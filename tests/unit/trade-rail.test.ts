// The trade rail through the proposal service: propose -> engine verdict -> execute.
//
// The engine is not touched. The one figure it reads is what the plan puts at stake, and the
// click threshold applied to that figure is the only wall. Under it a plan executes with
// decidedBy policy; above it a person clicks. A change that only takes risk off lands without
// the engine at all, and a cancel on an open plan is refused before anyone is asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Policy, Proposal, ProposalService, RiskRow, TradeDraft } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { createProposalService } from '../../src/proposals.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { tradeRail } from '../../src/trade/rail.ts';
import type { TradeDeps } from '../../src/trade/rail.ts';
import { planHash, validatePlanInput } from '../../src/trade/plan.ts';
import type { PlanInput } from '../../src/trade/plan.ts';
import type { PlanRow } from '../../src/trade/plans.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const NOW = 1_786_492_800_000;

/* A runner that keeps its rows in memory and records what it was asked. The real one is
   proven in runner-host.test.ts; this file is about the door in front of it. */
function fakeRunner() {
  const rows = new Map<string, PlanRow>();
  const calls: string[] = [];
  let seq = 0;
  const runner: TradeDeps['runner'] & { rows: Map<string, PlanRow>; calls: string[] } = {
    rows,
    calls,
    get: (id) => rows.get(id) ?? null,
    plans: () => [...rows.values()],
    draw(input: PlanInput, by: string | null) {
      seq += 1;
      const id = `pl_${seq}`;
      const row: PlanRow = { id, ...input, status: 'idea', hash: planHash({ id, ...input }), cloids: {}, gen: 0, by, createdAt: 'x', updatedAt: 'x' };
      rows.set(id, row);
      return row;
    },
    async arm(row) {
      calls.push(`arm ${row.id} ${row.proposalId ?? 'no-proposal'}`);
      rows.set(row.id, { ...row, status: 'waiting' });
      return { ok: true };
    },
    async change(id, c) {
      calls.push(`change ${id} ${JSON.stringify(c)}`);
      const row = rows.get(id);
      if (row !== undefined) {
        if (c.stop !== undefined) row.stop = c.stop;
        if (c.target !== undefined) row.target = c.target;
      }
      return { ok: true, detail: 'changed' };
    },
    async cancel(id) {
      calls.push(`cancel ${id}`);
      return { ok: true, detail: 'cancelled' };
    },
    async close(id, bps) {
      calls.push(`close ${id} ${bps}`);
      return { ok: true, detail: 'closed' };
    },
  };
  return runner;
}

function seededPolicy(clickUsd = 100): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist();
  p.outbound.humanClickAboveUsd = clickUsd;
  p.sentences = renderSentences(p);
  return p;
}


// A propose or an approve answers with the row as it stands, `executing` while the rail runs.
// The tests here are about where the row lands, so they wait for it.
async function landed(h: { svc: ProposalService }, reply: Promise<Proposal>): Promise<Proposal> {
  return h.svc.settled((await reply).id, 5000);
}

