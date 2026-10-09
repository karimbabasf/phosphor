// The Hyperliquid user-signed actions this app makes with its master key.
//
// Named for what it signs rather than for a direction, because it used to be called
// hyperliquid-withdraw.ts and that name misled twice: the module's live caller was a deposit
// (the settle step moves collateral between books), and the withdraw3 it was built around had
// no caller at all after the terminal script went on 2026-09-01. withdraw3 is gone with it.
// Money now leaves the venue through src/rails/hypercore-withdraw.ts, which signs the
// sendAsset below to an address NEAR Intents mints, and that is the only exit.
//
// Everything here is a SIGNED API ACTION: no transaction, no gas, no contract call from us.
// We sign an EIP-712 payload, POST it to /exchange, and the validators do the rest.
//
// Two actions, and they are the two an account needs:
//   sendAsset         USDC from this account to another HyperCore address. The one transfer
//                     both account modes accept: spotSend and usdSend are both refused on a
//                     unified account with "Action disabled when unified account is active"
//                     (seen live 2026-09-20; SwapKit's HyperCore guide says the same), and
//                     unified is the venue's recommended mode and Karim's account. spotSend
//                     signed the exit until 2026-09-20 and is gone: one write path, not two.
//   usdClassTransfer  USDC between this account's own spot and perp books. Not a transfer to
//                     anyone; needed on a standard account, rejected on a unified one.
//
// They are exported as plain functions rather than a Rail on purpose. A Rail is reachable by
// the agent through MCP; these are the primitives a rail composes, behind its own refusals.
// The third action only the master key can sign, approveAgent, is built here as well
// (buildApproveAgentPayload, approveAgent) and is never a rail's: scripts/hl-agent.ts signs it
// from the terminal for a wallet that holds its master key, and the window's "Allow trading"
// (src/hl/agent-key.ts) behind one Touch ID for a vault that moved to it.
//
// Once a vault has moved to this Mac's Touch ID key, the master key is not in memory any more:
// each of these signatures asks for a Touch ID of its own that names it (OwnerTouch, below).
//
// The signing scheme is the whole job, so it is stated once here and asserted against the
// official SDK's own vectors in the tests:
//   - EIP-712 typed data, NOT personal_sign, and NOT the msgpack phantom-agent scheme that L1
//     order actions use. The two schemes share an endpoint and nothing else.
//   - domain name is 'HyperliquidSignTransaction'. L1 actions use 'Exchange'. Different domain.
//   - domain chainId is 421614 and is NOT a venue selector. It only declares which chain the
//     wallet thinks it is signing on, and the docs accept 42161 there too. The field that
//     names the venue is hyperliquidChain, inside the signed message. That is the field to
//     get right: a payload signed with 'Mainnet' is a valid instruction against real money.
//   - the top-level nonce must equal the action's nonce, in MILLISECONDS. A mismatch is
//     rejected, and the venue keeps the highest hundred nonces per signer, so a nonce is the
//     identity of an action and a repeat is refused.
//   - the destination is hashed as a STRING, so its case is inside the digest. It is lowercased
//     once, before signing, and the same string is what gets posted.
//   - sourceDex and destinationDex name the book on each side: "" is the default perps book,
//     "spot" the spot book (docs, exchange-endpoint, Send Asset). A unified account reports its
//     whole balance under spotClearinghouseState, so "spot" is the side that can fund the send
//     there too; the destination side is "spot", which is where the retired spotSend landed
//     the money and what 1Click proved it credits (three live moves, 2026-09-11).
//
// One fee to know about, because it is paid by us and not by the destination: the first
// transaction into an account HyperCore has never seen costs the SENDER 1 USDC on top of the
// amount, whatever the action (docs, activation-gas-fee; read back off live ledgers
// 2026-09-11). Every address 1Click mints for a withdrawal is such an account. sendAsset checks
// the destination's role first and prices the fee in, so a caller reads the true cost before
// anything is signed, and a refusal names the most the account could send instead.

import { isAddress, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmPrivateKey, isOwnerTouchRequired } from '../keystore/index.ts';
import type { Address, Hex } from 'viem';
import { evmAddress } from '../keystore/index.ts';
import { readTimeout, venueWriteTimeout } from '../net.ts';
import { venueSaid } from '../venue-words.ts';
import { ReasonError } from './reasons.ts';
import type { ReasonCode } from './reasons.ts';

// ---------- the venue table ----------

export type HlVenueSpec = {
  exchangeUrl: string;
  infoUrl: string;
  // Inside the signed message, so it is a signing input rather than a label. A payload
  // carrying anything else is a signature the venue rejects.
  hyperliquidChain: 'Mainnet';
};

const HL_MAINNET: HlVenueSpec = {
  exchangeUrl: 'https://api.hyperliquid.xyz/exchange',
  infoUrl: 'https://api.hyperliquid.xyz/info',
  hyperliquidChain: 'Mainnet',
};

function hlVenue(): HlVenueSpec {
  return HL_MAINNET;
}

// The USDC token, as the SendAsset message names it: `name:tokenId`. Read from the venue's
// spotMeta on mainnet (token index 0, 8 wei decimals; re-read 2026-09-20) and pinned, because
// it is inside the signature and a lookup at signing time would let a poisoned list redirect
// the token. Testnet's USDC has a different id and must never be pasted here.
export const HL_USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

// Paid by the sender, on top of the amount, for the first transaction into an account the venue
// has never seen. The destination is credited in full.
export const HL_ACTIVATION_FEE_USDC = 1;

