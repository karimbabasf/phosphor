// The snapshot: the server asks the window for a picture of one chart, the window posts a
// JPEG back, and the image is handed to the one tool call waiting for it and never stored.
//
// The rules a broker has to hold: one outstanding request per chart, a TTL after which the
// caller gets nothing rather than waiting forever, and an answer that arrives for a request
// nobody is waiting on is dropped rather than kept for the next caller. The route holds the
// same guard as every other window write (loopback host, same origin, the window token) and
// a body cap well under the server's general one, because an image is the one thing a window
// posts that could be large.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshotBroker, SNAPSHOT_MAX_BYTES, SNAPSHOT_TTL_MS } from '../../src/snapshot.ts';
import { contentFor } from '../../src/mcp-content.ts';
import { bootChartServer } from '../fixtures/chart-server.ts';

// A JPEG header followed by filler: enough to pass the "is this a JPEG" check without being one.
function fakeJpeg(bytes = 64): string {
  const buf = Buffer.alloc(bytes, 0x20);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf.toString('base64');
}

test('the broker asks the window for one chart and hands the answer to the one caller waiting', async () => {
  const frames: { type: string; slot: number; reqId: string }[] = [];
  const broker = createSnapshotBroker({ broadcast: (frame) => frames.push(frame) });
  const waiting = broker.request(1, 1000);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.type, 'snapshot');
  assert.equal(frames[0]?.slot, 1);
  assert.match(frames[0]?.reqId ?? '', /^[0-9a-f]{16}$/);
  assert.equal(broker.pending(1), true);
  assert.equal(broker.pending(0), false);

  assert.equal(broker.deliver(frames[0]?.reqId ?? '', 'abc'), true);
  assert.deepEqual(await waiting, { jpegBase64: 'abc' });
  assert.equal(broker.pending(1), false);
  assert.equal(broker.deliver(frames[0]?.reqId ?? '', 'abc'), false, 'a second answer for the same id has nobody to go to');
});

test('a window that does not answer inside the TTL leaves the caller with null, and a late answer is dropped', async () => {
  const frames: { reqId: string }[] = [];
  const broker = createSnapshotBroker({ broadcast: (frame) => frames.push(frame) });
  const got = await broker.request(0, 20);
  assert.equal(got, null);
  assert.equal(broker.pending(0), false);
  assert.equal(broker.deliver(frames[0]?.reqId ?? '', 'late'), false, 'nothing is kept for a caller that has already gone');
});

test('a second request for the same chart while one is outstanding is refused, and another chart is not', async () => {
  const broker = createSnapshotBroker({ broadcast: () => {} });
  const first = broker.request(0, 50);
  assert.throws(() => broker.request(0, 50), /already being taken/);
  const other = broker.request(2, 50);
  assert.deepEqual(await Promise.all([first, other]), [null, null]);
});

test('the defaults are the ones the spec names', () => {
  assert.equal(SNAPSHOT_TTL_MS, 3000);
  assert.equal(SNAPSHOT_MAX_BYTES, 512 * 1024);
});

test('the proxy turns an image answer into an image block plus the digest, and leaves text alone', () => {
  const image = contentFor({ image: 'abc', mimeType: 'image/jpeg', digest: 'BTC-USD 1h' });
  assert.deepEqual(image, {
    content: [
      { type: 'image', data: 'abc', mimeType: 'image/jpeg' },
      { type: 'text', text: 'BTC-USD 1h' },
    ],
  });
  const text = contentFor({ digest: 'no window' });
  assert.deepEqual(text, { content: [{ type: 'text', text: JSON.stringify({ digest: 'no window' }) }] });
  assert.deepEqual(contentFor([1, 2]), { content: [{ type: 'text', text: '[1,2]' }] });
  // An image that is not a string is not an image block; the JSON goes through as text.
  assert.equal(contentFor({ image: 42, digest: 'x' }).content[0]?.type, 'text');
});

// ---------- the route ----------

test('the route refuses a cross-origin post and a bad token before it looks at the body', async () => {
  const h = await bootChartServer();
  try {
    const foreign = await h.post('/api/chart/snapshot', { token: h.token, reqId: 'x', jpeg: fakeJpeg() }, { origin: 'http://evil.test' });
    assert.equal(foreign.status, 403);
    const noToken = await h.post('/api/chart/snapshot', { reqId: 'x', jpeg: fakeJpeg() });
    assert.equal(noToken.status, 403);
    const badToken = await h.post('/api/chart/snapshot', { token: 'b'.repeat(48), reqId: 'x', jpeg: fakeJpeg() });
    assert.equal(badToken.status, 403);
  } finally {
    await h.close();
  }
});

