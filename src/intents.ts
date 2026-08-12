// NEAR Intents 1Click transport: quotes, deposit notification, status polling. Plus the
// synthetic quoter and the stub signer that predate it.
//
// Endpoint shapes verified against the live API 2026-08-12; notes in
// scratchpad/research-near.md. Two findings from that research shape this file:
//   - There is no testnet. One host, one verifier contract (intents.near), both mainnet.
//     A "testnet mode" pointing at a made-up host would be a lie, so this module carries
//     no host switch at all and src/rails/oneclick.ts holds the network guard.
//   - dry:false needs no API key and no exotic signing. An unauthenticated POST returns
//     HTTP 201 with a live deposit address, and the only signature the flow needs is a
//     plain ERC-20 transfer to that address.
//
// Everything this module returns is DATA. A field in a quote is a number or an address to
// be checked; it is never a rule, and a symbol from the remote token list never becomes a
// decision. The one thing we cannot verify is who owns the deposit address: that trust is
// inherent to the protocol, so the rail checks the address is well formed, checks the
// amounts the server echoes back, and lets the policy engine cap what is at stake.

import { parseUnits } from 'viem';
import type { ChainId, TransferLeg, LegQuote, Quoter, Signer } from './types.ts';

export const ONECLICK_BASE = 'https://1click.chaindefuser.com';

// Token registry shape loaded from data/tokens.json: chain -> symbol -> contract/mint id + decimals.
export type TokensFile = Record<ChainId, Record<string, { tokenId: string; decimals: number }>>;

// One entry from 1Click's GET /v0/tokens list.
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress?: string;
};

const CHAIN_TO_BLOCKCHAIN: Record<ChainId, string> = {
  eth: 'eth',
  base: 'base',
  arb: 'arb',
  sol: 'sol',
  near: 'near',
};

// Matches a chain + our token registry id against 1Click's token list. For near-chain
// tokens contractAddress carries the NEAR account id, so one field covers both cases.
export function assetIdFor(chain: ChainId, tokenId: string, list: OneClickToken[]): string | null {
  const blockchain = CHAIN_TO_BLOCKCHAIN[chain];
  const wantId = tokenId.toLowerCase();
  const match = list.find(
    (t) => t.blockchain.toLowerCase() === blockchain && (t.contractAddress ?? '').toLowerCase() === wantId,
  );
  return match ? match.assetId : null;
}

// ---------- amounts ----------

// A JS number printed by String() switches to exponent form at 1e21 and below 1e-6.
// parseUnits wants a plain decimal string, so expand it first.
function plainDecimal(value: number): string {
  const text = String(value);
  const parts = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (parts === null) return text;

  const sign = parts[1];
  const digits = parts[2] + (parts[3] ?? '');
  const point = parts[2].length + Number(parts[4]); // where the decimal point lands in `digits`

  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// UI units -> base units, through decimal strings and BigInt.
//
// The float version of this (Math.round(amount * 10 ** decimals)) is wrong twice over at
// 18 decimals, and both failures are silent:
//   2.3 DAI  -> 2299999999999999700, which is 300 wei short of what the human approved
//   1000 DAI -> "1e+21", which is not an integer string and is not a valid API amount
// Neither shows up at 6 decimals, which is why a USDC-only test suite never caught it.
//
// The double is the only input we have, so the contract is: take the shortest decimal
// string that round-trips it, then scale exactly. viem's parseUnits does the scaling and
// the half-up rounding of excess fraction digits, on the audited path the signer already
// depends on.
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount must be a finite number (got ${amount})`);
  if (amount < 0) throw new Error(`amount must not be negative (got ${amount})`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer in 0..36 (got ${decimals})`);
  }
  return parseUnits(plainDecimal(amount), decimals);
}

// ---------- responses, treated as data ----------

export type OneClickQuote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
};

export type OneClickQuoteResponse = {
  quote: OneClickQuote;
  quoteRequest?: unknown;
  signature?: string; // keep it: the docs say this is what resolves a dispute
  timestamp?: string;
  correlationId?: string;
  raw: unknown;
};

