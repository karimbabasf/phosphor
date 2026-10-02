// The window's half of the read gate (src/http/read-gate.ts). Every read the window makes carries
// the read key, which it trades its token for once; no read carries the token, in a header or in a
// URL, because the window reads on its own all the time (every state frame, every reconnect of the
// stream) and those requests go to whatever answers on the port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = (file: string) => readFileSync(new URL(`../../ui/core/${file}`, import.meta.url), 'utf8');
const NET = source('net.js');
const API = source('api.js');
const EVENTS = source('events.js');

const TOKEN = 'w'.repeat(64);
const KEY = 'k'.repeat(64);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
}

function load(options: { trade?: 'ok' | 'down' } = {}) {
  const calls: Call[] = [];
  const sources: Any[] = [];
  const timers: (() => void)[] = [];
  const window: Any = {
    __PHOSPHOR_TOKEN__: TOKEN,
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState: () => {} },
    setTimeout: (fn: () => void) => timers.push(fn),
    setInterval: () => 1,
    clearInterval: () => {},
  };
  class FakeEventSource {
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const sandbox: Any = {
    window,
    document: { addEventListener: () => {} },
    console,
    URLSearchParams,
    AbortController,
    AbortSignal,
    EventSource: FakeEventSource,
    fetch: async (url: string, init: Any = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: String(init.body ?? '') });
      if (url === '/api/read-key') {
        if (options.trade === 'down') throw new TypeError('Failed to fetch');
        const sent = JSON.parse(String(init.body)) as { token?: string };
        return sent.token === window.__PHOSPHOR_TOKEN__ || sent.token === sandbox.nextToken ? answer(200, { read: sent.token === TOKEN ? KEY : 'n'.repeat(64) }) : answer(403, { error: 'the window token is missing or wrong' });
      }
      return answer(200, { ok: true });
    },
  };
  const ctx = createContext(sandbox);
  runInContext(NET, ctx, { filename: 'ui/core/net.js' });
  runInContext(API, ctx, { filename: 'ui/core/api.js' });
  runInContext(EVENTS, ctx, { filename: 'ui/core/events.js' });
  return { sandbox, window, calls, sources, timers, net: window.PhosphorNet, api: window.PhosphorApi, events: window.PhosphorEvents };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

function carriesToken(call: Call): boolean {
  return call.url.includes(TOKEN) || Object.values(call.headers).some((v) => String(v).includes(TOKEN));
}

test('every read the window makes carries the read key, traded once, and never the token', async () => {
  const w = load();
  await w.net.getJson('/api/state');
  await w.net.getJson('/api/trade');
  await w.api.vault();
  const trades = w.calls.filter((c) => c.url === '/api/read-key');
  assert.equal(trades.length, 1, 'the token was traded more than once');
  assert.equal(trades[0].method, 'POST');
  assert.equal(JSON.parse(trades[0].body).token, TOKEN, 'the trade carries the token in its body, like every window write');
  const reads = w.calls.filter((c) => c.method === 'GET');
  assert.deepEqual(reads.map((c) => c.url), ['/api/state', '/api/trade', '/api/vault']);
  for (const read of reads) {
    assert.equal(read.headers['x-phosphor-read'], KEY, `${read.url} went without the read key`);
    assert.equal(carriesToken(read), false, `${read.url} carried the token`);
  }
});

test('health never waits on the trade, and carries the key once the window has it', async () => {
  const w = load();
  await w.api.health();
  assert.deepEqual(w.calls.map((c) => `${c.method} ${c.url}`), ['GET /api/health']);
  assert.equal(w.calls[0].headers['x-phosphor-read'], undefined);
  await w.net.getJson('/api/state');
  await w.api.health();
  const last = w.calls[w.calls.length - 1];
  assert.equal(last.url, '/api/health');
  assert.equal(last.headers['x-phosphor-read'], KEY);
});

test('the stream opens with the key in its URL, and a reconnect trades nothing and sends no token', async () => {
  const w = load();
  w.events.start();
  await flush();
  assert.equal(w.sources.length, 1);
  assert.equal(w.sources[0].url, `/api/events?read=${KEY}`);
  w.sources[0].onerror();
  assert.equal(w.events.state(), 'offline');
  assert.ok(w.timers.length >= 1, 'no retry was scheduled');
  w.timers.shift()!();
  await flush();
  assert.equal(w.sources.length, 2);
  assert.equal(w.sources[1].url, `/api/events?read=${KEY}`);
  assert.equal(w.calls.filter((c) => c.url === '/api/read-key').length, 1, 'a reconnect traded the token again');
  for (const s of w.sources) assert.ok(!s.url.includes(TOKEN));
});

test('a stream that cannot trade for the key says offline and tries again', async () => {
  const w = load({ trade: 'down' });
  w.events.start();
  await flush();
  assert.equal(w.sources.length, 0, 'a stream opened with no key');
  assert.equal(w.events.state(), 'offline');
  assert.ok(w.timers.length >= 1, 'no retry was scheduled');
});

test('a new token is traded again before the next read, and the picture URLs follow the key', async () => {
  const w = load();
  assert.equal(w.net.withRead('/api/coin-image?id=bitcoin'), '/api/coin-image?id=bitcoin', 'a key the window does not hold yet');
  await w.net.getJson('/api/state');
  assert.equal(w.net.withRead('/api/coin-image?id=bitcoin'), `/api/coin-image?id=bitcoin&read=${KEY}`);
  assert.equal(w.net.withRead('/api/events'), `/api/events?read=${KEY}`);
  const next = 'x'.repeat(64);
  w.sandbox.nextToken = next;
  w.net.setToken(next);
  await w.net.getJson('/api/state');
  const trades = w.calls.filter((c) => c.url === '/api/read-key');
  assert.equal(trades.length, 2);
  assert.equal(JSON.parse(trades[1].body).token, next);
  assert.equal(w.calls[w.calls.length - 1].headers['x-phosphor-read'], 'n'.repeat(64));
});

/* A read that is never revalidated is never kept. One of them is the reveal: the recovery phrase it
   brings used to stay in the window's read cache after the Vault row that showed it closed and
   after a lock, where a 304 on the same path would still hand it out. */
test('the words a reveal brings leave no copy in the window once they are handed over', async () => {
  const w = load();
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  const served: number[] = [];
  const passOn = w.sandbox.fetch;
  w.sandbox.fetch = async (url: string, init: Any = {}) => {
    if (!url.startsWith('/api/wallet/reveal/')) return passOn(url, init);
    served.push(served.length);
    return served.length === 1
      ? { ok: true, status: 200, headers: { get: (name: string) => (name === 'etag' ? '"r1"' : null) }, text: async () => '', json: async () => ({ ok: true, what: 'mnemonic', mnemonic: words }) }
      : { ok: false, status: 304, headers: { get: () => null }, text: async () => '', json: async () => null };
  };
  const shown = await w.api.revealFetch('n1');
  assert.deepEqual(shown.mnemonic, words);
  const again = await w.net.getJson('/api/wallet/reveal/n1');
  assert.equal(again.status, 304);
  assert.equal(again.data, undefined, 'the window kept the words after the reveal was spent');
});
