// The scan half of the button inventory: every place a button is built, grouped into families,
// with where its words come from, whether it can wait or be disabled, and which of its states
// the stylesheets draw. Pure functions over the files on disk, so a test can hold the window's
// buttons to the floor without a browser (tests/unit/button-inventory.test.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export type Site = {
  file: string;
  line: number;
  family: string; // the class string, or the expression when it is not a literal
  label: string; // where the words come from
  pending: string | null;
  disables: boolean;
};

export type Family = {
  family: string;
  sites: Site[];
  states: Record<string, string>; // state -> the rule that draws it, or '' when none
  pending: boolean;
  disables: boolean;
};

const STATE_PSEUDO: Record<string, RegExp[]> = {
  hover: [/:hover/],
  active: [/:active/],
  disabled: [/:disabled/, /\[disabled\]/],
  focus: [/:focus-visible/],
  pending: [/\[data-pending/],
  on: [/\[aria-(selected|pressed|checked|current|expanded)="true"\]/, /\[data-(chosen|armed|open)="true"\]/],
};

function lines(file: string): string[] {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
}

function uiFiles(): string[] {
  const out: string[] = ['ui/index.html'];
  for (const dir of ['ui', 'ui/screens']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith('.js')) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

/* The words on a button, read from the lines that follow its construction: a .btn-label span,
   a bare span, the third argument of dom.el, textContent, or an aria-label for an icon-only
   control. The window is bounded by the next button so one site never reads another's label. */
function labelOf(src: string[], from: number): { label: string; pending: string | null; disables: boolean } {
  let label = '';
  let pending: string | null = null;
  let disables = false;
  const icons: string[] = [];
  for (let i = from; i < Math.min(src.length, from + 14); i++) {
    const line = src[i] ?? '';
    if (i > from && /el\('button'|createElement\('button'\)|<button/.test(line)) break;
    const lit = line.match(/'btn-label', *'([^']*)'/);
    const arg = line.match(/'btn-label', *([A-Za-z_$][\w$.]*)/);
    const span = line.match(/el\('span', *'[^']*', *'([^']*)'\)/);
    const spanVar = line.match(/el\('span', *'[^']*', *([A-Za-z_$][\w$.]*)/);
    const text = line.match(/textContent *= *'([^']*)'/);
    const aria = line.match(/aria-label', *'([^']*)'/);
    const icon = line.match(/icon\('([a-z-]+)'|icons\.svg\('([a-z-]+)'|glyph\('([a-z-]+)'/);
    const wait = line.match(/data-pending-label', *'([^']*)'/);
    if (wait && pending === null) pending = wait[1] ?? '';
    if (/\.disabled *=|'disabled', *(true|[a-z])/.test(line)) disables = true;
    if (label === '') {
      if (lit) label = `"${lit[1]}"`;
      else if (arg) label = `${arg[1]} (argument)`;
      else if (span) label = `"${span[1]}"`;
      else if (spanVar) label = `${spanVar[1]} (argument)`;
      else if (text) label = `"${text[1]}"`;
    }
    if (icon) icons.push(icon[1] ?? icon[2] ?? icon[3] ?? '');
    if (aria && label === '') label = `aria-label "${aria[1]}"`;
  }
  if (label === '' && icons.length) label = `icon ${icons.join(', ')}`;
  return { label: label || 'built by the caller', pending, disables };
}

export function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of uiFiles()) {
    const src = lines(file);
    src.forEach((line, i) => {
      const n = i + 1;
      // index.html: the markup itself.
      const markup = line.match(/<button class="([^"]+)"/);
      if (markup) {
        const inner = src.slice(i, i + 4).join(' ');
        const text = inner.match(/<span[^>]*>([^<]+)<\/span>/) ?? inner.match(/>([^<>]+)<\/button>/);
        const word = text ? text[1]?.trim() ?? '' : '';
        sites.push({ file, line: n, family: markup[1] ?? '', label: word ? `"${word}"` : 'icon', pending: null, disables: false });
        return;
      }
      // The three button() helpers build one button from their arguments; their call sites
      // are the families, so the definition itself is not a site.
      if (/function button\(/.test(src[i - 1] ?? '')) return;
      const lit = line.match(/el\('button', *'([^']*)'(?:, *([^)]*))?\)/);
      if (lit) {
        const read = labelOf(src, i);
        const third = lit[2] ? lit[2].trim() : '';
        const label = third
          ? (third.startsWith("'") ? (third.length > 2 ? `"${third.slice(1, -1)}"` : 'written later') : `${third} (argument)`)
          : read.label;
        sites.push({ file, line: n, family: lit[1] ?? '', label, pending: read.pending, disables: read.disables });
        return;
      }
      const dyn = line.match(/el\('button', *([^)]+)\)/);
      if (dyn) {
        const read = labelOf(src, i);
        const expr = dyn[1]?.trim() ?? '';
        // A ternary between two literals is two families, drawn with the same label.
        const pair = expr.match(/^[^?]+\? *'([^']+)' *: *'([^']+)'$/);
        for (const family of pair ? [pair[1] ?? '', pair[2] ?? ''] : [expr]) {
          sites.push({ file, line: n, family, label: read.label, pending: read.pending, disables: read.disables });
        }
        return;
      }
      if (/createElement\('button'\)/.test(line)) {
        const cls = src.slice(i, i + 4).join(' ').match(/className = '([^']+)'/);
        const read = labelOf(src, i);
        sites.push({ file, line: n, family: cls?.[1] ?? '?', label: read.label, pending: read.pending, disables: read.disables });
      }
    });
    // A screen's button() helper builds one button from its arguments, so its call sites are
    // the families and the definition is not a site. Three shapes exist: a fixed class in the
    // body (receipts.js), the class as the first argument (agent.js), and a kind added to 'btn '
    // (netpick.js, vault.js). The body's first dom.el('button', ...) says which.
    const helper = src.findIndex((l) => /function button\(/.test(l));
    if (helper >= 0) {
      const body = src.slice(helper, helper + 3).join(' ');
      const fixed = body.match(/el\('button', *'([^']+)'\)/);
      const classFirst = /el\('button', *className\)/.test(body);
      src.forEach((line, i) => {
        if (i === helper) return;
        const call = line.match(/\bbutton\('([^']*)'(?:, *('([^']*)'|[^,)]+))?(?:, *('([^']*)'|[^,)]+))?(?:, *('([^']*)'|[^,)]+))?\)/);
        if (!call) return;
        const first = call[1] ?? '';
        const second = call[3] ?? null;
        const third = call[5] ?? null;
        const fourth = call[7] ?? null;
        if (fixed) {
          sites.push({ file, line: i + 1, family: fixed[1] ?? '', label: `"${first}"`, pending: null, disables: /\.disabled *=/.test(body) });
        } else if (classFirst) {
          sites.push({ file, line: i + 1, family: first, label: second !== null ? `"${second}"` : 'label (argument)', pending: fourth, disables: false });
        } else {
          sites.push({ file, line: i + 1, family: `btn ${second ?? 'btn-ghost'}`, label: `"${first}"`, pending: third, disables: false });
        }
      });
    }
  }
  return sites.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file.localeCompare(y.file)));
}

/* One selector per rule, with the at-rule it sits in flattened away: enough to ask whether
   a class has a rule for a pseudo state anywhere in the stylesheets. */
function cssSelectors(): string[] {
  const out: string[] = [];
  const dir = path.join(ROOT, 'ui/design');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.css')) continue;
    const css = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    let buf = '';
    for (const ch of css) {
      if (ch === '{') {
        const sel = buf.trim();
        if (!sel.startsWith('@')) out.push(sel);
        depth++;
        buf = '';
      } else if (ch === '}') {
        depth--;
        buf = '';
      } else buf += ch;
    }
    if (depth !== 0) throw new Error(`${name}: braces do not balance`);
  }
  return out;
}

