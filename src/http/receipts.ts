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
import { intParam, sendJson } from './respond.ts';
import { transactionsPayload } from './state.ts';
import type { Ctx } from './context.ts';
import { amountUsdOf, didHeadline } from '../view/basic.ts';

export const RECEIPT_LIMIT_DEFAULT = 25;
export const RECEIPT_LIMIT_MAX = 200;

type ReceiptTx = { chain: string; hash: string; url: string | null };

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
  // The venue's own fee plus whatever gas has been read back so far. null when neither is
  // known yet, which is a different fact from a fee of zero.
  feesUsd: number | null;
  txids: ReceiptTx[];
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

function buildReceipts(ctx: Ctx, limit: number): Receipt[] {
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
      feesUsd: feesOf(entry),
      txids: entry.hashes.map((h) => ({ chain: h.place, hash: h.hash, url: h.url })),
      balanceBefore: balances?.beforeUsd ?? null,
      balanceAfter: balances?.afterUsd ?? null,
      status,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function sendReceipts(ctx: Ctx, url: URL, res: http.ServerResponse): void {
  const limit = intParam(url.searchParams.get('limit'), RECEIPT_LIMIT_DEFAULT, RECEIPT_LIMIT_MAX);
  sendJson(res, 200, { receipts: buildReceipts(ctx, limit) });
}
