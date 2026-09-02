// The hardening pass, driven against a real server over real HTTP.
//
// The guards live on the wire (a Host header, an Origin
// header, the shape of a proposal body), so a unit test of a lifted function would assert the
// function and not the door. Each test below is one of the red-team's confirmed break-ins,
// turned into a test that fails on the old code and passes on the new.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
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

function builtSwap(): Proposal {
  // A stub that stands in for a real draft. The venue and amount guards run BEFORE proposeSwap
  // is called, so a rejected request never reaches this; a request that returns this is one the
  // guards let through.
  return {
    id: 'p-swap',
    kind: 'swap',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: {
      kind: 'swap',
      venue: 'oneclick',
      chain: 'arb',
      toChain: 'sol',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: 100,
      amountUsd: 100,
      minAmountOut: 0.5,
      from: '0xself',
      to: '0xself',
      counterparty: 'oneclick:1click.chaindefuser.com',
      quote: null,
    },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
  };
}

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-sec-'));
  // Play the shell: the window token arrives in the environment, never over a route.
  process.env.PHOSPHOR_WINDOW_TOKEN = crypto.randomBytes(32).toString('hex');
  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
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
      proposeConsolidate: async () => builtSwap(),
      proposePolicyChange: async () => builtSwap(),
      // Only reached when the swap guards pass. A bad venue or amount is refused before here.
      proposeSwap: async () => builtSwap(),
      proposeHlDeposit: async () => builtSwap(),
      proposeIntentsDeposit: async () => builtSwap(),
      proposeIntentsWithdraw: async () => builtSwap(),
      proposeMandate: async () => builtSwap(),
      proposeLpAdd: async () => builtSwap(),
      proposeLpRemove: async () => builtSwap(),
      proposeYieldDeposit: async () => builtSwap(),
      proposeYieldWithdraw: async () => builtSwap(),
      approve: async () => builtSwap(),
      refuse: async () => builtSwap(),
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

// A request with explicit control over Host and Origin, which fetch() will not let a caller set.
function raw(
  urlBase: string,
  route: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers ?? {} },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test('a forged Host is refused on every route, closing DNS-rebinding (Finding 4)', async () => {
  const h = await boot();
  try {
    for (const route of ['/api/state', '/api/trade']) {
      const out = await raw(h.url, route, { headers: { Host: 'evil.com' } });
      assert.equal(out.status, 403, `${route} under a foreign Host must be refused`);
    }
    // The real loopback name still answers.
    const ok = await raw(h.url, '/api/state', { headers: { Host: '127.0.0.1' } });
    assert.equal(ok.status, 200);
  } finally {
    await h.close();
  }
});

test('a cross-origin POST to /api/mcp is refused, closing CSRF (Findings 2 and 3)', async () => {
  const h = await boot();
  try {
    const foreign = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ op: 'read', tool: 'balances' }),
    });
    assert.equal(foreign.status, 403, 'a foreign Origin must not drive the money surface');

    // An Origin naming this app is what a caller has to bring. A browser cannot set the
    // header at all, so this can only be the window or a local process, which is the split.
    const local = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: h.url },
      body: JSON.stringify({ op: 'read', tool: 'start' }),
    });
    assert.notEqual(local.status, 403, 'an Origin naming this app must be allowed');
  } finally {
    await h.close();
  }
});

// The break-in this closes: a page embeds <iframe sandbox="allow-scripts">, which gives its
// script an opaque origin, so its fetch sends the literal string 'null'. Host is really
// 127.0.0.1 because the browser really dialled loopback. The old sameOrigin allowed 'null',
// and /api/mcp carries no token, so one POST proposed a swap and the policy engine executed
// it under the click threshold.
test('an opaque Origin cannot reach the money surface (P0-2)', async () => {
  const h = await boot();
  try {
    const sandboxed = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'null' },
      body: JSON.stringify({ op: 'read', tool: 'balances' }),
    });
    assert.equal(sandboxed.status, 403, 'the literal null Origin must be refused');

    const headless = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', tool: 'balances' }),
    });
    assert.equal(headless.status, 403, 'an absent Origin must be refused too');
  } finally {
    await h.close();
  }
});

