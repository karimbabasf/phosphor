// The coin pictures: every listed coin's picture, fetched once into a cache on disk and served by
// the local server, so the window never loads a third-party URL.
//
// ui/design/marks.js drew a real logo only for the 75 tickers with a hand-picked file in ui/logos,
// so a held VVV was a "V" on a disc (2026-09-25). CoinGecko's markets answer, the one the day feed
// already makes for every listed coin, names each coin's picture. What is held here: the pictures
// asked for are every listed coin's, never only the held ones; the bytes are untrusted (https from
// CoinGecko's image host only, no redirects, 256 KB at most as they arrive, PNG, JPEG or WebP by
// their first bytes and never SVG); the cache sits away from the keys; a picture is served from
// disk after a restart and fetched again only after a week; and the routes answer only what is on
// disk.
//
// Run: node --test tests/unit/coin-pictures.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { OneClickToken } from '../../src/intents.ts';
import type { Ctx } from '../../src/http/context.ts';
import { handle } from '../../src/http/router.ts';
import { createDayFeed, listedIds, parseImages, pictureUrl } from '../../src/ledger/day.ts';
import {
  createCoinPictures,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_IDS,
  PICTURE_MAX_TOTAL_BYTES,
  PICTURE_REFRESH_MS,
  PICTURE_RETRY_MS,
  pictureDir,
  pictureType,
  type CoinPictures,
} from '../../src/ledger/pictures.ts';

type Row = Record<string, any>;

const MARKETS = JSON.parse(
  fs.readFileSync(new URL('../fixtures/coingecko-markets-2026-09-25.json', import.meta.url), 'utf8'),
) as Row[];

const VVV = 'nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near';

