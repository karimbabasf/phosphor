// The account socket, tested against the four ways it can lie.
//
// Every test here is a failure that has happened to somebody on this venue: fills doubling on
// every reconnect because a snapshot was appended, a quiet account's socket dying because
// nothing pinged it, a screen reporting zero equity on an account that was holding a position,
// and a coin change tearing down a connection that was carrying five other subscriptions.
//
// The socket is faked rather than dialled. Reconnect timing and the heartbeat are the behaviours
// most worth testing and both are unreachable against a real venue in a unit test.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTradeFeed, type FeedSocket } from '../../src/trade/feed-ws.ts';
import type { InfoClient } from '../../src/hl/info.ts';

const USER = '0x1111111111111111111111111111111111111111';
const WS = 'wss://test.invalid/ws';

type FakeSocket = FeedSocket & {
  url: string;
  sent: string[];
  open(): void;
  deliver(msg: unknown): void;
  drop(): void;
};

function fakeSockets(): { make: (url: string) => FeedSocket; all: FakeSocket[]; last: () => FakeSocket } {
  const all: FakeSocket[] = [];
  function make(url: string): FeedSocket {
    const sock: FakeSocket = {
      url,
      sent: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string): void {
        sock.sent.push(data);
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
  return { make, all, last: () => all[all.length - 1] };
}

const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
    { name: 'SOL', szDecimals: 2, maxLeverage: 20 },
  ],
};

function fakeInfo(answers?: Record<string, unknown>): InfoClient {
  const table: Record<string, unknown> = {
    meta: META,
    spotClearinghouseState: { balances: [] },
    ...(answers ?? {}),
  };
  return {
    post<T>(body: unknown): Promise<T> {
      const type =
        typeof body === 'object' && body !== null ? String((body as Record<string, unknown>).type) : '';
      return Promise.resolve(table[type] as T);
    },
    health: () => ({
      ok: true,
      consecutiveFailures: 0,
      lastError: null,
      lastLatencyMs: null,
      backoffUntilMs: null,
    }),
  };
}

// The boot reads are promises, so one turn of the microtask queue lands them.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fill(tid: number, timeMs: number, over?: Record<string, unknown>): Record<string, unknown> {
  return {
    tid,
    coin: 'BTC',
    px: '30000.5',
    sz: '0.01',
    side: 'B',
    time: timeMs,
    fee: '0.15',
    closedPnl: '0.0',
    hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    ...(over ?? {}),
  };
}

function position(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    position: {
      coin: 'BTC',
      szi: '0.5',
      entryPx: '29000.0',
      positionValue: '15000.0',
      unrealizedPnl: '250.0',
      liquidationPx: null,
      leverage: { type: 'cross', value: 10 },
      marginUsed: '1500.0',
      cumFunding: { allTime: '3.0', sinceOpen: '1.25', sinceChange: '0.5' },
      ...(over ?? {}),
    },
  };
}

function sentMessages(sock: FakeSocket): Array<Record<string, unknown>> {
  return sock.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function subscribedTypes(sock: FakeSocket, method: string): string[] {
  return sentMessages(sock)
    .filter((m) => m.method === method)
    .map((m) => {
      const s = m.subscription as Record<string, unknown> | undefined;
      const coin = s?.coin === undefined ? '' : `:${String(s.coin)}`;
      return `${String(s?.type ?? '')}${coin}`;
    });
}

test('a snapshot replaces the held fills, anything else appends, and a repeat is not counted twice', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();

  socks.last().deliver({
    channel: 'userFills',
    data: { isSnapshot: true, user: USER, fills: [fill(1, 1000), fill(2, 2000)] },
  });
  assert.deepEqual(
    feed.fills().map((f) => f.tid),
    ['2', '1'],
  );

  // No isSnapshot: this is new business and it adds to what is held.
  socks.last().deliver({ channel: 'userFills', data: { user: USER, fills: [fill(3, 3000)] } });
  assert.deepEqual(
    feed.fills().map((f) => f.tid),
    ['3', '2', '1'],
  );

  // The same fill again, as a resend. tid is the identity, so the list does not grow.
  socks.last().deliver({ channel: 'userFills', data: { user: USER, fills: [fill(3, 3000)] } });
  assert.equal(feed.fills().length, 3);

  // The reconnect replay. It carries everything that was missed, so it stands alone.
  socks.last().deliver({ channel: 'userFills', data: { isSnapshot: true, fills: [fill(9, 9000)] } });
  assert.deepEqual(
    feed.fills().map((f) => f.tid),
    ['9'],
  );
});

