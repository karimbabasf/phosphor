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
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, Proposal, ProposalStatus } from '../../src/types.ts';

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
      intents: () => undefined,
      hyperliquid: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => settled('x', 'executed'),
      proposePolicyChange: async () => settled('x', 'executed'),
      proposeSwap: async () => settled('x', 'executed'),
      proposeHlDeposit: async () => settled('x', 'executed'),
      proposeHlWithdraw: async () => settled('x', 'executed'),
      proposeIntentsDeposit: async () => settled('x', 'executed'),
      proposeIntentsWithdraw: async () => settled('x', 'executed'),
      proposeTrade: async () => settled('x', 'executed'),
      proposeTradeChange: async () => settled('x', 'executed'),
      approve: async () => settled('x', 'executed'),
      refuse: async () => settled('x', 'refused'),
      get: (id: string) => store.get(id),
      list: () => store.list(),
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
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
      'headline',
      'id',
      'kind',
      // Added 2026-09-14: the conversation's receipt card and the Activity row say what
      // arrived, and both read it off the receipt rather than off the rail's sentence.
      'received',
      'status',
      'summary',
      'symbol',
      'toChain',
      'txids',
      // Added 2026-09-15: the receipt card's grid prints what it was worth, who did it and
      // which address it left from, and reads all three off the receipt.
      'valueUsd',
      'venue',
      'wallet',
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
    assert.deepEqual(Object.keys(receipt.txids[0]).sort(), ['chain', 'explorer', 'hash', 'url']);
    assert.equal(receipt.txids[0].hash, '0x' + 'a'.repeat(64));
    assert.equal(typeof receipt.txids[0].chain, 'string');
    // The name on the card's button follows the link, never the row: no link, no name.
    assert.equal(receipt.txids[0].url, 'https://arbiscan.io/tx/0x' + 'a'.repeat(64));
    assert.equal(receipt.txids[0].explorer, 'Arbiscan');
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

/* The row and the opened receipt answer to two different readers, and the Activity panel was
   handing the wrong sentence to the wrong one: the rail's line, with its intent hash and quote
   handle, as the title of every row. It wrapped to six lines, buried the time under itself and
   ran across the amount, so two receipts filled the panel. The verbatim line is evidence and it
   stays. What a ROW says is this one. */
