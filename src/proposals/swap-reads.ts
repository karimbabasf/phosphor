// The three swap reads: what can be swapped inside NEAR Intents, a dry quote, and one swap's
// truth re-read now. None of them files a row, signs anything or takes the spend queue.
//
// Each answers a question the agent could only answer on 2026-09-23 by proposing a swap and
// drawing a Refused card (R3): whether BTC can be bought at all, what a swap would get, and
// whether a FAILED swap's money ever left. The last one reads the balance and the intents
// ledger, never the venue's note alone: that note said 1Click held money that had never moved.

import type { OneClickToken, TokensFile } from '../intents.ts';
import { amountAsk, baseUnitsToDecimal, decimalToBaseUnits, heldSymbol, oneLine, resolveAsset } from '../intents.ts';
import { MAX_LIMIT } from '../chainscan/index.ts';
import type { IntentsActivity, IntentsRow } from '../chainscan/index.ts';
import { networkByVenue, spendNetworkOf } from '../rails/intents-address.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_NATIVE_VENUE } from '../rails/intents-native.ts';
import { INTENTS_RELAY_COUNTERPARTY, INTENTS_RELAY_VENUE } from '../rails/intents-relay.ts';
import { reasonOf } from '../rails/reasons.ts';
import type { ReasonCode } from '../rails/reasons.ts';
import type { SwapLookup } from '../rails/index.ts';
import { swapRailOf } from '../config.ts';
import type { SwapDraft } from '../types.ts';
import { ourIntentsAddress, usdOf } from './draft.ts';
import { errText } from './lifecycle.ts';
import type { PCtx } from './lifecycle.ts';
import { reasonSentence, shortIds, watchWords } from './view.ts';

// ---------- shapes ----------

export type SwapSide = { symbol: string; network: string; assetId: string; decimals: number };

export type SwapAssetsParams = { query?: string; limit?: number };
export type SwapAsset = SwapSide & {
  name: string; // "USDC on Arbitrum One"
  priceUsd: number | null;
  held: string | null; // what the balance holds of it, exact, or null for none
  /* Whether the swap service will sell it inside NEAR Intents: 'yes' or 'no' from a dry quote
     for a few dollars of USDC (asked when a search narrows to ten or fewer, remembered for ten
     minutes), 'unknown' when nobody has asked. */
  liquidity: 'yes' | 'no' | 'unknown';
};
export type SwapAssetsReply = { ok: boolean; assets: SwapAsset[]; total: number; note: string; reason?: ReasonCode };

// The names propose_swap uses, so an agent asks for a price in the words it would propose with.
export type SwapQuoteParams = { fromSymbol: string; toSymbol: string; amountIn: string | number; chain?: string; toChain?: string };
export type SwapQuoteReply = {
  ok: boolean; // a quote came back
  from: SwapSide | null;
  to: SwapSide | null;
  amountIn: string | null; // the exact amount priced, in the sold coin's units
  expectedOut: string | null;
  minOut: string | null; // the floor a swap proposed now would be approved with
  feeUsd: number | null;
  etaSeconds: number | null;
  // Set when there is no quote, or when there is one and the swap still could not run as asked.
  reason: ReasonCode | null;
  sentence: string | null;
  details: string | null;
  candidates?: SwapSide[]; // on ambiguous_asset: name one of these by its assetId
  picked?: string; // the version of the bought coin the app took, when its name fits several
};

export type SwapLedgerMove = { amount: string; at: string | null; counterparty: string | null; hash: string };
export type SwapCheckReply = {
  id: string;
  ok: boolean; // the row is a swap and was re-read
  venue: { name: 'swap service' | 'relay' | null; status: string | null; refundedAmount: string | null };
  moved: 'yes' | 'no' | 'unknown'; // whether the sold coin left the balance for this swap
  refunded: boolean | null;
  balance: { symbol: string; now: string | null };
  ledger: { source: string; outgoing: SwapLedgerMove[]; incoming: SwapLedgerMove[] } | null;
  summary: string; // one plain line
};

// ---------- shared ----------

const NO_VENUE = 'No swap venue is wired here, so nothing can be listed or quoted.';
// No registry: every lookup below goes by the venue's own list, and an id is taken as named.
const NO_REGISTRY = {} as TokensFile;

function sideOf(t: OneClickToken): SwapSide | null {
  const net = networkByVenue(t.blockchain);
  if (net === undefined) return null;
  return { symbol: oneLine(t.symbol, 24), network: net.id, assetId: t.assetId, decimals: t.decimals };
}

// What the balance holds, by asset id, as exact decimals. Empty when the ledger has no read.
function heldOf(ctx: PCtx): Map<string, string> {
  const out = new Map<string, string>();
  const read = ctx.ledger.intents();
  if (read === undefined || !read.ok) return out;
  for (const h of read.holdings) {
    if (h.amountBase === undefined || !/^\d+$/.test(h.amountBase) || BigInt(h.amountBase) === 0n) continue;
    out.set(h.assetId, baseUnitsToDecimal(BigInt(h.amountBase), h.decimals));
  }
  return out;
}