test('the client pings on a timer, because a quiet account never gives the venue a reason to speak', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  const sock = socks.last();
  sock.open();

  const pings = (): number => sentMessages(sock).filter((m) => m.method === 'ping').length;
  assert.equal(pings(), 0);
  mock.timers.tick(30_000);
  assert.equal(pings(), 1);
  mock.timers.tick(30_000);
  assert.equal(pings(), 2);

  // The venue answers with a bare channel and no data key. It counts as traffic and nothing else.
  sock.deliver({ channel: 'pong' });
  assert.notEqual(feed.status().lastMessageMs, null);
  assert.equal(feed.status().lastError, null);

  // A dead socket is not written to, so a ping cannot resurrect a closed connection.
  sock.drop();
  const before = sock.sent.length;
  mock.timers.tick(30_000);
  assert.equal(sock.sent.length, before);
});

test('reconnect backoff grows, and a fresh connection resubscribes the account and every watched coin', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();
  feed.watch(['ETH']);
  assert.equal(socks.all.length, 1);

  socks.last().drop();
  assert.equal(feed.status().connected, false);
  assert.equal(feed.status().since, null);

  // First retry waits a second.
  mock.timers.tick(999);
  assert.equal(socks.all.length, 1);
  mock.timers.tick(1);
  assert.equal(socks.all.length, 2);

  // That attempt never opened, so the next wait is doubled, not repeated.
  socks.last().drop();
  mock.timers.tick(1999);
  assert.equal(socks.all.length, 2);
  mock.timers.tick(1);
  assert.equal(socks.all.length, 3);

  socks.last().open();
  assert.deepEqual(subscribedTypes(socks.last(), 'subscribe'), [
    'clearinghouseState',
    'openOrders',
    'userFills',
    'userEvents',
    'activeAssetData:ETH',
    'activeAssetCtx:ETH',
  ]);
  const status = feed.status();
  assert.equal(status.connected, true);
  assert.equal(status.reconnects, 1);
  assert.notEqual(status.since, null);
});

test('a number the venue cannot state reads as null and never as zero', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();
  feed.watch(['BTC']);

  socks.last().deliver({
    channel: 'clearinghouseState',
    data: {
      marginSummary: { accountValue: 'n/a', totalRawUsd: '', totalMarginUsed: '1500.0' },
      crossMaintenanceMarginUsed: '750.0',
      withdrawable: '',
      assetPositions: [position()],
      time: 1_700_000_000_000,
    },
  });
  const acc = feed.account();
  assert.ok(acc !== null);
  assert.equal(acc.equityUsd, null);
  assert.notEqual(acc.equityUsd, 0);
  assert.equal(acc.withdrawableUsd, null);
  assert.equal(acc.freeUsd, null);
  assert.equal(acc.marginUsedUsd, 1500);
  assert.equal(acc.maintenanceUsd, 750);
  // A cross position reports no liquidation price. Zero there would read as infinite room.
  assert.equal(acc.positions[0].liqPx, null);
  assert.equal(acc.positions[0].fundingPaidUsd, 1.25);

  socks.last().deliver({
    channel: 'activeAssetCtx',
    data: {
      coin: 'BTC',
      ctx: {
        markPx: '30000.0',
        oraclePx: 'unavailable',
        midPx: '',
        funding: '0.0000125',
        openInterest: '1200.5',
        dayNtlVlm: '98000000.0',
        premium: '0.0004',
      },
    },
  });
  const ctx = feed.market('BTC');
  assert.ok(ctx !== null);
  assert.equal(ctx.oraclePx, null);
  assert.equal(ctx.midPx, null);
  assert.equal(ctx.markPx, 30000);
  assert.equal(ctx.fundingRateHourly, 0.0000125);
  // Open interest is quoted in coins, so USD is the venue's number times the mark.
  assert.equal(ctx.openInterestUsd, 1200.5 * 30000);
  assert.equal(ctx.premiumPct, 0.04);

  // A row with an unreadable field is dropped rather than zero-filled, and says so.
  socks.last().deliver({
    channel: 'clearinghouseState',
    data: {
      marginSummary: { accountValue: '5000.0', totalRawUsd: '5000.0', totalMarginUsed: '0.0' },
      assetPositions: [position({ szi: 'unknown' })],
      time: 1_700_000_001_000,
    },
  });
  assert.equal(feed.account()?.positions.length, 0);
  assert.match(String(feed.status().lastError), /dropped/);
});

