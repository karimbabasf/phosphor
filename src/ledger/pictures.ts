// The coin pictures: every listed coin's picture, fetched once into a cache on disk and served by
// the local server, for the window's logos.
//
// WHY (2026-09-25). ui/design/marks.js drew a real logo only for a ticker with a hand-picked file
// in ui/logos, 75 of them, so VVV and the forty-odd other coins 1Click lists beyond those were a
// letter on a disc. Karim: "the pictures are out there, we just have to find them and use them."
// The markets answer the day feed already reads names each coin's picture (src/ledger/day.ts), and
// the window now draws a hand-picked file first, then this picture, then the monogram.
//
// EVERY LISTED COIN, NEVER THE HELD ONES. What is fetched is the token list's pictures, whatever
// the wallet holds, so the image host learns nothing about it; and the window loads a picture only
// from this app's own server (its CSP allows images from nowhere else), so no third party sees
// what the window draws either.
//
// THE BYTES ARE UNTRUSTED. Only https from CoinGecko's image host (pictureUrl in day.ts), no
// redirect followed, the read deadline, 256 KB at most counted as the bytes arrive (a
// content-length is a claim, not a count), and only PNG, JPEG or WebP by their first bytes,
// whatever the server calls them. Never SVG: an SVG is a document that can carry script, and the
// hand-picked files in ui/logos stay the only SVG the window draws. And no more than
// PICTURE_MAX_SIDE pixels a side by its own header (pictures review finding 3): 256 KB caps the
// file and not the bitmap, and a PNG declaring 40000 x 40000 deflates to about 195 KB and would
// have WebKit decode gigabytes for a 24 px mark. A picture that fails any of it is not kept and
// not asked for again for a day, and the coin keeps its monogram. What is on disk is checked again,
// size included, every time it is served.
//
// ON DISK, AWAY FROM THE KEYS: <dataDir>/cache/coin-images, one file per CoinGecko id, written
// whole or not at all. A data directory that would put it beside the key file, or under the
// wallets' own folders in the home directory, gets no pictures. A picture is fetched again after a
// week.
//
// BOUNDED, AND IT FORGETS (pictures review finding 2). Nothing bounded the cache but the list, and
// nothing ever left it: a list naming every coin CoinGecko has would fill the disk a quarter
// megabyte at a time and keep all of it. A pass is about the first PICTURE_MAX_IDS listed coins by
// id; the files of those coins hold at most PICTURE_MAX_TOTAL_BYTES, and a picture there is no room
// for is not fetched and waits a day like any refused one; and a pass that runs to its end deletes
// the file of every coin it was not about, so a coin 1Click stops listing leaves the disk. Today's
// list names 97 coins, about a megabyte and a half.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveReal } from '../config.ts';
import { atomicWrite } from '../fsatomic.ts';
import { oneLine } from '../intents.ts';
import { readTimeout } from '../net.ts';
import { coingeckoIdOk, pictureUrl } from './day.ts';

export const PICTURE_MAX_BYTES = 256 * 1024;
// How old a picture on disk may get before it is fetched again: a coin rarely changes its mark.
export const PICTURE_REFRESH_MS = 7 * 24 * 60 * 60_000;
// How long a picture that was refused, or would not come, waits before it is asked for again.
export const PICTURE_RETRY_MS = 24 * 60 * 60_000;
// The most coins a pass is about, and the most their files may hold together. See BOUNDED above.
export const PICTURE_MAX_IDS = 500;
export const PICTURE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
// The longest side a picture may declare. A mark draws at 16 to 32 px, and CoinGecko's large
// picture is 250.
export const PICTURE_MAX_SIDE = 1024;

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp';
export type Picture = { bytes: Buffer; type: PictureType };
// What GET /api/coin-images hands the window: each symbol with a picture on disk to its CoinGecko
// id, and whether more are still to come, so the window knows to ask again soon.
export type PicturesManifest = { symbols: Record<string, string>; settled: boolean };

export type CoinPictures = {
  // Fetches what is missing or a week old, one at a time. Never throws; a tick that lands while
  // one is running joins it.
  sync(): Promise<void>;
  // A picture on disk, checked again, or null.
  read(id: string): Picture | null;
  manifest(): PicturesManifest;
};

