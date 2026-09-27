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
type Cached = { at: number; value: unknown; ttl: number };

// A chain head kept between reads by src/chainscan/index.ts: the last one read and when, and
// when a read was last tried, answered or not.
export type KeptHead = { head: { height: number; time: string | null } | null; at: number; tried: number };

export type ChainFetchState = {
  buckets: Map<string, Bucket>;
  cache: Map<string, Cached>;
  heads: Map<string, KeptHead>; // by network
  flights: Map<string, Promise<void>>; // the head read on the wire, by network
};

// Slots a read of several requests paid for before its first one left (see reserve()).
export type Prepaid = { host: string; left: number };

export type ChainFetchDeps = {
  fetchImpl?: typeof fetch; // injected by tests so they never touch the network
  keys?: ChainKeys;
  state?: ChainFetchState; // buckets and cache; the process default unless a test wants its own
  now?: () => number; // the bucket and cache clock, injectable so a wait can be asserted
  sleep?: (ms: number) => Promise<void>;
  deadline?: number; // absolute ms for the whole tool call; each request gets what is left
  wait?: boolean; // false: a request with no slot free fails at once instead of sleeping (the chain head)
  prepaid?: Prepaid; // spent before the bucket is asked
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
  /* The hosts added on 2026-09-26, each under its own published or observed limit. publicnode
     publishes none and answered every burst we sent; the single-operator chain RPCs get less.
     TronGrid suspends a keyless caller for 5 s past 3 a second, toncenter allows 1 a second
     without a key (three calls exactly a second apart drew a 429, so a third slower here), Horizon 3600 an hour, BlockCypher 3 a second and 100 an hour (so its bucket
     refills at the hourly rate), Blockchain.com asks for one call every 10 s, and the
     Hyperliquid info API weighs this call at 2 of 1200 a minute. */
  'ethereum-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'base-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'arbitrum-one-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'mainnet.optimism.io': { perSecond: 2, burst: 2 },
  'gnosis-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'polygon-bor-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'bsc-dataseed.bnbchain.org': { perSecond: 5, burst: 5 },
  'avalanche-c-chain-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'scroll-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'rpc.berachain.com': { perSecond: 2, burst: 2 },
  'robinhood-rpc.publicnode.com': { perSecond: 5, burst: 5 },
  'starknet-rpc.publicnode.com': { perSecond: 2, burst: 2 },
  'rpc.monad.xyz': { perSecond: 2, burst: 2 },
  'rpc.xlayer.tech': { perSecond: 2, burst: 2 },
  'rpc.plasma.to': { perSecond: 2, burst: 2 },
  'rpc.adifoundation.ai': { perSecond: 1, burst: 1 },
  'api.mainnet.abs.xyz': { perSecond: 2, burst: 2 },
  'mainnet.fogo.io': { perSecond: 2, burst: 2 },
  'litecoinspace.org': { perSecond: 2, burst: 2 },
  'api.blockchain.info': { perSecond: 0.1, burst: 2 },
  'api.blockcypher.com': { perSecond: 100 / 3600, burst: 3 },
  'insight.dash.org': { perSecond: 1, burst: 1 },
  'xrplcluster.com': { perSecond: 5, burst: 5 },
  'toncenter.com': { perSecond: 0.75, burst: 1 },
  'api.trongrid.io': { perSecond: 2, burst: 2 },
  'graphql.mainnet.sui.io': { perSecond: 2, burst: 2 },
  'api.mainnet.aptoslabs.com': { perSecond: 2, burst: 2 },
  'mainnet.movementnetwork.xyz': { perSecond: 2, burst: 2 },
  'api.koios.rest': { perSecond: 0.5, burst: 2 },
  'horizon.stellar.org': { perSecond: 1, burst: 2 },
  'api.explorer.provable.com': { perSecond: 1, burst: 2 },
  'api.hyperliquid.xyz': { perSecond: 2, burst: 2 },
  'rpc.hyperliquid.xyz': { perSecond: 1, burst: 2 },
};
const DEFAULT_RATE = { perSecond: 1, burst: 1 };

export function createChainFetchState(): ChainFetchState {
  return { buckets: new Map(), cache: new Map(), heads: new Map(), flights: new Map() };
}

const DEFAULT_STATE = createChainFetchState();

export function stateOf(deps: ChainFetchDeps): ChainFetchState {
  return deps.state ?? DEFAULT_STATE;
}

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

function refill(host: string, state: ChainFetchState, now: number): Bucket {
  const rate = RATES[host] ?? DEFAULT_RATE;
  const bucket = state.buckets.get(host) ?? { tokens: rate.burst, last: now };
  bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.last) * rate.perSecond) / 1000);
  bucket.last = now;
  state.buckets.set(host, bucket);
  return bucket;
}

