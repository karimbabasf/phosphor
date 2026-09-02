// The four yield ops an agent reaches, driven against a real server over real HTTP.
//
// What these hold is the half of the surface that lives in src/server.ts: which chain a
// proposal gets when the caller omits one, what a read says when no loop is running, and
// what the switch refuses. The tool DESCRIPTIONS and the schemas are held by
// tests/tool-surface.ts and tests/injection.test.ts, which is the split this repo already
// uses everywhere: the shim owns the door, the app owns what is behind it.
//
// Every assertion goes through the wire. A resolver that returns the right chain to nobody
// is the shape of test that let a gate flag ship wired to nothing.

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
import { OBSERVATION_CAVEAT } from '../../src/yield/positions.ts';
import type { Allocator, YieldView } from '../../src/yield/allocator.ts';
import type {
  AppConfig,
  ChainId,
  ChainStatus,
  LedgerSnapshot,
  LpPosition,
  Proposal,
  ViewMode,
  YieldDepositParams,
  YieldWithdrawParams,
} from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-yieldsurface-'));
}

function seatedAgents() {
  const agents = createAgents();
  agents.claim({ session: 'unnamed-session', client: 'test' });
  return agents;
}

function snapshot(): LedgerSnapshot {
  const fetchedAt = new Date().toISOString();
  const status: ChainStatus = { ok: true, fetchedAt };
  return {
    holdings: [
      { chain: 'arb', address: '0xself', symbol: 'USDC', tokenId: '0xusdc', amount: 500, usd: 500, native: false },
    ],
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

// A view shaped like the allocator's, with only the fields the server's resolvers read
// filled in honestly. Anything the resolvers do not touch stays at its empty value, so a
// test that starts depending on one of them fails loudly rather than reading a fixture's
// invention as a fact.
function view(over: Partial<YieldView> = {}): YieldView {
  return {
    chain: null,
    positions: [],
    venues: [],
    totalPrincipalUsd: 0,
    totalValueUsd: 0,
    totalEarnedUsd: 0,
    basisUnknown: 0,
    best: null,
    autoAllocate: false,
    lastTickAt: null,
    decisions: [],
    stale: false,
    error: null,
    ...over,
  };
}

function heldPosition(chain: ChainId, valueUsd: number): YieldView['positions'][number] {
  return {
    venue: 'aave-v3',
    chain,
    symbol: 'USDC',
    decimals: 6,
    receiptSymbol: 'aUSDC',
    receipt: '0xreceipt',
    explorerTx: 'https://example.invalid/tx/',
    basisKnown: true,
    principalBase: '0',
    valueBase: '0',
    earnedBase: '0',
    principalUsd: valueUsd,
    valueUsd,
    earnedUsd: 0,
    openedAt: null,
    credits: [],
    rate: null,
    realized: null,
  };
}

type Calls = { deposits: YieldDepositParams[]; withdrawals: YieldWithdrawParams[]; started: number; stopped: number };

type Harness = {
  url: string;
  close: () => Promise<void>;
  calls: Calls;
  auditMessages: () => string[];
};

async function boot(opts: { yieldView?: YieldView | null } = {}): Promise<Harness> {
  const dataDir = tmpDir();
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  let mode: ViewMode = 'pro';
  const calls: Calls = { deposits: [], withdrawals: [], started: 0, stopped: 0 };
  let current = opts.yieldView === undefined ? view() : opts.yieldView;

  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };

  // Only the four methods the server calls. A fuller fake would be inventing behaviour the
  // allocator's own tests already hold.
  const allocator: Allocator | undefined =
    current === null
      ? undefined
      : ({
          view: () => current as YieldView,
          refresh: async () => current as YieldView,
          tick: async () => ({ at: new Date().toISOString(), action: 'idle', detail: '', proposalId: null }),
          start: () => {
            calls.started += 1;
            current = view({ ...(current as YieldView), autoAllocate: true });
          },
          stop: () => {
            calls.stopped += 1;
            current = view({ ...(current as YieldView), autoAllocate: false });
          },
        } as Allocator);

  const server = createServer({
    cfg,
    audit,
    store,
    riskRows: [],
    allocator,
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
    market: createMarketData({
      fetchImpl: (async () => ({
        ok: true,
        json: async () => [],
        text: async () => '',
        headers: new Headers(),
      })) as unknown as typeof fetch,
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
      proposeYieldDeposit: async (p: YieldDepositParams) => {
        calls.deposits.push(p);
        return pendingProposal('p-deposit');
      },
      proposeYieldWithdraw: async (p: YieldWithdrawParams) => {
        calls.withdrawals.push(p);
        return pendingProposal('p-withdraw');
      },
      approve: async () => pendingProposal(),
      refuse: async () => pendingProposal(),
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      settle: () => Promise.resolve(true),
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: seatedAgents(),
    getView: () => mode,
    setView: (next) => {
      mode = next;
    },
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
    calls,
    auditMessages: () => audit.tail(200).map((e) => e.msg),
  };
}

async function postMcp(h: Harness, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ---------- yield_read ----------

test('yield_read with no allocator says this app is not wired for it, not that the position is empty', async () => {
  const h = await boot({ yieldView: null });
  try {
    const { status, json } = await postMcp(h, { op: 'read', tool: 'yield_read' });
    assert.equal(status, 200);
    assert.equal(json.available, false);
    // The distinction is the whole point of the branch: an agent must not report "you have
    // nothing earning" when the truth is "nothing here can tell you".
    assert.match(String(json.reason), /does not mean a supplied balance is empty/);
    assert.equal(json.positions, undefined);
  } finally {
    await h.close();
  }
});

test('yield_read carries the observation caveat with the numbers, not only in the tool description', async () => {
  const h = await boot({ yieldView: view({ totalEarnedUsd: 0.41, best: { chain: 'arb', apy: 0.0427 } }) });
  try {
    const { json } = await postMcp(h, { op: 'read', tool: 'yield_read' });
    assert.equal(json.available, true);
    assert.equal(json.caveat, OBSERVATION_CAVEAT);
    assert.equal(json.totalEarnedUsd, 0.41);
    assert.deepEqual(json.best, { chain: 'arb', apy: 0.0427 });
  } finally {
    await h.close();
  }
});

// ---------- propose yield_deposit ----------

test('a deposit with no chain goes where the loop would send it', async () => {
  const h = await boot({ yieldView: view({ best: { chain: 'base', apy: 0.0123 } }) });
  try {
    const { status } = await postMcp(h, { op: 'propose', kind: 'yield_deposit', params: { amount: 25 } });
    assert.equal(status, 200);
    assert.deepEqual(h.calls.deposits, [{ chain: 'base', symbol: undefined, amount: 25 }]);
  } finally {
    await h.close();
  }
});

test('a deposit with no chain is refused, with the venue notes, when nothing quotes a rate', async () => {
  const h = await boot({
    yieldView: view({
      best: null,
      venues: [
        { venue: 'aave-v3', chain: 'arb', symbol: 'USDC', rate: null, healthy: false, note: 'reserve frozen', idleBase: '0', idleUsd: 0 },
      ],
    }),
  });
  try {
    const { status, json } = await postMcp(h, { op: 'propose', kind: 'yield_deposit', params: { amount: 25 } });
    assert.equal(status, 400);
    assert.match(String(json.error), /reserve frozen/);
    assert.equal(h.calls.deposits.length, 0);
  } finally {
    await h.close();
  }
});

test('a deposit names an EVM chain or none: sol and near are refused by name', async () => {
  const h = await boot();
  try {
    for (const chain of ['sol', 'near']) {
      const { status, json } = await postMcp(h, {
        op: 'propose',
        kind: 'yield_deposit',
        params: { chain, amount: 25 },
      });
      assert.equal(status, 400, `${chain} should be refused`);
      assert.match(String(json.error), /eth, base, arb/);
    }
    assert.equal(h.calls.deposits.length, 0);
  } finally {
    await h.close();
  }
});

test('a deposit of zero or less never reaches the rail', async () => {
  const h = await boot();
  try {
    const { status } = await postMcp(h, { op: 'propose', kind: 'yield_deposit', params: { chain: 'arb', amount: 0 } });
    assert.equal(status, 400);
    assert.equal(h.calls.deposits.length, 0);
  } finally {
    await h.close();
  }
});

test('a deposit requires an amount, because there is no honest default for how much to supply', async () => {
  const h = await boot();
  try {
    const { status } = await postMcp(h, { op: 'propose', kind: 'yield_deposit', params: { chain: 'arb' } });
    assert.equal(status, 400);
    assert.equal(h.calls.deposits.length, 0);
  } finally {
    await h.close();
  }
});

// ---------- propose yield_withdraw ----------

test('a withdrawal with no amount is the whole position, and the rail is told so by omission', async () => {
  const h = await boot({ yieldView: view({ positions: [heldPosition('arb', 56.29)] }) });
  try {
    const { status } = await postMcp(h, { op: 'propose', kind: 'yield_withdraw', params: {} });
    assert.equal(status, 200);
    assert.equal(h.calls.withdrawals.length, 1);
    assert.equal(h.calls.withdrawals[0]!.chain, 'arb');
    // Not zero, not the current balance: absent. A rebasing receipt grows while the proposal
    // waits, so any number this layer supplied would leave dust behind.
    assert.equal(h.calls.withdrawals[0]!.amount, undefined);
  } finally {
    await h.close();
  }
});

test('a withdrawal with money on two chains refuses and names both, rather than picking one', async () => {
  const h = await boot({
    yieldView: view({ positions: [heldPosition('arb', 40), heldPosition('base', 10)] }),
  });
  try {
    const { status, json } = await postMcp(h, { op: 'propose', kind: 'yield_withdraw', params: {} });
    assert.equal(status, 400);
    assert.match(String(json.error), /arb, base/);
    assert.equal(h.calls.withdrawals.length, 0);
  } finally {
    await h.close();
  }
});

test('a closed position is not a place to withdraw from, even though its row is still there', async () => {
  // The row survives a full exit so the window can still print what it earned. Counting it
  // as a destination would send a withdrawal at a zero balance and get a rail error that
  // says nothing about which chain the caller should have named.
  const h = await boot({ yieldView: view({ positions: [heldPosition('arb', 0)] }) });
  try {
    const { status, json } = await postMcp(h, { op: 'propose', kind: 'yield_withdraw', params: {} });
    assert.equal(status, 400);
    assert.match(String(json.error), /nothing is supplied/);
  } finally {
    await h.close();
  }
});

test('a withdrawal may still name its chain and its amount, for a partial exit', async () => {
  const h = await boot({ yieldView: view({ positions: [heldPosition('arb', 56.29), heldPosition('base', 10)] }) });
  try {
    const { status } = await postMcp(h, {
      op: 'propose',
      kind: 'yield_withdraw',
      params: { chain: 'base', amount: 4 },
    });
    assert.equal(status, 200);
    assert.deepEqual(h.calls.withdrawals, [{ chain: 'base', symbol: undefined, amount: 4 }]);
  } finally {
    await h.close();
  }
});

// ---------- yield_auto ----------

test('yield_auto has no default: a switch is not something to flip while reading it', async () => {
  const h = await boot();
  try {
    const { status, json } = await postMcp(h, { op: 'yield_auto' });
    assert.equal(status, 400);
    assert.match(String(json.error), /enabled must be true or false/);
    assert.equal(h.calls.started, 0);
    assert.equal(h.calls.stopped, 0);
  } finally {
    await h.close();
  }
});

test('yield_auto starts and stops the loop, and says which in the log', async () => {
  const h = await boot();
  try {
    const on = await postMcp(h, { op: 'yield_auto', enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.autoAllocate, true);
    assert.equal(h.calls.started, 1);

    const off = await postMcp(h, { op: 'yield_auto', enabled: false });
    assert.equal(off.json.autoAllocate, false);
    assert.equal(h.calls.stopped, 1);

    // "Who turned the bot on" is the first question anyone asks of a log after money moved
    // without a click, so both edges are in it and both say which way they went.
    const messages = h.auditMessages().join('\n');
    assert.match(messages, /yield_auto ON/);
    assert.match(messages, /yield_auto OFF/);
  } finally {
    await h.close();
  }
});

test('yield_auto with no allocator refuses rather than reporting a switch it did not throw', async () => {
  const h = await boot({ yieldView: null });
  try {
    const { status, json } = await postMcp(h, { op: 'yield_auto', enabled: true });
    assert.equal(status, 400);
    assert.match(String(json.error), /no lending allocator/);
  } finally {
    await h.close();
  }
});

// ---------- the ops list ----------

test('an unknown op names yield_auto among the ones that exist', async () => {
  const h = await boot();
  try {
    const { status, json } = await postMcp(h, { op: 'not_an_op' });
    assert.equal(status, 400);
    assert.match(String(json.error), /yield_auto/);
  } finally {
    await h.close();
  }
});

test('an unknown read tool names yield_read and gas_report among the ones that exist', async () => {
  const h = await boot();
  try {
    const { status, json } = await postMcp(h, { op: 'read', tool: 'not_a_tool' });
    assert.equal(status, 400);
    assert.match(String(json.error), /yield_read/);
    assert.match(String(json.error), /gas_report/);
  } finally {
    await h.close();
  }
});

// ---------- the gas endpoint's boundary ----------

test('a gas window this app does not have is refused by name, with a 400, on both doors', async () => {
  const h = await boot();
  try {
    // The status matters as much as the message. The window renders whatever body it is
    // handed, so an error object answered 200 draws as a report of zero gas spent, which is
    // the one wrong answer this feature exists to avoid.
    const viaHttp = await fetch(`${h.url}/api/gas?window=forever`);
    assert.equal(viaHttp.status, 400);
    const httpBody = (await viaHttp.json()) as { error?: string };
    assert.match(String(httpBody.error), /24h, 7d, 30d, all/);

    const viaMcp = await postMcp(h, { op: 'read', tool: 'gas_report', args: { window: 'forever' } });
    assert.equal(viaMcp.status, 400);
    assert.match(String(viaMcp.json.error), /24h, 7d, 30d, all/);
  } finally {
    await h.close();
  }
});

test('the gas report defaults to seven days and answers on both doors with the same shape', async () => {
  const h = await boot();
  try {
    const viaHttp = (await (await fetch(`${h.url}/api/gas`)).json()) as {
      window: string;
      totalUsd: number;
      moveCount: number;
    };
    const viaMcp = (await postMcp(h, { op: 'read', tool: 'gas_report' })).json;
    assert.equal(viaHttp.window, '7d');
    assert.equal(viaMcp.window, '7d');
    // Two aggregations of one history would eventually disagree about a dollar, and the human
    // and the agent would each be told a different number about the same money.
    assert.equal(viaHttp.totalUsd, viaMcp.totalUsd);
    assert.equal(viaHttp.moveCount, viaMcp.moveCount);
  } finally {
    await h.close();
  }
});
