// What the chart keeps across a restart: every study, level, mark, line and zone on every
// market each chart has shown, the charts themselves (market, timeframe, bars, venue, and the
// comparison charts a layout put up), the market in focus and the Layers switches. Karim,
// 2026-09-24: the markings stay, through quitting and through the agent's session ending, until
// somebody explicitly clears them.
//
// One file, <dataDir>/chart-markings.json, written whole through the app's one durable writer
// (src/fsatomic.ts, owner-only) and read back through a strict schema. The rules the schema
// holds are the ones that make a file this app reads at boot safe to read:
//
//   Nothing in it runs. A study is kept as its type and its numbers; its label, its pane and
//   its code come back from the app's own library (the built-in catalogue, or the custom loader's
//   map by slug) and never from here. A file that names a study the library no longer has loses
//   that study, with a line in the log.
//   Nothing in it points anywhere. A product, a symbol, an id and a session are closed character
//   sets; a label goes back through src/chart-label.ts, which takes out anything that looks like
//   a link or a path and puts the [agent] tag back on the agent's.
//   Nothing in it grows without bound. Every list is capped, the chart re-applies its own
//   per-market and total caps as it takes the markings back, and a file past 2 MB (four times what
//   the caps can write) is refused unread.
//   Unknown fields are dropped, one bad entry is dropped on its own, and a file that cannot be
//   read at all is copied aside and the chart starts empty, with a line in the log. Nothing
//   here throws at boot.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { atomicWriteJson } from './fsatomic.ts';
import { LIMITS, PROVIDER_CHOICES } from './chart.ts';
import type { ChartIndicatorRecipe, ChartLevel, ChartMark } from './chart.ts';
import type { SlotsSnapshot } from './charts.ts';
import type { Drawing } from './drawings.ts';
import { DRAWINGS_MAX } from './drawings.ts';
import { OVERLAYS } from './trade/view.ts';
import type { OverlayName } from './trade/view.ts';
import { MIN_TIMEFRAME_SEC, servable } from './market/aggregate.ts';

export const MARKINGS_FILE = 'chart-markings.json';
export const MARKINGS_VERSION = 1;
// Four charts full to every cap write about half a megabyte (compact, as save does). The read cap
// sits well above that, because a file an agent could fill past the cap would be a file an agent
// could have thrown away whole at the next boot, the person's markings with it.
export const MARKINGS_MAX_BYTES = 2 * 1024 * 1024;
// A ceiling on each list in the file, well past anything the stores can hold, so a hand-made
// file cannot make the boot walk a million entries before the caps apply.
const LIST_CEILING = 1000;

export type SavedFocus = { symbol: string; overlays: Partial<Record<OverlayName, boolean>> };
export type SavedMarkings = { charts: SlotsSnapshot; focus: SavedFocus | null };

// ---------- the schema ----------

// "BTC-USD", "KPEPE-USD", "ETH-USDC": the only shape the catalogue makes.
const PRODUCT = z.string().regex(/^[A-Z0-9]{1,24}-[A-Z0-9]{1,12}$/);
const SYMBOL = z.string().regex(/^[A-Z0-9]{1,12}$/);
const SOURCE = z.enum(['human', 'agent']);
// A session id is metadata about who drew something. One that is not a plain id is forgotten
// rather than fatal: the drawing is still the agent's.
const BY = z.union([z.string().regex(/^[A-Za-z0-9._:@-]{1,64}$/), z.null()]).catch(null);
const CREATED = z.number().int().min(0).max(8.64e15);
const GRANULARITY = z.number().int().refine((s) => s >= MIN_TIMEFRAME_SEC && servable(s), 'not a timeframe');
const PRICE = z.number().gt(-1e15).lt(1e15);
const EPOCH_SEC = z.number().min(0).max(1e11);
// Cleaned and cut again on the way in (src/chart-label.ts); this only bounds what is read.
const LABEL = z.string().max(256);
const STORE_ID = z.string().regex(/^[a-z0-9:_-]{1,48}-\d{1,9}$/);
const TYPE = z.string().regex(/^(?:[a-z][a-z0-9_]{0,31}|custom:[a-z0-9-]{1,32})$/);
const PARAMS = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/), z.number())
  .refine((r) => Object.keys(r).length <= 12, 'too many parameters');

