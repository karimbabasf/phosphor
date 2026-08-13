// The client that survives a degraded venue.
//
// Written against a real failure, not a hypothetical one: Hyperliquid's testnet /info went to
// ~16 seconds per call while the runner's feed polled every 2 seconds. Eight requests stacked
// per symbol, the venue started refusing, and the runner logged `fetch failed` forever while an
// armed mandate sat there never seeing a book. No order was ever placed. The bug was not the
// slow venue, it was a poller with no timeout, no dedupe and no backoff.
//
// Each test below is one of the three things that were missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInfoClient } from '../../src/hl/info.ts';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

// A fetch that never settles until released, standing in for the 16-second venue.
function hangingFetch(): { impl: typeof fetch; calls: number; release: (v: unknown) => void } {
  const state = { calls: 0, release: (_v: unknown) => {} };
  const impl = ((_url: string, init?: RequestInit) => {
    state.calls += 1;
    return new Promise<Response>((resolve, reject) => {
      state.release = (v: unknown) => resolve(jsonResponse(v));
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  return { impl, get calls() { return state.calls; }, release: (v: unknown) => state.release(v) } as never;
}

test('a request that outlives its timeout rejects instead of hanging forever', async () => {
  const hang = hangingFetch();
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: hang.impl, timeoutMs: 20 });

  await assert.rejects(
    () => info.post({ type: 'meta' }),
    (err: Error) => {
      assert.match(err.message, /timed out after 20ms/);
      return true;
    },
  );
});

test('two identical requests in flight share one call to the venue', async () => {
  // The actual pile-up fix. A 2s poller against a 16s venue opens eight sockets for one
  // question; joining the in-flight promise means it opens one and eight callers get the answer.
  const hang = hangingFetch();
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: hang.impl, timeoutMs: 5000 });

  const a = info.post({ type: 'activeAssetData', coin: 'BTC' });
  const b = info.post({ type: 'activeAssetData', coin: 'BTC' });
  const c = info.post({ type: 'activeAssetData', coin: 'BTC' });

  assert.equal(hang.calls, 1, 'three identical asks must reach the venue once');
  hang.release({ markPx: '100' });
  assert.deepEqual(await a, { markPx: '100' });
  assert.deepEqual(await b, { markPx: '100' });
  assert.deepEqual(await c, { markPx: '100' });
});

test('different requests are never merged', async () => {
  const hang = hangingFetch();
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: hang.impl, timeoutMs: 5000 });

  // Both are left to time out; catching keeps the rejection from outliving the test.
  const a = info.post({ type: 'activeAssetData', coin: 'BTC' }).catch(() => null);
  const b = info.post({ type: 'activeAssetData', coin: 'ETH' }).catch(() => null);
  assert.equal(hang.calls, 2, 'two coins are two questions');
  hang.release({ markPx: '1' });
  await Promise.all([a, b]);
});

test('a settled request is not cached: the next poll asks again', async () => {
  // Dedupe is in-flight only. Caching a mark price would mean the runner sizes an order
  // against a price the venue has already moved past, which is worse than a slow answer.
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return jsonResponse({ markPx: String(calls) });
  }) as unknown as typeof fetch;
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: impl, timeoutMs: 1000 });

  assert.deepEqual(await info.post({ type: 'x' }), { markPx: '1' });
  assert.deepEqual(await info.post({ type: 'x' }), { markPx: '2' });
  assert.equal(calls, 2);
});

test('repeated failure opens a backoff that fails fast without touching the venue', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const impl = (async () => {
    calls += 1;
    throw new Error('fetch failed');
  }) as unknown as typeof fetch;
  const info = createInfoClient({
    baseUrl: 'http://venue',
    fetchImpl: impl,
    timeoutMs: 50,
    now: () => clock,
    backoffMs: 1000,
    failuresBeforeBackoff: 3,
  });

  for (let i = 0; i < 3; i++) await assert.rejects(() => info.post({ type: 'meta' }));
  assert.equal(calls, 3);

  // Fourth call inside the window must not reach the venue at all.
  await assert.rejects(
    () => info.post({ type: 'meta' }),
    (err: Error) => {
      assert.match(err.message, /backing off/);
      return true;
    },
  );
  assert.equal(calls, 3, 'the backoff must spend no request');

  // Past the window it tries again.
  clock += 1001;
  await assert.rejects(() => info.post({ type: 'meta' }));
  assert.equal(calls, 4);
});

test('one success clears the failure count', async () => {
  let calls = 0;
  let fail = true;
  const impl = (async () => {
    calls += 1;
    if (fail) throw new Error('fetch failed');
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
  const info = createInfoClient({
    baseUrl: 'http://venue',
    fetchImpl: impl,
    timeoutMs: 50,
    backoffMs: 100_000,
    failuresBeforeBackoff: 3,
  });

  for (let i = 0; i < 2; i++) await assert.rejects(() => info.post({ type: 'meta' }));
  fail = false;
  assert.deepEqual(await info.post({ type: 'meta' }), { ok: true });

  fail = true;
  // Two more failures must not trip the backoff, because the counter went back to zero.
  for (let i = 0; i < 2; i++) await assert.rejects(() => info.post({ type: 'meta' }));
  assert.equal(calls, 5, 'still calling: the backoff has not opened');
});

test('a non-200 answer throws with the status and the body', async () => {
  const impl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: impl, timeoutMs: 100 });

  await assert.rejects(
    () => info.post({ type: 'meta' }),
    (err: Error) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /rate limited/);
      return true;
    },
  );
});

test('health reports what the caller needs to show a human', async () => {
  let fail = true;
  const impl = (async () => {
    if (fail) throw new Error('fetch failed');
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
  const info = createInfoClient({ baseUrl: 'http://venue', fetchImpl: impl, timeoutMs: 50 });

  assert.equal(info.health().ok, true, 'a client that has never failed reads healthy');
  await assert.rejects(() => info.post({ type: 'meta' }));
  const bad = info.health();
  assert.equal(bad.ok, false);
  assert.equal(bad.consecutiveFailures, 1);
  assert.match(String(bad.lastError), /fetch failed/);

  fail = false;
  await info.post({ type: 'meta' });
  assert.equal(info.health().ok, true);
  assert.equal(info.health().consecutiveFailures, 0);
  assert.ok(info.health().lastLatencyMs !== null, 'a good call records how long the venue took');
});
