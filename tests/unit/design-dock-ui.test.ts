// The dock's room, held in the stylesheet (term 9, B6, and term 3, 3.6): every dock button is on
// screen without a scroll at a 400 px column, and nothing under the dock is sliced.
//
// On 2026-09-21 a swap card on a 400 px column at 800 px of height put No and Yes 137 px under
// the fold: the dock was capped at 62 percent of the column and shrank further for the
// transcript's share, while the answer sits in the body under the facts (decision-dock-ui.test.ts
// keeps it there, on purpose). The rules pinned here are what moved the answer back on screen,
// measured in a real browser at 400 by 800, 400 by 780, 860 by 800 and 860 by 700.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const LAYOUT = fs.readFileSync(path.join(ROOT, 'ui', 'design', 'layout.css'), 'utf8');
const COMPONENTS = fs.readFileSync(path.join(ROOT, 'ui', 'design', 'components.css'), 'utf8');

function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule for "${selector}"`);
  return css.slice(at, css.indexOf('}', at));
}

test('the dock takes the column but 120 px, and never gives way to the transcript', () => {
  const dock = block(LAYOUT, '.dock');
  assert.match(dock, /max-height:\s*calc\(100% - 120px\);/, 'the dock is capped short of the column again');
  assert.match(dock, /flex:\s*0 0 auto;/, 'a shrinkable dock hands its height to the transcript and puts the answer under the fold');
  assert.doesNotMatch(dock, /max-height:\s*62%/);
});

test('an ask takes the stacked window whole, and a card to read keeps the split', () => {
  const stacked = LAYOUT.slice(LAYOUT.indexOf('@media (max-width: 959px)'));
  assert.match(stacked, /\.stage:has\(> \.conversation > \.dock:not\(\[hidden\]\):not\(\[data-state\]\)\)\s*\{\s*grid-template-rows:\s*0 minmax\(0, 1fr\);/);
  assert.match(stacked, /\.stage:has\(> \.conversation > \.dock:not\(\[hidden\]\):not\(\[data-state\]\)\) > \.split-v\s*\{\s*display:\s*none;/);
  // Two rows once the handle is gone: a third track put the conversation on a 0 px row.
  assert.doesNotMatch(stacked, /grid-template-rows:\s*0 0 minmax/);
});

test('what the transcript holds under the dock fades rather than slicing a sentence', () => {
  const fade = LAYOUT.match(/\.conversation:has\(> \.dock:not\(\[hidden\]\)\) > \.conversation-body\s*\{([^}]*)\}/);
  assert.ok(fade, 'the transcript is cut hard under the dock');
  assert.match(fade?.[1] ?? '', /mask-image:\s*linear-gradient\(to bottom, #000 calc\(100% - 32px\), transparent 100%\)/);
});

test('a chip carries no dot', () => {
  assert.match(COMPONENTS, /\.chip > \.dot\s*\{\s*display:\s*none;\s*\}/);
});
