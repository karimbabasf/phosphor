// The one fetch every chain lookup goes through, with every bound applied.
//
// Same rules as src/research.ts, the module this one copies: https only, a host on the list
// character for character, a deadline on every request, redirects followed by hand so each
// hop is checked again, a read that stops at the byte cap. Two things are new here because the
// sources are APIs rather than feeds. A per-host token bucket, because Blockscout and
// NearBlocks throttle by IP and a throttled lookup is a lookup that fails for the next hour.
// And a short cache by URL, because an agent asks the same question three ways in one turn.
//
// Keys are optional, come from config through `deps.keys`, and never appear in an error or a
// log: the one place a key touches a string that leaves this module is the URL, and scrub()
// takes it back out of any message built from one.

import { isTimeout, READ_TIMEOUT_MS, withTimeout } from '../net.ts';
import { HOSTS, NEARBLOCKS_HOST } from './networks.ts';

export type ChainKeys = { blockscoutApiKey?: string; nearblocksApiKey?: string };

type Bucket = { tokens: number; last: number };
type Cached = { at: number; value: unknown };

export type ChainFetchState = { buckets: Map<string, Bucket>; cache: Map<string, Cached> };

export type ChainFetchDeps = {
  fetchImpl?: typeof fetch; // injected by tests so they never touch the network
  keys?: ChainKeys;
  state?: ChainFetchState; // buckets and cache; the process default unless a test wants its own
  now?: () => number; // the bucket and cache clock, injectable so a wait can be asserted
  sleep?: (ms: number) => Promise<void>;
  deadline?: number; // absolute ms for the whole tool call; each request gets what is left
};

export const DEFAULT_CAP = 256 * 1024;
export const LIST_CAP = 2 * 1024 * 1024; // EVM and Bitcoin transaction lists carry inputs
export const CACHE_TTL_MS = 60_000;
export const CACHE_MAX = 256;
export const CALL_BUDGET_MS = 30_000;
const MAX_REDIRECTS = 3;

// Tokens per second and the burst each host allows, under the limits observed live: Blockscout
// answers 180 per window per instance, NearBlocks throttles after 9 quick calls, the public
// Solana RPC allows 100 per 10 s.
const RATES: Readonly<Record<string, { perSecond: number; burst: number }>> = {
  'eth.blockscout.com': { perSecond: 2, burst: 2 },
  'base.blockscout.com': { perSecond: 2, burst: 2 },
  'arbitrum.blockscout.com': { perSecond: 2, burst: 2 },
  [NEARBLOCKS_HOST]: { perSecond: 0.5, burst: 1 },
  'api.mainnet-beta.solana.com': { perSecond: 5, burst: 5 },
  'free.rpc.fastnear.com': { perSecond: 5, burst: 5 },
  'mempool.space': { perSecond: 5, burst: 5 },
};
const DEFAULT_RATE = { perSecond: 1, burst: 1 };

export function createChainFetchState(): ChainFetchState {
  return { buckets: new Map(), cache: new Map() };
}

const DEFAULT_STATE = createChainFetchState();

// ---------- the guard ----------

export function isAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && HOSTS.has(url.host);
}

function hostOf(raw: string): string {
  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    return '(unparseable url)';
  }
  const clean = host.replace(/[^a-zA-Z0-9.:-]/g, '').slice(0, 80);
  return clean === '' ? '(no host)' : clean;
}

// A key must never be read back out of a failure message.
export function scrub(text: string): string {
  return text.replace(/\b(apikey|api-key|api_key)=[^&\s"']*/gi, '$1=[key removed]');
}

// ---------- the bucket ----------

async function take(host: string, deps: Required<Pick<ChainFetchDeps, 'now' | 'sleep' | 'state'>>, deadline: number): Promise<void> {
  const rate = RATES[host] ?? DEFAULT_RATE;
  for (;;) {
    const now = deps.now();
    const bucket = deps.state.buckets.get(host) ?? { tokens: rate.burst, last: now };
    bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.last) * rate.perSecond) / 1000);
    bucket.last = now;
    deps.state.buckets.set(host, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const wait = Math.ceil(((1 - bucket.tokens) / rate.perSecond) * 1000);
    if (now + wait > deadline) throw new Error(`rate limit for ${host}: the next slot is ${wait}ms away and the call would run out of time`);
    await deps.sleep(wait);
  }
}

