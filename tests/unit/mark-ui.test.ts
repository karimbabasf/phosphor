// The mark: brand/phosphor-mark.svg, cut into the five pieces its motion addresses, and the one
// kind of motion it has. The window draws every mark from one <symbol> in ui/index.html, so the
// geometry is checked against the brand file here, and the motion in ui/design/mark.css is
// checked for what it may touch (a piece's light and heat, never its size) and when it runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const HTML = read('../../ui/index.html');
const MARK_CSS = read('../../ui/design/mark.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const BRAND = read('../../brand/phosphor-mark.svg');
const SHELL = read('../../ui/screens/shell.js');

const squash = (d: string) => d.replace(/\s+/g, ' ').trim();

function symbol(): string {
  const start = HTML.indexOf('<symbol id="phosphor-mark"');
  assert.ok(start >= 0, 'index.html has no mark symbol');
  return HTML.slice(start, HTML.indexOf('</symbol>', start));
}

function piece(n: number): { d: string; style: string; tag: string } {
  const tag = symbol().match(new RegExp(`<path class="m${n}"[^>]*/>`))?.[0] ?? '';
  assert.ok(tag, `the symbol has no m${n}`);
  return { tag, d: tag.match(/ d="([^"]+)"/)?.[1] ?? '', style: tag.match(/style="([^"]+)"/)?.[1] ?? '' };
}

// The brand file is one path of five subpaths: the front slab, its cut, then the slabs behind.
const SUBPATHS = (BRAND.match(/ d="([^"]+)"/)?.[1] ?? '').split(/(?=M)/).map(squash);

test('the symbol is the brand mark, cut into five pieces from the back slab to the cut', () => {
  assert.equal(SUBPATHS.length, 5, 'brand/phosphor-mark.svg is not the five-subpath mark');
  assert.match(symbol(), /viewBox="0 0 59\.46 64\.75"/);
  assert.equal((symbol().match(/<path /g) ?? []).length, 5);
  const [front, cut, third, second, back] = SUBPATHS;
  assert.equal(squash(piece(1).d), back);
  assert.equal(squash(piece(2).d), second);
  assert.equal(squash(piece(3).d), third);
  assert.equal(squash(piece(4).d), `${front} ${cut}`, 'the front slab lost its cut');
  assert.match(piece(4).tag, /fill-rule="evenodd"/, 'the cut would fill in');
  assert.equal(squash(piece(5).d), cut);
});

test('each piece reads its own light and heat, and the cut is dark at rest', () => {
  for (let n = 1; n <= 5; n += 1) {
    const { style } = piece(n);
    assert.match(style, new RegExp(`fill-opacity: var\\(--m${n}, ${n === 5 ? 0 : 1}\\)`), `m${n} does not read --m${n}`);
    assert.match(style, new RegExp(`calc\\(var\\(--h${n}, 0\\) \\* 100%\\)`), `m${n} does not read --h${n}`);
  }
});

test('the window draws the new mark everywhere: the bar, the tab icon, and nothing of the traced path', () => {
  assert.match(HTML, /<svg class="mark brand-mark"[^>]*><use href="#phosphor-mark"\/><\/svg>/);
  const icon = HTML.match(/<link rel="icon" href="([^"]+)">/)?.[1] ?? '';
  assert.ok(icon.includes("viewBox='0 0 59.46 64.75'") && icon.includes('M31.63 64.75'), 'the tab icon is not the brand mark');
  assert.equal(HTML.includes('58.05'), false, 'the old traced path is still in the window');
});

test('the splash and the update window draw the brand mark too', () => {
  const brand = squash(BRAND.match(/ d="([^"]+)"/)?.[1] ?? '');
  for (const page of ['index.html', 'update.html']) {
    const html = read(`../../src-tauri/frontend/${page}`);
    const svg = html.match(/<svg class="mark" viewBox="([^"]+)"[^>]*>\s*<path fill="currentColor" fill-rule="evenodd" d="([^"]+)"\/>/);
    assert.ok(svg, `${page} does not draw the mark as one evenodd path`);
    assert.equal(svg?.[1], '0 0 59.46 64.75');
    assert.equal(squash(svg?.[2] ?? ''), brand, `${page} draws a different mark`);
  }
});

/* Every @keyframes body, found by matching braces: some are one line, some are many. */
function keyframes(): string[] {
  const out: string[] = [];
  let at = MARK_CSS.indexOf('@keyframes');
  while (at >= 0) {
    let i = MARK_CSS.indexOf('{', at);
    const start = i + 1;
    let depth = 1;
    while (depth > 0) {
      i += 1;
      if (MARK_CSS[i] === '{') depth += 1;
      else if (MARK_CSS[i] === '}') depth -= 1;
    }
    out.push(MARK_CSS.slice(start, i));
    at = MARK_CSS.indexOf('@keyframes', i);
  }
  return out;
}

test('the motion registers each number it moves and moves nothing else', () => {
  for (const name of ['--m1', '--m2', '--m3', '--m4', '--m5', '--h1', '--h2', '--h3', '--h4', '--h5']) {
    assert.match(MARK_CSS, new RegExp(`@property ${name} \\{ syntax: "<number>"; inherits: true;`), `${name} is not registered, so it would jump rather than fade`);
  }
  const frames = keyframes().join('\n');
  assert.ok(frames.length > 0);
  const declared = [...frames.matchAll(/([a-z-][\w-]*)\s*:/g)].map((m) => m[1]);
  for (const prop of declared) {
    assert.ok(/^--[mh][1-5]$/.test(prop) || prop === 'animation-timing-function', `a keyframe moves ${prop}`);
  }
  assert.doesNotMatch(MARK_CSS, /transform|scale\(|width:|height:/, 'the mark changes size');
});

test('it traces on at boot, scans while the agent works, and flashes once when it is done', () => {
  assert.match(HTML, /^<!doctype html>\n<html lang="en" data-boot>/, 'the document is not served in its boot state');
  assert.ok(SHELL.includes("root.removeAttribute('data-boot')"), 'the trace-on could replay');
  const rule = (selector: string) => MARK_CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`))?.[1] ?? '';
  const boot = rule('html[data-boot] svg.mark');
  assert.match(boot, /mark-in-1 440ms var\(--ease-out\) 60ms both/);
  assert.match(boot, /mark-in-4 440ms var\(--ease-out\) 330ms both/, 'the trace-on runs past about 700 ms');
  const working = rule('svg.mark[data-state="working"],\nhtml[data-agent="working"] .topbar svg.mark');
  for (let n = 1; n <= 5; n += 1) assert.match(working, new RegExp(`mark-scan-${n} 1400ms linear \\d+ms infinite`));
  const done = rule('svg.mark[data-state="done"],\nhtml[data-agent="done"] .topbar svg.mark');
  assert.match(done, /mark-flash 2400ms/);
});

test('under reduced motion the mark stands still, in every state', () => {
  const reduced = MARK_CSS.slice(MARK_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const selector of ['svg.mark,', 'html[data-boot] svg.mark,', 'svg.mark[data-state="working"],', 'svg.mark[data-state="done"],', 'html[data-agent] .topbar svg.mark']) {
    assert.ok(reduced.includes(selector), `${selector} still moves under reduced motion`);
  }
  assert.match(reduced, /animation: none;/);
});
