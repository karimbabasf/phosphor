// The balance's live prices (src/ledger/live-prices.ts) and how the wallet takes them (src/wallet.ts).
//
// Karim, 2026-10-09, holding GRAM: "make the balance update to the price of tokens held like live,
// not just like every 5 min". 1Click re-prices its list about once a minute and to two or three
// digits, so the balance stepped rather than moved. Hyperliquid's activeAssetCtx sends a coin's mid
// about once a second. The socket is faked rather than dialled: reconnect and the push cadence are
// the behaviours worth testing, and neither is reachable against a real venue in a unit test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createLivePrices, FRESH_MS, PUSH_MS } from '../../src/ledger/live-prices.ts';
import type { FeedSocket } from '../../src/trade/feed-ws.ts';
import { buildWallet, liveCoins, LIVE_BAND, LIVE_COINS_MAX } from '../../src/wallet.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { LedgerSnapshot } from '../../src/types.ts';

type FakeSocket = FeedSocket & { sent: Array<Record<string, unknown>>; open(): void; deliver(msg: unknown): void; drop(): void };

function sockets(): { make: (url: string) => FeedSocket; all: FakeSocket[] } {
  const all: FakeSocket[] = [];
  const make = (): FeedSocket => {
    const sock: FakeSocket = {
      sent: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        sock.sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close() {
        sock.readyState = 3;
        sock.onclose?.();
      },
      open() {
        sock.readyState = 1;
        sock.onopen?.();
      },
      deliver(msg: unknown) {
        sock.onmessage?.({ data: JSON.stringify(msg) });
      },
      drop() {
        sock.readyState = 3;
        sock.onclose?.();
      },
    };
    all.push(sock);
    return sock;
  };
  return { make, all };
}

const ctx = (coin: string, midPx: string | null, markPx = '1.0') => ({ channel: 'activeAssetCtx', data: { coin, ctx: { midPx, markPx, funding: '0' } } });
const subs = (sock: FakeSocket, method: string): string[] =>
  sock.sent.filter((m) => m.method === method).map((m) => String((m.subscription as { coin?: unknown }).coin));

test('no coin held, no socket: the feed dials only when there is something to price', () => {
  const { make, all } = sockets();
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make });
  live.track([]);
  assert.equal(all.length, 0);
  live.track(['gram']);
  assert.equal(all.length, 1);
  live.stop();
});

test('each held coin is subscribed on open, priced at its mid, and untracked coins are dropped', () => {
  const { make, all } = sockets();
  let now = 1_000_000;
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make, now: () => now });
  live.track(['GRAM', 'NEAR']);
  const sock = all[0]!;
  sock.open();
  assert.deepEqual(subs(sock, 'subscribe').sort(), ['GRAM', 'NEAR']);
  assert.equal(live.price('GRAM'), null, 'no mid yet is no price');

  sock.deliver(ctx('GRAM', '1.45635'));
  assert.equal(live.price('GRAM'), 1.45635);
  assert.equal(live.price('gram'), 1.45635, 'keyed uppercase, as the wallet keys it');
  // A one-sided book sends no mid: the mark stands in.
  sock.deliver(ctx('NEAR', null, '4.7337'));
  assert.equal(live.price('NEAR'), 4.7337);
  // A coin nobody tracks, and a venue error for an unknown one, change nothing.
  sock.deliver(ctx('BTC', '82675.5'));
  sock.deliver({ channel: 'error', data: 'Invalid subscription {"type":"activeAssetCtx","coin":"WBTC"}' });
  assert.equal(live.price('BTC'), null);

  live.track(['GRAM']);
  assert.deepEqual(subs(sock, 'unsubscribe'), ['NEAR']);
  assert.equal(live.price('NEAR'), null, 'a coin no longer held keeps no price');
  live.track(['GRAM', 'ETH']);
  assert.deepEqual(subs(sock, 'subscribe').sort(), ['ETH', 'GRAM', 'NEAR'], 'a new holding is subscribed on the open socket');

  now += FRESH_MS + 1;
  assert.equal(live.price('GRAM'), null, 'a mid older than FRESH_MS is no live price, so the ledger price stands');
  live.stop();
});