export type SidePick =
  | { kind: 'one'; side: SwapSide }
  | { kind: 'many'; candidates: SwapSide[] }
  | { kind: 'none'; why: string; code?: ReasonCode; lookalike?: true };
export type SideAsk = { asked: string; chain?: string };

/* THE TWO COINS OF A SWAP, one rule for swap_quote and propose_swap alike (2026-09-23: "swap my
   NEAR to USDC" came back "which USDC?"). A coin named with its network, or by id, is that coin.
   A ticker alone that several coins carry:
     spent  -> the one the balance holds is the only answer; none held is nothing to spend, and
               several held is the question.
     bought -> its NEAR version (nearVersion), so one coin never sits in the balance as several
               tiles (Karim, 2026-09-25: "default to near intents always"); with none, the one
               held the most of; otherwise pickBoughtByQuote asks what each would get.
   What is still several after this is the candidates the next step, or the person, chooses from. */
export function resolveSwapSides(from: SideAsk, to: SideAsk, list: OneClickToken[], held: ReadonlyMap<string, string>): { from: SidePick; to: SidePick } {
  const named = (ask: SideAsk): boolean => (ask.chain?.trim() ?? '') !== '';
  const picks = { from: resolveSide(from.asked, from.chain, list), to: resolveSide(to.asked, to.chain, list) };
  // A lookalike of a pinned coin is never bought, however it was named: by ticker, network or id.
  const real = (s: SwapSide): boolean => {
    const pin = NEAR_VERSION_PINNED[s.symbol.toUpperCase()];
    return s.network !== 'near' || pin === undefined || s.assetId === pin;
  };
  const fake = { kind: 'none', why: `that ${oneLine(to.asked, 60)} on NEAR is not the real coin of that name`, lookalike: true } as const;
  if (picks.to.kind === 'one' && !real(picks.to.side)) picks.to = fake;
  if (picks.to.kind === 'many') {
    const kept = picks.to.candidates.filter(real);
    picks.to = kept.length === 0 ? fake : kept.length === 1 ? { kind: 'one', side: kept[0]! } : { kind: 'many', candidates: kept };
  }
  if (picks.to.kind === 'many' && !named(to)) {
    const near = nearVersion(picks.to.candidates, list);
    const owned = picks.to.candidates.filter((s) => held.has(s.assetId)).sort((a, b) => Number(held.get(b.assetId)) - Number(held.get(a.assetId)));
    if (near !== null) picks.to = { kind: 'one', side: near };
    else if (owned.length > 0) picks.to = { kind: 'one', side: owned[0]! };
  }
  if (picks.from.kind === 'many' && !named(from)) {
    const owned = picks.from.candidates.filter((s) => held.has(s.assetId));
    picks.from =
      owned.length === 1
        ? { kind: 'one', side: owned[0]! }
        : owned.length > 1
          ? { kind: 'many', candidates: owned }
          : { kind: 'none', why: `the balance holds no ${oneLine(from.asked, 20)}`, code: 'insufficient_balance' };
  }
  return picks;
}

/* THE NEAR VERSION OF A COIN WORTH FAKING, by exact id: the near rows of data/tokens.json. The
   venue's list is read over the network and its tickers are its own word, so for these the NEAR
   version is this id and nothing else, and any other coin on near under the ticker is a
   lookalike, never bought. */
export const NEAR_VERSION_PINNED: Readonly<Record<string, string>> = {
  USDT: 'nep141:usdt.tether-token.near',
  USDC: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  WNEAR: 'nep141:wrap.near',
};

/* Which of one ticker's versions is on NEAR. A pinned ticker is its pinned id. Any other ticker
   is its one near version, and only when the listed prices say it is the same coin as the rest
   (SAME_COIN_BAND): two near versions, or a price that disagrees, is no pick. */
function nearVersion(candidates: SwapSide[], list: OneClickToken[]): SwapSide | null {
  const pinned = NEAR_VERSION_PINNED[(candidates[0]?.symbol ?? '').toUpperCase()];
  if (pinned !== undefined) return candidates.find((s) => s.assetId === pinned) ?? null;
  const nears = candidates.filter((s) => s.network === 'near');
  if (nears.length !== 1) return null;
  const priceOf = (s: SwapSide): number | null => {
    const p = list.find((t) => t.assetId === s.assetId)?.price;
    return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
  };
  const prices = candidates.map(priceOf).filter((x): x is number => x !== null);
  const agree = prices.length === 0 || (priceOf(nears[0]!) !== null && Math.max(...prices) <= Math.min(...prices) * (1 + SAME_COIN_BAND));
  return agree ? nears[0]! : null;
}

/* THE COIN BOUGHT, BY WHAT IT WOULD GET. Up to BUY_PROBE_MAX of the candidates are asked for a
   floorless price at once, BUY_PROBE_TIMEOUT_MS for all of them, and the most arriving IN DOLLARS
   wins: what arrives times the coin's listed price, so ETH from Ethereum beats the bridged ETH on
   near when it pays more. ONE TICKER CAN BE TWO COINS: two NEARKATs are listed 30 times apart, and
   the most units went to the cheaper one whatever the person meant (audit, finding 8). So listed
   prices more than SAME_COIN_BAND apart are two coins and a question, answered with the ids; an
   unpriced candidate is compared only when none is priced, by units. No answer at all is the one
   on near; no near one either is no price. Nothing is signed or filed. The four asked are the
   one on near, the one on the spent coin's network, then Ethereum, Base, Arbitrum and Solana, then
   the list's own order; the same order breaks a tie. */
