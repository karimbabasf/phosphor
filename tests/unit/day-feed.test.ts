// The day feed: every coin NEAR Intents lists, its last 24 hours, for Pro's line and change.
//
// Pro used to read a coin's day off Coinbase candles, and only for the seven markets config.json
// names, so a held VVV showed no line and no change (2026-09-25). The coins now come off 1Click's
// live token list and one CoinGecko markets call answers for all of them. What is held here: the
// call names every listed id and never only the held ones; each asset maps to its day through the
// CoinGecko id 1Click gives it; the answer is untrusted data; a failed read keeps the last good day
// with the time it was read and backs off; and a day nobody could refresh for an hour is not served.
//
// The markets rows are a real capture: tests/fixtures/coingecko-markets-2026-09-25.json, the
// keyless answer for seven ids on 2026-09-25. The token rows are real 1Click rows from that day.
//
// Run: node --test tests/unit/day-feed.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { AppConfig } from '../../src/types.ts';
import type { OneClickToken } from '../../src/intents.ts';
import type { Ctx } from '../../src/http/context.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { handle } from '../../src/http/router.ts';
import {
  callsFor,
  createDayFeed,
  DAY_POINTS,
  DAY_REFRESH_MS,
  DAY_STALE_MS,
  listedIds,
  parseMarkets,
  type DayAnswer,
} from '../../src/ledger/day.ts';

type Row = Record<string, any>;

const MARKETS = JSON.parse(
  fs.readFileSync(new URL('../fixtures/coingecko-markets-2026-09-25.json', import.meta.url), 'utf8'),
) as Row[];

function marketRow(id: string): Row {
  const row = MARKETS.find((r) => r.id === id);
  assert.ok(row, `no ${id} in the fixture`);
  return row;
}

const ETH_NEAR = 'nep141:eth.bridge.near';
const ETH = 'nep141:eth.omft.near';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const WBTC = 'nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near';
const ZEC = 'nep141:zec.omft.near';
const LTC = 'nep141:ltc.omft.near';
const VVV = 'nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near';
const NEAR_BSC = 'nep245:v2_1.omni.hot.tg:56_SZzgw3HSudhZcTwPWUTi2RJB19t';
const PIT = 'nep141:base-0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b.omdep.near';
const VAULT = 'nep141:sol-0xa69aa1bcb03a369e338156a8718ad60271145803.omdep.near';

