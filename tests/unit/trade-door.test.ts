// The two doors onto a plan, attacked: the human's (/api/trade/action) and the agent's
// (/api/mcp, and the propose path behind it).
//
// The claim in src/http/trade.ts is that the human door is unreachable from the agent's door
// because the function is not wired to it, and the claim in src/proposals/trade.ts is that the
// agent's own changes (a new exit, a cancel, a close) go through the policy like any write.
// Neither claim is a check that could be wrong; both are absences, and an absence is proven by
// asking for the thing every way it could be asked for and reading the refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootChartServer } from '../fixtures/chart-server.ts';
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
import { createEndedNotices } from '../../src/http/ended.ts';
import type { Chat } from '../../src/http/context.ts';
import type { DriverState } from '../../src/driver.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const NOW = 1_786_492_800_000;

const VERBS = ['cancel', 'close', 'flatten'] as const;

// ---------- the human door ----------

test('the human door refuses anything that is not the window: no token, a bad token, a foreign origin', async () => {
  const h = await bootChartServer();
  try {
    const bare = await h.post('/api/trade/action', { action: 'flatten' });
    assert.equal(bare.status, 403);
    assert.match(String(bare.json.error), /token/);

    // The agent's identity on the wire is a session, a client name and the seat secret. None
    // of them is the token, and presenting all three changes nothing.
    const agentShaped = await h.post('/api/trade/action', {
      action: 'flatten',
      session: 'an-agent',
      client: 'phosphor-mcp',
      secret: 'a'.repeat(64),
      op: 'view',
    });
    assert.equal(agentShaped.status, 403);

    const wrong = await h.post('/api/trade/action', { action: 'close', id: 'pl_1', token: 'b'.repeat(48) });
    assert.equal(wrong.status, 403);

    const foreign = await h.post('/api/trade/action', { action: 'flatten', token: h.token }, { origin: 'http://evil.test' });
    assert.equal(foreign.status, 403);
    assert.match(String(foreign.json.error), /cross-origin/);

    const rejected = h.audit.tail(50).filter((e) => e.type === 'approve_attempt_rejected');
    assert.ok(rejected.length >= 3, 'every bad token is a line in the log');
    for (const e of rejected) {
      assert.equal(typeof (e.data as { tokenPresent?: unknown }).tokenPresent, 'boolean');
      assert.ok(!JSON.stringify(e).includes('b'.repeat(48)), 'the supplied token itself never enters the log');
    }
    assert.equal(h.audit.tail(50).some((e) => e.msg.startsWith('human:')), false, 'a refused request was logged as the human');
  } finally {
    await h.close();
  }
});

test('the human door takes exactly three verbs, and one that lands is logged as the human', async () => {
  const h = await bootChartServer();
  try {
    for (const action of ['disarm', 'approve', 'arm', 'trade_cancel', '', 'FLATTEN']) {
      const res = await h.post('/api/trade/action', { action, token: h.token });
      assert.equal(res.status, 400, `${action} was not refused`);
      assert.match(String(res.json.error), /unknown action/);
      assert.match(String(res.json.error), /cancel, close, flatten/);
    }

    // The fixture's trade service has no venue, so the verb reaches the service and comes back
    // refused. What this asserts is the path: the door dispatched, and wrote the human's line.
    const flat = await h.post('/api/trade/action', { action: 'flatten', token: h.token });
    assert.equal(flat.status, 400);
    assert.equal(flat.json.error, 'no venue in this test');
    assert.equal(flat.json.detail, 'no venue in this test');
    const lines = h.audit.tail(20);
    assert.ok(lines.some((e) => e.type === 'tool_call' && e.msg === 'human: flatten'));
  } finally {
    await h.close();
  }
});

// ---------- the agent's door ----------

/* Every op /api/mcp knows, asked for every verb the human door has, plus the token in the body
   in case the door read one. Every answer is a refusal that names the op or the tool as
   unknown, and the human's line is never written. This is the in-process half of the claim
   tests/injection.test.ts makes against the real app. */
