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
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { readViewMode } from '../../src/view/mode.ts';
import { createMarketData } from '../../src/market/index.ts';
import type {
  AppConfig,
  ChainId,
  ChainStatus,
  LedgerSnapshot,
  LpPosition,
  Proposal,
  ViewMode,
} from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-viewop-'));
}

// These tests post ops with no session id, which is one occupant like any other: the first
// op takes the free seat and the rest are the same session. Seating it up front keeps the
// connect edge out of the audit assertions, which is what the old agentSeen stub did.
function seatedAgents() {
  const agents = createAgents();
  agents.claim({ session: 'unnamed-session', client: 'test' });
  return agents;
}

function snapshot(): LedgerSnapshot {
  const fetchedAt = new Date().toISOString();
  const status: ChainStatus = { ok: true, fetchedAt };
  return {
    holdings: [{ chain: 'arb', address: '0xself', symbol: 'USDC', tokenId: '0xusdc', amount: 500, usd: 500, native: false }],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

function pendingProposal(id = 'p-pending'): Proposal {
  return {
    id,
    kind: 'consolidate',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: { kind: 'consolidate', legs: [], totalUsd: 250, toChain: 'arb', symbol: 'USDC' },
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
    network: 'testnet',
    approvalGate: true,
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };

  const server = createServer({
    cfg,
    audit,
    store,
    riskRows: [],
    ledger: {
      snapshot,
      positions: (): LpPosition[] => [],
      intents: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    candles: {
      get: async () => ({ candles: [], stale: false, source: 'test', fetchedAt: new Date().toISOString() }),
      spot: async () => 1,
    },
    // A market layer with no venue behind it: the store answers from an empty cache and
    // never reaches the network, which is what this test wants.
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposeConsolidate: async () => pendingProposal(),
      proposePolicyChange: async () => pendingProposal(),
      proposeSwap: async () => pendingProposal(),
      proposeHlDeposit: async () => pendingProposal(),
      proposeIntentsDeposit: async () => pendingProposal(),
      proposeIntentsWithdraw: async () => pendingProposal(),
      proposeMandate: async () => pendingProposal(),
      proposeLpAdd: async () => pendingProposal(),
      proposeLpRemove: async () => pendingProposal(),
      approve: async () => pendingProposal(),
      refuse: async () => pendingProposal(),
      get: (id: string) => list.find((p) => p.id === id),
      list: () => list,
      sessionSpentUsd: () => 0,
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function state(h: Harness): Promise<any> {
  return (await fetch(`${h.url}/api/state`)).json();
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
    assert.equal(readViewMode(h.dataDir), 'pro', 'an unwritten dataDir still reads pro');
  } finally {
    await h.close();
  }
});
