// GET /api/receipts: one card per action that actually happened.
//
// The transaction history already exists and answers a different question. It is a table built
// for someone auditing a sequence: every hash, every party, every gas figure, sortable, dense. A
// receipt answers the question a person has straight after doing something, which is "what just
// happened to my money", and the two facts that answer it are what the history buries: what the
// wallet was worth before, and what it is worth now.
//
// So this is a projection, not a second derivation. Every field comes from the same TxEntry the
// history renders, plus the two balances the executor records on the proposal. Two derivations of
// one event would let the history and the receipt disagree about an amount, and a person holding
// two screens that disagree about their own money has no way to tell which one is lying.

import type http from 'node:http';

import type { Proposal } from '../types.ts';
import type { TxEntry } from '../transactions.ts';
import { fail, intParam, sendJson } from './respond.ts';
import { transactionsPayload } from './state.ts';
import type { Ctx } from './context.ts';
import { amountUsdOf, didHeadline } from '../view/basic.ts';
import { explorerName } from '../explorers.ts';

export const RECEIPT_LIMIT_DEFAULT = 25;
export const RECEIPT_LIMIT_MAX = 200;

/* The four words the Activity filter offers, each standing for the entry kinds it covers. The
   window asks for `kind=move` rather than listing seven kinds itself, so the taxonomy lives
   here beside the projection and a new rail joins one list. `trade` and `bot` are the two
   words transactions.ts gives a venue row (venueKindOf): an armed plan or a cancelled one is a
   bot, a close or a moved stop is a trade. */
export const RECEIPT_KINDS: Record<string, readonly string[]> = {
  swap: ['swap'],
  trade: ['trade'],
  move: [
    'intents_deposit', 'intents_withdraw', 'hl_deposit', 'hl_withdraw', 'transfer', 'consolidate',
    'lp_add', 'lp_remove', 'yield_deposit', 'yield_withdraw',
  ],
  bot: ['bot'],
};

export type ReceiptQuery = {
  // Both are ms since the epoch. `since` keeps receipts at or after it; `before` is the paging
  // cursor and keeps receipts strictly older than it, so a page never repeats its last row.
  since: number | null;
  before: number | null;
  limit: number;
  // null is every kind. Otherwise the draft kinds behind one word of RECEIPT_KINDS.
  kinds: readonly string[] | null;
};

export type ReceiptPage = {
  receipts: Receipt[];
  // How many receipts the window and kind hold in all, before the cursor and the limit, so a
  // panel can say "12 in the last 24 hours" while showing five of them.
  total: number;
  // Whether anything older than the last row on this page is still in the window.
  hasMore: boolean;
  // The fees of everything in the window, not only of the page: the head line says what
  // the window cost, and a number that grew with each Show more would be a different fact.
  feesUsd: number;
};

// `explorer` is the name on the card's button ("View on Basescan"), derived from the url's host
// and null when there is no url or the host is not one this app links to.
type ReceiptTx = { chain: string; hash: string; url: string | null; explorer: string | null };

export type Receipt = {
  id: string;
  kind: string;
  at: string;
  headline: string;
  summary: string;
  fromChain: string;
  toChain: string;
  // What left, and in what. null for a move whose size is not an amount of a token: pulling
  // liquidity is a share of a position, and a number with no unit would be worse than none.
  amount: number | null;
  symbol: string | null;
  // What arrived, when the rail recorded it (transactions.ts receivedOf): the fill of a swap,
  // the amount paid out or credited by an Intents move. null when the rail did not say, which
  // is a different fact from nothing arriving, so no surface prints a zero for it.
  received: { symbol: string; amount: number } | null;
  // The venue's own fee plus whatever gas has been read back so far. null when neither is
  // known yet, which is a different fact from a fee of zero.
  feesUsd: number | null;
  txids: ReceiptTx[];
  // Three facts the receipt card's grid prints beside the fee: what the move was worth when it
  // was approved, the venue that did it (null for a plain chain transfer), and the address the
  // money left from (or landed at, when the record has no sender). All three come off the same
  // TxEntry as everything above.
  valueUsd: number | null;
  venue: string | null;
  wallet: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  status: 'executed' | 'failed' | 'needs_reconciliation';
};

// The three outcomes a receipt can describe. `executing` is not one of them: a card for an
// action still in flight would be a receipt for something that has not happened, and the boot
// sweep turns any row stranded in that state into needs_reconciliation anyway.
function receiptStatus(entry: TxEntry): Receipt['status'] | null {
  if (entry.status === 'executed' || entry.status === 'failed' || entry.status === 'needs_reconciliation') {
    return entry.status;
  }
  return null;
}

/* Gas is filled in behind the response by the same background reader the history uses, so a
   receipt read a second after the action shows the venue fee and adds the gas once it lands.
   Adding them is right: a person asking what this cost means everything it cost. */
function feesOf(entry: TxEntry): number | null {
  const gas = entry.hashes
    .map((h) => h.gas?.feeUsd ?? null)
    .filter((usd): usd is number => usd !== null)
    .reduce<number | null>((sum, usd) => (sum ?? 0) + usd, null);
  if (entry.venueFeeUsd === null && gas === null) return null;
  return (entry.venueFeeUsd ?? 0) + (gas ?? 0);
}

