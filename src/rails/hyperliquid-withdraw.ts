// The Hyperliquid withdrawal path: move USDC off a Hyperliquid account and back onto Arbitrum.
//
// This is the mirror of hyperliquid-deposit.ts and it works nothing like it. A deposit is a
// plain ERC-20 transfer on Arbitrum. A withdrawal is a SIGNED API ACTION: no transaction, no
// gas, no contract call from us. We sign an EIP-712 payload, POST it to /exchange, and the
// validators push USDC out to the destination on Arbitrum in three to five minutes.
//
// Two actions live here because on this account you need both. withdraw3 pays out of the PERP
// balance, and a bridge deposit also lands on the perp side, but spot and perp are separate
// books on the same account. Money sitting in spot is invisible to withdraw3. usdClassTransfer
// is the move between them.
//
// These are exported as plain functions rather than a Rail on purpose. A Rail is reachable by
// the agent through MCP, and "withdraw everything to an address" is the one operation in this
// repo that must stay in a human's hands. There is deliberately no MCP tool for this module.
//
// The signing scheme is the whole job, so it is stated once here and asserted against the
// official SDK's own fixtures in the tests:
//   - EIP-712 typed data, NOT personal_sign, and NOT the msgpack phantom-agent scheme that L1
//     order actions use. The two schemes share an endpoint and nothing else.
//   - domain name is 'HyperliquidSignTransaction'. L1 actions use 'Exchange'. Different domain.
//   - domain chainId is 421614 and is NOT the network selector. It only declares which chain
//     the wallet thinks it is signing on, and the docs accept 42161 there too. The field that
//     actually separates the two worlds is hyperliquidChain, inside the signed message. That is
//     the field to get right: a payload signed with 'Mainnet' is a valid mainnet instruction.
//   - the top-level nonce must equal the action's time (withdraw3) or nonce (usdClassTransfer),
//     in MILLISECONDS. A mismatch is rejected.
//
// The fee is 1.0 USDC and it comes OUT OF the amount: the destination receives amount - 1. That
// is not in the testnet docs, so it was measured. See MIN_WITHDRAW_USDC below.

