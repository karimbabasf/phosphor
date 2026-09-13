// The loader over <dataDir>/indicators/*.json and *.pine.
//
// Only the human writes in that directory. The app reads it at boot and whenever the agent
// asks for the indicator list, re-parsing a file only when its mtime or size has moved, and
// keeps one map from slug to compiled spec. The slug is the filename at scan time and nothing
// else: an agent's 'custom:<slug>' is a map lookup, never a path join, so a slug can name a
// file in this directory and cannot name anything anywhere else.
//
// Nothing here throws. A file that cannot be read, parsed, translated or compiled becomes a
// problem with its filename and, where the translator knows it, the line, and the rest of
// the directory loads as if it were not there.

import fs from 'node:fs';
import path from 'node:path';

import type { IndicatorSpec } from '../indicators.ts';
import { customIndicatorSchema } from './schema.ts';
import { compile } from './evaluate.ts';
import { translatePine } from './pine.ts';

export const SLUG_RE = /^[a-z0-9-]{1,32}$/;

// Large enough for any indicator anyone would write by hand, small enough that a file the
// size of a video cannot be handed to JSON.parse.
export const FILE_CAP_BYTES = 256 * 1024;

// A miss in get() rescans the directory so a file dropped in a moment ago is found, but a
// chart holding a type whose file was deleted asks on every render, and a readdir per frame
// is not the answer. Between rescans a miss is a miss.
const RESCAN_GAP_MS = 2000;

export type LoaderProblem = { file: string; line?: number; message: string };

export type CustomIndicators = {
  refresh(): { specs: IndicatorSpec[]; problems: LoaderProblem[] };
  specs(): IndicatorSpec[];
  get(slug: string): IndicatorSpec | null;
};

type Entry = { mtimeMs: number; size: number; spec: IndicatorSpec | null; problems: LoaderProblem[] };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// JSON.parse quotes the bytes around the fault in its message, and that message goes to the
// agent as a problem. The position is what a human needs to fix the file; the bytes are the
// file's own business, and on the day the file is something else entirely they are a secret.
function jsonProblem(err: unknown): string {
  const where = /at position \d+( \(line \d+ column \d+\))?/.exec(message(err));
  return where === null ? 'not valid JSON' : `not valid JSON ${where[0]}`;
}

export function createCustomIndicators(dir: string, now: () => number = Date.now): CustomIndicators {
  const entries = new Map<string, Entry>();
  let bySlug = new Map<string, IndicatorSpec>();
  let problems: LoaderProblem[] = [];
  let lastScan = 0;

  function load(file: string, slug: string, st: fs.Stats): Entry {
    const base = { mtimeMs: st.mtimeMs, size: st.size };
    const fail = (line: number | undefined, text: string): Entry => ({
      ...base,
      spec: null,
      problems: [line === undefined ? { file, message: text } : { file, line, message: text }],
    });
    if (st.size > FILE_CAP_BYTES) return fail(undefined, `the file is ${Math.round(st.size / 1024)} KB and the cap is ${FILE_CAP_BYTES / 1024} KB`);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      return fail(undefined, `cannot read the file: ${message(err)}`);
    }
    try {
      if (file.endsWith('.pine')) {
        const out = translatePine(text);
        if (!out.ok) return fail(out.line, out.message);
        return {
          ...base,
          spec: compile(out.indicator, slug),
          problems: out.ignored.map((note) => ({ file, message: `ignored: ${note}` })),
        };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        return fail(undefined, jsonProblem(err));
      }
      const parsed = customIndicatorSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
        return fail(undefined, `${where}${issue?.message ?? 'does not validate'}`);
      }
      return { ...base, spec: compile(parsed.data, slug), problems: [] };
    } catch (err) {
      return fail(undefined, `could not load: ${message(err)}`);
    }
  }

  function scan(): void {
    lastScan = now();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      entries.clear();
      bySlug = new Map();
      problems = [];
      return;
    }
    names.sort();
    const seen = new Set<string>();
    const taken = new Map<string, string>();
    const nextProblems: LoaderProblem[] = [];
    const nextBySlug = new Map<string, IndicatorSpec>();
    for (const file of names) {
      const ext = path.extname(file);
      if (ext !== '.json' && ext !== '.pine') continue;
      // lstat, not stat: a link in this folder is a file somewhere else, and "somewhere else"
      // is the one thing a slug must never reach. It is reported rather than skipped so the
      // human learns why the indicator they linked in is not on the list.
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(dir, file));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        nextProblems.push({ file, message: 'a symbolic link is not read; copy the file into this folder instead' });
        continue;
      }
      if (!st.isFile()) continue;
      seen.add(file);
      const slug = file.slice(0, -ext.length);
      if (!SLUG_RE.test(slug)) {
        nextProblems.push({ file, message: 'the name before the extension must be 1 to 32 lower-case letters, digits or dashes' });
        continue;
      }
      const other = taken.get(slug);
      if (other !== undefined) {
        nextProblems.push({ file, message: `the slug '${slug}' is already taken by ${other}` });
        continue;
      }
      taken.set(slug, file);
      let entry = entries.get(file);
      if (entry === undefined || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        entry = load(file, slug, st);
        entries.set(file, entry);
      }
      nextProblems.push(...entry.problems);
      if (entry.spec !== null) nextBySlug.set(slug, entry.spec);
    }
    for (const file of [...entries.keys()]) if (!seen.has(file)) entries.delete(file);
    bySlug = nextBySlug;
    problems = nextProblems;
  }

  function specs(): IndicatorSpec[] {
    return [...bySlug.keys()].sort().map((slug) => bySlug.get(slug) as IndicatorSpec);
  }

  scan();

  return {
    refresh() {
      scan();
      return { specs: specs(), problems: problems.slice() };
    },
    specs,
    get(slug) {
      const key = slug.startsWith('custom:') ? slug.slice('custom:'.length) : slug;
      if (!SLUG_RE.test(key)) return null;
      const have = bySlug.get(key);
      if (have !== undefined) return have;
      if (now() - lastScan < RESCAN_GAP_MS) return null;
      scan();
      return bySlug.get(key) ?? null;
    },
  };
}