async function take(host: string, deps: Required<Pick<ChainFetchDeps, 'now' | 'sleep' | 'state'>> & Pick<ChainFetchDeps, 'wait' | 'prepaid'>, deadline: number): Promise<void> {
  if (deps.prepaid !== undefined && deps.prepaid.host === host && deps.prepaid.left > 0) {
    deps.prepaid.left -= 1;
    return;
  }
  const rate = RATES[host] ?? DEFAULT_RATE;
  for (;;) {
    const now = deps.now();
    const bucket = refill(host, deps.state, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const wait = Math.ceil(((1 - bucket.tokens) / rate.perSecond) * 1000);
    if (deps.wait === false) throw new Error(`rate limit for ${host}: the next slot is ${wait}ms away and this read does not wait`);
    if (now + wait > deadline) throw new Error(`rate limit for ${host}: the next slot is ${wait}ms away and the call would run out of time`);
    await deps.sleep(wait);
  }
}

/* A read of several requests that must never wait (the chain head) takes every slot it needs
   at once, or none and does not start: a lookup that starts beside it can then never leave it
   half read. Capped at the host's burst, so a read of more requests than the burst still
   starts. Null when the host has fewer free right now. */
export function reserve(host: string, n: number, deps: ChainFetchDeps): Prepaid | null {
  const need = Math.min(n, (RATES[host] ?? DEFAULT_RATE).burst);
  const bucket = refill(host, stateOf(deps), (deps.now ?? Date.now)());
  if (bucket.tokens < need) return null;
  bucket.tokens -= need;
  return { host, left: need };
}

// Slots a read did not spend, because an answer came from the cache or the read failed first,
// go back to the bucket.
export function refund(prepaid: Prepaid, deps: ChainFetchDeps): void {
  const bucket = refill(prepaid.host, stateOf(deps), (deps.now ?? Date.now)());
  bucket.tokens = Math.min((RATES[prepaid.host] ?? DEFAULT_RATE).burst, bucket.tokens + prepaid.left);
  prepaid.left = 0;
}

// The host's sustained rate in requests per second, what a budget is computed from.
export function ratePerSecond(host: string): number {
  return (RATES[host] ?? DEFAULT_RATE).perSecond;
}

// ---------- the cache ----------

function cacheGet(state: ChainFetchState, key: string, now: number): { hit: true; value: unknown } | { hit: false } {
  const row = state.cache.get(key);
  if (row === undefined) return { hit: false };
  if (now - row.at > row.ttl) {
    state.cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: row.value };
}

function cachePut(state: ChainFetchState, key: string, value: unknown, now: number, ttl: number): void {
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next().value;
    if (oldest !== undefined) state.cache.delete(oldest);
  }
  state.cache.set(key, { at: now, value, ttl });
}

/* A whole number past 2^53 arrives as JSON text a float cannot hold: a Dogecoin whale's balance
   in satoshis, a Solana account's lamports. The reviver hands such a number back as its own
   digits, which every amount parser here reads exactly, so no balance is ever rounded on the
   way in. Every other value parses as it always did. */
function exact(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source) ? context.source : value;
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

// `ttl` shortens how long the answer is served from the cache, for a question whose answer
// moves faster than a minute (the chain head).
export type ChainFetchOptions = { method?: 'GET' | 'POST'; body?: string; cap?: number; ttl?: number };

// One request: the parsed JSON answer, or a thrown Error whose message names why not, with
// nothing in it that came off the wire except an HTTP status.
export async function chainFetch(url: string, opts: ChainFetchOptions, deps: ChainFetchDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = stateOf(deps);
  const deadline = deps.deadline ?? Date.now() + CALL_BUDGET_MS;
  const method = opts.method ?? 'GET';
  const cap = opts.cap ?? DEFAULT_CAP;

  if (!isAllowedUrl(url)) throw new Error(`refused: ${hostOf(url)} is not on the allowlist`);
  const key = `${method} ${url} ${opts.body ?? ''}`;
  const cached = cacheGet(state, key, now());
  if (cached.hit) return cached.value;

  const host = new URL(url).host;
  await take(host, { now, sleep, state, wait: deps.wait, prepaid: deps.prepaid }, deadline);

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
      value = JSON.parse(text, exact);
    } catch {
      throw new Error('the answer was not JSON');
    }
    cachePut(state, key, value, now(), opts.ttl ?? CACHE_TTL_MS);
    return value;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
