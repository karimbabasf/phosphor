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

test('the mark has left the bar: no tile beside the brake and no glyph in the wordmark', () => {
  assert.equal(HTML.includes('colourway-toggle'), false, 'the colourway toggle tile is still in the bar');
  assert.equal(HTML.includes('wordmark-glyph'), false, 'the wordmark still carries the mark');
  assert.equal(cluster().includes('phosphor-mark'), false, 'the cluster draws the mark');
  assert.equal(SHELL.includes('renderGlyph'), false, 'the shell still drives a glyph that is not there');
  assert.equal(SHELL.includes('colourway-toggle'), false, 'the shell still wires the toggle');
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