// The two books a sendAsset names on each side, in the venue's own spelling: the empty string
// is the default perps book, "spot" the spot book.
export type HlDex = '' | 'spot';
export const HL_SPOT_DEX: HlDex = 'spot';

// ---------- the EIP-712 constants ----------

// Hardcoded to 0x66eee (421614) by the official SDK's sign_user_signed_action. It is the chain
// the wallet declares it signed on, not the chain anything settles on.
export const SIGNATURE_CHAIN_ID_HEX = '0x66eee';
export const SIGNATURE_CHAIN_ID = 421614;

export const HL_DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: SIGNATURE_CHAIN_ID,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

// Field ORDER is part of the EIP-712 type hash, so these arrays are not just documentation.
// Reordering them produces a different digest and a signature that recovers to a stranger.
// destination is typed `string`, not `address`: that is what the SDK does, and `address` would
// hash the 20 bytes instead of the 42-character text and never verify.
export const SEND_ASSET_TYPES = {
  'HyperliquidTransaction:SendAsset': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'sourceDex', type: 'string' },
    { name: 'destinationDex', type: 'string' },
    { name: 'token', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'fromSubAccount', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const USD_CLASS_TRANSFER_TYPES = {
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

// Here the agent IS typed `address`, unlike sendAsset's destination: that is the SDK's own table
// for approve_agent, and the one scripts/hl-agent.ts has signed since the first agent was approved.
export const APPROVE_AGENT_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

const USDC_DECIMALS = 6;

// ---------- amounts ----------

// Hyperliquid takes amounts as decimal STRINGS, and the string is inside the signature, so it
// has to be built once and reused for both signing and sending. Same rule as the deposit rail:
// a float that cannot be represented at 6 decimals must never be silently rounded into a
// transfer. Refuse it instead of moving a different number than the caller asked for.
export function toAmountString(amount: number, decimals: number = USDC_DECIMALS): string {
  if (!Number.isFinite(amount)) throw new Error(`amount ${amount} is not a finite number`);
  if (amount <= 0) throw new Error(`amount must be positive (got ${amount})`);
  const fixed = amount.toFixed(decimals);
  // toFixed goes exponential past 1e21, which is not a decimal string any more.
  if (!/^\d+(\.\d+)?$/.test(fixed)) throw new Error(`amount ${amount} is out of range`);
  if (Number(fixed) !== amount) {
    throw new Error(`amount ${amount} needs more than ${decimals} decimals; rounding it to ${fixed} would move a different amount`);
  }
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- the payloads ----------

export type HlTypedData = {
  domain: typeof HL_DOMAIN;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type HlSendAssetAction = {
  type: 'sendAsset';
  signatureChainId: string;
  hyperliquidChain: 'Mainnet' | 'Testnet';
  destination: string;
  sourceDex: HlDex;
  destinationDex: HlDex;
  token: string;
  amount: string;
  fromSubAccount: ''; // never from a sub-account: this app has none and names none
  nonce: number;
};

export type HlUsdClassTransferAction = {
  type: 'usdClassTransfer';
  signatureChainId: string;
  hyperliquidChain: 'Mainnet';
  amount: string;
  toPerp: boolean;
  nonce: number;
};

export type HlApproveAgentAction = {
  type: 'approveAgent';
  hyperliquidChain: 'Mainnet';
  signatureChainId: string;
  agentAddress: string;
  agentName: string;
  nonce: number;
};

// Built as one function so the signed message can never drift from the posted action: the
// message IS the action minus its `type` and `signatureChainId` tags, and both come from the
// same object.
//
// The destination is lowercased. It is hashed as a string, so its case is inside the digest,
// and the server rebuilds the digest from the string we send. Lowercase is what the SDK's own
// fixture uses, and normalising here means the signed text and the sent text cannot disagree.
export function buildSendAssetPayload(args: {
  destination: string;
  amount: string;
  nonce: number;
  sourceDex?: HlDex;
  destinationDex?: HlDex;
  // Testnet exists here for the signing vectors only: nothing in this app posts to testnet.
  chain?: 'Mainnet' | 'Testnet';
}): { action: HlSendAssetAction; typedData: HlTypedData; nonce: number } {
  const action: HlSendAssetAction = {
    type: 'sendAsset',
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    hyperliquidChain: args.chain ?? hlVenue().hyperliquidChain,
    destination: args.destination.trim().toLowerCase(),
    sourceDex: args.sourceDex ?? HL_SPOT_DEX,
    destinationDex: args.destinationDex ?? HL_SPOT_DEX,
    token: HL_USDC_TOKEN,
    amount: args.amount,
    fromSubAccount: '',
    nonce: args.nonce,
  };
  return {
    action,
    nonce: args.nonce, // the API rejects a nonce that does not equal action.nonce
    typedData: {
      domain: HL_DOMAIN,
      types: SEND_ASSET_TYPES as unknown as HlTypedData['types'],
      primaryType: 'HyperliquidTransaction:SendAsset',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        destination: action.destination,
        sourceDex: action.sourceDex,
        destinationDex: action.destinationDex,
        token: action.token,
        amount: action.amount,
        fromSubAccount: action.fromSubAccount,
        nonce: BigInt(action.nonce),
      },
    },
  };
}

export function buildUsdClassTransferPayload(args: {
  amount: string;
  toPerp: boolean;
  nonce: number;
}): { action: HlUsdClassTransferAction; typedData: HlTypedData; nonce: number } {
  const spec = hlVenue();
  const action: HlUsdClassTransferAction = {
    type: 'usdClassTransfer',
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    hyperliquidChain: spec.hyperliquidChain,
    amount: args.amount,
    toPerp: args.toPerp,
    nonce: args.nonce,
  };
  return {
    action,
    nonce: args.nonce,
    typedData: {
      domain: HL_DOMAIN,
      types: USD_CLASS_TRANSFER_TYPES as unknown as HlTypedData['types'],
      primaryType: 'HyperliquidTransaction:UsdClassTransfer',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        amount: action.amount,
        toPerp: action.toPerp,
        nonce: BigInt(action.nonce),
      },
    },
  };
}

/* A trading key's end, set in its name: the label, " valid_until ", then the end in milliseconds,
   at most 180 days ahead (docs, exchange endpoint, "Approve an API wallet"). The venue prunes a key
   that expired, so the end is real, and the Touch ID dialog says it (agentValidityDays). */
export const HL_AGENT_MAX_DAYS = 180;
const DAY_MS = 86_400_000;
/* The name Phosphor's trading keys go by on the venue (scripts/hl-agent.ts's default): an approval
   under a name the account already has replaces that key, so Phosphor holds one trading key, never
   two, and the one an approval retires is gone from the venue the same moment. */
export const HL_AGENT_LABEL = 'phosphor-runner';

export function agentNameUntil(label: string, validUntil: number): string {
  return `${label} valid_until ${validUntil}`;
}

/* How long an approveAgent's name lets the key trade, read off the signed message alone: null for a
   plain label, a key with no end (what scripts/hl-agent.ts signs); whole days from the action's
   nonce, 1 to 180, for `<label> valid_until <ms>`, the label held to the venue's 16 characters;
   undefined for anything else, which no Touch ID may be asked to sign. */
export function agentValidityDays(agentName: unknown, nonce: unknown): number | null | undefined {
  if (typeof agentName !== 'string') return undefined;
  if (/^[A-Za-z0-9-]{1,32}$/.test(agentName)) return null;
  const until = /^[A-Za-z0-9-]{1,16} valid_until ([1-9]\d{0,15})$/.exec(agentName);
  if (until === null || typeof nonce !== 'bigint') return undefined;
  const span = BigInt(until[1]) - nonce;
  if (span <= 0n || span % BigInt(DAY_MS) !== 0n) return undefined;
  const days = Number(span / BigInt(DAY_MS));
  return days <= HL_AGENT_MAX_DAYS ? days : undefined;
}

// The action and its message keep the field order scripts/hl-agent.ts posts and signs. The
// address is lowercased once, as the script does, so the signed and the posted text agree.
export function buildApproveAgentPayload(args: {
  agentAddress: string;
  agentName: string;
  nonce: number;
}): { action: HlApproveAgentAction; typedData: HlTypedData; nonce: number } {
  const action: HlApproveAgentAction = {
    type: 'approveAgent',
    hyperliquidChain: hlVenue().hyperliquidChain,
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    agentAddress: args.agentAddress.trim().toLowerCase(),
    agentName: args.agentName,
    nonce: args.nonce,
  };
  return {
    action,
    nonce: args.nonce,
    typedData: {
      domain: HL_DOMAIN,
      types: APPROVE_AGENT_TYPES as unknown as HlTypedData['types'],
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        agentAddress: action.agentAddress,
        agentName: action.agentName,
        nonce: BigInt(action.nonce),
      },
    },
  };
}

// ---------- the signing seam ----------

export type HlSignature = { r: Hex; s: Hex; v: number };

export type HlSignPort = {
  address(keysPath: string): Address;
  /* `lastCheck` is the executor's last check (RailHooks.lastCheck). The caller runs it right
     before it asks; a signer that waits on a person in between (a Touch ID) runs it again once
     the key is in hand, so Freeze pressed while the dialog is up still stops the signature. */
  signTypedData(keysPath: string, typed: HlTypedData, lastCheck?: () => void): Promise<HlSignature>;
};

// The DEBT this file carried is paid: it used to open the key file itself, because
// src/chain/evm.ts kept its reader private and this module could not edit it. Both now ask
// src/keystore for the material, so there is one door, and a locked wallet closes it.

/* THE MASTER KEY BEHIND A TOUCH, ONE ACTION AT A TIME (PHASE2-PLAN.md P2.8). A vault that moved
   to the chip opens without the master key (src/keystore/store.ts, keepOwnerKeyOutWhen), and on
   Hyperliquid that key is still the account's owner. So each of the three actions only it can
   sign asks for a Touch ID of its own: one unwrap, one touch, one signature, and the key is zeroed
   once the signature is made. Nothing is kept, so the next action asks again. src/main.ts installs
   the touch (src/proposals/lifecycle.ts, ownerTouchVia) the way it installs the keystore. */
export type OwnerTouch = {
  // Whether the master key is out of the session, so an owner action asks for its own touch.
  required(): boolean;
  // One Touch ID whose dialog names `typed` exactly, the key for that one signature, then zeroed.
  sign(typed: HlTypedData, lastCheck?: () => void): Promise<HlSignature>;
};

let ownerTouch: OwnerTouch | null = null;

export function useOwnerTouch(touch: OwnerTouch | null): void {
  ownerTouch = touch;
}

export function ownerTouchRequired(): boolean {
  return ownerTouch?.required() ?? false;
}

/* A touch that gave no signature: cancelled, unanswered, out of reach, or an action the dialog
   could not name. Nothing was signed. A cancel is the person saying no; anything else is a move
   that did not go out. `touch` is the relay's own code, for the log. */
export class OwnerTouchRefused extends ReasonError {
  readonly touch: string;
  constructor(touch: string, message: string) {
    super(touch === 'user_cancel' ? 'declined' : 'not_sent', message);
    this.name = 'OwnerTouchRefused';
    this.touch = touch;
  }
}

/* One EIP-712 signature with the key handed in. viem takes it as hex, a copy JavaScript cannot
   wipe: the floor src/keystore/store.ts names for every EVM signature (evmKey). Hyperliquid wants
   {r, s, v} with v as 27 or 28, not viem's packed 65-byte hex. */
export async function signTypedWith(key: Hex | Buffer, typed: HlTypedData): Promise<HlSignature> {
  const account = privateKeyToAccount(typeof key === 'string' ? key : `0x${key.toString('hex')}`);
  const packed = await account.signTypedData(typed as never);
  const { r, s, v, yParity } = parseSignature(packed);
  return { r, s, v: v !== undefined ? Number(v) : 27 + yParity };
}

export const liveSignPort: HlSignPort = {
  address: evmAddress,
  async signTypedData(keysPath, typed, lastCheck) {
    let key: Hex;
    try {
      key = evmPrivateKey(keysPath);
    } catch (err) {
      if (!isOwnerTouchRequired(err)) throw err;
      if (ownerTouch === null) {
        throw new OwnerTouchRefused('no_touch', 'The owner key signs only behind Touch ID, and Touch ID is not set up in this process, so nothing was signed');
      }
      return ownerTouch.sign(typed, lastCheck);
    }
    return signTypedWith(key, typed);
  },
};

// ---------- reads ----------

export type HlAccountSummary = {
  address: string;
  spotUsdc: number; // where a faucet drip and any spot trading proceeds sit
  perpAccountValueUsd: number;
  perpWithdrawableUsd: number; // 0 on a unified account even when funds are present
  availableUsdc: number; // what a send may actually draw on, either shape of account
  unified: boolean; // spot and perp merged, so usdClassTransfer is rejected outright
  marginUsedUsd: number;
  openPositions: number;
  fetchedAt: string;
  // The venue's own clock when it answered (clearinghouseState.time), so a window measured against
  // the venue's ledger stamps is on one clock. Absent when the venue sent none.
  venueTimeMs?: number;
};

type ClearinghouseState = {
  time?: number;
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: unknown[];
};

type SpotClearinghouseState = {
  balances?: Array<{ coin?: string; total?: string }>;
  // Unified accounts only: [tokenId, availableAfterMaintenance] pairs. Token 0 is USDC.
  tokenToAvailableAfterMaintenance?: Array<[number | string, string]>;
};

const USDC_TOKEN_ID = 0;

// Every number in these responses is a string, and a malformed one must read as zero rather
// than NaN: NaN silently poisons every comparison the guards below make.
function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type HlUserSignedDeps = {
  keysPath: string;
  sign?: HlSignPort;
  fetchImpl?: typeof fetch;
  now?: () => number;
  // The executor's last check (RailHooks.lastCheck), run with nothing awaited before the key signs.
  lastCheck?: () => void;
};

async function info<T>(deps: HlUserSignedDeps, body: Record<string, unknown>): Promise<T> {
  const spec = hlVenue();
  const res = await (deps.fetchImpl ?? fetch)(spec.infoUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: readTimeout(),
  });
  if (!res.ok) {
    const said = (await res.text().catch(() => '')).trim();
    throw new Error(`hyperliquid ${String(body.type)} failed: ${res.status}${said === '' ? '' : ` ${venueSaid('Hyperliquid', said, 200)}`}`);
  }
  return (await res.json()) as T;
}

