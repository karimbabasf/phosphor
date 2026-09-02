// The live rail, tested against the four ways a price feed can lie.
//
// Every test here is a failure this rail exists to avoid: a Coinbase bar opened at whatever
// trade the process happened to attach to rather than at the minute's open, one venue's
// candles landing under another venue's key, a subscription left behind by a window that
// closed, and a socket that dies quietly and never comes back.
//
// The socket is faked rather than dialled. Reconnect timing, the open timeout and the
// mid-minute attach are the behaviours most worth testing and none of them is reachable
// against a real venue in a unit test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import {
  createMarketLive,
  coinOf,
  foldMatch,
  hyperliquidCandle,
  LIVE_BASE_SEC,
  type LiveProvider,
  type LiveSocket,
} from '../../src/market/live.ts';
import { createMarketData } from '../../src/market/index.ts';

type FakeSocket = LiveSocket & {
  url: string;
  sent: unknown[];
  open(): void;
  deliver(msg: unknown): void;
  drop(): void;
};

function fakeSockets(): { make: (url: string) => LiveSocket; all: FakeSocket[]; last: () => FakeSocket } {
  const all: FakeSocket[] = [];
  function make(url: string): LiveSocket {
    const sock: FakeSocket = {
      url,
      sent: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string): void {
        sock.sent.push(JSON.parse(data));
      },
      close(): void {
        sock.drop();
      },
      open(): void {
        sock.readyState = 1;
        sock.onopen?.();
      },
      deliver(msg: unknown): void {
        sock.onmessage?.({ data: JSON.stringify(msg) });
      },
      drop(): void {
        if (sock.readyState === 3) return;
        sock.readyState = 3;
        sock.onclose?.();
      },
    };
    all.push(sock);
    return sock;
  }
  return { make, all, last: () => all[all.length - 1] as FakeSocket };
}

type Emitted = { product: string; baseSec: number; candle: Candle; provider: LiveProvider };

function harness(opts: { seed?: (product: string, provider: LiveProvider) => Candle | null; now?: () => number } = {}) {
  const sockets = fakeSockets();
  const emitted: Emitted[] = [];
  const live = createMarketLive({
    onCandle: (product, baseSec, candle, provider) => emitted.push({ product, baseSec, candle, provider }),
    seedBar: opts.seed,
    wsImpl: sockets.make,
    now: opts.now,
  });
  return { live, sockets, emitted };
}

// A minute that opened at 09:00:00 with the venue reporting 100 as the open.
const MINUTE = 1_700_000_400;
const hlBar = (over: Partial<Record<string, string>> = {}) => ({
  t: String(MINUTE * 1000),
  T: String((MINUTE + 60) * 1000 - 1),
  s: 'BTC',
  i: '1m',
  o: '100',
  h: '101',
  l: '99',
  c: '100.5',
  v: '3',
  n: '12',
  ...over,
});

// ---------- the mapping ----------

test('a hyperliquid candle row becomes a candle, with t read as the bar open', () => {
  const row = hyperliquidCandle(hlBar());
  assert.ok(row);
  assert.equal(row.coin, 'BTC');
  assert.equal(row.interval, '1m');
  // Milliseconds in, seconds out, and the open of the bar rather than the instant it was sent.
  // Reading this field as a send time is what made the feed measure 44 s late when it is 24 ms
  // behind the tape.
  assert.deepEqual(row.candle, { t: MINUTE, o: 100, h: 101, l: 99, c: 100.5, v: 3 });
});

test('a row with one unreadable leg is refused rather than half built', () => {
  assert.equal(hyperliquidCandle(hlBar({ h: 'n/a' })), null);
  assert.equal(hyperliquidCandle(hlBar({ v: '' })), null);
  assert.equal(hyperliquidCandle(null), null);
  assert.equal(hyperliquidCandle({ s: 'BTC' }), null);
});

