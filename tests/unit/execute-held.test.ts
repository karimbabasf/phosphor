// The held state: a rail whose preflight said hold signed nothing, and the executor keeps the
// row approved and runs the rail again on its own until the checks clear or the hold runs out.
//
// The hold is a status, never a question. Nothing here asks a person anything: the row says
// what it is waiting for, the retry is the app's, and the row that runs out of time fails
// with the reason and the audit line that says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Preflight, Proposal, RailResult } from '../../src/types.ts';
import { HELD_MAX_MS, HELD_RETRY_MS } from '../../src/proposals/execute.ts';
import { reconcileOnBoot } from '../../src/proposals/reconcile.ts';
import { landed, makeCtx, railThat } from './helpers/proposals.ts';

function preflightOf(verdict: Preflight['verdict'], at = new Date().toISOString()): Preflight {
  return {
    at,
    checks: [
      { id: 'gas', label: 'Arbitrum gas', state: verdict === 'ok' ? 'ok' : 'fail', value: verdict === 'ok' ? '145,392 / 300,000' : '300,024 / 300,000', detail: 'the sweep', series: [145_392], limit: 300_000 },
      { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: '29.3x', detail: 'fine' },
      { id: 'venue', label: 'Venue answering', state: 'ok', value: '120 ms', detail: 'fine' },
      { id: 'balance', label: 'Balance', state: 'ok', value: '50 USDC', detail: 'fine' },
      { id: 'deadline', label: 'Quote still valid', state: 'ok', value: '10 min', detail: 'fine' },
    ],
    verdict,
    ...(verdict === 'hold' ? { holdReason: 'Waiting for Arbitrum gas to settle' } : {}),
  };
}

function held(): RailResult {
  const preflight = preflightOf('hold');
  return { ok: false, held: true, detail: `${preflight.holdReason}. Nothing was signed.`, preflight };
}

async function until(read: () => Proposal | undefined, done: (p: Proposal) => boolean, ms = 3000): Promise<Proposal> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const p = read();
    if (p !== undefined && done(p)) return p;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the row did not reach the state in ${ms} ms: ${JSON.stringify(read()?.status)}`);
}

test('the defaults: a retry every thirty seconds for fifteen minutes', () => {
  assert.equal(HELD_RETRY_MS, 30_000);
  assert.equal(HELD_MAX_MS, 15 * 60_000);
});

test('a held rail leaves the row approved with heldSince and the checks on it, signs nothing, and is retried until it clears', async () => {
  let runs = 0;
  const signed: string[] = [];
  const rail = railThat('hl_deposit', async (_draft, _id, hooks) => {
    runs += 1;
    if (runs === 1) {
      const result = held();
      hooks?.onPreflight?.(result.preflight!);
      return result;
    }
    const preflight = preflightOf('ok');
    hooks?.onPreflight?.(preflight);
    signed.push('SIG');
    return { ok: true, detail: 'funded', txids: ['intent-h1'], preflight };
  });
  const h = makeCtx({ rails: [rail], deps: { held: { retryMs: 10, maxMs: 5_000 } } });
  const first = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(first.status, 'approved', 'a held row stays approved');
  assert.ok(typeof first.heldSince === 'string' && Date.parse(first.heldSince) > 0, 'heldSince is stamped');
  assert.equal(first.preflight?.length, 1);
  assert.equal(first.preflight?.[0]?.verdict, 'hold');
  assert.equal(first.preflight?.[0]?.holdReason, 'Waiting for Arbitrum gas to settle');
  assert.equal(signed.length, 0, 'nothing was signed while held');
  assert.equal(first.result, undefined, 'a held row carries no result: nothing happened');
  assert.ok(h.eventTypes().includes('execution_held'), h.eventTypes().join(', '));
  assert.ok(!h.eventTypes().includes('execution_failed'));
  // Held money is committed money: the day's budget holds it while it waits.
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10, 'a held row counts against the cap');

  const done = await until(() => h.store.get(first.id), (p) => p.status === 'executed');
  assert.equal(runs, 2, 'the rail ran again on its own');
  assert.equal(signed.length, 1);
  assert.equal(done.preflight?.length, 2, 'every attempt appends its checks');
  assert.equal(done.preflight?.[1]?.verdict, 'ok');
  assert.equal(done.heldSince, undefined, 'the hold is over once the row moves on');
  assert.deepEqual(done.result?.txids, ['intent-h1']);
  const types = h.eventTypes();
  assert.ok(types.indexOf('execution_held') < types.indexOf('executed'));
  await h.svc.settle(2000);
});

test('a hold that runs out fails cleanly with the reason and an execution_held_expired line, and never signs', async () => {
  let runs = 0;
  const rail = railThat('hl_deposit', async (_draft, _id, hooks) => {
    runs += 1;
    const result = held();
    hooks?.onPreflight?.(result.preflight!);
    return result;
  });
  const h = makeCtx({ rails: [rail], deps: { held: { retryMs: 5, maxMs: 40 } } });
  const first = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(first.status, 'approved');
  const failed = await until(() => h.store.get(first.id), (p) => p.status === 'failed');
  assert.ok(runs >= 2, `the rail was retried (${runs} runs)`);
  assert.match(failed.result?.detail ?? '', /Waiting for Arbitrum gas to settle/);
  assert.match(failed.result?.detail ?? '', /Nothing was signed/);
  assert.deepEqual(failed.result?.txids ?? [], []);
  assert.equal(failed.preflight?.length, runs, 'every attempt is on the row');
  assert.ok(typeof failed.settledAt === 'string');
  assert.ok(h.eventTypes().includes('execution_held_expired'), h.eventTypes().join(', '));
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 0, 'a failed hold charges nothing');
  const runsAtFail = runs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runs, runsAtFail, 'no retry runs after the row failed');
});

test('a rail that fails its preflight outright lands failed at once with the checks on the row', async () => {
  const preflight: Preflight = { ...preflightOf('fail'), holdReason: 'The balance inside NEAR Intents does not cover this move' };
  const rail = railThat('hl_deposit', async (_draft, _id, hooks) => {
    hooks?.onPreflight?.(preflight);
    return { ok: false, held: false, detail: `${preflight.holdReason}. Nothing was signed.`, preflight };
  });
  const h = makeCtx({ rails: [rail] });
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'failed');
  assert.equal(p.heldSince, undefined);
  assert.equal(p.preflight?.length, 1);
  assert.match(p.result?.detail ?? '', /does not cover/);
  assert.ok(h.eventTypes().includes('execution_failed'));
});

test('the boot sweep closes a row that was held when the app stopped: nothing was signed, so it fails rather than waits on a venue', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => held())], deps: { held: { retryMs: 60_000, maxMs: 120_000 } } });
  const first = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(first.status, 'approved');
  const moved = reconcileOnBoot({ store: h.store, audit: h.audit, notify: () => {} } as never);
  assert.equal(moved.length, 1);
  const row = h.store.get(first.id)!;
  assert.equal(row.status, 'failed');
  assert.match(row.result?.detail ?? '', /Nothing was signed/);
  assert.ok(h.eventTypes().includes('execution_held_expired'));
});
