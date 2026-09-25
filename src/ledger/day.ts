// The day feed: the last 24 hours of every coin NEAR Intents lists, for Pro's line and change.
//
// WHY IT EXISTS (2026-09-25). Pro drew a coin's day off 25 hourly Coinbase candles, and only for
// the seven markets config.json names (candleProducts), so a held VVV, LTC or ZEC had no line and
// no change beside it. Karim: "the token list shouldnt be hardcoded, we had this issue before". So
// the coins come off 1Click's own token list, read live, which names a CoinGecko id for 188 of its
// 197 assets, and one keyless call to CoinGecko's markets endpoint answers the day for every one of
// them in about half a second.
//
// ALL OF THEM, NEVER THE HELD ONES. The call names every id on the list, whatever this wallet
// holds, and it is made on a clock rather than when a coin arrives: a call for the held coins alone
// would tell a third party what this person owns. Nothing here reads a balance, and the assets the
// window asks about (answer) are only ever looked up in what the last call already brought back.
//
// THE SAME ANSWER NAMES EACH COIN'S PICTURE, so the feed keeps those URLs too (pictureUrls), and
// src/ledger/pictures.ts fetches every listed coin's into a cache on disk for the window's logos.
//
// UNTRUSTED. The answer is somebody else's JSON. A row counts only for an id that was asked for,
// with a finite 24 hour change above -100% and inside a sane bound, and a line of finite positive
// prices. A row that fails any of it is dropped, never repaired, and a coin with no row has no day:
// Pro falls back to its candles or shows nothing, never a made-up number.
//
// A FAILED READ KEEPS THE LAST GOOD DAY, with the time it was read, and waits longer before the
// next: the free tier answers 429 when pressed, and pressing again on every tick is how it stays
// shut. What is served ages out after an hour, so a feed that stopped answering hands Pro back to
// the candles rather than a day that ended hours ago.
import type { OneClickToken } from '../intents.ts';
import { oneLine } from '../intents.ts';
import { readTimeout } from '../net.ts';

// How often src/main.ts asks, and how long the window keeps a day before it reads again.
export const DAY_REFRESH_MS = 5 * 60_000;
// Hourly points: the price now and the 24 hours before it.
export const DAY_POINTS = 25;
// Twelve refreshes missed in a row. Past this the last good day is kept but no longer served.
export const DAY_STALE_MS = 60 * 60_000;
// The longest a failure waits before the next try, whatever Retry-After asked for.
const DAY_BACKOFF_MAX_MS = 60 * 60_000;

const MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';
// The endpoint's own page ceiling: past this the ids go in more than one call.
const IDS_PER_CALL = 250;
/* The most of one answer that is read. Today's, 98 ids with their week of hourly points, is about
   half a megabyte; the read deadline bounds the time and not the size, and a hostile endpoint can
   stream hundreds of megabytes inside it. Past this the answer is a failed read. */
export const DAY_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
// The ids joined, per call. Keeps the URL near 4 KB, well under the 8 KB most servers take.
const IDS_CHARS_PER_CALL = 4_000;
// A hundredfold in a day. A figure past it is far more likely a broken row than a market.
const SANE_CHANGE_PCT = 10_000;
// What a CoinGecko id looks like: 'venice-token', 'usd-coin'. 1Click also writes 'custom:ssc1-pit',
// which is none, and anything that is not this shape never reaches a URL or a file name.
const COINGECKO_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/* Where a coin's picture may come from: CoinGecko's image host, over https, and nowhere else.
   Every one of the 92 rows answered on 2026-09-25 named it. See src/ledger/pictures.ts. */
const PICTURE_HOST = 'coin-images.coingecko.com';
const PICTURE_URL_MAX = 500;

export function coingeckoIdOk(id: unknown): id is string {
  return typeof id === 'string' && COINGECKO_ID.test(id);
}

/* A row's `image` when it is a picture this app will fetch, as a URL string, else null: https,
   the image host, no credentials, no port but the default, and a length a URL has. */
export function pictureUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > PICTURE_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== PICTURE_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  return url.toString();
}