// Both books, because the difference between them is the whole reason usdClassTransfer exists.
export async function accountSummary(deps: HlUserSignedDeps, address?: string): Promise<HlAccountSummary> {
  const sign = deps.sign ?? liveSignPort;
  const user = (address ?? sign.address(deps.keysPath)).trim();
  if (!isAddress(user)) throw new Error(`hyperliquid accountSummary: ${user} is not an address`);

  const [perp, spot, abstraction] = await Promise.all([
    info<ClearinghouseState>(deps, { type: 'clearinghouseState', user, dex: '' }),
    info<SpotClearinghouseState>(deps, { type: 'spotClearinghouseState', user }),
    // The venue's own word on the account mode. An empty unified account reads 0 on both
    // balance figures, and the heuristic below would then call it standard.
    info<unknown>(deps, { type: 'userAbstraction', user }).catch(() => null),
  ]);

  // A UNIFIED account merges the two books, and then clearinghouseState.withdrawable reads
  // 0.0 while every dollar sits in spot. Observed live 2026-08-12: perp withdrawable 0,
  // spot 899.037299, and usdClassTransfer rejected outright with "Action disabled when
  // unified account is active" because there are no longer two sides to move between.
  // Guarding on the perp number alone therefore refuses a withdrawal the account can
  // certainly afford, and telling the operator to run a transfer that cannot run.
  //
  // tokenToAvailableAfterMaintenance is the authoritative figure: what is actually free
  // once maintenance margin is held back, per token id (0 is USDC). Present on unified
  // accounts, absent on classic ones, so it is used when it exists and ignored otherwise.
  const availablePairs = spot.tokenToAvailableAfterMaintenance;
  const unifiedUsdc = Array.isArray(availablePairs)
    ? num((availablePairs.find((pair) => Array.isArray(pair) && Number(pair[0]) === USDC_TOKEN_ID) ?? [])[1])
    : 0;

  return {
    address: user,
    spotUsdc: num((spot.balances ?? []).find((b) => b.coin === 'USDC')?.total),
    perpAccountValueUsd: num(perp.marginSummary?.accountValue),
    perpWithdrawableUsd: num(perp.withdrawable),
    // What a withdrawal may actually draw on, whichever shape the account is in. The perp
    // book on a classic account, the unified figure on a unified one.
    availableUsdc: Math.max(num(perp.withdrawable), unifiedUsdc),
    unified:
      typeof abstraction === 'string' && abstraction !== ''
        ? abstraction === 'unifiedAccount'
        : unifiedUsdc > 0 && num(perp.withdrawable) === 0,
    marginUsedUsd: num(perp.marginSummary?.totalMarginUsed),
    openPositions: Array.isArray(perp.assetPositions) ? perp.assetPositions.length : 0,
    fetchedAt: new Date().toISOString(),
    ...(typeof perp.time === 'number' && Number.isFinite(perp.time) && perp.time > 0 ? { venueTimeMs: perp.time } : {}),
  };
}

