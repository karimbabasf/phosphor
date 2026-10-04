// The click on a withdrawal once the vault has moved to the chip (PHASE2-PLAN.md P2.8). Every
// signature a withdrawal makes is a Hyperliquid owner action with a Touch ID of its own, so the
// click approves it and opens nothing: the one dialog the person sees is the one that names the
// send, its amount and where it goes. A kind key wallet keeps its approval touch exactly as
// before, and so does any move that spends from the intents balance, which needs the session.
//
// The proposal service is the app's own over a live-mode ledger (tests/unit/helpers/proposals.ts),
// the withdrawal rail is the real one with every remote faked, and the vault is a real keystore
// whose touch is played by hand (tests/unit/helpers/owner-touch.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSentences } from '../../src/policy/render.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { chipVault, teardown, withdrawWorld } from './helpers/owner-touch.ts';
import { makeCtx, railThat, seededPolicy } from './helpers/proposals.ts';

const [V] = DERIVED_VECTORS;

test.afterEach(teardown);

async function withdrawalOn(moved: boolean) {
  const v = chipVault(V.old, { moved });
  await v.attach();
  const world = withdrawWorld(v.keysPath);
  const h = makeCtx({ rails: [world.rail], deps: { vault: v.relay, keystore: v.store } });
  const proposed = await h.svc.proposeHlWithdraw({ amount: 8 });
  assert.equal(proposed.status, 'pending', `${proposed.status}: ${proposed.verdict.outcome === 'refuse' ? proposed.verdict.reasons.join('; ') : ''}`);
  return { v, world, h, proposed };
}

test('kind chip: approving a withdrawal asks for no approval touch, and its one Touch ID is the send\'s', async () => {
  const { v, world, h, proposed } = await withdrawalOn(true);
  const clicked = await h.svc.approve(proposed.id);
  assert.notEqual(clicked.status, 'awaiting_touch', 'the click is the approval');
  assert.equal(clicked.decidedBy, 'human');
  assert.equal(v.store.state(), 'locked', 'and it opened nothing');

  const asked = await v.shell.answer();
  assert.equal(asked.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 1, 'one dialog for the whole withdrawal');
  assert.ok(!v.shell.asked.some((r) => r.id.startsWith('approve:')), 'never an approval touch');
  assert.equal(world.posts.length, 1);
  assert.equal(v.store.state(), 'locked');
  assert.ok(h.audit.tail(80).some((e) => e.msg.includes('Touch ID asks at each owner signature')));
});

test('kind chip: cancelling the send\'s Touch ID ends the withdrawal as the person saying no, with nothing sent', async () => {
  const { v, world, h, proposed } = await withdrawalOn(true);
  await h.svc.approve(proposed.id);
  await v.shell.answer({ cancel: true });
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'failed');
  assert.equal(done.result?.reason, 'declined');
  assert.match(done.result?.detail ?? '', /Touch ID was cancelled, so nothing was signed\. Nothing was sent\./);
  assert.equal(world.posts.length, 0);
  assert.equal(h.svc.view(done).reason?.code, 'declined');
  assert.equal(h.svc.view(done).reason?.sentence, 'You said no. Nothing moved.');
});

test('kind key: approving a withdrawal asks for the approval touch, as before', async () => {
  const { v, world, h, proposed } = await withdrawalOn(false);
  const clicked = await h.svc.approve(proposed.id);
  assert.equal(clicked.status, 'awaiting_touch');
  assert.match(v.relay.waiting()?.reason ?? '', /^Approve: Withdraw 8 USDC out of Hyperliquid/);
  const asked = await v.shell.answer({ cancel: true });
  assert.equal(asked.id, `approve:${proposed.id}`);
  await h.svc.settle(5_000);
  assert.equal(h.store.get(proposed.id)?.status, 'pending', 'a cancelled approval touch puts it back');
  assert.equal(world.posts.length, 0);
});

test('kind chip: a deposit still asks for its approval touch, which opens the allowance it spends from', async () => {
  const v = chipVault(V.old);
  await v.attach();
  const policy = seededPolicy();
  policy.outbound.humanClickAboveUsd = 1;
  policy.sentences = renderSentences(policy);
  const h = makeCtx({
    rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'scripted' }))],
    policy,
    deps: { vault: v.relay, keystore: v.store },
  });
  const proposed = await h.svc.proposeHlDeposit({ amount: 10 });
  assert.equal(proposed.status, 'pending', proposed.verdict.outcome === 'refuse' ? proposed.verdict.reasons.join('; ') : proposed.status);
  const clicked = await h.svc.approve(proposed.id);
  assert.equal(clicked.status, 'awaiting_touch');
  assert.match(v.relay.waiting()?.reason ?? '', /^Approve: Move 10 USDC into Hyperliquid/);
  await v.shell.answer({ cancel: true });
  await h.svc.settle(5_000);
  assert.equal(h.store.get(proposed.id)?.status, 'pending');
});
