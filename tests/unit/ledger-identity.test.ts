// The ledger reads the wallet that exists NOW, not the one that existed at boot.
//
// docs/bugs/2026-09-15-first-deposit-invisible-until-restart.md: on a clean install the ledger
// was built before any wallet existed, captured "no account" once, and never read the verifier
// or the trading account until a restart. The first deposit landed and the app showed $0. Both
// tests here boot exactly that way: an empty keystore registered, a ledger built over it, and
// the wallet created afterwards.
//
// Temp directory throughout, every fetch stubbed. Nothing here reaches a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/types.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { createDepositWatch } from '../../src/vault/watch.ts';
import { createKeystore, useKeystore, walletAddresses } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';

const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PASSWORD = 'a long enough password';
const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function liveConfig(keysPath: string): AppConfig {
  return {
    mode: 'live',
    keysPath,
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir: path.dirname(keysPath),
  };
}

type Seen = { url: string; body: Record<string, unknown> | null };

/* Every venue the live ledger talks to, answered from memory. `holdings` is what the verifier
   says the account holds, in base units; the tests move it to stand in for a deposit landing. */
function fakeWorld(): { fetchImpl: typeof fetch; seen: Seen[]; holdings: Map<string, string> } {
  const seen: Seen[] = [];
  const holdings = new Map<string, string>();
  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response =>
    json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push({ url, body });

    if (url.includes('coinbase.com')) return json([[0, 0, 0, 0, 100, 0]]);
    if (url.endsWith('/v0/tokens')) return json([{ assetId: ETH_USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC' }]);
    if (url.includes('hyperliquid.xyz')) {
      const type = String(body?.type);
      if (type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0', totalMarginUsed: '0' }, withdrawable: '0', assetPositions: [] });
      if (type === 'spotClearinghouseState') return json({ balances: [] });
      return json('standard');
    }
    // The NEAR RPC: the two view calls the verifier read makes.
    const params = (body?.params ?? {}) as { method_name?: string; args_base64?: string };
    const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8') || '{}') as {
      token_ids?: string[];
    };
    if (params.method_name === 'mt_tokens_for_owner') {
      return nearView([...holdings.keys()].map((token_id) => ({ token_id })));
    }
    if (params.method_name === 'mt_batch_balance_of') {
      return nearView((args.token_ids ?? []).map((id) => holdings.get(id) ?? '0'));
    }
    throw new Error(`unexpected request ${url} ${JSON.stringify(body)}`);
  }) as typeof fetch;

  return { fetchImpl, seen, holdings };
}

function verifierReads(seen: Seen[]): string[] {
  return seen
    .filter((s) => s.url.includes('fastnear'))
    .map((s) => {
      const params = (s.body?.params ?? {}) as { args_base64?: string };
      const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8')) as { account_id?: string };
      return String(args.account_id);
    });
}

function tradingReads(seen: Seen[]): string[] {
  return seen.filter((s) => s.url.includes('hyperliquid.xyz')).map((s) => String(s.body?.user));
}

test.afterEach(() => {
  useKeystore(null);
});

test('a wallet created after the ledger was built is read on the next refresh, not the next restart', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ledger-')), 'keys.json');
  // Boot order as in src/main.ts: the empty keystore is registered, then the ledger is built.
  const store = createKeystore({ keysPath, kdf: fast });
  useKeystore(store);
  const world = fakeWorld();
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl });

  await ledger.refresh();
  assert.deepEqual(verifierReads(world.seen), [], 'no wallet: the verifier is not asked about anyone');
  assert.deepEqual(tradingReads(world.seen), [], 'no wallet: the trading account is not asked about either');
  assert.equal(ledger.intents(), undefined, 'not asked is not the same as empty');
  assert.equal(ledger.hyperliquid(), undefined);

  // The person creates the wallet in the window. Nothing tells the ledger.
  await store.importWallet(PASSWORD, { mnemonic: VECTOR });

  await ledger.refresh();
  const account = VECTOR_EVM.toLowerCase();
  assert.deepEqual([...new Set(verifierReads(world.seen))], [account], 'the verifier is now read for the new wallet');
  assert.deepEqual([...new Set(tradingReads(world.seen))], [account], 'and so is the trading account');
  assert.equal(ledger.intents()?.ok, true);
  assert.equal(ledger.hyperliquid()?.account, account);
});

test('the deposit watch lands a deposit for a wallet created after the ledger was built', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ledger-')), 'keys.json');
  const store = createKeystore({ keysPath, kdf: fast });
  useKeystore(store);
  const world = fakeWorld();
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl });
  const frames: Array<{ phase: string; amount: number | null }> = [];
  const watch = createDepositWatch({
    ledger,
    sse: { broadcast: (frame) => frames.push(frame as { phase: string; amount: number | null }) },
    // The same resolver src/server.ts hands the watch: the keystore's header, per call.
    account: () => walletAddresses().evm?.toLowerCase() ?? null,
    refresh: () => ledger.refresh().then(() => undefined),
    recent: async () => [],
    pollMs: 5,
  });

  // The card goes up before the wallet exists, then the wallet is made, then the money lands.
  const shown = watch.show('eth', 'USDC', null);
  assert.equal(shown.baseline, 0);
  await store.importWallet(PASSWORD, { mnemonic: VECTOR });
  world.holdings.set(ETH_USDC, '5000000');

  const deadline = Date.now() + 5_000;
  while (watch.current()?.phase !== 'landed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  watch.stop();

  const landed = watch.current();
  assert.equal(landed?.phase, 'landed', `the watch never saw the deposit: ${JSON.stringify(frames)}`);
  assert.equal(landed?.amount, 5);
  assert.ok(frames.some((f) => f.phase === 'landed' && f.amount === 5), 'the window was told');
});
