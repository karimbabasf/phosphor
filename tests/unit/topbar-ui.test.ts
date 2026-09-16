// The top bar's right cluster: one quiet line of state and one real control.
//
// Karim, 2026-09-14, on the pills, the white mark tile and the outlined red button that used
// to sit there: "they look like ai slop". The bar is static markup in ui/index.html and the
// shell only writes words and tones into it, so the contract is read off the two files as
// text, the way basic-view.test.ts reads the Basic column's surfaces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../../ui/screens/shell.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function cluster(): string {
  const start = HTML.indexOf('<div class="status-cluster">');
  assert.ok(start >= 0, 'the bar has no status cluster');
  return HTML.slice(start, HTML.indexOf('</header>', start));
}

test('the mark sits in the brand row at left, as the banner sets it, and nowhere else in the bar', () => {
  // The brand row is a plain div: the mark at 20px and the word, no menu, no button. The
  // colourway menu it used to open went with light mode on 2026-09-15.
  const start = HTML.indexOf('<div class="brand">');
  assert.ok(start >= 0, 'the bar has no brand row');
  const brand = HTML.slice(start, HTML.indexOf('</div>', start));
  assert.ok(brand.includes('class="brand-mark"') && brand.includes('#phosphor-mark'), 'the brand row draws no mark');
  assert.ok(/<span class="brand-word">Phosphor<\/span>/.test(brand), 'the brand row has no word');
  assert.equal(brand.includes('<button'), false, 'the brand row is a control');
  assert.equal(HTML.includes('colourway'), false, 'the colourway menu is still in the bar');
  assert.equal(HTML.includes('wordmark'), false, 'the old wordmark button is still in the bar');
  assert.equal(cluster().includes('phosphor-mark'), false, 'the cluster draws the mark');
  assert.equal(SHELL.includes('renderGlyph'), false, 'the shell still drives a glyph that is not there');
  assert.equal(SHELL.includes('colourway'), false, 'the shell still wires the menu');
});

test('state is a dot or a lock and a word, never a pill, and the brake is last', () => {
  const right = cluster();
  assert.equal(/class="[^"]*\bchip\b/.test(right), false, 'a chip is still in the cluster');
  assert.equal(right.includes('btn-danger'), false, 'the brake is still the outlined red button');
  assert.ok(/id="chip-feed"/.test(right) && /class="status-line[^"]*"\s+id="chip-feed"/.test(right),
    'the stream is not a status line');
  assert.ok(/class="bar-lock"\s+id="chip-lock"/.test(right), 'the lock is not the lock line');
  assert.ok(/class="bar-lock-glyph"/.test(right), 'the lock line has no lock');
  assert.ok(right.includes('Freeze everything'), 'the brake lost its words');
  const last = right.lastIndexOf('<button');
  assert.ok(right.slice(last).includes('id="btn-freeze"'), 'the brake is not the last thing in the bar');
});

test('the stream has three words and the shell writes all three', () => {
  for (const word of ["'Live'", "'Delayed'", "'Offline'"]) {
    assert.ok(SHELL.includes(word), `the shell never writes ${word}`);
  }
  assert.ok(SHELL.includes("'off'") && SHELL.includes("'warn'") && SHELL.includes("'up'"),
    'the three dot tones are not all written');
});

test('the Layout menu is on the bar, before the brake, and the shell lists the panes of the mode that is up', () => {
  // Karim, 2026-09-15: "when i hide the chat thing, i cant bring it back". The one control
  // that put a pane back lived on the trade strip, so the assistant hidden on Basic, Pro or
  // Vault had no way back. The menu is the bar's now, and the bar is on every mode.
  const right = cluster();
  const menu = right.indexOf('id="btn-layout"');
  assert.ok(menu >= 0, 'the bar has no Layout button');
  assert.ok(right.indexOf('id="btn-freeze"') > menu, 'the brake is not after the Layout menu');
  const button = right.slice(right.lastIndexOf('<button', menu), right.indexOf('</button>', menu));
  assert.ok(/class="layout opens"/.test(button), 'the Layout button is not on the opening grammar');
  assert.ok(button.includes('aria-haspopup="menu"') && button.includes('aria-controls="bar-layout"'), 'the button does not name its menu');
  assert.ok(button.includes('>Layout<'), 'the button lost its word');
  assert.ok(/id="bar-layout"[^>]*role="menu"/.test(right) || /role="menu"[^>]*id="bar-layout"/.test(right), 'the sheet is not a menu');
  assert.ok(right.includes('id="bar-layout-rows"'), 'the sheet has nowhere to put its rows');
  // The shell fills it from the split script, by the view that is up, and hands a press back.
  assert.ok(SHELL.includes("PhosphorSplit.panes(currentView)"), 'the shell does not list the panes of the current view');
  assert.ok(SHELL.includes("PhosphorSplit.setPane("), 'a press in the menu reaches nothing');
  assert.ok(SHELL.includes("'phosphor:pane'"), 'an eye-off press in a header would leave the menu stale');
  assert.equal(readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8').includes('layoutControl'),
    false, 'the strip still draws its own Layout menu');
});
