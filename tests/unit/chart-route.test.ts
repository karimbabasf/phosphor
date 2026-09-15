// GET /api/chart with a slot: the window's render payload for each of the charts a layout put
// up. No slot is the primary, which is what every window built before slots asks for; a slot
// nothing has filled is a 404, never the primary served under another chart's name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';
import type { LiveSocket } from '../../src/market/live.ts';

test('the primary answers with no slot and as slot 0, with the same revision', async () => {
  const h = await bootChartServer();
  try {
    const bare = await h.get('/api/chart');
    assert.equal(bare.status, 200);
    assert.equal(bare.json.slot, 0);
    assert.equal(bare.json.view.product, 'BTC-USD');
    assert.ok(Array.isArray(bare.json.candles));
    const zero = await h.get('/api/chart?slot=0');
    assert.equal(zero.status, 200);
    assert.equal(zero.json.rev, bare.json.rev);
  } finally {
    await h.close();
  }
});

test('a slot no layout has filled is a 404 that names the tool', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.get('/api/chart?slot=2');
    assert.equal(out.status, 404);
    assert.match(String(out.json.error), /chart_layout/);
  } finally {
    await h.close();
  }
});

test('slot=-1, abc, 7, 1.5, 0x1 and an empty slot are refused by name rather than answered with the primary', async () => {
  const h = await bootChartServer();
  try {
    for (const bad of ['-1', 'abc', '7', '1.5', '0x1', '']) {
      const out = await h.get(`/api/chart?slot=${bad}`);
      assert.equal(out.status, 400, `slot=${bad} answered ${out.status}: ${JSON.stringify(out.json).slice(0, 80)}`);
      assert.match(String(out.json.error), /0 to 3/);
    }
    assert.equal((await h.get('/api/chart?slot=0')).json.slot, 0);
    const empty = await h.get('/api/chart?slot=3');
    assert.equal(empty.status, 404, 'a slot inside the four that no layout filled stays a 404');
  } finally {
    await h.close();
  }
});

/* ---------- the latency beside the state word ----------

   The number the window prints beside "live". It used to come off the trading socket's account
   snapshot, which the venue pushes every 5 s, so it climbed to 5000 ms and reset on a chart
   whose price moved every half second. It is the venue's delay on the socket serving the
   chart now, and it is only there while that socket is what serves the chart. */

type FakeSocket = LiveSocket & { open(): void; deliver(msg: unknown): void; sent: unknown[] };

function fakeSocket(): { make: (url: string) => LiveSocket; last: () => FakeSocket } {
  const all: FakeSocket[] = [];
  return {
    make(url: string): LiveSocket {
      void url;
      const sock: FakeSocket = {
        readyState: 0,
        sent: [],
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data: string) => {
          sock.sent.push(JSON.parse(data));
        },
        close: () => {
          sock.readyState = 3;
          sock.onclose?.();
        },
        open: () => {
          sock.readyState = 1;
          sock.onopen?.();
        },
        deliver: (msg: unknown) => sock.onmessage?.({ data: JSON.stringify(msg) }),
      };
      all.push(sock);
      return sock;
    },
    last: () => all[all.length - 1] as FakeSocket,
  };
}

test('the chart carries the venue latency only while the socket is what serves it', async () => {
  const sockets = fakeSocket();
  const h = await bootChartServer({ liveSocket: sockets.make });
  try {
    const before = await h.get('/api/chart');
    assert.notEqual(before.json.meta.feed, 'live', 'no socket has spoken yet');
    assert.equal(before.json.meta.latencyMs, null, 'a delay on a feed that is not live is a number about the wrong thing');

    // The read subscribed the rail. Open the socket, answer its ping, and push the forming bar.
    sockets.last().open();
    assert.ok((sockets.last().sent as { method: string }[]).some((m) => m.method === 'ping'), 'the open pings the venue');
    sockets.last().deliver({ channel: 'pong' });
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    sockets.last().deliver({
      channel: 'candle',
      data: { t: String(minute), T: String(minute + 59_999), s: 'BTC', i: '1m', o: '100', h: '101', l: '99', c: '100.5', v: '3', n: '1' },
    });

    const live = await h.get('/api/chart');
    assert.equal(live.json.meta.feed, 'live');
    assert.equal(typeof live.json.meta.latencyMs, 'number');
    assert.ok(live.json.meta.latencyMs >= 0 && live.json.meta.latencyMs < 5_000, `a round trip, got ${live.json.meta.latencyMs}`);
  } finally {
    await h.close();
  }
});