// 1Click's own rows, as /v0/tokens answered them on 2026-09-25. SSC1_PIT carries a "custom:" id
// that is no CoinGecko id at all, and the yield-vault wrapper carries none.
const LIST: OneClickToken[] = [
  { assetId: ETH_NEAR, decimals: 18, blockchain: 'near', symbol: 'ETH', contractAddress: 'eth.bridge.near', coingeckoId: 'ethereum' },
  { assetId: ETH, decimals: 18, blockchain: 'eth', symbol: 'ETH', coingeckoId: 'ethereum' },
  { assetId: USDC_NEAR, decimals: 6, blockchain: 'near', symbol: 'USDC', coingeckoId: 'usd-coin' },
  { assetId: USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', coingeckoId: 'usd-coin' },
  { assetId: WBTC, decimals: 8, blockchain: 'near', symbol: 'wBTC', coingeckoId: 'bitcoin' },
  { assetId: ZEC, decimals: 8, blockchain: 'zec', symbol: 'ZEC', coingeckoId: 'zcash' },
  { assetId: PIT, decimals: 18, blockchain: 'base', symbol: 'SSC1_PIT', coingeckoId: 'custom:ssc1-pit' },
  { assetId: LTC, decimals: 8, blockchain: 'ltc', symbol: 'LTC', coingeckoId: 'litecoin' },
  { assetId: VVV, decimals: 18, blockchain: 'base', symbol: 'VVV', coingeckoId: 'venice-token' },
  { assetId: NEAR_BSC, decimals: 18, blockchain: 'bsc', symbol: 'NEAR', coingeckoId: 'near' },
  { assetId: VAULT, decimals: 9, blockchain: 'sol', symbol: 'kV-gtSOLb' },
];

const LISTED_IDS = ['bitcoin', 'ethereum', 'litecoin', 'near', 'usd-coin', 'venice-token', 'zcash'];

type Answer = 'ok' | '429' | '500' | 'throw' | 'not-a-list' | 'not-json' | 'endless' | 'padded-over' | 'padded-under';

type Rig = {
  feed: ReturnType<typeof createDayFeed>;
  clock: { now: number };
  calls: Array<{ url: string; headers: Record<string, string> }>;
  lines: string[];
  set(answer: Answer): void;
  // How many chunks of an endless answer were read.
  pulled(): number;
};

const TWO_MB = 2 * 1024 * 1024;

// The real answer, padded with the whitespace JSON allows to `bytes` long.
function padded(rows: Row[], bytes: number): string {
  const body = JSON.stringify(rows);
  return `${body}${' '.repeat(Math.max(0, bytes - Buffer.byteLength(body)))}`;
}

function rig(options: { env?: Record<string, string>; tokens?: () => Promise<OneClickToken[]>; rows?: Row[] } = {}): Rig {
  const clock = { now: Date.parse('2026-09-25T20:30:00Z') };
  const calls: Rig['calls'] = [];
  const lines: string[] = [];
  let answer: Answer = 'ok';
  let pulled = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    calls.push({ url, headers });
    if (!url.startsWith('https://api.coingecko.com/api/v3/coins/markets?')) throw new Error(`unexpected request ${url}`);
    if (answer === 'throw') throw new TypeError('fetch failed');
    if (answer === '429') return new Response('{"status":{"error_code":429}}', { status: 429, headers: { 'retry-after': '60' } });
    if (answer === '500') return new Response('upstream sad', { status: 500 });
    if (answer === 'not-a-list') return new Response('{"error":"nope"}', { status: 200 });
    if (answer === 'not-json') return new Response('<html>', { status: 200 });
    // A list that never closes, a chunk at a time, and no content-length to warn of it.
    if (answer === 'endless') {
      pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode(pulled === 1 ? '[' : ' '.repeat(64 * 1024)));
          if (pulled > 2000) controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    if (answer === 'padded-over') return new Response(padded(options.rows ?? MARKETS, TWO_MB + 1), { status: 200 });
    if (answer === 'padded-under') return new Response(padded(options.rows ?? MARKETS, TWO_MB), { status: 200 });
    return new Response(JSON.stringify(options.rows ?? MARKETS), { status: 200 });
  }) as typeof fetch;
  const feed = createDayFeed({
    tokens: options.tokens ?? (async () => LIST),
    fetchImpl,
    now: () => clock.now,
    env: options.env ?? {},
    log: (line) => lines.push(line),
  });
  return { feed, clock, calls, lines, set: (next) => { answer = next; }, pulled: () => pulled };
}

function idsAsked(url: string): string[] {
  const ids = new URL(url).searchParams.get('ids');
  assert.ok(ids !== null, `no ids in ${url}`);
  return ids.split(',');
}

/* ---------- the mapping ---------- */

// A day's change as the feed serves it: the line's own, first point to last, in percent.
function lineChange(line: number[]): number {
  return ((line[line.length - 1] - line[0]) / line[0]) * 100;
}

// The day the fixture's row for a CoinGecko id is served as: its last 25 points and their change.
function dayIn(id: string): { change24: number; line: number[] } {
  const line = marketRow(id).sparkline_in_7d.price.slice(-25) as number[];
  return { change24: lineChange(line), line };
}

test('the markets answer becomes every listed asset\'s day: the last 25 hourly points and their change', async () => {
  const r = rig();
  await r.feed.refresh();
  assert.equal(DAY_POINTS, 25, 'a day is the price now and the 24 hours before it');
  const want = { ...dayIn('ethereum'), at: r.clock.now };
  assert.deepEqual(r.feed.entry(ETH), want);
  // Every asset 1Click lists under the same id is the same coin with the same day.
  assert.deepEqual(r.feed.entry(ETH_NEAR), want, 'the NEAR-bridged ETH did not map through its CoinGecko id');
  assert.equal(r.feed.entry(USDC)?.change24, dayIn('usd-coin').change24);
  assert.equal(r.feed.entry(USDC_NEAR)?.change24, dayIn('usd-coin').change24);
  assert.equal(r.feed.entry(WBTC)?.change24, dayIn('bitcoin').change24, 'a wrapped coin is the coin 1Click says it is');
  assert.equal(r.feed.entry(USDC)?.line.length, 25);
  // No CoinGecko id, or one that is not a CoinGecko id, is no day: never a borrowed one.
  assert.equal(r.feed.entry(VAULT), null);
  assert.equal(r.feed.entry(PIT), null);
  assert.equal(r.feed.entry('nep141:not-listed.near'), null);
});