export type DayEntry = {
  change24: number; // percent, the line's own: its first point to its last (see parseMarkets)
  line: number[]; // the last DAY_POINTS hourly prices, oldest first, in dollars
  at: number; // when the answer carrying it landed, epoch ms
};

export type DayAnswer = {
  // When the last good refresh landed, epoch ms; null before the first.
  at: number | null;
  // By 1Click asset id. A plain object, so the window can index it.
  entries: Record<string, DayEntry>;
  // Why the last refresh failed, until one succeeds.
  error?: string;
};

export type DayFeed = {
  // Never throws. A tick that lands while one is running joins it; one inside a wait asks nothing.
  refresh(): Promise<void>;
  // One asset's day, or null: not listed, no CoinGecko id, no good row, or older than DAY_STALE_MS.
  entry(assetId: string): DayEntry | null;
  // What GET /api/day hands the window: the named assets, or every listed one when none are named.
  answer(assetIds?: readonly string[]): DayAnswer;
  // Every listed coin's picture, by CoinGecko id, as the markets answer named it: what
  // src/ledger/pictures.ts fetches. Never the held coins alone, because nothing here knows them.
  pictureUrls(): Map<string, string>;
  // Each symbol on the list to the one CoinGecko id it names, for pictures; a symbol naming two
  // coins is left out, and so is one naming an id another symbol names too.
  symbols(): Map<string, string>;
};

export type DayFeedDeps = {
  // The token list. src/main.ts hands in the ledger's (Ledger.tokens), so there is one copy.
  tokens: () => Promise<OneClickToken[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  // Where COINGECKO_API_KEY is read from. A parameter so a test drives both paths without
  // touching the process, as windowToken does in src/http/auth.ts.
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/* Every CoinGecko id the list names, once each and sorted, so the call reads the same whatever
   order 1Click answers in; each asset to its id; and each symbol, as the window keys a logo
   (trimmed, upper case), to its id. An asset whose id is missing or malformed maps to nothing.
   A symbol the list gives two ids, or gives one id on one row and none on another, is no symbol
   here: wBTC is bitcoin on one row and WBTC is wrapped-bitcoin on another, and a picture guessed
   between them could be the wrong coin's.
   THE OTHER WAY ROUND TOO: an id two symbols name is a picture for neither. SUSDC and USAD both
   name usd-coin, so each drew USDC's own logo, and a card for USDC to USAD showed two USDC marks
   over a swap into a different coin (pictures review finding 1). `symbols` is for pictures only:
   the day stays each asset's own id in `idOf`, the market 1Click itself prices that coin off, and
   a wrapped coin's 24 hours are its underlying's in fact, where a borrowed logo claims to be it. */
export function listedIds(list: readonly OneClickToken[]): { ids: string[]; idOf: Map<string, string>; symbols: Map<string, string> } {
  const idOf = new Map<string, string>();
  // Every id each symbol is listed under, '' for a row with none.
  const named = new Map<string, Set<string>>();
  for (const token of list) {
    if (typeof token?.assetId !== 'string') continue;
    const id: unknown = token.coingeckoId;
    const good = coingeckoIdOk(id);
    if (good) idOf.set(token.assetId, id);
    const symbol = typeof token.symbol === 'string' ? token.symbol.trim().toUpperCase() : '';
    if (symbol === '') continue;
    const ids = named.get(symbol) ?? new Set<string>();
    ids.add(good ? id : '');
    named.set(symbol, ids);
  }
  // How many symbols name each id.
  const namers = new Map<string, number>();
  for (const ids of named.values()) {
    for (const id of ids) if (id !== '') namers.set(id, (namers.get(id) ?? 0) + 1);
  }
  const symbols = new Map<string, string>();
  for (const [symbol, ids] of named) {
    const [only] = ids;
    if (ids.size === 1 && only !== '' && namers.get(only) === 1) symbols.set(symbol, only);
  }
  return { ids: [...new Set(idOf.values())].sort(), idOf, symbols };
}

/* The ids split into calls: at most IDS_PER_CALL each and at most IDS_CHARS_PER_CALL of them
   joined. Today's 98 ids are one call of about 960 characters. */
export function callsFor(ids: readonly string[]): string[][] {
  const calls: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const joined = current.length === 0 ? id.length : chars + 1 + id.length;
    if (current.length > 0 && (current.length >= IDS_PER_CALL || joined > IDS_CHARS_PER_CALL)) {
      calls.push(current);
      current = [id];
      chars = id.length;
      continue;
    }
    current.push(id);
    chars = joined;
  }
  if (current.length > 0) calls.push(current);
  return calls;
}

function marketsUrl(ids: readonly string[]): string {
  // Commas as they are: the ids already passed COINGECKO_ID, so nothing in them needs escaping.
  return (
    `${MARKETS_URL}?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}` +
    `&per_page=${IDS_PER_CALL}&page=1&sparkline=true&price_change_percentage=24h`
  );
}

function saneChange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > -100 && value <= SANE_CHANGE_PCT;
}

