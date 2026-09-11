// The Hyperliquid user-signed actions this app makes with its master key.
//
// Named for what it signs rather than for a direction, because it used to be called
// hyperliquid-withdraw.ts and that name misled twice: the module's live caller was a deposit
// (the settle step moves collateral between books), and the withdraw3 it was built around had
// no caller at all after the terminal script went on 2026-09-01. withdraw3 is gone with it.
// Money now leaves the venue through src/rails/hypercore-withdraw.ts, which signs the
// spotSend below to an address NEAR Intents mints, and that is the only exit.
//
// Everything here is a SIGNED API ACTION: no transaction, no gas, no contract call from us.
// We sign an EIP-712 payload, POST it to /exchange, and the validators do the rest.
//
// Two actions, and they are the two an account needs:
//   spotSend          USDC from this account's spot book to another HyperCore address.
//   usdClassTransfer  USDC between this account's own spot and perp books. Not a transfer to
//                     anyone; needed on a standard account, rejected on a unified one.
//
// They are exported as plain functions rather than a Rail on purpose. A Rail is reachable by
// the agent through MCP; these are the primitives a rail composes, behind its own refusals.
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
//   - the top-level nonce must equal the action's time (spotSend) or nonce (usdClassTransfer),
//     in MILLISECONDS. A mismatch is rejected, and the venue keeps the highest hundred nonces
//     per signer, so a nonce is the identity of an action and a repeat is refused.
//   - the destination is hashed as a STRING, so its case is inside the digest. It is lowercased
//     once, before signing, and the same string is what gets posted.
//
// One fee to know about, because it is paid by us and not by the destination: the first
// transfer into an account HyperCore has never seen costs the SENDER 1 USDC on top of the
// amount (docs, activation-gas-fee; read back off live ledgers 2026-09-11). Every address
// 1Click mints for a withdrawal is such an account. spotSend checks the destination's role
// first and prices the fee in, so a caller reads the true cost before anything is signed.

import { isAddress, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmPrivateKey } from '../keystore/index.ts';
import type { Address, Hex } from 'viem';
import { evmAddress } from '../chain/evm.ts';
import { readTimeout, venueWriteTimeout } from '../net.ts';

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

// The spot USDC token, as the SpotSend message names it: `name:tokenId`. Read from the venue's
// spotMeta on mainnet (token index 0, 8 wei decimals) and pinned, because it is inside the
// signature and a lookup at signing time would let a poisoned list redirect the token.
// Testnet's USDC has a different id and must never be pasted here.
export const HL_USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