test('the window is told at most once a second, and only when a mid moved', async () => {
  const { make, all } = sockets();
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make });
  let told = 0;
  live.onChange(() => {
    told += 1;
  });
  live.track(['GRAM']);
  const sock = all[0]!;
  sock.open();
  const rev0 = live.revision();
  sock.deliver(ctx('GRAM', '1.4601'));
  assert.equal(told, 1, 'the first move is told at once');
  sock.deliver(ctx('GRAM', '1.4602'));
  sock.deliver(ctx('GRAM', '1.4603'));
  assert.equal(told, 1, 'moves inside the window wait for it');
  assert.equal(live.revision(), rev0 + 3, 'every move moves the revision a cache keys on');
  await new Promise((resolve) => setTimeout(resolve, PUSH_MS + 50));
  assert.equal(told, 2, 'and are told once when it closes');
  sock.deliver(ctx('GRAM', '1.4603'));
  assert.equal(live.revision(), rev0 + 3, 'the same mid again is not a move');
  await new Promise((resolve) => setTimeout(resolve, PUSH_MS + 50));
  assert.equal(told, 2);
  live.stop();
});

test('a dropped socket comes back and subscribes every held coin again', async () => {
  const { make, all } = sockets();
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make });
  live.track(['GRAM']);
  all[0]!.open();
  all[0]!.drop();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(all.length, 2, 'no reconnect after the first retry delay');
  all[1]!.open();
  assert.deepEqual(subs(all[1]!, 'subscribe'), ['GRAM']);
  all[1]!.deliver(ctx('GRAM', '1.46'));
  assert.equal(live.price('GRAM'), 1.46);
  live.stop();
});

const SNAP: LedgerSnapshot = { mode: 'live', fetchedAt: new Date().toISOString(), prices: { NEAR: 4.75 } };
const GRAM = 'nep245:v2_1.omni.hot.tg:1117_';
function read(rows: Array<{ symbol: string; assetId: string; amount: number; priceUsd?: number | null }>): IntentsRead {
  return {
    holdings: rows.map((r) => ({ accountId: '0xa', originChain: 'near', decimals: 9, ...r })),
    ok: true,
    fetchedAt: new Date().toISOString(),
    failures: 0,
  };
}

test('the wallet values a coin at its live mid inside the band, and at its own price outside it', () => {
  const held = read([
    { symbol: 'GRAM', assetId: GRAM, amount: 640, priceUsd: 1.46 },
    { symbol: 'wNEAR', assetId: 'nep141:wrap.near', amount: 10 },
    { symbol: 'USDC', assetId: 'nep141:usdc', amount: 5, priceUsd: 1 },
  ]);
  const mids: Record<string, number> = { GRAM: 1.45635, NEAR: 4.7337, USDC: 0.9 };
  const wallet = buildWallet(SNAP, held, undefined, Date.now(), (coin) => mids[coin] ?? null);
  const row = (symbol: string) => wallet.rows.find((r) => r.symbol === symbol)!;
  assert.equal(row('GRAM').priceUsd, 1.45635, "1Click's coin moves with its market");
  assert.equal(row('GRAM').priceSource, 'hyperliquid');
  assert.equal(row('wNEAR').priceUsd, 4.7337, 'a wrapper takes its coin\'s mid, as it takes its price (pricedAs)');
  assert.equal(row('USDC').priceUsd, 1, 'a dollar is a dollar, whatever a market says');
  assert.ok(Math.abs(wallet.totalUsd - (640 * 1.45635 + 47.337 + 5)) < 1e-9);

  // Outside the band: another token under the same ticker, or a perp that broke from its spot.
  const far = buildWallet(SNAP, held, undefined, Date.now(), (coin) => (coin === 'GRAM' ? 1.46 * (1 + LIVE_BAND + 0.01) : null));
  assert.equal(far.rows.find((r) => r.symbol === 'GRAM')!.priceUsd, 1.46);
  assert.equal(far.rows.find((r) => r.symbol === 'GRAM')!.priceSource, '1click');

  // No own price at all: a mid alone is no price, so the coin stays unpriced rather than borrowed.
  const bare = buildWallet(SNAP, read([{ symbol: 'GRAM', assetId: GRAM, amount: 640, priceUsd: null }]), undefined, Date.now(), () => 1.45);
  assert.equal(bare.rows.find((r) => r.symbol === 'GRAM')!.priced, false);

  // Without the live hook the wallet is exactly what it was: every governing caller passes none.
  assert.equal(buildWallet(SNAP, held, undefined).rows.find((r) => r.symbol === 'GRAM')!.priceUsd, 1.46);
});