test('a hyperliquid coin is the base of the product this app names', () => {
  assert.equal(coinOf('BTC-USD'), 'BTC');
  assert.equal(coinOf('kPEPE-USD'), 'KPEPE');
  assert.equal(coinOf('SOL'), 'SOL');
});

// ---------- the fold ----------

test('a coinbase bucket opens at the minute open the venue reported, not at the trade seen first', () => {
  // Attaching at 09:00:30 with the venue's own bar in the cache. Without the seed the bar
  // would open at 105, store.put would let it win, and a correct REST bar would be replaced
  // by a wrong one that looks like a real move.
  const cached: Candle = { t: MINUTE, o: 100, h: 106, l: 99, c: 105, v: 4 };
  const folded = foldMatch(null, cached, MINUTE + 30, 105, 0.5);
  assert.equal(folded.t, MINUTE);
  assert.equal(folded.o, 100);
  assert.equal(folded.h, 106);
  assert.equal(folded.l, 99);
  assert.equal(folded.c, 105);
  assert.equal(folded.v, 4.5);
});

test('with no cached bar the fold opens at the first trade it sees', () => {
  const folded = foldMatch(null, null, MINUTE + 5, 42, 2);
  assert.deepEqual(folded, { t: MINUTE, o: 42, h: 42, l: 42, c: 42, v: 2 });
});

test('trades accumulate into the bucket and roll into the next minute', () => {
  let held = foldMatch(null, null, MINUTE + 1, 100, 1);
  held = foldMatch(held, null, MINUTE + 2, 103, 1);
  held = foldMatch(held, null, MINUTE + 3, 98, 1);
  assert.deepEqual(held, { t: MINUTE, o: 100, h: 103, l: 98, c: 98, v: 3 });

  const next = foldMatch(held, null, MINUTE + 61, 99, 2);
  assert.equal(next.t, MINUTE + 60, 'a new minute is a new bar, not an extension of the old one');
  assert.deepEqual(next, { t: MINUTE + 60, o: 99, h: 99, l: 99, c: 99, v: 2 });
});

test('volume inside a bucket only grows, so a dropped message cannot shrink the bar', () => {
  // The REST rail refreshes mid-minute and reports more volume than this process accumulated,
  // which is what a dropped match looks like from here. The larger figure is the one that saw
  // more of the minute.
  let held = foldMatch(null, null, MINUTE + 1, 100, 1);
  const cached: Candle = { t: MINUTE, o: 100, h: 100, l: 100, c: 100, v: 9 };
  held = foldMatch(held, cached, MINUTE + 2, 100, 1);
  assert.equal(held.v, 10);
});

// ---------- subscriptions ----------

test('a venue nobody watches keeps no socket, and one that is watched keeps exactly one', () => {
  const { live, sockets } = harness();
  assert.equal(sockets.all.length, 0, 'constructing the rail dials nothing');

  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  assert.equal(sockets.all.length, 1);
  sockets.last().open();

  // A second market on the same venue rides the socket that is already open.
  live.track('trade', [{ product: 'ETH-USD', provider: 'hyperliquid' }]);
  assert.equal(sockets.all.length, 1, 'one socket per venue, not one per market');

  const subs = sockets.last().sent as { method: string; subscription: { type: string; coin: string; interval: string } }[];
  assert.deepEqual(
    subs.map((s) => s.subscription.coin),
    ['BTC', 'ETH'],
  );
  assert.ok(subs.every((s) => s.method === 'subscribe' && s.subscription.interval === '1m'));

  live.stop();
});

test('a window that stops watching gives its subscription back', () => {
  const { live, sockets } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  live.track('trade', [{ product: 'ETH-USD', provider: 'hyperliquid' }]);
  sockets.last().sent.length = 0;

  // The owner states its whole set, so an empty one is "I want nothing" and cannot leak.
  live.track('trade', []);
  const sent = sockets.last().sent as { method: string; subscription: { coin: string } }[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, 'unsubscribe');
  assert.equal(sent[0]?.subscription.coin, 'ETH');

  // The last owner leaving closes the venue rather than holding an idle connection.
  live.track('chart', []);
  assert.equal(sockets.last().readyState, 3);
  live.stop();
});

