// NEAR Intents 1Click transport: quotes, deposit notification, status polling. Plus the
// synthetic quoter and the stub signer that predate it.
//
// Endpoint shapes verified against the live API 2026-08-12; notes in
// scratchpad/research-near.md. Two findings from that research shape this file:
//   - One host and one verifier contract (intents.near), with no second world to point at.
//     A host switch here could only select a made-up host, so this module carries none.
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
import { readTimeout, venueWriteTimeout } from './net.ts';

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

/* Matches a chain + our token registry id against 1Click's token list. For near-chain
   tokens contractAddress carries the NEAR account id, so one field covers both cases.

   `expectDecimals` is the registry's own figure for the same token, and passing it is what turns
   this from a lookup into an agreement. The matched entry carries decimals too, and this used to
   discard them: every amount was then scaled by the repo's number while the venue quoted against
   its own, so the two disagreeing would misprice a transfer by a power of ten. Checked against
   the live list and against on-chain decimals() on 2026-09-07 there were no mismatches, so this
   is hardening rather than a live bug, and the HyperCore rail already does exactly this check
   for its one pinned asset.

   A mismatch throws rather than returning null, because null already means "the venue does not
   list this" and the two are different facts with different fixes. Every call site is already
   inside the try that wraps fetching the list. */
export function assetIdFor(
  chain: ChainId,
  tokenId: string,
  list: OneClickToken[],
  expectDecimals?: number,
): string | null {
  const blockchain = CHAIN_TO_BLOCKCHAIN[chain];
  const wantId = tokenId.toLowerCase();
  const match = list.find(
    (t) => t.blockchain.toLowerCase() === blockchain && (t.contractAddress ?? '').toLowerCase() === wantId,
  );
  if (!match) return null;
  if (expectDecimals !== undefined && match.decimals !== expectDecimals) {
    throw new Error(
      `1click lists ${oneLine(tokenId, 60)} on ${chain} with ${match.decimals} decimals and this app's registry ` +
        `says ${expectDecimals}. Every amount sent would be wrong by a factor of ten, so nothing is quoted until ` +
        'the two agree',
    );
  }
  return match.assetId;
}

// The gas asset of a chain, which assetIdFor cannot find because 1Click lists a native asset
// with NO contractAddress field at all: native ETH on ethereum is
// {assetId:'nep141:eth.omft.near', blockchain:'eth', symbol:'ETH'} and nothing else.
// Verified against the live token list 2026-08-13.
//
// Matching therefore has to fall back to the symbol, which is remote text, so this is
// deliberately stricter than assetIdFor in two ways. The symbol comes from OUR table below
// and never from a caller, and an ambiguous list (two entries claiming to be the gas asset
// of one chain) returns null rather than picking one. A native asset id decides where real
// money goes, so "the answer was not unique" has to be a refusal and not a coin flip.
export function nativeAssetIdFor(chain: ChainId, list: OneClickToken[]): string | null {
  const blockchain = CHAIN_TO_BLOCKCHAIN[chain];
  const spec = NATIVE_ASSET[chain];
  if (spec === undefined) return null;
  const matches = list.filter(
    (t) =>
      t.blockchain.toLowerCase() === blockchain &&
      t.symbol === spec.symbol &&
      (t.contractAddress === undefined || t.contractAddress === ''),
  );
  return matches.length === 1 ? matches[0].assetId : null;
}

// The gas asset per chain. A table in this repo, not a lookup on the wire: an agent naming
// a symbol must not be able to make the app treat some other token as the thing it spends.
// Decimals are the chain's own and are never read from the remote list either, because they
// scale the amount that leaves the wallet.
export const NATIVE_ASSET: Partial<Record<ChainId, { symbol: string; decimals: number }>> = {
  eth: { symbol: 'ETH', decimals: 18 },
  base: { symbol: 'ETH', decimals: 18 },
  arb: { symbol: 'ETH', decimals: 18 },
  sol: { symbol: 'SOL', decimals: 9 },
  near: { symbol: 'NEAR', decimals: 24 },
};

// What src/ledger/evm.ts and src/ledger/near.ts already put in Holding.tokenId for the gas
// asset. Kept here so a draft can name the native asset without inventing a second spelling.
export const NATIVE_TOKEN_ID = 'native';