// Real 1Click rows from 2026-09-25, and two made-up ones: a second WBTC under another id, which
// makes that symbol ambiguous, and a coin CoinGecko has no row for.
const LIST: OneClickToken[] = [
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', coingeckoId: 'ethereum' },
  { assetId: 'nep141:eth.bridge.near', decimals: 18, blockchain: 'near', symbol: 'ETH', coingeckoId: 'ethereum' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', decimals: 8, blockchain: 'near', symbol: 'wBTC', coingeckoId: 'bitcoin' },
  { assetId: 'nep141:wbtc.other.near', decimals: 8, blockchain: 'near', symbol: 'WBTC', coingeckoId: 'wrapped-bitcoin' },
  { assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC', coingeckoId: 'zcash' },
  { assetId: 'nep141:ltc.omft.near', decimals: 8, blockchain: 'ltc', symbol: 'LTC', coingeckoId: 'litecoin' },
  { assetId: VVV, decimals: 18, blockchain: 'base', symbol: 'VVV', coingeckoId: 'venice-token' },
  { assetId: 'nep245:v2_1.omni.hot.tg:56_SZzgw3HSudhZcTwPWUTi2RJB19t', decimals: 18, blockchain: 'bsc', symbol: 'NEAR', coingeckoId: 'near' },
  { assetId: 'nep141:gone.near', decimals: 18, blockchain: 'near', symbol: 'GONE', coingeckoId: 'not-on-coingecko' },
];

// What the image host serves: the first bytes are what decide.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(200, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/state")</script></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 2)]);
const HUGE_PNG = Buffer.concat([PNG, Buffer.alloc(PICTURE_MAX_BYTES, 9)]);

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type Served = { status?: number; body?: Buffer | ReadableStream<Uint8Array> | null; headers?: Record<string, string> };

type Rig = {
  pictures: CoinPictures;
  dir: string;
  clock: { now: number };
  asked: Array<{ url: string; init?: RequestInit }>;
  serve: Map<string, Served>;
  lines: string[];
  urls: Map<string, string>;
  symbols: Map<string, string>;
  fresh(): CoinPictures;
};

const url = (id: string) => `https://coin-images.coingecko.com/coins/images/1/large/${id}.png?1696501400`;

function rig(options: { dir?: string; ids?: string[]; maxIds?: number; maxBytes?: number } = {}): Rig {
  const dir = options.dir ?? path.join(tempDir('phosphor-pictures-'), 'cache', 'coin-images');
  const clock = { now: Date.parse('2026-09-25T20:30:00Z') };
  const asked: Rig['asked'] = [];
  const serve = new Map<string, Served>();
  const lines: string[] = [];
  const ids = options.ids ?? ['venice-token', 'zcash'];
  const urls = new Map(ids.map((id) => [id, url(id)]));
  const symbols = new Map([['VVV', 'venice-token'], ['ZEC', 'zcash']]);
  for (const id of ids) serve.set(url(id), { body: PNG });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const at = String(input);
    asked.push({ url: at, init });
    const answer = serve.get(at);
    if (answer === undefined) return new Response('not found', { status: 404 });
    return new Response(answer.body ?? null, { status: answer.status ?? 200, headers: answer.headers ?? { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const make = () =>
    createCoinPictures({ dir, urls: () => urls, symbols: () => symbols, fetchImpl, now: () => clock.now, log: (line) => lines.push(line), maxIds: options.maxIds, maxBytes: options.maxBytes });
  return { pictures: make(), dir, clock, asked, serve, lines, urls, symbols, fresh: make };
}

/* ---------- the gates ---------- */

test('pictureType knows PNG, JPEG and WebP by their first bytes, and nothing else', () => {
  assert.equal(pictureType(PNG), 'image/png');
  assert.equal(pictureType(JPEG), 'image/jpeg');
  assert.equal(pictureType(WEBP), 'image/webp');
  assert.equal(pictureType(SVG), null, 'an SVG passed for a picture');
  assert.equal(pictureType(GIF), null);
  assert.equal(pictureType(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null, 'a RIFF that is not WebP');
  assert.equal(pictureType(Buffer.alloc(0)), null);
  assert.equal(pictureType(PNG.subarray(0, 4)), null, 'half a PNG signature');
});

test('an SVG is refused whatever the server calls it, and so is a GIF', async () => {
  const r = rig({ ids: ['venice-token', 'zcash'] });
  r.serve.set(url('venice-token'), { body: SVG, headers: { 'content-type': 'image/png' } });
  r.serve.set(url('zcash'), { body: GIF, headers: { 'content-type': 'image/png' } });
  await r.pictures.sync();
  assert.equal(r.pictures.read('venice-token'), null, 'an SVG was kept');
  assert.equal(r.pictures.read('zcash'), null, 'a GIF was kept');
  assert.deepEqual(fs.existsSync(r.dir) ? fs.readdirSync(r.dir) : [], [], 'refused bytes reached the disk');
  assert.match(r.lines.join('\n'), /not a PNG, JPEG or WebP/);
});

test('a file past 256 KB is refused, whether the server says so first or the bytes run over', async () => {
  const r = rig({ ids: ['venice-token', 'zcash', 'litecoin'] });
  // Said up front: refused on the header, before the body is read.
  r.serve.set(url('venice-token'), { body: HUGE_PNG, headers: { 'content-type': 'image/png', 'content-length': String(HUGE_PNG.length) } });
  // Said nothing: counted as it arrives, and the read stops soon after the cap rather than taking it all.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(pulled === 1 ? new Uint8Array(PNG) : new Uint8Array(64 * 1024));
      if (pulled > 200) controller.close();
    },
  });
  r.serve.set(url('zcash'), { body: endless });
  // A small header over a big body: the count is what decides, never the header.
  r.serve.set(url('litecoin'), { body: HUGE_PNG, headers: { 'content-type': 'image/png', 'content-length': '300' } });
  await r.pictures.sync();
  assert.equal(r.pictures.read('venice-token'), null);
  assert.equal(r.pictures.read('zcash'), null);
  assert.equal(r.pictures.read('litecoin'), null, 'a lying content-length let an oversize file through');
  assert.ok(pulled < 10, `the read took ${pulled} chunks of an endless body`);
  assert.equal(PICTURE_MAX_BYTES, 256 * 1024);
});

test('a redirect is refused and never followed, and only https from CoinGecko\'s image host is asked', async () => {
  const r = rig({ ids: ['venice-token'] });
  r.serve.set(url('venice-token'), { status: 302, body: null, headers: { location: 'https://evil.example/vvv.png' } });
  r.urls.set('zcash', 'http://coin-images.coingecko.com/coins/images/1/large/zcash.png');
  r.urls.set('litecoin', 'https://evil.example/litecoin.png');
  r.urls.set('near', 'https://coin-images.coingecko.com.evil.example/near.png');
  await r.pictures.sync();
  assert.equal(r.pictures.read('venice-token'), null, 'a redirect was followed to a picture');
  assert.deepEqual(r.asked.map((a) => a.url), [url('venice-token')], 'a URL off the image host was asked');
  assert.equal(r.asked[0].init?.redirect, 'manual', 'fetch was left to follow redirects on its own');
  assert.ok(r.asked[0].init?.signal instanceof AbortSignal, 'the picture was fetched with no deadline');
  // The same rule the day feed applies when it reads the markets answer.
  assert.equal(pictureUrl('https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400'), 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400');
  for (const bad of ['http://coin-images.coingecko.com/x.png', 'https://evil.example/x.png', 'https://user:pw@coin-images.coingecko.com/x.png', 'https://coin-images.coingecko.com:8443/x.png', 'data:image/png;base64,AAAA', 7, null, `https://coin-images.coingecko.com/${'a'.repeat(600)}.png`]) {
    assert.equal(pictureUrl(bad), null, `${String(bad).slice(0, 60)} passed`);
  }
});

test('PNG, JPEG and WebP are kept by their bytes, and a server that calls them something else changes nothing', async () => {
  const r = rig({ ids: ['venice-token', 'zcash', 'litecoin'] });
  r.serve.set(url('venice-token'), { body: PNG, headers: { 'content-type': 'text/html' } });
  r.serve.set(url('zcash'), { body: JPEG, headers: { 'content-type': 'image/svg+xml' } });
  r.serve.set(url('litecoin'), { body: WEBP });
  await r.pictures.sync();
  assert.equal(r.pictures.read('venice-token')?.type, 'image/png');
  assert.equal(r.pictures.read('zcash')?.type, 'image/jpeg');
  assert.equal(r.pictures.read('litecoin')?.type, 'image/webp');
  assert.deepEqual(r.pictures.read('zcash')?.bytes, JPEG);
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['litecoin.webp', 'venice-token.png', 'zcash.jpg']);
});

/* ---------- every listed coin ---------- */

test('the download asks for every listed coin\'s picture, never only the held ones', async () => {
  // The real feed over the real markets rows: the pictures it names are the list's, and nothing
  // about a wallet reaches either module.
  const dayFetch = (async () => new Response(JSON.stringify(MARKETS), { status: 200 })) as typeof fetch;
  const feed = createDayFeed({ tokens: async () => LIST, fetchImpl: dayFetch, env: {}, log: () => {} });
  await feed.refresh();
  const listedWithPicture = MARKETS.map((row) => row.id as string).filter((id) => LIST.some((t) => t.coingeckoId === id)).sort();
  assert.deepEqual([...feed.pictureUrls().keys()].sort(), listedWithPicture);
  for (const [id, at] of feed.pictureUrls()) assert.equal(at, MARKETS.find((row) => row.id === id)?.image);

  const dir = path.join(tempDir('phosphor-pictures-'), 'cache', 'coin-images');
  const asked: string[] = [];
  const imageFetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(PNG, { status: 200 });
  }) as typeof fetch;
  const pictures = createCoinPictures({ dir, urls: () => feed.pictureUrls(), symbols: () => feed.symbols(), fetchImpl: imageFetch, log: () => {} });
  await pictures.sync();
  assert.deepEqual(asked.sort(), listedWithPicture.map((id) => MARKETS.find((row) => row.id === id)?.image).sort());
  assert.equal(asked.length, 7, 'one picture per listed coin CoinGecko answered for');
  // Each symbol the list names once finds its picture; WBTC names two coins and finds none.
  const manifest = pictures.manifest();
  assert.equal(manifest.symbols.VVV, 'venice-token');
  assert.equal(manifest.symbols.ZEC, 'zcash');
  assert.equal(manifest.symbols.ETH, 'ethereum');
  assert.equal('WBTC' in manifest.symbols, false, 'an ambiguous symbol was given one coin\'s picture');
  assert.equal('GONE' in manifest.symbols, false);
  assert.equal(manifest.settled, true);
  // Nothing new to fetch: the next tick asks nothing.
  await pictures.sync();
  assert.equal(asked.length, 7);
});

test('listedIds names each symbol the list gives exactly one CoinGecko id, and parseImages keeps only good URLs for asked ids', () => {
  const { symbols } = listedIds([
    ...LIST,
    // One row with an id and one without: the second could be any coin, so neither gets a picture.
    { assetId: 'nep141:half.near', decimals: 6, blockchain: 'near', symbol: 'HALF', coingeckoId: 'half-coin' },
    { assetId: 'nep141:half-vault.near', decimals: 6, blockchain: 'sol', symbol: 'half' },
    { assetId: 'nep141:bare.near', decimals: 6, blockchain: 'sol', symbol: 'BARE' },
  ]);
  assert.equal(symbols.get('VVV'), 'venice-token');
  assert.equal(symbols.get('ETH'), 'ethereum');
  assert.equal(symbols.has('WBTC'), false, 'wBTC and WBTC name two coins');
  assert.equal(symbols.has('HALF'), false, 'a symbol one row lists with no id was given the other row\'s picture');
  assert.equal(symbols.has('BARE'), false);
  const asked = new Set(['venice-token', 'zcash', 'bitcoin']);
  const images = parseImages(
    [
      { id: 'venice-token', image: MARKETS.find((row) => row.id === 'venice-token')?.image },
      { id: 'zcash', image: 'https://evil.example/zec.png' },
      { id: 'bitcoin', image: 42 },
      { id: 'ethereum', image: url('ethereum') },
      null,
    ],
    asked,
  );
  assert.deepEqual([...images.keys()], ['venice-token']);
  assert.equal(parseImages('nope', asked).size, 0);
});

/* Pictures review finding 1: the one-id rule ran one way. A symbol naming two ids got nothing, but
   several symbols naming one id all drew that id's picture, so an approval card for USDC to USAD
   drew two USDC marks. The live list of 2026-09-25 has six such rows, all here. */
const SHARED: OneClickToken[] = [
  { assetId: 'nep141:usdc.eth', decimals: 6, blockchain: 'eth', symbol: 'USDC', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:susdc.base', decimals: 6, blockchain: 'base', symbol: 'SUSDC', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:susdc.sol', decimals: 6, blockchain: 'sol', symbol: 'sUSDC', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:usad.aleo', decimals: 6, blockchain: 'aleo', symbol: 'USAD', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:usdt.eth', decimals: 6, blockchain: 'eth', symbol: 'USDT', coingeckoId: 'tether' },
  { assetId: 'nep141:nrusdt.near', decimals: 6, blockchain: 'near', symbol: 'NRUSDT', coingeckoId: 'tether' },
  { assetId: 'nep141:nrusdt.bsc', decimals: 6, blockchain: 'bsc', symbol: 'NRUSDT', coingeckoId: 'tether' },
  { assetId: 'nep141:xpl.plasma', decimals: 18, blockchain: 'plasma', symbol: 'XPL', coingeckoId: 'plasma' },
  { assetId: 'nep141:xpl-old.plasma', decimals: 18, blockchain: 'plasma', symbol: 'XPL_(DEPRECATED)', coingeckoId: 'plasma' },
  { assetId: 'nep141:usdt0.plasma', decimals: 6, blockchain: 'plasma', symbol: 'USDT0', coingeckoId: 'usdt0' },
  { assetId: 'nep141:usdt0-old.plasma', decimals: 6, blockchain: 'plasma', symbol: 'USDT0(DEPRECATED)', coingeckoId: 'usdt0' },
  { assetId: 'nep141:nearkat.near', decimals: 18, blockchain: 'near', symbol: 'NEARKAT', coingeckoId: 'nearkat-2' },
  { assetId: 'nep141:wnearkat.near', decimals: 18, blockchain: 'near', symbol: 'WNEARKAT', coingeckoId: 'nearkat-2' },
  { assetId: VVV, decimals: 18, blockchain: 'base', symbol: 'VVV', coingeckoId: 'venice-token' },
];

test('a CoinGecko id two symbols share is a picture for neither: SUSDC and USAD never wear USDC\'s mark', async () => {
  const { symbols, idOf } = listedIds(SHARED);
  for (const symbol of ['USDC', 'SUSDC', 'USAD', 'USDT', 'NRUSDT', 'XPL', 'XPL_(DEPRECATED)', 'USDT0', 'USDT0(DEPRECATED)', 'NEARKAT', 'WNEARKAT']) {
    assert.equal(symbols.has(symbol), false, `${symbol} was given ${symbols.get(symbol)}'s picture, which another symbol names too`);
  }
  assert.equal(symbols.get('VVV'), 'venice-token', 'a symbol that is the only one naming its id lost its picture');
  // The day is the asset's own id whatever the pictures do: the market 1Click itself prices it off.
  assert.equal(idOf.get('nep141:usad.aleo'), 'usd-coin');
  assert.equal(idOf.get('nep141:wnearkat.near'), 'nearkat-2');

  // Through the feed and the cache, as the window reads them: USAD has no picture to draw, so the
  // card for USDC to USAD draws USDC's file beside a monogram, never two USDC marks.
  const dayFetch = (async () => new Response(JSON.stringify(MARKETS), { status: 200 })) as typeof fetch;
  const feed = createDayFeed({ tokens: async () => SHARED, fetchImpl: dayFetch, env: {}, log: () => {} });
  await feed.refresh();
  const dir = path.join(tempDir('phosphor-pictures-'), 'cache', 'coin-images');
  const pictures = createCoinPictures({ dir, urls: () => feed.pictureUrls(), symbols: () => feed.symbols(), fetchImpl: (async () => new Response(PNG, { status: 200 })) as typeof fetch, log: () => {} });
  await pictures.sync();
  const manifest = pictures.manifest();
  assert.equal(manifest.symbols.VVV, 'venice-token');
  for (const symbol of ['USAD', 'SUSDC', 'USDC', 'NRUSDT', 'XPL_(DEPRECATED)']) assert.equal(symbol in manifest.symbols, false, `${symbol} is in the manifest`);
  assert.equal(feed.entry('nep141:usad.aleo')?.change24, MARKETS.find((row) => row.id === 'usd-coin')?.price_change_percentage_24h, 'USAD lost the day 1Click prices it off');
});

/* ---------- on disk ---------- */

test('a picture on disk is served after a restart, fetched again after a week, and a refused one waits a day', async () => {
  const r = rig({ ids: ['venice-token', 'zcash'] });
  r.serve.set(url('zcash'), { body: SVG });
  await r.pictures.sync();
  assert.equal(r.asked.length, 2);
  // A new process over the same folder has the picture before it asks anything.
  const again = r.fresh();
  assert.deepEqual(again.read('venice-token')?.bytes, PNG);
  assert.equal(again.manifest().symbols.VVV, 'venice-token');
  await r.pictures.sync();
  assert.equal(r.asked.length, 2, 'a fresh picture or a refused one was asked for again at once');
  r.clock.now += PICTURE_RETRY_MS + 1;
  await r.pictures.sync();
  assert.deepEqual(r.asked.slice(2).map((a) => a.url), [url('zcash')], 'a refused picture was not tried again after a day');
  r.clock.now += PICTURE_REFRESH_MS;
  r.serve.set(url('venice-token'), { body: JPEG });
  await r.pictures.sync();
  assert.equal(r.pictures.read('venice-token')?.type, 'image/jpeg', 'a week-old picture was not fetched again');
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['venice-token.jpg'], 'the old file was left beside the new one');
});

