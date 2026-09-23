// The logo files the wallet draws beside its rows. ui/design/marks.js lists every ticker that has a
// file in ui/logos, and logo() only asks the server for a listed one, so the list and the folder
// have to agree in both directions: a listed ticker with no file draws a broken image until the
// fallback catches it, and a file nobody lists is weight the app ships and never shows. The files
// come from icon packages, so the last test is what stands between a package's next version and
// the window: nothing in any of them may run code or reach past the file.
//
// Run: node --test tests/unit/logo-files.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const DIR = fileURLToPath(new URL('../../ui/logos/', import.meta.url));
const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');

// The list as the window sees it: the real marks.js, run the way the *-ui tests run it.
function listed(): string[] {
  const sandbox: Record<string, any> = { window: {} };
  createContext(sandbox);
  runInContext(MARKS, sandbox, { filename: 'ui/design/marks.js' });
  return Array.from(sandbox.window.PhosphorMarks.LOGOS as string[]);
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.svg')).sort();

test('every listed ticker has its file in ui/logos', () => {
  const missing = listed().filter((ticker) => !files.includes(`${ticker.toLowerCase()}.svg`));
  assert.deepEqual(missing, []);
});

test('every file in ui/logos is listed, so none ships without being drawn', () => {
  const names = new Set(listed().map((ticker) => `${ticker.toLowerCase()}.svg`));
  assert.deepEqual(files.filter((name) => !names.has(name)), []);
});

// A reference that starts with # stays inside the file (a gradient, a clip path, a reused
// shape), and it is the only kind a logo needs. Anything else is a way out.
const RULES: Array<[string, RegExp]> = [
  ['a script element', /<script\b/i],
  ['an on* event attribute', /[\s/]on[a-z]+\s*=/i],
  ['a foreignObject', /<foreignObject\b/i],
  ['an image element', /<image\b/i],
  ['an href that leaves the file', /\b(?:xlink:)?href\s*=\s*(?:"(?!#)|'(?!#)|(?!["'#]))/i],
  ['a url() that leaves the file', /url\(\s*(?:"(?!#)|'(?!#)|(?!["'#\s]))/i],
  ['an @import', /@import\b/i],
  ['a DOCTYPE or an entity', /<!(?:DOCTYPE|ENTITY)\b/i],
];

test('no logo file carries anything that could run or reach outside it', () => {
  const found: string[] = [];
  for (const name of files) {
    const file = path.join(DIR, name);
    const text = readFileSync(file, 'utf8');
    for (const [what, pattern] of RULES) if (pattern.test(text)) found.push(`${name}: ${what}`);
    if (statSync(file).size > 40 * 1024) found.push(`${name}: over 40 KB`);
  }
  assert.deepEqual(found, []);
});

test('the rules catch what they name and pass a reference inside the file', () => {
  const caught = (svg: string) => RULES.filter(([, pattern]) => pattern.test(svg)).map(([what]) => what);
  assert.deepEqual(caught('<svg><path fill="url(#a)"/><use href="#b"/><use xlink:href=\'#c\'/></svg>'), []);
  assert.deepEqual(caught('<svg><path fill="url(\'#a\')"/></svg>'), []);
  assert.deepEqual(caught('<svg><script>alert(1)</script></svg>'), ['a script element']);
  assert.deepEqual(caught('<svg onload="go()"/>'), ['an on* event attribute']);
  assert.deepEqual(caught('<svg><foreignObject/></svg>'), ['a foreignObject']);
  assert.deepEqual(caught('<svg><image/></svg>'), ['an image element']);
  assert.deepEqual(caught('<svg><use xlink:href="https://x.test/a.svg#b"/></svg>'), ['an href that leaves the file']);
  assert.deepEqual(caught('<svg><path fill="url(https://x.test/a)"/></svg>'), ['a url() that leaves the file']);
  assert.deepEqual(caught('<svg><style>@import "x.css";</style></svg>'), ['an @import']);
  assert.deepEqual(caught('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>'), ['a DOCTYPE or an entity']);
});