test('cancel, close and flatten are absent from every op on /api/mcp, with or without the token', async () => {
  const h = await bootChartServer();
  try {
    const attempts: Array<Record<string, unknown>> = [];
    for (const verb of VERBS) {
      attempts.push(
        { op: 'trade_action', action: verb, id: 'pl_1', token: h.token },
        { op: verb, id: 'pl_1', token: h.token },
        { op: 'read', tool: verb, args: { id: 'pl_1' }, token: h.token },
        { op: 'read', tool: `trade_${verb}`, args: { id: 'pl_1' } },
        { op: 'view', tool: verb, args: { id: 'pl_1' }, token: h.token },
        { op: 'view', tool: `trade_${verb}`, args: { id: 'pl_1' } },
        { op: 'propose', kind: verb, params: { id: 'pl_1' }, token: h.token },
        { op: 'propose', kind: `trade_${verb}`, params: { id: 'pl_1' } },
      );
    }
    for (const attempt of attempts) {
      const res = await h.mcp(attempt);
      assert.equal(res.status, 400, `${JSON.stringify(attempt)} answered ${res.status}: ${JSON.stringify(res.json)}`);
      assert.match(String(res.json.error), /unknown (op|read tool|view tool|propose kind)/, JSON.stringify(res.json));
    }
    const lines = h.audit.tail(200);
    assert.equal(lines.some((e) => e.msg.startsWith('human:')), false, 'the agent door wrote the human\'s line');
    assert.equal(lines.some((e) => e.type === 'executed'), false);
  } finally {
    await h.close();
  }
});

// ---------- the agent's changes, behind the policy ----------

