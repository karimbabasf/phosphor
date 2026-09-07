// What rides on /api/state, and what does not.
//
// The state payload used to carry EVERY proposal the data directory had ever held. Measured on a
// demo instance: 14.4 KB with none, 216 KB at 200, 1027 KB at 1000, of which the proposals key was
// 1014 KB. The window reads that list filtered to pending in two places and renders at most two
// cards from it, so 98% of the biggest response in the app was history nothing drew.
//
// The rule now: nothing unbounded rides on /api/state. The payload is a fixed-size snapshot, the
// history is paged behind /api/proposals, and the assertion that keeps it that way is the size
// one below. It is a size test on purpose: a key added later that grows with use fails it.

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
import {
  PROPOSAL_PAGE_DEFAULT,
  PROPOSAL_PAGE_MAX,
  STATE_DECIDED_BYTES,
  STATE_DECIDED_KEPT,
} from '../../src/http/state.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition, Proposal, ProposalStatus } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const SELF = '0x1111111111111111111111111111111111111111';

/* One snapshot object, handed back by reference, because that is what the real ledger does:
   src/ledger/index.ts holds `current` and replaces it on refresh. The state cache keys off that
   identity, so a harness that built a fresh object per call would be testing a ledger no install
   has. */
function buildSnapshot(): LedgerSnapshot {
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

const SNAPSHOT = buildSnapshot();
const snapshot = (): LedgerSnapshot => SNAPSHOT;

/* A row the size of a real one. The point of the size assertion is lost against a stub: a real
   proposal carries a draft, a simulation with its quote echo, a verdict and a result, which is
   why one of them is about a kilobyte. */
function row(id: string, status: ProposalStatus, ageMin: number): Proposal {
  const at = new Date(Date.now() - ageMin * 60_000).toISOString();
  return {
    id,
    kind: 'swap',
    createdAt: at,
    decidedAt: at,
    decidedBy: 'human',
    status,
    draft: {
      kind: 'swap',
      chain: 'base',
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amountUsd: 100,
      to: '0x' + 'a'.repeat(40),
      venue: 'oneclick',
      minAmountOut: '1000000000000000',
      quoteRequest: { originAsset: 'nep141:base.omft.near', destinationAsset: 'nep141:eth.omft.near', amount: '100000000' },
    } as unknown as Proposal['draft'],
    simulation: {
      ok: true,
      summary: 'swap 100 USDC for WETH on base through oneclick',
      destinations: ['0x' + 'a'.repeat(40)],
      postComposition: { byIssuer: { circle: 0.8, other: 0.2 }, freezableShare: 0.8 },
    } as unknown as Proposal['simulation'],
    verdict: { outcome: 'ask', reasons: ['It is above the $50 you said to ask about.'] } as unknown as Proposal['verdict'],
    result: { ok: true, detail: 'the rail said what it did', txids: ['0x' + 'b'.repeat(64)] },
    balances: { beforeUsd: 1_000, afterUsd: 900 },
  } as unknown as Proposal;
}

/* How many times the state build has read the proposal store. buildState is the only thing in
   this harness that calls list(), so this counts builds, which is what the cache tests below
   assert on: a cached answer reads nothing. */
let builds = 0;

async function boot(proposals: Proposal[]): Promise<{ url: string; store: ReturnType<typeof createStore>; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-state-payload-'));
  // Seeded as a file rather than through a thousand put() calls: the store rewrites the whole
  // array on every put, so seeding through it is quadratic and measures the wrong thing.
  fs.writeFileSync(path.join(dataDir, 'proposals.json'), JSON.stringify(proposals, null, 2));
  const store = createStore(dataDir);

  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: [SELF], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const settled = row('stub', 'executed', 0);
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store,
    riskRows: [],
    ledger: {
      snapshot,
      positions: (): LpPosition[] => [],
      intents: () => undefined,
      refresh: async () => SNAPSHOT,
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
      proposeConsolidate: async () => settled,
      proposePolicyChange: async () => settled,
      proposeSwap: async () => settled,
      proposeHlDeposit: async () => settled,
      proposeIntentsDeposit: async () => settled,
      proposeIntentsWithdraw: async () => settled,
      proposeMandate: async () => settled,
      proposeLpAdd: async () => settled,
      proposeLpRemove: async () => settled,
      proposeYieldDeposit: async () => settled,
      proposeYieldWithdraw: async () => settled,
      approve: async () => settled,
      refuse: async () => settled,
      get: (id: string) => store.get(id),
      list: () => {
        builds += 1;
        return store.list();
      },
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
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  builds = 0;
  return { url: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => server.close(() => r())) };
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

async function state(urlBase: string): Promise<{ bytes: number; proposals: Proposal[] }> {
  const out = await get(urlBase, '/api/state');
  assert.equal(out.status, 200);
  return { bytes: out.body.length, proposals: (JSON.parse(out.body) as { proposals: Proposal[] }).proposals };
}

async function page(urlBase: string, query = ''): Promise<{ status: number; proposals: Proposal[]; nextBefore: string | null }> {
  const out = await get(urlBase, `/api/proposals${query}`);
  if (out.status !== 200) return { status: out.status, proposals: [], nextBefore: null };
  const body = JSON.parse(out.body) as { proposals: Proposal[]; nextBefore: string | null };
  return { status: out.status, proposals: body.proposals, nextBefore: body.nextBefore };
}

function history(decided: number, extra: Proposal[] = []): Proposal[] {
  const rows: Proposal[] = [];
  for (let i = 0; i < decided; i += 1) rows.push(row(`d-${i}`, 'executed', decided - i));
  return [...rows, ...extra];
}

// The one that keeps the payload honest as a data directory ages.
test('the state payload for a thousand decided proposals is under twenty kilobytes', async () => {
  const h = await boot(history(1000));
  try {
    const out = await state(h.url);
    assert.ok(
      out.bytes < 20 * 1024,
      `the state payload was ${(out.bytes / 1024).toFixed(1)} KB with 1000 decided proposals behind it`,
    );
  } finally {
    await h.close();
  }
});

test('every proposal still waiting on someone rides on state, however old the history is', async () => {
  const waiting = [
    row('w-pending', 'pending', 500),
    row('w-unlock', 'pending_unlock', 400),
    row('w-reconcile', 'needs_reconciliation', 300),
  ];
  const h = await boot(history(1000, waiting));
  try {
    const out = await state(h.url);
    const ids = out.proposals.map((p) => p.id);
    for (const p of waiting) assert.ok(ids.includes(p.id), `${p.id} (${p.status}) was not on the state payload`);
  } finally {
    await h.close();
  }
});

/* The decided rows that stay are the newest ones, and they stop for one of exactly two stated
   reasons: twenty of them, or the byte budget. A count alone does not bound bytes, because a
   proposal is not a fixed size. */
test('state carries the most recent decided rows, up to the count and up to the budget', async () => {
  const h = await boot(history(1000));
  try {
    const out = await state(h.url);
    assert.ok(out.proposals.length > 0, 'something recent is still shown');
    assert.ok(out.proposals.length <= STATE_DECIDED_KEPT, `${out.proposals.length} rows is over the ceiling`);

    // Contiguous and newest: d-999 back, with nothing skipped.
    const nums = out.proposals.map((p) => Number(p.id.slice(2)));
    assert.equal(nums[nums.length - 1], 999, 'the newest decided row is the last one');
    for (let i = 1; i < nums.length; i += 1) assert.equal(nums[i], nums[i - 1] + 1);

    const bytes = out.proposals.reduce((sum, p) => sum + JSON.stringify(p).length, 0);
    const stoppedOnCount = out.proposals.length === STATE_DECIDED_KEPT;
    assert.ok(stoppedOnCount || bytes >= STATE_DECIDED_BYTES, `stopped at ${out.proposals.length} rows and ${bytes} bytes for no stated reason`);
  } finally {
    await h.close();
  }
});

/* The order the window reads. ui/screens/decision.js takes pending[0] out of the filtered list and
   ui/screens/shell.js counts the same filter, so the rows that survive the trim have to keep the
   order the store wrote them in. A trim that reversed them would silently change which proposal
   the person is asked about first. */
test('the rows that survive keep the order the store wrote them in', async () => {
  const h = await boot(history(40, [row('w-1', 'pending', 20), row('w-2', 'pending', 10)]));
  try {
    const out = await state(h.url);
    const ids = out.proposals.map((p) => p.id);
    assert.deepEqual(ids.slice(-2), ['w-1', 'w-2'], 'the two pending rows are last, as the store wrote them');
    const decided = ids.filter((id) => id.startsWith('d-')).map((id) => Number(id.slice(2)));
    assert.equal(decided[decided.length - 1], 39, 'the newest decided row is the last decided one');
    for (let i = 1; i < decided.length; i += 1) assert.equal(decided[i], decided[i - 1] + 1, 'ascending, and nothing skipped');
  } finally {
    await h.close();
  }
});

test('the paged route answers the whole history, newest first', async () => {
  const h = await boot(history(120));
  try {
    const first = await page(h.url, '?limit=50');
    assert.equal(first.status, 200);
    assert.equal(first.proposals.length, 50);
    assert.equal(first.proposals[0].id, 'd-119', 'newest first');
    assert.equal(first.proposals[49].id, 'd-70');
    assert.equal(first.nextBefore, 'd-70');

    const second = await page(h.url, '?limit=50&before=d-70');
    assert.equal(second.proposals[0].id, 'd-69');
    assert.equal(second.proposals.length, 50);

    const third = await page(h.url, '?limit=50&before=d-20');
    assert.equal(third.proposals.length, 20, 'the last page is short');
    assert.equal(third.nextBefore, null, 'and says there is nothing after it');
  } finally {
    await h.close();
  }
});

test('the page size is capped, defaulted and refuses a cursor it has never seen', async () => {
  const h = await boot(history(300));
  try {
    const capped = await page(h.url, '?limit=5000');
    assert.equal(capped.proposals.length, PROPOSAL_PAGE_MAX);

    const defaulted = await page(h.url, '');
    assert.equal(defaulted.proposals.length, PROPOSAL_PAGE_DEFAULT);

    const bad = await get(h.url, '/api/proposals?before=nothing-by-that-name');
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error as string, /nothing-by-that-name/);
  } finally {
    await h.close();
  }
});

/* The gate is the Host header, exactly as it is for every other read on this surface. A forged
   Host is how a page on the internet would otherwise rebind its own domain to 127.0.0.1 and read
   the whole proposal history as same-origin. */
test('the paged route refuses a forged Host like every other read', async () => {
  const h = await boot(history(10));
  try {
    const u = new URL(h.url);
    const out = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: '/api/proposals', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(out.status, 403);
  } finally {
    await h.close();
  }
});

/* ---------- how often the payload is built ----------

   The body and its ETag used to be built BEFORE the if-none-match comparison, so a 304 cost the
   server everything a 200 did and saved only the wire and the browser's redraw. Measured at 1000
   proposals: 4.49 ms on the 304 path against 4.66 ms on the 200 path. With a trading feed live the
   hub can push 8.3 state frames a second, so that was about 37 ms of blocked event loop every
   second, permanently, on a payload that had not changed.

   The build is cached behind the things it reads: the store's revision, the audit's line count,
   the lock state and the ledger snapshot's identity, plus a one second ceiling for the handful of
   inputs with no hook (the price poll, the lending view, the idle countdown). */

function getWithEtag(urlBase: string, etag: string): Promise<{ status: number; body: string; etag: string | null }> {
  const u = new URL(urlBase + '/api/state');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'if-none-match': etag } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d, etag: res.headers.etag ?? null }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('two reads with nothing changed build the payload once', async () => {
  const h = await boot(history(50));
  try {
    const first = await get(h.url, '/api/state');
    const after = builds;
    assert.equal(after, 1, 'the first read builds');
    const second = await get(h.url, '/api/state');
    assert.equal(builds, after, 'the second read did not touch the store');
    assert.equal(second.body, first.body, 'and answered the same bytes');
  } finally {
    await h.close();
  }
});

test('a 304 costs no build either, which is what it used to cost', async () => {
  const h = await boot(history(50));
  try {
    const first = await getWithEtag(h.url, 'a tag from nowhere');
    assert.equal(first.status, 200);
    assert.equal(builds, 1, 'the first read builds');

    const tagged = await getWithEtag(h.url, first.etag ?? '');
    assert.equal(tagged.status, 304, "a read carrying the answer's own tag is a 304");
    assert.equal(tagged.body, '', 'and carries no body');
    assert.equal(builds, 1, 'and built nothing to work that out');
  } finally {
    await h.close();
  }
});

test('a store write invalidates the cached body', async () => {
  const h = await boot(history(50));
  try {
    await get(h.url, '/api/state');
    assert.equal(builds, 1);

    h.store.put(row('w-new', 'pending', 0));
    const after = await get(h.url, '/api/state');
    assert.equal(builds, 2, 'a write to the store is a rebuild');
    const ids = (JSON.parse(after.body) as { proposals: Proposal[] }).proposals.map((p) => p.id);
    assert.ok(ids.includes('w-new'), 'and the new row is in what came back');
  } finally {
    await h.close();
  }
});