// Whether the venue has ever seen an address. `missing` means the first transfer into it pays
// the activation fee. Weight 60 on the rate limiter, so it is asked once per destination.
export async function userRole(deps: HlUserSignedDeps, address: string): Promise<string> {
  const user = address.trim().toLowerCase();
  if (!isAddress(user)) throw new Error(`hyperliquid userRole: ${address} is not an address`);
  const body = await info<{ role?: unknown }>(deps, { type: 'userRole', user });
  return typeof body?.role === 'string' ? body.role : 'unknown';
}

export type HlAgentListing = { address: string; name: string; validUntil: number | null };

/* The trading keys the venue holds approved for an account: address lower case, the name without its
   end, and the end in milliseconds or null. No key, a public /info POST; throws when the venue's
   answer is not a list, so a caller never reads a failure as "no key approved". */
export async function extraAgents(deps: HlUserSignedDeps, account: string): Promise<HlAgentListing[]> {
  const user = account.trim().toLowerCase();
  if (!isAddress(user)) throw new Error(`hyperliquid extraAgents: ${account} is not an address`);
  const rows = await info<unknown>(deps, { type: 'extraAgents', user });
  if (!Array.isArray(rows)) throw new Error('hyperliquid extraAgents answered with something that is not a list');
  return rows.flatMap((row) => {
    const r = (row ?? {}) as { address?: unknown; name?: unknown; validUntil?: unknown };
    if (typeof r.address !== 'string' || !isAddress(r.address)) return [];
    return [{ address: r.address.toLowerCase(), name: typeof r.name === 'string' ? r.name : '', validUntil: typeof r.validUntil === 'number' ? r.validUntil : null }];
  });
}

