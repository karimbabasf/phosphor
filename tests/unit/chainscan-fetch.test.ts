// The one fetch every chain lookup goes through, with an injected fetch so nothing here
// touches the network. The bounds are what has to be asserted: the host list is exact, a
// redirect cannot leave it, a body over the cap is refused, the bucket waits, the cache
// answers the second ask without a call, and a key never reaches a message.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_TTL_MS, chainFetch, createChainFetchState, isAllowedUrl, scrub } from '../../src/chainscan/fetch.ts';
import { HOSTS } from '../../src/chainscan/networks.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler, seen: string[] = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    return await handler(url, init);
  }) as unknown as typeof fetch;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

// A clock the test moves by hand, and a sleep that records what it was asked for and moves it.
function clock(start = 1_000_000) {
  let now = start;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    waits,
  };
}

const ETH = 'https://eth.blockscout.com/api/v2/addresses/0x1';

test('isAllowedUrl accepts every hardcoded host over https and nothing else', () => {
  for (const host of HOSTS) {
    assert.equal(isAllowedUrl(`https://${host}/x`), true, host);
    assert.equal(isAllowedUrl(`http://${host}/x`), false, host);
  }
  for (const url of [
    'https://eth.blockscout.com.evil.tld/x',
    'https://evil.tld/eth.blockscout.com/x',
    'https://blockscout.com/x',
    'https://api.etherscan.io/v2/api',
    'https://mainnet.helius-rpc.com/',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedUrl(url), false, url);
  }
});

test('a host off the list is refused before any request is made', async () => {
  const seen: string[] = [];
  const fetchImpl = fakeFetch(() => json({}), seen);
  await assert.rejects(chainFetch('https://api.etherscan.io/v2/api', {}, { fetchImpl, state: createChainFetchState() }), /not on the allowlist/);
  await assert.rejects(chainFetch('http://eth.blockscout.com/api/v2/addresses/0x1', {}, { fetchImpl, state: createChainFetchState() }), /not on the allowlist/);
  assert.deepEqual(seen, []);
});

test('a redirect off the list is refused, and one on the list is followed with the same checks', async () => {
  const seen: string[] = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/0x1')) return new Response(null, { status: 302, headers: { location: 'https://evil.tld/x' } });
    if (url.endsWith('/0x2')) return new Response(null, { status: 302, headers: { location: '/api/v2/addresses/0x3' } });
    return json({ hash: '0x3' });
  }, seen);
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl, state: createChainFetchState() }), /redirect to evil.tld left the allowlist/);
  assert.equal(seen.length, 1, 'the redirect target was never fetched');
  const answer = await chainFetch('https://eth.blockscout.com/api/v2/addresses/0x2', {}, { fetchImpl, state: createChainFetchState() });
  assert.deepEqual(answer, { hash: '0x3' });
});

test('a body over the cap is refused rather than truncated, by header and by count', async () => {
  const big = JSON.stringify({ items: 'x'.repeat(2000) });
  const declared = fakeFetch(() => json({}, 200, { 'content-length': '5000000' }));
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl: declared, state: createChainFetchState() }), /over the 256 KB cap|over the 262144 byte cap/);
  const streamed = fakeFetch(() => new Response(big, { status: 200 }));
  await assert.rejects(chainFetch(ETH, { cap: 1024 }, { fetchImpl: streamed, state: createChainFetchState() }), /over the 1024 byte cap/);
  const fits = fakeFetch(() => new Response(big, { status: 200 }));
  assert.deepEqual(await chainFetch(ETH, { cap: 4096 }, { fetchImpl: fits, state: createChainFetchState() }), JSON.parse(big));
});

test('a non-JSON answer and an HTTP failure are named failures', async () => {
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl: fakeFetch(() => new Response('<html>', { status: 200 })), state: createChainFetchState() }), /not JSON/);
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl: fakeFetch(() => new Response('nope', { status: 429 })), state: createChainFetchState() }), /http 429/);
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl: fakeFetch(() => new Response('nope', { status: 500 })), state: createChainFetchState() }), /http 500/);
});

test('every request carries a signal and manual redirects', async () => {
  let init: RequestInit | undefined;
  await chainFetch(ETH, {}, {
    fetchImpl: fakeFetch((_url, i) => {
      init = i;
      return json({});
    }),
    state: createChainFetchState(),
  });
  assert.ok(init?.signal instanceof AbortSignal);
  assert.equal(init?.redirect, 'manual');
});

