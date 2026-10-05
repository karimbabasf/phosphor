// The balance when the app opens. Karim, 2026-10-05: "the balance is taking a really shit long
// time to load when opening the app, it says zero for a while, and tends to say couldnt read your
// balances". Measured that afternoon against the live venues: the window drew "$0.00" over
// "Nothing here yet" until the first read landed, a first verifier read that failed left the
// money out of the total with nothing said, and the read waited on 1Click's token list, 0.5 s of
// a 0.72 s first balance on a good day and the whole 10 s read deadline while 1Click hung.
//
// Temp directory throughout, every fetch stubbed. Nothing here reaches a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { AppConfig } from '../../src/types.ts';
import { createLedger, type Ledger } from '../../src/ledger/index.ts';
import { buildWallet } from '../../src/wallet.ts';
import { buildBasic } from '../../src/view/basic.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { tempDir } from './helpers/tmp.ts';

const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'a long enough password';
const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

function liveConfig(keysPath: string): AppConfig {
  return { mode: 'live', keysPath, port: 4177, addresses: {}, candleProducts: ['BTC-USD'], dataDir: path.dirname(keysPath) };
}

type World = { fetchImpl: typeof fetch; verifier: 'ok' | 'down'; oneClick: 'ok' | 'hang' };

// Every venue the live ledger reads, answered from memory: the account holds 5 USDC in the verifier.
function fakeWorld(): World {
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response => json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  const world: World = { verifier: 'ok', oneClick: 'ok', fetchImpl: fetch };
  world.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.includes('coinbase.com')) return json([[0, 0, 0, 0, 100, 0]]);
    if (url.endsWith('/v0/tokens')) {
      // The incident: no answer at all until the caller's own deadline gives up.
      if (world.oneClick === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      return json([{ assetId: NEAR_USDC, decimals: 6, blockchain: 'near', symbol: 'USDC' }]);
    }
    if (url.includes('hyperliquid.xyz')) {
      const type = String(body?.type);
      if (type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0', totalMarginUsed: '0' }, withdrawable: '0', assetPositions: [] });
      if (type === 'spotClearinghouseState') return json({ balances: [] });
      return json('standard');
    }
    if (world.verifier === 'down') return json({ error: 'service unavailable' }, 503);
    const method = (body?.params as { method_name?: string } | undefined)?.method_name;
    if (method === 'mt_tokens_for_owner') return nearView([{ token_id: NEAR_USDC }]);
    if (method === 'mt_batch_balance_of') return nearView(['5000000']);
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return world;
}

async function walletAt(keysPath: string): Promise<void> {
  const store = createKeystore({ keysPath, kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(store);
  await store.importWallet(PASSWORD, { mnemonic: VECTOR });
}

// What the window's balance panel says, built the way /api/state builds it.
function panel(ledger: Ledger) {
  const wallet = buildWallet(ledger.snapshot(), ledger.intents(), ledger.hyperliquid());
  return { wallet, basic: buildBasic({ wallet, proposals: [], policyReadable: true, killSwitch: false, readAt: ledger.snapshot().fetchedAt }) };
}

test.afterEach(() => {
  useKeystore(null);
});

test('the window opens on a loading state, never $0.00, until the first read lands', async () => {
  const keysPath = path.join(tempDir('phosphor-cold-open-'), 'keys.json');
  await walletAt(keysPath);
  const world = fakeWorld();
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: () => undefined });

  const before = panel(ledger);
  assert.equal(before.basic.totalLine, '', 'no figure before anything is read');
  assert.equal(before.basic.caption, 'Reading your balance.');
  assert.equal(before.basic.emptyLine, null, 'and no "Nothing here yet" over money nobody has read');
  assert.deepEqual(before.wallet.stale, ['intents', 'hyperliquid'], 'an agent reading the wallet is told the same');
  assert.deepEqual(before.wallet.unread, ['intents', 'hyperliquid'], 'with no figures behind either');

  await ledger.refresh();
  const after = panel(ledger);
  assert.equal(after.basic.totalLine, '$5.00');
  assert.equal(after.basic.caption, 'in your balance');
  assert.deepEqual(after.wallet.stale, []);
  assert.equal(after.wallet.unread, undefined);

  // Two misses in a row later: stale, and the last good holdings stay in the rows for a screen to keep.
  world.verifier = 'down';
  await ledger.refresh();
  await ledger.refresh();
  const missed = panel(ledger);
  assert.ok(missed.wallet.stale.includes('intents'));
  assert.equal(missed.wallet.unread, undefined, 'read before, so not unread');
  assert.equal(missed.wallet.rows.find((r) => r.kind === 'intents')?.quantity, 5);
});

test('a first read that fails says so and never shows the money as gone', async () => {
  const keysPath = path.join(tempDir('phosphor-cold-open-'), 'keys.json');
  await walletAt(keysPath);
  const world = fakeWorld();
  world.verifier = 'down';
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: () => undefined });

  await ledger.refresh();
  const missed = panel(ledger);
  assert.ok(missed.wallet.stale.includes('intents'), 'nothing was ever read, so one miss is already unread');
  assert.deepEqual(missed.wallet.unread, ['intents']);
  assert.match(missed.wallet.staleWhy?.intents ?? '', /http 503/);
  assert.equal(missed.basic.totalLine, '');
  assert.equal(missed.basic.emptyLine, 'Part of your balance could not be read just now. It shows here as soon as it can be.');

  world.verifier = 'ok';
  await ledger.refresh();
  assert.equal(panel(ledger).basic.totalLine, '$5.00', 'the next good read clears it');
});

test('a cold open reads the balance off the last token list and never waits on 1Click', async () => {
  const keysPath = path.join(tempDir('phosphor-cold-open-'), 'keys.json');
  await walletAt(keysPath);
  const world = fakeWorld();
  // A run with 1Click answering, which keeps the list it read.
  await createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: () => undefined }).refresh();

  // The app opens again while 1Click hangs.
  world.oneClick = 'hang';
  const ledger = createLedger(liveConfig(keysPath), { fetchImpl: world.fetchImpl, log: () => undefined });
  const started = Date.now();
  const first = await Promise.race([
    ledger.refresh().then(() => 'landed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('still waiting on 1Click'), 2_000).unref()),
  ]);
  assert.equal(first, 'landed');
  assert.ok(Date.now() - started < 1_000, `the balance landed ${Date.now() - started} ms after the read started`);
  const held = ledger.intents()?.holdings[0];
  assert.equal(held?.symbol, 'USDC', 'labelled off the list the last run kept');
  assert.equal(held?.amount, 5, 'in its own decimals, not as a raw integer');
  assert.equal(panel(ledger).basic.totalLine, '$5.00');
});