test('VVV, which no candle product names, gets its line and its change, and so do LTC and ZEC', async () => {
  const r = rig();
  await r.feed.refresh();
  const vvv = r.feed.entry(VVV);
  assert.ok(vvv, 'VVV has no day');
  assert.equal(vvv.change24, dayIn('venice-token').change24);
  assert.equal(vvv.line.length, 25);
  assert.ok(vvv.line.every((p) => Number.isFinite(p) && p > 0), 'a point on the line is not a price');
  assert.deepEqual(vvv.line, marketRow('venice-token').sparkline_in_7d.price.slice(-25));
  assert.equal(r.feed.entry(LTC)?.change24, dayIn('litecoin').change24);
  assert.equal(r.feed.entry(ZEC)?.change24, dayIn('zcash').change24);
});

/* CoinGecko's 24h figure is live and its sparkline's last point trails it by up to an hour, so the
   two can point opposite ways, and Pro colours the line by the change: a line drawn falling in green.
   In the capture of 2026-09-25 ZEC's figure says +0.59% over a line that fell 0.25%, and VVV's says
   -4.58% over a line that fell 2.80%. The change served is the line's, as the candle path draws it. */
test('the change served is the line\'s own, first point to last, never CoinGecko\'s live figure beside a line that trails it', async () => {
  const r = rig();
  await r.feed.refresh();
  const zec = r.feed.entry(ZEC);
  assert.ok(zec);
  assert.equal(marketRow('zcash').price_change_percentage_24h > 0, true, 'the capture changed: CoinGecko\'s figure for ZEC rose');
  assert.ok(zec.change24 < 0, `ZEC's line falls and its change is ${zec.change24}`);
  assert.equal(Math.sign(zec.change24), Math.sign(zec.line[zec.line.length - 1] - zec.line[0]));
  assert.equal(r.feed.entry(VVV)?.change24.toFixed(5), '-2.80092');
});

/* ---------- the request ---------- */

test('one call asks for every id the list names, whatever is held, and never a malformed one', async () => {
  const r = rig();
  await r.feed.refresh();
  assert.equal(r.calls.length, 1, 'one markets call covers the whole list');
  assert.deepEqual(idsAsked(r.calls[0].url), LISTED_IDS, 'the call did not name every listed coin');
  assert.ok(!r.calls[0].url.includes('custom'), 'an id that is not a CoinGecko id was sent');
  const url = new URL(r.calls[0].url);
  assert.equal(url.searchParams.get('vs_currency'), 'usd');
  assert.equal(url.searchParams.get('sparkline'), 'true');
  assert.equal(url.searchParams.get('price_change_percentage'), '24h');
  assert.equal(url.searchParams.get('per_page'), '250');
  // The feed is never told what is held, so what is held cannot change what it asks: reading the
  // day for one coin and then for another asks the same thing again.
  r.feed.answer([VVV]);
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  r.feed.answer([LTC]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].url, r.calls[0].url);
});

test('listedIds: each CoinGecko id once and sorted, each asset to its id, and a malformed id nowhere', () => {
  const { ids, idOf } = listedIds([
    ...LIST,
    { assetId: 'nep141:up.near', decimals: 1, blockchain: 'near', symbol: 'UP', coingeckoId: 'Upper-Case' },
    { assetId: 'nep141:inject.near', decimals: 1, blockchain: 'near', symbol: 'X', coingeckoId: 'bitcoin&ids=near' },
    { assetId: 'nep141:num.near', decimals: 1, blockchain: 'near', symbol: 'Y', coingeckoId: 7 as unknown as string },
    { assetId: 'nep141:empty.near', decimals: 1, blockchain: 'near', symbol: 'Z', coingeckoId: '' },
  ]);
  assert.deepEqual(ids, LISTED_IDS);
  assert.equal(idOf.get(ETH), 'ethereum');
  assert.equal(idOf.get(ETH_NEAR), 'ethereum');
  assert.equal(idOf.get(VVV), 'venice-token');
  for (const asset of [PIT, VAULT, 'nep141:up.near', 'nep141:inject.near', 'nep141:num.near', 'nep141:empty.near']) {
    assert.equal(idOf.has(asset), false, `${asset} was mapped`);
  }
});

