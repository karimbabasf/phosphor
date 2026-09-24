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
// amounts the server echoes back, verifies 1Click's signature over the whole quote before the
// address is used (src/quote-signature.ts), and lets the policy engine cap what is at stake.

import { parseUnits } from 'viem';
import type { ChainId } from './types.ts';
import { readTimeout, venueWriteTimeout } from './net.ts';
import { spendNetworkOf } from './rails/intents-address.ts';
import { ReasonError } from './rails/reasons.ts';

export const ONECLICK_BASE = 'https://1click.chaindefuser.com';

// The allowlist entry for anything routed through 1Click. 1Click mints a fresh deposit address
// per quote, so no address of its own can ever sit on a static list; the venue string stands
// in, and the Hyperliquid withdraw rail names it as its counterparty.
export const ONECLICK_COUNTERPARTY = 'oneclick:1click.chaindefuser.com';

// Token registry shape loaded from data/tokens.json: chain -> symbol -> contract/mint id + decimals.
export type TokensFile = Record<ChainId, Record<string, { tokenId: string; decimals: number }>>;

// One entry from 1Click's GET /v0/tokens list.
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress?: string;
  /* Dollars per unit as 1Click last saw it, and when. Never an input to a quote; the price of last
     resort for a coin nothing else prices, aged from priceUpdatedAt and bounded by the quote's own
     value of what arrives (src/proposals/draft.ts priceOf, src/proposals/rails.ts prepareSwap). */
  price?: number;
  priceUpdatedAt?: string;
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
  chain: string,
  tokenId: string,
  list: OneClickToken[],
  expectDecimals?: number,
): string | null {
  /* The venue's own name for the chain, off the one registry. A chain the registry does not know
     matches nothing rather than matching the list's rows for some other chain. */
  const blockchain = spendNetworkOf(chain)?.venue;
  if (blockchain === undefined || blockchain === null) return null;
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
export function nativeAssetIdFor(chain: string, list: OneClickToken[]): string | null {
  const matches = nativeAssetMatches(chain, list);
  return matches.length === 1 ? matches[0].assetId : null;
}

// Every entry claiming to be the gas asset of a chain. Exposed beside the single-answer form so
// a refusal can say how many it found: zero and two are different facts with different fixes,
// and "unambiguously" was being said about zero (NEAR on near, 2026-09-20).
function nativeAssetMatches(chain: string, list: OneClickToken[]): OneClickToken[] {
  const blockchain = spendNetworkOf(chain)?.venue;
  const spec = NATIVE_ASSET[chain as ChainId];
  if (spec === undefined || blockchain === undefined || blockchain === null) return [];
  return list.filter(
    (t) =>
      t.blockchain.toLowerCase() === blockchain &&
      t.symbol === spec.symbol &&
      (t.contractAddress === undefined || t.contractAddress === ''),
  );
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

/* THE NAME A COIN GOES BY INSIDE THE VERIFIER. NEAR Intents holds NEAR as wrap.near, which
   1Click lists under the symbol wNEAR and nothing else: there is no native NEAR entry on the
   list at all (checked live 2026-09-20). A person who says "NEAR" means that coin, so the app
   books it under the name the venue and the wallet row will use, rather than refusing the one
   asset a NEAR product is about. The table is per chain and holds only wrappers that ARE the
   coin: nothing here may map one asset to a different one. */
const INTENTS_SYMBOL_ALIAS: Partial<Record<ChainId, Record<string, string>>> = {
  near: { NEAR: 'wNEAR', WNEAR: 'wNEAR' },
};
// Keyed on the uppercased ask, because every other ticker on this surface is read that way
// and "WNEAR" fell through to a registry sentence when it was not (review, 2026-09-20).
export function canonicalSymbol(chain: string, symbol: string): string {
  return INTENTS_SYMBOL_ALIAS[chain as ChainId]?.[symbol.toUpperCase()] ?? symbol;
}

// The name a balance inside the verifier goes by, whatever chain the asker had in mind. The
// tables are per chain but a held coin has one name, so a send or a payout of "NEAR" finds
// the wNEAR row the swap booked.
export function heldSymbol(symbol: string): string {
  for (const table of Object.values(INTENTS_SYMBOL_ALIAS)) {
    const hit = table?.[symbol.toUpperCase()];
    if (hit !== undefined) return hit;
  }
  return symbol;
}

/* An assetId is the venue's own id and carries a colon; a ticker never does. Used only to tell
   the two apart, never to parse one. */
const LOOKS_LIKE_ASSET_ID = /:/;

export type AssetCandidate = {
  assetId: string;
  decimals: number;
  symbol: string;
  contractAddress: string | null;
  priceUsd: number | null;
};

/* One answer, or the question to put to the person. A throw is the third outcome and means the
   ask cannot be answered at all: no such chain, or no such ticker on it. */
export type AssetPick =
  | { kind: 'one'; assetId: string; decimals: number; native: boolean; priceUsd: number | null }
  | { kind: 'many'; candidates: AssetCandidate[] };

function priceOf(t: OneClickToken): number | null {
  return typeof t.price === 'number' && isFinite(t.price) && t.price > 0 ? t.price : null;
}

/* WHICH TOKEN A SPEND MEANS. Four tiers, and the order is the point.

   The registry first, unchanged, so every asset this repo pins keeps its local anchor and its
   decimals agreement with the venue (assetIdFor's expectDecimals). Nothing about USDC on the
   five pinned chains moves. The gas-asset table second, for the same reason: it is this repo's
   own word for what a chain's coin is, and no caller may shadow it.

   An assetId named outright third, taken exactly as it is. That is how a person answers the
   question the last tier asks, and it is the escape hatch for anything a ticker cannot say.

   The venue's list last, matched on the chain's venue name and the ticker, case folded. This is
   the tier that opens every other chain, and it is deliberately thin: it finds candidates and it
   counts them. TWO IS NOT A GUESS. The card asks. A hundredfold decimals difference hides behind
   one ticker on the live list today (USDC on hypercore, 8 and 6), so the count is load bearing.

   It exists because both intents rails needed the same lookup and neither could express a gas
   asset without it: data/tokens.json holds ERC-20 contracts, and a native asset has no contract
   to hold. Adding a 'native' row to that file instead was rejected because src/ledger/evm.ts
   reads the same file to build balanceOf calls and would have sent eth_call to the string
   "native". */
export function resolveAsset(
  network: string,
  asked: string,
  tokens: TokensFile,
  list: OneClickToken[],
): AssetPick {
  const net = spendNetworkOf(network);
  if (net === undefined || net.venue === null) {
    throw new ReasonError('unsupported_asset', `this app has no chain called ${oneLine(network, 40)}, so nothing can be priced on it`);
  }
  const blockchain = net.venue;

  const symbol = canonicalSymbol(network, asked);
  const registry = tokens[network as ChainId]?.[symbol];
  if (registry !== undefined) {
    const assetId = assetIdFor(network, registry.tokenId, list, registry.decimals);
    if (assetId === null) throw new ReasonError('unsupported_asset', `1click does not list ${symbol} on ${network}`);
    const meta = list.find((t) => t.assetId === assetId);
    return { kind: 'one', assetId, decimals: registry.decimals, native: false, priceUsd: meta === undefined ? null : priceOf(meta) };
  }

  const spec = NATIVE_ASSET[network as ChainId];
  if (spec !== undefined && spec.symbol === symbol) {
    const matches = nativeAssetMatches(network, list);
    if (matches.length === 0) throw new ReasonError('unsupported_asset', `1click lists no native ${symbol} on ${network}`);
    if (matches.length > 1) {
      throw new ReasonError('ambiguous_asset', `1click lists ${matches.length} native ${symbol} on ${network}, so the app cannot tell which one is the coin`);
    }
    return { kind: 'one', assetId: matches[0]!.assetId, decimals: spec.decimals, native: true, priceUsd: priceOf(matches[0]!) };
  }

  /* An id is one asset on the whole list, so it is taken wherever the list files it: the chain
     named beside it is the asker's guess at a home and decides nothing. Requiring the two to
     agree refused `nep141:btc.omft.near` named on near, where 1Click files it under btc. */
  if (LOOKS_LIKE_ASSET_ID.test(asked)) {
    const exact = list.find((t) => t.assetId === asked);
    if (exact === undefined) {
      throw new ReasonError('unsupported_asset', `1click lists no asset ${oneLine(asked, 60)}`);
    }
    return {
      kind: 'one',
      assetId: exact.assetId,
      decimals: exact.decimals,
      native: (exact.contractAddress ?? '') === '',
      priceUsd: priceOf(exact),
    };
  }

  const wanted = symbol.toUpperCase();
  const matches = list.filter((t) => t.blockchain.toLowerCase() === blockchain && t.symbol.toUpperCase() === wanted);
  if (matches.length === 0) {
    throw new ReasonError('unsupported_asset', `1click lists no ${oneLine(symbol, 20)} on ${network}`);
  }
  if (matches.length > 1) {
    return {
      kind: 'many',
      candidates: matches.map((t) => ({
        assetId: t.assetId,
        decimals: t.decimals,
        symbol: t.symbol,
        contractAddress: t.contractAddress ?? null,
        priceUsd: priceOf(t),
      })),
    };
  }
  const only = matches[0]!;
  return {
    kind: 'one',
    assetId: only.assetId,
    decimals: only.decimals,
    native: (only.contractAddress ?? '') === '',
    priceUsd: priceOf(only),
  };
}

// ---------- amounts ----------

// A JS number printed by String() switches to exponent form at 1e21 and below 1e-6.
// parseUnits wants a plain decimal string, so expand it first.
export function plainDecimal(value: number): string {
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

/* The same conversion with the excess fraction digits CUT, never rounded. A floor is truncated
   toward zero (the rule since 42f5809), and a figure that is signed is exactly the figure a
   person approved, never one base unit above it: 1.0000005 USDC is 1000000 base units here and
   1000001 through parseUnits. The relay swap rail signs through this one; the other rails keep
   toBaseUnits and its rounding, which their tests pin, and the two differ only past the asset's
   own precision. */
export function truncateToBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount must be a finite number (got ${amount})`);
  if (amount < 0) throw new Error(`amount must not be negative (got ${amount})`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer in 0..36 (got ${decimals})`);
  }
  const [whole, fraction = ''] = plainDecimal(amount).split('.');
  const kept = fraction.slice(0, decimals);
  return parseUnits(kept === '' ? whole : `${whole}.${kept}`, decimals);
}