// The seven values the spec defines. Anything else is reported as UNKNOWN and is never
// treated as terminal, so a renamed or invented status stalls the poll rather than
// declaring a swap finished.
export type OneClickStatusName =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export const ONECLICK_STATUSES: readonly OneClickStatusName[] = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
];

export const ONECLICK_TERMINAL: readonly OneClickStatusName[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

export type OneClickStatus = {
  found: boolean; // false on 404: the address is not known to the API yet
  status: OneClickStatusName | 'UNKNOWN';
  reported: string; // what the API actually said, one line, bounded
  originTxHashes: string[];
  destinationTxHashes: string[];
};

// Remote text lands in one-line audit entries and in the approval gate a human reads.
// Holding it to one bounded line is not censorship, it is the shape of the field: a solver
// answering with newlines or terminal escapes could otherwise forge extra lines in a log.
export function oneLine(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  let flat = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    flat += code < 32 || code === 127 ? ' ' : ch;
  }
  const tidy = flat.replace(/\s+/g, ' ').trim();
  return tidy.length > max ? tidy.slice(0, max) + '...' : tidy;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => oneLine(v, 120));
}

export type OneClickQuoteParams = {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string; // base units, as a decimal integer string
  refundTo: string;
  recipient: string;
  slippageToleranceBps?: number; // default 100 = 1%
  deadlineMs?: number; // how far ahead the request deadline sits; default 10 minutes
  referral?: string;
};

export type OneClickDeps = { fetchImpl?: typeof fetch };

export type OneClickClient = {
  tokens(): Promise<OneClickToken[]>;
  quote(params: OneClickQuoteParams): Promise<OneClickQuoteResponse>;
  submitDeposit(depositAddress: string, txHash: string): Promise<{ ok: boolean; detail: string }>;
  status(depositAddress: string, depositMemo?: string): Promise<OneClickStatus>;
};