test('two venues are two sockets, and a candle only ever lands under the venue that sent it', () => {
  const { live, sockets, emitted } = harness();
  live.track('chart', [
    { product: 'BTC-USD', provider: 'hyperliquid' },
    { product: 'BTC-USD', provider: 'coinbase' },
  ]);
  assert.equal(sockets.all.length, 2);
  const hl = sockets.all.find((s) => s.url.includes('hyperliquid')) as FakeSocket;
  const cb = sockets.all.find((s) => s.url.includes('coinbase')) as FakeSocket;
  assert.ok(hl && cb);
  hl.open();
  cb.open();

  hl.deliver({ channel: 'candle', data: hlBar() });
  cb.deliver({ type: 'match', product_id: 'BTC-USD', price: '77', size: '1', time: new Date(MINUTE * 1000).toISOString() });

  assert.equal(emitted.length, 2);
  // The same product on two venues is two series, and the perp's price never reaches the
  // spot key. This is the splice the store's keyOf comment exists to prevent.
  assert.equal(emitted[0]?.provider, 'hyperliquid');
  assert.equal(emitted[0]?.candle.c, 100.5);
  assert.equal(emitted[1]?.provider, 'coinbase');
  assert.equal(emitted[1]?.candle.c, 77);
  assert.ok(emitted.every((e) => e.baseSec === LIVE_BASE_SEC));
  live.stop();
});

test('coinbase subscribes to matches and a heartbeat, so a quiet product cannot idle the socket out', () => {
  const { live, sockets } = harness();
  live.track('chart', [{ product: 'ETH-USD', provider: 'coinbase' }]);
  sockets.last().open();
  const sent = sockets.last().sent as { type: string; product_ids: string[]; channels: string[] }[];
  assert.equal(sent[0]?.type, 'subscribe');
  assert.deepEqual(sent[0]?.product_ids, ['ETH-USD']);
  assert.deepEqual(sent[0]?.channels, ['matches', 'heartbeat']);
  live.stop();
});

// ---------- messages ----------

test('a candle for a coin nobody asked for is dropped', () => {
  const { live, sockets, emitted } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  sockets.last().deliver({ channel: 'candle', data: hlBar({ s: 'DOGE' }) });
  assert.equal(emitted.length, 0);
  live.stop();
});

test('an interval other than one minute is dropped, because the base is the whole contract', () => {
  const { live, sockets, emitted } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  sockets.last().deliver({ channel: 'candle', data: hlBar({ i: '5m' }) });
  assert.equal(emitted.length, 0);
  live.stop();
});

test('the same bar arriving twice is emitted once', () => {
  const { live, sockets, emitted } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  sockets.last().deliver({ channel: 'candle', data: hlBar() });
  sockets.last().deliver({ channel: 'candle', data: hlBar() });
  assert.equal(emitted.length, 1, 'a repeat of a bar that did not move is not news');
  sockets.last().deliver({ channel: 'candle', data: hlBar({ c: '101' }) });
  assert.equal(emitted.length, 2);
  live.stop();
});

test('last_match is not folded, because its size is already inside the cached bar', () => {
  const cached: Candle = { t: MINUTE, o: 100, h: 100, l: 100, c: 100, v: 5 };
  const { live, sockets, emitted } = harness({ seed: () => cached });
  live.track('chart', [{ product: 'BTC-USD', provider: 'coinbase' }]);
  sockets.last().open();
  sockets.last().deliver({
    type: 'last_match',
    product_id: 'BTC-USD',
    price: '100',
    size: '5',
    time: new Date(MINUTE * 1000).toISOString(),
  });
  assert.equal(emitted.length, 0);
  live.stop();
});

test('an unparseable frame is recorded and never throws into the socket', () => {
  const { live, sockets, emitted } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  sockets.last().onmessage?.({ data: 'not json' });
  sockets.last().deliver({ channel: 'error', data: 'subscription refused' });
  assert.equal(emitted.length, 0);
  const status = live.status()[0];
  assert.equal(status?.lastError, 'subscription refused');
  live.stop();
});