// One entry of the venue's non-funding ledger: a deposit, a withdrawal, a transfer between
// accounts or between the account's own books. Every number is a string, like every read here.
type LedgerUpdate = { time?: number; hash?: string; delta?: Record<string, unknown> };

/* One USDC credit to an account, off that ledger: when the venue stamped it, its hash, the
   amount, and the book it landed on where the row names one (a bridge deposit and a transfer
   between accounts land on perp; a spotTransfer on spot; a `send` on its destinationDex, where
   "" is the perp book and any other dex is not one this app trades). A 1Click delivery is a
   `send` out of the solver's spot book into our perp book (read off the ledger 2026-10-09). */
export type HlUsdcCredit = {
  atMs: number;
  hash: string;
  usdc: number;
  book: 'perp' | 'spot' | null;
  /* The shape of a 1Click delivery and nothing wider: a USDC `send` from another account, out of
     its spot book into our perp book. A bridge deposit, a transfer from a friend and a move between
     our own dexes are credits too, and count in a sum (usdcCreditedSince), never as a deposit's own
     early proof (src/rails/hypercore-deposit.ts creditProof; review 2026-10-09). */
  delivery?: boolean;
};

/* Whether a ledger row is a USDC credit to `account`: bridge deposits, and USDC transfers on
   either book whose destination is the account. Money leaving, money moving between the
   account's own books, any other token, and an amount that does not read as a positive number
   are not. A row with no time keeps NaN, so the deposit rail's "since" never lets it through.
   Shared by the REST read below and the trade feed's socket (src/trade/feed-ws.ts), so the two
   cannot disagree about what a credit is. */