test('past 250 ids, or past a URL the server would refuse, the ids go in more than one call; under that, in one', () => {
  const today = Array.from({ length: 98 }, (_, i) => `coin-${i}`);
  assert.deepEqual(callsFor(today), [today]);
  const many = Array.from({ length: 600 }, (_, i) => `c${i}`);
  const split = callsFor(many);
  assert.equal(split.length, 3);
  assert.ok(split.every((c) => c.length <= 250), 'a call over the endpoint\'s 250');
  assert.deepEqual(split.flat(), many, 'an id was lost or asked twice');
  const long = Array.from({ length: 200 }, (_, i) => `a-very-long-coingecko-identifier-that-goes-on-and-on-${String(i).padStart(4, '0')}`);
  const byLength = callsFor(long);
  assert.ok(byLength.length > 1, 'twelve kilobytes of ids went in one URL');
  assert.ok(byLength.every((c) => c.join(',').length <= 4000), 'a call longer than the ceiling');
  assert.deepEqual(byLength.flat(), long);
  assert.deepEqual(callsFor([]), []);
});

test('a key in COINGECKO_API_KEY rides in the demo header, and with none the call is keyless', async () => {
  const keyed = rig({ env: { COINGECKO_API_KEY: 'CG-test-key-123' } });
  await keyed.feed.refresh();
  assert.equal(keyed.calls[0].headers['x-cg-demo-api-key'], 'CG-test-key-123');
  assert.ok(!keyed.calls[0].url.includes('CG-test-key-123'), 'the key went in the URL');
  const keyless = rig();
  await keyless.feed.refresh();
  assert.equal('x-cg-demo-api-key' in keyless.calls[0].headers, false);
  assert.ok(keyless.feed.entry(VVV), 'keyless did not work');
  // A failure says why without the key in the sentence.
  keyed.set('500');
  keyed.clock.now += DAY_REFRESH_MS;
  await keyed.feed.refresh();
  assert.ok(keyed.lines.length > 0);
  assert.ok(keyed.lines.every((l) => !l.includes('CG-test-key-123')), 'the key was logged');
});

/* ---------- untrusted ---------- */

