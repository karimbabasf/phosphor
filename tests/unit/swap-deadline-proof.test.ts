// A swap whose signed transfer can provably never run closes as "didn't go through, nothing left
// your balance" within half a minute of the chain showing it.
//
// 2026-09-25, proposal 6bb6783b, VVV to USDC on the intents-native rail: the transfer's deadline
// passed at 20:02:34Z, the rail's watch gave up at 20:04:34Z as "still checking", the grace rule
// could only call it dead at 20:07:34Z, and nothing asked again until the ten-minute sweep at
// 20:13:08Z. The card read "On its way" all that time over money that never left (those words are
// tests/unit/proposal-view.test.ts's).
//
// The proof is src/relay/fate.ts: NEAR's final block stamped past the deadline, with the nonce
// unspent at that block, is a transfer the verifier refuses from then on. The chain is a fake
// here, and the tests read what the proof, the deadline watch and the rail's own watch make of it.
//
// Run: node --test tests/unit/swap-deadline-proof.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FATE_RECHECK_MS, RELAY_DEADLINE_GRACE_MS, transferFate } from '../../src/relay/fate.ts';
import type { FateReads } from '../../src/relay/fate.ts';
import { finalBlockOf, liveVerifier } from '../../src/relay/verifier.ts';
import type { FinalBlock } from '../../src/relay/verifier.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_VERIFIER, intentsNativeRail } from '../../src/rails/intents-native.ts';
import { parseStatus } from '../../src/intents.ts';
import type { OneClickQuote, OneClickStatus } from '../../src/intents.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { IntentsActivity } from '../../src/chainscan/index.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import type { Proposal, ProposalStatus, SwapDraft } from '../../src/types.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { SELF_EVM, makeCtx } from './helpers/proposals.ts';

const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
const nonceLiving = (untilMs: number): string => buildNonce({ salt: SALT, deadlineMs: untilMs, random: new Uint8Array(15).fill(7) });
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------- the proof ----------

const T = Date.parse('2026-09-25T20:02:34.000Z');
const PROOF_NONCE = nonceLiving(T + 72 * 3_600_000);

type Chain = { block: FinalBlock | null; spent: boolean | null; salt?: boolean | null };

// The three reads, logged in the order they were taken and at which block.
function chainOf(c: Chain): FateReads & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    finalBlock: async () => {
      log.push('block');
      return c.block;
    },
    nonceUsed: async (_account, _nonce, at) => {
      log.push(`nonce@${at ?? 'final'}`);
      return c.spent;
    },
    saltValid: async (_salt, at) => {
      log.push(`salt@${at ?? 'final'}`);
      return c.salt === undefined ? true : c.salt;
    },
  };
}

const signed = { account: SELF_EVM, nonce: PROOF_NONCE, deadline: iso(T) };

test('a final block stamped half a minute past the deadline, with the nonce unspent at that block, is a transfer that never ran and never can', async () => {
  const block = { hash: 'Blk1', atMs: T + 30_001 };
  const chain = chainOf({ block, spent: false });
  assert.deepEqual(await transferFate(chain, signed, T + 30_000), { ran: false, dead: { by: 'chain', block } });
  assert.deepEqual(chain.log, ['block', 'nonce@Blk1', 'salt@Blk1'], 'the clock first, then the nonce and the salt at that same block');
});

/* Security review F3: the RPC's clock alone closed a row. A node that stamps a final block a
   second past the deadline while this Mac is three minutes short of it wrote "nothing moved" over
   a transfer that could still run, on every path, the sweep and a Reconcile click included. Both
   clocks now have to be half a minute past it. */
test('both clocks must be half a minute past the deadline: the chain\'s and this one', async () => {
  const past = { hash: 'BlkPast', atMs: T + 31_000 };
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false }), signed, T + 29_999), { ran: false, dead: null }, 'this clock short of the floor');
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false }), signed, T - 5_000), { ran: false, dead: null }, 'this clock short of the deadline');
  const early = { hash: 'BlkEarly', atMs: T + 30_000 };
  assert.deepEqual(await transferFate(chainOf({ block: early, spent: false }), signed, T + 10 * 60_000), { ran: false, dead: null }, 'the chain short of the floor');
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false }), signed, T + 30_000), { ran: false, dead: { by: 'chain', block: past } });
});

