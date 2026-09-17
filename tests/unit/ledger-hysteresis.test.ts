// One missed verifier read is a miss, not a warning.
//
// The Money card said "Could not check NEAR Intents" on and off, every few seconds, for a
// wallet the verifier was answering fine: the ledger was being refreshed by two loops at once,
// one read in twenty failed or answered late, and the wallet report marked the verifier stale
// off whichever read had written last. Three rules close that, and each has a test here:
//
//   - a failed read keeps the last good holdings and their stamp, counts the miss, and logs
//     why, once; the wallet report waits for two misses in a row before it says unread;
//   - a read that answers after a newer one has already written is dropped, so the last answer
//     to arrive can never put an older balance on screen;
//   - holdings nobody has re-read for two idle periods are unread even when the last read was
//     fine, because a number nobody is refreshing is not a number to act on.
//
// Temp directory throughout, every fetch stubbed. Nothing here reaches a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/types.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { INTENTS_UNREAD_AFTER_MS, intentsUnreadWhy } from '../../src/ledger/intents.ts';
import { buildWallet } from '../../src/wallet.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';

const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
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
    addresses: {},
    candleProducts: ['BTC-USD'],
    dataDir: path.dirname(keysPath),
  };
}

type Verifier = {
  // What the verifier holds, in base units. Read when the request ARRIVES, so a delayed answer
  // carries the balance from when it was asked, the way a slow RPC does.
  holdings: Map<string, string>;
  // 'ok' answers, 'down' answers HTTP 503, and delayMs holds the answer back.
  mode: 'ok' | 'down';
  delayMs: number;
};

/* Every venue the live ledger talks to, answered from memory. Only the verifier is scripted. */
function fakeWorld(): { fetchImpl: typeof fetch; verifier: Verifier } {
  const verifier: Verifier = { holdings: new Map(), mode: 'ok', delayMs: 0 };
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response =>
    json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;

    if (url.includes('coinbase.com')) return json([[0, 0, 0, 0, 100, 0]]);
    if (url.endsWith('/v0/tokens')) return json([{ assetId: ETH_USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC' }]);
    if (url.includes('hyperliquid.xyz')) {
      const type = String(body?.type);
      if (type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0', totalMarginUsed: '0' }, withdrawable: '0', assetPositions: [] });
      if (type === 'spotClearinghouseState') return json({ balances: [] });
      return json('standard');
    }
    // The NEAR RPC: the two view calls the verifier read makes, scripted.
    const mode = verifier.mode;
    const delay = verifier.delayMs;
    const ids = [...verifier.holdings.keys()];
    const amounts = new Map(verifier.holdings);
    if (delay > 0) await sleep(delay);
    if (mode === 'down') return json({ error: 'service unavailable' }, 503);
    const params = (body?.params ?? {}) as { method_name?: string; args_base64?: string };
    const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8') || '{}') as {
      token_ids?: string[];
    };
    if (params.method_name === 'mt_tokens_for_owner') return nearView(ids.map((token_id) => ({ token_id })));
    if (params.method_name === 'mt_batch_balance_of') return nearView((args.token_ids ?? []).map((id) => amounts.get(id) ?? '0'));
    throw new Error(`unexpected request ${url} ${JSON.stringify(body)}`);
  }) as typeof fetch;

  return { fetchImpl, verifier };
}

async function walletAt(keysPath: string): Promise<void> {
  const store = createKeystore({ keysPath, kdf: fast });
  useKeystore(store);
  await store.importWallet(PASSWORD, { mnemonic: VECTOR });
}

test.afterEach(() => {
  useKeystore(null);
});

test('one missed verifier read keeps the holdings and their stamp and counts the miss; two in a row are unread; a good read clears it', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ledger-')), 'keys.json');
  await walletAt(keysPath);
  const world = fakeWorld();
  const logged: string[] = [];
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: (line) => logged.push(line) });

  world.verifier.holdings.set(ETH_USDC, '5000000');
  await ledger.refresh();
  const good = ledger.intents();
  assert.ok(good?.ok, 'the first read is fine');
  assert.equal(good.failures, 0);
  assert.equal(good.holdings[0]?.amount, 5);

  world.verifier.mode = 'down';
  await ledger.refresh();
  const missed = ledger.intents();
  assert.equal(missed?.ok, false);
  assert.equal(missed.failures, 1, 'one miss, counted');
  assert.equal(missed.holdings[0]?.amount, 5, 'the last good holdings stay on screen');
  assert.equal(missed.fetchedAt, good.fetchedAt, 'and they keep the stamp of the read that produced them');
  assert.match(missed.error ?? '', /http 503/);
  assert.equal(logged.length, 1, 'the miss is logged once');
  assert.match(logged[0]!, /http 503/);
  assert.match(logged[0]!, /1 in a row/);
  const oneMiss = buildWallet(ledger.snapshot(), missed, ledger.hyperliquid());
  assert.equal(oneMiss.stale.includes('intents'), false, 'one miss is a miss, not a warning');
  assert.equal(oneMiss.rows.some((r) => r.kind === 'intents' && r.quantity === 5), true, 'the row is still there');

  await ledger.refresh();
  const twice = ledger.intents();
  assert.equal(twice?.failures, 2);
  assert.equal(logged.length, 2);
  const twoMisses = buildWallet(ledger.snapshot(), twice, ledger.hyperliquid());
  assert.ok(twoMisses.stale.includes('intents'), 'two misses in a row are worth saying');
  assert.match(twoMisses.staleWhy?.intents ?? '', /http 503/, 'and the reason travels with it');
  assert.equal(twoMisses.rows.some((r) => r.kind === 'intents' && r.quantity === 5), true, 'without blanking the row');

  world.verifier.mode = 'ok';
  await ledger.refresh();
  const back = ledger.intents();
  assert.ok(back?.ok);
  assert.equal(back.failures, 0, 'a good read clears the count');
  assert.equal(buildWallet(ledger.snapshot(), back, ledger.hyperliquid()).stale.includes('intents'), false);
  assert.equal(logged.length, 2, 'nothing is logged for a read that worked');
});