// One place that turns "USDC on base" or "ETH on eth" into the pair a quote needs. The token
// registry is tried first and the gas-asset table second, so a chain that lists a symbol
// explicitly always wins over the fallback and no registry entry can be shadowed.
//
// It exists because both intents rails needed the same two-step lookup and neither could
// express a gas asset without it: data/tokens.json holds ERC-20 contracts, and a native asset
// has no contract to hold. Adding a 'native' row to that file instead was rejected because
// src/ledger/evm.ts reads the same file to build balanceOf calls and would have sent
// eth_call to the string "native".
export function resolveAsset(
  chain: ChainId,
  symbol: string,
  tokens: TokensFile,
  list: OneClickToken[],
): { assetId: string; decimals: number; native: boolean } {
  const registry = tokens[chain]?.[symbol];
  if (registry !== undefined) {
    const assetId = assetIdFor(chain, registry.tokenId, list, registry.decimals);
    if (assetId === null) throw new Error(`1click does not list ${symbol} on ${chain}`);
    return { assetId, decimals: registry.decimals, native: false };
  }

  const spec = NATIVE_ASSET[chain];
  if (spec !== undefined && spec.symbol === symbol) {
    const assetId = nativeAssetIdFor(chain, list);
    if (assetId === null) throw new Error(`1click does not list native ${symbol} on ${chain} unambiguously`);
    return { assetId, decimals: spec.decimals, native: true };
  }

  throw new Error(`no token registry entry for ${symbol} on ${chain}, and it is not that chain's gas asset`);
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

// A base-unit field off a quote. Never Number(): 18-decimal amounts do not survive a double, and
// a garbage string must fail loudly rather than become NaN.
//
// One copy, here, because four rails each had their own and the fifth caller was about to make a
// fifth. A missing field throws rather than defaulting to zero, which matters most for the field
// this was added for: minAmountOut absent is a quote that guarantees nothing, and reading it as
// a floor of zero is how a rail accepts exactly that.
export function baseUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`1click quote is missing ${field}`);
  }
  if (value === '') throw new Error(`1click quote is missing ${field}`);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`1click quote returned a non-integer ${field}: ${oneLine(value, 40)}`);
  }
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

const ONECLICK_STATUSES: readonly OneClickStatusName[] = [
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

// Where the output of a swap is delivered, and where a refund goes if it does not happen.
// DESTINATION_CHAIN / ORIGIN_CHAIN mean an ordinary on-chain address. INTENTS means a
// balance held inside the intents.near verifier under an account id, which is what a
// "deposit onto NEAR Intents" is: no wallet on the other side, just a credited balance.
export type OneClickEndpointType = 'DESTINATION_CHAIN' | 'ORIGIN_CHAIN' | 'INTENTS';

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
  // The three routing fields, defaulted to the wallet-to-wallet shape the swap rail has
  // always sent. They are options rather than constants because the deposit rail needs
  // recipientType INTENTS, and they are named explicitly at every call site so that reading
  // a rail tells you where its money ends up without reading this file.
  recipientType?: OneClickEndpointType;
  refundType?: OneClickEndpointType;
  depositType?: OneClickEndpointType;
};

/* ---------- the quote echo, checked once for every rail ----------

   The API echoes the request it priced, verbatim, in `quoteRequest` (verified live 2026-08-13).
   That echo is the only place a quote states where the money ends up, so every field that
   decides that is compared against what the rail asked for.

   This lived in two rails and not in the other three, which is how the same defect was found
   twice: a quote priced to credit a DIFFERENT recipient, to take its input from a chain transfer
   rather than the verifier balance, or to refund somewhere that is not our account passed every
   check the two rails without it made. So it is one function now. Four copies of a check is how
   the fourth one gets forgotten, which is exactly what happened.

   A missing echo is a refusal, not a shrug. Each rail says in `noEcho` why it cannot proceed
   without one, because the reason differs: an intent names no destination at all, and an
   ordinary transfer goes to an address only the echo ties to a payout. */
export type QuoteEcho = {
  // Where the proceeds land. `verb` and `noun` are the rail's own words for it, so the refusal
  // reads as a sentence about this rail rather than a generic mismatch.
  recipient: string;
  recipientVerb: 'pay' | 'credit';
  recipientNoun: string;
  recipientType: OneClickEndpointType;
  recipientTypeWhy: string;
  // Where the input comes from, and where a failure puts it back.
  depositType: OneClickEndpointType;
  refundType: OneClickEndpointType;
  refundTypeWhy: string;
  refundTo: string;
  // The assets and the size, as a complete second opinion rather than a partial one.
  originAsset: string;
  destinationAsset: string;
  amount: string; // base units, as a decimal integer string
  noEcho: string;
};