test('the per-host bucket lets Blockscout burst two and then waits half a second per call', async () => {
  const c = clock();
  const seen: string[] = [];
  const deps = { fetchImpl: fakeFetch(() => json({}), seen), state: createChainFetchState(), now: c.now, sleep: c.sleep };
  await chainFetch(`${ETH}a`, {}, deps);
  await chainFetch(`${ETH}b`, {}, deps);
  assert.deepEqual(c.waits, [], 'the burst is free');
  await chainFetch(`${ETH}c`, {}, deps);
  assert.deepEqual(c.waits, [500], 'the third call waited for one token at 2 per second');
  // Another host has its own bucket and does not wait for Blockscout's.
  await chainFetch('https://mempool.space/api/address/bc1q', {}, deps);
  assert.deepEqual(c.waits, [500]);
  // NearBlocks: one call, then two seconds.
  await chainFetch('https://api.nearblocks.io/v3/accounts/a/txns', {}, deps);
  await chainFetch('https://api.nearblocks.io/v3/accounts/b/txns', {}, deps);
  assert.deepEqual(c.waits, [500, 2000]);
  assert.equal(seen.length, 6);
});

test('a wait that would run past the deadline is refused instead of slept', async () => {
  const c = clock();
  const deps = { fetchImpl: fakeFetch(() => json({})), state: createChainFetchState(), now: c.now, sleep: c.sleep, deadline: Date.now() + 100 };
  await chainFetch('https://api.nearblocks.io/v3/accounts/a/txns', {}, deps);
  await assert.rejects(chainFetch('https://api.nearblocks.io/v3/accounts/b/txns', {}, { ...deps, deadline: c.now() + 100 }), /rate limit for api.nearblocks.io/);
  assert.deepEqual(c.waits, []);
});

test('the same URL inside 60 seconds is answered from the cache with no second call', async () => {
  const c = clock();
  const seen: string[] = [];
  const deps = { fetchImpl: fakeFetch(() => json({ n: seen.length }), seen), state: createChainFetchState(), now: c.now, sleep: c.sleep };
  const first = await chainFetch(ETH, {}, deps);
  const second = await chainFetch(ETH, {}, deps);
  assert.deepEqual(first, second);
  assert.equal(seen.length, 1, 'the second ask made a call');
  // A different body is a different question, even to the same URL.
  await chainFetch('https://api.mainnet-beta.solana.com/', { method: 'POST', body: '{"a":1}' }, deps);
  await chainFetch('https://api.mainnet-beta.solana.com/', { method: 'POST', body: '{"a":2}' }, deps);
  assert.equal(seen.length, 3);
  // Past the TTL the answer is fetched again.
  c.advance(CACHE_TTL_MS + 1);
  await chainFetch(ETH, {}, deps);
  assert.equal(seen.length, 4);
});

test('a failure is not cached', async () => {
  let calls = 0;
  const deps = {
    fetchImpl: fakeFetch(() => {
      calls += 1;
      return calls === 1 ? new Response('x', { status: 500 }) : json({ ok: 1 });
    }),
    state: createChainFetchState(),
  };
  await assert.rejects(chainFetch(ETH, {}, deps), /http 500/);
  assert.deepEqual(await chainFetch(ETH, {}, deps), { ok: 1 });
});

test('a configured key rides only to its own host and never lands in a message', async () => {
  const seen: string[] = [];
  const auths: Array<string | undefined> = [];
  const fetchImpl = fakeFetch((_url, init) => {
    auths.push((init?.headers as Record<string, string> | undefined)?.authorization);
    return new Response('nope', { status: 500 });
  }, seen);
  const keys = { blockscoutApiKey: 'BSKEY-SECRET', nearblocksApiKey: 'NBKEY-SECRET' };
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl, state: createChainFetchState(), keys }), (err: Error) => !err.message.includes('SECRET') && /http 500/.test(err.message));
  assert.ok(seen[0].includes('apikey=BSKEY-SECRET'), 'blockscout got its key as a query parameter');
  assert.equal(auths[0], undefined, 'the nearblocks key did not go to blockscout');
  await assert.rejects(chainFetch('https://api.nearblocks.io/v3/txns/x', {}, { fetchImpl, state: createChainFetchState(), keys }), /http 500/);
  assert.equal(auths[1], 'Bearer NBKEY-SECRET');
  assert.ok(!seen[1].includes('SECRET'), 'no key in the nearblocks URL');
  await assert.rejects(chainFetch('https://mempool.space/api/tx/x', {}, { fetchImpl, state: createChainFetchState(), keys }), /http 500/);
  assert.equal(auths[2], undefined);
  assert.ok(!seen[2].includes('SECRET'));
  // A thrown network error that quotes the URL is scrubbed before it leaves.
  const thrower = fakeFetch((url) => {
    throw new Error(`connect failed for ${url}`);
  });
  await assert.rejects(chainFetch(ETH, {}, { fetchImpl: thrower, state: createChainFetchState(), keys }), (err: Error) => !err.message.includes('SECRET') && err.message.includes('[key removed]'));
  assert.equal(scrub('https://x/?apikey=abc&b=1 api-key=zzz'), 'https://x/?apikey=[key removed]&b=1 api-key=[key removed]');
});
