// What a yield position is worth, what it cost, and what that means as a percentage.
//
// Nothing here is stored. The cost basis is DERIVED from the proposal store, the way
// src/transactions.ts already derives the whole transaction history from proposals.json
// plus audit.jsonl on every request. That is the repo's idiom and it is the right one here
// for a reason beyond consistency: a principal figure kept in its own file can drift from
// the chain, and the one number this feature exists to print is the difference between the
// two. A number that can drift from its own reference is not evidence.
//
// So:
//   principal = sum(executed yield_deposit) - sum(executed yield_withdraw)      from the store
//   value     = aToken.balanceOf(us)                                            from the chain
//   earned    = value - principal
//
// The percentage this produces is REALIZED and backward-looking. 1inch's Aqua, which Karim
// named as the reference, computes its rate the same way and labels it "an observation, not
// a promise" and "a rear-view mirror". This module carries that label as a field so the
// renderer cannot forget to print it.

import type { ChainId, Proposal } from '../types.ts';
import type { VenueId, VenueRate } from './venue.ts';
import { fromBaseUnits } from './venue.ts';

// One movement of principal, from an executed proposal. This is the ledger Aqua puts in
// front of the number, and it is what makes the percentage checkable: every row has a
// transaction hash a reader can open on an explorer.
export type YieldCredit = {
  at: string; // ISO, the proposal's decidedAt
  kind: 'deposit' | 'withdraw';
  amountBase: string; // base units, unsigned; `kind` carries the direction
  amountUsd: number;
  txids: string[];
  proposalId: string;
};

// The realized figure, with everything a reader needs to judge it attached.
export type RealizedYield = {
  earnedBase: string;
  earnedUsd: number;
  windowMs: number;
  windowLabel: string; // '7 days', '4 hours', '18 minutes'
  // Null below MIN_ANNUALISE_MS. Annualising twelve minutes of interest gives a number that
  // is arithmetically correct and rhetorically a lie, and the honest move is to print the
  // dollars and no rate rather than a rate with a footnote nobody reads.
  annualisedPct: number | null;
  // The denominator, exposed because a percentage whose denominator is not visible cannot be
  // checked. Time-weighted, so a deposit made halfway through the window counts for half.
  avgPrincipalUsd: number;
  caveat: string;
};

export type YieldHolding = {
  venue: VenueId;
  chain: ChainId;
  symbol: string;
  decimals: number;
  receiptSymbol: string;
  receipt: string;
  // The explorer prefix for THIS position's chain, resolved server-side.
  //
  // The client used to build this from the network alone and always produced an Arbiscan
  // URL, so every ledger hash on a Base position linked to a transaction that is not there.
  // The chain is the other half of the question and the server already knows it, so the
  // client is handed the answer rather than asked to infer it.
  explorerTx: string;
  principalBase: string;
  valueBase: string;
  earnedBase: string;
  principalUsd: number;
  valueUsd: number;
  earnedUsd: number;
  openedAt: string | null;
  credits: YieldCredit[]; // newest first
  rate: VenueRate | null; // what the venue pays RIGHT NOW, which is not what we earned
  realized: RealizedYield | null;
};

export const MIN_ANNUALISE_MS = 60 * 60 * 1000; // one hour
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const OBSERVATION_CAVEAT = 'Observed, not promised. This is what it did, not what it will do.';

// A yield draft, structurally. Declared here rather than imported from ../types.ts so this
// module stays loadable by anything that wants to read a position without pulling the whole
// draft union in, the same separation src/rails/kinds.ts makes for the policy engine.
type YieldDraftShape = {
  kind: 'yield_deposit' | 'yield_withdraw';
  venue: VenueId;
  chain: ChainId;
  symbol: string;
  amountBase: string;
  amountUsd: number;
};

function isYieldProposal(p: Proposal): boolean {
  return p.kind === 'yield_deposit' || p.kind === 'yield_withdraw';
}

// Only EXECUTED proposals move principal.
//
// A proposal that is pending, refused or failed moved no money, and counting one would make
// the cost basis disagree with the chain in exactly the direction that inflates the earned
// figure. `result.ok` is checked as well as the status, because a rail can report a failure
// on a proposal the store has already marked executing.
function movedMoney(p: Proposal): boolean {
  return p.status === 'executed' && p.result?.ok === true;
}