const provenance = { source: SOURCE, by: BY, createdAt: CREATED, product: PRODUCT, granularitySec: GRANULARITY };

const INDICATOR = z.object({ id: STORE_ID, type: TYPE, params: PARAMS, ...provenance });
const LEVEL = z.object({ id: STORE_ID, price: PRICE, label: LABEL, ...provenance });
const MARK = z.object({ id: STORE_ID, t: EPOCH_SEC, label: LABEL, ...provenance });
const ANCHOR = z.object({ t: EPOCH_SEC, price: PRICE });
const DRAWING = z.object({
  id: z.string().regex(/^(?:c[1-3]_)?(?:tl|zn)_\d{1,9}$/),
  kind: z.enum(['trendline', 'zone']),
  label: LABEL,
  source: SOURCE,
  by: BY,
  product: PRODUCT.optional(),
  granularitySec: GRANULARITY.optional(),
  createdAt: CREATED,
  line: z.object({ a: ANCHOR, b: ANCHOR }).optional(),
  zone: z.object({ low: PRICE, high: PRICE, t1: EPOCH_SEC.optional(), t2: EPOCH_SEC.optional() }).optional(),
});
const VIEW = z.object({
  product: PRODUCT,
  provider: z.enum(PROVIDER_CHOICES as unknown as ['auto', 'hyperliquid', 'coinbase']),
  granularitySec: GRANULARITY,
  barCount: z.number().min(LIMITS.barCountMin).max(LIMITS.barCountMax),
});
const LIST = z.array(z.unknown()).max(LIST_CEILING);
const CHART = z.object({
  index: z.number().int().min(0).max(3),
  // A view this version cannot read (a product named some new way) costs the chart its view, not
  // its markings: the chart opens where it would have and the markings wait on their markets.
  view: VIEW.nullable().catch(null),
  seq: z.number().int().min(0).max(1e8),
  indicators: LIST,
  levels: LIST,
  marks: LIST,
  drawings: LIST,
});
const COUNTER = z.number().int().min(0).max(1e8).catch(0);
const OVERLAY_SWITCHES = z.object(Object.fromEntries(OVERLAYS.map((name) => [name, z.boolean().optional()])) as Record<OverlayName, z.ZodOptional<z.ZodBoolean>>);
const FILE = z.object({
  version: z.literal(MARKINGS_VERSION),
  savedAt: z.string().max(40).optional(),
  counters: z.object({ tl: COUNTER.optional(), zn: COUNTER.optional() }),
  charts: z.array(z.unknown()).max(4),
  focus: z.object({ symbol: SYMBOL, overlays: OVERLAY_SWITCHES }).nullable().optional(),
});

/* One list, entry by entry: a bad entry is left out and counted, and the rest stand. */
function entries<T>(list: unknown[], schema: z.ZodType<T>, cap: number, dropped: { n: number }): T[] {
  const out: T[] = [];
  for (const raw of list) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      dropped.n += 1;
      continue;
    }
    out.push(parsed.data);
  }
  if (out.length > cap) dropped.n += out.length - cap;
  return out.slice(0, cap);
}

/* The file's contents as the stores take them, every part held to the schema above. Used both
   ways: what is read is parsed through it, and what is written is too, so the app never writes
   a file its own reader would refuse. */