test('a unified account is detected from negative raw usd, and its money comes from spot', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({
    wsUrl: WS,
    user: USER,
    info: fakeInfo({
      spotClearinghouseState: {
        balances: [
          { coin: 'USDC', total: '5000.0', hold: '1200.0' },
          { coin: 'HYPE', total: '10.0', hold: '0.0' },
        ],
      },
    }),
    wsImpl: socks.make,
  });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();

  // Position equity, not the account's money: the perp side has drawn its margin from spot,
  // which is what pushes totalRawUsd below zero.
  socks.last().deliver({
    channel: 'clearinghouseState',
    data: {
      marginSummary: { accountValue: '1234.5', totalRawUsd: '-765.5', totalMarginUsed: '400.0' },
      crossMaintenanceMarginUsed: '200.0',
      withdrawable: '0.0',
      assetPositions: [position()],
      time: 1_700_000_000_000,
    },
  });

  const acc = feed.account();
  assert.ok(acc !== null);
  assert.equal(acc.unified, true);
  // Not 1234.5, which is position equity, and not 0.0, which is what withdrawable claims.
  assert.equal(acc.equityUsd, 5000);
  assert.equal(acc.withdrawableUsd, 3800);
  assert.equal(acc.marginUsedUsd, 400);
});

test('a flat unified account is detected from zero equity plus collateral that is still there', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();
  feed.watch(['BTC']);

  socks.last().deliver({
    channel: 'clearinghouseState',
    data: {
      marginSummary: { accountValue: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
      withdrawable: '0.0',
      assetPositions: [],
      time: 1_700_000_000_000,
    },
  });
  // Zero equity on its own is just an empty account.
  assert.equal(feed.account()?.unified, false);

  socks.last().deliver({
    channel: 'activeAssetData',
    data: {
      user: USER,
      coin: 'BTC',
      leverage: { type: 'cross', value: 10 },
      maxTradeSzs: ['1.5', '1.5'],
      // Two elements, no labels on them. Live behaviour is [buy, sell].
      availableToTrade: ['4200.0', '4200.0'],
      markPx: '30000.0',
    },
  });
  const acc = feed.account();
  assert.ok(acc !== null);
  assert.equal(acc.unified, true);
  assert.equal(acc.freeUsd, 4200);
  assert.notEqual(acc.freeUsd, 0);
  // The mark from activeAssetData fills the gap until the context lands.
  assert.equal(feed.market('BTC')?.markPx, 30000);
});

test('watch() subscribes only what changed and never tears down the socket to do it', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  const sock = socks.last();
  sock.open();

  feed.watch(['BTC', 'ETH']);
  const afterFirst = sock.sent.length;
  assert.deepEqual(subscribedTypes(sock, 'subscribe').slice(4), [
    'activeAssetData:BTC',
    'activeAssetCtx:BTC',
    'activeAssetData:ETH',
    'activeAssetCtx:ETH',
  ]);

  // The same set again is a no-op, in either order.
  feed.watch(['ETH', 'BTC']);
  assert.equal(sock.sent.length, afterFirst);

  feed.watch(['ETH', 'SOL']);
  const changed = sock.sent.slice(afterFirst).map((raw) => JSON.parse(raw) as Record<string, unknown>);
  assert.deepEqual(
    changed.map((m) => `${String(m.method)} ${String((m.subscription as Record<string, unknown>).type)}:${String((m.subscription as Record<string, unknown>).coin)}`),
    [
      'unsubscribe activeAssetData:BTC',
      'unsubscribe activeAssetCtx:BTC',
      'subscribe activeAssetData:SOL',
      'subscribe activeAssetCtx:SOL',
    ],
  );
  // ETH was watched before and after, so nothing was said about it.
  assert.equal(
    changed.filter((m) => (m.subscription as Record<string, unknown>).coin === 'ETH').length,
    0,
  );
  // One socket throughout. Changing a coin costs two frames, not a reconnect.
  assert.equal(socks.all.length, 1);
  assert.equal(feed.status().connected, true);
  // A coin the venue does not list would subscribe to a channel that never sends.
  feed.watch(['ETH', 'SOL', 'NOTACOIN']);
  assert.match(String(feed.status().lastError), /unknown coin NOTACOIN/);
});

