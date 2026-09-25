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

import { RECEIVE_NETWORKS, SPEND_NETWORKS } from '../../src/rails/intents-address.ts';

const DIR = fileURLToPath(new URL('../../ui/logos/', import.meta.url));
const AGENT_DIR = path.join(DIR, 'agents');
const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');

// The lists as the window sees them: the real marks.js, run the way the *-ui tests run it.
function marks(): Record<string, any> {
  const sandbox: Record<string, any> = { window: {} };
  createContext(sandbox);
  runInContext(MARKS, sandbox, { filename: 'ui/design/marks.js' });
  return sandbox.window.PhosphorMarks;
}

function listed(): string[] {
  return Array.from(marks().LOGOS as string[]);
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.svg')).sort();
const agentFiles = readdirSync(AGENT_DIR).filter((name) => name.endsWith('.svg')).sort();
// Every file the window can load, as [the name a failure prints, its path].
const everyFile: Array<[string, string]> = [
  ...files.map((name): [string, string] => [name, path.join(DIR, name)]),
  ...agentFiles.map((name): [string, string] => [`agents/${name}`, path.join(AGENT_DIR, name)]),
];

test('every listed ticker has its file in ui/logos', () => {
  const missing = listed().filter((ticker) => !files.includes(`${ticker.toLowerCase()}.svg`));
  assert.deepEqual(missing, []);
});

test('every file in ui/logos is listed, so none ships without being drawn', () => {
  const names = new Set(listed().map((ticker) => `${ticker.toLowerCase()}.svg`));
  assert.deepEqual(files.filter((name) => !names.has(name)), []);
});

// Karim, 2026-09-23: the agent list drew monograms. Every agent the catalog names draws a real
// logo from ui/logos/agents, except Another agent, which is any client and draws the link icon.
test('every agent in the catalog has its logo in ui/logos/agents, and every file there is drawn', () => {
  const named = marks().AGENT_LOGOS as Record<string, string>;
  const ids = ['claude', 'codex', 'hermes', 'grok', 'desktop'];
  assert.deepEqual(ids.filter((id) => !Object.prototype.hasOwnProperty.call(named, id)), []);
  const wanted = new Set(Object.values(named).map((file) => `${file}.svg`));
  assert.deepEqual([...wanted].filter((name) => !agentFiles.includes(name)), []);
  assert.deepEqual(agentFiles.filter((name) => !wanted.has(name)), []);
});

// Karim, 2026-09-23: WBTC drew a generic target in the balances panel. The wrapped bitcoins the
// app names to people (src/proposals/view.ts: "WBTC, nBTC or cbBTC") each draw a real logo.
test('the wrapped bitcoins draw a real logo, never the monogram', () => {
  const have = new Set(listed());
  assert.deepEqual(['WBTC', 'CBBTC', 'NBTC', 'HEMIBTC', 'XBTC'].filter((ticker) => !have.has(ticker)), []);
});

// A deposit tile draws the chain's mark (src/rails/intents-address.ts `mark`), so every network
// the app offers money in or out on has its logo here.
test('every network tile has its logo', () => {
  const have = new Set(listed());
  const marks = [...RECEIVE_NETWORKS, ...SPEND_NETWORKS].map((network) => network.mark.toUpperCase());
  assert.deepEqual([...new Set(marks)].filter((mark) => !have.has(mark)), []);
});

// A wrapped or bridged ticker wears the file of the coin it carries (ATTRIBUTION.md), byte for byte,
// so a fix to the coin's file cannot leave its copies behind.
const COPIES: Record<string, string[]> = {
  'eth.svg': ['weth.svg'],
  'btc.svg': ['cbbtc.svg', 'hemibtc.svg', 'xbtc.svg', 'nbtc.svg', 'btc(omni).svg'],
  'usdt.svg': ['usdt0.svg'],
  'usdc.svg': ['usdc.e.svg', 'usdcx.svg'],
  'dai.svg': ['xdai.svg'],
  'xrp.svg': ['fxrp.svg'],
};

test('a wrapped ticker\'s file is its coin\'s file, byte for byte', () => {
  const drifted: string[] = [];
  for (const [coin, copies] of Object.entries(COPIES)) {
    const original = readFileSync(path.join(DIR, coin));
    for (const copy of copies) if (!readFileSync(path.join(DIR, copy)).equals(original)) drifted.push(copy);
  }
  assert.deepEqual(drifted, []);
});

// Every mark sits in the middle three quarters of its box, the way the web3icons files draw it,
// so a row of logos reads at one size. A file drawn edge to edge (a disc from another set, a
// square tile cut to a disc) widens its viewBox by a sixth of the drawing on each side.
test('every file keeps the clear edge a logo row is sized by', () => {
  const off: string[] = [];
  for (const [name, file] of everyFile) {
    const box = /viewBox="([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    const [x, y, w, h] = box.split(/[\s,]+/).map(Number);
    if (box === '0 0 24 24' || name === 'hype.svg') continue;
    const inner = (w as number) * 0.75;
    const edge = ((w as number) - inner) / 2;
    if (w !== h || Math.abs((x as number) + edge) > 0.01 || Math.abs((y as number) + edge) > 0.01) off.push(`${name}: ${box}`);
  }
  assert.deepEqual(off, []);
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
  for (const [name, file] of everyFile) {
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