/* Pictures review finding 2: nothing bounded the cache but the list, and nothing left it. A list
   naming every coin CoinGecko has (about 17,000) filled the disk a quarter megabyte at a time, and
   when the list went back to normal every file stayed. */
test('a pass is about the first 500 listed coins by id, and one past them gets no picture', async () => {
  assert.equal(PICTURE_MAX_IDS, 500);
  // Fifty of sixty here, the same rule at a size a test writes in a moment.
  const ids = Array.from({ length: 60 }, (_, i) => `coin-${String(i).padStart(3, '0')}`);
  const r = rig({ ids, maxIds: 50 });
  await r.pictures.sync();
  assert.equal(r.asked.length, 50, 'a pass asked for more pictures than its cap');
  assert.equal(fs.readdirSync(r.dir).length, 50);
  assert.equal(r.pictures.read('coin-049')?.type, 'image/png');
  assert.equal(r.pictures.read('coin-050'), null, 'the coin past the cap by id was kept');
  assert.equal(r.pictures.manifest().settled, true, 'the coins past the cap keep the window asking forever');
  await r.pictures.sync();
  assert.equal(r.asked.length, 50, 'the next pass went after the coins past the cap');
});

test('the cache holds at most 64 MB: a picture that would take it past is not kept, and waits a day', async () => {
  assert.equal(PICTURE_MAX_TOTAL_BYTES, 64 * 1024 * 1024);
  const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024 - PNG.length, 5)]);
  const ids = ['a-coin', 'b-coin', 'c-coin', 'd-coin', 'e-coin'];
  const r = rig({ ids, maxBytes: 3 * PICTURE_MAX_BYTES });
  for (const id of ids) r.serve.set(url(id), { body: big });
  await r.pictures.sync();
  const kept = fs.readdirSync(r.dir);
  const bytes = kept.reduce((sum, name) => sum + fs.statSync(path.join(r.dir, name)).size, 0);
  assert.ok(bytes <= 3 * PICTURE_MAX_BYTES, `the cache holds ${bytes} bytes`);
  assert.deepEqual(kept.sort(), ['a-coin.png', 'b-coin.png', 'c-coin.png']);
  assert.equal(r.asked.length, 3, 'a picture with no room for it was downloaded anyway');
  assert.match(r.lines.join('\n'), /d-coin \(the cache is full/);
  assert.equal(r.pictures.manifest().settled, true);
  await r.pictures.sync();
  assert.equal(r.asked.length, 3, 'a picture refused for room was asked for again at once');
});

