// An agent's heartbeat arrives every five seconds per proxy, and each one used to push a full state
// frame to the window, which then refetched and rebuilt the whole state for a roster that had not
// changed (R5, 2026-09-23). A hello pushes state only when the roster the window draws changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

async function stateFrames(url: string, during: () => Promise<void>): Promise<number> {
  const abort = new AbortController();
  let frames = 0;
  const res = await fetch(`${url}/api/events`, { signal: abort.signal, headers: { origin: url } });
  const reader = res.body!.getReader();
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        frames += (Buffer.from(value).toString('utf8').match(/"type":"state"/g) ?? []).length;
      }
    } catch {
      /* aborted */
    }
  })();
  // Past the frame a new stream is opened with, and past the state debounce (120 ms).
  await new Promise((r) => setTimeout(r, 400));
  frames = 0;
  await during();
  await new Promise((r) => setTimeout(r, 400));
  abort.abort();
  await reading;
  return frames;
}

test('a heartbeat pushes state only when the roster the window draws changed', async () => {
  const h = await bootChartServer();
  const hello = (client: string) => h.post('/api/mcp', { op: 'hello', client, intervalMs: 5000, session: 'beating', secret: h.seat });
  try {
    const arrived = await stateFrames(h.url, async () => {
      assert.equal((await hello('claude-code')).status, 200);
    });
    assert.ok(arrived >= 1, 'an agent arriving is news to the window');

    const beats = await stateFrames(h.url, async () => {
      for (let n = 0; n < 4; n += 1) assert.equal((await hello('claude-code')).status, 200);
    });
    assert.equal(beats, 0, `${beats} state frames for four heartbeats that changed nothing`);

    const renamed = await stateFrames(h.url, async () => {
      assert.equal((await hello('grok')).status, 200);
    });
    assert.ok(renamed >= 1, 'a client that renamed itself on its handshake changes the roster line');
  } finally {
    await h.close();
  }
});