test('a block stamped more than two minutes ahead of this clock is no answer: the grace rule decides, and nothing is read at it', async () => {
  // The proof of concept as it was filed: this clock 180 s short of the deadline, a final block a
  // second past it.
  const forged = chainOf({ block: { hash: 'FAKEHASH', atMs: T + 1_000 }, spent: false });
  assert.deepEqual(await transferFate(forged, signed, T - 180_000), { ran: false, dead: null });
  assert.deepEqual(forged.log, ['block', 'nonce@final', 'salt@final'], 'the nonce was read at a block stamped in the future');
  // Past both floors by this clock, and still no answer when the block is 121 s ahead of it.
  const ahead = chainOf({ block: { hash: 'Ahead', atMs: T + 60_000 + 121_000 }, spent: false });
  assert.deepEqual(await transferFate(ahead, signed, T + 60_000), { ran: false, dead: null });
  assert.deepEqual(ahead.log, ['block', 'nonce@final', 'salt@final']);
  // Two minutes ahead exactly is a clock a little fast, and it answers.
  const fast = { hash: 'Fast', atMs: T + 60_000 + 120_000 };
  assert.deepEqual(await transferFate(chainOf({ block: fast, spent: false }), signed, T + 60_000), { ran: false, dead: { by: 'chain', block: fast } });
  // A future block past the grace is the grace rule's call, the rule for a chain that cannot be read.
  const graced = chainOf({ block: { hash: 'Later', atMs: T + RELAY_DEADLINE_GRACE_MS + 10 * 60_000 }, spent: false });
  assert.deepEqual(await transferFate(graced, signed, T + RELAY_DEADLINE_GRACE_MS), { ran: false, dead: { by: 'clock' } });
});

test('a final block stamped at or before the deadline is a transfer that can still run, whatever this clock says', async () => {
  const late = T + RELAY_DEADLINE_GRACE_MS + 60_000;
  assert.deepEqual(await transferFate(chainOf({ block: { hash: 'Blk2', atMs: T }, spent: false }), signed, late), { ran: false, dead: null });
  assert.deepEqual(await transferFate(chainOf({ block: { hash: 'Blk3', atMs: T - 2_600 }, spent: false }), signed, late), { ran: false, dead: null });
});

test('a spent nonce is a transfer that ran, never "nothing moved"', async () => {
  assert.deepEqual(await transferFate(chainOf({ block: { hash: 'Blk4', atMs: T + 60_000 }, spent: true }), signed, T + 60_000), { ran: true });
});

test('without the chain\'s clock only this clock and the grace can call the deadline passed', async () => {
  const blind = chainOf({ block: null, spent: false });
  assert.deepEqual(await transferFate(blind, signed, T + 60_000), { ran: false, dead: null }, 'past the deadline by this clock, inside the grace');
  assert.deepEqual(blind.log, ['block', 'nonce@final', 'salt@final']);
  assert.deepEqual(await transferFate(chainOf({ block: null, spent: false }), signed, T + RELAY_DEADLINE_GRACE_MS), { ran: false, dead: { by: 'clock' } });
});

test('an unspent nonce the verifier may have pruned, or one it did not answer for, proves nothing', async () => {
  const past = { hash: 'Blk5', atMs: T + 60_000 };
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false, salt: false }), signed, T), { ran: null, why: 'salt_retired' });
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false, salt: null }), signed, T), { ran: null, why: 'salt_no_answer' });
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: null }), signed, T), { ran: null, why: 'no_answer' });
  const short = nonceLiving(T + 30_000);
  assert.deepEqual(await transferFate(chainOf({ block: past, spent: false }), { ...signed, nonce: short }, T), { ran: null, why: 'nonce_life_over', nonceLifeMs: T + 30_000 });
  const venues = chainOf({ block: past, spent: false });
  assert.deepEqual(await transferFate(venues, { ...signed, nonce: '1727000000000' }, T), { ran: null, why: 'not_the_verifiers' });
  assert.deepEqual(venues.log, [], 'a Hyperliquid nonce is never asked of the verifier');
});

// ---------- the reads ----------

test('the chain\'s clock is the final block\'s own nanoseconds cut to the millisecond, and a read at that block names the block', async () => {
  assert.deepEqual(finalBlockOf({ hash: 'H', timestamp_nanosec: '1790000000123999999' }), { hash: 'H', atMs: 1_790_000_000_123 });
  assert.equal(finalBlockOf({ hash: 'H', timestamp: 1_790_000_000_123_999_999 }), null, 'the JSON number has lost its last digits and is not read');
  assert.equal(finalBlockOf({ timestamp_nanosec: '1790000000123999999' }), null);
  assert.equal(finalBlockOf({ hash: 'H', timestamp_nanosec: 'soon' }), null);

  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    sent.push(body);
    if (body.method === 'block') return new Response(JSON.stringify({ result: { header: { hash: 'Blk', timestamp_nanosec: '1790000000123999999' } } }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from('false')] } }));
  }) as unknown as typeof fetch;
  const verifier = liveVerifier(fetchImpl);
  assert.deepEqual(await verifier.finalBlock?.(), { hash: 'Blk', atMs: 1_790_000_000_123 });
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } });
  assert.equal(await verifier.nonceUsed(SELF_EVM, PROOF_NONCE, 'Blk'), false);
  assert.equal(sent[1]?.params['block_id'], 'Blk');
  assert.equal('finality' in (sent[1]?.params ?? {}), false, 'at the block the clock came from, not whatever is final a moment later');
  assert.equal(await verifier.isValidSalt?.(SALT, 'Blk'), false);
  assert.equal(sent[2]?.params['block_id'], 'Blk');
  await verifier.nonceUsed(SELF_EVM, PROOF_NONCE);
  assert.equal(sent[3]?.params['finality'], 'final', 'and at the newest final block when no block is named');
});

