// A swap's reads run outside the spend queue, and the queue still holds the money rules.
//
// Every propose ran whole inside the one-at-a-time queue, network reads included: a swap's
// balance read and quotes took seconds, and any approve, refuse or second propose that arrived
// meanwhile waited behind them (R5 B2, up to 8 s behind a send). The reads are harmless to run
// side by side; what has to be one step is deciding and reserving, because five concurrent
// $10,000 moves once went through against a $25,000 cap, each reading a spend of zero. These
// tests hold both halves: the reads overlap, the decisions do not, and the cap still holds.
//
// Run: node --test tests/unit/swap-queue.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Rail, RailResult, SwapSpend } from '../../src/types.ts';
import { loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { makeCtx, railThat, seededPolicy } from './helpers/proposals.ts';

// A swap rail whose floor-setting price waits on a gate the test opens, and which counts how
// many of those reads are running at once.
function gatedRail() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let running = 0;
  let most = 0;
  let started = 0;
  const base = railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'swapped', txids: ['h'] }));
  const rail: Rail = {
    ...base,
    async spend(): Promise<SwapSpend> {
      return { assetId: 'nep141:usdt.tether-token.near', decimals: 6, heldBase: 10n ** 15n };
    },
    async quote() {
      started += 1;
      running += 1;
      most = Math.max(most, running);
      await gate;
      running -= 1;
      return 10_000;
    },
    async simulate() {
      return { ok: true, summary: 'priced', swap: { receives: '10000', receivesAtLeast: '9900', feeUsd: 1, etaSeconds: 12 } };
    },
  };
  return { rail, open: () => open(), most: () => most, started: () => started };
}

async function until(check: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

// Every limit out of the way but the ones a test sets.
function openPolicy() {
  const policy = seededPolicy();
  policy.outbound.maxPerTransactionUsd = 10_000;
  policy.outbound.maxPerSessionUsd = 25_000;
  policy.outbound.humanClickAboveUsd = 1_000_000;
  policy.outbound.autoApproveDailyUsd = 1_000_000;
  return policy;
}

const SWAP = { chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: '10000' };

test('two swap proposes read the venue side by side instead of one queued behind the other', async () => {
  const g = gatedRail();
  const h = makeCtx({ rails: [g.rail], policy: openPolicy(), intentsUsdc: 100_000 });
  const a = h.svc.proposeSwap(SWAP);
  const b = h.svc.proposeSwap({ ...SWAP, amountIn: '9000' });
  assert.ok(await until(() => g.started() === 2), `the second read waited for the first: ${g.started()} started`);
  assert.equal(g.most(), 2);
  g.open();
  const [pa, pb] = await Promise.all([a, b]);
  assert.notEqual(pa.status, 'policy_refused', JSON.stringify(pa.verdict));
  assert.notEqual(pb.status, 'policy_refused', JSON.stringify(pb.verdict));
  await h.svc.settle(2_000);
});

test('five concurrent $10,000 swaps with their reads overlapping still cannot pass a $25,000 day between them', async () => {
  const g = gatedRail();
  const h = makeCtx({ rails: [g.rail], policy: openPolicy(), intentsUsdc: 100_000 });
  const pending = [1, 2, 3, 4, 5].map(() => h.svc.proposeSwap(SWAP));
  assert.ok(await until(() => g.started() === 5), `only ${g.started()} reads started`);
  g.open();
  const rows = await Promise.all(pending);
  const moved = rows.filter((p) => p.status === 'executing' || p.status === 'executed').reduce((sum, p) => sum + (p.draft.kind === 'swap' ? p.draft.amountUsd : 0), 0);
  assert.ok(moved <= 25_000, `moved $${moved} against a $25,000 day`);
  assert.equal(moved, 20_000, 'two fit, the third would pass the cap');
  const refused = rows.filter((p) => p.status === 'policy_refused');
  assert.equal(refused.length, 3);
  for (const p of refused) assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'max_per_session');
  assert.equal(h.svc.view(refused[0]!).reason?.code, 'over_daily_cap');
  await h.svc.settle(2_000);
});

test('an approve lands while a swap propose is still waiting on its price', async () => {
  const g = gatedRail();
  const h = makeCtx({ rails: [g.rail], policy: openPolicy(), intentsUsdc: 100_000 });
  const change = await h.svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 60 } }, sentence: 'Ask me above $60.' });
  assert.equal(change.status, 'pending');
  const swap = h.svc.proposeSwap(SWAP);
  assert.ok(await until(() => g.started() === 1));

  const approved = await Promise.race([h.svc.approve(change.id), new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 1_000))]);
  assert.notEqual(approved, 'held', 'the approve waited behind the swap price');
  assert.equal(h.svc.get(change.id)?.status, 'executed');

  g.open();
  await swap;
  await h.svc.settle(2_000);
});

test('a kill switch turned on while a swap waits on its price refuses it: the decision reads the policy of that moment', async () => {
  const g = gatedRail();
  const h = makeCtx({ rails: [g.rail], policy: openPolicy(), intentsUsdc: 100_000 });
  const swap = h.svc.proposeSwap(SWAP);
  assert.ok(await until(() => g.started() === 1));
  const policy = loadPolicy(h.dataDir);
  assert.ok(policy !== null);
  savePolicy(h.dataDir, { ...policy, killSwitch: true });
  g.open();
  const p = await swap;
  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'kill_switch');
  assert.equal(h.svc.view(p).reason?.code, 'kill_switch');
});
