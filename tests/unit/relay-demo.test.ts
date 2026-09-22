// The demo swap walks the relay's words. Demo mode is where the card, the agent's narration and
// the anxiety harness see a swap without real money, so a demo swap has to show the stages a
// real relay swap shows (PENDING, TX_BROADCASTED, SETTLED, then the balance), stall where a
// real one stalls (at the match), and leave the history reading the intent hash first and the
// NEAR hash with its link, the way src/transactions.ts reads a live relay row.
//
// Run: node --test tests/unit/relay-demo.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig, LedgerSnapshot, Proposal, Rail, SwapDraft, WriteDraft } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { ProposalStage } from '../../src/proposals/view.ts';
import { DEMO_DEADLINE_ENV, DEMO_EXPLORER, demoRails, demoStallSweep } from '../../src/rails/demo.ts';
import type { DemoKnobs } from '../../src/rails/demo.ts';
import { demoAssetOf, demoHolding, loadDemoLedger, loadDemoReads, resetDemoBalances } from '../../src/ledger/demo.ts';
import { buildTransactions } from '../../src/transactions.ts';
import { floorUnderQuote } from '../../src/rails/slippage.ts';
import { makeCtx, SELF_EVM } from './helpers/proposals.ts';

function cfgFor(mode: 'live' | 'demo'): AppConfig {
  return { mode, port: 4177, addresses: { evm: SELF_EVM }, candleProducts: [], dataDir: '/tmp/phosphor-relay-demo-cfg', keysPath: '/tmp/phosphor-relay-demo-keys.json' };
}

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