function statesOf(family: string, selectors: string[]): Record<string, string> {
  const tokens = family.split(/\s+/).filter((t) => /^[a-z][\w-]*$/.test(t));
  const out: Record<string, string> = { rest: '', hover: '', active: '', disabled: '', focus: '', pending: '', on: '' };
  for (const sel of selectors) {
    for (const token of tokens) {
      const hit = new RegExp(`(^|[\\s>+~(])\\.${token}(?![\\w-])`);
      if (!hit.test(sel)) continue;
      if (out.rest === '' && !/[:\[]/.test(sel.replace(/\[data-tone[^\]]*\]/g, ''))) out.rest = sel;
      for (const [state, tests] of Object.entries(STATE_PSEUDO)) {
        if (out[state] === '' && tests.some((t) => t.test(sel))) out[state] = sel;
      }
    }
  }
  // Two rules cover every button without naming its class: the focus ring in reset.css and
  // the waiting face in components.css.
  if (out.focus === '') out.focus = ':focus-visible (reset.css, every element)';
  if (out.pending === '') out.pending = '[data-pending="true"] (components.css, every element)';
  return out;
}

export function families(sites: Site[]): Family[] {
  const selectors = cssSelectors();
  const byClass = new Map<string, Site[]>();
  for (const s of sites) {
    const list = byClass.get(s.family) ?? [];
    list.push(s);
    byClass.set(s.family, list);
  }
  return [...byClass.entries()].map(([family, list]) => ({
    family,
    sites: list,
    states: statesOf(family, selectors),
    pending: list.some((s) => s.pending !== null),
    disables: list.some((s) => s.disables),
  })).sort((a, b) => a.family.localeCompare(b.family));
}