/* Whether two endpoints in a quote are the same one.
   Exact by default, because base58 case carries key material and two Solana strings differing
   only in case are two different accounts. EVM addresses are the exception and only the
   exception: the same 20 bytes have a checksummed spelling and a lowercase one, and both name
   the same account. Recognising the exception by shape rather than by chain is what lets one
   comparison serve a rail whose recipient may be an EVM address, a Solana key or a NEAR id. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function sameEndpoint(value: unknown, want: string): boolean {
  if (typeof value !== 'string') return false;
  if (EVM_ADDRESS.test(value) && EVM_ADDRESS.test(want)) return value.toLowerCase() === want.toLowerCase();
  return value === want;
}

export function quoteEchoProblems(raw: unknown, want: QuoteEcho): string[] {
  if (raw === null || typeof raw !== 'object') {
    return [`the quote response is not an object (got ${oneLine(raw, 60)})`];
  }
  const echo = (raw as Record<string, unknown>)['quoteRequest'];
  if (echo === null || typeof echo !== 'object' || Array.isArray(echo)) {
    return [`the quote carries no quoteRequest echo, so ${want.noEcho}`];
  }
  const req = echo as Record<string, unknown>;
  const problems: string[] = [];
  const say = (field: string): string => oneLine(req[field], 60);

  if (!sameEndpoint(req['recipient'], want.recipient)) {
    problems.push(
      `the quote was priced to ${want.recipientVerb} ${say('recipient')}, not our ${want.recipientNoun} ` +
        `${oneLine(want.recipient, 60)}`,
    );
  }
  if (req['recipientType'] !== want.recipientType) {
    problems.push(`the quote pays out as ${say('recipientType')}, not ${want.recipientType}: ${want.recipientTypeWhy}`);
  }
  if (req['depositType'] !== want.depositType) {
    problems.push(`the quote takes its input as ${say('depositType')}, not the ${want.depositType} balance this rail spends`);
  }
  if (req['refundType'] !== want.refundType) {
    problems.push(`a refund on this quote goes to ${say('refundType')}, not ${want.refundTypeWhy}`);
  }
  if (!sameEndpoint(req['refundTo'], want.refundTo)) {
    problems.push(`a refund on this quote goes to ${say('refundTo')}, not to our account ${oneLine(want.refundTo, 60)}`);
  }
  if (req['originAsset'] !== want.originAsset || req['destinationAsset'] !== want.destinationAsset) {
    problems.push(
      `the quote moves ${say('originAsset')} to ${say('destinationAsset')}, not the ` +
        `${oneLine(want.originAsset, 40)} to ${oneLine(want.destinationAsset, 40)} the draft names`,
    );
  }
  if (req['amount'] !== want.amount) {
    problems.push(`the quote was priced for ${say('amount')} base units, not the ${want.amount} approved`);
  }

  return problems;
}

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
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/tokens`, { signal: readTimeout() });
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
      refundType: params.refundType ?? 'ORIGIN_CHAIN',
      recipient: params.recipient,
      recipientType: params.recipientType ?? 'DESTINATION_CHAIN',
      // depositType ORIGIN_CHAIN is why the swap rail needs no NEAR account and no message
      // signing: the funds arrive by ordinary transfer, so the solver needs no authorisation
      // from us beyond seeing the money. depositType INTENTS is the other case, where the
      // input is a balance already inside the verifier and a signed intent releases it; that
      // is src/rails/intents-native.ts and it passes this explicitly.
      depositType: params.depositType ?? 'ORIGIN_CHAIN',
      deadline,
    };
    if (params.referral !== undefined) body.referral = params.referral;

    /* Venue write, and it is the `dry: false` case that makes it one: that quote mints a deposit
       address and commits the solver, so a hang here is a hang after the venue has acted. */
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: venueWriteTimeout(),
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
        signal: readTimeout(),
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

    const res = await fetchImpl(url.toString(), { signal: readTimeout() });
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
    const originAsset = assetIdFor(leg.fromChain, originInfo.tokenId, list, originInfo.decimals);
    const destinationAsset = assetIdFor(leg.toChain, destInfo.tokenId, list, destInfo.decimals);
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
