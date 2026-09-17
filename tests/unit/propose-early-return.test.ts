// A propose answers with the row as it stands, and the rail keeps running behind it.
//
// The incident of 2026-09-15: "deposit $10" moved $20. The propose held its HTTP reply open
// for the whole rail (43 s that day, up to five minutes by the watch loop's budget), the
// proxy gave up at 30 s and told the agent the app was not running, the agent proposed again,
// and both were under the click threshold. The reply must never outlive the proxy's patience:
// the row is `executing` on disk the moment the rail starts, and that row is an answer. Whoever
// wants the settled row waits for it with a cap, and reads proposal_status past that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, Signer } from '../../src/types.ts';
import { PROPOSE_REPLY_CAP_MS } from '../../src/http/propose.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
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

test('the reply cap sits under the proxy budget', () => {
  assert.equal(PROPOSE_REPLY_CAP_MS, 20_000);
});

test('a propose that is still executing past the cap says so and where to read the answer', async () => {
  const executing = row({ result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['h1'], evidence: { handle: 'dep1' } } });
  const h = makeHttp({ proposals: serviceThatAnswers(executing) });
  const reply = await h.post('hl_deposit', { amount: 10 });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.status, 'executing');
  assert.equal(reply.json.next, 'executing: read proposal_status until it settles');
  assert.deepEqual(reply.json.result, executing.result, 'the hash the venue already holds rides on the reply');
  assert.equal('draft' in reply.json, false, 'the draft and its resolved addresses stay off the wire');
});

test('a propose that settled carries the rail sentence, so "failed" never arrives without its "do not send again"', async () => {
  const unconfirmed = row({
    status: 'needs_reconciliation',
    result: { ok: false, detail: '1click reported FAILED and refunded 0 so far; the input is held by 1Click under handle dep1', txids: ['h1'] },
  });
  const h = makeHttp({ proposals: serviceThatAnswers(row({}), unconfirmed) });
  const reply = await h.post('hl_deposit', { amount: 10 });
  assert.equal(reply.json.status, 'needs_reconciliation');
  assert.match(String((reply.json.result as { detail: string }).detail), /held by 1Click under handle dep1/);
  assert.equal(reply.json.next, undefined);
});

test('a rail that outlives the reply cap answers with the executing row and settles later', async () => {
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

/* A consolidate is a fund move, not a rail, and it kept holding the reply: its legs and two
   balance re-reads ran inline, so a three-leg move could pass the proxy's thirty seconds the
   same way the rail did on 2026-09-15. It runs behind the executing row now, on the same
   inflight map, so the propose cap, the settled wait and the shutdown drain all cover it. */
test('a fund move whose legs outlive the reply cap answers with the executing row and settles later', async () => {
  const waiting: Array<() => void> = [];
  const signer: Signer = {
    ready: true,
    describe: () => 'a signer that waits for the test',
    send: (leg) => new Promise((resolve) => waiting.push(() => resolve({ ok: true, txid: `0x${leg.fromChain}` }))),
  };
  const policy = defaultPolicy();
  // Every cap out of the way: the four USDT legs total near twenty thousand dollars, and the
  // question here is the clock, not the budget.
  policy.outbound = { ...policy.outbound, maxPerTransactionUsd: 1e6, maxPerSessionUsd: 1e6, humanClickAboveUsd: 1e6, autoApproveDailyUsd: 1e6, destinationAllowlist: venueAllowlist() };
  policy.sentences = renderSentences(policy);
  const h = makeCtx({ policy, deps: { signer } });

  const started = Date.now();
  const reply = await h.svc.proposeConsolidate({ toChain: 'base', symbol: 'USDT' });
  assert.ok(reply.draft.kind === 'consolidate' && reply.draft.legs.length >= 3, `this needs three legs to mean anything, got ${JSON.stringify(reply.verdict)}`);
  assert.equal(reply.status, 'executing', JSON.stringify(reply.verdict));
  const current = await h.svc.settled(reply.id, 50);
  assert.equal(current.status, 'executing', 'the first leg is still out');
  assert.ok(Date.now() - started < 1000, 'the propose and the capped wait both answered at once');
  assert.ok(h.svc.sessionSpentUsd() > 0, 'the budget is charged while the legs run');
  assert.equal(await h.svc.settle(50), false, 'and the shutdown drain knows a move is still out');

  // Release the legs one at a time: each one lands on the row before the next is signed.
  while (waiting.length > 0 || (h.store.get(reply.id)?.result?.txids?.length ?? 0) < reply.draft.legs.length) {
    const release = waiting.shift();
    if (release !== undefined) release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const done = await h.svc.settled(reply.id, 5000);
  assert.equal(done.status, 'executed');
  assert.equal(done.result?.txids?.length, reply.draft.legs.length);
  assert.equal(await h.svc.settle(2000), true);
});
