// The demo money rail, and the one thing it must never be: reachable on mainnet.
//
// Demo mode used to refuse every money proposal, so the live pending state (the stage clock,
// the agent's narration, a row going late) could only be seen with real money on a real chain.
// These walk it instead: a deposit that passes through every stage a real rail reports and
// lands confirmed with the fixture's balances moved, the same deposit stopped at PROCESSING so
// the deadline is what decides it, and a mainnet boot that holds none of this whatever the
// environment says.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Proposal, Rail, WriteDraft } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { ProposalStage } from '../../src/proposals/view.ts';
import {
  DEMO_DEADLINE_ENV,
  DEMO_EXPLORER,
  DEMO_HELD_MAX_ENV,
  DEMO_HELD_RETRY_ENV,
  DEMO_HOLD_ENV,
  DEMO_PROVIDER_END_ENV,
  DEMO_STAGE_SCALE_ENV,
  DEMO_STALL_ENV,
  demoHeldTiming,
  demoKnobs,
  demoRails,
  demoStallSweep,
  isDemoRail,
} from '../../src/rails/demo.ts';
import type { DemoKnobs } from '../../src/rails/demo.ts';
import { createRails } from '../../src/rails/index.ts';
import {
  demoAvailableUsdc,
  demoHolding,
  loadDemoLedger,
  loadDemoReads,
  resetDemoBalances,
} from '../../src/ledger/demo.ts';
import { makeCtx, SELF_EVM } from './helpers/proposals.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

function cfgFor(mode: 'live' | 'demo'): AppConfig {
  return {
    mode,
    port: 4177,
    addresses: { evm: SELF_EVM },
    candleProducts: [],
    dataDir: '/tmp/phosphor-demo-rail-cfg',
    keysPath: '/tmp/phosphor-demo-rail-keys.json',
  };
}

