// Every destination this window can send somebody to comes off one list.
//
// ui/core/links.js holds the list and, since this file, it is also the only
// place in ui/ that writes an href. That second half is the point: three screens
// used to build their own anchor and check the url their own way (the send card
// on an exact host match, the receipt on the scheme alone, the fills table on
// nothing at all), and the audit that found them found them one at a time. A
// list of guarded call sites would have the same weakness, because the next
// sibling is the one nobody adds to the list.
//
// So the shape is checked instead of the sites: a raw href write anywhere in ui/
// fails this test, whatever it is guarded by. tauri.conf.json sets "csp": null,
// so a javascript: href written here would run in the page origin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const UI = fileURLToPath(new URL('../../ui/', import.meta.url));

function scripts(dir: string, at = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, at)).sort()) {
    const rel = at === '' ? name : at + '/' + name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...scripts(dir, rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/* The four ways a string in this window becomes somewhere it goes. */
const WRITES = [/\.href\s*=[^=]/, /\bhref\s*:/, /window\.open\s*\(/, /setAttribute\(\s*['"]href['"]/];

type Site = { file: string; code: string; count: number; why: 'links' | 'fragment' };

/* Every line in ui/ that writes a destination, and why it may.
   'links' is the one writer, which refuses anything off the list before it
   writes. 'fragment' is a reference into this same document (an SVG sprite) and
   can never be a url. Nothing else belongs here: a fourth entry means a screen
   started building its own links again. */
const ALLOWED: Site[] = [
  { file: 'core/dom.js', code: "use.setAttribute('href', '#phosphor-mark');", count: 1, why: 'fragment' },
  { file: 'core/links.js', code: 'anchor.href = safe;', count: 1, why: 'links' },
  { file: 'design/icons.js', code: "use.setAttribute('href', '#i-' + name);", count: 1, why: 'fragment' },
  // The Vault's frozen row draws the bar's own freeze glyph, which index.html holds as a symbol.
  { file: 'screens/vault.js', code: "use.setAttribute('href', '#i-freeze');", count: 1, why: 'fragment' },
];

function found(): Site[] {
  const out = new Map<string, Site>();
  for (const file of scripts(UI)) {
    const source = readFileSync(join(UI, file), 'utf8');
    for (const raw of source.split('\n')) {
      const code = raw.trim();
      if (!WRITES.some((p) => p.test(code))) continue;
      const key = file + '\u0000' + code;
      const seen = out.get(key);
      if (seen) seen.count += 1;
      else out.set(key, { file, code, count: 1, why: 'links' });
    }
  }
  return [...out.values()].sort((a, b) => (a.file + a.code).localeCompare(b.file + b.code));
}

test('ui/ writes an href in one place and the rest of the window asks for it', () => {
  const sites = found();
  const shape = (s: Site): string => s.file + '  ' + s.code + (s.count === 1 ? '' : '  x' + s.count);
  assert.deepEqual(
    sites.map(shape),
    ALLOWED.map(shape),
    'a link site in ui/ is not the one links.js owns. Route it through PhosphorLinks.setHref\n' +
      'or PhosphorLinks.setSiteHref, or, if it is a fragment in this document, add it above.'
  );
});

test('the fragment sites are fragments, not urls', () => {
  for (const site of ALLOWED) {
    if (site.why !== 'fragment') continue;
    assert.match(site.code, /'#/, `${site.file} writes an href that does not start with #`);
  }
});

/* The writer is the check. A screen hands it whatever the server sent and never
   looks at it, so a url off the list has to leave the anchor with no href at
   all: an anchor carrying a stale destination is a link to the wrong place. */
test('the writer refuses anything off the list and leaves no href behind', () => {
  const links = load();
  const anchor = stubAnchor();

  assert.equal(links.setHref(anchor, 'https://sepolia.basescan.org/tx/0xabc'), true);
  assert.equal(anchor.href, 'https://sepolia.basescan.org/tx/0xabc');

  for (const hostile of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//basescan.org/tx/0xabc',
    'http://basescan.org/tx/0xabc',
    'https://basescan.org.evil.com/tx/0xabc',
    'https://evil.com/basescan.org',
    null,
    undefined,
    42,
  ]) {
    assert.equal(links.setHref(anchor, hostile), false, `${String(hostile)} was written`);
    assert.equal(anchor.href, null, `${String(hostile)} left an href on the anchor`);
    assert.equal(anchor.removed, true);
  }

  // The product's own pages are a second, separate list: an explorer is not the
  // terms page and the terms page is not an explorer.
  assert.equal(links.setSiteHref(anchor, 'https://phosphor.money/terms/'), true);
  assert.equal(links.setHref(anchor, 'https://phosphor.money/terms/'), false);
  assert.equal(links.setSiteHref(anchor, 'https://sepolia.basescan.org/tx/0xabc'), false);
  assert.equal(links.setSiteHref(anchor, 'https://phosphor.money.evil.com/terms/'), false);
});

function load(): Record<string, any> {
  const sandbox: Record<string, any> = { window: {}, URL, console };
  createContext(sandbox);
  runInContext(readFileSync(join(UI, 'core/links.js'), 'utf8'), sandbox, { filename: 'ui/core/links.js' });
  return sandbox.window.PhosphorLinks;
}

function stubAnchor(): Record<string, any> {
  return {
    href: null as string | null,
    removed: false,
    setAttribute(name: string, value: string) { if (name === 'href') { this.href = value; this.removed = false; } },
    removeAttribute(name: string) { if (name === 'href') { this.href = null; this.removed = true; } },
  };
}