/* A runner that keeps its rows in memory and records what it was asked, the same shape
   tests/unit/trade-rail.test.ts uses. This file is about who may ask, not about the runner. */
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
      calls.push(`arm ${row.id}`);
      rows.set(row.id, { ...row, status: 'waiting' });
      return { ok: true };
    },
    async change(id, c) {
      calls.push(`change ${id} ${JSON.stringify(c)}`);
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

function seededPolicy(clickUsd: number): Policy {
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

function setup(clickUsd: number) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-trade-door-'));
  const cfg: AppConfig = {
    mode: 'live',
    port: 4177,
    addresses: { evm: '0x1111111111111111111111111111111111111111' },
    candleProducts: ['ETH-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const ledger: Ledger = {
    snapshot: () => snapshot,
    intents: () => undefined,
    refresh: async () => snapshot,
    hyperliquid: () => undefined,
  };
  savePolicy(dataDir, seededPolicy(clickUsd));
  const runner = fakeRunner();
  const trade: TradeDeps = {
    runner,
    meta: () => ({ assetId: 3, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    now: () => NOW,
  };
  const rail = tradeRail(trade);
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    rails: { for: (draft) => (draft.kind === 'trade' ? (rail as never) : null), kinds: () => ['trade'] },
    trade,
    dataDir,
  });
  return { svc, runner, dataDir, store, audit };
}

const PLAN = { symbol: 'ETH', side: 'long', sizeUsd: 300, leverage: 5, entry: { type: 'market' }, stop: 92, target: 110 };

function openRow(runner: ReturnType<typeof fakeRunner>, id: string, by: string, status: PlanRow['status'] = 'open'): PlanRow {
  const parsed = validatePlanInput(PLAN, NOW);
  assert.ok(parsed.ok);
  const row: PlanRow = {
    id,
    ...parsed.plan,
    status,
    hash: 'h',
    cloids: { entry: 'a', stop: 'b', target: 'c' },
    gen: 1,
    risk: { marginUsd: 60, maxLossUsd: 24.3, stopSlipUsd: 30, entryRef: 100, liquidationPx: 82, notionalUsd: 300, amountUsd: 60 },
    fillPx: 100,
    by,
    createdAt: 'x',
    updatedAt: 'x',
  };
  runner.rows.set(row.id, row);
  return row;
}

/* WHO DREW A PLAN IS RECORDED AND NEVER CONSULTED. A row carries `by`, the session that drew
   it, and a change to it arrives with no session at all: TradeChangeParams has no such field
   and src/http/propose.ts passes none. So a second operator can cancel or close what the first
   one armed, on the same terms as the first: the roster rule (src/agents.ts) is that every
   operator may do everything an operator may do, and the wall in front of both is the policy,
   not the author. Stated here so a change to that rule has a test to turn red. */
test('a change reaches a plan whoever drew it: ownership is recorded, and the policy is the only wall', async () => {
  const h = setup(1000);
  openRow(h.runner, 'pl_theirs', 'agent-1');
  openRow(h.runner, 'pl_resting', 'agent-1', 'placed');

  // No `by` exists to pass. The only identity a change carries is the plan id.
  const closed = await landed(h, h.svc.proposeTradeChange({ id: 'pl_theirs', close: true }));
  assert.equal(closed.status, 'executed', JSON.stringify(closed.verdict));
  assert.equal((closed.draft as TradeDraft).amountUsd, 0, 'a close is free at the wall, whoever asks');
  assert.equal(h.runner.calls[0], 'close pl_theirs 30');

  const cancelled = await landed(h, h.svc.proposeTradeChange({ id: 'pl_resting', cancel: true }));
  assert.equal(cancelled.status, 'executed');
  assert.equal((cancelled.draft as TradeDraft).amountUsd, 0, 'a cancel is free at the wall');
  assert.equal(h.runner.calls[1], 'cancel pl_resting');
});

/* A CLOSE ONLY TAKES RISK OFF: a reduce-only order at the plan's own bound, no new margin, and
   nothing leaves the venue. It was priced at the plan's margin and so charged the day and waited
   for a click above the ask line, the way opening one does (B4, 2026-09-23). It lands free now,
   like a cancel, and the two walls that are not about the amount still hold. */
test('a close charges nothing to the day and lands without a click, and the kill switch still refuses it', async () => {
  const strict = setup(10);
  openRow(strict.runner, 'pl_theirs', 'agent-1');
  const before = strict.svc.dailyLimit(25_000).spentUsd;
  const closed = await landed(strict, strict.svc.proposeTradeChange({ id: 'pl_theirs', close: true }));
  assert.equal(closed.status, 'executed', JSON.stringify(closed.verdict));
  assert.equal(strict.svc.dailyLimit(25_000).spentUsd, before, 'a close was charged to the day');
  assert.deepEqual(strict.runner.calls, ['close pl_theirs 30']);

  const stopped = setup(1000);
  openRow(stopped.runner, 'pl_theirs', 'agent-1');
  const policy = seededPolicy(1000);
  policy.killSwitch = true;
  savePolicy(stopped.dataDir, policy);
  const refused = await stopped.svc.proposeTradeChange({ id: 'pl_theirs', close: true });
  assert.equal(refused.status, 'policy_refused');
  assert.equal(refused.verdict.outcome === 'refuse' ? refused.verdict.rule : '', 'kill_switch');
  assert.deepEqual(stopped.runner.calls, [], 'nothing reached the venue');
});

/* NOT INSIDE A TURN THE APP STARTED. A move that did not go through wakes its agent for one line
   (src/http/ended.ts), and a close lands free at any size, so a woken agent that "tidied up" by
   closing a position did it with nobody at the window (security review F1). A change filed in
   that turn waits for the click (src/app-turn.ts); the person's own next turn closes as above. */
test('a close filed inside a turn the app started waits for the click, and the person\'s next turn closes on the policy', async () => {
  const h = setup(1000);
  openRow(h.runner, 'pl_theirs', 'seat-woken');
  let state: DriverState = 'ready';
  const turns: string[] = [];
  const chat = {
    id: 'c1',
    session: 'seat-woken',
    label: 'AGENT 1',
    transcript: [],
    driver: {
      status: () => ({ state }),
      send: (text: string) => {
        turns.push(text);
        state = 'thinking';
      },
      note: () => {},
    },
  } as unknown as Chat;
  let owed: (() => void) | null = null;
  const notices = createEndedNotices({
    store: h.store,
    chats: () => [chat],
    view: (p) => h.svc.view(p),
    audit: h.audit,
    schedule: (fn) => {
      owed = fn;
      return { cancel: () => {} };
    },
  });
  const at = new Date(NOW).toISOString();
  h.store.put({
    id: 'failed-1',
    kind: 'hl_withdraw',
    createdAt: at,
    status: 'failed',
    decidedBy: 'human',
    decidedAt: at,
    settledAt: at,
    draft: { kind: 'hl_withdraw', symbol: 'USDC', amount: 6.2, amountUsd: 6.2, minReceived: 5.9, from: '0x1', to: '0x1', counterparty: 'hypercore-withdraw' },
    simulation: { ok: true, summary: 'ok' },
    verdict: { outcome: 'needs_approval', reasons: [] },
    by: 'seat-woken',
    result: { ok: false, detail: 'spotSend refused by Hyperliquid. Nothing was sent.' },
  });
  assert.ok(owed !== null, 'the failure owed no wake');
  (owed as () => void)();
  assert.equal(turns.length, 1, 'the app did not start a turn');

  const woken = await landed(h, h.svc.proposeTradeChange({ id: 'pl_theirs', close: true, by: 'seat-woken' }));
  assert.equal(woken.status, 'pending', `the close landed ${woken.status}, decided by ${String(woken.decidedBy)}`);
  assert.equal(woken.verdict.reasons.at(-1), 'The app started this turn, so this waits for your OK.');
  assert.deepEqual(h.runner.calls, [], 'a position was closed with nobody at the window');

  notices.event(chat, { kind: 'turn_end', error: false, turns: 1 });
  state = 'ready';
  const theirs = await landed(h, h.svc.proposeTradeChange({ id: 'pl_theirs', close: true, by: 'seat-woken' }));
  assert.equal(theirs.status, 'executed', JSON.stringify(theirs.verdict));
  assert.deepEqual(h.runner.calls, ['close pl_theirs 30']);
  notices.stop();
});

/* ONE PLAN PER COIN, REFUSED BEFORE THE DRAW. The rule is pg/hl's (src/trade/risk.ts
   sameCoinPlan); the propose side refuses a second plan on a coin before drawing it, so a refusal
   leaves no stray idea on the chart. Skipped until the risk inputs carry the field. */
test('a second plan on a coin that already has a live one is refused before anything is drawn', async () => {
  const h = setup(1000);
  openRow(h.runner, 'pl_live', 'agent-1');
  const drawn = h.runner.rows.size;
  const p = await h.svc.proposeTrade({ plan: { ...PLAN, side: 'short', sizeUsd: 200 }, by: 'agent-2' });
  assert.equal(p.status, 'policy_refused');
  assert.deepEqual(p.verdict.reasonCodes, ['plan_exists']);
  assert.equal(h.runner.rows.size, drawn, 'a refused plan left an idea on the chart');
  assert.equal(h.svc.view(p).reason?.sentence, 'ETH already has a live plan, so nothing new was placed. Change or cancel that plan first.');
});

/* THE CARD IS THE PLAN THAT RUNS. An idea stays an idea while its proposal waits for the click,
   and an idea can be redrawn. So the chart the person is looking at can be moved under a card
   that has not changed. What runs on the click is the draft the card showed, whole, checked
   against its hash: the redraw is overwritten by the approved plan when the row is armed. */
test('a redraw while the proposal waits changes the chart and not what the click arms', async () => {
  const h = setup(10);
  const p = await h.svc.proposeTrade({ plan: PLAN, by: 'agent-1' });
  assert.equal(p.status, 'pending');
  const draft = p.draft as Extract<TradeDraft, { op: 'open' }>;
  const id = draft.plan.id;
  assert.equal(h.runner.get(id)?.status, 'idea');

  // The agent moves the idea: ten times the size, a stop far away. The card still shows $300.
  const row = h.runner.rows.get(id);
  assert.ok(row !== undefined);
  h.runner.rows.set(id, { ...row, sizeUsd: 30_000, stop: 50, hash: 'redrawn' });

  const approved = await landed(h, h.svc.approve(p.id));
  assert.equal(approved.status, 'executed', JSON.stringify(approved.verdict));
  const armed = h.runner.get(id);
  assert.ok(armed !== null);
  assert.equal(armed.status, 'waiting');
  assert.equal(armed.sizeUsd, 300, 'what armed is what the card showed');
  assert.equal(armed.stop, 92);
  assert.equal(armed.hash, draft.hash, 'the armed row carries the hash the person clicked on');
});

/* A change can only name a plan that is live. An idea has no authority to take off, a done
   row is history, and an id nobody minted is nothing. Each is refused before any pricing. */
test('a change to an idea, a finished plan or a made-up id is refused by name', async () => {
  const h = setup(1000);
  const parsed = validatePlanInput(PLAN, NOW);
  assert.ok(parsed.ok);
  const idea = h.runner.draw(parsed.plan, 'agent-1');
  openRow(h.runner, 'pl_done', 'agent-1', 'done');

  for (const [id, pattern] of [
    [idea.id, /is idea/],
    ['pl_done', /is done/],
    ['pl_nothing', /no plan pl_nothing/],
    ['../../etc/passwd', /no plan/],
  ] as const) {
    for (const change of [{ cancel: true }, { close: true }, { stop: 95 }]) {
      const p = await h.svc.proposeTradeChange({ id, ...change });
      assert.equal(p.status, 'policy_refused', `${id} ${JSON.stringify(change)}: ${p.status}`);
      assert.match(p.verdict.reasons.join(' '), pattern);
    }
  }
  assert.deepEqual(h.runner.calls, []);
});
