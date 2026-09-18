// The set_view_mode op, driven against a real server over real HTTP.
//
// These deliberately do not assert that getView() returns what setView() wrote. That
// is the shape of test that let v0.2 ship a gate flag wired to nothing: a pure
// function with no call site passes its own unit test and changes no behaviour.
// Every assertion here goes through the wire and then reads /api/state back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { readViewMode } from '../../src/view/mode.ts';
import { createMarketData } from '../../src/market/index.ts';
import type {
  AppConfig,
  LedgerSnapshot,
  Proposal,
  ViewMode,
} from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';

// The seat secret every op on /api/mcp carries (src/http/mcp.ts).
const SEAT = 's'.repeat(64);


function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-viewop-'));
}

// The window token the human's door is knocked on with. Sixteen hex digits, as the app mints.
const TOKEN = 'deadbeefcafef00d';

// These tests post ops with no session id, which is one occupant like any other: the first
// op takes the free seat and the rest are the same session. Seating it up front keeps the
// connect edge out of the audit assertions, which is what the old agentSeen stub did.
function seatedAgents() {
  const agents = createAgents(Date.now, MAX_AGENTS, { secret: SEAT });
  agents.claim({ session: 'unnamed-session', client: 'test' });
  return agents;
}

function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

function pendingProposal(id = 'p-pending'): Proposal {
  return {
    id,
    kind: 'swap',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: {
      kind: 'swap',
      venue: 'intents-native',
      chain: 'arb',
      toChain: 'eth',
      fromSymbol: 'USDC',
      toSymbol: 'ETH',
      amountIn: 250,
      amountUsd: 250,
      minAmountOut: 0.05,
      from: '0xself',
      to: '0xself',
      counterparty: 'intents.near',
      quote: null,
    },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
  };
}

type Harness = {
  url: string;
  close: () => Promise<void>;
  dataDir: string;
  auditTypes: () => string[];
  setProposals: (list: Proposal[]) => void;
};

async function boot(opts: { view?: ViewMode; proposals?: Proposal[] } = {}): Promise<Harness> {
  const dataDir = tmpDir();
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  let list: Proposal[] = opts.proposals ?? [];
  let view: ViewMode = opts.view ?? 'pro';

  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: '0xself' },
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };

  const server = createServer({
    cfg,
    token: TOKEN,
    audit,
    store,
    riskRows: [],
    ledger: {
      snapshot,
      intents: () => undefined,
      hyperliquid: () => undefined,
      refresh: async () => snapshot(),
    },
    // A market layer with no venue behind it: the store answers from an empty cache and
    // never reaches the network, which is what this test wants.
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposePolicyChange: async () => pendingProposal(),
      proposeSwap: async () => pendingProposal(),
      proposeHlDeposit: async () => pendingProposal(),
      proposeHlWithdraw: async () => pendingProposal(),
      proposeSend: async () => pendingProposal(),
      proposeTrade: async () => pendingProposal(),
      proposeTradeChange: async () => pendingProposal(),
      approve: async () => pendingProposal(),
      refuse: async () => pendingProposal(),
      get: (id: string) => list.find((p) => p.id === id),
      list: () => list,
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async (id: string) => list.find((p) => p.id === id) ?? pendingProposal(),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    // A seat already held by this test's own session, so an op logs no connect edge.
    agents: seatedAgents(),
    getView: () => view,
    setView: (mode) => {
      view = mode;
    },
    // The trading surface is not what this test drives, so everything that would reach the
    // venue is inert. The view is the real one rather than a fake: it is pure and cheap, and
    // a stubbed shape here would be asserting against something the server never sees.
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    dataDir,
    auditTypes: () => audit.tail(200).map((e) => e.type),
    setProposals: (next) => {
      list = next;
    },
  };
}

async function postMcp(h: Harness, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url },
    body: JSON.stringify({ secret: SEAT, ...(body as Record<string, unknown>) }),
  });
  return { status: res.status, json: await res.json() };
}

async function state(h: Harness): Promise<any> {
  return (await fetch(`${h.url}/api/state`)).json();
}