/* EXACT AMOUNTS: a decimal string in, base units out, and no double anywhere between.
   "Swap all my NEAR" failed three times on 2026-09-23 because the whole balance,
   894697028778374732410224 yocto, travelled as the double 0.8946970287783748 and came back as
   894697028778374800000000: 67,589,776 more than was held, so the signed transfer could never
   run. A double holds about 16 significant digits and a 24-decimal balance needs 24. */
export const AMOUNT_TEXT = /^\d+(?:\.\d+)?$/;
const AMOUNT_TEXT_MAX = 80;

// What a caller asked to spend: everything held, or an exact decimal in the coin's own units.
export type AmountAsk = { all: true } | { all: false; text: string };

/* "all", an exact decimal string, or a number (kept for callers that still send one, and read
   through its shortest decimal string, never through float math on base units). Strict: no sign,
   exponent, hex, whitespace, Infinity or NaN, and "all" in any case but nothing around it. Null
   for anything else, zero included: nothing to spend is not an amount. */
export function amountAsk(value: unknown): AmountAsk | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return { all: false, text: plainDecimal(value) };
  }
  if (typeof value !== 'string') return null;
  if (value.toLowerCase() === 'all') return { all: true };
  if (value.length > AMOUNT_TEXT_MAX || !AMOUNT_TEXT.test(value) || !/[1-9]/.test(value)) return null;
  return { all: false, text: value };
}