test('rows that do not hold up are dropped, never repaired', () => {
  const good = marketRow('venice-token');
  const spark = good.sparkline_in_7d.price as number[];
  const asked = new Set(['venice-token', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm']);
  const at = 1_790_000_000_000;
  const rows: unknown[] = [
    good,
    { ...good, id: 'not-asked' },
    { ...good, id: 'a', price_change_percentage_24h: '5' },
    { ...good, id: 'b', price_change_percentage_24h: null },
    { ...good, id: 'c', price_change_percentage_24h: -100 },
    { ...good, id: 'd', price_change_percentage_24h: 10_001 },
    { ...good, id: 'e', sparkline_in_7d: { price: [...spark.slice(0, -1), 0] } },
    { ...good, id: 'f', sparkline_in_7d: { price: [...spark.slice(0, -2), '30.1', 30.2] } },
    { ...good, id: 'g', sparkline_in_7d: { price: [30.1] } },
    { ...good, id: 'h', sparkline_in_7d: null },
    { ...good, id: 'i', sparkline_in_7d: { price: [...spark.slice(0, -1), -1] } },
    null,
    ['venice-token', -4],
    { ...good, id: 'j', sparkline_in_7d: { price: [...spark.slice(0, -1), 1e400] } },
    { id: 'k', price_change_percentage_24h: 2 },
    // A shorter day is still a day: a coin listed six hours ago has six hours of line, and its change is that line's.
    { ...good, id: 'l', price_change_percentage_24h: 12.5, sparkline_in_7d: { price: [1.5, 1.6, 1.7] } },
    // A line that goes up twenty-thousandfold in a day is a broken row, whatever the figure beside it says.
    { ...good, id: 'm', sparkline_in_7d: { price: [0.0001, 2] } },
    // The same id twice: the first answer stands.
    { ...good, price_change_percentage_24h: 99 },
  ];
  const parsed = parseMarkets(rows, asked, at);
  assert.deepEqual([...parsed.keys()].sort(), ['l', 'venice-token']);
  assert.deepEqual(parsed.get('venice-token'), { change24: lineChange(spark.slice(-25)), line: spark.slice(-25), at });
  assert.deepEqual(parsed.get('l'), { change24: lineChange([1.5, 1.6, 1.7]), line: [1.5, 1.6, 1.7], at });
  for (const junk of [null, 'rows', { rows: [good] }, 42]) assert.equal(parseMarkets(junk, asked, at).size, 0);
});

/* ---------- failure ---------- */

test('a refresh that fails keeps the last good day with the time it was read, and waits longer each time', async () => {
  const r = rig();
  await r.feed.refresh();
  const readAt = r.clock.now;
  const before = r.feed.entry(VVV);
  assert.ok(before);

  r.set('429');
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.feed.entry(VVV), before, 'a 429 blanked or changed a good day');
  assert.equal(r.feed.entry(VVV)?.at, readAt, 'the kept day was restamped as if it were read now');
  const answer: DayAnswer = r.feed.answer([VVV]);
  assert.equal(answer.at, readAt, 'the answer does not say when the day was read');
  assert.match(answer.error ?? '', /429/);
  assert.match(r.lines.at(-1) ?? '', /429/);

  // Five minutes on, still inside the wait: the tick asks nothing.
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  assert.equal(r.calls.length, 2, 'the feed pressed a server that had just said too many requests');
  // Ten minutes after the failure it tries again; a second failure waits twenty.
  r.set('500');
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  assert.equal(r.calls.length, 3);
  r.set('ok');
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  assert.equal(r.calls.length, 3, 'the wait did not grow after a second failure');
  r.clock.now += DAY_REFRESH_MS;
  await r.feed.refresh();
  assert.equal(r.calls.length, 4);
  assert.equal(r.feed.entry(VVV)?.at, r.clock.now, 'a good read did not restamp the day');
  assert.equal(r.feed.answer().error, undefined, 'a good read left the old failure standing');
});

test('a fetch that throws, an answer that is not a list and one that is not JSON are failed reads too, never an empty day', async () => {
  for (const bad of ['throw', 'not-a-list', 'not-json'] as const) {
    const r = rig();
    await r.feed.refresh();
    const kept = r.feed.entry(ETH);
    r.set(bad);
    r.clock.now += DAY_REFRESH_MS;
    await r.feed.refresh();
    assert.deepEqual(r.feed.entry(ETH), kept, `${bad} blanked the day`);
    assert.ok(r.feed.answer().error, `${bad} was not a failure`);
  }
});

/* Security review F4: the answer was read whole with res.json(), bounded only by the ten-second
   deadline, and hundreds of megabytes fit inside ten seconds. Today's answer is about half a
   megabyte, so 2 MB is four times it. */
test('an answer past 2 MB is a failed refresh that keeps the last good day, and the rest of it is never read', async () => {
  for (const bad of ['endless', 'padded-over'] as const) {
    const r = rig();
    await r.feed.refresh();
    const kept = r.feed.entry(VVV);
    assert.ok(kept);
    r.set(bad);
    r.clock.now += DAY_REFRESH_MS;
    await r.feed.refresh();
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.feed.entry(VVV), kept, `${bad} blanked or changed the day`);
    assert.match(r.feed.answer().error ?? '', /over 2 MB/, `${bad} was not a failure`);
    if (bad === 'endless') assert.ok(r.pulled() < 40, `the read took ${r.pulled()} chunks of 64 KB`);
  }
  // Two megabytes exactly is an answer like any other.
  const r = rig();
  r.set('padded-under');
  await r.feed.refresh();
  assert.equal(r.feed.answer().error, undefined);
  assert.equal(r.feed.entry(VVV)?.change24, -4.58151);
});