// The fixture's own reads, re-run on every refresh so a demo move shows, and the listeners the
// executor settles a row on. The same shape src/ledger/index.ts builds for demo mode.
function demoLedger(): Ledger {
  let reads = loadDemoReads();
  let snapshot: LedgerSnapshot = loadDemoLedger();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => snapshot,
    intents: () => reads.intents,
    hyperliquid: () => reads.hyperliquid,
    refresh: async () => {
      reads = loadDemoReads();
      snapshot = { ...snapshot, fetchedAt: new Date().toISOString() };
      for (const fn of [...listeners]) fn();
      return snapshot;
    },
    onRefresh: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// A service over the demo rails and the demo ledger, with the stage timer wound right down.
function demoHarness(knobs: Partial<DemoKnobs> = {}, held?: { retryMs: number; maxMs: number }): { h: ReturnType<typeof makeCtx>; ledger: Ledger } {
  const ledger = demoLedger();
  const registry = demoRails({
    cfg: cfgFor('demo'),
    refresh: () => ledger.refresh(),
    knobs: { stageScale: 0.05, stall: false, deadlineSec: null, providerEnd: null, hold: false, ...knobs },
  });
  const rails = registry.kinds().map((kind) => registry.for({ kind } as WriteDraft) as Rail);
  const h = makeCtx({ rails, deps: { ledger, ...(held === undefined ? {} : { held }) } });
  return { h, ledger };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every stage the row passed through, in order, with repeats collapsed: what a card watching
// this proposal would have printed.
async function watchStages(h: ReturnType<typeof makeCtx>, id: string, forMs: number): Promise<ProposalStage[]> {
  const seen: ProposalStage[] = [];
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    const row = h.svc.get(id);
    if (row !== undefined) {
      const stage = h.svc.view(row).stage;
      if (seen[seen.length - 1] !== stage) seen.push(stage);
      if (stage === 'confirmed') break;
    }
    await sleep(15);
  }
  return seen;
}

test('a demo deposit walks every stage a real one reports and lands confirmed', async () => {
  resetDemoBalances();
  const { h } = demoHarness();
  const usdcBefore = demoHolding(USDC)?.amount ?? 0;
  const collateralBefore = demoAvailableUsdc();

  const filed = await h.svc.proposeHlDeposit({ amount: 25 });
  const stages = await watchStages(h, filed.id, 5_000);

  // The path KIND_STAGES.hl_deposit names, in order: the money starts inside the verifier, so
  // there is no PENDING_DEPOSIT, and "Deposit seen" comes first (criterion 8.4).
  assert.deepEqual(stages, [
    'submitting',
    'KNOWN_DEPOSIT_TX',
    'PROCESSING',
    'SUCCESS',
    'crediting',
    'confirmed',
  ]);

  const view = h.svc.view(h.svc.get(filed.id) as Proposal);
  assert.equal(view.terminal, true);
  assert.equal(view.waitingOn, null);
  assert.notEqual(view.settledAt, null);
  assert.equal(h.svc.get(filed.id)?.status, 'executed');

  // The fee is the rail's, the figures on the card are the rail's, and the link goes nowhere a
  // person could mistake for a chain.
  const credited = 25 - (0.3 + (25 * 25) / 10_000);
  assert.equal(view.money.amountOut, String(credited));
  assert.equal(view.txs.length, 2);
  assert.equal(view.txs[0].leg, 'intent');
  assert.equal(view.txs[1].explorer?.startsWith(DEMO_EXPLORER), true);
  assert.equal(view.txs.every((t) => t.running === false), true);
  assert.match(view.correlationId ?? '', /^demo-/);

  // And the money the fixture serves moved, so `wallet` reads the move back.
  assert.equal(Math.abs((demoHolding(USDC)?.amount ?? 0) - (usdcBefore - 25)) < 1e-9, true);
  assert.equal(Math.abs(demoAvailableUsdc() - (collateralBefore + credited)) < 1e-9, true);
  resetDemoBalances();
});

test('the stall knob stops the walk at PROCESSING and the deadline is what moves the row', async () => {
  resetDemoBalances();
  const { h } = demoHarness({ stall: true, deadlineSec: 1 });
  const collateralBefore = demoAvailableUsdc();

  const filed = await h.svc.proposeHlDeposit({ amount: 25 });
  const settled = await h.svc.settled(filed.id, 5_000);
  assert.equal(settled.status, 'needs_reconciliation');
  assert.equal(h.svc.view(settled).stage, 'PROCESSING');
  assert.equal(h.svc.view(settled).waitingOn, 'The transfer');

  // The clock the demo stall sweep hands markStalled, built from the same knob the rail read.
  const sweep = demoStallSweep(cfgFor('demo'), { [DEMO_DEADLINE_ENV]: '1' });
  assert.notEqual(sweep, null);
  const until = Date.now() + 5_000;
  while (Date.now() < until && h.svc.view(h.svc.get(filed.id) as Proposal).stage !== 'stalled') {
    h.svc.markStalled((sweep as { now: () => number }).now());
    await sleep(200);
  }

  const view = h.svc.view(h.svc.get(filed.id) as Proposal);
  assert.equal(view.stage, 'stalled');
  assert.equal(view.stageLabel, 'Late, nothing has changed');
  assert.equal(view.error?.code, 'deadline_passed');
  // A stall is a statement about the clock and never about the money: nothing credited.
  assert.equal(h.svc.get(filed.id)?.status, 'needs_reconciliation');
  assert.equal(demoAvailableUsdc(), collateralBefore);
  resetDemoBalances();
});

test('a mainnet boot holds no demo rail and reads no demo knob, whatever the environment says', () => {
  const env = { [DEMO_STAGE_SCALE_ENV]: '0.01', [DEMO_STALL_ENV]: '1', [DEMO_DEADLINE_ENV]: '5' };
  const live = cfgFor('live');

  assert.deepEqual(demoKnobs(live, env), { stageScale: 1, stall: false, deadlineSec: null, providerEnd: null, hold: false });
  assert.equal(demoHeldTiming(live, { [DEMO_HELD_RETRY_ENV]: '1', [DEMO_HELD_MAX_ENV]: '2' }), null);
  assert.equal(demoStallSweep(live, env), null);
  assert.throws(() => demoRails({ cfg: live, refresh: async () => undefined }), /demo mode only/);

  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8'));
  const stubTrade = {
    runner: {
      get: () => null,
      plans: () => [],
      draw: () => {
        throw new Error('unused');
      },
      arm: async () => ({ ok: false as const, reason: 'stub' }),
      change: async () => ({ ok: true, detail: 'stub' }),
      cancel: async () => ({ ok: true, detail: 'stub' }),
      close: async () => ({ ok: true, detail: 'stub' }),
    },
    meta: () => null,
    mark: () => null,
    free: () => null,
  };
  const registry = createRails({ cfg: live, tokens, trade: stubTrade });
  assert.equal(registry.kinds().length > 0, true);
  for (const kind of registry.kinds()) {
    assert.equal(isDemoRail(registry.for({ kind } as WriteDraft)), false, `${kind} on mainnet is a demo rail`);
  }

  // And the same environment IS read in demo mode, so the test above is about the mode and not
  // about the variables being ignored everywhere.
  assert.deepEqual(demoKnobs(cfgFor('demo'), env), { stageScale: 0.01, stall: true, deadlineSec: 5, providerEnd: null, hold: false });
  assert.deepEqual(demoKnobs(cfgFor('demo'), { [DEMO_PROVIDER_END_ENV]: 'refunded', [DEMO_HOLD_ENV]: 'yes' }), {
    stageScale: 1,
    stall: false,
    deadlineSec: null,
    providerEnd: 'REFUNDED',
    hold: true,
  });
  assert.deepEqual(demoHeldTiming(cfgFor('demo'), { [DEMO_HELD_RETRY_ENV]: '1', [DEMO_HELD_MAX_ENV]: '2' }), { retryMs: 1000, maxMs: 2000 });
  assert.equal(demoHeldTiming(cfgFor('demo'), {}), null);
});

// ---------- the Hyperliquid exit, and the seams the anxiety harness screenshots ----------

test('a demo withdrawal walks the same words as a deposit, sits in crediting until NEAR Intents shows it, and debits the activation fee', async () => {
  resetDemoBalances();
  const { h } = demoHarness();
  const usdcBefore = demoHolding(USDC)?.amount ?? 0;
  const collateralBefore = demoAvailableUsdc();

  const filed = await h.svc.proposeHlWithdraw({ amount: 20 });
  assert.equal(filed.status, 'pending', 'a withdrawal always waits for the click');
  await h.svc.approve(filed.id);
  const stages = await watchStages(h, filed.id, 5_000);
  assert.deepEqual(stages, ['submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'crediting', 'confirmed']);

  const row = h.svc.get(filed.id) as Proposal;
  const view = h.svc.view(row);
  assert.equal(row.status, 'executed');
  assert.equal(row.pocket?.venue, 'intents');
  assert.equal(view.stageLabel, 'Confirmed');
  // The nonce the send signed with reaches the row with the first word, so a process that dies
  // polling still has what the sweep asks the venue by (criterion 8.5).
  assert.match(row.result?.evidence?.nonce ?? '', /^\d{13}$/);
  assert.match(row.result?.evidence?.handle ?? '', /^demo-/);

  const received = 20 - (0.2 + (20 * 25) / 10_000);
  assert.equal(Math.abs((demoHolding(USDC)?.amount ?? 0) - (usdcBefore + received)) < 1e-9, true, 'the intents balance rose by what lands');
  assert.equal(Math.abs(demoAvailableUsdc() - (collateralBefore - 21)) < 1e-9, true, 'the venue account fell by the amount plus the 1 USDC activation fee');
  resetDemoBalances();
});

test('the demo simulations carry the same fee facts the live rails do, so the card shows the fee and the floor before the click', async () => {
  resetDemoBalances();
  const { h } = demoHarness();
  // Over the click threshold, so both wait for a person and nothing walks: the facts are read
  // off the simulation the card draws before the click.
  const deposit = await h.svc.proposeHlDeposit({ amount: 150 });
  assert.equal(deposit.status, 'pending');
  const dep = deposit.simulation?.send;
  assert.ok(dep !== undefined, 'the deposit carries send facts');
  assert.equal(dep.feeUsd, 0.675);
  assert.equal(dep.arrives, dep.arrivesAtLeast, 'the floor in both slots, as the live rails do');
  assert.equal(dep.arrivesAtLeast, String(deposit.draft.kind === 'hl_deposit' ? deposit.draft.minCredited : NaN));
  assert.match(deposit.simulation?.summary ?? '', /app fee   0\.3750 USDC, 25 bp, inside the quote/);
  await h.svc.refuse(deposit.id);

  const withdraw = await h.svc.proposeHlWithdraw({ amount: 20 });
  const wd = withdraw.simulation?.send;
  assert.ok(wd !== undefined, 'the withdrawal carries send facts');
  // 0.2 flat plus 25 bp of 20 inside the quote, plus 1 USDC the venue takes on top.
  assert.equal(wd.feeUsd, 1.25);
  assert.equal(wd.arrives, wd.arrivesAtLeast);
  assert.equal(wd.arrivesAtLeast, String(withdraw.draft.kind === 'hl_withdraw' ? withdraw.draft.minReceived : NaN));
  assert.match(wd.activity, /1 USDC on top/);
  assert.match(withdraw.simulation?.summary ?? '', /activation 1 USDC on top/);
  await h.svc.refuse(withdraw.id);
  resetDemoBalances();
});

test('a demo deposit under the floor is refused before anything, with the floor named (criterion 8.7)', async () => {
  resetDemoBalances();
  const { h } = demoHarness();
  const filed = await h.svc.proposeHlDeposit({ amount: 2 });
  assert.equal(filed.status, 'policy_refused');
  const view = h.svc.view(filed);
  assert.equal(view.stage, 'refused');
  assert.match(filed.simulation?.summary ?? '', /below the 7 USDC floor/);
  assert.match(filed.simulation?.summary ?? '', /under 5 USDC, it is lost/);
  assert.equal(filed.result, undefined, 'nothing ran');
  resetDemoBalances();
});

test('a demo withdrawal the account cannot fund is refused before any quote, with the most that could come back in the sentence (criterion 8.6)', async () => {
  resetDemoBalances();
  const { h } = demoHarness();
  const available = demoAvailableUsdc();
  const filed = await h.svc.proposeHlWithdraw({ amount: available });
  assert.equal(filed.status, 'policy_refused');
  assert.match(filed.simulation?.summary ?? '', /plus the 1 USDC activation fee/);
  assert.match(filed.simulation?.summary ?? '', new RegExp(`The most that can come back now is ${String(Math.floor((available - 1) * 1e6) / 1e6).replace('.', '\\.')} USDC`));
  resetDemoBalances();
});

test('the preflight hold seam sends a deposit back to approved with the five checks on it, nothing walked, and the executor retries it', async () => {
  resetDemoBalances();
  const { h } = demoHarness({ hold: true }, { retryMs: 60, maxMs: 200 });
  const collateralBefore = demoAvailableUsdc();
  const filed = await h.svc.proposeHlDeposit({ amount: 25 });
  await sleep(30);
  const held = h.svc.get(filed.id) as Proposal;
  assert.equal(held.status, 'approved');
  assert.notEqual(held.heldSince, undefined);
  assert.equal(held.preflight?.length, 1);
  assert.equal(held.preflight?.[0].verdict, 'hold');
  assert.equal(held.preflight?.[0].checks.length, 5);
  assert.equal(held.preflight?.[0].holdReason, 'Waiting for Arbitrum gas to settle');
  assert.equal(held.result, undefined, 'a hold leaves no result: nothing was signed');
  // Retried until the hold outlives its cap, then closed with the reason and still nothing moved.
  const until = Date.now() + 3_000;
  while (Date.now() < until && h.svc.get(filed.id)?.status !== 'failed') await sleep(20);
  const closed = h.svc.get(filed.id) as Proposal;
  assert.equal(closed.status, 'failed');
  assert.match(closed.result?.detail ?? '', /without clearing, so it is closed/);
  assert.equal(closed.preflight !== undefined && closed.preflight.length >= 2, true, 'each retry appended its checks');
  assert.equal(demoAvailableUsdc(), collateralBefore);
  resetDemoBalances();
});

for (const end of ['FAILED', 'REFUNDED'] as const) {
  test(`the ${end} seam ends a deposit on the router's own word, with the handle kept and the fixture untouched`, async () => {
    resetDemoBalances();
    const { h } = demoHarness({ providerEnd: end });
    const usdcBefore = demoHolding(USDC)?.amount ?? 0;
    const collateralBefore = demoAvailableUsdc();
    const filed = await h.svc.proposeHlDeposit({ amount: 25 });
    const settled = await h.svc.settled(filed.id, 5_000);
    const view = h.svc.view(settled);
    assert.equal(view.stage, end);
    assert.equal(view.terminal, true);
    assert.equal(view.error?.code, end === 'FAILED' ? 'provider_failed' : 'refunded');
    assert.match(settled.result?.evidence?.handle ?? '', /^demo-/);
    assert.equal(settled.result?.evidence?.refundedAmount, end === 'FAILED' ? '0' : '25');
    assert.equal(demoHolding(USDC)?.amount ?? 0, usdcBefore);
    assert.equal(demoAvailableUsdc(), collateralBefore);
    resetDemoBalances();
  });
}
