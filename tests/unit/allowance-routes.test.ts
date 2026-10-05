// The allowance's two window routes (PHASE2-PLAN.md C9) and the state slice the window reads.
//
// Both routes are custody writes: the window token or nothing, the knock logged, and neither is an
// op on /api/mcp or a tool in src/mcp.ts, so the agent can never fill or size its own allowance.
//
// Run: node --test tests/unit/allowance-routes.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { useRailAccounts } from '../../src/intents-sign.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { AppConfig, LedgerSnapshot, Proposal, VaultTopUpParams } from '../../src/types.ts';
import { allowanceState } from '../../src/vault/allowance.ts';
import { stubView } from '../fixtures/view.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWANCE = '0xf6beee2877dc58331cfa06c66cc47b5f2535a379';
const VAULT = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';

function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

async function boot() {
  const dataDir = tempDir('phosphor-allowance-routes-');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const cfg: AppConfig = { mode: 'demo', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const audit = createAudit(dataDir);
  const asked: VaultTopUpParams[] = [];
  const sweeps: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const server = createServer({
    cfg,
    audit,
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposePolicyChange: unused,
      proposeSwap: unused,
      proposeHlDeposit: unused,
      proposeHlWithdraw: unused,
      proposeSend: unused,
      proposeTrade: unused,
      proposeTradeChange: unused,
      async proposeVaultTopUp(params) {
        asked.push(params);
        if (params.usd > 100) throw new Error('Your allowance can take at most $100.00 more right now, or the extra goes straight back to your vault. Nothing changed.');
        return { id: 'p-top-up', kind: 'vault_top_up', status: 'pending' } as Proposal;
      },
      async sweepAllowance(why) {
        sweeps.push(why);
        return null;
      },
      approve: unused,
      refuse: unused,
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: unused,
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { token, audit, dataDir, asked, sweeps, post, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('a top-up from the window: the token or nothing, the knock logged, and what the service files comes back', async () => {
  const b = await boot();
  try {
    const refused = await b.post('/api/vault/allowance/top-up', { usd: 5 });
    assert.equal(refused.status, 403);
    assert.deepEqual(b.asked, [], 'nothing was filed without the window token');
    assert.ok(b.audit.tail(5).some((e) => e.type === 'approve_attempt_rejected' && String(e.msg).includes('/api/vault/allowance/top-up')));

    const filed = await b.post('/api/vault/allowance/top-up', { token: b.token, usd: 5, why: 'low' });
    assert.equal(filed.status, 200, JSON.stringify(filed.json));
    assert.deepEqual([filed.json.ok, filed.json.proposal.id, filed.json.proposal.status], [true, 'p-top-up', 'pending']);
    assert.deepEqual(b.asked, [{ usd: 5, why: 'low' }]);

    const odd = await b.post('/api/vault/allowance/top-up', { token: b.token, usd: 5, why: 'shortfall' });
    assert.equal(odd.status, 200);
    assert.deepEqual(b.asked.at(-1), { usd: 5, why: 'manual' }, 'a window never files a shortfall: only a move the person approved does');

    const big = await b.post('/api/vault/allowance/top-up', { token: b.token, usd: 500 });
    assert.equal(big.status, 400);
    assert.match(big.json.error, /can take at most \$100\.00 more right now/);
    for (const usd of ['5', null, Number.NaN]) {
      const bad = await b.post('/api/vault/allowance/top-up', { token: b.token, usd });
      assert.equal(bad.status, 400, String(usd));
    }
  } finally {
    await b.close();
  }
});

test('the size from the window: the token or nothing, kept in vault.json, logged, and the sweep asked at once', async () => {
  const b = await boot();
  try {
    assert.equal((await b.post('/api/vault/allowance/size', { usd: 1 })).status, 403);
    assert.deepEqual(b.sweeps, []);
    const set = await b.post('/api/vault/allowance/size', { token: b.token, usd: 12.345 });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.deepEqual(set.json, { ok: true, sizeUsd: 12.35 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(b.dataDir, 'vault.json'), 'utf8')).allowance.sizeUsd, 12.35);
    assert.deepEqual(b.sweeps, ['size']);
    assert.ok(b.audit.tail(5).some((e) => e.msg === 'the allowance size is now $12.35 (it was $100.00)'));
    for (const usd of [-1, 2_000_000, '7']) assert.equal((await b.post('/api/vault/allowance/size', { token: b.token, usd })).status, 400, String(usd));
  } finally {
    await b.close();
  }
});

test('the agent has no door to the allowance: no op on /api/mcp and no tool names a top-up or a size', () => {
  for (const file of ['src/http/mcp.ts', 'src/mcp.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /top[_-]?up|vault_top_up|allowance\/|setAllowanceSize|proposeVaultTopUp|sweepAllowance/i, file);
  }
  const router = fs.readFileSync(path.join(ROOT, 'src', 'http', 'router.ts'), 'utf8');
  const lines = router.split('\n').filter((l) => l.includes('/api/vault/allowance/'));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => /handleAllowance(TopUp|Size)\(ctx, req, res\)/.test(l)));
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'http', 'allowance.ts'), 'utf8');
  assert.equal((routes.match(/await guarded\(ctx, '\/api\/vault\/allowance\/(top-up|size)', req, res\)/g) ?? []).length, 2, 'both carry the window token');
});

test('the state slice: null before the vault moves, then the allowance, its size and what the wallet panel values it at', () => {
  const holdings = [
    { accountId: ALLOWANCE, assetId: 'nep141:usdc', symbol: 'USDC', originChain: 'near', amount: 63, amountBase: '63000000', decimals: 6 },
    { accountId: VAULT, assetId: 'nep141:usdc', symbol: 'USDC', originChain: 'near', amount: 1850, amountBase: '1850000000', decimals: 6 },
  ];
  const ctx = (ok: boolean) => ({
    cfg: { keysPath: '/nowhere' },
    keystore: { derivedAccounts: () => ({ allowance: '0xF6BEEE2877DC58331cFa06c66Cc47B5F2535A379' as const, gas: 'e4d6' }) },
    vaultPrefs: { get: () => ({ allowance: { sizeUsd: 100 } }) },
    ledger: { snapshot: () => ({ ...loadDemoLedger(), mode: 'live' as const }), intents: () => ({ ok, holdings, fetchedAt: new Date().toISOString() }) },
  });
  try {
    useRailAccounts(() => ({ kind: 'key', vault: VAULT, spend: VAULT }));
    assert.equal(allowanceState(ctx(true)), null, 'kind key: no allowance in use');
    useRailAccounts(() => ({ kind: 'chip', vault: VAULT, spend: ALLOWANCE }));
    assert.deepEqual(allowanceState(ctx(true)), { account: ALLOWANCE, sizeUsd: 100, balanceUsd: 63 }, 'the vault\'s 1,850 is not the allowance\'s');
    assert.deepEqual(allowanceState(ctx(false)), { account: ALLOWANCE, sizeUsd: 100, balanceUsd: null }, 'a failed read is unknown, never zero');
    assert.equal(allowanceState({ ...ctx(true), keystore: { derivedAccounts: () => null } }), null, 'no account to name before the wallet opens');
  } finally {
    useRailAccounts(null);
  }
});
