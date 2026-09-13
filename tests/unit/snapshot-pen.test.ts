// The snapshot route and the image pass-through under attack: every way a local process, a
// page or a second window could post a picture that is not the window's, a body that is not a
// JPEG, or one that the model's API would choke on, and the two races the broker has to hold.
// The cases the code already held are kept beside the two it did not (a foreign origin was
// refused only after the body was buffered, and base64 was checked by character set alone), so
// the next reader sees what was tried and not only what was fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { contentFor } from '../../src/mcp-content.ts';

function jpegOf(body: Buffer): string {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), body]).toString('base64');
}

function fakeJpeg(bytes = 64): string {
  return jpegOf(Buffer.alloc(bytes, 0x20));
}

// A request with explicit control over Host and Origin, which fetch() will not let a caller set.
function raw(
  urlBase: string,
  route: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: opts.headers ?? {} },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

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
  frame.catch(() => {});
  return { frame, close: () => controller.abort() };
}

test('snapshot: no token, a wrong token, no Origin, a null Origin, a foreign Origin, a forged Host and GET are all refused', async () => {
  const h = await bootChartServer();
  try {
    const good = { token: h.token, reqId: 'x', jpeg: fakeJpeg() };
    assert.equal((await h.post('/api/chart/snapshot', { reqId: 'x', jpeg: fakeJpeg() })).status, 403);
    assert.equal((await h.post('/api/chart/snapshot', { ...good, token: 'b'.repeat(48) })).status, 403);
    assert.equal((await h.post('/api/chart/snapshot', good, { origin: 'http://evil.test' })).status, 403);
    const body = JSON.stringify(good);
    const json = { 'content-type': 'application/json' };
    const noOrigin = await raw(h.url, '/api/chart/snapshot', { method: 'POST', headers: json, body });
    assert.equal(noOrigin.status, 403, 'a local process with no Origin is not the window');
    const nullOrigin = await raw(h.url, '/api/chart/snapshot', { method: 'POST', headers: { ...json, origin: 'null' }, body });
    assert.equal(nullOrigin.status, 403, 'a sandboxed iframe is not the window');
    const host = new URL(h.url).host;
    const forged = await raw(h.url, '/api/chart/snapshot', { method: 'POST', headers: { ...json, origin: `http://${host}`, host: 'evil.com' }, body });
    assert.equal(forged.status, 403);
    assert.match(forged.body, /127\.0\.0\.1/);
    const get = await raw(h.url, '/api/chart/snapshot');
    assert.equal(get.status, 404, 'the route answers POST only');
  } finally {
    await h.close();
  }
});

test('snapshot: a foreign Origin is refused before the body is read, so a post that never ends its body still gets its 403', async () => {
  const h = await bootChartServer();
  const u = new URL(h.url);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: '/api/chart/snapshot',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.test', 'transfer-encoding': 'chunked' },
  });
  try {
    const answered = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    // Half a body and no end: a server that reads before it refuses waits here for ever.
    req.write('{"token":"');
    const status = await Promise.race([
      answered,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('the server buffered the body before refusing the origin')), 1500).unref()),
    ]);
    assert.equal(status, 403);
  } finally {
    req.destroy();
    await h.close();
  }
});

test('snapshot: a PNG, an HTML document, an SVG, an empty field, a number, junk characters and broken base64 are all 400', async () => {
  const h = await bootChartServer();
  try {
    const cases: [string, unknown][] = [
      ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')],
      ['html', Buffer.from('<!DOCTYPE html><script>alert(1)</script>').toString('base64')],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')],
      ['empty', ''],
      ['number', 42],
      ['junk', `${fakeJpeg(32).slice(0, 12)}!!${fakeJpeg(32).slice(14)}`],
      // A JPEG head, then padding in the middle of the string: Buffer.from() shrugs, the model's
      // API does not, and the agent's turn would die on a 400 from upstream instead of a digest.
      ['padding inside', `${fakeJpeg(32).slice(0, 12)}==${fakeJpeg(32).slice(12)}`],
      ['length not a multiple of four', `${fakeJpeg(32)}A`],
    ];
    for (const [name, jpeg] of cases) {
      const out = await h.post('/api/chart/snapshot', { token: h.token, reqId: 'deadbeefdeadbeef', jpeg });
      assert.equal(out.status, 400, `${name}: ${JSON.stringify(out.json)}`);
      assert.match(String(out.json.error), /base64 JPEG/);
    }
  } finally {
    await h.close();
  }
});

test('snapshot: a JPEG header followed by a script is accepted as bytes and reaches the tool as an image block, never as text', async () => {
  const h = await bootChartServer();
  const stream = await nextSnapshotFrame(h.url);
  try {
    const asking = h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    const frame = await stream.frame;
    const polyglot = jpegOf(Buffer.from('<script>document.title="pwned"</script>'));
    const posted = await h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: polyglot });
    assert.equal(posted.status, 200, 'the route checks the magic; the only reader is a vision model, and to it this is a broken picture');
    const out = await asking;
    assert.equal(out.json.image, polyglot);
    const content = contentFor(out.json).content;
    assert.equal(content[0]?.type, 'image', 'the bytes go out as an image block');
    assert.equal(content[1]?.type, 'text');
    assert.ok(!String((content[1] as { text: string }).text).includes('<script>'), 'and the digest never carries them as text');
  } finally {
    stream.close();
    await h.close();
  }
});