test('with no token list the feed asks CoinGecko nothing, says why and waits', async () => {
  const r = rig({ tokens: async () => { throw new Error('1click token list fetch failed: 503'); } });
  await r.feed.refresh();
  assert.equal(r.calls.length, 0, 'the markets call went out with no list to name its coins');
  assert.match(r.feed.answer().error ?? '', /token list/);
  assert.deepEqual(r.feed.answer(), { at: null, entries: {}, error: r.feed.answer().error });
});

test('one refresh at a time: a tick that lands while one is running joins it', async () => {
  const r = rig();
  await Promise.all([r.feed.refresh(), r.feed.refresh(), r.feed.refresh()]);
  assert.equal(r.calls.length, 1);
});

test('a day nobody could refresh for an hour is not served, so Pro goes back to the candles', async () => {
  const r = rig();
  await r.feed.refresh();
  r.set('throw');
  r.clock.now += DAY_STALE_MS;
  assert.ok(r.feed.entry(VVV), 'a day exactly an hour old is still the last good one');
  r.clock.now += 1;
  assert.equal(r.feed.entry(VVV), null);
  assert.deepEqual(r.feed.answer([VVV]).entries, {});
});

/* ---------- what the window reads ---------- */

test('the answer carries the assets asked for and nothing else, and a hostile name is only a name', async () => {
  const r = rig();
  await r.feed.refresh();
  const some = r.feed.answer([LTC, 'nep141:nobody.near', VAULT]);
  assert.deepEqual(Object.keys(some.entries), [LTC]);
  assert.equal(some.at, r.clock.now);
  const all = r.feed.answer();
  assert.deepEqual(Object.keys(all.entries).sort(), [ETH, ETH_NEAR, LTC, NEAR_BSC, USDC, USDC_NEAR, VVV, WBTC, ZEC].sort());
  const hostile = r.feed.answer(['__proto__', 'constructor', 'toString']);
  assert.deepEqual(Object.keys(hostile.entries), []);
  assert.equal(Object.getPrototypeOf(hostile.entries), Object.prototype);
});

async function getDay(ctx: Partial<Ctx>, query: string): Promise<{ status: number; body: DayAnswer }> {
  const server = http.createServer((req, res) => void handle(ctx as Ctx, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/day${query}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as DayAnswer }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /api/day answers the assets the window names, every listed one with none named, and nothing in demo', async () => {
  const r = rig();
  await r.feed.refresh();
  const ctx = { day: r.feed, audit: { append: () => {} } } as unknown as Partial<Ctx>;
  const named = await getDay(ctx, `?assets=${encodeURIComponent([VVV, LTC].join(','))}`);
  assert.equal(named.status, 200);
  assert.deepEqual(Object.keys(named.body.entries).sort(), [LTC, VVV].sort());
  assert.equal(named.body.entries[VVV].change24, dayIn('venice-token').change24);
  assert.equal(named.body.at, r.clock.now);
  const every = await getDay(ctx, '');
  assert.equal(Object.keys(every.body.entries).length, 9);
  // Demo mode builds no feed: an answer with no days, and Pro draws its candles as before.
  const demo = await getDay({ audit: { append: () => {} } } as unknown as Partial<Ctx>, `?assets=${encodeURIComponent(VVV)}`);
  assert.equal(demo.status, 200);
  assert.deepEqual(demo.body, { at: null, entries: {} });
});

/* ---------- the list it names its coins from ---------- */

test('the feed reads the token list the ledger already keeps: one fetch, not a second fetcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-day-'));
  const cfg: AppConfig = { mode: 'live', keysPath: path.join(dir, 'keys.json'), port: 4177, addresses: {}, candleProducts: [], dataDir: dir };
  let listReads = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://1click.chaindefuser.com/v0/tokens') {
      listReads += 1;
      return new Response(JSON.stringify(LIST), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const ledger = createLedger(cfg, { fetchImpl, log: () => {} });
  assert.ok(ledger.tokens, 'the live ledger does not hand out its token list');
  const first = await ledger.tokens();
  const second = await ledger.tokens();
  assert.equal(listReads, 1, 'the list was fetched twice inside its minute');
  assert.equal(second, first);
  assert.equal(first.find((t) => t.assetId === VVV)?.coingeckoId, 'venice-token');
  // Demo mode reads no venue, and so has no list to hand out.
  assert.equal(createLedger({ ...cfg, mode: 'demo' }).tokens, undefined);
});
