// Agent presence over the wire: the frames the window animates from, and the button that
// replaces the agent.
//
// Driven against a real server over real HTTP, for the reason written at the top of
// view-op.test.ts: a store with the right shape and no call site passes its own unit test and
// changes no behaviour. The invariant that matters here is an ordering one, and ordering only
// exists on the wire. `start` has to reach the browser BEFORE the work is dispatched, because
// the whole design turns on the window moving at the first instant the intent is known.

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
import { createMarketData } from '../../src/market/index.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition, Proposal } from '../../src/types.ts';
import type { SummonOutcome } from '../../src/summon.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function snapshot(): LedgerSnapshot {
  const fetchedAt = new Date().toISOString();
  const status: ChainStatus = { ok: true, fetchedAt };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

function pendingProposal(): Proposal {
  return {
    id: 'p-pending',
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
  agents: ReturnType<typeof createAgents>;
  summonCalls: () => number;
};

/** `slowRead` lets a test hold a tool call open, which is the only way to observe that the
 *  start frame is already out while the work is still running. */
async function boot(opts: { summon?: (cwd: string) => Promise<SummonOutcome>; slowRead?: () => Promise<void> } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-presence-'));
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const agents = createAgents();
  let summonCalls = 0;

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
      get: async () => {
        if (opts.slowRead) await opts.slowRead();
        return { candles: [], stale: false, source: 'test', fetchedAt: new Date().toISOString() };
      },
      spot: async () => 1,
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
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
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents,
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      onUpdate: () => {},
      stop: () => {},
    },
    // Never the real one: the suite must not open a Terminal window on whoever runs it.
    summon: async (cwd: string) => {
      summonCalls++;
      return opts.summon ? opts.summon(cwd) : { ok: true, how: 'test' };
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    agents,
    summonCalls: () => summonCalls,
  };
}

/** Reads SSE frames off /api/events until `want` agent frames have arrived or time runs out.
 *  Real parsing of the real stream: the browser gets bare `data:` lines and so does this. */
async function agentFrames(h: Harness, want: number, fire: () => Promise<unknown>): Promise<any[]> {
  const ac = new AbortController();
  const res = await fetch(`${h.url}/api/events`, { signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buf = '';

  const pump = (async () => {
    while (frames.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.type === 'agent') frames.push(payload);
      }
    }
  })();

  await fire();
  await Promise.race([pump, new Promise((r) => setTimeout(r, 4000))]);
  ac.abort();
  return frames;
}