test('a slow read that answers after a newer one has written is dropped, whatever it says', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ledger-')), 'keys.json');
  await walletAt(keysPath);
  const world = fakeWorld();
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: () => undefined });
  let told = 0;
  ledger.onRefresh?.(() => {
    told += 1;
  });

  // The old read: asked while the account held 5, answered late.
  world.verifier.holdings.set(ETH_USDC, '5000000');
  world.verifier.delayMs = 120;
  const slow = ledger.refresh();
  // The new read: asked after a deposit made it 7, answered at once.
  await new Promise((resolve) => setTimeout(resolve, 5));
  world.verifier.holdings.set(ETH_USDC, '7000000');
  world.verifier.delayMs = 0;
  const quick = ledger.refresh();

  await quick;
  assert.equal(ledger.intents()?.holdings[0]?.amount, 7, 'the newer read is on screen');
  await slow;
  assert.equal(ledger.intents()?.holdings[0]?.amount, 7, 'and the older answer, arriving later, does not replace it');
  assert.equal(told, 1, 'listeners hear about the read that was written, not the one that was dropped');

  // The same rule for a slow read that FAILS: it cannot mark a newer good read as a miss.
  world.verifier.mode = 'down';
  world.verifier.delayMs = 120;
  const slowMiss = ledger.refresh();
  await new Promise((resolve) => setTimeout(resolve, 5));
  world.verifier.mode = 'ok';
  world.verifier.delayMs = 0;
  await ledger.refresh();
  await slowMiss;
  assert.equal(ledger.intents()?.ok, true);
  assert.equal(ledger.intents()?.failures, 0, 'a late miss is not counted against a read that came after it');
});

test('holdings nobody has re-read for two idle periods are unread even when the last read was fine', () => {
  const now = Date.parse('2026-09-16T12:00:00.000Z');
  const fresh = { holdings: [], ok: true, fetchedAt: new Date(now - 20_000).toISOString(), failures: 0 };
  const old = { holdings: [], ok: true, fetchedAt: new Date(now - INTENTS_UNREAD_AFTER_MS - 1_000).toISOString(), failures: 0 };
  assert.equal(intentsUnreadWhy(fresh, now), null);
  assert.match(intentsUnreadWhy(old, now) ?? '', /last read \d+ s ago/);
  // A stamp the reader cannot parse says nothing about age; only the count can mark it.
  assert.equal(intentsUnreadWhy({ holdings: [], ok: true, fetchedAt: 'now' }, now), null);
  assert.equal(intentsUnreadWhy({ holdings: [], ok: false, fetchedAt: 'now', error: 'rpc down' }, now), null, 'a hand-built miss with no count is one miss');
  assert.equal(intentsUnreadWhy({ holdings: [], ok: false, fetchedAt: 'now', error: 'rpc down', failures: 2 }, now), 'rpc down');
});