function demoHarness(knobs: Partial<DemoKnobs> = {}, cfg: Partial<AppConfig> = {}): ReturnType<typeof makeCtx> {
  const ledger = demoLedger();
  const registry = demoRails({ cfg: cfgFor('demo'), refresh: () => ledger.refresh(), knobs: { stageScale: 0.05, stall: false, deadlineSec: null, providerEnd: null, hold: false, ...knobs } });
  const rails = registry.kinds().map((kind) => registry.for({ kind } as WriteDraft) as Rail);
  // The service's cfg decides the venue proposeSwap stamps; the demo rail walks what it is
  // handed. The proposal service reads mode, addresses and the swap switch off cfg and nothing
  // else, so the paths in it never matter here.
  return makeCtx({ rails, deps: { ledger, cfg: { ...cfgFor('live'), ...cfg } } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const SWAP = { chain: 'near' as const, toChain: 'near' as const, fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: 2, minAmountOut: 0.4 };

test('a demo swap walks the relay words and lands confirmed with the balance moved', async () => {
  resetDemoBalances();
  const h = demoHarness();
  const near = demoAssetOf('wNEAR');
  assert.ok(near !== null);
  const nearBefore = demoHolding(near.assetId)?.amount ?? 0;

  const filed = await h.svc.proposeSwap(SWAP);
  assert.equal(filed.draft.kind === 'swap' ? filed.draft.venue : '', 'intents-relay');
  assert.equal(filed.simulation?.swap?.priceGoodForSec, 60, 'the card gets the one-minute fact as a field');
  const stages = await watchStages(h, filed.id, 5_000);
  assert.deepEqual(stages, ['submitting', 'PENDING', 'TX_BROADCASTED', 'SETTLED', 'crediting', 'confirmed']);

  const row = h.svc.get(filed.id) as Proposal;
  const view = h.svc.view(row);
  assert.equal(row.status, 'executed');
  assert.equal(view.terminal, true);
  assert.equal(view.txs.length, 2);
  assert.equal(view.txs[0].leg, 'intent');
  assert.equal(view.txs[1].explorer?.startsWith(DEMO_EXPLORER), true);
  assert.equal(typeof row.result?.evidence?.nonce, 'string');
  assert.equal(typeof row.result?.evidence?.deadline, 'string');
  assert.equal(row.result?.evidence?.handle, row.result?.txids?.[0], 'the handle is the intent hash');
  assert.ok((demoHolding(near.assetId)?.amount ?? 0) > nearBefore, 'the fixture credited the bought coin');

  // The history reads the relay row the way it reads a live one: the intent hash first, then
  // the NEAR settlement with its link.
  const entries = buildTransactions({ proposals: [row], events: [], selfAddresses: [SELF_EVM] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hashes[0].kind, 'intent');
  assert.equal(entries[0].hashes[1].kind, 'chain');
  assert.equal(entries[0].hashes[1].place, 'near');
  resetDemoBalances();
});

test('the stall knob stops a demo swap at PENDING and the deadline is what moves the row', async () => {
  resetDemoBalances();
  const h = demoHarness({ stall: true, deadlineSec: 1 });
  const near = demoAssetOf('wNEAR');
  assert.ok(near !== null);
  const nearBefore = demoHolding(near.assetId)?.amount ?? 0;

  const filed = await h.svc.proposeSwap(SWAP);
  const settled = await h.svc.settled(filed.id, 5_000);
  assert.equal(settled.status, 'needs_reconciliation');
  assert.equal(h.svc.view(settled).stage, 'PENDING');
  assert.equal(h.svc.view(settled).waitingOn, 'NEAR Intents');

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
  assert.equal(demoHolding(near.assetId)?.amount ?? 0, nearBefore, 'nothing credited');
  resetDemoBalances();
});

test('a demo swap under swap.rail oneclick still walks the 1Click words', async () => {
  resetDemoBalances();
  const h = demoHarness({}, { swap: { rail: 'oneclick' } });
  const filed = await h.svc.proposeSwap(SWAP);
  assert.equal(filed.draft.kind === 'swap' ? filed.draft.venue : '', 'intents-native');
  assert.equal(filed.simulation?.swap?.priceGoodForSec, null);
  const stages = await watchStages(h, filed.id, 5_000);
  assert.deepEqual(stages, ['submitting', 'KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS', 'crediting', 'confirmed']);
  resetDemoBalances();
});

/* THE FLOOR COMES OFF THE QUOTE (frozen rule 2). A swap proposed with no minAmountOut takes
   its floor from the rail's own floor-free price, one percent under, cut toward zero at six
   significant figures, and the row carries that floor before anyone sees it. A pair nobody
   prices is refused, never floored at zero. Before 2026-09-21 the tool required a floor from
   the agent, which sized it off a market price: the guess the rule forbids. */
test('a swap proposed without a floor takes one percent under the rail\'s own quote, and no price is a refusal', async () => {
  resetDemoBalances();
  const h = demoHarness();
  await h.ledger.refresh();
  const { minAmountOut: _named, ...noFloor } = SWAP;
  const filed = await h.svc.proposeSwap(noFloor);
  const draft = filed.draft as SwapDraft;
  assert.ok(draft.minAmountOut > 0, `the app set a floor: ${draft.minAmountOut}`);
  const registry = demoRails({ cfg: cfgFor('demo'), refresh: async () => {}, knobs: { stageScale: 0.05, stall: false, deadlineSec: null, providerEnd: null, hold: false } });
  const priced = await registry.for(draft)!.quote!(draft);
  assert.ok(priced !== null && priced > 0);
  assert.equal(draft.minAmountOut, floorUnderQuote(priced), 'the floor is one percent under the rail\'s quote, cut');
  assert.ok(draft.minAmountOut < priced && draft.minAmountOut > priced * 0.985);
  assert.notEqual(filed.status, 'policy_refused', JSON.stringify(filed.verdict));

  const unpriced = await h.svc.proposeSwap({ ...noFloor, toSymbol: 'XYZ' });
  assert.equal(unpriced.status, 'policy_refused');
  assert.match(unpriced.verdict.reasons.join(' '), /Nobody offered a price for USDC to XYZ right now, so no floor could be set/);
  assert.equal((unpriced.draft as SwapDraft).minAmountOut, 0, 'nothing was signed or floored');
});