function setup(over: { clickUsd?: number; kill?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-trade-rail-'));
  const cfg: AppConfig = {
    mode: 'live',
    port: 4177,
    addresses: { evm: '0x1111111111111111111111111111111111111111' },
    candleProducts: ['ETH-USD'],
    dataDir,
    keysPath: '/tmp/phosphor-trade-rail-keys.json',
  };
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const ledger: Ledger = {
    snapshot: () => snapshot,
    intents: () => undefined,
    refresh: async () => snapshot,
    hyperliquid: () => undefined,
  };
  const policy = seededPolicy(over.clickUsd);
  if (over.kill === true) policy.killSwitch = true;
  savePolicy(dataDir, policy);
  const runner = fakeRunner();
  const trade: TradeDeps = {
    runner,
    meta: () => ({ assetId: 3, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    now: () => NOW,
  };
  const rail = tradeRail(trade);
  const svc = createProposalService({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    ledger,
    riskRows,
    rails: { for: (draft) => (draft.kind === 'trade' ? (rail as never) : null), kinds: () => ['trade'] },
    trade,
    dataDir,
  });
  return { svc, runner };
}

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { symbol: 'ETH', side: 'long', sizeUsd: 300, leverage: 5, entry: { type: 'market' }, stop: 92, target: 110, ...over };
}

function openRow(runner: ReturnType<typeof fakeRunner>, over: Partial<PlanRow> = {}): PlanRow {
  const parsed = validatePlanInput(plan(), NOW);
  assert.ok(parsed.ok);
  const row: PlanRow = {
    id: 'pl_open',
    ...parsed.plan,
    status: 'open',
    hash: 'h',
    cloids: { entry: 'a', stop: 'b', target: 'c' },
    gen: 1,
    risk: { marginUsd: 60, maxLossUsd: 24.3, stopSlipUsd: 30, entryRef: 100, liquidationPx: 82, notionalUsd: 300, amountUsd: 60 },
    fillPx: 100,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
  runner.rows.set(row.id, row);
  return row;
}

test('a plan with $60 of margin under a $100 threshold executes with decidedBy policy', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeTrade({ plan: plan(), by: 'agent-1' }));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  assert.equal(p.decidedBy, 'policy');
  const draft = p.draft as TradeDraft;
  assert.equal(draft.kind, 'trade');
  assert.equal(draft.op, 'open');
  if (draft.op !== 'open') return;
  assert.equal(draft.amountUsd, 60, 'max(margin, max loss) is what the engine read');
  assert.equal(draft.hash, planHash(draft.plan), 'the draft carries the whole plan and its hash');
  assert.equal(h.runner.calls[0], `arm ${draft.plan.id} ${p.id}`, 'the rail arms the plan under the proposal id');
  assert.equal(h.runner.get(draft.plan.id)?.status, 'waiting');
  assert.match(p.simulation?.summary ?? '', /Long ETH: \$300\.00 notional at 5x, \$60\.00 of collateral at stake/);
  assert.match(p.simulation?.summary ?? '', /No other plan is waiting/);
});

test('a plan with $150 of margin lands pending, and nothing is armed until a person clicks', async () => {
  const h = setup();
  const p = await h.svc.proposeTrade({ plan: plan({ sizeUsd: 750 }) });
  assert.equal(p.status, 'pending');
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.deepEqual(h.runner.calls, []);
  // The idea stays drawn while the human decides, so the card and the chart are one object.
  assert.equal(h.runner.plans().length, 1);
  assert.equal(h.runner.plans()[0]?.status, 'idea');
});

test('a drawn plan arms by id, keeping the id, and a plan that is not an idea is refused', async () => {
  const h = setup();
  const parsed = validatePlanInput(plan(), NOW);
  assert.ok(parsed.ok);
  const drawn = h.runner.draw(parsed.plan, 'agent-1');
  const p = await landed(h, h.svc.proposeTrade({ planId: drawn.id }));
  assert.equal(p.status, 'executed');
  assert.equal((p.draft as Extract<TradeDraft, { op: 'open' }>).plan.id, drawn.id);
  const again = await h.svc.proposeTrade({ planId: drawn.id });
  assert.equal(again.status, 'policy_refused');
  assert.match(again.verdict.reasons.join(' '), /already waiting/);
});

test('a plan the risk rules refuse never reaches the engine', async () => {
  const h = setup();
  const p = await h.svc.proposeTrade({ plan: plan({ stop: 105 }) });
  assert.equal(p.status, 'policy_refused');
  assert.match(p.verdict.reasons.join(' '), /stop/);
  const bad = await h.svc.proposeTrade({ plan: plan({ leverage: 26 }) });
  assert.match(bad.verdict.reasons.join(' '), /25x/);
  const shape = await h.svc.proposeTrade({ plan: plan({ recipient: '0xabc' }) });
  assert.equal(shape.status, 'policy_refused');
  assert.match(shape.verdict.reasons.join(' '), /recipient/);
});

test('a change that tightens the stop is amountUsd 0 and lands executed without a click', async () => {
  const h = setup({ clickUsd: 0 });
  openRow(h.runner);
  const p = await landed(h, h.svc.proposeTradeChange({ id: 'pl_open', stop: 95 }));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  assert.equal(p.decidedBy, 'policy');
  assert.equal((p.draft as TradeDraft).amountUsd, 0);
  assert.equal(h.runner.calls[0], 'change pl_open {"stop":95}');
  assert.match(p.simulation?.summary ?? '', /Stop 92 becomes 95/);
  assert.match(p.simulation?.summary ?? '', /tighter, so no wall applies/);
});

test('a change that widens the stop is priced like a new plan and waits above the threshold', async () => {
  const h = setup({ clickUsd: 10 });
  openRow(h.runner);
  const p = await h.svc.proposeTradeChange({ id: 'pl_open', stop: 85 });
  assert.equal(p.status, 'pending');
  const draft = p.draft as Extract<TradeDraft, { op: 'change' }>;
  assert.ok(draft.amountUsd > 0);
  assert.ok(draft.after.maxLossUsd > draft.before.maxLossUsd);
  assert.deepEqual(h.runner.calls, []);
});

test('a cancel on an open plan is refused at propose, and on a placed plan it lands free', async () => {
  const h = setup({ clickUsd: 0 });
  openRow(h.runner);
  const refused = await h.svc.proposeTradeChange({ id: 'pl_open', cancel: true });
  assert.equal(refused.status, 'policy_refused');
  assert.match(refused.verdict.reasons.join(' '), /open/);
  assert.deepEqual(h.runner.calls, []);

  openRow(h.runner, { id: 'pl_placed', status: 'placed' });
  const ok = await landed(h, h.svc.proposeTradeChange({ id: 'pl_placed', cancel: true }));
  assert.equal(ok.status, 'executed');
  assert.equal((ok.draft as TradeDraft).amountUsd, 0);
  assert.equal(h.runner.calls[0], 'cancel pl_placed');
});

test('a close is free at the wall and goes through the plan bound', async () => {
  const h = setup({ clickUsd: 1000 });
  openRow(h.runner);
  const p = await landed(h, h.svc.proposeTradeChange({ id: 'pl_open', close: true }));
  assert.equal(p.status, 'executed');
  // A reduce-only close takes risk off, so it charges nothing (B4, 2026-09-23).
  assert.equal((p.draft as TradeDraft).amountUsd, 0);
  assert.equal(h.runner.calls[0], 'close pl_open 30');
  const notOpen = await h.svc.proposeTradeChange({ id: 'pl_open', close: true, cancel: true });
  assert.equal(notOpen.status, 'policy_refused');
  assert.match(notOpen.verdict.reasons.join(' '), /one change at a time/);
});

test('the kill switch refuses even a change that takes risk off', async () => {
  const h = setup({ kill: true });
  openRow(h.runner);
  const p = await h.svc.proposeTradeChange({ id: 'pl_open', stop: 95 });
  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'kill_switch');
  assert.deepEqual(h.runner.calls, []);
});

