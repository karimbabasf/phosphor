// The dock's room, held in the stylesheet (term 9, B6, and term 3, 3.6): every dock button is on
// screen without a scroll at a 400 px column, and nothing under the dock is sliced.
//
// On 2026-09-21 a swap card on a 400 px column at 800 px of height put No and Yes 137 px under
// the fold: the dock was capped at 62 percent of the column and shrank further for the
// transcript's share. The rules pinned here are what moved the answer back on screen, measured
// in a real browser at 400 by 800, 400 by 780, 860 by 800 and 860 by 700; the answer row's own
// place (a pinned foot after the scrolling body, decision-dock-ui.test.ts holds the DOM) is
// the last two tests.

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

/* THE TRANSCRIPT NO LONGER RUNS UNDER THE DOCK, so it has nothing to fade.

   Until 60d0d57 the body kept flex 1 1 auto with a card up, so it filled the column and its last
   lines lay beneath the dock; the mask pinned here faded that cut rather than slicing a sentence.
   Karim asked for the card in the middle of the conversation instead of down on the composer, and
   the way it gets there is the body giving up the column's free space (flex 0 1 auto) so the
   dock's own auto margins can split it. A body that hugs its content ends above the dock and
   passes under nothing.

   The mask had to leave with it: applied to a body that is now the height of its content, it ate
   the last line of a SHORT transcript, which is the opposite of what it was for. The edge that
   really has more behind it is the inner scroller's, and .transcript-fade still draws that one,
   on and off by opacity as the column crosses it (ui/design/agent.css).

   So this test pins the two rules that place the card, and pins the absence of the mask, because
   a mask put back here would be a regression that looks like a fix. */
test('the transcript gives up the free space so the card sits in the middle, and fades nothing', () => {
  const body = LAYOUT.match(/\.conversation:has\(> \.dock:not\(\[hidden\]\)\) > \.conversation-body\s*\{([^}]*)\}/);
  assert.ok(body, 'nothing shapes the transcript while a card is up');
  assert.match(body?.[1] ?? '', /flex:\s*0 1 auto;/, 'a growing body eats the free space and the card falls back onto the composer');
  assert.doesNotMatch(body?.[1] ?? '', /mask-image/, 'the mask is back, and on a hugging body it eats the last line of a short transcript');

  const dock = LAYOUT.match(/\.conversation:has\(> \.dock:not\(\[hidden\]\)\) > \.dock\s*\{([^}]*)\}/);
  assert.ok(dock, 'nothing centres the dock in the rail');
  assert.match(dock?.[1] ?? '', /margin-block:\s*auto;/, 'without auto margins the card sits on the composer again');
});

/* THE ANSWER ROW IS OUTSIDE THE SCROLLING BODY. A send card is taller than the dock at the
   app's default window (1180 by 780) and at every smaller size, so something has to scroll.
   14a10d3 left the row in the body's flow and No and Approve sat 156 px under the fold; 6f34d66
   made the row sticky at the bottom of the scrolling body, and at scroll 0 it was painted over
   the address it approves at three of four sizes (the re-check's finding). A sticky row cannot
   do otherwise: it sits on the in-flow lines that fill the scrollport's last pixels. The foot
   is the answer: a second flex child after the body, flex 0 0 auto, never sticky, so the body's
   scrollport ends where the row begins and a fact line is either in it or clipped under a fade,
   never covered. Measured at 1180x780, 960x700, 860x700 and 400x800 on a send and a swap. */
test('the answer row is a pinned foot after the scrolling body, never a sticky row inside it', () => {
  const foot = block(LAYOUT, '.dock-foot');
  assert.match(foot, /flex:\s*0 0 auto;/, 'a foot that shrinks puts the answer under the fold');
  assert.match(foot, /border-top:\s*1px solid color-mix\(in srgb, var\(--warn\) 28%, transparent\);/);
  assert.doesNotMatch(foot, /position:\s*sticky/);
  assert.doesNotMatch(LAYOUT, /\.dock-body > \.dock-actions/, 'a rule styles the answer row inside the scrolling body');
  assert.doesNotMatch(LAYOUT, /\.dock-body > \.screen-actions/, 'a rule styles a read card\'s row inside the scrolling body');
  assert.doesNotMatch(LAYOUT, /position:\s*sticky/, 'something in the dock sticks, and a stuck element covers what it sits on');
  const body = block(LAYOUT, '.dock-body');
  assert.match(body, /flex:\s*1 1 auto;/);
  assert.match(body, /min-height:\s*0;/);
  assert.match(body, /overflow-y:\s*auto;/);
  // An empty foot (a receipt of somebody else's, the answer flash) takes no room.
  assert.match(LAYOUT, /\.dock-foot:empty\s*\{\s*display:\s*none;\s*\}/);
});

/* The fade is the one sign a person gets that the card goes on (macOS hides the scrollbar):
   a mask on the body while data-more is true, solid again at the end so the last line is never
   left half drawn. On the body, not on the row: the row is outside it now. */
test('the body fades under data-more, and nothing fades the answer row', () => {
  const fade = LAYOUT.match(/\.dock-card\[data-more="true"\] \.dock-body\s*\{([^}]*)\}/);
  assert.ok(fade, 'the body is cut hard while there is more card under it');
  assert.match(fade?.[1] ?? '', /mask-image:\s*linear-gradient\(to bottom, #000 calc\(100% - 40px\), transparent\)/);
  assert.doesNotMatch(LAYOUT, /\.dock-actions::before|\.screen-actions::before/, 'a fade is drawn on the row');
  // The 120 px the transcript keeps reached the idle block's mark: a sliver of logo over the dock.
  assert.match(LAYOUT, /\.conversation:has\(> \.dock:not\(\[hidden\]\)\) \.agent-empty\s*\{\s*display:\s*none;\s*\}/);
});

test('a chip carries no dot', () => {
  assert.match(COMPONENTS, /\.chip > \.dot\s*\{\s*display:\s*none;\s*\}/);
});