// The last DAY_POINTS prices, or null when any of them is not a finite positive number or there
// are fewer than two: two points are the least a line can be.
function lineOf(sparkline: unknown): number[] | null {
  const prices = sparkline !== null && typeof sparkline === 'object' ? (sparkline as { price?: unknown }).price : undefined;
  if (!Array.isArray(prices)) return null;
  const day = prices.slice(-DAY_POINTS);
  if (day.length < 2) return null;
  for (const p of day) if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null;
  return day as number[];
}

/* The rows of one markets answer that hold up, by CoinGecko id. `asked` is what the call named:
   a row for anything else is not an answer to this question. The first row for an id stands.

   THE CHANGE IS THE LINE'S, first point to last, as Pro's candle path reads its closes. CoinGecko's
   24 hour figure is live and the sparkline's last point trails it by up to an hour, so the two
   could point opposite ways (the capture of 2026-09-25: ZEC +0.59% over a line that fell 0.25%)
   and Pro colours the line by the change. The figure still has to hold up for the row to count. */
export function parseMarkets(payload: unknown, asked: ReadonlySet<string>, at: number): Map<string, DayEntry> {
  const out = new Map<string, DayEntry>();
  if (!Array.isArray(payload)) return out;
  for (const row of payload) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = r['id'];
    if (typeof id !== 'string' || !asked.has(id) || out.has(id)) continue;
    const line = lineOf(r['sparkline_in_7d']);
    if (!saneChange(r['price_change_percentage_24h']) || line === null) continue;
    const change = ((line[line.length - 1] - line[0]) / line[0]) * 100;
    if (!saneChange(change)) continue;
    out.set(id, { change24: change, line, at });
  }
  return out;
}

/* Each asked id's picture URL, where the row names one pictureUrl accepts. Apart from the day on
   purpose: a coin whose line fails its checks still has a picture, and the reverse. */
export function parseImages(payload: unknown, asked: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(payload)) return out;
  for (const row of payload) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = r['id'];
    if (typeof id !== 'string' || !asked.has(id) || out.has(id)) continue;
    const image = pictureUrl(r['image']);
    if (image !== null) out.set(id, image);
  }
  return out;
}

// The body as text, counted as it arrives. Past the cap the rest is never read, and null says so.
async function readCapped(res: Response): Promise<string | null> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DAY_ANSWER_MAX_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Retry-After in seconds, the only form the endpoint sends. Anything else is no advice.
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

type Read = { ok: true; rows: Map<string, DayEntry>; images: Map<string, string> } | { ok: false; error: string; waitMs: number };

