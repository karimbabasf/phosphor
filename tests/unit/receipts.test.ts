// One card per action that actually happened.
//
// The history table answers "what was the sequence" and buries the two facts a person actually
// wants straight after doing something: what the wallet was worth before, and what it is worth
// now. A receipt is that question answered.
//
// The property that matters most here is that a receipt is a PROJECTION of the history rather
// than a second derivation of the same event. Two derivations would let the two screens disagree
// about an amount, and a person holding two screens that disagree about their own money has no
// way to tell which is lying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { RECEIPT_LIMIT_DEFAULT, RECEIPT_LIMIT_MAX } from '../../src/http/receipts.ts';
import type { Receipt } from '../../src/http/receipts.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition, Proposal, ProposalStatus } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const SELF = '0x1111111111111111111111111111111111111111';

function snapshot(): LedgerSnapshot {
  const chainStatus = Object.fromEntries(
    CHAINS.map((c) => [c, { ok: true, fetchedAt: new Date().toISOString() } as unknown as ChainStatus]),
  ) as Record<ChainId, ChainStatus>;
  return {
    holdings: [],
    prices: {},
    gas: {} as LedgerSnapshot['gas'],
    chainStatus,
    fetchedAt: new Date().toISOString(),
  } as unknown as LedgerSnapshot;
}

function settled(id: string, status: ProposalStatus, over: Partial<Proposal> = {}): Proposal {
  const at = new Date().toISOString();
  return {
    id,
    kind: 'intents_deposit',
    createdAt: at,
    decidedAt: at,
    decidedBy: 'policy',
    status,
    draft: {
      kind: 'intents_deposit',
      chain: 'arb',
      symbol: 'USDC',
      amount: 100,
      amountUsd: 100,
      from: SELF,
      to: '0x2222222222222222222222222222222222222222',
    } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    result: { ok: status === 'executed', detail: `the rail said what it did about ${id}`, txids: ['0x' + 'a'.repeat(64)] },
    balances: { beforeUsd: 1_000, afterUsd: 900 },
    ...over,
  };
}

async function boot(proposals: Proposal[]): Promise<{ url: string; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-receipts-'));
  const store = createStore(dataDir);
  for (const p of proposals) store.put(p);

  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: [SELF], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
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
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => settled('x', 'executed'),
      proposePolicyChange: async () => settled('x', 'executed'),
      proposeSwap: async () => settled('x', 'executed'),
      proposeHlDeposit: async () => settled('x', 'executed'),
      proposeIntentsDeposit: async () => settled('x', 'executed'),
      proposeIntentsWithdraw: async () => settled('x', 'executed'),
      proposeMandate: async () => settled('x', 'executed'),
      proposeLpAdd: async () => settled('x', 'executed'),
      proposeLpRemove: async () => settled('x', 'executed'),
      proposeYieldDeposit: async () => settled('x', 'executed'),
      proposeYieldWithdraw: async () => settled('x', 'executed'),
      approve: async () => settled('x', 'executed'),
      refuse: async () => settled('x', 'refused'),
      get: (id: string) => store.get(id),
      list: () => store.list(),
      sessionSpentUsd: () => 0,
      reconcileOnBoot: () => [],
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
      reconcile: () => Promise.reject(new Error('not wired in this test')),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(),
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function get(urlBase: string, route: string): Promise<{ status: number; body: string }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function receipts(urlBase: string, query = ''): Promise<Receipt[]> {
  const out = await get(urlBase, `/api/receipts${query}`);
  assert.equal(out.status, 200);
  return (JSON.parse(out.body) as { receipts: Receipt[] }).receipts;
}

test('a receipt carries every field the contract fixes', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const list = await receipts(h.url);
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), [
      'amount',
      'at',
      'balanceAfter',
      'balanceBefore',
      'feesUsd',
      'fromChain',
      'id',
      'kind',
      'status',
      'summary',
      'symbol',
      'toChain',
      'txids',
    ]);
  } finally {
    await h.close();
  }
});

test('the two balances are what make a receipt answer the question a person has', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const [receipt] = await receipts(h.url);
    assert.equal(receipt.balanceBefore, 1_000);
    assert.equal(receipt.balanceAfter, 900);
  } finally {
    await h.close();
  }
});