export const BUY_PROBE_MAX = 4;
export const BUY_PROBE_TIMEOUT_MS = 2_000;
export const SAME_COIN_BAND = 0.05;
const BUY_PROBE_PREFERRED = ['eth', 'base', 'arb', 'sol'];

export async function pickBoughtByQuote(
  ctx: PCtx,
  sold: SwapSide,
  amount: string | null,
  candidates: SwapSide[],
  account: string,
  list: OneClickToken[] = [],
): Promise<SidePick> {
  const unitPrice = (s: SwapSide): number | null => {
    const price = list.find((t) => t.assetId === s.assetId)?.price;
    return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
  };
  const prices = candidates.map(unitPrice).filter((x): x is number => x !== null);
  if (prices.length >= 2 && Math.max(...prices) > Math.min(...prices) * (1 + SAME_COIN_BAND)) return { kind: 'many', candidates };
  const pool = prices.length > 0 ? candidates.filter((s) => unitPrice(s) !== null) : candidates;

  const rank = (s: SwapSide): number => {
    const order = ['near', sold.network, ...BUY_PROBE_PREFERRED];
    const at = order.indexOf(s.network);
    return at === -1 ? order.length : at;
  };
  const ordered = pool.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
  const near = ordered.find((s) => s.network === 'near');
  const asked = amount === null ? [] : ordered.slice(0, BUY_PROBE_MAX);
  const outs = await Promise.all(asked.map((s) => boughtOut(ctx, sold, s, amount ?? '0', account)));
  let won: { side: SwapSide; value: number } | null = null;
  for (const [i, out] of outs.entries()) {
    if (out === null) continue;
    const value = out * (unitPrice(asked[i]!) ?? 1);
    if (won === null || value > won.value) won = { side: asked[i]!, value };
  }
  if (won !== null) return { kind: 'one', side: won.side };
  // Versions of one coin that nobody prices are no price, never a question about networks.
  return near !== undefined ? { kind: 'one', side: near } : { kind: 'none', why: `nobody offered a price for ${oneLine(candidates[0]?.symbol ?? 'that coin', 20)} on any network right now`, code: 'no_price' };
}

// What one candidate would get for the amount sold, in its own units, or null: no price, a refusal,
// or no answer inside BUY_PROBE_TIMEOUT_MS.
async function boughtOut(ctx: PCtx, sold: SwapSide, target: SwapSide, amount: string, account: string): Promise<number | null> {
  const draft = { ...draftFor(ctx, sold, target, account), amountIn: Number(amount), amountInExact: amount };
  const rail = ctx.rails.for(draft);
  if (rail === null) return null;
  const ask = async (): Promise<number | null> => {
    if (typeof rail.quote === 'function') return rail.quote(draft);
    if (typeof rail.facts === 'function') return Number((await rail.facts(draft)).expectedOut);
    return null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BUY_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const out = await Promise.race([ask().catch(() => null), late]);
    return out !== null && Number.isFinite(out) && out > 0 ? out : null;
  } finally {
    clearTimeout(timer);
  }
}

// The amount a probe sells: "all" is the balance as the ledger last read it, an amount is cut to the
// coin's own decimals. Null when there is nothing to ask a price for.
function probeAmount(ctx: PCtx, sold: SwapSide, amountIn: unknown): string | null {
  const ask = amountAsk(amountIn);
  if (ask === null) return null;
  if (ask.all) return heldOf(ctx).get(sold.assetId) ?? null;
  const base = decimalToBaseUnits(ask.text, sold.decimals);
  return base === 0n ? null : baseUnitsToDecimal(base, sold.decimals);
}

/* THE ONE RESOLVER, whole: the rule above over the venue's list and the balance as the ledger last
   read it, then the bought coin by what it would get. Null when there is no venue list here to
   read (a hand-built registry). */
export async function pickSwapSides(
  ctx: PCtx,
  from: SideAsk,
  to: SideAsk,
  amountIn: unknown,
): Promise<{ from: SidePick; to: SidePick; list: OneClickToken[] } | null> {
  const lookup = ctx.rails.swap;
  if (lookup === undefined) return null;
  const list = await lookup.tokens();
  const picks = resolveSwapSides(from, to, list, heldOf(ctx));
  if (picks.from.kind === 'one' && picks.to.kind === 'many' && (to.chain?.trim() ?? '') === '') {
    const account = ourIntentsAddress(ctx, []);
    picks.to = await pickBoughtByQuote(ctx, picks.from.side, probeAmount(ctx, picks.from.side, amountIn), picks.to.candidates, account, list);
  }
  return { ...picks, list };
}

/* The name a draft carries for a picked coin: its ticker, which the card and the rails read, or its
   id where the ticker is shared on its own network (two USDC on hypercore, 6 and 8 decimals). */