// Paid by the sender, on top of the amount, for the first transfer into an account the venue
// has never seen. The destination is credited in full.
export const HL_ACTIVATION_FEE_USDC = 1;

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
export const SPOT_SEND_TYPES = {
  'HyperliquidTransaction:SpotSend': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'token', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
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

export type HlSpotSendAction = {
  type: 'spotSend';
  signatureChainId: string;
  hyperliquidChain: 'Mainnet' | 'Testnet';
  destination: string;
  token: string;
  amount: string;
  time: number;
};

export type HlUsdClassTransferAction = {
  type: 'usdClassTransfer';
  signatureChainId: string;
  hyperliquidChain: 'Mainnet';
  amount: string;
  toPerp: boolean;
  nonce: number;
};

// Built as one function so the signed message can never drift from the posted action: the
// message IS the action minus its `type` tag, and both come from the same object.
//
// The destination is lowercased. It is hashed as a string, so its case is inside the digest,
// and the server rebuilds the digest from the string we send. Lowercase is what the SDK's own
// fixture uses, and normalising here means the signed text and the sent text cannot disagree.
export function buildSpotSendPayload(args: {
  destination: string;
  amount: string;
  time: number;
  // Testnet exists here for the signing vectors only: nothing in this app posts to testnet.
  chain?: 'Mainnet' | 'Testnet';
}): { action: HlSpotSendAction; typedData: HlTypedData; nonce: number } {
  const action: HlSpotSendAction = {
    type: 'spotSend',
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    hyperliquidChain: args.chain ?? hlVenue().hyperliquidChain,
    destination: args.destination.trim().toLowerCase(),
    token: HL_USDC_TOKEN,
    amount: args.amount,
    time: args.time,
  };
  return {
    action,
    nonce: args.time, // the API rejects a nonce that does not equal action.time
    typedData: {
      domain: HL_DOMAIN,
      types: SPOT_SEND_TYPES as unknown as HlTypedData['types'],
      primaryType: 'HyperliquidTransaction:SpotSend',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        destination: action.destination,
        token: action.token,
        amount: action.amount,
        time: BigInt(action.time),
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

// ---------- the signing seam ----------

export type HlSignature = { r: Hex; s: Hex; v: number };

export type HlSignPort = {
  address(keysPath: string): Address;
  signTypedData(keysPath: string, typed: HlTypedData): Promise<HlSignature>;
};

// The DEBT this file carried is paid: it used to open the key file itself, because
// src/chain/evm.ts kept its reader private and this module could not edit it. Both now ask
// src/keystore for the material, so there is one door, and a locked wallet closes it.

export const liveSignPort: HlSignPort = {
  address: evmAddress,
  async signTypedData(keysPath, typed) {
    const account = privateKeyToAccount(evmPrivateKey(keysPath));
    const packed = await account.signTypedData(typed as never);
    // Hyperliquid wants {r, s, v} with v as 27 or 28, not viem's packed 65-byte hex.
    const { r, s, v, yParity } = parseSignature(packed);
    return { r, s, v: v !== undefined ? Number(v) : 27 + yParity };
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
};

type ClearinghouseState = {
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
};

async function info<T>(deps: HlUserSignedDeps, body: Record<string, unknown>): Promise<T> {
  const spec = hlVenue();
  const res = await (deps.fetchImpl ?? fetch)(spec.infoUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`hyperliquid ${String(body.type)} failed: ${res.status} ${await res.text()}`);
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

// ---------- the write path ----------

export type HlActionResult = {
  ok: boolean;
  detail: string;
  action?: HlSpotSendAction | HlUsdClassTransferAction;
  /* spotSend only: what the venue charged us on top of the amount, 1 for a fresh destination. */
  activationFeeUsdc?: number;
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
};

type ExchangeResponse = { status?: string; response?: unknown };

// The exchange endpoint answers HTTP 200 with {"status":"err","response":"<message>"} for a
// rejected action. Reading res.ok alone reports a refused withdrawal as a success, so the
// status field is checked as well and is what decides ok here.
async function postAction(
  deps: HlUserSignedDeps,
  action: HlSpotSendAction | HlUsdClassTransferAction,
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
    return { ok: false, detail: `${action.type} got a non-JSON reply: ${res.status} ${text.slice(0, 200)}`, body: text };
  }
  if (!res.ok) return { ok: false, detail: `${action.type} failed: HTTP ${res.status} ${text.slice(0, 200)}`, body };
  const status = (body as ExchangeResponse).status;
  if (status !== 'ok') {
    return { ok: false, detail: `${action.type} refused by Hyperliquid: ${JSON.stringify((body as ExchangeResponse).response ?? body)}`, body };
  }
  return { ok: true, detail: '', body };
}

// ---------- usdClassTransfer: spot <-> perp ----------

// Moves USDC between the two books on one account. Not a transfer to anyone: same account,
// different side. A standard account needs it in both directions: a HyperCore delivery can
// land on spot, and spotSend pays out of spot.
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

  const signature = await sign.signTypedData(deps.keysPath, typedData);
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, response: out.body, nonce, ambiguous: out.ambiguous };
  return {
    ok: true,
    detail: `moved ${amount} USDC ${params.toPerp ? 'spot -> perp' : 'perp -> spot'} on Hyperliquid`,
    action,
    response: out.body,
  };
}

// ---------- spotSend: USDC to another HyperCore address ----------

// The one action here that pays someone else, so it refuses more than it does. It has no
// default destination on purpose: the caller must name one, and the only caller is the
// withdraw rail, which names the address 1Click minted for the quote it just checked.
export async function spotSend(
  deps: HlUserSignedDeps,
  params: {
    destination: string;
    amount: number;
    /* Pass the nonce from a previous ambiguous attempt to RETRY it. Omitted, the clock is used
       and this is a new transfer. The venue refuses a nonce it has already seen, so a genuine
       retry is refused as a duplicate rather than paying out twice. */
    nonce?: number;
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

  // spotSend pays out of the spot book. On a unified account that is the single balance, and
  // the perp figure reads 0 while the money is present; on a standard account it is the spot
  // total, and money on the perp side has to be moved first.
  const summary = await accountSummary(deps, own);
  const sendable = summary.unified ? summary.availableUsdc : summary.spotUsdc;
  if (needed > sendable) {
    const why =
      activationFeeUsdc > 0 ? ` (${amount} plus the ${activationFeeUsdc} USDC activation fee for a destination the venue has never seen)` : '';
    const hint =
      !summary.unified && summary.perpWithdrawableUsd > 0
        ? ` The perp side holds ${summary.perpWithdrawableUsd} USDC; move it with usdClassTransfer({ amount, toPerp: false }) first.`
        : '';
    return {
      ok: false,
      detail:
        `REFUSED: ${summary.unified ? 'available' : 'spot holds'} ${summary.unified ? 'is ' : ''}${sendable} USDC ` +
        `and the transfer needs ${toAmountString(needed)}${why}.${hint}`,
    };
  }

  const { action, typedData, nonce } = buildSpotSendPayload({
    destination,
    amount,
    // The caller's nonce when retrying, the clock when this is a new transfer.
    time: params.nonce ?? (deps.now ?? Date.now)(),
  });

  const signature = await sign.signTypedData(deps.keysPath, typedData);
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, response: out.body, nonce, ambiguous: out.ambiguous };

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