import fs from 'node:fs';
import { isAddress, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { evmAddress } from '../chain/evm.ts';
import type { Network } from '../types.ts';

// ---------- the per-network table ----------

// Same rule as the deposit rail: nothing here has a default. A default is how a testnet build
// ends up pointed at mainnet.
export type HlWithdrawSpec = {
  exchangeUrl: string;
  infoUrl: string;
  hyperliquidChain: 'Testnet' | 'Mainnet'; // the real network separator, inside the signature
  label: string; // where the money lands, for humans reading a refusal
};

const HL_WITHDRAW_NETWORKS: Record<Network, HlWithdrawSpec> = {
  testnet: {
    exchangeUrl: 'https://api.hyperliquid-testnet.xyz/exchange',
    infoUrl: 'https://api.hyperliquid-testnet.xyz/info',
    hyperliquidChain: 'Testnet',
    label: 'Arbitrum Sepolia',
  },
  mainnet: {
    exchangeUrl: 'https://api.hyperliquid.xyz/exchange',
    infoUrl: 'https://api.hyperliquid.xyz/info',
    hyperliquidChain: 'Mainnet',
    label: 'Arbitrum One',
  },
};

function hlWithdrawSpec(network: Network): HlWithdrawSpec {
  const spec = HL_WITHDRAW_NETWORKS[network];
  if (spec === undefined) throw new Error(`no Hyperliquid withdraw spec for network ${JSON.stringify(network)}`);
  return spec;
}

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
export const WITHDRAW_TYPES = {
  'HyperliquidTransaction:Withdraw': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
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

// Measured, not assumed. The docs quote $1 on the mainnet page and say nothing about testnet, so
// this was read off nine real testnet withdrawals in userNonFundingLedgerUpdates: every one
// carries "fee":"1.0". There is no testnet discount.
export const WITHDRAW_FEE_USDC = 1;

// The fee comes out of the amount, so the destination receives amount - 1. Established three
// ways that agree: the nktkas SDK's integration test funds a perp account with exactly "2" and
// then withdraws "2" successfully, which is only possible if the fee is inside the amount; a
// zero-fill testnet account's 76 withdrawals reconcile to its live balance to the cent only
// under that model; and the bridge's outbound Transfer amounts equal the ledger's net figure.
//
// So anything at or below 1.0 delivers nothing while still emptying that much from the account.
// 2 is the floor: the smallest amount that actually lands at least 1 USDC2 on the far side.
export const MIN_WITHDRAW_USDC = 2;

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

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- the payloads ----------

export type HlTypedData = {
  domain: typeof HL_DOMAIN;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type HlWithdrawAction = {
  type: 'withdraw3';
  signatureChainId: string;
  hyperliquidChain: 'Testnet' | 'Mainnet';
  destination: string;
  amount: string;
  time: number;
};

export type HlUsdClassTransferAction = {
  type: 'usdClassTransfer';
  signatureChainId: string;
  hyperliquidChain: 'Testnet' | 'Mainnet';
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
export function buildWithdrawPayload(args: {
  network: Network;
  destination: string;
  amount: string;
  time: number;
}): { action: HlWithdrawAction; typedData: HlTypedData; nonce: number } {
  const spec = hlWithdrawSpec(args.network);
  const action: HlWithdrawAction = {
    type: 'withdraw3',
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    hyperliquidChain: spec.hyperliquidChain,
    destination: args.destination.trim().toLowerCase(),
    amount: args.amount,
    time: args.time,
  };
  return {
    action,
    nonce: args.time, // the API rejects a nonce that does not equal action.time
    typedData: {
      domain: HL_DOMAIN,
      types: WITHDRAW_TYPES as unknown as HlTypedData['types'],
      primaryType: 'HyperliquidTransaction:Withdraw',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        destination: action.destination,
        amount: action.amount,
        time: BigInt(action.time),
      },
    },
  };
}

export function buildUsdClassTransferPayload(args: {
  network: Network;
  amount: string;
  toPerp: boolean;
  nonce: number;
}): { action: HlUsdClassTransferAction; typedData: HlTypedData; nonce: number } {
  const spec = hlWithdrawSpec(args.network);
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

// DEBT, flagged for review rather than hidden: src/chain/evm.ts opens by saying it is the ONE
// module that reads the key, and this is a second one. evm.ts exports evmAddress but no signer
// and keeps its readEvmKey private, and this module was scoped without permission to edit it.
// The fix is one additive export there (signTypedDataEvm) and deleting this function. Until
// then the key is read at the moment of use, handed straight to viem, and never stored in
// module state, logged, or returned.
function readEvmKey(keysPath: string): Hex {
  if (!fs.existsSync(keysPath)) throw new Error(`no keys file at ${keysPath}. Run: npm run keygen`);
  const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as { evm?: { privateKey?: string } };
  const key = parsed.evm?.privateKey;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`keys file at ${keysPath} has no valid evm.privateKey`);
  }
  return key as Hex;
}

export const liveSignPort: HlSignPort = {
  address: evmAddress,
  async signTypedData(keysPath, typed) {
    const account = privateKeyToAccount(readEvmKey(keysPath));
    const packed = await account.signTypedData(typed as never);
    // Hyperliquid wants {r, s, v} with v as 27 or 28, not viem's packed 65-byte hex.
    const { r, s, v, yParity } = parseSignature(packed);
    return { r, s, v: v !== undefined ? Number(v) : 27 + yParity };
  },
};

// ---------- reads ----------

export type HlAccountSummary = {
  address: string;
  network: Network;
  spotUsdc: number; // where a faucet drip and any spot trading proceeds sit
  perpAccountValueUsd: number;
  perpWithdrawableUsd: number; // 0 on a unified account even when funds are present
  availableUsdc: number; // what withdraw3 may actually draw on, either shape of account
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

export type HlWithdrawDeps = {
  network: Network;
  keysPath: string;
  sign?: HlSignPort;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

async function info<T>(deps: HlWithdrawDeps, body: Record<string, unknown>): Promise<T> {
  const spec = hlWithdrawSpec(deps.network);
  const res = await (deps.fetchImpl ?? fetch)(spec.infoUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid ${String(body.type)} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// Both books, because the difference between them is the whole reason usdClassTransfer exists.
export async function accountSummary(deps: HlWithdrawDeps, address?: string): Promise<HlAccountSummary> {
  const sign = deps.sign ?? liveSignPort;
  const user = (address ?? sign.address(deps.keysPath)).trim();
  if (!isAddress(user)) throw new Error(`hyperliquid accountSummary: ${user} is not an address`);

  const [perp, spot] = await Promise.all([
    info<ClearinghouseState>(deps, { type: 'clearinghouseState', user, dex: '' }),
    info<SpotClearinghouseState>(deps, { type: 'spotClearinghouseState', user }),
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
    network: deps.network,
    spotUsdc: num((spot.balances ?? []).find((b) => b.coin === 'USDC')?.total),
    perpAccountValueUsd: num(perp.marginSummary?.accountValue),
    perpWithdrawableUsd: num(perp.withdrawable),
    // What a withdrawal may actually draw on, whichever shape the account is in. The perp
    // book on a classic account, the unified figure on a unified one.
    availableUsdc: Math.max(num(perp.withdrawable), unifiedUsdc),
    unified: unifiedUsdc > 0 && num(perp.withdrawable) === 0,
    marginUsedUsd: num(perp.marginSummary?.totalMarginUsed),
    openPositions: Array.isArray(perp.assetPositions) ? perp.assetPositions.length : 0,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- the write path ----------

export type HlActionResult = {
  ok: boolean;
  detail: string;
  action?: HlWithdrawAction | HlUsdClassTransferAction;
  response?: unknown;
};

type ExchangeResponse = { status?: string; response?: unknown };

// The exchange endpoint answers HTTP 200 with {"status":"err","response":"<message>"} for a
// rejected action. Reading res.ok alone reports a refused withdrawal as a success, so the
// status field is checked as well and is what decides ok here.
async function postAction(
  deps: HlWithdrawDeps,
  action: HlWithdrawAction | HlUsdClassTransferAction,
  nonce: number,
  signature: HlSignature,
): Promise<{ ok: boolean; detail: string; body: unknown }> {
  const spec = hlWithdrawSpec(deps.network);
  const res = await (deps.fetchImpl ?? fetch)(spec.exchangeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const text = await res.text();
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

// Every write in this module goes through here first. Mainnet is not a supported configuration
// for this file: it moves real money and nobody authorised that, so it throws rather than
// refusing softly. A thrown error cannot be mistaken for a result object with ok:false.
function assertTestnet(deps: HlWithdrawDeps): void {
  if (deps.network !== 'testnet') {
    throw new Error(
      `hyperliquid-withdraw is TESTNET ONLY and this app is configured for ${deps.network}. ` +
        `These actions move real funds on mainnet. Refusing to sign.`,
    );
  }
}

// ---------- usdClassTransfer: spot <-> perp ----------

// Moves USDC between the two books on one account. Not a transfer to anyone: same account,
// different side. Needed before any withdrawal, because withdraw3 pays out of perp and a
// faucet drip lands in spot.
export async function usdClassTransfer(
  deps: HlWithdrawDeps,
  params: { amount: number; toPerp: boolean },
): Promise<HlActionResult> {
  assertTestnet(deps);
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
    network: deps.network,
    amount,
    toPerp: params.toPerp,
    nonce: (deps.now ?? Date.now)(),
  });

  const signature = await sign.signTypedData(deps.keysPath, typedData);
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, response: out.body };
  return {
    ok: true,
    detail: `moved ${amount} USDC ${params.toPerp ? 'spot -> perp' : 'perp -> spot'} on Hyperliquid ${deps.network}`,
    action,
    response: out.body,
  };
}

// ---------- withdraw3: off Hyperliquid, onto Arbitrum ----------

// The highest-risk operation in this repo, so it refuses more than it does.
//
// destination defaults to the app's own signing address and a different one is refused unless
// the caller passes allowExternalDestination. That flag exists so the refusal is a deliberate
// decision at the call site rather than a typo in an address argument. There is no MCP tool
// wired to any of this, so an agent cannot reach the flag at all.
export async function withdraw3(
  deps: HlWithdrawDeps,
  params: { amount: number; destination?: string; allowExternalDestination?: boolean },
): Promise<HlActionResult> {
  assertTestnet(deps);
  const sign = deps.sign ?? liveSignPort;
  const spec = hlWithdrawSpec(deps.network);

  let own: Address;
  try {
    own = sign.address(deps.keysPath);
  } catch (err) {
    return { ok: false, detail: `REFUSED: cannot resolve the signing wallet: ${errText(err)}` };
  }

  const destination = (params.destination ?? own).trim();
  if (!isAddress(destination)) {
    return { ok: false, detail: `REFUSED: destination ${params.destination} is not an address` };
  }
  if (!sameAddress(destination, own) && params.allowExternalDestination !== true) {
    return {
      ok: false,
      detail:
        `REFUSED: destination ${destination} is not this app's own address (${own}). ` +
        `A withdrawal to an outside address is irreversible; pass allowExternalDestination to mean it.`,
    };
  }

  let amount: string;
  try {
    amount = toAmountString(params.amount);
  } catch (err) {
    return { ok: false, detail: `REFUSED: ${errText(err)}` };
  }

  // The fee is taken out of the amount, so anything at or below it delivers nothing while
  // still leaving the account.
  if (params.amount < MIN_WITHDRAW_USDC) {
    return {
      ok: false,
      detail:
        `REFUSED: amount ${amount} is below the ${MIN_WITHDRAW_USDC} USDC minimum. ` +
        `Hyperliquid takes a ${WITHDRAW_FEE_USDC} USDC fee out of the amount, so ${amount} would deliver ` +
        `${(params.amount - WITHDRAW_FEE_USDC).toFixed(6)} to ${spec.label} while still leaving the account.`,
    };
  }

  // What the account can actually pay out. On a classic account that is the perp book; on a
  // unified one the two books are merged and the perp figure reads 0 while the money is all
  // in spot. Guarding on the perp number alone refused a withdrawal this account could
  // certainly afford, and advised a usdClassTransfer that a unified account rejects outright.
  const summary = await accountSummary(deps, own);
  if (params.amount > summary.availableUsdc) {
    const hint =
      !summary.unified && summary.spotUsdc > 0
        ? ` Spot holds ${summary.spotUsdc} USDC; move it with usdClassTransfer({ amount, toPerp: true }) first.`
        : '';
    return {
      ok: false,
      detail:
        `REFUSED: ${summary.unified ? 'available' : 'perp withdrawable'} is ${summary.availableUsdc} USDC ` +
        `and the withdrawal needs ${amount}.${hint}`,
    };
  }

  const { action, typedData, nonce } = buildWithdrawPayload({
    network: deps.network,
    destination,
    amount,
    time: (deps.now ?? Date.now)(),
  });

  const signature = await sign.signTypedData(deps.keysPath, typedData);
  const out = await postAction(deps, action, nonce, signature);
  if (!out.ok) return { ok: false, detail: out.detail, action, response: out.body };

  const net = (params.amount - WITHDRAW_FEE_USDC).toFixed(6);
  return {
    ok: true,
    detail:
      `withdrawal of ${amount} USDC accepted on Hyperliquid ${deps.network}. ` +
      `${destination} receives ${net} USDC2 on ${spec.label} in three to five minutes ` +
      `(${WITHDRAW_FEE_USDC} USDC fee). No Arbitrum transaction from us: the validators push it.`,
    action,
    response: out.body,
  };
}