// ---------- reconnect ----------

test('a dropped socket comes back with backoff and resubscribes everything it was carrying', async () => {
  const { live, sockets } = harness();
  live.track('chart', [
    { product: 'BTC-USD', provider: 'hyperliquid' },
    { product: 'ETH-USD', provider: 'hyperliquid' },
  ]);
  sockets.last().open();
  assert.equal(sockets.last().sent.length, 2);

  sockets.last().drop();
  assert.equal(sockets.all.length, 1, 'the retry is on a timer, not immediate');
  assert.equal(live.connected('hyperliquid'), false);

  // 1 s, then 2 s, then 4 s, capped at 15 s. Waiting the first step out is cheap.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(sockets.all.length, 2, 'the rail dialled again');
  sockets.last().open();
  const subs = sockets.last().sent as { subscription: { coin: string } }[];
  assert.deepEqual(
    subs.map((s) => s.subscription.coin),
    ['BTC', 'ETH'],
    'a reconnect that forgets a subscription is a chart that silently stops moving',
  );
  assert.equal(live.status()[0]?.reconnects, 1);
  live.stop();
});

test('a connect that hangs is timed out rather than held open forever', async () => {
  const { live, sockets } = harness();
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  // Never opened, never closed. Without the open timeout nothing here fires onclose, so the
  // backoff chain is unreachable and the venue sits dark with no price and no complaint.
  assert.equal(sockets.all.length, 1);
  assert.equal(live.connected('hyperliquid'), false);
  assert.equal(live.status()[0]?.connected, false);
  live.stop();
});

test('a socket that throws on construction still schedules a retry', () => {
  let dialled = 0;
  const live = createMarketLive({
    onCandle: () => {},
    wsImpl: () => {
      dialled += 1;
      throw new Error('dns is having a day');
    },
  });
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  assert.equal(dialled, 1);
  assert.equal(live.status()[0]?.lastError, 'dns is having a day');
  assert.equal(live.connected('hyperliquid'), false);
  live.stop();
});

// ---------- what the feed state is derived from ----------

test('the age of a series is the gap since its last live bar, and null before the first one', () => {
  let clock = 10_000;
  const { live, sockets } = harness({ now: () => clock });
  live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
  sockets.last().open();
  assert.equal(live.ageMs('BTC-USD', 'hyperliquid'), null, 'nothing has arrived yet');

  sockets.last().deliver({ channel: 'candle', data: hlBar() });
  assert.equal(live.ageMs('BTC-USD', 'hyperliquid'), 0);
  clock += 7_000;
  assert.equal(live.ageMs('BTC-USD', 'hyperliquid'), 7_000);
  // A different series on the same venue has its own age, because one market going quiet
  // says nothing about another.
  assert.equal(live.ageMs('ETH-USD', 'hyperliquid'), null);
  live.stop();
});

test('stopping the rail closes every socket and refuses further tracking', () => {
  const { live, sockets } = harness();
  live.track('chart', [
    { product: 'BTC-USD', provider: 'hyperliquid' },
    { product: 'BTC-USD', provider: 'coinbase' },
  ]);
  for (const sock of sockets.all) sock.open();
  live.stop();
  assert.ok(sockets.all.every((s) => s.readyState === 3));
  live.track('chart', [{ product: 'SOL-USD', provider: 'hyperliquid' }]);
  assert.equal(sockets.all.length, 2, 'a stopped rail does not dial again');
});

// ---------- the rail wired to the cache ----------

