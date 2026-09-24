// The top bar: the mark and the name, the mode switch, and the brake. Nothing that reports state.
//
// Karim, 2026-09-14, on the pills, the white mark tile and the outlined red button that used
// to sit there: "they look like ai slop". 2026-09-23, the locked Basic layout: a calm 64 px bar,
// Basic, Pro and Vault at its centre, one quiet freeze control at its end whose confirm step is
// a small in-app panel, and the "No backup", lock-timer and "Live" pills gone from it. The bar
// is static markup in ui/index.html and the shell only writes words and states into it, so the
// contract is read off the files as text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const HTML = read('../../ui/index.html');
const SHELL = read('../../ui/screens/shell.js')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const LAYOUT = read('../../ui/design/layout.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const NOTICE = read('../../ui/design/notice.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const TOKENS = read('../../ui/design/tokens.css');

function bar(): string {
  const start = HTML.indexOf('<header class="topbar" id="topbar">');
  assert.ok(start >= 0, 'the window has no top bar');
  return HTML.slice(start, HTML.indexOf('</header>', start));
}

function end(): string {
  const markup = bar();
  const start = markup.indexOf('<div class="bar-end">');
  assert.ok(start >= 0, 'the bar has no end');
  return markup.slice(start);
}

test('the bar is 64 px tall and holds three things: the brand, the switch, the end', () => {
  assert.match(TOKENS, /--topbar-h:\s*64px;/);
  const markup = bar();
  const brand = markup.indexOf('<div class="brand">');
  const tabs = markup.indexOf('<nav class="tabs"');
  const tail = markup.indexOf('<div class="bar-end">');
  assert.ok(brand >= 0 && tabs > brand && tail > tabs, 'the bar is not brand, switch, end, in that order');
});

test('the mark sits in the brand row at left, drawn from the one symbol, and nowhere else in the bar', () => {
  const markup = bar();
  const start = markup.indexOf('<div class="brand">');
  const brand = markup.slice(start, markup.indexOf('</div>', start));
  assert.match(brand, /<svg class="mark brand-mark"[^>]*><use href="#phosphor-mark"\/><\/svg>/, 'the brand row does not draw the mark as svg.mark');
  assert.ok(/<span class="brand-word">Phosphor<\/span>/.test(brand), 'the brand row has no word');
  assert.equal(brand.includes('<button'), false, 'the brand row is a control');
  assert.equal(end().includes('phosphor-mark'), false, 'the end of the bar draws the mark');
});

test('the switch is Basic, Pro and Vault, and Trade is part of Pro', () => {
  const tabs = [...bar().matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['basic', 'pro', 'vault']);
  assert.ok(/TAB_OF = \{ basic: 'basic', pro: 'pro', trade: 'pro', vault: 'vault' \}/.test(SHELL), 'the shell does not light Pro while Trade is up');
  assert.ok(/VIEWS = \[[^\]]*'trade'/.test(SHELL), 'Trade is no longer a view the window can show');
});

test('nothing in the bar reports state: no pills, no dots, no lock timer, no stream word', () => {
  const markup = bar();
  for (const gone of ['chip-', 'status-dot', 'status-line', 'bar-lock', 'bar-state', 'Not backed up', 'Locks in', '>Live<', 'waiting']) {
    assert.equal(markup.includes(gone), false, `the bar still carries ${gone}`);
  }
  for (const gone of ["'Live'", "'Delayed'", 'renderStatus', 'chip-lock', 'chip-feed', 'chip-waiting', 'chip-backup']) {
    assert.equal(SHELL.includes(gone), false, `the shell still writes ${gone}`);
  }
});

test('the brake is one glyph at the end of the bar, named, neutral, and never red at rest', () => {
  const tail = end();
  const last = tail.lastIndexOf('<button class="brake-btn"');
  assert.ok(last >= 0, 'the bar has no brake');
  const button = tail.slice(last, tail.indexOf('</button>', last));
  assert.ok(button.includes('id="btn-freeze"'));
  assert.ok(button.includes('type="button"'));
  assert.ok(button.includes('aria-label="Freeze everything"'), 'the glyph has no name');
  assert.ok(button.includes('aria-haspopup="dialog"') && button.includes('aria-controls="brake-panel"'), 'the glyph does not name its confirm step');
  assert.ok(button.includes('<use href="#i-freeze"/>'), 'the brake does not draw the freeze glyph');
  assert.match(HTML, /<symbol id="i-freeze" viewBox="0 0 24 24">/, 'the freeze glyph is not drawn on the icon grid');
  const rest = LAYOUT.match(/\.brake-btn\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rest, /color:\s*var\(--text-2\)/, 'the brake is not neutral at rest');
  assert.doesNotMatch(LAYOUT.replace(/\.brake-panel[^{]*\{[^}]*\}/g, ''), /\.brake-btn[^{]*\{[^}]*var\(--down/, 'the brake glyph wears red');
});

test('the confirm step is a small panel under the brake, and the one red in it is the Freeze button', () => {
  const tail = end();
  const panel = tail.slice(tail.indexOf('<div class="brake-panel"'));
  assert.match(panel, /<div class="brake-panel" id="brake-panel" role="dialog"[^>]*hidden>/, 'the confirm step is not a hidden in-window panel');
  assert.equal(HTML.includes('<dialog'), false, 'the confirm step is a modal dialog');
  assert.ok(SHELL.includes("refs.brakeGo.className = frozen ? 'btn btn-sm' : 'btn btn-danger btn-sm'"), 'Freeze is not the one red button');
  assert.ok(!SHELL.includes('PhosphorConfirm.ask'), 'the brake still asks through the dialog over the window');
  for (const word of ["'Freeze everything?'", "'Freeze everything'", "'Freezing'", "'Unfreeze'", "'Unfreezing'", "'Keep frozen'", "'Cancel'"]) {
    assert.ok(SHELL.includes(word), `the brake never says ${word}`);
  }
  // The harmless answer takes the focus, and Escape or a click outside puts the panel away.
  assert.ok(/refs\.brakeKeep\.focus\(\)/.test(SHELL));
  assert.ok(/event\.key !== 'Escape' \|\| refs\.brakePanel\.hidden/.test(SHELL));
});

test('the Layout menu is on the bar before the brake, and only on the modes with panes to arrange', () => {
  const tail = end();
  const menu = tail.indexOf('id="btn-layout"');
  assert.ok(menu >= 0, 'the bar has no Layout button');
  assert.ok(tail.indexOf('id="btn-freeze"') > menu, 'the brake is not after the Layout menu');
  const button = tail.slice(tail.lastIndexOf('<button', menu), tail.indexOf('</button>', menu));
  assert.ok(/class="layout opens"/.test(button), 'the Layout button is not on the opening grammar');
  assert.ok(button.includes('aria-haspopup="menu"') && button.includes('aria-controls="bar-layout"'), 'the button does not name its menu');
  assert.match(LAYOUT, /body\[data-view="basic"\] \.layout-wrap,\s*body\[data-view="vault"\] \.layout-wrap\s*\{\s*display:\s*none;/, 'Layout shows on a mode with nothing to arrange');
  assert.ok(SHELL.includes('PhosphorSplit.panes(currentView)'), 'the shell does not list the panes of the current view');
  assert.ok(SHELL.includes('PhosphorSplit.setPane('), 'a press in the menu reaches nothing');
  assert.ok(SHELL.includes("'phosphor:pane'"), 'an eye-off press in a header would leave the menu stale');
});

test('what needs the person is one calm line at the foot of the world, never in the bar', () => {
  const world = HTML.slice(HTML.indexOf('<main class="world"'), HTML.indexOf('</main>'));
  assert.match(world, /<div class="notice" id="notice" role="status" hidden>/, 'the notice is not in the world');
  assert.equal(bar().includes('notice'), false);
  for (const word of ["'Reconnecting to the app.'", "'Your recovery phrase is not backed up yet.'", "'Back it up'"]) {
    assert.ok(SHELL.includes(word), `the notice never says ${word}`);
  }
  const rule = NOTICE.match(/\.notice\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /position:\s*sticky;/);
  assert.doesNotMatch(rule, /var\(--(warn|down|up|ink)/, 'the notice shouts in a state colour');
});
