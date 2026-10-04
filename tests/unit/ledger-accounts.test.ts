// The ledger keeps one verifier read per account (PHASE2-PLAN.md C6).
//
// Under kind key the vault is the one account, read once a pass, and intents() is that read, as it
// always was. Once the vault has moved to the chip the rails spend the allowance, so the allowance
// is read beside the vault: intents() carries both, every row naming its account, reads() hands
// each one apart, each keeps its own misses, and the trading account is still the vault's.
//
// Every fetch stubbed, a stand-in keystore for the address. Nothing here reaches a network.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from '../../src/types.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { intentsUnreadWhy } from '../../src/ledger/intents.ts';
import { useRailAccounts } from '../../src/intents-sign.ts';
import type { RailAccounts } from '../../src/intents-sign.ts';
import { useKeystore } from '../../src/keystore/index.ts';
import type { Keystore } from '../../src/keystore/index.ts';

const VAULT = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const ALLOWANCE = '0xf6beee2877dc58331cfa06c66cc47b5f2535a379';
const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const WNEAR = 'nep141:wrap.near';

const cfg = { mode: 'live', keysPath: '/nonexistent/keys.json', port: 4177, addresses: {}, candleProducts: ['BTC-USD'], dataDir: '/nonexistent' } as AppConfig;

type World = {
  fetchImpl: typeof fetch;
  // What the verifier holds per account, in base units, and the accounts it was asked about.
  held: Map<string, Map<string, string>>;
  down: Set<string>;
  asked: string[];
  hlUsers: string[];
};