test('after a pass that ran to its end, a coin no longer listed loses its file; a pass that stopped, or no list at all, deletes nothing', async () => {
  const r = rig({ ids: ['venice-token', 'zcash'] });
  await r.pictures.sync();
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['venice-token.png', 'zcash.png']);
  // A stray copy of the coin under another extension goes with it.
  fs.writeFileSync(path.join(r.dir, 'zcash.jpg'), JPEG);

  // No list yet (the day feed has not answered since a restart): nothing is taken away.
  const saved = new Map(r.urls);
  r.urls.clear();
  await r.pictures.sync();
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['venice-token.png', 'zcash.jpg', 'zcash.png']);

  // A pass the image host stopped with a 429 is not the end of one.
  for (const [id, at] of saved) if (id !== 'zcash') r.urls.set(id, at);
  r.urls.set('litecoin', url('litecoin'));
  r.serve.set(url('litecoin'), { status: 429, body: null });
  await r.pictures.sync();
  assert.ok(fs.readdirSync(r.dir).includes('zcash.png'), 'a stopped pass deleted a file');

  r.serve.set(url('litecoin'), { body: PNG });
  await r.pictures.sync();
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['litecoin.png', 'venice-token.png'], 'zcash left the list and kept its files');
  assert.equal(r.pictures.read('zcash'), null);
  assert.equal(r.fresh().read('zcash'), null, 'a restart found the file again');
  assert.equal('ZEC' in r.pictures.manifest().symbols, false);
});