export function parseMarkings(value: unknown): { saved: SavedMarkings; dropped: number } | { error: string } {
  const top = FILE.safeParse(value);
  if (!top.success) {
    const issue = top.error.issues[0];
    return { error: issue === undefined ? 'the file does not validate' : `${issue.path.join('.') || 'the file'}: ${issue.message}` };
  }
  const dropped = { n: 0 };
  const seen = new Set<number>();
  const charts: SlotsSnapshot['charts'] = [];
  for (const raw of top.data.charts) {
    const parsed = CHART.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.index)) {
      dropped.n += 1;
      continue;
    }
    const c = parsed.data;
    seen.add(c.index);
    charts.push({
      index: c.index,
      view: c.view,
      seq: c.seq,
      indicators: entries(c.indicators, INDICATOR, LIMITS.maxOverlays + LIMITS.maxPanes, dropped) as ChartIndicatorRecipe[],
      levels: entries(c.levels, LEVEL, LIMITS.levelsTotal, dropped) as ChartLevel[],
      marks: entries(c.marks, MARK, LIMITS.marksTotal, dropped) as ChartMark[],
      drawings: entries(c.drawings, DRAWING, DRAWINGS_MAX, dropped) as Drawing[],
    });
  }
  charts.sort((a, b) => a.index - b.index);
  const focus = top.data.focus ?? null;
  return {
    saved: {
      charts: { counters: { tl: top.data.counters.tl ?? 0, zn: top.data.counters.zn ?? 0 }, charts },
      focus: focus === null ? null : { symbol: focus.symbol, overlays: focus.overlays },
    },
    dropped: dropped.n,
  };
}

// ---------- the file ----------

export type MarkingsFile = {
  path: string;
  // What was kept, or null for a fresh install and for a file that could not be read (which is
  // copied aside and logged). Never throws.
  load(): SavedMarkings | null;
  // Throws only what the durable writer throws; the keeper below catches and logs it.
  save(saved: SavedMarkings): void;
};

export function createMarkingsFile(dataDir: string, log: (line: string) => void = () => {}): MarkingsFile {
  const file = path.join(dataDir, MARKINGS_FILE);

  // A file the app cannot read is kept for whoever wants to know why, and the next save writes a
  // good one in its place. The same move src/trade/plans.ts makes with an unreadable plans.json.
  function aside(why: string): null {
    const copy = `${file}.${Date.now().toString(36)}.unreadable`;
    try {
      fs.copyFileSync(file, copy);
      log(`${why}; the chart starts empty and the file was kept as ${path.basename(copy)}`);
    } catch {
      log(`${why}; the chart starts empty`);
    }
    return null;
  }

  return {
    path: file,
    load() {
      let raw: string;
      try {
        // lstat, not stat: a link here is a file somewhere else, and this read is the app's own.
        const st = fs.lstatSync(file);
        if (!st.isFile()) {
          log(`${MARKINGS_FILE} is not a plain file, so it was not read; the chart starts empty`);
          return null;
        }
        if (st.size > MARKINGS_MAX_BYTES) return aside(`${MARKINGS_FILE} is ${Math.ceil(st.size / 1024)} KB, over the ${MARKINGS_MAX_BYTES / 1024} KB this app reads`);
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        log(`${MARKINGS_FILE} could not be read (${(err as NodeJS.ErrnoException)?.code ?? 'error'}); the chart starts empty`);
        return null;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return aside(`${MARKINGS_FILE} is not valid JSON`);
      }
      const out = parseMarkings(json);
      if ('error' in out) return aside(`${MARKINGS_FILE} does not match what this app writes (${out.error})`);
      if (out.dropped > 0) log(`${out.dropped} ${out.dropped === 1 ? 'entry' : 'entries'} in ${MARKINGS_FILE} did not validate and ${out.dropped === 1 ? 'was' : 'were'} left out`);
      return out.saved;
    },
    save(saved) {
      const body = toFile(saved);
      const checked = parseMarkings(body);
      // What goes down is what the reader would take back: parsed through the same schema, so a
      // store bug writes a smaller file rather than one the next boot throws away whole.
      if ('error' in checked) throw new Error(`the chart markings did not validate: ${checked.error}`);
      atomicWriteJson(file, { ...toFile(checked.saved), savedAt: new Date().toISOString() }, 0);
    },
  };
}

function toFile(saved: SavedMarkings): Record<string, unknown> {
  return {
    version: MARKINGS_VERSION,
    counters: { tl: saved.charts.counters.tl ?? 0, zn: saved.charts.counters.zn ?? 0 },
    charts: saved.charts.charts,
    focus: saved.focus,
  };
}