export function oneClickClient(deps: OneClickDeps = {}): OneClickClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let tokenListCache: OneClickToken[] | null = null;

  async function tokens(): Promise<OneClickToken[]> {
    if (tokenListCache) return tokenListCache;
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/tokens`);
    if (!res.ok) {
      throw new Error(`1click token list fetch failed: ${res.status} ${await res.text()}`);
    }
    const list = (await res.json()) as OneClickToken[];
    tokenListCache = list;
    return list;
  }

  async function quote(params: OneClickQuoteParams): Promise<OneClickQuoteResponse> {
    const deadline = new Date(Date.now() + (params.deadlineMs ?? 10 * 60 * 1000)).toISOString();
    const body: Record<string, unknown> = {
      dry: params.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: params.slippageToleranceBps ?? 100,
      originAsset: params.originAsset,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      refundTo: params.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: params.recipient,
      recipientType: 'DESTINATION_CHAIN',
      // ORIGIN_CHAIN is the whole reason this rail needs no NEAR account and no NEP-413
      // signing: the funds arrive by ordinary transfer. INTENTS would need both, plus a
      // partner API key.
      depositType: 'ORIGIN_CHAIN',
      deadline,
    };
    if (params.referral !== undefined) body.referral = params.referral;

    const res = await fetchImpl(`${ONECLICK_BASE}/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      const msg = payload?.['message'] ?? payload?.['error'];
      throw new Error(msg !== undefined ? oneLine(msg) : `1click quote failed: ${res.status}`);
    }
    const quoteField = payload?.['quote'] as OneClickQuote | undefined;
    if (!quoteField || typeof quoteField !== 'object') {
      const msg = payload?.['message'];
      throw new Error(msg !== undefined ? oneLine(msg) : 'no quote in 1click response');
    }

    return {
      quote: quoteField,
      quoteRequest: payload?.['quoteRequest'],
      signature: typeof payload?.['signature'] === 'string' ? (payload['signature'] as string) : undefined,
      timestamp: typeof payload?.['timestamp'] === 'string' ? (payload['timestamp'] as string) : undefined,
      correlationId: typeof payload?.['correlationId'] === 'string' ? (payload['correlationId'] as string) : undefined,
      raw: payload,
    };
  }

  // Optional in the protocol: it only tells the solver to stop waiting for a deposit it
  // would have found anyway. A failure here is never fatal, so it reports rather than throws.
  async function submitDeposit(depositAddress: string, txHash: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetchImpl(`${ONECLICK_BASE}/v0/deposit/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depositAddress, txHash }),
      });
      if (!res.ok) return { ok: false, detail: `deposit/submit returned ${res.status}` };
      return { ok: true, detail: 'deposit notified' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? oneLine(err.message) : 'deposit/submit failed' };
    }
  }

  async function status(depositAddress: string, depositMemo?: string): Promise<OneClickStatus> {
    const url = new URL(`${ONECLICK_BASE}/v0/status`);
    url.searchParams.set('depositAddress', depositAddress);
    if (depositMemo !== undefined && depositMemo !== '') url.searchParams.set('depositMemo', depositMemo);

    const res = await fetchImpl(url.toString());
    if (res.status === 404) {
      // The API has not seen this address yet. Not an error, and not terminal.
      return {
        found: false,
        status: 'PENDING_DEPOSIT',
        reported: 'not found yet',
        originTxHashes: [],
        destinationTxHashes: [],
      };
    }
    if (!res.ok) throw new Error(`1click status failed: ${res.status}`);

    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const reported = oneLine(payload?.['status'] ?? 'missing status field', 60);
    const known = (ONECLICK_STATUSES as readonly string[]).includes(reported);
    const details = (payload?.['swapDetails'] ?? {}) as Record<string, unknown>;

    return {
      found: true,
      status: known ? (reported as OneClickStatusName) : 'UNKNOWN',
      reported,
      originTxHashes: stringsOf(details['originChainTxHashes']),
      destinationTxHashes: stringsOf(details['destinationChainTxHashes']),
    };
  }

  return { tokens, quote, submitDeposit, status };
}

// ---------- the Quoter used to price a consolidation ----------

export function oneClickQuoter(tokens: TokensFile, deps?: { fetchImpl?: typeof fetch }): Quoter {
  const client = oneClickClient({ fetchImpl: deps?.fetchImpl });

  async function quoteLeg(leg: TransferLeg): Promise<LegQuote> {
    const originInfo = tokens[leg.fromChain]?.[leg.symbol];
    const destInfo = tokens[leg.toChain]?.[leg.symbol];
    if (!originInfo) throw new Error(`no token registry entry for ${leg.symbol} on ${leg.fromChain}`);
    if (!destInfo) throw new Error(`no token registry entry for ${leg.symbol} on ${leg.toChain}`);

    const list = await client.tokens();
    const originAsset = assetIdFor(leg.fromChain, originInfo.tokenId, list);
    const destinationAsset = assetIdFor(leg.toChain, destInfo.tokenId, list);
    if (!originAsset) throw new Error(`no 1click asset id for ${leg.symbol} on ${leg.fromChain}`);
    if (!destinationAsset) throw new Error(`no 1click asset id for ${leg.symbol} on ${leg.toChain}`);

    // dry:true always. This path prices a proposal; it must never mint a deposit address.
    const response = await client.quote({
      dry: true,
      originAsset,
      destinationAsset,
      amount: toBaseUnits(leg.amount, originInfo.decimals).toString(),
      refundTo: leg.from,
      recipient: leg.to,
    });

    const quote = response.quote;
    const amountInUsd = Number(quote.amountInUsd);
    const amountOutUsd = Number(quote.amountOutUsd);

    return {
      amountOut: Number(quote.amountOutFormatted),
      feeUsd: amountInUsd - amountOutUsd,
      timeEstimateSec: Number(quote.timeEstimate),
      raw: response.raw,
    };
  }

  return { name: 'oneclick', quoteLeg };
}

export function syntheticQuoter(): Quoter {
  return {
    name: 'synthetic',
    async quoteLeg(leg: TransferLeg): Promise<LegQuote> {
      return {
        amountOut: leg.amount * 0.9999 - 0.02,
        feeUsd: leg.amount * 0.0001 + 0.02,
        timeEstimateSec: 8,
      };
    },
  };
}

export function stubSigner(): Signer {
  const describe = () => 'No signer configured. Add keys via config to enable live execution (auth step).';
  return {
    ready: false,
    describe,
    async send() {
      return { ok: false, error: describe() };
    },
  };
}
