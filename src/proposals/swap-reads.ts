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
import { networkByVenue } from '../rails/intents-address.ts';
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
import { reasonSentence, shortIds } from './view.ts';

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

type SidePick = { kind: 'one'; side: SwapSide } | { kind: 'many'; candidates: SwapSide[] } | { kind: 'none'; why: string };

/* A coin named by ticker, by ticker and chain, or by id. A ticker alone across every chain is
   one answer when one coin carries it, or when the person holds exactly one of several (the one
   they can sell); anything else is a question, answered with the ids to choose between. */
function resolveSide(asked: string, chain: string | undefined, list: OneClickToken[], held: ReadonlySet<string> | null): SidePick {
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
  if (held !== null) {
    const owned = matches.filter((s) => held.has(s.assetId));
    if (owned.length === 1) return { kind: 'one', side: owned[0]! };
  }
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
  const note = probing
    ? 'liquidity is a dry quote for a few dollars of USDC, asked just now. Name a coin by its assetId to be exact.'
    : 'liquidity is what a recent quote found, or unknown. Search for one coin to have each result asked about.';
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

  const held = heldOf(ctx);
  const fromPick = resolveSide(String(params.fromSymbol ?? ''), params.chain, list, new Set(held.keys()));
  const toPick = resolveSide(String(params.toSymbol ?? ''), params.toChain, list, null);
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
        sentence: `Several coins go by that name, so there is no quote yet. Say which one you mean for ${which}: each is listed with its network.`,
        candidates: pick.candidates,
      };
    }
    if (pick.kind === 'none') {
      return {
        ...none,
        from: fromPick.kind === 'one' ? fromPick.side : null,
        to: toPick.kind === 'one' ? toPick.side : null,
        reason: 'unsupported_asset',
        sentence: "The swap service doesn't offer that coin, so there is no quote. Ask what can be swapped and pick from that.",
        details: pick.why,
      };
    }
  }
  if (fromPick.kind !== 'one' || toPick.kind !== 'one') return { ...none, from: null, to: null, reason: 'invalid_request', sentence: plain('invalid_request', null) };
  const from = fromPick.side;
  const to = toPick.side;

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
  const priced: SwapDraft = { ...draft, amountIn: Number(exact), amountInExact: exact, amountUsd: usdOf(ctx, from.symbol, Number(exact), ctx.ledger.snapshot()) };
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
  else if (moved === 'no' && (status === 'FAILED' || status === 'NOT_FOUND_OR_NOT_VALID' || p.status === 'failed')) summary = `It didn't go through. Nothing left your balance.${holding}`;
  else if (moved === 'no') summary = `Nothing has left your balance yet${word === null ? '' : `; the swap service says ${word}`}.${holding}`;
  else if (moved === 'yes' && refunded === true) summary = `Your ${symbol} left and the swap service reports a refund${refundedAmount !== null && Number(refundedAmount) > 0 ? ` of ${refundedAmount}` : ''}.${holding}`;
  else if (moved === 'yes') summary = `Your ${symbol} left your balance and the swap hasn't finished${word === null ? '' : `: the swap service says ${word}`}. The app keeps checking; don't send it again.`;
  else summary = `The app can't tell yet whether your ${symbol} left your balance. It keeps checking; don't send it again.`;

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