export function draftSymbolOf(side: SwapSide, list: OneClickToken[]): string {
  const twins = list.filter((t) => t.symbol.toUpperCase() === side.symbol.toUpperCase() && sideOf(t)?.network === side.network);
  return twins.length === 1 ? side.symbol : side.assetId;
}

// The version of the bought coin the app took, in words: null when the ticker is one coin.
function pickedWords(side: SwapSide, list: OneClickToken[]): string | null {
  const versions = list.filter((t) => t.symbol.toUpperCase() === side.symbol.toUpperCase() && sideOf(t) !== null).length;
  if (versions < 2) return null;
  const coin = side.symbol.toUpperCase() === 'WNEAR' ? 'NEAR' : side.symbol;
  const on = `${coin} on ${spendNetworkOf(side.network)?.name ?? side.network}`;
  return side.network === 'near'
    ? `${on}, its NEAR version: the app keeps every coin bought on NEAR, so the balance holds one ${coin}.`
    : `${on}: no NEAR version is offered, so the app took the one already held, or the one that gets the most.`;
}

/* A coin named by ticker, by ticker and chain, or by id. A ticker alone across every chain is one
   answer when one coin carries it; several are the candidates resolveSwapSides narrows. */
function resolveSide(asked: string, chain: string | undefined, list: OneClickToken[]): SidePick {
  const text = asked.trim();
  if (text === '') return { kind: 'none', why: 'no coin was named' };
  const byId = (id: string): SwapSide | null => {
    const t = list.find((x) => x.assetId === id);
    return t === undefined ? null : sideOf(t);
  };
  if (chain !== undefined && chain.trim() !== '') {
    try {
      const pick = resolveAsset(chain.trim(), text, NO_REGISTRY, list);
      if (pick.kind === 'one') {
        const side = byId(pick.assetId);
        return side === null ? { kind: 'none', why: `the swap service lists no ${text} on ${chain}` } : { kind: 'one', side };
      }
      return { kind: 'many', candidates: pick.candidates.map((c) => byId(c.assetId)).filter((s): s is SwapSide => s !== null) };
    } catch (err) {
      return { kind: 'none', why: errText(err) };
    }
  }
  if (text.includes(':')) {
    const side = byId(text);
    return side === null ? { kind: 'none', why: `the swap service lists no asset ${oneLine(text, 60)}` } : { kind: 'one', side };
  }
  const wanted = heldSymbol(text).toUpperCase();
  const matches = list
    .filter((t) => t.symbol.toUpperCase() === wanted)
    .map(sideOf)
    .filter((s): s is SwapSide => s !== null);
  if (matches.length === 0) return { kind: 'none', why: `the swap service lists no coin called ${oneLine(text, 20)}` };
  if (matches.length === 1) return { kind: 'one', side: matches[0]! };
  return { kind: 'many', candidates: matches };
}

// A swap draft for the rail the config names today, with both coins named by id, so the rail
// resolves exactly the assets this read resolved. Never filed.
function draftFor(ctx: PCtx, from: SwapSide, to: SwapSide, account: string): SwapDraft {
  const relay = swapRailOf(ctx.cfg) === 'relay';
  return {
    kind: 'swap',
    venue: relay ? INTENTS_RELAY_VENUE : INTENTS_NATIVE_VENUE,
    chain: from.network,
    toChain: to.network,
    fromSymbol: from.assetId,
    toSymbol: to.assetId,
    amountIn: 0,
    amountUsd: 0,
    minAmountOut: 0,
    from: account,
    to: account,
    counterparty: relay ? INTENTS_RELAY_COUNTERPARTY : INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
  };
}

// For the sentence only: the plain names, so a reason reads "NEAR to WBTC", never two ids.
// For the sentence only, before either coin is found: the names as they were asked.
function askedWords(ctx: PCtx, params: SwapQuoteParams): SwapDraft {
  const from = String(params.fromSymbol ?? '');
  const to = String(params.toSymbol ?? '');
  const side = (symbol: string, network?: string): SwapSide => ({ symbol, network: network ?? '', assetId: symbol, decimals: 0 });
  return wordsDraft(draftFor(ctx, side(from, params.chain), side(to, params.toChain), ''), side(from), side(to));
}

function wordsDraft(draft: SwapDraft, from: SwapSide, to: SwapSide): SwapDraft {
  return { ...draft, fromSymbol: from.symbol, toSymbol: to.assetId === 'nep141:btc.omft.near' ? draft.toSymbol : to.symbol };
}

// ---------- liquidity, remembered ----------

const LIQUIDITY_TTL_MS = 10 * 60_000;
const PROBE_MAX = 10;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_USDC = '5';
const liquidityByCtx = new WeakMap<PCtx, Map<string, { at: number; value: 'yes' | 'no' }>>();

function liquidityOf(ctx: PCtx): Map<string, { at: number; value: 'yes' | 'no' }> {
  let map = liquidityByCtx.get(ctx);
  if (map === undefined) {
    map = new Map();
    liquidityByCtx.set(ctx, map);
  }
  return map;
}

function remember(ctx: PCtx, assetId: string, value: 'yes' | 'no'): void {
  liquidityOf(ctx).set(assetId, { at: Date.now(), value });
}