test('a balance that was never re-read is null, not a number', async () => {
  const h = await boot([settled('a', 'executed', { balances: { beforeUsd: 500, afterUsd: null } })]);
  try {
    const [receipt] = await receipts(h.url);
    assert.equal(receipt.balanceBefore, 500);
    assert.equal(receipt.balanceAfter, null, 'a failed re-read is not a balance of zero');
  } finally {
    await h.close();
  }
});

test('a proposal from before this field existed still gets a receipt', async () => {
  const h = await boot([settled('a', 'executed', { balances: undefined })]);
  try {
    const [receipt] = await receipts(h.url);
    assert.equal(receipt.balanceBefore, null);
    assert.equal(receipt.balanceAfter, null);
    assert.equal(receipt.status, 'executed');
  } finally {
    await h.close();
  }
});

test('the three outcomes a receipt can describe, and the one it cannot', async () => {
  const h = await boot([
    settled('done', 'executed'),
    settled('broke', 'failed'),
    settled('unknown', 'needs_reconciliation'),
    settled('running', 'executing'),
    settled('waiting', 'pending'),
    settled('refused', 'refused'),
  ]);
  try {
    const list = await receipts(h.url);
    const byId = new Map(list.map((r) => [r.id, r.status]));
    assert.equal(byId.get('done'), 'executed');
    assert.equal(byId.get('broke'), 'failed');
    assert.equal(byId.get('unknown'), 'needs_reconciliation');
    assert.equal(byId.has('running'), false, 'a receipt for something still in flight is not a receipt');
    assert.equal(byId.has('waiting'), false);
    assert.equal(byId.has('refused'), false);
  } finally {
    await h.close();
  }
});

test('the hashes carry a chain and a link, not a bare string', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const [receipt] = await receipts(h.url);
    assert.equal(receipt.txids.length, 1);
    assert.deepEqual(Object.keys(receipt.txids[0]).sort(), ['chain', 'hash', 'url']);
    assert.equal(receipt.txids[0].hash, '0x' + 'a'.repeat(64));
    assert.equal(typeof receipt.txids[0].chain, 'string');
  } finally {
    await h.close();
  }
});

test('the summary is the rail\'s own sentence, verbatim', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const [receipt] = await receipts(h.url);
    assert.equal(receipt.summary, 'the rail said what it did about a');
  } finally {
    await h.close();
  }
});

test('limit is honoured and bounded', async () => {
  const many = Array.from({ length: 40 }, (_, i) => settled(`p${i}`, 'executed'));
  const h = await boot(many);
  try {
    assert.equal((await receipts(h.url, '?limit=5')).length, 5);
    assert.equal((await receipts(h.url)).length, RECEIPT_LIMIT_DEFAULT);
    assert.ok((await receipts(h.url, '?limit=99999')).length <= RECEIPT_LIMIT_MAX);
    assert.equal((await receipts(h.url, '?limit=nonsense')).length, RECEIPT_LIMIT_DEFAULT);
  } finally {
    await h.close();
  }
});

test('an empty history is an empty list, not a failure', async () => {
  const h = await boot([]);
  try {
    assert.deepEqual(await receipts(h.url), []);
  } finally {
    await h.close();
  }
});

// A projection, not a second derivation. If these two ever disagree about an amount, a person is
// holding two screens about their own money with no way to tell which one is lying.
test('a receipt and the history row it came from agree on every shared fact', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const [receipt] = await receipts(h.url);
    const history = JSON.parse((await get(h.url, '/api/transactions')).body) as {
      entries: Array<Record<string, unknown>>;
    };
    const row = history.entries.find((e) => e.id === 'a');
    assert.ok(row !== undefined);
    assert.equal(receipt.at, row.ts);
    assert.equal(receipt.kind, row.kind);
    assert.equal(receipt.status, row.status);
    assert.equal(receipt.fromChain, row.place);
    assert.equal(receipt.toChain, row.toPlace);
    assert.equal(receipt.summary, row.detail);
    assert.equal(receipt.amount, (row.sent as { amount: number } | null)?.amount ?? null);
  } finally {
    await h.close();
  }
});