test('a picture tampered with on disk is not served', async () => {
  const r = rig({ ids: ['venice-token'] });
  await r.pictures.sync();
  fs.writeFileSync(path.join(r.dir, 'venice-token.png'), SVG);
  assert.equal(r.pictures.read('venice-token'), null);
  fs.writeFileSync(path.join(r.dir, 'venice-token.png'), HUGE_PNG);
  assert.equal(r.pictures.read('venice-token'), null);
  // A file that is not named for a CoinGecko id is never picked up.
  fs.writeFileSync(path.join(r.dir, '..evil.png'), PNG);
  assert.equal(r.fresh().read('..evil'), null);
});

test('the cache sits under the data directory, never beside the keys or under ~/.phosphor', () => {
  const home = tempDir('phosphor-home-');
  const data = tempDir('phosphor-data-');
  const keysElsewhere = path.join(home, '.phosphor', 'phosphor', 'keys.enc.json');
  assert.equal(pictureDir(data, keysElsewhere, home), path.join(data, 'cache', 'coin-images'));
  assert.equal(pictureDir(data, path.join(data, 'keys.json'), home), null, 'the pictures went beside the key file');
  assert.equal(pictureDir(path.join(home, '.phosphor', 'data'), keysElsewhere, home), null, 'the pictures went under ~/.phosphor');
  assert.equal(pictureDir(path.join(home, '.phosphor-demo', 'x'), path.join(data, 'k', 'keys.json'), home), null);
  // No folder, no pictures: nothing is fetched, and the window keeps its monograms.
  const none = createCoinPictures({ dir: null, urls: () => new Map([['zcash', url('zcash')]]), symbols: () => new Map(), fetchImpl: (async () => { throw new Error('asked'); }) as typeof fetch, log: () => {} });
  return none.sync().then(() => {
    assert.equal(none.read('zcash'), null);
    assert.deepEqual(none.manifest(), { symbols: {}, settled: true });
  });
});