// ---------- the deadline watch ----------

const SWAP: SwapDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'near',
  toChain: 'near',
  fromSymbol: 'VVV',
  toSymbol: 'USDC',
  amountIn: 12,
  amountInExact: '12',
  amountUsd: 12,
  minAmountOut: 11.8,
  from: SELF_EVM,
  to: SELF_EVM,
  counterparty: INTENTS_NATIVE_COUNTERPARTY,
  quote: null,
};

const PROCESSING: OneClickStatus = { found: true, status: 'PROCESSING', reported: 'PROCESSING', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [] };
const FAILED: OneClickStatus = { ...PROCESSING, status: 'FAILED', reported: 'FAILED', refundedAmount: '0' };
// One row from long before the click: the ledger reaches back, and nothing went to the handle.
const QUIET: IntentsActivity = {
  account: SELF_EVM,
  ok: true,
  rows: [{ cause: 'TRANSFER', token: 'VVV', tokenId: 'nep141:vvv', delta: '+1', counterparty: 'solver.near', hash: 'h0', time: iso(Date.now() - 3_600_000) }],
  balances: null,
  partial: false,
  source: 'nearblocks',
  explorer: null,
  note: '',
};

type ChainNow = { block: (deadlineMs: number) => FinalBlock | null; spent: boolean | null; salt?: boolean | null; saltRead?: () => Promise<boolean | null> };