function recalled(ctx: PCtx, assetId: string): 'yes' | 'no' | 'unknown' {
  const hit = liquidityOf(ctx).get(assetId);
  return hit !== undefined && Date.now() - hit.at <= LIQUIDITY_TTL_MS ? hit.value : 'unknown';
}

/* Whether a few dollars of USDC buys this coin inside NEAR Intents right now: one dry quote on
   the configured rail, bounded. Nobody selling is 'no'; a minimum is still somebody selling. */
async function probe(ctx: PCtx, usdc: SwapSide, target: SwapSide, account: string): Promise<'yes' | 'no' | 'unknown'> {
  if (target.assetId === usdc.assetId) return 'yes';
  const draft = { ...draftFor(ctx, usdc, target, account), amountIn: Number(PROBE_USDC), amountInExact: PROBE_USDC, amountUsd: Number(PROBE_USDC) };
  const rail = ctx.rails.for(draft);
  if (rail === null || typeof rail.facts !== 'function') return 'unknown';
  let timer: NodeJS.Timeout | undefined;
  try {
    const bound = new Promise<'unknown'>((resolve) => {
      timer = setTimeout(() => resolve('unknown'), PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const asked = rail.facts(draft).then(
      () => 'yes' as const,
      (err: unknown) => {
        const code = reasonOf(err);
        return code === 'no_price' ? ('no' as const) : code === 'below_minimum' ? ('yes' as const) : ('unknown' as const);
      },
    );
    const answer = await Promise.race([asked, bound]);
    if (answer !== 'unknown') remember(ctx, target.assetId, answer);
    return answer;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The USDC a probe spends: the NEAR-native one when the list has it, the first USDC otherwise.
function probeUsdc(list: OneClickToken[]): SwapSide | null {
  const usdc = list.filter((t) => t.symbol.toUpperCase() === 'USDC');
  const pick = usdc.find((t) => t.blockchain.toLowerCase() === 'near') ?? usdc[0];
  return pick === undefined ? null : sideOf(pick);
}

// ---------- swap_assets ----------

const ASSETS_DEFAULT = 40;
const ASSETS_MAX = 200;

function matchesQuery(q: string, t: OneClickToken, side: SwapSide): boolean {
  const net = networkByVenue(t.blockchain);
  return (
    side.symbol.toLowerCase().includes(q) ||
    t.assetId.toLowerCase().includes(q) ||
    side.network === q ||
    (net !== undefined && net.name.toLowerCase().includes(q)) ||
    (q === 'near' && side.symbol.toUpperCase() === 'WNEAR')
  );
}

export async function swapAssets(ctx: PCtx, params: SwapAssetsParams): Promise<SwapAssetsReply> {
  const lookup: SwapLookup | undefined = ctx.rails.swap;
  if (lookup === undefined) return { ok: false, assets: [], total: 0, note: NO_VENUE, reason: 'not_available' };
  let list: OneClickToken[];
  try {
    list = await lookup.tokens();
  } catch (err) {
    return { ok: false, assets: [], total: 0, note: `The swap service's list could not be read just now (${oneLine(errText(err), 80)}). Try again in a minute.`, reason: 'not_available' };
  }
  const q = (params.query ?? '').trim().toLowerCase();
  const held = heldOf(ctx);
  const found: Array<{ t: OneClickToken; side: SwapSide }> = [];
  for (const t of list) {
    const side = sideOf(t);
    if (side !== null && (q === '' || matchesQuery(q, t, side))) found.push({ t, side });
  }
  // What the person holds first, then an exact ticker, then the rest by ticker.
  found.sort((a, b) => {
    const heldA = held.has(a.side.assetId) ? 0 : 1;
    const heldB = held.has(b.side.assetId) ? 0 : 1;
    if (heldA !== heldB) return heldA - heldB;
    const exactA = a.side.symbol.toLowerCase() === q ? 0 : 1;
    const exactB = b.side.symbol.toLowerCase() === q ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    return a.side.symbol.localeCompare(b.side.symbol) || a.side.network.localeCompare(b.side.network);
  });
  const limit = Math.min(ASSETS_MAX, Math.max(1, Math.floor(Number(params.limit) || ASSETS_DEFAULT)));
  const shown = found.slice(0, limit);

  /* A narrowed search asks the venue about each coin it found: "can I buy bitcoin" answered
     from the list alone would say yes to native BTC, which nobody sells inside NEAR Intents. */
  const problems: string[] = [];
  const account = ourIntentsAddress(ctx, problems);
  const usdc = probeUsdc(list);
  const probing = q !== '' && shown.length <= PROBE_MAX && usdc !== null && problems.length === 0;
  const liquidity = probing
    ? await Promise.all(shown.map(({ side }) => (recalled(ctx, side.assetId) !== 'unknown' ? Promise.resolve(recalled(ctx, side.assetId)) : probe(ctx, usdc, side, account))))
    : shown.map(({ side }) => recalled(ctx, side.assetId));

  const assets: SwapAsset[] = shown.map(({ t, side }, i) => {
    const net = networkByVenue(t.blockchain);
    return {
      ...side,
      name: `${side.symbol} on ${net?.name ?? side.network}`,
      priceUsd: typeof t.price === 'number' && Number.isFinite(t.price) && t.price > 0 ? t.price : null,
      held: held.get(side.assetId) ?? null,
      liquidity: liquidity[i] ?? 'unknown',
    };
  });
  const note =
    (probing
      ? 'liquidity is a dry quote for a few dollars of USDC, asked just now.'
      : 'liquidity is what a recent quote found, or unknown. Search for one coin to have each result asked about.') +
    ' A coin listed on several networks is one coin: to buy it, name the symbol alone and the app takes its NEAR version. Never ask which network.';
  return { ok: true, assets, total: found.length, note };
}

// ---------- swap_quote ----------

export async function swapQuote(ctx: PCtx, params: SwapQuoteParams): Promise<SwapQuoteReply> {
  const none = { ok: false, amountIn: null, expectedOut: null, minOut: null, feeUsd: null, etaSeconds: null, details: null } as const;
  const lookup = ctx.rails.swap;
  const plain = (code: ReasonCode, draft: SwapDraft | null, sentence?: string) => sentence ?? (draft === null ? NO_VENUE : reasonSentence(code, draft));
  if (lookup === undefined) return { ...none, from: null, to: null, reason: 'not_available', sentence: NO_VENUE };
  let list: OneClickToken[];
  try {
    list = await lookup.tokens();
  } catch (err) {
    return { ...none, from: null, to: null, reason: 'no_price', sentence: "The swap service didn't answer just now, so there is no quote. Try again in a minute.", details: shortIds(errText(err)) };
  }

  const sides = resolveSwapSides(
    { asked: String(params.fromSymbol ?? ''), chain: params.chain },
    { asked: String(params.toSymbol ?? ''), chain: params.toChain },
    list,
    heldOf(ctx),
  );
  const fromPick = sides.from;
  let toPick = sides.to;
  if (fromPick.kind === 'one' && toPick.kind === 'many' && (params.toChain?.trim() ?? '') === '') {
    toPick = await pickBoughtByQuote(ctx, fromPick.side, probeAmount(ctx, fromPick.side, params.amountIn), toPick.candidates, ourIntentsAddress(ctx, []), list);
  }
  for (const [pick, which] of [
    [fromPick, 'the coin you sell'],
    [toPick, 'the coin you buy'],
  ] as const) {
    if (pick.kind === 'many') {
      return {
        ...none,
        from: fromPick.kind === 'one' ? fromPick.side : null,
        to: toPick.kind === 'one' ? toPick.side : null,
        reason: 'ambiguous_asset',
        sentence:
          pick === toPick
            ? 'Several different coins go by that name, so there is no quote yet. Ask which coin they mean, never which network.'
            : `Several coins go by that name, so there is no quote yet. Say which one you mean for ${which}: each is listed with its network.`,
        candidates: pick.candidates,
      };
    }
    if (pick.kind === 'none') {
      const code = pick.code ?? 'unsupported_asset';
      return {
        ...none,
        from: fromPick.kind === 'one' ? fromPick.side : null,
        to: toPick.kind === 'one' ? toPick.side : null,
        reason: code,
        sentence:
          code === 'unsupported_asset'
            ? "The swap service doesn't offer that coin, so there is no quote. Ask what can be swapped and pick from that."
            : reasonSentence(code, askedWords(ctx, params)),
        details: pick.why,
      };
    }
  }
  if (fromPick.kind !== 'one' || toPick.kind !== 'one') return { ...none, from: null, to: null, reason: 'invalid_request', sentence: plain('invalid_request', null) };
  const from = fromPick.side;
  const to = toPick.side;
  const picked = (params.toChain?.trim() ?? '') === '' ? pickedWords(to, list) : null;

  const problems: string[] = [];
  const account = ourIntentsAddress(ctx, problems);
  if (problems.length > 0) return { ...none, from, to, reason: 'not_available', sentence: 'Make a wallet first, then ask again.' };
  const draft = draftFor(ctx, from, to, account);
  const words = wordsDraft(draft, from, to);
  if (from.assetId === to.assetId) return { ...none, from, to, reason: 'invalid_request', sentence: 'Those are the same coin, so there is nothing to swap.' };
  const ask = amountAsk(params.amountIn);
  if (ask === null) return { ...none, from, to, reason: 'invalid_request', sentence: 'The amount has to be "all" or a number above zero, like 1.5.' };

  // The exact amount, the same way a propose sets it: "all" is the balance to the last unit.
  const heldBase = await lookup.balance(account.toLowerCase(), from.assetId);
  let base: bigint;
  if (ask.all) {
    if (heldBase === null) return { ...none, from, to, reason: 'balance_unread', sentence: reasonSentence('balance_unread', words) };
    if (heldBase === 0n) return { ...none, from, to, reason: 'insufficient_balance', sentence: reasonSentence('insufficient_balance', words) };
    base = heldBase;
  } else {
    base = decimalToBaseUnits(ask.text, from.decimals);
    if (base === 0n) return { ...none, from, to, reason: 'invalid_request', sentence: `That's less than the smallest amount of ${from.symbol}.` };
  }
  const exact = baseUnitsToDecimal(base, from.decimals);
  const priced: SwapDraft = { ...draft, amountIn: Number(exact), amountInExact: exact, amountUsd: usdOf(ctx, from.symbol, Number(exact), ctx.ledger.snapshot(), from.assetId) };
  const rail = ctx.rails.for(priced);
  if (rail === null || typeof rail.facts !== 'function') return { ...none, from, to, amountIn: exact, reason: 'not_available', sentence: NO_VENUE };

  try {
    const facts = await rail.facts(priced);
    remember(ctx, to.assetId, 'yes');
    // A quote for more than is held is still a price, and the reason says the swap could not run.
    const short = heldBase !== null && base > heldBase;
    return {
      ok: true,
      from,
      to,
      ...facts,
      reason: short ? 'insufficient_balance' : null,
      sentence: short ? reasonSentence('insufficient_balance', words) : null,
      details: null,
      ...(picked === null ? {} : { picked }),
    };
  } catch (err) {
    const code = reasonOf(err) ?? 'simulation_failed';
    if (code === 'no_price') remember(ctx, to.assetId, 'no');
    return { ...none, from, to, amountIn: exact, reason: code, sentence: reasonSentence(code, words), details: shortIds(oneLine(errText(err), 400)) };
  }
}

// ---------- swap_check ----------

// The largest page the ledger read hands back; a page shorter than this is the whole history.
export const LEDGER_PAGE = MAX_LIMIT;
// How far before the click a ledger row still counts as this swap's: clocks disagree a little.
const LEDGER_SLACK_MS = 60_000;

// The venue's word as a person would say it.
const VENUE_WORDS: Record<string, string> = {
  PENDING_DEPOSIT: 'waiting for the deposit',
  KNOWN_DEPOSIT_TX: 'deposit seen',
  INCOMPLETE_DEPOSIT: 'part of the deposit arrived',
  PROCESSING: 'working on it',
  SUCCESS: 'done',
  REFUNDED: 'refunded',
  FAILED: 'failed',
  PENDING: 'matching',
  TX_BROADCASTED: 'settling',
  SETTLED: 'settled',
  NOT_FOUND_OR_NOT_VALID: 'not accepted',
};

function moveOf(r: IntentsRow): SwapLedgerMove {
  return { amount: r.delta.replace(/^[+-]/, ''), at: r.time, counterparty: r.counterparty === null ? null : shortIds(r.counterparty), hash: shortIds(r.hash) };
}

/* The ledger since the click, for one coin or (assetId null) for any.
   'yes': a row leaving for this move's handle (the 1Click funding transfer), or with no handle to
   go by, any row leaving in the window. 'no' needs two things: NOTHING left the account in the
   window, to the handle or anywhere else, since a row this app cannot tie to the move could still
   be it; and the page reaching back past the click, so a busy account cannot make a move that
   happened look like one that did not. Anything else is 'unknown'. */
export function ledgerMoves(
  activity: IntentsActivity,
  assetId: string | null,
  sinceMs: number,
  handle: string | null,
): { moved: 'yes' | 'no' | 'unknown'; outgoing: SwapLedgerMove[]; incoming: SwapLedgerMove[] } {
  if (!activity.ok || activity.partial || !Number.isFinite(sinceMs)) return { moved: 'unknown', outgoing: [], incoming: [] };
  const inWindow = activity.rows.filter((r) => (assetId === null || r.tokenId === assetId) && (r.time === null || Date.parse(r.time) >= sinceMs - LEDGER_SLACK_MS));
  const leaving = inWindow.filter((r) => r.delta.startsWith('-'));
  const toHandle = handle === null ? leaving : leaving.filter((r) => r.counterparty === handle);
  const incoming = inWindow.filter((r) => !r.delta.startsWith('-') && handle !== null && r.counterparty === handle);
  if (toHandle.length > 0) return { moved: 'yes', outgoing: toHandle.map(moveOf), incoming: incoming.map(moveOf) };
  if (leaving.length > 0) return { moved: 'unknown', outgoing: leaving.map(moveOf), incoming: incoming.map(moveOf) };
  const stamps = activity.rows.map((r) => Date.parse(r.time ?? '')).filter((n) => Number.isFinite(n));
  const reachesBack = activity.rows.length < LEDGER_PAGE || (stamps.length > 0 && Math.min(...stamps) <= sinceMs - LEDGER_SLACK_MS);
  return { moved: reachesBack ? 'no' : 'unknown', outgoing: [], incoming: incoming.map(moveOf) };
}

export async function swapCheck(ctx: PCtx, id: string): Promise<SwapCheckReply> {
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal id: ${oneLine(id, 120)}`);
  const blank: SwapCheckReply = {
    id: p.id,
    ok: false,
    venue: { name: null, status: null, refundedAmount: null },
    moved: 'unknown',
    refunded: null,
    balance: { symbol: '', now: null },
    ledger: null,
    summary: '',
  };
  if (p.draft.kind !== 'swap') return { ...blank, summary: 'That move is not a swap; read it with proposal_status.' };
  const draft = p.draft;
  const symbol = draft.fromSymbol.toUpperCase() === 'WNEAR' ? 'NEAR' : draft.fromSymbol;
  const account = draft.from.toLowerCase();
  const evidence = p.result?.evidence;
  const handle = typeof evidence?.handle === 'string' ? evidence.handle : null;
  const relay = draft.venue === INTENTS_RELAY_VENUE;

  // The venue's word now, asked again rather than read off the row.
  let status: string | null = evidence?.providerStage ?? null;
  let refundedAmount: string | null = evidence?.refundedAmount ?? null;
  let settlementHashes = 0;
  if (handle !== null) {
    try {
      if (relay && ctx.rails.relay !== undefined) {
        status = (await ctx.rails.relay.status(handle)).status;
      } else if (!relay && ctx.oneClickStatus !== undefined) {
        const read = await ctx.oneClickStatus(handle);
        status = read.found ? read.status : 'PENDING_DEPOSIT';
        refundedAmount = read.refundedAmount ?? refundedAmount;
        settlementHashes = read.nearTxHashes.length;
      }
    } catch {
      // The row's last word stands; the balance and the ledger below still answer.
    }
  }

  // The sold coin, its balance now, and its ledger since the click.
  const lookup = ctx.rails.swap;
  let assetId: string | null = null;
  let decimals = 0;
  let now: string | null = null;
  let ledger: { moved: 'yes' | 'no' | 'unknown'; outgoing: SwapLedgerMove[]; incoming: SwapLedgerMove[] } = { moved: 'unknown', outgoing: [], incoming: [] };
  let source = 'none';
  if (lookup !== undefined) {
    try {
      const list = await lookup.tokens();
      const pick = resolveAsset(draft.chain, draft.fromSymbol, NO_REGISTRY, list);
      if (pick.kind === 'one') {
        assetId = pick.assetId;
        decimals = pick.decimals;
      }
    } catch {
      // No id, no balance: the answer says unknown rather than guessing which coin was meant.
    }
    if (assetId !== null) {
      const [balance, activity] = await Promise.all([lookup.balance(account, assetId), lookup.activity(account, LEDGER_PAGE).catch(() => null)]);
      now = balance === null ? null : baseUnitsToDecimal(balance, decimals);
      if (activity !== null) {
        source = activity.source;
        ledger = ledgerMoves(activity, assetId, Date.parse(p.decidedAt ?? p.createdAt), relay ? null : handle);
      }
    }
  }

  /* WHAT MOVED, from the strongest fact on hand: the row's own proof, then the ledger, then a
     settlement hash the venue reports. A swap that confirmed moved by definition. */
  let moved = ledger.moved;
  if (p.status === 'executed') moved = 'yes';
  else if (p.result?.reason === 'venue_failed_nothing_moved' && moved === 'unknown') moved = 'no';
  else if (moved === 'unknown' && status === 'FAILED' && settlementHashes > 0) moved = 'yes';
  else if (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch' || p.status === 'policy_refused' || p.status === 'refused') moved = 'no';

  const refunded =
    status === 'REFUNDED' || (refundedAmount !== null && Number(refundedAmount) > 0) || ledger.incoming.length > 0 ? true : status === 'FAILED' ? false : null;
  const word = status === null ? null : (VENUE_WORDS[status] ?? oneLine(status, 30).toLowerCase());
  const holding = now === null ? '' : ` You hold ${now} ${symbol}.`;

  let summary: string;
  if (p.status === 'executed') summary = 'It went through.';
  else if (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch') summary = `It hasn't been sent: it waits for your OK.${holding}`;
  else if (p.status === 'policy_refused' || p.status === 'refused') summary = `It was never sent, so nothing left your balance.${holding}`;
  // The signed transfer can still run until its deadline, so "nothing left" is not over yet.
  else if (p.status === 'needs_reconciliation' && p.result?.reason === 'venue_failed_watching' && moved !== 'yes')
    summary = `Still checking this swap: nothing has left your balance so far. I'm keeping an eye on it ${watchWords(p.result?.evidence?.deadline, Date.now())}.${holding}`;
  else if (moved === 'no' && (status === 'FAILED' || status === 'NOT_FOUND_OR_NOT_VALID' || p.status === 'failed')) summary = `It didn't go through. Nothing left your balance.${holding}`;
  else if (moved === 'no') summary = `Nothing has left your balance yet${word === null ? '' : `; the swap service says ${word}`}.${holding}`;
  else if (moved === 'yes' && refunded === true) summary = `Your ${symbol} left and the swap service reports a refund${refundedAmount !== null && Number(refundedAmount) > 0 ? ` of ${refundedAmount}` : ''}.${holding}`;
  else if (moved === 'yes') summary = `Your ${symbol} left your balance and the swap hasn't finished${word === null ? '' : `: the swap service says ${word}`}. I'll update it here.`;
  else summary = `Still checking whether your ${symbol} left your balance. I'll update it here.`;

  return {
    id: p.id,
    ok: true,
    venue: { name: handle === null ? null : relay ? 'relay' : 'swap service', status, refundedAmount },
    moved,
    refunded,
    balance: { symbol, now },
    ledger: lookup === undefined || assetId === null ? null : { source, outgoing: ledger.outgoing, incoming: ledger.incoming },
    summary,
  };
}