test('without a trading surface every trade proposal refuses by name', async () => {
  const h = setup();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-trade-rail-none-'));
  savePolicy(dataDir, seededPolicy());
  const svc = createProposalService({
    cfg: { mode: 'demo', port: 4177, addresses: {}, candleProducts: [], dataDir, keysPath: '/tmp/none' },
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    ledger: { snapshot: () => loadDemoLedger(), intents: () => undefined, refresh: async () => loadDemoLedger(), hyperliquid: () => undefined },
    riskRows,
    dataDir,
  });
  const p = await svc.proposeTrade({ plan: plan() });
  assert.equal(p.status, 'policy_refused');
  assert.match(p.verdict.reasons.join(' '), /no trading surface/);
  assert.deepEqual(h.runner.calls, []);
});

// ---------- a retried plan does not arm twice (A.F3) ----------
//
// A lost reply or a transient-looking error brings the same plan back. Without a guard each
// call draws a fresh id and arms its own bracket: two positions, double margin, one coin. The
// second identical propose is refused, and the refusal names the plan that is already live.
test('two identical proposeTrade calls arm one plan; the second is refused and names the first', async () => {
  const h = setup();
  const first = await landed(h, h.svc.proposeTrade({ plan: plan(), by: 'agent-1' }));
  assert.equal(first.status, 'executed', JSON.stringify(first.verdict));
  const firstPlanId = h.runner.calls.find((c) => c.startsWith('arm '))?.split(' ')[1];
  assert.ok(firstPlanId, 'the first plan armed');

  const second = await landed(h, h.svc.proposeTrade({ plan: plan(), by: 'agent-1' }));
  assert.equal(second.status, 'policy_refused', JSON.stringify(second.verdict));
  assert.equal(second.verdict.outcome, 'refuse');
  assert.match(second.verdict.reasons.join(' '), new RegExp(String(firstPlanId)));

  const armed = [...h.runner.rows.values()].filter((r) => r.status === 'waiting' || r.status === 'placed' || r.status === 'open');
  assert.equal(armed.length, 1, `one armed plan, not ${armed.length}`);
  assert.equal(h.runner.calls.filter((c) => c.startsWith('arm ')).length, 1, 'arm ran once');
});

test('a different plan on a coin that already has a live one is refused at propose: one plan per coin', async () => {
  const h = setup();
  const first = await landed(h, h.svc.proposeTrade({ plan: plan(), by: 'agent-1' }));
  assert.equal(first.status, 'executed', JSON.stringify(first.verdict));
  const firstId = [...h.runner.rows.values()].find((r) => r.status === 'waiting')?.id ?? '';
  for (const other of [plan({ sizeUsd: 400 }), plan({ side: 'short', stop: 110, target: 90 })]) {
    const p = await landed(h, h.svc.proposeTrade({ plan: other, by: 'agent-1' }));
    assert.equal(p.status, 'policy_refused', JSON.stringify(p.verdict));
    assert.match(JSON.stringify(p.verdict), new RegExp(`already has a live plan \\(${firstId}\\)`));
  }
  const armed = [...h.runner.rows.values()].filter((r) => r.status === 'waiting');
  assert.equal(armed.length, 1, 'the first plan alone holds the coin');
  // Another coin is its own.
  const btc = await landed(h, h.svc.proposeTrade({ plan: plan({ symbol: 'BTC' }), by: 'agent-1' }));
  assert.equal(btc.status, 'executed', JSON.stringify(btc.verdict));
});