// A live service whose ledger refresh the test fires by hand, over a fake chain and 1Click. An
// Error for `status` is 1Click not answering: status() throws on a network or a non-404 HTTP error.
function world(chain: ChainNow, status: OneClickStatus | Error = PROCESSING) {
  const listeners: Array<() => void> = [];
  const snapshot = { ...loadDemoLedger(), mode: 'live' as const };
  const ledger: Ledger = {
    snapshot: () => snapshot,
    intents: () => undefined,
    hyperliquid: () => undefined,
    refresh: async () => snapshot,
    onRefresh: (fn) => {
      listeners.push(fn);
      return () => {};
    },
  };
  const reads: string[] = [];
  const asked: string[] = [];
  let deadlineMs = Number.NaN;
  const rails: RailRegistry = {
    for: () => null,
    kinds: () => [],
    relay: {
      status: async () => {
        throw new Error('a 1Click row is never asked of the relay');
      },
      finalBlock: async () => {
        reads.push('block');
        return chain.block(deadlineMs);
      },
      nonceUsed: async (_account, _nonce, at) => {
        reads.push(`nonce@${at ?? 'final'}`);
        return chain.spent;
      },
      saltValid: async (_salt, at) => {
        reads.push(`salt@${at ?? 'final'}`);
        if (chain.saltRead !== undefined) return chain.saltRead();
        return chain.salt === undefined ? true : chain.salt;
      },
    },
    swap: { tokens: async () => [], balance: async () => null, activity: async () => QUIET },
  };
  const h = makeCtx({
    deps: {
      rails,
      ledger,
      oneClickStatus: async (handle) => {
        asked.push(handle);
        if (status instanceof Error) throw status;
        return status;
      },
    },
  });
  // The rail's own words when its watch ran out: the incident's row.
  const seed = (over: { deadlineMs: number; status?: ProposalStatus; reason?: string; id?: string }): Proposal => {
    deadlineMs = over.deadlineMs;
    const p: Proposal = {
      id: over.id ?? 'swap-1',
      kind: 'swap',
      createdAt: iso(over.deadlineMs - 180_000),
      decidedAt: iso(over.deadlineMs - 180_000),
      settledAt: iso(over.deadlineMs + 120_000),
      status: over.status ?? 'needs_reconciliation',
      draft: SWAP,
      simulation: null,
      verdict: { outcome: 'allow', reasons: [] },
      decidedBy: 'policy',
      result: {
        ok: false,
        reason: over.reason ?? 'stuck_unknown',
        detail: 'the intent was submitted but 1click did not reach a terminal status within 300s (last status PROCESSING). THE INTENT IS SIGNED AND SUBMITTED.',
        txids: ['intent-h'],
        evidence: { handle: 'dep-1', nonce: nonceLiving(Date.now() + 72 * 3_600_000), deadline: iso(over.deadlineMs), providerStage: 'PROCESSING' },
      },
    };
    h.store.put(p);
    return p;
  };
  // One ledger refresh, and the re-checks it started run to their end: every read here is a
  // promise that is already resolved, so one timer turn is all of them.
  const tick = async (): Promise<void> => {
    for (const fn of listeners) fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { ...h, reads, asked, seed, tick };
}

const pastBy = (ms: number) => (deadlineMs: number): FinalBlock => ({ hash: 'BlkPast', atMs: deadlineMs + ms });

test('(a) chain time past the deadline with the nonce unspent: the first refresh after the deadline closes it, nothing moved', async () => {
  const w = world({ block: pastBy(31_000), spent: false });
  w.seed({ deadlineMs: Date.now() - 40_000 });
  assert.equal(w.svc.dailyLimit(25_000).spentUsd, 12, 'open and counted until the proof');

  await w.tick();
  const out = w.store.get('swap-1');
  assert.equal(out?.status, 'failed', 'on the first tick, not the ten-minute sweep and not after the five-minute grace');
  assert.equal(out?.result?.reason, 'venue_failed_nothing_moved');
  assert.match(out?.result?.detail ?? '', /1click reports PROCESSING, and the deadline .* passed with the signed transfer never run \(NEAR's final block is stamped .*, past it, so it never can\)/);
  assert.deepEqual(w.reads, ['block', 'nonce@BlkPast', 'salt@BlkPast'], 'the chain\'s clock first, then the nonce at that block');
  assert.equal(w.svc.dailyLimit(25_000).spentUsd, 0, 'nothing left, so nothing is charged to the day');
  const view = w.svc.view(out!);
  assert.equal(view.state, 'didnt_go_through');
  assert.equal(view.reason?.sentence, "The swap didn't go through. Nothing left your balance.");
  assert.equal(view.reason?.retry, true);
});

test('(a) a row the proof closed stays closed when a later re-check cannot read the chain', async () => {
  let readable = true;
  const w = world({ block: (deadlineMs) => (readable ? { hash: 'BlkPast', atMs: deadlineMs + 31_000 } : null), spent: false }, FAILED);
  w.seed({ deadlineMs: Date.now() - 40_000 });
  await w.tick();
  assert.equal(w.store.get('swap-1')?.status, 'failed');

  // Inside the grace, this clock alone would still say "can run": the sweep and a click leave it.
  readable = false;
  assert.equal(await w.svc.reconcileOpen(), 0, 'the sweep does not pick a proof-closed row up');
  assert.equal((await w.svc.reconcile('swap-1')).status, 'failed', 'and a click does not reopen it');
  assert.equal(w.store.get('swap-1')?.result?.reason, 'venue_failed_nothing_moved');
});

test('(a) the sweep never asks the swap service about a row the proof closed', async () => {
  /* Inside the grace a "nothing moved" row is swept again in case its transfer runs late
     (closedWhileLive), unless the proof closed it. The FAILED guard would keep such a row closed
     even if it were asked, and the sweep counts only status changes, so the question itself is
     the only thing that shows the row was picked up. */
  const w = world({ block: pastBy(1_000), spent: false }, FAILED);
  w.seed({ deadlineMs: Date.now() - 20_000 });
  await w.tick();
  assert.equal(w.store.get('swap-1')?.status, 'failed');
  assert.equal(w.store.get('swap-1')?.result?.reason, 'venue_failed_nothing_moved');
  const asked = w.asked.length;
  assert.equal(await w.svc.reconcileOpen(), 0);
  assert.equal(w.asked.length, asked, 'the sweep asked 1Click about a row closed on the proof');
});

test('(b) chain time at or before the deadline: the row stays open and counted, whatever this clock says', async () => {
  const w = world({ block: (deadlineMs) => ({ hash: 'BlkBehind', atMs: deadlineMs - 2_600 }), spent: false });
  w.seed({ deadlineMs: Date.now() - 10_000 });
  await w.tick();
  const out = w.store.get('swap-1');
  assert.equal(out?.status, 'needs_reconciliation');
  assert.equal(out?.result?.reason, 'stuck_unknown');
  assert.equal(w.svc.dailyLimit(25_000).spentUsd, 12);
  assert.deepEqual(w.asked, ['dep-1'], 'it was asked, and the chain said the transfer can still run');

  const early = world({ block: pastBy(1_000), spent: false });
  early.seed({ deadlineMs: Date.now() + 60_000 });
  await early.tick();
  assert.deepEqual(early.asked, [], 'before the deadline by this clock nothing is asked');
});

test('(c) a spent nonce is never "nothing moved": still waiting on a PROCESSING swap, the input gone on a FAILED one', async () => {
  const processing = world({ block: pastBy(60_000), spent: true });
  processing.seed({ deadlineMs: Date.now() - 90_000 });
  await processing.tick();
  assert.equal(processing.store.get('swap-1')?.status, 'needs_reconciliation');
  assert.equal(processing.store.get('swap-1')?.result?.reason, 'stuck_unknown');

  const failed = world({ block: pastBy(60_000), spent: true }, FAILED);
  failed.seed({ deadlineMs: Date.now() - 90_000 });
  await failed.tick();
  assert.equal(failed.store.get('swap-1')?.status, 'needs_reconciliation');
  assert.equal(failed.store.get('swap-1')?.result?.reason, 'venue_failed_refund_pending');
});

test('(d) chain time unreadable: only the grace rule can close it', async () => {
  const inside = world({ block: () => null, spent: false });
  inside.seed({ deadlineMs: Date.now() - 60_000 });
  await inside.tick();
  assert.equal(inside.store.get('swap-1')?.status, 'needs_reconciliation', 'past the deadline by this clock, inside the grace: open');
  assert.deepEqual(inside.reads, ['block', 'nonce@final', 'salt@final']);

  const after = world({ block: () => null, spent: false });
  after.seed({ deadlineMs: Date.now() - RELAY_DEADLINE_GRACE_MS - 30_000 });
  await after.tick();
  const out = after.store.get('swap-1');
  assert.equal(out?.status, 'failed', 'the grace behind it: closed by this clock');
  assert.equal(out?.result?.reason, 'venue_failed_nothing_moved');
  assert.doesNotMatch(out?.result?.detail ?? '', /final block/);
});

test('(e) a Reconcile click takes no RPC\'s word for a deadline this clock has not reached, and no block stamped in the future', async () => {
  // The click and the sweep ask whatever the row's deadline says. An RPC whose final block is a
  // minute and a half ahead of this Mac, past the deadline, closed the row as nothing moved.
  const lying = world({ block: pastBy(31_000), spent: false }, FAILED);
  lying.seed({ deadlineMs: Date.now() + 60_000, reason: 'venue_failed_watching' });
  const out = await lying.svc.reconcile('swap-1');
  assert.equal(out.status, 'needs_reconciliation', `closed on the RPC's clock alone: ${out.result?.reason}`);
  assert.equal(lying.svc.dailyLimit(25_000).spentUsd, 12, 'the day was released on the RPC\'s clock alone');

  // A block stamped ten minutes ahead is no answer at all, and nothing is read at it.
  const future = world({ block: (deadlineMs) => ({ hash: 'Forged', atMs: deadlineMs + 10 * 60_000 }), spent: false }, FAILED);
  future.seed({ deadlineMs: Date.now() - 40_000, reason: 'venue_failed_watching' });
  assert.equal((await future.svc.reconcile('swap-1')).status, 'needs_reconciliation');
  assert.ok(!future.reads.includes('nonce@Forged'), 'the nonce was read at a block stamped in the future');
});

/* 1Click not answering (a network error, a 5xx) threw before the chain was asked: while it was down
   the deadline watch never reached the proof, the row waited for 1Click to come back, and the watch
   wrote an error line every half minute for minutes per row. The chain decides without it. */
const DOWN = new Error('1click status failed: 503');
// The lines the deadline watch and the sweep write when a re-check throws (src/proposals/reconcile.ts).
const watchErrors = (w: ReturnType<typeof world>) =>
  w.audit.tail(200).filter((e) => e.msg.includes('the re-check after its deadline failed') || e.msg.includes('could not re-check it'));

test('(e) 1Click not answering does not stop the proof: a transfer past its deadline that never ran closes the row', async () => {
  const w = world({ block: pastBy(1_000), spent: false }, DOWN);
  w.seed({ deadlineMs: Date.now() - 20_000 });
  await w.tick();
  const out = w.store.get('swap-1');
  assert.equal(out?.status, 'failed', 'the row waited for 1Click to come back');
  assert.equal(out?.result?.reason, 'venue_failed_nothing_moved');
  assert.match(
    out?.result?.detail ?? '',
    /^1click could not be asked, and the deadline .* passed with the signed transfer never run \(NEAR's final block is stamped .*\): the verifier shows its nonce unspent, so nothing left the balance\.$/,
  );
  assert.equal(w.svc.dailyLimit(25_000).spentUsd, 0, 'nothing left, so nothing is charged to the day');
  assert.deepEqual(watchErrors(w), []);
});

test('(e) 1Click not answering over a transfer that can still run keeps the row open with one line, written once', async () => {
  const w = world({ block: (deadlineMs) => ({ hash: 'BlkBehind', atMs: deadlineMs - 2_600 }), spent: false }, DOWN);
  w.seed({ deadlineMs: Date.now() - 10_000 });
  await w.tick();
  for (let i = 0; i < 3; i += 1) await w.svc.reconcile('swap-1');
  const out = w.store.get('swap-1');
  assert.equal(out?.status, 'needs_reconciliation');
  assert.equal(out?.result?.reason, 'stuck_unknown');
  assert.match(out?.result?.detail ?? '', /^the intent was submitted .* Re-checked with 1Click: it did not answer, so nothing has changed; it is asked again shortly\.$/);
  assert.equal(w.svc.dailyLimit(25_000).spentUsd, 12, 'open and counted');
  assert.equal(w.asked.length, 4);
  const said = w.audit.tail(200).filter((e) => e.msg.includes('it did not answer'));
  assert.equal(said.length, 1, `one line for four questions, not one a question: ${said.length}`);
  assert.deepEqual(watchErrors(w), [], 'an error line for a question 1Click did not answer');
});

/* NEAR's final block trails this clock by about 2.6 s, so the first refresh after the deadline often
   reads a block short of it: the chain not there yet, not an answer. Half a minute until the next
   question made the close land 30 to 35 s after the deadline instead of a refresh after it. */
test('a question that lands inside NEAR\'s lag behind this clock is asked again on the next refresh, not half a minute later', async () => {
  let reads = 0;
  const w = world({ block: (deadlineMs) => (++reads === 1 ? { hash: 'BlkShort', atMs: deadlineMs - 1_000 } : { hash: 'BlkPast', atMs: deadlineMs + 1_600 }), spent: false });
  w.seed({ deadlineMs: Date.now() - 1_600 });
  await w.tick();
  assert.equal(w.store.get('swap-1')?.status, 'needs_reconciliation', 'the chain had not reached the deadline yet');
  await w.tick();
  assert.equal(w.store.get('swap-1')?.status, 'failed', 'the next refresh did not ask again');
  assert.equal(w.store.get('swap-1')?.result?.reason, 'venue_failed_nothing_moved');
  assert.deepEqual(w.asked, ['dep-1', 'dep-1']);
});

test('the deadline watch asks at most every half minute per row, never about a row a rail is still watching, and hands a late row to the sweep', async () => {
  // A chain still short of a deadline half a minute gone is a node that lags, and it is asked at the
  // usual pace: the next refresh asks again only inside the first half minute.
  const w = world({ block: (deadlineMs) => ({ hash: 'BlkBehind', atMs: deadlineMs - 2_600 }), spent: false });
  w.seed({ deadlineMs: Date.now() - FATE_RECHECK_MS - 10_000 });
  await w.tick();
  await w.tick();
  assert.deepEqual(w.asked, ['dep-1'], `twice in a row is one question; the next is ${FATE_RECHECK_MS / 1000} s on`);
  const answered = world({ block: pastBy(60_000), spent: true });
  answered.seed({ deadlineMs: Date.now() - 10_000 });
  await answered.tick();
  await answered.tick();
  assert.deepEqual(answered.asked, ['dep-1'], 'a chain past the deadline answered, and the next question is half a minute on');

  const railing = world({ block: pastBy(1_000), spent: false });
  railing.seed({ deadlineMs: Date.now() - 20_000, status: 'executing' });
  await railing.tick();
  assert.deepEqual(railing.asked, [], 'an executing row is its rail\'s, and the rail closes it on the same proof');
  assert.equal(railing.store.get('swap-1')?.status, 'executing');

  const late = world({ block: pastBy(1_000), spent: false });
  late.seed({ deadlineMs: Date.now() - RELAY_DEADLINE_GRACE_MS - 3 * 60_000 });
  await late.tick();
  assert.deepEqual(late.asked, [], 'past the deadline, the grace and two minutes, the ten-minute sweep has it');
});

test('a re-check that read the chain before another closed the row does not write the row back open', async () => {
  // The first re-check reads a chain still short of the deadline and waits on its salt read; the
  // second reads the chain past it and closes the row; then the first finishes with "can still run".
  const blocks: FinalBlock[] = [];
  let release: (value: boolean) => void = () => {};
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let salts = 0;
  const w = world({ block: () => blocks.shift() ?? null, spent: false, saltRead: () => (++salts === 1 ? held : Promise.resolve(true)) }, FAILED);
  const deadlineMs = Date.now() - 40_000;
  w.seed({ deadlineMs, reason: 'venue_failed_watching' });
  blocks.push({ hash: 'BlkBehind', atMs: deadlineMs - 2_600 }, { hash: 'BlkPast', atMs: deadlineMs + 31_000 });

  const slow = w.svc.reconcile('swap-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await w.svc.reconcile('swap-1')).status, 'failed', 'the second re-check has the proof');
  release(true);
  assert.equal((await slow).status, 'failed', 'the first hands back the row as it now stands');
  assert.equal(w.store.get('swap-1')?.status, 'failed');
  assert.equal(w.store.get('swap-1')?.result?.reason, 'venue_failed_nothing_moved');
});

// ---------- the rail's own watch ----------

const OWNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const HANDLE = 'q-9f2c41ae.1click.near';
const INTENT_HASH = '44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw';
const ORIGIN = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEST = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const NOW = Date.parse('2026-09-25T19:59:34.000Z');
const DEADLINE = NOW + 3 * 60_000;
const RAIL_NONCE = nonceLiving(NOW + 72 * 3_600_000);

const tokens = {
  eth: {},
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: { USDT: { tokenId: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 } },
  sol: {},
  near: {},
};
const list = [
  { assetId: ORIGIN, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: DEST, decimals: 6, blockchain: 'arb', symbol: 'USDT', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
];
const quote = {
  amountIn: '100000000',
  amountInFormatted: '100.0',
  amountInUsd: '100.00',
  minAmountIn: '100000000',
  amountOut: '99850000',
  amountOutFormatted: '99.85',
  amountOutUsd: '99.84',
  minAmountOut: '99500000',
  timeEstimate: 12,
  depositAddress: HANDLE,
};
const payload = JSON.stringify({
  signer_id: OWNER.toLowerCase(),
  verifying_contract: INTENTS_VERIFIER,
  deadline: iso(NOW + 72 * 3_600_000),
  nonce: RAIL_NONCE,
  intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ORIGIN]: '100000000' } }],
});
const railDraft: SwapDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'base',
  toChain: 'arb',
  fromSymbol: 'USDC',
  toSymbol: 'USDT',
  amountIn: 100,
  amountInExact: '100',
  amountUsd: 100,
  minAmountOut: 99,
  from: OWNER,
  to: OWNER,
  counterparty: INTENTS_NATIVE_COUNTERPARTY,
  quote: null,
};

// The rail on a clock its own sleeps move, over a 1Click that answers `word(now)` and a chain
// whose final block trails that clock by 2.6 s, as it did live on 2026-09-25 (`lagMs` to change it).
// Its polls land 2.75 s past the deadline; a `firstPollMs` of 1 s moves them to 2 s past.
function railOn(opts: { word: (now: number) => string; chainReadable?: boolean; spent: boolean | null; firstPollMs?: number; lagMs?: number }) {
  const clock = { now: NOW };
  const reads: Array<{ at: number; read: string }> = [];
  let filled = false;
  const api = {
    tokens: async () => list,
    quote: async (p: { dry: boolean }) => {
      const s = signQuote({
        quote,
        quoteRequest: { dry: p.dry, originAsset: ORIGIN, destinationAsset: DEST, amount: '100000000', depositType: 'INTENTS', recipientType: 'INTENTS', recipient: OWNER, refundType: 'INTENTS', refundTo: OWNER },
      });
      return { quote: s['quote'] as OneClickQuote, raw: s };
    },
    generateIntent: async () => ({ standard: 'erc191', payload, correlationId: 'c' }),
    submitIntent: async () => ({ intentHash: INTENT_HASH, correlationId: 'c' }),
    status: async () => {
      const word = opts.word(clock.now);
      if (word === 'SUCCESS') filled = true;
      return parseStatus({ status: word });
    },
  };
  const rail = intentsNativeRail({
    keysPath: '/nonexistent',
    quoteKey: TEST_QUOTE_KEY,
    tokens,
    api,
    signer: { address: () => OWNER, signErc191: async () => 'secp256k1:stub' },
    verifierBalance: async (_account: string, asset: string) => (asset === ORIGIN ? 1_000_000_000n : filled ? 99_850_000n : 0n),
    nonceUsed: async (_account, _nonce, at) => {
      reads.push({ at: clock.now, read: `nonce@${at ?? 'final'}` });
      return opts.spent;
    },
    finalBlock: async () => {
      reads.push({ at: clock.now, read: 'block' });
      return opts.chainReadable === false ? null : { hash: `blk-${clock.now}`, atMs: clock.now - (opts.lagMs ?? 2_600) };
    },
    saltValid: async (_salt, at) => {
      reads.push({ at: clock.now, read: `salt@${at ?? 'final'}` });
      return true;
    },
    now: () => clock.now,
    sleepImpl: async (ms: number) => {
      clock.now += ms;
    },
    ...(opts.firstPollMs === undefined ? {} : { firstPollMs: opts.firstPollMs }),
  });
  return { run: () => rail.execute(railDraft, 'p-1', { onEvidence: () => {} }), clock, reads };
}

test('the rail\'s watch closes a swap the chain proves can never run about a minute after its deadline, not at the five-minute timeout', async () => {
  const h = railOn({ word: () => 'PROCESSING', spent: false });
  const out = await h.run();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'venue_failed_nothing_moved');
  assert.match(out.detail, /1click last reported PROCESSING, and the deadline .* passed with the signed transfer never run \(NEAR's final block is stamped/);
  assert.deepEqual(out.txids, [INTENT_HASH]);
  // The final block trails this clock by 2.6 s, so it is past the half-minute floor at the second ask.
  assert.ok(h.clock.now - DEADLINE >= 30_000, `closed ${Math.round((h.clock.now - DEADLINE) / 1000)} s after the deadline, inside the floor`);
  assert.ok(h.clock.now - DEADLINE <= 2 * FATE_RECHECK_MS + 10_000, `closed ${Math.round((h.clock.now - DEADLINE) / 1000)} s after the deadline`);
  assert.ok(h.clock.now < NOW + 5 * 60_000, 'before the watch would have run out');
  assert.ok(h.reads.every((r) => r.at >= DEADLINE), 'the chain is asked nothing before the deadline by this clock');
  assert.ok(h.reads.filter((r) => r.read.startsWith('nonce')).every((r) => r.read.startsWith('nonce@blk-')), 'every nonce read is at the block the clock came from');
  const blocks = h.reads.filter((r) => r.read === 'block').map((r) => r.at);
  assert.ok(blocks.every((at, i) => i === 0 || at - blocks[i - 1]! >= FATE_RECHECK_MS), 'at most every half minute');
});

/* The first poll past the deadline lands inside NEAR's 2.6 s lag about half the time, and reads a
   block short of the deadline: the chain not there yet. Asked again only half a minute on, the
   swap closed 30 to 35 s after its deadline instead of about 5 s. */
test('the rail\'s first question inside NEAR\'s lag is asked again on the next poll, and the swap closes seconds after its deadline', async () => {
  const h = railOn({ word: () => 'PROCESSING', spent: false, firstPollMs: 1_000 });
  const out = await h.run();
  assert.equal(out.reason, 'venue_failed_nothing_moved');
  const blocks = h.reads.filter((r) => r.read === 'block').map((r) => r.at);
  assert.equal(blocks[0]! - DEADLINE, 2_000, 'the first question lands inside the lag');
  assert.deepEqual(blocks.map((at) => at - DEADLINE), [2_000, 7_000], 'asked again a poll later, not half a minute later');
  assert.ok(h.clock.now - DEADLINE <= 10_000, `closed ${Math.round((h.clock.now - DEADLINE) / 1000)} s after the deadline`);
});

test('a chain that stays short of the deadline is asked on every poll for the first half minute only, then every half minute', async () => {
  // A node a minute behind this clock: every block it gives is short of the deadline for a minute.
  const h = railOn({ word: () => 'PROCESSING', spent: false, lagMs: 60_000 });
  const out = await h.run();
  assert.equal(out.reason, 'venue_failed_nothing_moved');
  const blocks = h.reads.filter((r) => r.read === 'block').map((r) => r.at - DEADLINE);
  assert.ok(blocks.filter((at) => at < FATE_RECHECK_MS).length <= FATE_RECHECK_MS / 5_000 + 1, `asked ${blocks.length} times in the first half minute`);
  const later = blocks.filter((at) => at >= FATE_RECHECK_MS);
  assert.ok(later.length > 0);
  assert.ok(later.every((at, i) => at - (i === 0 ? blocks[blocks.length - later.length - 1]! : later[i - 1]!) >= FATE_RECHECK_MS), `asked at ${blocks.join(', ')} ms past the deadline`);
});

test('a FAILED that lands after the deadline on a transfer that can never run ends the swap as nothing moved, not as still watching', async () => {
  // Past the half minute both clocks need, the ask the FAILED brings is the one that proves it.
  const h = railOn({ word: (now) => (now < DEADLINE + 30_000 ? 'PROCESSING' : 'FAILED'), spent: false });
  const out = await h.run();
  assert.equal(out.reason, 'venue_failed_nothing_moved');
  assert.match(out.detail, /1click last reported FAILED/);
  // Inside it, nothing can be proved yet: the row stays open for the deadline watch to close.
  const soon = railOn({ word: (now) => (now < DEADLINE ? 'PROCESSING' : 'FAILED'), spent: false });
  assert.equal((await soon.run()).reason, 'venue_failed_watching');
});

test('while the chain cannot say, the rail\'s watch runs as it did: to its timeout, still checking', async () => {
  const h = railOn({ word: () => 'PROCESSING', chainReadable: false, spent: false });
  const out = await h.run();
  assert.equal(out.reason, 'stuck_unknown');
  assert.ok(h.clock.now >= NOW + 5 * 60_000 - 5_000, 'the whole five minutes');
});

test('a SUCCESS after the deadline on a transfer that ran settles exactly as before', async () => {
  const h = railOn({ word: (now) => (now < DEADLINE + 20_000 ? 'PROCESSING' : 'SUCCESS'), spent: true });
  const out = await h.run();
  assert.equal(out.ok, true);
  assert.match(out.detail, /^swapped 100 USDC for 99\.85 USDT inside intents\.near, read back from the verifier/);
});