/* A decimal string to base units, exactly. Digits past the coin's precision are CUT, never
   rounded: what is signed is at most what was asked, the rule truncateToBaseUnits keeps. */
export function decimalToBaseUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer in 0..36 (got ${decimals})`);
  }
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (parts === null) throw new Error(`amount must be a plain decimal like 1.25 (got ${oneLine(text, 40)})`);
  const fraction = (parts[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(parts[1] + fraction);
}

// Base units back to the shortest exact decimal string: 1500000 at 6 decimals is "1.5".
export function baseUnitsToDecimal(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
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
  // 1Click's Ed25519 signature over the quote, and the stamp it covers. Verified against the
  // published key by every rail before a deposit address is used, and kept on the proposal row
  // afterwards, because it is what resolves a dispute: see src/quote-signature.ts.
  signature?: string;
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

// The statuses a watch stops on. INCOMPLETE_DEPOSIT is here although the API can still move
// past it: it means the deposit fell short of the quote, and this app sends exactly once, so
// nothing it does afterwards changes that. Polling on would only delay the sentence.
export const ONECLICK_TERMINAL: readonly OneClickStatusName[] = ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'];

export type OneClickStatus = {
  found: boolean; // false on 404: the address is not known to the API yet
  status: OneClickStatusName | 'UNKNOWN';
  reported: string; // what the API actually said, one line, bounded
  originTxHashes: string[];
  destinationTxHashes: string[];
  nearTxHashes: string[]; // the settlement on NEAR, which for an INTENTS order is the only hash there is
  depositedAmount?: string; // formatted, what the API saw arrive at the deposit address
  settledAmountOut?: string; // formatted, what the API says was delivered, not what was quoted
  refundedAmount?: string; // formatted; "0" on a terminal status that carries no refund field
  refundReason?: string; // the API's reason for a refund, when it gave one
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

// The spec types originChainTxHashes and destinationChainTxHashes as { hash, explorerUrl }
// objects and nearTxHashes as plain strings. Both shapes are read: the reader that kept only
// strings dropped every chain hash the live API returned, and nobody noticed because the
// fixtures were written as strings too.
export function hashesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(oneLine(v, 120));
    else if (v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>)['hash'] === 'string') {
      out.push(oneLine((v as Record<string, unknown>)['hash'], 120));
    }
  }
  return out;
}

function amountOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? oneLine(value, 40) : undefined;
}

// A status body as the API returns it, read as data. Exported so a test can feed it the real
// bodies and so a stub can produce exactly what the client would.
export function parseStatus(payload: unknown): OneClickStatus {
  const body = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const reported = oneLine(body['status'] ?? 'missing status field', 60);
  const known = (ONECLICK_STATUSES as readonly string[]).includes(reported);
  const status: OneClickStatusName | 'UNKNOWN' = known ? (reported as OneClickStatusName) : 'UNKNOWN';
  const terminal = known && (ONECLICK_TERMINAL as readonly string[]).includes(status);
  const raw = body['swapDetails'];
  const details = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const depositedAmount = amountOf(details['depositedAmountFormatted']);
  const settledAmountOut = amountOf(details['amountOutFormatted']);
  // On a terminal status the refund is settled too, so a missing field means none was made.
  // Before that the field is simply not known yet, and "0" would be a claim.
  const refundedAmount = amountOf(details['refundedAmountFormatted']) ?? (terminal ? '0' : undefined);
  const reason = details['refundReason'];
  const refundReason = typeof reason === 'string' && reason.trim() !== '' ? oneLine(reason, 80) : undefined;

  return {
    found: true,
    status,
    reported,
    originTxHashes: hashesOf(details['originChainTxHashes']),
    destinationTxHashes: hashesOf(details['destinationChainTxHashes']),
    nearTxHashes: hashesOf(details['nearTxHashes']),
    ...(depositedAmount !== undefined ? { depositedAmount } : {}),
    ...(settledAmountOut !== undefined ? { settledAmountOut } : {}),
    ...(refundedAmount !== undefined ? { refundedAmount } : {}),
    ...(refundReason !== undefined ? { refundReason } : {}),
  };
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
  // When the list tokens() answers with was fetched, in epoch ms; null before the first fetch.
  listedAt?(): number | null;
  quote(params: OneClickQuoteParams): Promise<OneClickQuoteResponse>;
  submitDeposit(depositAddress: string, txHash: string): Promise<{ ok: boolean; detail: string }>;
  status(depositAddress: string, depositMemo?: string): Promise<OneClickStatus>;
};

/* HOW OLD THE TOKEN LIST MAY GET: one minute. The list is the price of last resort for a coin no
   other source prices (src/proposals/draft.ts priceOf), and a governing price may be two minutes
   old at most (PRICE_STALENESS_MS), so it is read again inside that. A read that fails keeps the
   last list and its stamp: the names stay good, and the prices age out of governing on their own. */
export const TOKEN_LIST_TTL_MS = 60_000;

export function oneClickClient(deps: OneClickDeps = {}): OneClickClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let tokenListCache: { list: OneClickToken[]; at: number } | null = null;
  // One read at a time: callers that find the list old together share the read that renews it.
  let reading: Promise<OneClickToken[]> | null = null;

  async function readList(): Promise<OneClickToken[]> {
    try {
      const res = await fetchImpl(`${ONECLICK_BASE}/v0/tokens`, { signal: readTimeout() });
      if (!res.ok) {
        throw new Error(`1click token list fetch failed: ${res.status} ${await res.text()}`);
      }
      const list = (await res.json()) as OneClickToken[];
      tokenListCache = { list, at: Date.now() };
      return list;
    } catch (err) {
      if (tokenListCache !== null) return tokenListCache.list;
      throw err;
    } finally {
      reading = null;
    }
  }

  async function tokens(): Promise<OneClickToken[]> {
    if (tokenListCache !== null && Date.now() - tokenListCache.at < TOKEN_LIST_TTL_MS) return tokenListCache.list;
    reading ??= readList();
    return reading;
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
        nearTxHashes: [],
      };
    }
    if (!res.ok) throw new Error(`1click status failed: ${res.status}`);

    return parseStatus(await res.json().catch(() => null));
  }

  return { tokens, listedAt: () => tokenListCache?.at ?? null, quote, submitDeposit, status };
}
