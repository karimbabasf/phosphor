// What the window loads at boot, and what it fetches only when a screen needs it.
//
// The QR libraries, the trade screen with its chart engine, and the first run are fetched the
// first time a screen that uses them opens (ui/core/lazy.js), not with the window: together
// they were over half of the script every window fetched at boot (R5, 2026-09-23).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const UI = new URL('../../ui/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, UI), 'utf8');
const HTML = read('index.html');
const LAZY = read('core/lazy.js');

test('index.html fetches no QR library, no chart, no trade screen and no first run at boot', () => {
  for (const late of ['vendor/qrcode.js', 'vendor/jsqr.js', 'screens/trade.js', 'screens/firstrun.js', 'chart/chart.js', 'chart/labels.js', 'chart/mini.js', 'chart/trade-overlay.js']) {
    assert.equal(HTML.includes(`src="./${late}"`), false, `${late} still loads with the window`);
    assert.ok(LAZY.includes(`'./${late}'`), `${late} is in no late bundle`);
  }
  const at = (src: string) => HTML.indexOf(`<script src="./${src}" defer></script>`);
  assert.ok(at('core/lazy.js') > 0, 'the loader is not in the window');
  assert.ok(at('core/lazy.js') < at('screens/lock.js') && at('core/lazy.js') < at('app.js'), 'the stand-ins arrive after the screens that call them');
  assert.match(read('screens/netpick.js'), /Promise\.all\(\[load\(\), lazy \? lazy\.load\('qr'\) : null\]\)/, 'an address can be drawn before its QR libraries are in');
  assert.match(read('screens/shell.js'), /var NEEDS = \{ pro: 'trade', vault: 'firstrun' \};/);
});

/* ---------- the loader, run ---------- */

function loader() {
  const scripts: Any[] = [];
  const attrs: Record<string, string> = {};
  const firstrun: Any = { hidden: true };
  const calls: string[] = [];
  const doc: Any = {
    createElement: () => ({}),
    head: { appendChild: (node: Any) => { scripts.push(node); } },
    body: { setAttribute: (name: string, value: string) => { attrs[name] = value; } },
    getElementById: (id: string) => (id === 'screen-firstrun' ? firstrun : null),
  };
  const win: Any = {
    document: doc,
    console: { error: () => {} },
    PhosphorTheme: { repaint: () => calls.push('repaint') },
  };
  win.window = win;
  const sandbox: Any = { window: win, document: doc, console: win.console, Promise };
  createContext(sandbox);
  runInContext(LAZY, sandbox, { filename: 'ui/core/lazy.js' });
  return { win, scripts, attrs, firstrun, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a bundle loads once, in order, and resolves only when every file has run', async () => {
  const { win, scripts } = loader();
  const qr = win.PhosphorLazy.load('qr');
  assert.equal(win.PhosphorLazy.load('qr'), qr, 'a second ask fetched the bundle again');
  assert.deepEqual(scripts.map((s) => s.src), ['./vendor/qrcode.js', './vendor/jsqr.js']);
  assert.ok(scripts.every((s) => s.async === false), 'the files could run out of order');
  let done: unknown = null;
  qr.then((ok: unknown) => { done = ok; });
  scripts[0].onload();
  await settle();
  assert.equal(done, null, 'resolved before the second file ran');
  scripts[1].onload();
  await settle();
  assert.equal(done, true);
  assert.equal(await win.PhosphorLazy.load('nothing'), false);
});

test('a file that fails resolves false rather than hanging the screen that asked', async () => {
  const { win, scripts } = loader();
  const qr = win.PhosphorLazy.load('qr');
  scripts[0].onload();
  scripts[1].onerror();
  assert.equal(await qr, false);
});

test('Trade boots when its bundle arrives, and the chart is told the theme it missed', async () => {
  const { win, scripts, calls } = loader();
  assert.equal(typeof win.PhosphorTrade.boot, 'function', 'app.js would throw booting a screen that is not loaded');
  const trade = win.PhosphorLazy.load('trade');
  win.PhosphorTrade = { boot: () => calls.push('trade.boot') };
  for (const s of scripts) s.onload();
  assert.equal(await trade, true);
  assert.deepEqual(calls, ['trade.boot', 'repaint']);
});

test('the first run opens over a blank page while its script is on the way, then hands over', async () => {
  const { win, scripts, attrs, firstrun } = loader();
  const opened: string[] = [];
  win.PhosphorFirstRun.boot();
  win.PhosphorFirstRun.open();
  assert.equal(attrs['data-firstrun'], 'true', 'the empty window shows through while the first run loads');
  assert.equal(attrs['data-locked'], 'true');
  assert.equal(firstrun.hidden, false);
  assert.deepEqual(scripts.map((s) => s.src), ['./screens/firstrun.js']);
  win.PhosphorFirstRun = { boot: () => opened.push('boot'), open: () => opened.push('open') };
  scripts[0].onload();
  await settle();
  await settle();
  assert.deepEqual(opened, ['boot', 'open']);
});
