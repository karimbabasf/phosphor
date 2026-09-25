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
// hand-picked files in ui/logos stay the only SVG the window draws. A picture that fails any of it
// is not kept and not asked for again for a day, and the coin keeps its monogram. What is on disk
// is checked again every time it is served.
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
      return type === null ? null : { bytes, type };
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