test('snapshot: two windows racing one request id, the first picture wins and the second is a 409 that does not replace it', async () => {
  const h = await bootChartServer();
  const stream = await nextSnapshotFrame(h.url);
  try {
    const asking = h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    const frame = await stream.frame;
    const a = jpegOf(Buffer.alloc(16, 0x41));
    const b = jpegOf(Buffer.alloc(16, 0x42));
    const [first, second] = await Promise.all([
      h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: a }),
      h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: b }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const out = await asking;
    assert.equal(out.json.image, first.status === 200 ? a : b, 'the tool got exactly the picture the 200 delivered');
  } finally {
    stream.close();
    await h.close();
  }
});

test('snapshot: two tool calls racing on one chart, one gets the picture and the other is told it is being taken; a stream reader without the token cannot answer', async () => {
  const h = await bootChartServer();
  const window = await nextSnapshotFrame(h.url);
  const rogue = await nextSnapshotFrame(h.url);
  try {
    const calls = Promise.all([
      h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} }),
      h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'b', args: {} }),
    ]);
    const frame = await window.frame;
    const seen = await rogue.frame;
    assert.equal(seen.reqId, frame.reqId, 'every stream sees the frame');
    const stolen = await h.post('/api/chart/snapshot', { token: 'c'.repeat(48), reqId: seen.reqId, jpeg: fakeJpeg() });
    assert.equal(stolen.status, 403, 'and the id alone buys nothing');
    const posted = await h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: fakeJpeg() });
    assert.equal(posted.status, 200);
    const [x, y] = await calls;
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const won = x.status === 200 ? x : y;
    const lost = x.status === 200 ? y : x;
    assert.equal(won.json.image, fakeJpeg());
    assert.match(String(lost.json.error), /already being taken/);
  } finally {
    window.close();
    rogue.close();
    await h.close();
  }
});

test('the image pass-through refuses what is not base64 and what is not an image type, and never hands the model a blob as text', () => {
  const garbage = contentFor({ image: 'not base64!', digest: 'chart 0' });
  assert.equal(garbage.content.length, 1);
  assert.equal(garbage.content[0]?.type, 'text');
  assert.ok(!String((garbage.content[0] as { text: string }).text).includes('not base64!'), 'the bad blob is dropped, not printed');
  assert.match(String((garbage.content[0] as { text: string }).text), /chart 0/);
  const padded = contentFor({ image: 'abc', digest: 'x' });
  assert.equal(padded.content[0]?.type, 'text', 'a length that is not a multiple of four is not base64');
  const mime = contentFor({ image: 'abc=', mimeType: 'text/html', digest: 'x' });
  assert.equal(mime.content[0]?.type, 'image');
  assert.equal((mime.content[0] as { mimeType: string }).mimeType, 'image/jpeg', 'a type that is not an image falls back to the one the window encodes');
  const fine = contentFor({ image: '/9j/4AAQ', mimeType: 'image/jpeg', digest: 'x' });
  assert.deepEqual(fine.content[0], { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' });
});

test('snapshot: a 600 KB announced body is refused before it is read, and a delivered request id cannot be replayed', async () => {
  const h = await bootChartServer();
  const u = new URL(h.url);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: '/api/chart/snapshot',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.url, 'content-length': String(600 * 1024) },
  });
  const stream = await nextSnapshotFrame(h.url);
  try {
    const answered = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    // The right token at the front of a body that never ends: a server that reads the announced
    // 600 KB before judging it waits here for ever.
    req.write(`{"token":"${h.token}","reqId":"x","jpeg":"`);
    const status = await Promise.race([
      answered,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('the server read the body before refusing its length')), 1500).unref()),
    ]);
    assert.equal(status, 413);

    // A request id is spent by the answer that lands on it. The same id again, a number, an
    // object and an id of the right shape nobody asked for are all 409, and none of them reaches
    // a tool call.
    const asking = h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'a', args: {} });
    const frame = await stream.frame;
    const first = await h.post('/api/chart/snapshot', { token: h.token, reqId: frame.reqId, jpeg: fakeJpeg() });
    assert.equal(first.status, 200);
    assert.equal((await asking).json.image, fakeJpeg());
    for (const reqId of [frame.reqId, 42, { id: frame.reqId }, [frame.reqId], null, 'f'.repeat(16), '']) {
      const again = await h.post('/api/chart/snapshot', { token: h.token, reqId, jpeg: fakeJpeg() });
      assert.equal(again.status, 409, JSON.stringify(reqId));
      assert.match(String(again.json.error), /no snapshot is waiting/);
    }
  } finally {
    req.destroy();
    stream.close();
    await h.close();
  }
});