// The human's door: a window write, so it carries the token and the origin the window sends.
async function postView(h: Harness, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.url}/api/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function screenHeader(h: Harness, body: unknown): Promise<string | null> {
  const res = await fetch(`${h.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url },
    body: JSON.stringify({ secret: SEAT, ...(body as Record<string, unknown>) }),
  });
  await res.text();
  return res.headers.get('x-phosphor-screen');
}

// ---------- the consequence, not the switch ----------

test('/api/state carries the view mode and a basic model, in pro as well as basic', async () => {
  const h = await boot({ view: 'pro' });
  try {
    const s = await state(h);
    assert.equal(s.view, 'pro');
    assert.ok(s.basic, 'basic must be computed even while pro is rendering');
    assert.ok(s.basic.headline.length > 0);
  } finally {
    await h.close();
  }
});

test('set_view_mode flips the mode and the next state read shows it', async () => {
  const h = await boot({ view: 'pro' });
  try {
    const res = await postMcp(h, { op: 'set_view_mode', mode: 'basic' });
    assert.equal(res.status, 200);
    assert.equal(res.json.view, 'basic');
    assert.equal((await state(h)).view, 'basic');
    assert.ok(h.auditTypes().includes('view_changed'));
  } finally {
    await h.close();
  }
});

test('the flipped view carries the live proposal amount, not just the label', async () => {
  // This is the assertion that would have caught the v0.2 gate flag. A mode that
  // changes what the app SAYS about itself, while the payload underneath is unchanged
  // or empty, passes every other test in this file.
  const h = await boot({ view: 'pro', proposals: [pendingProposal()] });
  try {
    const s = await state(h);
    assert.equal(s.basic.ask.amountUsd, 250, 'the basic ask must carry the real governed amount');
    assert.match(s.basic.ask.headline, /250/);
    assert.equal(s.basic.tone, 'asking');
  } finally {
    await h.close();
  }
});

// ---------- refusals ----------

// A pending proposal used to refuse the switch outright, so that an agent could not move a
// human away from a decision they were in the middle of. Commit 7b41af4 put the approval block
// on the trading window, and ui/approvals.js now draws it on all three surfaces, so the
// decision travels with the human instead of being left behind on the screen they came from.
// The refusal was therefore protecting against something that can no longer happen, while
// standing directly in the way of the one-word switch.
//
// What replaces it is disclosure. These tests hold the switch to still REPORTING the pending
// work, because the basic screen shows one ask at a time and a silent switch with three
// waiting would hide two of them.
test('a switch while a proposal is pending goes through and reports what is still waiting', async () => {
  const h = await boot({ view: 'pro', proposals: [pendingProposal()] });
  try {
    const res = await postMcp(h, { op: 'set_view_mode', mode: 'basic' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.pending, ['p-pending'], 'the pending work must ride back on the answer');
    assert.match(String(res.json.note), /await/, 'the answer must say so in a sentence, not only in an array');
    assert.equal((await state(h)).view, 'basic');
    assert.ok(h.auditTypes().includes('view_changed'));
  } finally {
    await h.close();
  }
});

test('a switch with nothing pending says so rather than returning a bare empty list', async () => {
  const h = await boot({ view: 'pro' });
  try {
    const res = await postMcp(h, { op: 'set_view_mode', mode: 'trade' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.pending, []);
    assert.match(String(res.json.note), /nothing is waiting/);
  } finally {
    await h.close();
  }
});

test('trade is a real mode and the window can be sent to it', async () => {
  const h = await boot({ view: 'pro' });
  try {
    assert.equal((await postMcp(h, { op: 'set_view_mode', mode: 'trade' })).status, 200);
    assert.equal((await state(h)).view, 'trade');
    assert.ok(h.auditTypes().includes('view_changed'));
  } finally {
    await h.close();
  }
});

// One word is the requirement, so the words a person actually says all have to land. These are
// resolved in the app rather than in src/mcp.ts so that both doors onto the app agree.
test('the words a person says resolve to a mode', async () => {
  for (const [said, expected] of [
    ['trading', 'trade'],
    ['hft', 'trade'],
    ['perps', 'trade'],
    ['hyperliquid', 'trade'],
    ['simple', 'basic'],
    ['operator', 'pro'],
    ['vault', 'vault'],
    ['custody', 'vault'],
    // Case and stray spacing are the human typing, not a different intent.
    ['  TRADING  ', 'trade'],
    ['BASIC', 'basic'],
  ] as const) {
    const h = await boot({ view: 'pro' });
    try {
      const res = await postMcp(h, { op: 'set_view_mode', mode: said });
      assert.equal(res.status, 200, `"${said}" should resolve`);
      assert.equal((await state(h)).view, expected, `"${said}" should mean ${expected}`);
    } finally {
      await h.close();
    }
  }
});

test('an unknown mode is refused and changes nothing', async () => {
  const h = await boot({ view: 'pro' });
  try {
    // 'BASIC' is no longer here: case folding is now deliberate, see the alias test above.
    // What must still be refused is a mode that names nothing, however plausible it sounds.
    for (const mode of ['expert', '', 'null', 'trade-mode', 'both']) {
      const res = await postMcp(h, { op: 'set_view_mode', mode });
      assert.equal(res.status, 400, `mode ${mode} should be refused`);
    }
    assert.equal((await state(h)).view, 'pro');
    assert.ok(!h.auditTypes().includes('view_changed'));
  } finally {
    await h.close();
  }
});

test('a missing mode is refused rather than defaulting to anything', async () => {
  const h = await boot({ view: 'pro' });
  try {
    assert.equal((await postMcp(h, { op: 'set_view_mode' })).status, 400);
    assert.equal((await state(h)).view, 'pro');
  } finally {
    await h.close();
  }
});

// ---------- the op surface itself ----------

test('every set_view_mode call is audited as a tool_call before it is dispatched', async () => {
  const h = await boot({ view: 'pro' });
  try {
    await postMcp(h, { op: 'set_view_mode', mode: 'basic' });
    const calls = h.auditTypes().filter((t) => t === 'tool_call');
    assert.ok(calls.length > 0, 'the existing contract is that every op is logged before dispatch');
  } finally {
    await h.close();
  }
});

test('set_view_mode appears in the unknown-op help text', async () => {
  const h = await boot();
  try {
    const res = await postMcp(h, { op: 'nonsense' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /set_view_mode/);
  } finally {
    await h.close();
  }
});

test('the mode the server hands out is the one main.ts would persist', async () => {
  // The harness holds the mode in a closure the way main.ts does, so this checks the
  // wiring shape rather than the file. The file itself is covered in view-mode.test.ts.
  const h = await boot({ view: 'basic' });
  try {
    assert.equal((await state(h)).view, 'basic');
    assert.equal(readViewMode(h.dataDir), 'basic', 'an unwritten dataDir is a fresh install, which opens simple');
  } finally {
    await h.close();
  }
});

// ---------- the human's own switch ----------

// Karim, 2026-09-14: "when swapping by hand from pro to trade and stuff, it cant tell what
// screen it is on right now". The tab used to switch the window and tell nobody, so the
// server's view, and everything the agent reads it from, moved only when the agent moved it.

test('a human POST switches the view, and the next start reports it with by: human', async () => {
  const h = await boot({ view: 'pro' });
  try {
    const before = Date.now();
    const res = await postView(h, { token: TOKEN, view: 'trade' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.unchanged, false);
    assert.deepEqual({ view: res.json.screen.view, by: res.json.screen.by }, { view: 'trade', by: 'human' });
    assert.ok(Date.parse(res.json.screen.since) >= before, 'since is the moment of the click');

    assert.equal((await state(h)).view, 'trade', 'the state frame follows the human');
    const start = await postMcp(h, { op: 'read', tool: 'start' });
    assert.equal(start.status, 200);
    assert.equal(start.json.facts.view, 'trade');
    assert.equal(start.json.screen.view, 'trade');
    assert.equal(start.json.screen.by, 'human');
    assert.equal(start.json.screen.since, res.json.screen.since);
    assert.ok(h.auditTypes().includes('view_changed'), 'a human switch is audited like an agent switch');
  } finally {
    await h.close();
  }
});

test('the agent switch reports the same record with by: agent, and start agrees', async () => {
  const h = await boot({ view: 'basic' });
  try {
    const res = await postMcp(h, { op: 'set_view_mode', mode: 'pro' });
    assert.equal(res.status, 200);
    assert.equal(res.json.screen.view, 'pro');
    assert.equal(res.json.screen.by, 'agent');
    const start = await postMcp(h, { op: 'read', tool: 'start' });
    assert.deepEqual(start.json.screen, res.json.screen);
    // A human click on the tab the window is already on is answered without a new stamp.
    const same = await postView(h, { token: TOKEN, view: 'pro' });
    assert.equal(same.json.unchanged, true);
    assert.deepEqual(same.json.screen, res.json.screen, 'no write, so the agent still holds the record');
  } finally {
    await h.close();
  }
});

test('the human door accepts the agent door aliases and refuses anything else', async () => {
  const h = await boot({ view: 'basic' });
  try {
    assert.equal((await postView(h, { token: TOKEN, view: 'trading' })).json.screen.view, 'trade');
    assert.equal((await postView(h, { token: TOKEN, view: 'Simple' })).json.screen.view, 'basic');
    for (const view of ['expert', '', 'both']) {
      assert.equal((await postView(h, { token: TOKEN, view })).status, 400, `view ${view} should be refused`);
    }
    assert.equal((await state(h)).view, 'basic');
  } finally {
    await h.close();
  }
});

test('the human door is a window write: no token, no switch', async () => {
  const h = await boot({ view: 'pro' });
  try {
    assert.equal((await postView(h, { view: 'trade' })).status, 403);
    assert.equal((await postView(h, { token: 'wrong', view: 'trade' })).status, 403);
    assert.equal((await state(h)).view, 'pro');
    assert.ok(!h.auditTypes().includes('view_changed'));
  } finally {
    await h.close();
  }
});

test('every agent door answer names the screen, and a switch names the one it moved to', async () => {
  const h = await boot({ view: 'pro' });
  try {
    assert.equal(await screenHeader(h, { op: 'read', tool: 'start' }), 'pro');
    assert.equal(await screenHeader(h, { op: 'set_view_mode', mode: 'trade' }), 'trade', 'stamped as the answer is written, after the switch');
    assert.equal(await screenHeader(h, { op: 'read', tool: 'wallet' }), 'trade');
    await postView(h, { token: TOKEN, view: 'basic' });
    assert.equal(await screenHeader(h, { op: 'read', tool: 'wallet' }), 'basic', 'the human tab reaches the next answer');
    assert.equal(await screenHeader(h, { op: 'read', tool: 'no_such_tool' }), 'basic', 'a refusal names it too');
  } finally {
    await h.close();
  }
});