test('a body over 512 KB is a 413, whether it announces its length or not', async () => {
  const h = await bootChartServer();
  try {
    const big = await h.post('/api/chart/snapshot', { token: h.token, reqId: 'x', jpeg: fakeJpeg(SNAPSHOT_MAX_BYTES + 1024) });
    assert.equal(big.status, 413);
    // Chunked, so no content-length header to refuse on: the cap still holds after the read.
    const res = await fetch(`${h.url}/api/chart/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.url },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: h.token, reqId: 'x', jpeg: fakeJpeg(SNAPSHOT_MAX_BYTES + 1024) })));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    assert.equal(res.status, 413);
  } finally {
    await h.close();
  }
});

test('an answer for a request nobody is waiting on is a 409, and something that is not a JPEG is a 400', async () => {
  const h = await bootChartServer();
  try {
    const stale = await h.post('/api/chart/snapshot', { token: h.token, reqId: 'deadbeefdeadbeef', jpeg: fakeJpeg() });
    assert.equal(stale.status, 409);
    const notJpeg = await h.post('/api/chart/snapshot', { token: h.token, reqId: 'deadbeefdeadbeef', jpeg: Buffer.from('<svg/>').toString('base64') });
    assert.equal(notJpeg.status, 400);
  } finally {
    await h.close();
  }
});

// ---------- the tool ----------

// Opens the window's own stream and hands back the next snapshot frame the server sends.
async function nextSnapshotFrame(url: string): Promise<{ frame: Promise<{ slot: number; reqId: string }>; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: controller.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const frame = (async () => {
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream closed before a snapshot frame');
      buffered += new TextDecoder().decode(value);
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const parsed = JSON.parse(line.slice(6)) as { type: string; slot?: number; reqId?: string };
        if (parsed.type === 'snapshot') return { slot: parsed.slot as number, reqId: parsed.reqId as string };
      }
    }
  })();
  // Closing the stream rejects a frame nobody awaited; that is the expected end, not a failure.
  frame.catch(() => {});
  return { frame, close: () => controller.abort() };
}

test('a window that answers inside the TTL puts the image in the tool answer beside a one-line digest', async () => {
  const h = await bootChartServer();
  const stream = await nextSnapshotFrame(h.url);
  try {
    // Something to say in the digest.
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { add: [{ type: 'rsi' }] }, levels: [{ px: 1 }] } });
    const asking = h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    const frame = await stream.frame;
    assert.equal(frame.slot, 0);
    const posted = await h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: fakeJpeg() });
    assert.equal(posted.status, 200, JSON.stringify(posted.json));
    const out = await asking;
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.image, fakeJpeg());
    assert.equal(out.json.mimeType, 'image/jpeg');
    assert.match(out.json.digest, /BTC-USD 1m/);
    assert.match(out.json.digest, /1 indicator/);
    assert.match(out.json.digest, /1 level/);
    assert.ok(!out.json.digest.includes('\n'), 'one line');
  } finally {
    stream.close();
    await h.close();
  }
});

test('with no window open the digest alone comes back and says so, without waiting the TTL', async () => {
  const h = await bootChartServer();
  try {
    const started = Date.now();
    const out = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    assert.equal(out.status, 200);
    assert.equal(out.json.image, undefined);
    assert.match(out.json.digest, /no window is open/);
    assert.ok(Date.now() - started < SNAPSHOT_TTL_MS, 'nobody to ask means nothing to wait for');
  } finally {
    await h.close();
  }
});

test('a window that is not on the trade screen is not asked, and the digest says which screen it is on', async () => {
  const h = await bootChartServer({ view: 'pro' });
  const stream = await nextSnapshotFrame(h.url);
  try {
    const out = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    assert.equal(out.status, 200);
    assert.equal(out.json.image, undefined);
    assert.match(out.json.digest, /not on the trade screen/);
    assert.match(out.json.digest, /pro/);
  } finally {
    stream.close();
    await h.close();
  }
});

test('a second snapshot of the same chart while one is outstanding is refused', async () => {
  const h = await bootChartServer();
  const stream = await nextSnapshotFrame(h.url);
  try {
    const first = h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    const frame = await stream.frame;
    const second = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'b', args: {} });
    assert.equal(second.status, 409);
    assert.match(String(second.json.error), /already being taken/);
    await h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: fakeJpeg() });
    assert.equal((await first).status, 200);
  } finally {
    stream.close();
    await h.close();
  }
});

test('a snapshot names a chart a layout has not put up by the tool that does', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: { chart: 2 } });
    assert.equal(out.status, 400);
    assert.match(String(out.json.error), /chart_layout/);
  } finally {
    await h.close();
  }
});