export function usdcCreditOf(row: unknown, account: string): HlUsdcCredit | null {
  const r = (row ?? {}) as LedgerUpdate;
  const delta = r.delta;
  if (typeof delta !== 'object' || delta === null) return null;
  const toUs = String(delta.destination ?? '').toLowerCase() === account.trim().toLowerCase();
  let usdc: number;
  let book: HlUsdcCredit['book'];
  if (delta.type === 'deposit') {
    usdc = num(String(delta.usdc ?? ''));
    book = 'perp';
  } else if (delta.type === 'internalTransfer' && toUs) {
    usdc = num(String(delta.usdc ?? ''));
    book = 'perp';
  } else if ((delta.type === 'spotTransfer' || delta.type === 'send') && toUs && delta.token === 'USDC') {
    usdc = num(String(delta.amount ?? ''));
    book = delta.type === 'spotTransfer' || delta.destinationDex === 'spot' ? 'spot' : delta.destinationDex === '' ? 'perp' : null;
  } else {
    return null;
  }
  if (!(usdc > 0)) return null;
  const delivery =
    delta.type === 'send' &&
    delta.token === 'USDC' &&
    toUs &&
    typeof delta.user === 'string' &&
    delta.user.toLowerCase() !== account.trim().toLowerCase() &&
    delta.sourceDex === 'spot' &&
    delta.destinationDex === '';
  return { atMs: typeof r.time === 'number' ? r.time : NaN, hash: typeof r.hash === 'string' ? r.hash : '', usdc, book, delivery };
}

/* The USDC credits to an account since a moment, one row each. No key, a public /info POST.
   Throws when the ledger will not answer, so a caller never reads a failure as "nothing arrived". */
export async function usdcCreditsSince(deps: HlUserSignedDeps, account: string, sinceMs: number): Promise<HlUsdcCredit[]> {
  const user = account.trim().toLowerCase();
  if (!isAddress(user)) throw new Error(`hyperliquid usdcCreditsSince: ${account} is not an address`);
  const rows = await info<unknown>(deps, { type: 'userNonFundingLedgerUpdates', user, startTime: sinceMs });
  if (!Array.isArray(rows)) throw new Error('hyperliquid userNonFundingLedgerUpdates answered with something that is not a list');
  return rows.flatMap((row) => {
    const credit = usdcCreditOf(row, user);
    // A row with no time was always counted in the sum below, and still is.
    return credit === null || credit.atMs < sinceMs ? [] : [credit];
  });
}

/* USDC credited to an account since a moment, summed.
   The reconcile sweep reads this to confirm a Hyperliquid deposit 1Click calls SUCCESS: after
   the fact a balance comparison cannot answer it (the rail's before-read is gone with the
   process, and trading moves the same figure), and the ledger names each credit with its amount.
   Throws when the ledger will not answer, so the caller can leave a row unconfirmed. */
export async function usdcCreditedSince(deps: HlUserSignedDeps, account: string, sinceMs: number): Promise<number> {
  const credited = (await usdcCreditsSince(deps, account, sinceMs)).reduce((sum, c) => sum + c.usdc, 0);
  // Six decimals is the venue's own precision for USDC; summing strings as doubles drifts past it.
  return Math.round(credited * 1e6) / 1e6;
}

// ---------- the write path ----------

export type HlActionResult = {
  ok: boolean;
  detail: string;
  action?: HlSendAssetAction | HlUsdClassTransferAction;
  /* sendAsset only: what the venue charged us on top of the amount, 1 for a fresh destination. */
  activationFeeUsdc?: number;
  /* sendAsset only, on a refusal for a short balance: the most the account could send to this
     destination right now, activation fee already taken off. The rail puts it in the sentence
     a person reads, so a refusal ends with a number to try rather than a dead end. */
  maxSendableUsdc?: number;
  response?: unknown;
  /* The nonce this attempt signed with. On Hyperliquid the nonce IS the identity of the action:
     the venue keeps the highest hundred per signer and refuses a repeat, which is the whole of
     its deduplication. A retry that passes this back is a retry; one that mints a fresh nonce is
     a SECOND REAL WITHDRAWAL, and that is what used to happen. */
  nonce?: number;
  /* The venue did not answer. Not a failure: the withdrawal may have been accepted and the
     reply lost. A caller must not report "nothing happened", and if it retries it must reuse
     `nonce` above. Before this the throw simply escaped, and the retry above it minted a new
     nonce and a new signature that the venue was perfectly happy to accept a second time. */
  ambiguous?: boolean;
  /* sendAsset only, on an ambiguous attempt: the signature it posted. A retry posts it again with
     the same action (sendAsset's `resend`), so the retry is the same bytes and never a second
     signature, and on a vault on the chip never a second Touch ID for one send. */
  signature?: HlSignature;
  // Why nothing was signed, when a Touch ID gave no signature: 'declined' for a cancel.
  reason?: ReasonCode;
};

type ExchangeResponse = { status?: string; response?: unknown };

// The exchange endpoint answers HTTP 200 with {"status":"err","response":"<message>"} for a
// rejected action. Reading res.ok alone reports a refused withdrawal as a success, so the
// status field is checked as well and is what decides ok here.
async function postAction(
  deps: HlUserSignedDeps,
  action: HlSendAssetAction | HlUsdClassTransferAction | HlApproveAgentAction,
  nonce: number,
  signature: HlSignature,
): Promise<{ ok: boolean; detail: string; body: unknown; ambiguous?: boolean }> {
  const spec = hlVenue();
  /* The one call in this file that moves money off the venue. Thirty seconds, and the caller
     treats a timeout as UNKNOWN: the withdrawal may have been accepted. Retrying it with a
     fresh nonce would be a second real transfer. */
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(spec.exchangeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature }),
      signal: venueWriteTimeout(),
    });
  } catch (err) {
    // The request went out and the answer did not come back. Ambiguous, never failed.
    return {
      ok: false,
      ambiguous: true,
      detail:
        `${action.type} was sent to Hyperliquid and no reply came back (${errText(err)}). ` +
        `IT MAY HAVE BEEN ACCEPTED. Check the account before retrying, and retry only with nonce ${String(nonce)}: ` +
        `a fresh nonce would be a second real ${action.type}.`,
      body: null,
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      ambiguous: true,
      detail: `${action.type} reached Hyperliquid and its reply could not be read (${errText(err)}). IT MAY HAVE BEEN ACCEPTED.`,
      body: null,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as ExchangeResponse;
  } catch {
    return { ok: false, detail: `${action.type} got a non-JSON reply: ${res.status} ${venueSaid('Hyperliquid', text, 200)}`, body: text };
  }
  // The venue's words go to the agent inside the rails' sentences, so they are quoted and labeled.
  if (!res.ok) return { ok: false, detail: `${action.type} failed: HTTP ${res.status} ${venueSaid('Hyperliquid', text, 200)}`, body };
  const status = (body as ExchangeResponse).status;
  if (status !== 'ok') {
    return { ok: false, detail: `${action.type} refused by Hyperliquid: ${venueSaid('Hyperliquid', (body as ExchangeResponse).response ?? body)}`, body };
  }
  return { ok: true, detail: '', body };
}