export type CoinPicturesDeps = {
  // Where the pictures live (pictureDir), or null for no pictures at all.
  dir: string | null;
  // Every listed coin's picture URL, by CoinGecko id (DayFeed.pictureUrls).
  urls: () => ReadonlyMap<string, string>;
  // Each listed symbol to its CoinGecko id (DayFeed.symbols).
  symbols: () => ReadonlyMap<string, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  // Test seams: the two caps, at a size a test fills in a moment. The app passes neither.
  maxIds?: number;
  maxBytes?: number;
};

const EXT: Record<PictureType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE_OF: Record<string, PictureType> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
// A file this module wrote: a CoinGecko id and the extension its bytes earned. Nothing else in the
// folder is ever read, and a half-written file (atomicWrite's) starts with a dot.
const FILE = /^([a-z0-9][a-z0-9._-]{0,99})\.(png|jpg|webp)$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* What a picture's first bytes say it is: the PNG signature, the JPEG start of image, or a RIFF
   file whose form is WEBP. Anything else is null, an SVG above all, whatever a header called it. */
export function pictureType(bytes: Uint8Array): PictureType | null {
  if (bytes.length >= PNG.length && PNG.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

export type PictureSize = { width: number; height: number };

/* What a picture's header says it draws at, read before anything decodes it: PNG's IHDR, the first
   JPEG frame header, WebP's VP8, VP8L or VP8X chunk. Null when the header cannot be read or names
   a side of zero, and a null is refused like a side too long. */
export function pictureSize(bytes: Uint8Array, type: PictureType): PictureSize | null {
  const size = type === 'image/png' ? pngSize(bytes) : type === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

// The first chunk is IHDR, and its first eight bytes are the width and the height.
function pngSize(b: Uint8Array): PictureSize | null {
  if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// A JPEG frame header: SOF0 to SOF15 but DHT (C4), JPG (C8) and DAC (CC), or DHP (DE), which names
// a hierarchical image's size ahead of its frames.
function frameHeader(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) || marker === 0xde;
}

// Segment by segment, each stepped over by its own length, to the first frame header.
function jpegSize(b: Uint8Array): PictureSize | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // A fill byte, then the markers that carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // A scan, an end or a second start before any frame header: no size to read.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    if (frameHeader(marker)) {
      if (i + 8 >= b.length) return null;
      return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
    }
    i += 2 + length;
  }
  return null;
}