export function creditsFor(proposals: Proposal[], venue: VenueId, chain: ChainId, symbol: string): YieldCredit[] {
  const out: YieldCredit[] = [];
  for (const p of proposals) {
    if (!isYieldProposal(p) || !movedMoney(p)) continue;
    const draft = p.draft as unknown as YieldDraftShape;
    if (draft.venue !== venue || draft.chain !== chain) continue;
    if (draft.symbol.toLowerCase() !== symbol.toLowerCase()) continue;
    out.push({
      at: p.decidedAt ?? p.createdAt,
      kind: draft.kind === 'yield_deposit' ? 'deposit' : 'withdraw',
      amountBase: draft.amountBase,
      amountUsd: draft.amountUsd,
      txids: p.result?.txids ?? [],
      proposalId: p.id,
    });
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

// Cost basis. Deposits raise it, withdrawals lower it, interest never touches it.
//
// Clamped at zero because a withdrawal takes out principal AND the interest sitting on top
// of it, so a full exit withdraws more base units than were ever put in. Without the clamp
// the basis goes negative and the next deposit reports a fortune.
export function principalFrom(credits: YieldCredit[]): bigint {
  let acc = 0n;
  for (const c of credits) {
    const amount = BigInt(c.amountBase);
    acc = c.kind === 'deposit' ? acc + amount : acc - amount;
    if (acc < 0n) acc = 0n;
  }
  return acc;
}

// When the CURRENT run of exposure started.
//
// Not the first deposit ever: the first deposit after the position was last empty. A
// position that was closed in June and reopened in August has earned for days, not months,
// and a window measured from June would divide by the wrong number and under-report the
// rate by an order of magnitude.
export function openedAtFrom(credits: YieldCredit[]): string | null {
  let acc = 0n;
  let openedAt: string | null = null;
  for (const c of credits) {
    const before = acc;
    acc = c.kind === 'deposit' ? acc + BigInt(c.amountBase) : acc - BigInt(c.amountBase);
    if (acc < 0n) acc = 0n;
    if (before === 0n && acc > 0n) openedAt = c.at;
    if (acc === 0n) openedAt = null;
  }
  return openedAt;
}

// Time-weighted average principal across the window.
//
// The naive version divides earnings by the principal as it stands now, which flatters any
// position that was topped up late: a dollar that arrived an hour ago is counted as though
// it had been working all week. Weighting each segment by how long it lasted is what makes
// the percentage mean what its label says.
export function avgPrincipalBase(credits: YieldCredit[], fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  const points = credits
    .map((c) => ({ at: Date.parse(c.at), delta: c.kind === 'deposit' ? BigInt(c.amountBase) : -BigInt(c.amountBase) }))
    .sort((a, b) => a.at - b.at);

  // Principal as it stood at the start of the window.
  let running = 0n;
  for (const p of points) {
    if (p.at > fromMs) break;
    running += p.delta;
    if (running < 0n) running = 0n;
  }

  let weighted = 0;
  let cursor = fromMs;
  for (const p of points) {
    if (p.at <= fromMs) continue;
    const at = Math.min(p.at, toMs);
    weighted += Number(running) * (at - cursor);
    cursor = at;
    running += p.delta;
    if (running < 0n) running = 0n;
    if (cursor >= toMs) break;
  }
  weighted += Number(running) * (toMs - cursor);
  return weighted / (toMs - fromMs);
}

export function windowLabel(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function realizedFrom(args: {
  credits: YieldCredit[];
  openedAt: string | null;
  earnedBase: bigint;
  decimals: number;
  priceUsd: number;
  nowMs: number;
}): RealizedYield | null {
  if (args.openedAt === null) return null;
  const fromMs = Date.parse(args.openedAt);
  if (!Number.isFinite(fromMs)) return null;
  const windowMs = Math.max(0, args.nowMs - fromMs);

  const earnedUsd = fromBaseUnits(args.earnedBase, args.decimals) * args.priceUsd;
  const avgBase = avgPrincipalBase(args.credits, fromMs, args.nowMs);
  const avgPrincipalUsd = (avgBase / 10 ** args.decimals) * args.priceUsd;

  let annualisedPct: number | null = null;
  if (windowMs >= MIN_ANNUALISE_MS && avgPrincipalUsd > 0) {
    annualisedPct = (earnedUsd / avgPrincipalUsd) * (YEAR_MS / windowMs) * 100;
  }

  return {
    earnedBase: args.earnedBase.toString(),
    earnedUsd,
    windowMs,
    windowLabel: windowLabel(windowMs),
    annualisedPct,
    avgPrincipalUsd,
    caveat: OBSERVATION_CAVEAT,
  };
}