/* The signature, or the Touch ID that would have made it saying why not. A refused touch is an
   answer, since nothing was signed; anything else throws as it always has, for the rail to word. */
async function signFor(sign: HlSignPort, deps: HlUserSignedDeps, typed: HlTypedData): Promise<HlSignature | OwnerTouchRefused> {
  try {
    return await sign.signTypedData(deps.keysPath, typed, deps.lastCheck);
  } catch (err) {
    if (err instanceof OwnerTouchRefused) return err;
    throw err;
  }
}

// ---------- usdClassTransfer: spot <-> perp ----------

// Moves USDC between the two books on one account. Not a transfer to anyone: same account,
// different side. A standard account needs it in both directions: a HyperCore delivery can
// land on spot, and the exit pays out of spot.
export async function usdClassTransfer(
  deps: HlUserSignedDeps,
  // `nonce` retries a previous ambiguous attempt. See the note on HlActionResult.nonce.
  params: { amount: number; toPerp: boolean; nonce?: number },
): Promise<HlActionResult> {
  const sign = deps.sign ?? liveSignPort;

  let amount: string;
  try {
    amount = toAmountString(params.amount);
  } catch (err) {
    return { ok: false, detail: `REFUSED: ${errText(err)}` };
  }

  // Read the side we are taking from. Asking to move more than exists is rejected by the API
  // anyway, but a local refusal costs nothing and says which number was short.
  const summary = await accountSummary(deps);
  const available = params.toPerp ? summary.spotUsdc : summary.perpWithdrawableUsd;
  const fromName = params.toPerp ? 'spot' : 'perp withdrawable';
  if (params.amount > available) {
    return {
      ok: false,
      detail: `REFUSED: ${fromName} holds ${available} USDC and the transfer needs ${amount}`,
    };
  }

  const { action, typedData, nonce } = buildUsdClassTransferPayload({
    amount,
    toPerp: params.toPerp,
    nonce: params.nonce ?? (deps.now ?? Date.now)(),
  });

  deps.lastCheck?.();
  const signature = await signFor(sign, deps, typedData);
  if (signature instanceof OwnerTouchRefused) return { ok: false, detail: signature.message, reason: signature.reason };
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, response: out.body, nonce, ambiguous: out.ambiguous };
  return {
    ok: true,
    detail: `moved ${amount} USDC ${params.toPerp ? 'spot -> perp' : 'perp -> spot'} on Hyperliquid`,
    action,
    response: out.body,
  };
}

// ---------- sendAsset: USDC to another HyperCore address ----------

// The most the account could send to a destination right now: what the send can draw on, less
// the activation fee the venue takes beside the amount. Six decimals, cut toward zero, never
// negative. Exported so the rail's refusal and this one name the same number.
export function maxSendableUsdc(sendable: number, activationFeeUsdc: number): number {
  const room = Math.max(0, sendable - activationFeeUsdc);
  return Math.floor(room * 1e6) / 1e6;
}

// A USDC figure for a sentence: six places, trailing zeros off. A sum of two doubles is not a
// number toAmountString may spell (8.209399 + 1 has a seventh decimal), and a refusal that
// threw on its own arithmetic read as "rail threw" over a plain short balance.
function money(amount: number): string {
  return Number.isFinite(amount) ? amount.toFixed(6).replace(/\.?0+$/, '') : String(amount);
}