// ---------- the keeper ----------

export type MarkingsKeeper = {
  // Something changed. Cheap: the check runs once per turn of the event loop however many
  // changes one request made.
  touch(): void;
  // Write now if anything differs from the last write. Called on the way out.
  flush(): void;
  stop(): void;
};

/* When the markings change, the file follows within the same turn of the event loop, so a clear
   that was answered is a clear that is on the disk, and a restart a moment later cannot bring
   back what somebody removed. A burst is held to one write per `burstMs`: an agent calling
   chart_draw in a loop gets its last state written a fifth of a second later, not two fsyncs per
   call. A change to the view alone (a zoom, a timeframe, the focus) waits a second for the hand
   to settle, because a trackpad zoom is a stream of them. */
export function createMarkingsKeeper(opts: {
  file: Pick<MarkingsFile, 'save'>;
  snapshot: () => SavedMarkings;
  log?: (line: string) => void;
  viewDelayMs?: number;
  burstMs?: number;
  now?: () => number;
}): MarkingsKeeper {
  const log = opts.log ?? (() => {});
  const viewDelayMs = opts.viewDelayMs ?? 1000;
  const burstMs = opts.burstMs ?? 200;
  const now = opts.now ?? (() => Date.now());
  let pending: NodeJS.Immediate | null = null;
  let later: NodeJS.Timeout | null = null;
  let lastWriteAt = -Infinity;
  let failing = false;
  let stopped = false;

  const markingsKey = (s: SavedMarkings): string =>
    JSON.stringify({ counters: s.charts.counters, charts: s.charts.charts.map((c) => [c.index, c.seq, c.indicators, c.levels, c.marks, c.drawings]) });
  const wholeKey = (s: SavedMarkings): string => JSON.stringify(s);

  const first = opts.snapshot();
  let lastMarkings = markingsKey(first);
  let lastWhole = wholeKey(first);

  function write(s: SavedMarkings): void {
    lastWriteAt = now();
    try {
      opts.file.save(s);
      lastMarkings = markingsKey(s);
      lastWhole = wholeKey(s);
      if (failing) log('chart markings are being saved again');
      failing = false;
    } catch (err) {
      // One line per run of failures, not one per change: a full disk is one fact.
      if (!failing) log(`chart markings could not be saved: ${err instanceof Error ? err.message : String(err)}`);
      failing = true;
    }
  }

  function schedule(ms: number): void {
    if (later !== null) return;
    later = setTimeout(() => {
      later = null;
      if (!stopped) settle();
    }, Math.max(0, ms));
    later.unref?.();
  }

  function check(): void {
    pending = null;
    if (stopped) return;
    const s = opts.snapshot();
    if (wholeKey(s) === lastWhole) return;
    if (markingsKey(s) !== lastMarkings) {
      const wait = lastWriteAt + burstMs - now();
      if (wait <= 0) {
        if (later !== null) {
          clearTimeout(later);
          later = null;
        }
        write(s);
      } else {
        // Inside a burst: the write waits out the rest of it, or comes sooner than a view's would.
        if (later !== null) clearTimeout(later);
        later = null;
        schedule(wait);
      }
      return;
    }
    schedule(viewDelayMs);
  }

  // The delayed half: whatever the state is by now, written if it still differs.
  function settle(): void {
    const s = opts.snapshot();
    if (wholeKey(s) !== lastWhole) write(s);
  }

  function flush(): void {
    if (pending !== null) {
      clearImmediate(pending);
      pending = null;
    }
    if (later !== null) {
      clearTimeout(later);
      later = null;
    }
    const s = opts.snapshot();
    if (wholeKey(s) !== lastWhole) write(s);
  }

  return {
    touch() {
      if (stopped || pending !== null) return;
      pending = setImmediate(check);
    },
    flush,
    stop() {
      if (stopped) return;
      flush();
      stopped = true;
    },
  };
}