// ---------- the cache ----------

function cacheGet(state: ChainFetchState, key: string, now: number): { hit: true; value: unknown } | { hit: false } {
  const row = state.cache.get(key);
  if (row === undefined) return { hit: false };
  if (now - row.at > CACHE_TTL_MS) {
    state.cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: row.value };
}

function cachePut(state: ChainFetchState, key: string, value: unknown, now: number): void {
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next().value;
    if (oldest !== undefined) state.cache.delete(oldest);
  }
  state.cache.set(key, { at: now, value });
}

// ---------- the read ----------

async function readCapped(res: Response, cap: number): Promise<string> {
  if (res.body === null) return '';
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) throw new Error(`body of ${declared} bytes is over the ${cap} byte cap`);
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // Over the cap is refused, not truncated: a cut JSON body parses as nothing, and a
      // source that sends more than the cap is a source this lookup was not built for.
      if (bytes > cap) throw new Error(`body is over the ${cap} byte cap`);
      out += decoder.decode(chunk.value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

export type ChainFetchOptions = { method?: 'GET' | 'POST'; body?: string; cap?: number };

// One request: the parsed JSON answer, or a thrown Error whose message names why not, with
// nothing in it that came off the wire except an HTTP status.
export async function chainFetch(url: string, opts: ChainFetchOptions, deps: ChainFetchDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = deps.state ?? DEFAULT_STATE;
  const deadline = deps.deadline ?? Date.now() + CALL_BUDGET_MS;
  const method = opts.method ?? 'GET';
  const cap = opts.cap ?? DEFAULT_CAP;

  if (!isAllowedUrl(url)) throw new Error(`refused: ${hostOf(url)} is not on the allowlist`);
  const key = `${method} ${url} ${opts.body ?? ''}`;
  const cached = cacheGet(state, key, now());
  if (cached.hit) return cached.value;

  const host = new URL(url).host;
  await take(host, { now, sleep, state }, deadline);

  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(target)) throw new Error(`refused: ${hostOf(target)} is not on the allowlist`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('out of time before the request started');

    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'phosphor (chain lookup)' };
    if (method === 'POST') headers['content-type'] = 'application/json';
    // The key rides on the first hop only, to the host it was issued for, and is added here so
    // the cache key above and every message below were built from the keyless URL.
    let request = target;
    const hopHost = new URL(target).host;
    if (hop === 0 && hopHost === NEARBLOCKS_HOST && deps.keys?.nearblocksApiKey) headers.authorization = `Bearer ${deps.keys.nearblocksApiKey}`;
    if (hop === 0 && hopHost.endsWith('.blockscout.com') && deps.keys?.blockscoutApiKey) {
      const keyed = new URL(target);
      keyed.searchParams.set('apikey', deps.keys.blockscoutApiKey);
      request = keyed.toString();
    }

    let res: Response;
    try {
      res = await fetchImpl(request, {
        method,
        body: method === 'POST' ? opts.body : undefined,
        redirect: 'manual',
        signal: withTimeout(Math.min(READ_TIMEOUT_MS, remaining)),
        headers,
      });
    } catch (err) {
      if (isTimeout(err)) throw new Error(`timed out after ${Math.min(READ_TIMEOUT_MS, remaining)}ms`);
      throw new Error(scrub(err instanceof Error ? err.message : String(err)));
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location === null) throw new Error(`http ${res.status} with no location header`);
      const next = new URL(location, target).toString();
      if (!isAllowedUrl(next)) throw new Error(`redirect to ${hostOf(next)} left the allowlist`);
      target = next;
      continue;
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await readCapped(res, cap);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('the answer was not JSON');
    }
    cachePut(state, key, value, now());
    return value;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