test('the rail follows what is being read, and a socket bar lands in the cache under its own venue', async () => {
  const sockets = fakeSockets();
  const emitted: { product: string; candle: Candle; provider: string }[] = [];
  const market = createMarketData({
    cachePath: '/nonexistent/phosphor-test-catalog.json',
    fetchImpl: (async () => ({
      ok: true,
      json: async () => [],
      text: async () => '',
      headers: new Headers(),
    })) as unknown as typeof fetch,
    onLive: (product, _baseSec, candle, provider) => emitted.push({ product, candle, provider }),
    live: { enabled: true, wsImpl: sockets.make },
  });

  // Demand-driven, exactly like the fill behind read(): nothing was watched until something
  // was read, so a window nobody opened costs no connection.
  assert.equal(sockets.all.length, 0);
  market.read('BTC-USD', '1m', 100);
  assert.equal(sockets.all.length, 1, 'reading a market is what subscribes it');
  sockets.last().open();

  sockets.last().deliver({ channel: 'candle', data: hlBar() });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.provider, 'hyperliquid');
  assert.equal(emitted[0]?.candle.c, 100.5);

  // And the cache now holds it, so the next read paints the socket's bar with no fetch.
  const held = market.read('BTC-USD', '1m', 100);
  assert.equal(held.candles[held.candles.length - 1]?.c, 100.5);
  // Not exactly zero: this one runs on the wall clock, and a millisecond between the put and
  // the read is a passing test that fails one run in four.
  assert.ok(held.liveAgeSec !== null && held.liveAgeSec < 1, `expected a fresh series, got ${held.liveAgeSec}`);
  assert.equal(market.liveConnected('hyperliquid'), true);
  market.stopLive();
});

test('a market service with the rail switched off dials nothing at all', () => {
  const market = createMarketData({
    cachePath: '/nonexistent/phosphor-test-catalog.json',
    fetchImpl: (async () => ({
      ok: true,
      json: async () => [],
      text: async () => '',
      headers: new Headers(),
    })) as unknown as typeof fetch,
  });
  // The default. Every test in this repo that builds a market service gets this one, and a
  // unit test dialling a venue by accident is how a suite starts depending on the weather.
  market.read('BTC-USD', '1m', 100);
  assert.deepEqual(market.liveStatus(), []);
  assert.equal(market.liveConnected('hyperliquid'), false);
});


/* ---------- the backoff, and what resets it ----------

   A venue that completes the handshake and closes at once, which is what a rate limit and a ban
   both look like from here, reset the backoff on every OPEN and so reconnected once a second
   forever. It is cleared by a MESSAGE now: a connection that carried data is a connection that
   worked, and one that only opened proved nothing.

   The retry delays are read off setTimeout rather than waited out, because the point is the
   sequence and the sequence is fifteen seconds long. */
async function retryDelays(cycles: number, speak: boolean): Promise<number[]> {
  const { live, sockets } = harness();
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  const STEPS = [1000, 2000, 4000, 8000, 15000];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    /* Only the backoff steps are recorded, and only they are accelerated. The open watchdog
       rides the same timer at ten seconds and is left alone: firing it early would close the
       socket the test is about to speak on, which is a different failure wearing this one's
       clothes. */
    if (typeof ms === 'number' && STEPS.includes(ms)) {
      delays.push(ms);
      return real(fn, 0);
    }
    return real(fn, ms);
  }) as typeof setTimeout;
  try {
    live.track('chart', [{ product: 'BTC-USD', provider: 'hyperliquid' }]);
    for (let i = 0; i < cycles; i += 1) {
      const sock = sockets.last();
      sock.open();
      if (speak) sock.deliver({ channel: 'nothing-this-reader-knows' });
      sock.drop();
      await new Promise((resolve) => real(resolve, 5)); // let the retry timer fire
    }
  } finally {
    globalThis.setTimeout = real;
    live.stop();
  }
  return delays;
}

test('a venue that opens and closes without ever speaking backs off instead of hammering', async () => {
  const delays = await retryDelays(4, false);
  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000], 'the backoff grows across dead connections');
});

test('a socket that has carried a message starts its next backoff from the beginning', async () => {
  const delays = await retryDelays(3, true);
  assert.deepEqual(delays.slice(0, 3), [1000, 1000, 1000], 'a working connection resets the clock');
});