function fakeWorld(): World {
  const world: World = { fetchImpl: fetch, held: new Map(), down: new Set(), asked: [], hlUsers: [] };
  const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response => json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  world.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.includes('coinbase.com')) return json([[0, 0, 0, 0, 100, 0]]);
    if (url.endsWith('/v0/tokens')) {
      return json([
        { assetId: ETH_USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC' },
        { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR' },
      ]);
    }
    if (url.includes('hyperliquid.xyz')) {
      if (typeof body?.user === 'string') world.hlUsers.push(body.user.toLowerCase());
      const type = String(body?.type);
      if (type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0', totalMarginUsed: '0' }, withdrawable: '0', assetPositions: [] });
      if (type === 'spotClearinghouseState') return json({ balances: [] });
      return json('standard');
    }
    const params = (body?.params ?? {}) as { method_name?: string; args_base64?: string };
    const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8') || '{}') as { account_id?: string; token_ids?: string[] };
    const account = String(args.account_id);
    if (world.down.has(account)) return json({ error: 'service unavailable' }, 503);
    const holdings = world.held.get(account) ?? new Map<string, string>();
    if (params.method_name === 'mt_tokens_for_owner') {
      world.asked.push(account);
      return nearView([...holdings.keys()].map((token_id) => ({ token_id })));
    }
    if (params.method_name === 'mt_batch_balance_of') return nearView((args.token_ids ?? []).map((id) => holdings.get(id) ?? '0'));
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return world;
}

function useAccounts(accounts: RailAccounts): void {
  useKeystore({ addresses: () => ({ evm: VAULT, solana: null, near: null, nearPublicKey: null }) } as unknown as Keystore);
  useRailAccounts(() => accounts);
}

test.afterEach(() => {
  useKeystore(null);
  useRailAccounts(null);
});

test('kind key: the vault is read once a pass and intents() is that read, as before', async () => {
  const world = fakeWorld();
  world.held.set(VAULT, new Map([[ETH_USDC, '1850000000']]));
  useAccounts({ kind: 'key', vault: VAULT, spend: VAULT });
  const ledger = createLedger(cfg, { fetchImpl: world.fetchImpl, log: () => {} });
  await ledger.refresh();
  assert.deepEqual(world.asked, [VAULT]);
  const read = ledger.intents();
  assert.equal(read?.ok, true);
  assert.deepEqual(read?.holdings.map((h) => [h.accountId, h.symbol, h.amountBase]), [[VAULT, 'USDC', '1850000000']]);
  const reads = ledger.reads?.();
  assert.equal(reads?.vault?.account, VAULT);
  assert.equal(reads?.spend?.account, VAULT);
  assert.equal(reads?.spend?.read, read, 'one account, one read');
  assert.deepEqual(world.hlUsers.filter((u, i, all) => all.indexOf(u) === i), [VAULT]);
});

test('kind chip: the allowance is read beside the vault, intents() carries both, reads() hands each apart, the trading account stays the vault', async () => {
  const world = fakeWorld();
  world.held.set(VAULT, new Map([[ETH_USDC, '1850000000']]));
  world.held.set(ALLOWANCE, new Map([[ETH_USDC, '100000000'], [WNEAR, '2000000000000000000000000']]));
  useAccounts({ kind: 'chip', vault: VAULT, spend: ALLOWANCE });
  const ledger = createLedger(cfg, { fetchImpl: world.fetchImpl, log: () => {} });
  await ledger.refresh();
  assert.deepEqual([...world.asked].sort(), [ALLOWANCE, VAULT].sort());

  const read = ledger.intents();
  assert.equal(read?.ok, true);
  assert.deepEqual(
    read?.holdings.map((h) => [h.accountId, h.symbol, h.amountBase]),
    [
      [VAULT, 'USDC', '1850000000'],
      [ALLOWANCE, 'USDC', '100000000'],
      [ALLOWANCE, 'wNEAR', '2000000000000000000000000'],
    ],
  );
  const reads = ledger.reads?.();
  assert.equal(reads?.vault?.account, VAULT);
  assert.deepEqual(reads?.vault?.read?.holdings.map((h) => h.amountBase), ['1850000000']);
  assert.equal(reads?.spend?.account, ALLOWANCE);
  assert.deepEqual(reads?.spend?.read?.holdings.map((h) => h.symbol), ['USDC', 'wNEAR']);
  assert.deepEqual(world.hlUsers.filter((u, i, all) => all.indexOf(u) === i), [VAULT], 'every Hyperliquid read names the vault');
});

test('kind chip: an allowance read that fails keeps its own last holdings and its own count, says which, and marks the whole read', async () => {
  const world = fakeWorld();
  world.held.set(VAULT, new Map([[ETH_USDC, '1850000000']]));
  world.held.set(ALLOWANCE, new Map([[ETH_USDC, '100000000']]));
  useAccounts({ kind: 'chip', vault: VAULT, spend: ALLOWANCE });
  const logged: string[] = [];
  const ledger = createLedger(cfg, { fetchImpl: world.fetchImpl, log: (line) => logged.push(line) });
  await ledger.refresh();

  world.down.add(ALLOWANCE);
  await ledger.refresh();
  const reads = ledger.reads?.();
  assert.equal(reads?.vault?.read?.ok, true);
  assert.equal(reads?.vault?.read?.failures, 0);
  assert.equal(reads?.spend?.read?.ok, false);
  assert.equal(reads?.spend?.read?.failures, 1);
  assert.deepEqual(reads?.spend?.read?.holdings.map((h) => h.amountBase), ['100000000'], 'the last good allowance holdings stay');
  assert.match(logged[0] ?? '', /the verifier read for the allowance failed .*, 1 in a row/);
  const merged = ledger.intents();
  assert.equal(merged?.ok, false, 'a pocket nobody could read is not hidden behind one that answered');
  assert.equal(merged?.holdings.length, 2);
  assert.equal(intentsUnreadWhy(merged!), null, 'one miss is a miss');
  await ledger.refresh();
  assert.notEqual(intentsUnreadWhy(ledger.intents()!), null, 'two in a row are worth saying');
});

test('kind chip before this process has opened the wallet: the vault alone is read and the allowance is named as unknown', async () => {
  const world = fakeWorld();
  world.held.set(VAULT, new Map([[ETH_USDC, '1850000000']]));
  useAccounts({ kind: 'chip', vault: VAULT, spend: null });
  const ledger = createLedger(cfg, { fetchImpl: world.fetchImpl, log: () => {} });
  await ledger.refresh();
  assert.deepEqual(world.asked, [VAULT]);
  assert.deepEqual(ledger.intents()?.holdings.map((h) => h.accountId), [VAULT]);
  assert.equal(ledger.reads?.()?.spend, null);
});