test('the coins worth a live price are the priced non-dollar holdings, keyed as the wallet keys them, largest first', () => {
  const held = read([
    { symbol: 'wNEAR', assetId: 'nep141:wrap.near', amount: 10, priceUsd: 4.75 },
    { symbol: 'GRAM', assetId: GRAM, amount: 640, priceUsd: 1.46 },
    { symbol: 'USDT', assetId: 'nep141:usdt', amount: 8, priceUsd: 1 },
    { symbol: 'ETH', assetId: 'nep141:eth', amount: 0, priceUsd: 2487 },
  ]);
  assert.deepEqual(liveCoins(held), ['GRAM', 'NEAR']);
  assert.deepEqual(liveCoins(undefined), []);
});

// Review 2026-10-09: anyone can send tokens to the account. A coin 1Click does not list is named by
// its raw id with no price, so it can never take a mid, and 1500 of them were 1500 subscriptions on
// a socket that shares the venue's limits with the trade feed.
test('tokens nobody prices, odd names and a long tail never reach the socket', () => {
  const junk = Array.from({ length: 1500 }, (_, i) => ({ symbol: `nep245:spam.near:${i}`, assetId: `nep245:spam.near:${i}`, amount: 1, priceUsd: null }));
  const named = Array.from({ length: 30 }, (_, i) => ({ symbol: `C${i}`, assetId: `nep141:c${i}`, amount: 1, priceUsd: i + 1 }));
  const coins = liveCoins(read([...junk, { symbol: 'GRAM', assetId: GRAM, amount: 640, priceUsd: 1.46 }, ...named]));
  assert.equal(coins.length, LIVE_COINS_MAX);
  assert.equal(coins[0], 'GRAM', 'the largest holding first');
  assert.ok(coins.every((c) => /^[A-Z0-9]{2,10}$/.test(c)), coins.join(','));
  assert.ok(!coins.includes('C0'), 'the smallest are the ones left out');
});

test('a venue that takes the socket and drops it again is retried on the backoff, never once a second', async () => {
  const { make, all } = sockets();
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make });
  live.track(['GRAM']);
  all[0]!.open();
  all[0]!.drop();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(all.length, 2);
  all[1]!.open();
  all[1]!.drop();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(all.length, 2, 'an open that sent nothing reset the backoff to one second');
  live.stop();
});

test('with nothing left to price the socket goes, and the next coin held dials again', () => {
  const { make, all } = sockets();
  const live = createLivePrices({ wsUrl: 'wss://test.invalid/ws', wsImpl: make });
  live.track(['GRAM']);
  all[0]!.open();
  live.track([]);
  assert.equal(all[0]!.readyState, 3, 'the socket stayed open with nothing on it');
  live.track(['GRAM']);
  assert.equal(all.length, 2);
  live.stop();
});

// Display only. A live mid is a perp's: it reaches the window and the agent's wallet read, and never
// a path that prices, limits or signs a move. Those all call buildWallet without it.
test('no path that governs a move is handed the live prices', () => {
  const root = path.join(import.meta.dirname, '../../src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && /ctx\.livePrices/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(offenders.sort(), ['http/read/wallet.ts', 'http/state.ts']);
});