/* ---------- the routes ---------- */

async function get(ctx: Partial<Ctx>, route: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const server = http.createServer((req, res) => void handle(ctx as Ctx, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /api/coin-image serves a picture from disk as what its bytes are, and nothing it does not have', async () => {
  const r = rig({ ids: ['venice-token', 'zcash'] });
  r.serve.set(url('zcash'), { body: JPEG });
  await r.pictures.sync();
  const ctx = { pictures: r.pictures, audit: { append: () => {} } } as unknown as Partial<Ctx>;
  const png = await get(ctx, '/api/coin-image?id=venice-token');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['x-content-type-options'], 'nosniff');
  assert.match(String(png.headers['content-security-policy']), /default-src 'none'/);
  assert.deepEqual(png.body, PNG);
  assert.equal((await get(ctx, '/api/coin-image?id=zcash')).headers['content-type'], 'image/jpeg');
  for (const bad of ['?id=litecoin', '?id=..%2F..%2Fkeys', '?id=', '', '?id=Venice-Token']) {
    assert.equal((await get(ctx, `/api/coin-image${bad}`)).status, 404, `${bad} answered`);
  }
  const manifest = JSON.parse((await get(ctx, '/api/coin-images')).body.toString('utf8'));
  assert.deepEqual(manifest, { symbols: { VVV: 'venice-token', ZEC: 'zcash' }, settled: true });
  // Demo mode builds no pictures: no symbols, and nothing more is coming.
  const demo = { audit: { append: () => {} } } as unknown as Partial<Ctx>;
  assert.deepEqual(JSON.parse((await get(demo, '/api/coin-images')).body.toString('utf8')), { symbols: {}, settled: true });
  assert.equal((await get(demo, '/api/coin-image?id=venice-token')).status, 404);
});

test('the manifest says it is not settled while pictures are still to come, so the window asks again soon', async () => {
  const r = rig({ ids: ['venice-token', 'zcash'] });
  assert.equal(r.pictures.manifest().settled, false, 'nothing fetched yet and the manifest says settled');
  await r.pictures.sync();
  assert.equal(r.pictures.manifest().settled, true);
  r.urls.set('litecoin', url('litecoin'));
  r.serve.set(url('litecoin'), { body: PNG });
  assert.equal(r.pictures.manifest().settled, false, 'a newly listed coin with no picture yet reads as settled');
  const empty = rig({ ids: [] });
  assert.equal(empty.pictures.manifest().settled, false, 'no list yet reads as settled');
});