test('the headline is the owner\'s sentence and it is not the rail\'s', async () => {
  const h = await boot([settled('a', 'executed')]);
  try {
    const [receipt] = await receipts(h.url);
    assert.ok(receipt.headline.length > 0, 'a row has something to say');
    assert.notEqual(receipt.headline, receipt.summary, 'two readers, two sentences');
    // The tells of a rail sentence: what somebody debugging this app needs and an owner does not.
    for (const noise of ['intent ', 'quote handle', '0x']) {
      assert.ok(!receipt.headline.includes(noise), `a headline never carries "${noise}"`);
    }
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

// ---------- the window, the cursor and the kind ----------
//
// The Activity panel opens on the last 24 hours and pages backwards from there. The server owns
// the window (since), the cursor (before), the kind taxonomy and the two figures that describe
// the window rather than the page (total, feesUsd), so both Activity panels and the chat read
// one answer and never count for themselves.

type Page = { receipts: Receipt[]; total: number; hasMore: boolean; feesUsd: number };

async function page(urlBase: string, query = ''): Promise<Page> {
  const out = await get(urlBase, `/api/receipts${query}`);
  assert.equal(out.status, 200, out.body);
  return JSON.parse(out.body) as Page;
}

const HOUR = 3_600_000;

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

// One receipt settled `hours` ago, of one kind, with a venue fee the history parses off the
// simulation summary the way the real rails write it.
function aged(id: string, hours: number, kind: string, fee: number): Proposal {
  const at = ago(hours);
  const draft = kind === 'swap'
    ? {
        kind: 'swap', venue: 'intents-native', chain: 'eth', toChain: 'eth', fromSymbol: 'ETH', toSymbol: 'USDC',
        amountIn: 0.002, amountUsd: 5, minAmountOut: 4.9, from: SELF, to: SELF, counterparty: 'intents.near', quote: null,
      }
    : { kind, chain: 'arb', symbol: 'USDC', amount: 100, amountUsd: 100, from: SELF, to: SELF };
  return settled(id, 'executed', {
    kind: kind as Proposal['kind'],
    createdAt: at,
    decidedAt: at,
    draft: draft as unknown as Proposal['draft'],
    simulation: { ok: true, summary: `fee $${fee.toFixed(2)}` } as unknown as Proposal['simulation'],
  });
}

const SPREAD = [
  aged('h2', 2, 'swap', 0.02),
  aged('h5', 5, 'intents_deposit', 0.03),
  aged('h20', 20, 'swap', 0.05),
  aged('h30', 30, 'hl_deposit', 0.32),
  aged('h100', 100, 'swap', 0.01),
  aged('h200', 200, 'intents_withdraw', 0.04),
];

test('with no parameters the answer keeps its old shape and gains the three window figures', async () => {
  const h = await boot(SPREAD);
  try {
    const out = await page(h.url);
    assert.deepEqual(Object.keys(out).sort(), ['feesUsd', 'hasMore', 'receipts', 'total']);
    assert.deepEqual(out.receipts.map((r) => r.id), ['h2', 'h5', 'h20', 'h30', 'h100', 'h200'], 'newest first, all of them');
    assert.equal(out.total, 6);
    assert.equal(out.hasMore, false);
    assert.equal(out.feesUsd.toFixed(2), '0.47');
  } finally {
    await h.close();
  }
});

test('since keeps the window, and total and fees describe the window', async () => {
  const h = await boot(SPREAD);
  try {
    const out = await page(h.url, `?since=${Date.now() - 24 * HOUR}`);
    assert.deepEqual(out.receipts.map((r) => r.id), ['h2', 'h5', 'h20']);
    assert.equal(out.total, 3);
    assert.equal(out.hasMore, false);
    assert.equal(out.feesUsd.toFixed(2), '0.10', 'the fees of the window, not of everything');
  } finally {
    await h.close();
  }
});

test('before is the cursor: strictly older than the last row, so a page never repeats', async () => {
  const h = await boot(SPREAD);
  try {
    const first = await page(h.url, '?limit=2');
    assert.deepEqual(first.receipts.map((r) => r.id), ['h2', 'h5']);
    assert.equal(first.hasMore, true);
    assert.equal(first.total, 6, 'the total is the window, not the page');
    const cursor = Date.parse(first.receipts[1]!.at);
    const second = await page(h.url, `?limit=2&before=${cursor}`);
    assert.deepEqual(second.receipts.map((r) => r.id), ['h20', 'h30']);
    assert.equal(second.hasMore, true);
    const third = await page(h.url, `?limit=2&before=${Date.parse(second.receipts[1]!.at)}`);
    assert.deepEqual(third.receipts.map((r) => r.id), ['h100', 'h200']);
    assert.equal(third.hasMore, false);
    assert.equal(third.feesUsd.toFixed(2), '0.47', 'the window figures do not move as pages are read');
  } finally {
    await h.close();
  }
});

test('the cursor stays inside the window', async () => {
  const h = await boot(SPREAD);
  try {
    const out = await page(h.url, `?since=${Date.now() - 24 * HOUR}&limit=2&before=${Date.now() - 4 * HOUR}`);
    assert.deepEqual(out.receipts.map((r) => r.id), ['h5', 'h20']);
    assert.equal(out.hasMore, false, 'h30 is older than the window, so there is no more');
    assert.equal(out.total, 3);
  } finally {
    await h.close();
  }
});

test('kind is one word for a family of rails, and the four words are the taxonomy', async () => {
  const h = await boot(SPREAD);
  try {
    assert.deepEqual((await page(h.url, '?kind=swap')).receipts.map((r) => r.id), ['h2', 'h20', 'h100']);
    const moves = await page(h.url, '?kind=move');
    assert.deepEqual(moves.receipts.map((r) => r.id), ['h5', 'h30', 'h200']);
    assert.equal(moves.feesUsd.toFixed(2), '0.39');
    assert.deepEqual((await page(h.url, '?kind=all')).receipts.length, 6);
    // Trades and bots are not transactions today (transactions.ts ACTIONS), so the words answer with nothing rather than refusing.
    assert.deepEqual(await page(h.url, '?kind=trade'), { receipts: [], total: 0, hasMore: false, feesUsd: 0 });
    assert.deepEqual(await page(h.url, '?kind=bot'), { receipts: [], total: 0, hasMore: false, feesUsd: 0 });
    const swapsToday = await page(h.url, `?kind=swap&since=${Date.now() - 24 * HOUR}`);
    assert.deepEqual(swapsToday.receipts.map((r) => r.id), ['h2', 'h20']);
    assert.equal(swapsToday.total, 2);
  } finally {
    await h.close();
  }
});

test('a parameter that cannot be read is refused, never read as no window', async () => {
  const h = await boot(SPREAD);
  try {
    for (const bad of ['?since=yesterday', '?before=-1', '?kind=sandwich']) {
      const out = await get(h.url, `/api/receipts${bad}`);
      assert.equal(out.status, 400, bad);
      assert.ok(typeof (JSON.parse(out.body) as { error: string }).error === 'string');
    }
  } finally {
    await h.close();
  }
});