function post(h: Harness, route: string, body: unknown): Promise<Response> {
  return fetch(`${h.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url },
    body: JSON.stringify(body),
  });
}

test('a tool call produces a start frame and then a settle frame, in that order', async () => {
  const h = await boot();
  try {
    const frames = await agentFrames(h, 2, () =>
      post(h, '/api/mcp', { op: 'read', tool: 'balances', session: 's1', client: 'test' }),
    );
    assert.equal(frames.length, 2, 'both edges reached the browser');
    assert.equal(frames[0].phase, 'start');
    assert.equal(frames[1].phase, 'settle');
    assert.equal(frames[0].action.id, frames[1].action.id, 'and they are the same action');
    assert.equal(frames[0].action.label, 'read balances');
    assert.equal(frames[0].action.target, 'read');
    assert.equal(frames[1].action.outcome, 'ok');
    assert.ok(typeof frames[1].action.ms === 'number');
  } finally {
    await h.close();
  }
});

test('the start frame is out BEFORE the work finishes, which is the whole point', async () => {
  // The read is held open. If the start frame only went out on completion, nothing would
  // arrive until the gate below is released, and the window would have animated nothing
  // during the exact interval it exists to cover.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await boot({ slowRead: () => held });
  try {
    const frames = await agentFrames(h, 1, async () => {
      void post(h, '/api/mcp', { op: 'read', tool: 'candles', product: 'BTC-USD', session: 's1', client: 'test' });
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].phase, 'start', 'the window is already moving while the call is in flight');
  } finally {
    release();
    await h.close();
  }
});

test('a refused op still settles, so a wind-up can never be left running', async () => {
  const h = await boot();
  try {
    const frames = await agentFrames(h, 2, () => post(h, '/api/mcp', { op: 'nonsense', session: 's1', client: 'test' }));
    assert.equal(frames.length, 2);
    assert.equal(frames[1].phase, 'settle');
    assert.equal(frames[1].action.outcome, 'refused');
  } finally {
    await h.close();
  }
});

test('a chart write animates as chart, and carries what changed', async () => {
  const h = await boot();
  try {
    const frames = await agentFrames(h, 1, () =>
      post(h, '/api/mcp', {
        op: 'view',
        tool: 'chart_set_view',
        product: 'ETH-USD',
        granularitySec: 900,
        session: 's1',
        client: 'test',
      }),
    );
    assert.equal(frames[0].action.target, 'chart');
    // The detail is what the window prints beside the machine, so it has to be legible at a
    // glance rather than a dump of the arguments.
    assert.equal(frames[0].action.detail, 'ETH-USD 900s');
  } finally {
    await h.close();
  }
});

test('/api/state carries what is open, so a reloading window still winds', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await boot({ slowRead: () => held });
  try {
    void post(h, '/api/mcp', { op: 'read', tool: 'candles', product: 'BTC-USD', session: 's1', client: 'test' });
    await new Promise((r) => setTimeout(r, 120));
    const state = (await (await fetch(`${h.url}/api/state`)).json()) as any;
    assert.equal(state.agents.working.length, 1, 'a window attaching now learns the read is in flight');
    assert.equal(state.agents.working[0].target, 'read');
    release();
    await new Promise((r) => setTimeout(r, 120));
    const after = (await (await fetch(`${h.url}/api/state`)).json()) as any;
    assert.equal(after.agents.working.length, 0);
  } finally {
    release();
    await h.close();
  }
});

test('summon needs the token, and without it nothing is spawned and nobody is dropped', async () => {
  const h = await boot();
  try {
    h.agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
    const res = await post(h, '/api/summon', {});
    assert.equal(res.status, 403);
    assert.equal(h.summonCalls(), 0, 'the process is never spawned on a rejected request');
    assert.equal(h.agents.holder()?.session, 'old', 'and the seat is untouched');
  } finally {
    await h.close();
  }
});

test('summon drops the sitting agent, revokes it, and reports who went', async () => {
  const h = await boot();
  try {
    const { token } = (await (await fetch(`${h.url}/api/session`)).json()) as any;
    h.agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });

    const res = await post(h, '/api/summon', { token });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.dropped, 'claude-code');
    assert.equal(h.summonCalls(), 1);

    // Revoked, not merely freed. A freed seat would be taken straight back: the evicted proxy
    // heartbeats every five seconds and a terminal takes longer than that to start a shell.
    const again = h.agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
    assert.equal(again.ok, false);
    assert.equal(h.agents.holder(), null, 'the seat is waiting for the replacement');
  } finally {
    await h.close();
  }
});

test('the evicted agent is told to stop, in a way its proxy can act on', async () => {
  const h = await boot();
  try {
    const { token } = (await (await fetch(`${h.url}/api/session`)).json()) as any;
    h.agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
    await post(h, '/api/summon', { token });

    const res = await post(h, '/api/mcp', { op: 'read', tool: 'balances', session: 'old', client: 'claude-code' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as any;
    // 'revoked' and not 'busy'. src/mcp.ts exits on the first and reports a sentence on the
    // second, so conflating them would have a merely-unlucky agent kill itself.
    assert.equal(body.seat, 'revoked');
    assert.match(String(body.error), /replaced/);
  } finally {
    await h.close();
  }
});

test('a failed summon says so and does not claim an agent is coming', async () => {
  const h = await boot({ summon: async () => ({ ok: false, error: 'osascript: not permitted' }) });
  try {
    const { token } = (await (await fetch(`${h.url}/api/session`)).json()) as any;
    const res = await post(h, '/api/summon', { token });
    assert.equal(res.status, 500);
    assert.match(String(((await res.json()) as any).error), /not permitted/);
  } finally {
    await h.close();
  }
});

test('summoning with no agent connected is a plain success, not an error', async () => {
  const h = await boot();
  try {
    const { token } = (await (await fetch(`${h.url}/api/session`)).json()) as any;
    const res = await post(h, '/api/summon', { token });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).dropped, null);
  } finally {
    await h.close();
  }
});
