// A propose answers on the decision, and the rail keeps running behind it.
//
// Two incidents, one rule. 2026-09-15: "deposit $10" moved $20, because the propose held its
// HTTP reply open for the whole rail (43 s that day, up to five minutes by the watch loop's
// budget), the proxy gave up at 30 s and told the agent the app was not running, and the agent
// proposed again. 2026-09-18: the reply then waited up to twenty seconds, so the card in the
// conversation arrived that long after the call and the window showed nothing while the money
// moved. The reply now waits for nothing at all: the row is `executing` on disk the moment the
// rail starts, it carries the view the card draws, and proposal_status has the settled amount.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal } from '../../src/types.ts';
import { makeCtx, railThat, slowRail } from './helpers/proposals.ts';
import { makeHttp, serviceThatAnswers } from './helpers/http.ts';

function row(over: Partial<Proposal>): Proposal {
  return {
    id: 'p-1',
    kind: 'hl_deposit',
    createdAt: new Date().toISOString(),
    status: 'executing',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10 } as unknown as Proposal['draft'],
    simulation: { ok: true, summary: 'fine' },
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    decidedBy: 'policy',
    ...over,
  };
}

/* THE ASK THIS FILE EXISTS FOR (Karim, 2026-09-18, ask 1): the card has to be on the window when
   the agent's call comes back, not when the venue is finished with it. So the door's reply lands
   while the rail is still out, and it carries the view the card draws. */
test('the reply lands while the rail is still out, carrying the view the card draws', async () => {
  const slow = slowRail('hl_deposit');
  const ctx = makeCtx({ rails: [slow.rail] });
  const h = makeHttp({ proposals: ctx.svc, dataDir: ctx.dataDir });
  const started = Date.now();
  const reply = await h.post('hl_deposit', { amount: 10 });
  const answeredMs = Date.now() - started;
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.equal(reply.json.status, 'executing');
  assert.ok(answeredMs < 1_000, `the reply waited ${answeredMs} ms for a rail that has not answered`);

  const view = reply.json.view as { id: string; stage: string; stageLabel: string; terminal: boolean; waitingOn: string | null };
  assert.equal(view.id, reply.json.id, 'the view is this row');
  assert.equal(view.terminal, false);
  assert.ok(view.stageLabel.length > 0, 'the card has a line to print');
  assert.ok(view.waitingOn, 'and it says what is being waited on');

  slow.release({ ok: true, detail: 'done', txids: ['h1'] });
  await ctx.svc.settle(5_000);
  assert.equal(ctx.store.get(String(reply.json.id))?.status, 'executed', 'the rail settles the row behind the reply');
});

/* No "read proposal_status" hint rides on it any more: the reply already carries the view, and
   the hint sent the agent on a read it did not need (R3, 2026-09-23). */
test('an executing reply carries the view and the evidence, and no hint to go and read again', async () => {
  const executing = row({ result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['h1'], evidence: { handle: 'dep1' } } });
  const h = makeHttp({ proposals: serviceThatAnswers(executing) });
  const reply = await h.post('hl_deposit', { amount: 10 });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.status, 'executing');
  assert.equal(reply.json.next, undefined);
  assert.ok(reply.json.view !== undefined, 'the view is on the reply');
  assert.deepEqual(reply.json.result, executing.result, 'the hash the venue already holds rides on the reply');
  assert.equal('draft' in reply.json, false, 'the draft and its resolved addresses stay off the wire');
});

/* A row that is already terminal when the reply goes out: a rail that refused on the spot, or a
   client key replayed onto a move that has since landed unconfirmed. Its sentence rides along,
   because "failed" without "do not send this again" reads to an agent as a cue to retry. */
test('a terminal reply carries the rail sentence, so "failed" never arrives without its "do not send again"', async () => {
  const unconfirmed = row({
    status: 'needs_reconciliation',
    result: { ok: false, detail: '1click reported FAILED and refunded 0 so far; the input is held by 1Click under handle dep1', txids: ['h1'] },
  });
  const h = makeHttp({ proposals: serviceThatAnswers(unconfirmed) });
  const reply = await h.post('hl_deposit', { amount: 10 });
  assert.equal(reply.json.status, 'needs_reconciliation');
  assert.match(String((reply.json.result as { detail: string }).detail), /held by 1Click under handle dep1/);
  assert.equal(reply.json.next, undefined);
});

test('a rail that outlives the reply answers with the executing row and settles later', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  const started = Date.now();
  const reply = await h.svc.proposeHlDeposit({ amount: 10 });
  assert.equal(reply.status, 'executing');
  assert.equal(reply.decidedBy, 'policy');
  const current = await h.svc.settled(reply.id, 50);
  assert.equal(current.status, 'executing');
  assert.ok(Date.now() - started < 1000, 'the propose and the capped wait both answered at once');
  assert.equal(h.svc.sessionSpentUsd(), 10, 'the budget is charged while the rail runs');

  slow.release({ ok: true, detail: 'done', txids: ['h1'] });
  const done = await h.svc.settled(reply.id, 5000);
  assert.equal(done.status, 'executed');
  assert.deepEqual(done.result?.txids, ['h1']);
});

test('a rail that answers at once is settled by the time the propose returns', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done', txids: ['h2'] }))] });
  const reply = await h.svc.proposeHlDeposit({ amount: 10 });
  const done = await h.svc.settled(reply.id, 5000);
  assert.equal(done.status, 'executed');
});

test('a rail that throws lands a terminal row and never leaves the wait hanging', async () => {
  const h = makeCtx({
    rails: [
      railThat('hl_deposit', async () => {
        throw new Error('socket hang up');
      }),
    ],
  });
  const reply = await h.svc.proposeHlDeposit({ amount: 10 });
  const done = await h.svc.settled(reply.id, 5000);
  assert.equal(done.status, 'failed');
  assert.match(done.result?.detail ?? '', /rail threw: socket hang up/);
});

test('settled on a row that was never executing returns it as it is', async () => {
  const h = makeCtx({ intentsUsdc: 1000, rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done' }))] });
  const reply = await h.svc.proposeHlDeposit({ amount: 500 });
  assert.equal(reply.status, 'pending', JSON.stringify(reply.verdict));
  const same = await h.svc.settled(reply.id, 5000);
  assert.equal(same.status, 'pending');
  await assert.rejects(() => h.svc.settled('no-such-id', 10), /unknown proposal/);
});

test('the shutdown drain waits for a rail that is still running', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  await h.svc.proposeHlDeposit({ amount: 10 });
  assert.equal(await h.svc.settle(100), false, 'the rail is still out, so the drain has not finished');
  slow.release({ ok: true, detail: 'done', txids: ['h3'] });
  assert.equal(await h.svc.settle(2000), true);
});