// The one action here that pays someone else, so it refuses more than it does. It has no
// default destination on purpose: the caller must name one, and the only caller is the
// withdraw rail, which names the address 1Click minted for the quote it just checked.
export async function sendAsset(
  deps: HlUserSignedDeps,
  params: {
    destination: string;
    amount: number;
    /* Pass the nonce from a previous ambiguous attempt to RETRY it. Omitted, the clock is used
       and this is a new transfer. The venue refuses a nonce it has already seen, so a genuine
       retry is refused as a duplicate rather than paying out twice. */
    nonce?: number;
    /* Or the ambiguous attempt itself, its action and the signature it posted: the retry posts
       those very bytes and signs nothing. The arguments must rebuild exactly that action, or
       nothing is posted. */
    resend?: { action: HlSendAssetAction; signature: HlSignature };
    // Both default to the spot book: the side a unified account reports its balance under, and
    // the side the exit has always paid out of.
    sourceDex?: HlDex;
    destinationDex?: HlDex;
  },
): Promise<HlActionResult> {
  const sign = deps.sign ?? liveSignPort;

  let own: Address;
  try {
    own = sign.address(deps.keysPath);
  } catch (err) {
    return { ok: false, detail: `REFUSED: cannot resolve the signing wallet: ${errText(err)}` };
  }

  const destination = params.destination.trim();
  if (!isAddress(destination)) {
    return { ok: false, detail: `REFUSED: destination ${params.destination} is not an address` };
  }

  let amount: string;
  try {
    amount = toAmountString(params.amount);
  } catch (err) {
    return { ok: false, detail: `REFUSED: ${errText(err)}` };
  }

  // What the fee really is, from the venue, before the balance check that depends on it.
  let activationFeeUsdc = 0;
  try {
    if ((await userRole(deps, destination)) === 'missing') activationFeeUsdc = HL_ACTIVATION_FEE_USDC;
  } catch (err) {
    return { ok: false, detail: `REFUSED: could not read whether ${destination} exists on Hyperliquid: ${errText(err)}` };
  }
  const needed = params.amount + activationFeeUsdc;

  // The send pays out of one book. On a unified account there is one balance and the perp
  // figure reads 0 while the money is present; on a standard account it is the named book's
  // total, and money on the other side has to be moved first.
  const sourceDex = params.sourceDex ?? HL_SPOT_DEX;
  const summary = await accountSummary(deps, own);
  const sendable = summary.unified ? summary.availableUsdc : sourceDex === HL_SPOT_DEX ? summary.spotUsdc : summary.perpWithdrawableUsd;
  if (needed > sendable) {
    const most = maxSendableUsdc(sendable, activationFeeUsdc);
    const why =
      activationFeeUsdc > 0 ? ` (${amount} plus the ${activationFeeUsdc} USDC activation fee for a destination the venue has never seen)` : '';
    const hint =
      !summary.unified && summary.perpWithdrawableUsd > 0 && sourceDex === HL_SPOT_DEX
        ? ` The perp side holds ${summary.perpWithdrawableUsd} USDC; move it with usdClassTransfer({ amount, toPerp: false }) first.`
        : '';
    return {
      ok: false,
      maxSendableUsdc: most,
      detail:
        `REFUSED: ${summary.unified ? 'available' : `the ${sourceDex === HL_SPOT_DEX ? 'spot' : 'perp'} book holds`} ${summary.unified ? 'is ' : ''}${sendable} USDC ` +
        `and the transfer needs ${money(needed)}${why}. The most it can send now is ${most} USDC.${hint}`,
    };
  }

  const { action, typedData, nonce } = buildSendAssetPayload({
    destination,
    amount,
    sourceDex,
    destinationDex: params.destinationDex ?? HL_SPOT_DEX,
    // The caller's nonce when retrying, the clock when this is a new transfer.
    nonce: params.resend?.action.nonce ?? params.nonce ?? (deps.now ?? Date.now)(),
  });
  if (params.resend !== undefined && JSON.stringify(params.resend.action) !== JSON.stringify(action)) {
    return { ok: false, detail: 'REFUSED: the send to repeat is not the send these arguments build, so nothing was posted' };
  }

  deps.lastCheck?.();
  const signature = params.resend?.signature ?? (await signFor(sign, deps, typedData));
  if (signature instanceof OwnerTouchRefused) return { ok: false, detail: signature.message, reason: signature.reason };
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) {
    return { ok: false, detail: out.detail, action, response: out.body, nonce, ambiguous: out.ambiguous, ...(out.ambiguous === true ? { signature } : {}) };
  }

  const fee = activationFeeUsdc > 0 ? `, plus the ${activationFeeUsdc} USDC activation fee the venue charges us for a fresh destination` : '';
  return {
    ok: true,
    detail: `sent ${amount} USDC to ${action.destination} on HyperCore (nonce ${String(nonce)}${fee})`,
    action,
    response: out.body,
    nonce,
    activationFeeUsdc,
  };
}

// ---------- approveAgent: a trading key for this account ----------

export type HlApproveResult = {
  ok: boolean;
  detail: string;
  action?: HlApproveAgentAction;
  // As on a send: the venue did not answer, and the key may be approved all the same.
  ambiguous?: boolean;
  // Why nothing was signed, when the Touch ID gave no signature: 'declined' for a cancel.
  reason?: ReasonCode;
  // The relay's own code for that refused touch, for the caller's sentence and the log.
  touch?: string;
};

/* Approves a trading key for this account: the action only the owner key signs. On a vault that
   moved to Touch ID the signature is the owner touch's, one Touch ID whose dialog is read off this
   very message (src/vault/reason.ts). Nothing moves money, so nothing is resent here: a caller that
   got no answer reads the venue's list (extraAgents) before asking again. */
export async function approveAgent(
  deps: HlUserSignedDeps,
  params: { agentAddress: string; agentName: string; nonce: number },
): Promise<HlApproveResult> {
  const sign = deps.sign ?? liveSignPort;
  const { action, typedData, nonce } = buildApproveAgentPayload(params);
  deps.lastCheck?.();
  const signature = await signFor(sign, deps, typedData);
  if (signature instanceof OwnerTouchRefused) return { ok: false, detail: signature.message, reason: signature.reason, touch: signature.touch };
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, ambiguous: out.ambiguous };
  return { ok: true, detail: `approved trading key ${action.agentAddress} on Hyperliquid (nonce ${String(nonce)})`, action };
}