// The first chunk after RIFF and WEBP, as each of the three forms writes it.
function webpSize(b: Uint8Array): PictureSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 16);
  // Lossy: a key frame's start code, then 14 bits of width and 14 of height.
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  // Lossless: its signature, then 14 bits of width less one and 14 of height less one.
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // Extended: the canvas, 24 bits of width less one and 24 of height less one.
  if (chunk === 'VP8X') {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

// Why a picture's header rules it out, or null when the window can draw it.
function sizeRefusal(bytes: Uint8Array, type: PictureType): string | null {
  const size = pictureSize(bytes, type);
  if (size === null) return 'its size could not be read';
  if (size.width > PICTURE_MAX_SIDE || size.height > PICTURE_MAX_SIDE) return `${size.width} x ${size.height} px, over ${PICTURE_MAX_SIDE} a side`;
  return null;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* Where the pictures go: <dataDir>/cache/coin-images, unless that is the folder the key file sits
   in, inside it or around it, or anywhere under ~/.phosphor or ~/.phosphor-demo, where the wallets
   live. Then null, and the window keeps its monograms. Compared as the filesystem spells the
   paths (resolveReal in src/config.ts), so neither a symlink nor a change of case walks the cache
   in beside the keys. `home` is a parameter for the tests. */
export function pictureDir(dataDir: string, keysPath: string, home: string = os.homedir()): string | null {
  const dir = path.resolve(dataDir, 'cache', 'coin-images');
  const real = resolveReal(dir);
  const keys = resolveReal(path.dirname(keysPath));
  if (within(real, keys) || within(keys, real)) return null;
  for (const wallets of ['.phosphor', '.phosphor-demo']) {
    if (within(real, resolveReal(path.join(home, wallets)))) return null;
  }
  return dir;
}

type Fetched = { ok: true; picture: Picture } | { ok: false; why: string; stop?: boolean };
type OnDisk = { file: string; type: PictureType; at: number; size: number };

export function createCoinPictures(deps: CoinPicturesDeps): CoinPictures {
  const dir = deps.dir;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const maxIds = deps.maxIds ?? PICTURE_MAX_IDS;
  const maxBytes = deps.maxBytes ?? PICTURE_MAX_TOTAL_BYTES;
  // What a restart finds on disk is served at once, before anything is asked of the network.
  const files = scan();
  // When each refused picture was refused, so it waits a day rather than every tick.
  const refusedAt = new Map<string, number>();
  let running: Promise<void> | null = null;

  if (dir === null) log('phosphor: coin pictures are off: the data directory would keep them beside the keys');

  function scan(): Map<string, OnDisk> {
    const out = new Map<string, OnDisk>();
    if (dir === null) return out;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const match = FILE.exec(name);
      if (match === null) continue;
      try {
        const stat = fs.lstatSync(path.join(dir, name));
        const have = out.get(match[1]);
        if (stat.isFile() && (have === undefined || stat.mtimeMs > have.at)) {
          out.set(match[1], { file: path.join(dir, name), type: TYPE_OF[match[2]], at: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // Gone between the listing and the look.
      }
    }
    return out;
  }

  // The body, counted as it arrives. Past the cap the rest is never read.
  async function readCapped(res: Response): Promise<{ bytes: Buffer } | { why: string }> {
    if (res.body === null) return { bytes: Buffer.alloc(0) };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PICTURE_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { why: `over ${PICTURE_MAX_BYTES / 1024} KB` };
        }
        chunks.push(value);
      }
    } catch (err) {
      return { why: `did not finish: ${oneLine(err instanceof Error ? err.message : err, 80)}` };
    }
    return { bytes: Buffer.concat(chunks) };
  }

  async function fetchPicture(url: string): Promise<Fetched> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: readTimeout(),
        headers: { accept: 'image/png, image/jpeg, image/webp' },
      });
    } catch (err) {
      return { ok: false, why: `did not answer: ${oneLine(err instanceof Error ? err.message : err, 80)}` };
    }
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      if (res.status === 429) return { ok: false, why: 'too many requests (429)', stop: true };
      return { ok: false, why: res.status >= 300 && res.status < 400 ? `a redirect (${res.status}), not followed` : `answered ${res.status}` };
    }
    const said = Number(res.headers.get('content-length'));
    if (Number.isFinite(said) && said > PICTURE_MAX_BYTES) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, why: `${said} bytes, over ${PICTURE_MAX_BYTES / 1024} KB` };
    }
    const body = await readCapped(res);
    if ('why' in body) return { ok: false, why: body.why };
    const type = pictureType(body.bytes);
    if (type === null) return { ok: false, why: 'not a PNG, JPEG or WebP' };
    const refusal = sizeRefusal(body.bytes, type);
    if (refusal !== null) return { ok: false, why: refusal };
    return { ok: true, picture: { bytes: body.bytes, type } };
  }

  // Whole or not at all, through the app's one durable writer, and stamped with when it was
  // fetched; a copy of the coin under another extension goes, so one coin is one file.
  function write(id: string, picture: Picture): void {
    if (dir === null) return;
    const ext = EXT[picture.type];
    const target = path.join(dir, `${id}.${ext}`);
    atomicWrite(target, picture.bytes, { mode: 0o600, dirMode: 0o700 });
    const stamp = now() / 1000;
    fs.utimesSync(target, stamp, stamp);
    for (const other of Object.values(EXT)) {
      if (other !== ext) fs.rmSync(path.join(dir, `${id}.${other}`), { force: true });
    }
    files.set(id, { file: target, type: picture.type, at: now(), size: picture.bytes.length });
  }

  // The coins a pass is about: the first maxIds good ids on the list, by id, so every pass and
  // every restart picks the same ones.
  function reach(urls: ReadonlyMap<string, string>): Array<[string, string]> {
    return [...urls]
      .filter(([id]) => coingeckoIdOk(id))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, maxIds);
  }

  // What the files of these coins hold on disk together.
  function heldBytes(about: ReadonlySet<string>): number {
    let total = 0;
    for (const id of about) total += files.get(id)?.size ?? 0;
    return total;
  }

  // Every file of a coin the pass was not about goes, whatever extension it has.
  function prune(about: ReadonlySet<string>): void {
    if (dir === null) return;
    for (const id of [...files.keys()]) {
      if (about.has(id)) continue;
      try {
        for (const ext of Object.values(EXT)) fs.rmSync(path.join(dir, `${id}.${ext}`), { force: true });
        files.delete(id);
      } catch {
        // Left for the next pass.
      }
    }
    for (const id of [...refusedAt.keys()]) if (!about.has(id)) refusedAt.delete(id);
  }

  async function run(): Promise<void> {
    if (dir === null) return;
    const refused: string[] = [];
    const due = reach(deps.urls());
    const about = new Set(due.map(([id]) => id));
    let stopped = false;
    for (const [id, raw] of due) {
      const have = files.get(id);
      if (have !== undefined && now() - have.at < PICTURE_REFRESH_MS) continue;
      const failedAt = refusedAt.get(id);
      if (failedAt !== undefined && now() - failedAt < PICTURE_RETRY_MS) continue;
      // Room for this one at its largest among the files the pass keeps, asked before the
      // download, so a picture that could not be kept is never fetched.
      if (heldBytes(about) - (have?.size ?? 0) + PICTURE_MAX_BYTES > maxBytes) {
        refusedAt.set(id, now());
        refused.push(`${id} (the cache is full at ${maxBytes / (1024 * 1024)} MB)`);
        continue;
      }
      const url = pictureUrl(raw);
      const got: Fetched = url === null ? { ok: false, why: 'not a CoinGecko image URL' } : await fetchPicture(url);
      if (!got.ok) {
        // A server that said too many requests is not the picture's fault: the pass stops and the
        // next tick carries on.
        if (got.stop === true) {
          refused.push(`${id} (${got.why})`);
          stopped = true;
          break;
        }
        refusedAt.set(id, now());
        refused.push(`${id} (${got.why})`);
        continue;
      }
      try {
        write(id, got.picture);
        refusedAt.delete(id);
      } catch (err) {
        refusedAt.set(id, now());
        refused.push(`${id} (could not be written: ${oneLine(err instanceof Error ? err.message : err, 80)})`);
      }
    }
    // A pass that ran to its end over a list that answered takes away every file it was not about.
    // No list yet (the day feed has not answered since a restart) is not a list of nothing.
    if (!stopped && due.length > 0) prune(about);
    if (refused.length > 0) {
      const more = refused.length > 5 ? `, and ${refused.length - 5} more` : '';
      log(`phosphor: ${refused.length} coin picture${refused.length === 1 ? '' : 's'} not kept: ${refused.slice(0, 5).join(', ')}${more}`);
    }
  }

  function sync(): Promise<void> {
    running ??= run()
      .catch((err: unknown) => log(`phosphor: the coin pictures broke: ${oneLine(err instanceof Error ? err.message : err, 120)}`))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function read(id: string): Picture | null {
    if (!coingeckoIdOk(id)) return null;
    const have = files.get(id);
    if (have === undefined) return null;
    try {
      const stat = fs.lstatSync(have.file);
      if (!stat.isFile() || stat.size > PICTURE_MAX_BYTES) return null;
      const bytes = fs.readFileSync(have.file);
      const type = bytes.length > PICTURE_MAX_BYTES ? null : pictureType(bytes);
      return type === null || sizeRefusal(bytes, type) !== null ? null : { bytes, type };
    } catch {
      files.delete(id);
      return null;
    }
  }

  // Nothing more is coming: the list is known, no pass is running, and every picture a pass is
  // about is on disk or was refused inside the last day. A coin past the cap is coming never.
  function settled(): boolean {
    const urls = deps.urls();
    if (urls.size === 0 || running !== null) return false;
    for (const [id] of reach(urls)) {
      if (files.has(id)) continue;
      const failedAt = refusedAt.get(id);
      if (failedAt === undefined || now() - failedAt >= PICTURE_RETRY_MS) return false;
    }
    return true;
  }

  function manifest(): PicturesManifest {
    if (dir === null) return { symbols: {}, settled: true };
    const pairs: Array<[string, string]> = [];
    for (const [symbol, id] of deps.symbols()) if (files.has(id)) pairs.push([symbol, id]);
    // fromEntries defines each key as its own property, so a symbol is only ever a name.
    return { symbols: Object.fromEntries(pairs), settled: settled() };
  }

  return { sync, read, manifest };
}