/* The row's sentence. Falls back to null rather than to a guess: a receipt whose proposal
   has been pruned from the store still has the rail's own line to show, and inventing a
   headline for a draft we cannot read would be the one thing worse than showing the raw one. */
function headlineFor(proposal: Proposal | undefined): string {
  if (proposal === undefined) return '';
  return didHeadline(proposal.draft, amountUsdOf(proposal.draft));
}

/* Every receipt, newest first: the history is already sorted that way (transactions.ts), and
   the projection keeps the order. Filtering and paging happen after, over the whole list,
   because `total` and `feesUsd` describe the window and not the page. */
function buildReceipts(ctx: Ctx): Receipt[] {
  const proposals = new Map<string, Proposal>();
  for (const p of ctx.proposals.list()) proposals.set(p.id, p);

  const out: Receipt[] = [];
  for (const entry of transactionsPayload(ctx).entries) {
    const status = receiptStatus(entry);
    if (status === null) continue;
    const balances = proposals.get(entry.id)?.balances;
    out.push({
      id: entry.id,
      kind: entry.kind,
      at: entry.ts,
      /* TWO SENTENCES, because they are written for two different readers and this panel
         was showing the wrong one.

         `headline` is what happened, in the owner's own words, built from the typed draft
         the way src/view/basic.ts builds its history. It is what a row in a list says.

         `summary` is the rail's own sentence, verbatim, carrying the intent hash and the
         quote handle. It is evidence and it stays, because it is the one line in the record
         written by the thing that actually did the work. It belongs on the opened receipt,
         not as the title of a row: basic.ts:570 already says why, that text is written for
         whoever is debugging this app and reads as noise to the person who owns the money. */
      headline: headlineFor(proposals.get(entry.id)),
      summary: entry.detail,
      fromChain: entry.place,
      toChain: entry.toPlace,
      amount: entry.sent?.amount ?? null,
      symbol: entry.sent?.symbol ?? null,
      received: entry.received,
      feesUsd: feesOf(entry),
      txids: entry.hashes.map((h) => ({ chain: h.place, hash: h.hash, url: h.url, explorer: explorerName(h.url) })),
      valueUsd: Number.isFinite(entry.valueUsd) && entry.valueUsd > 0 ? entry.valueUsd : null,
      venue: entry.venue,
      wallet: entry.from?.address ?? entry.to?.address ?? null,
      balanceBefore: balances?.beforeUsd ?? null,
      balanceAfter: balances?.afterUsd ?? null,
      status,
    });
  }
  return out;
}

/* A time parameter is ms since the epoch or absent. Anything else is refused rather than
   read as "no window": a panel that asked for the last day and silently got all time would
   show a fee total for the wrong window with nothing on screen to say so. */
function msParam(raw: string | null): number | null | undefined {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseReceiptQuery(params: URLSearchParams): ReceiptQuery | { error: string } {
  const since = msParam(params.get('since'));
  if (since === undefined) return { error: 'since must be a time in ms since the epoch' };
  const before = msParam(params.get('before'));
  if (before === undefined) return { error: 'before must be a time in ms since the epoch' };
  const kind = params.get('kind');
  let kinds: readonly string[] | null = null;
  if (kind !== null && kind !== '' && kind !== 'all') {
    const known = RECEIPT_KINDS[kind];
    if (known === undefined) return { error: `kind must be one of ${Object.keys(RECEIPT_KINDS).join(', ')}, or all` };
    kinds = known;
  }
  return {
    since,
    before,
    limit: intParam(params.get('limit'), RECEIPT_LIMIT_DEFAULT, RECEIPT_LIMIT_MAX),
    kinds,
  };
}

function atMs(receipt: Receipt): number {
  const ms = Date.parse(receipt.at);
  return Number.isFinite(ms) ? ms : 0;
}

/* The window first (since and kind), then the cursor and the limit inside it. `total` and
   `feesUsd` are counted on the window so they do not move as pages are read. */
export function pageReceipts(all: Receipt[], query: ReceiptQuery): ReceiptPage {
  const inWindow = all.filter((r) => {
    if (query.kinds !== null && !query.kinds.includes(r.kind)) return false;
    if (query.since !== null && atMs(r) < query.since) return false;
    return true;
  });
  const older = query.before === null ? inWindow : inWindow.filter((r) => atMs(r) < (query.before as number));
  let feesUsd = 0;
  for (const r of inWindow) if (typeof r.feesUsd === 'number') feesUsd += r.feesUsd;
  return {
    receipts: older.slice(0, query.limit),
    total: inWindow.length,
    hasMore: older.length > query.limit,
    feesUsd,
  };
}

export function sendReceipts(ctx: Ctx, url: URL, res: http.ServerResponse): void {
  const query = parseReceiptQuery(url.searchParams);
  if ('error' in query) {
    fail(res, 400, query.error);
    return;
  }
  sendJson(res, 200, pageReceipts(buildReceipts(ctx), query));
}