// text/plain, multipart/form-data and application/x-www-form-urlencoded are the three types a
// page can post cross-origin with no preflight. Refusing everything but application/json means
// a cross-origin post has to ask first, and this app answers no CORS headers.
test('a body that is not application/json is refused with 415', async () => {
  const h = await boot();
  try {
    const plain = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', Origin: h.url },
      body: JSON.stringify({ op: 'read', tool: 'balances' }),
    });
    assert.equal(plain.status, 415);

    const form = await raw(h.url, '/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: h.url },
      body: 'id=x&token=y',
    });
    assert.equal(form.status, 415);
  } finally {
    await h.close();
  }
});

test('a cross-chain swap that names no venue is refused with the venue to use (S3, the reported bug)', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: h.url },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 100, minAmountOut: 0.5 },
      }),
    });
    assert.equal(out.status, 400);
    assert.match(out.body, /uniswap-v3 is a same-chain venue/);
    assert.match(out.body, /oneclick|intents-native/);
  } finally {
    await h.close();
  }
});

test('the same cross-chain swap with venue oneclick passes the guard and builds', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: h.url },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 100, minAmountOut: 0.5, venue: 'oneclick' },
      }),
    });
    assert.equal(out.status, 200, 'a named cross-chain venue must not be refused by the guard');
  } finally {
    await h.close();
  }
});

test('a negative amountIn is refused at the edge, never reaching the USD math (Finding 8)', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: h.url },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: -5, minAmountOut: 0 },
      }),
    });
    assert.equal(out.status, 400);
    assert.match(out.body, /amountIn must be greater than 0/);
  } finally {
    await h.close();
  }
});

// P0-1, the hole the product was named after. GET /api/session handed the approval token to any
// process on loopback, so a curl of it followed by a POST to /api/approve executed a pending
// proposal and wrote decidedBy: 'human' beside it. The token now arrives in the environment
// from the shell that owns the window, and this walks the whole GET surface to prove nothing
// hands it back.
test('no route serves the window token (P0-1)', async () => {
  const h = await boot();
  try {
    const gone = await raw(h.url, '/api/session', { headers: { Origin: h.url } });
    assert.equal(gone.status, 404, 'GET /api/session must not exist');

    const routes = [
      '/api/state',
      '/api/chart',
      '/api/log',
      '/api/transactions',
      '/api/gas',
      '/api/trade',
      '/api/driver',
    ];
    const token = process.env.PHOSPHOR_WINDOW_TOKEN ?? '';
    for (const route of routes) {
      const out = await raw(h.url, route, { headers: { Origin: h.url } });
      assert.ok(token.length > 0 && !out.body.includes(token), `${route} echoes the window token`);
      assert.doesNotMatch(out.body, /"token"\s*:\s*"[^"]/, `${route} carries a token field`);
    }
  } finally {
    await h.close();
  }
});

// ---------- amount bounds at the edge ----------
//
// numField accepted any finite number, so a negative or a 1e308 amount reached
// proposeHlDeposit, proposeIntentsDeposit, proposeIntentsWithdraw and all four mandate ceilings.
// Only swap and yield_deposit had a `> 0` check. The mandate numbers never pass through
// TransferLeg, so nothing downstream re-checked them: a negative maxLossUsd is a bot with no
// loss limit, and a negative amount is a NEGATIVE spend that makes the day's cap look emptier.

const BAD_AMOUNTS: Array<[string, number]> = [
  ['zero', 0],
  ['negative', -100],
  ['1e308', 1e308],
];

async function proposeWith(url: string, kind: string, params: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return raw(url, '/api/mcp', {
    method: 'POST',
    /* Origin as well as Content-Type. sameOrigin() refuses a write with an ABSENT Origin, which
       closes the door where any local process could claim to be "a local tool, not a browser".
       Origin is a forbidden header name, so no page can set it: a matching one can only come
       from a page this app served or from a local process that chose to send it. */
    headers: { 'content-type': 'application/json', origin: new URL(url).origin },
    body: JSON.stringify({ op: 'propose', kind, params }),
  });
}