test('fills are capped, newest first, whichever channel they arrive on', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), maxFills: 3, wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();

  socks.last().deliver({
    channel: 'userFills',
    data: {
      isSnapshot: true,
      fills: [fill(1, 1000), fill(2, 2000), fill(3, 3000), fill(4, 4000), fill(5, 5000)],
    },
  });
  assert.deepEqual(
    feed.fills().map((f) => f.tid),
    ['5', '4', '3'],
  );

  // userEvents replies on a channel called `user`, and a liquidation is the presence of the
  // object, not a flag.
  socks.last().deliver({
    channel: 'user',
    data: {
      fills: [
        fill(6, 6000, {
          side: 'A',
          liquidation: { liquidatedUser: USER, markPx: '28000.0', method: 'market' },
        }),
      ],
    },
  });
  const fills = feed.fills();
  assert.deepEqual(
    fills.map((f) => f.tid),
    ['6', '5', '4'],
  );
  assert.equal(fills[0].liquidation, true);
  assert.equal(fills[0].side, 'sell');
  assert.equal(fills[1].liquidation, false);
});

test('a trigger order keeps its trigger line separate from the slippage bound it fires with', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  socks.last().open();

  socks.last().deliver({
    channel: 'openOrders',
    data: {
      isSnapshot: true,
      orders: [
        {
          coin: 'BTC',
          oid: 77,
          side: 'A',
          sz: '0.5',
          limitPx: '27000.0',
          timestamp: 1_700_000_000_000,
          triggerPx: '30000.0',
          triggerCondition: 'tp/sl',
          isTrigger: true,
          orderType: 'Stop Market',
          tif: null,
          reduceOnly: true,
          cloid: null,
        },
        {
          coin: 'ETH',
          oid: 78,
          side: 'B',
          sz: '2.0',
          limitPx: '3000.0',
          timestamp: 1_700_000_001_000,
          triggerPx: '0.0',
          triggerCondition: 'N/A',
          isTrigger: false,
          orderType: 'Limit',
          tif: 'Gtc',
          reduceOnly: false,
          cloid: '0xabc',
        },
      ],
    },
  });

  const [stop, resting] = feed.orders();
  assert.equal(stop.isTrigger, true);
  assert.equal(stop.triggerPx, 30000);
  assert.equal(stop.limitPx, 27000);
  assert.equal(stop.side, 'sell');
  assert.equal(stop.reduceOnly, true);
  // A resting order carries triggerPx "0.0", which is not a line at zero.
  assert.equal(resting.isTrigger, false);
  assert.equal(resting.triggerPx, null);
  assert.equal(resting.cloid, '0xabc');
  assert.equal(resting.tif, 'Gtc');

  // The resting set arrives whole every time, so it replaces rather than accumulating.
  socks.last().deliver({ channel: 'openOrders', data: { orders: [] } });
  assert.equal(feed.orders().length, 0);
});

test('listeners are coalesced, so a burst of venue traffic is one repaint', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();
  let calls = 0;
  feed.onUpdate(() => {
    calls += 1;
  });
  socks.last().open();

  for (let i = 0; i < 20; i++) {
    socks.last().deliver({ channel: 'userFills', data: { fills: [fill(i + 1, 1000 + i)] } });
  }
  assert.equal(calls, 0);
  mock.timers.tick(100);
  assert.equal(calls, 1);

  socks.last().deliver({ channel: 'userFills', data: { fills: [fill(99, 99_000)] } });
  mock.timers.tick(100);
  assert.equal(calls, 2);
});

test('nothing is reported until the venue has said something', async (t) => {
  const socks = fakeSockets();
  const feed = createTradeFeed({ wsUrl: WS, user: USER, info: fakeInfo(), wsImpl: socks.make });
  t.after(() => feed.stop());
  await flush();

  // An empty account snapshot would render as a funded account holding nothing.
  assert.equal(feed.account(), null);
  assert.deepEqual(feed.orders(), []);
  assert.deepEqual(feed.fills(), []);
  assert.equal(feed.market('BTC'), null);
  const status = feed.status();
  assert.equal(status.connected, false);
  assert.equal(status.lastMessageMs, null);
  assert.equal(status.reconnects, 0);

  socks.last().open();
  assert.equal(feed.status().connected, true);
  // A venue-side error names itself in the status a human reads.
  socks.last().deliver({ channel: 'error', data: 'Invalid subscription {"type":"nope"}' });
  assert.match(String(feed.status().lastError), /Invalid subscription/);
});