export function createDayFeed(deps: DayFeedDeps): DayFeed {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;

  // Asset id to CoinGecko id and symbol to CoinGecko id, off the newest list read; CoinGecko id to
  // its last good day and to its picture's URL.
  let idOf = new Map<string, string>();
  let symbolIds = new Map<string, string>();
  const byId = new Map<string, DayEntry>();
  const imageById = new Map<string, string>();
  let lastGood: number | null = null;
  let error: string | undefined;
  let failures = 0;
  let retryAt = 0;
  let running: Promise<void> | null = null;

  function apiKey(): string {
    return String(env['COINGECKO_API_KEY'] ?? '').trim();
  }

  async function readMarkets(ids: string[]): Promise<Read> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = apiKey();
    if (key !== '') headers['x-cg-demo-api-key'] = key;
    let res: Response;
    try {
      res = await fetchImpl(marketsUrl(ids), { headers, signal: readTimeout() });
    } catch (err) {
      return { ok: false, error: `CoinGecko did not answer: ${oneLine(err instanceof Error ? err.message : err, 120)}`, waitMs: 0 };
    }
    if (res.status === 429) {
      return { ok: false, error: 'CoinGecko said too many requests (429)', waitMs: retryAfterMs(res.headers.get('retry-after')) };
    }
    if (!res.ok) return { ok: false, error: `CoinGecko answered ${res.status}`, waitMs: 0 };
    let payload: unknown;
    try {
      const text = await readCapped(res);
      if (text === null) return { ok: false, error: `CoinGecko answered over ${DAY_ANSWER_MAX_BYTES / (1024 * 1024)} MB`, waitMs: 0 };
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: 'CoinGecko answered something that is not JSON', waitMs: 0 };
    }
    if (!Array.isArray(payload)) return { ok: false, error: 'CoinGecko answered something that is not a list of coins', waitMs: 0 };
    const asked = new Set(ids);
    return { ok: true, rows: parseMarkets(payload, asked, now()), images: parseImages(payload, asked) };
  }

  // Twice the wait for every failure in a row, from ten minutes up to the ceiling, and never less
  // than the server asked for.
  function failed(reason: string, waitMs: number): void {
    failures += 1;
    const wait = Math.min(Math.max(DAY_REFRESH_MS * 2 ** failures, waitMs), DAY_BACKOFF_MAX_MS);
    retryAt = now() + wait;
    error = reason;
    log(`phosphor: the day feed did not refresh (${reason}), ${failures} in a row; next try in ${Math.round(wait / 60_000)} min`);
  }

  async function run(): Promise<void> {
    if (now() < retryAt) return;
    let list: OneClickToken[];
    try {
      list = await deps.tokens();
    } catch (err) {
      failed(`the 1Click token list did not answer: ${oneLine(err instanceof Error ? err.message : err, 120)}`, 0);
      return;
    }
    const listed = listedIds(Array.isArray(list) ? list : []);
    if (listed.ids.length === 0) {
      failed('the 1Click token list names no CoinGecko ids', 0);
      return;
    }
    // The newest mapping at once, so a coin listed since the last read finds its day as soon as
    // CoinGecko has one.
    idOf = listed.idOf;
    symbolIds = listed.symbols;
    for (const ids of callsFor(listed.ids)) {
      const read = await readMarkets(ids);
      if (!read.ok) {
        // The calls before this one landed and keep what they brought; this one's ids keep their
        // last good day. The rest wait with it rather than pressing a server that said no.
        failed(read.error, read.waitMs);
        return;
      }
      for (const [id, entry] of read.rows) byId.set(id, entry);
      for (const [id, image] of read.images) imageById.set(id, image);
    }
    failures = 0;
    retryAt = 0;
    error = undefined;
    lastGood = now();
  }

  function refresh(): Promise<void> {
    running ??= run()
      .catch((err: unknown) => failed(`the day feed broke: ${oneLine(err instanceof Error ? err.message : err, 120)}`, 0))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function entry(assetId: string): DayEntry | null {
    const id = idOf.get(assetId);
    if (id === undefined) return null;
    const day = byId.get(id);
    if (day === undefined || now() - day.at > DAY_STALE_MS) return null;
    return day;
  }

  function answer(assetIds?: readonly string[]): DayAnswer {
    const pairs: Array<[string, DayEntry]> = [];
    for (const assetId of assetIds ?? [...idOf.keys()]) {
      const day = entry(assetId);
      if (day !== null) pairs.push([assetId, day]);
    }
    // fromEntries defines each key as its own property, so an asset called __proto__ is a name.
    return { at: lastGood, entries: Object.fromEntries(pairs), ...(error === undefined ? {} : { error }) };
  }

  // Only coins still on the list: one 1Click stopped listing keeps no picture to fetch.
  function pictureUrls(): Map<string, string> {
    const listed = new Set(idOf.values());
    return new Map([...imageById].filter(([id]) => listed.has(id)));
  }

  return { refresh, entry, answer, pictureUrls, symbols: () => symbolIds };
}