for (const [label, amount] of BAD_AMOUNTS) {
  test(`a ${label} amount is refused on every propose kind that takes one`, async () => {
    const h = await boot();
    try {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['hl_deposit', { chain: 'arb', symbol: 'USDC', amount }],
        ['intents_deposit', { chain: 'arb', symbol: 'USDC', amount }],
        ['intents_withdraw', { chain: 'arb', symbol: 'USDC', amount }],
        ['swap', { chain: 'arb', toChain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: amount, minAmountOut: 1 }],
        ['yield_deposit', { chain: 'arb', symbol: 'USDC', amount }],
        ['lp_remove', { positionId: '1', liquidityPct: amount }],
      ];
      for (const [kind, params] of cases) {
        const out = await proposeWith(h.url, kind, params);
        assert.equal(out.status, 400, `${kind} accepted a ${label} amount: ${out.body.slice(0, 200)}`);
        assert.match(out.body, /must be (greater than 0|a finite number)|larger than this app can represent/, `${kind}: ${out.body.slice(0, 200)}`);
      }
    } finally {
      await h.close();
    }
  });
}

for (const [label, value] of BAD_AMOUNTS) {
  test(`a ${label} value is refused on every mandate ceiling`, async () => {
    const h = await boot();
    try {
      const good = {
        symbol: 'ETH',
        maxNotionalUsd: 50,
        maxLeverage: 2,
        maxOrdersPerMin: 4,
        maxLossUsd: 10,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        allowedActions: ['open'],
        program: { symbol: 'ETH', rules: [] },
      };
      for (const field of ['maxNotionalUsd', 'maxLeverage', 'maxOrdersPerMin', 'maxLossUsd']) {
        const out = await proposeWith(h.url, 'mandate_arm', { ...good, [field]: value });
        assert.equal(out.status, 400, `mandate_arm accepted a ${label} ${field}: ${out.body.slice(0, 200)}`);
        assert.match(out.body, new RegExp(`${field} (must be|is larger than)`), out.body.slice(0, 200));
      }
    } finally {
      await h.close();
    }
  });
}

test('an unknown chain is refused rather than silently drafted against ethereum', async () => {
  const h = await boot();
  try {
    // chainField used to return 'eth' as its sentinel. Every caller checks problems.length
    // first, so it was latent; the point of returning null is that the next branch that forgets
    // cannot spend on the wrong chain.
    const out = await proposeWith(h.url, 'intents_deposit', { chain: 'polygon', symbol: 'USDC', amount: 10 });
    assert.equal(out.status, 400);
    assert.match(out.body, /chain must be one of/);
    assert.doesNotMatch(out.body, /"id"/, 'no proposal was created');
  } finally {
    await h.close();
  }
});

test('a good amount still gets through, so the bound is a bound and not a wall', async () => {
  const h = await boot();
  try {
    const out = await proposeWith(h.url, 'intents_deposit', { chain: 'arb', symbol: 'USDC', amount: 10 });
    assert.equal(out.status, 200, out.body.slice(0, 200));
  } finally {
    await h.close();
  }
});

// ---------- /api/health ----------
//
// The only unauthenticated GET that proved the app was up used to be /api/session, which answered
// by handing out the approval token. "Is Phosphor running" and "take control of Phosphor" were
// the same request, so any supervisor or shell script that wanted the first reached for the
// second. This one carries no credential and no secret, which is what makes it usable.

test('health answers without a token and in the shape the spec fixes', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/health');
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      'killSwitch',
      'lastError',
      'locked',
      'ok',
      'pending',
      'uptimeSec',
      'version',
    ]);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.killSwitch, 'boolean');
    assert.equal(typeof body.pending, 'number');
    assert.equal(typeof body.locked, 'boolean');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.ok(body.uptimeSec as number >= 0);
    assert.equal(body.lastError, null);
  } finally {
    await h.close();
  }
});

test('health names no secret, no token and no balance', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/health');
    // The whole body, not a field list: a future addition that leaks has to fail something.
    for (const forbidden of ['token', 'key', 'secret', 'address', 'holdings', 'balance', 'mnemonic']) {
      assert.doesNotMatch(out.body.toLowerCase(), new RegExp(forbidden), `health mentioned ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('health is a GET only', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(out.status, 404, 'nothing on this route writes anything');
  } finally {
    await h.close();
  }
});

test('a forged Host cannot reach health either', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/health', { headers: { Host: 'evil.com' } });
    assert.equal(out.status, 403);
  } finally {
    await h.close();
  }
});
