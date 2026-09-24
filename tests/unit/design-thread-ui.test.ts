// The thread's look, held in the stylesheets.
//
// Karim, 2026-09-23: a status card covered the whole chat, statuses felt late, three clocks
// ticked, and he did not know where to look. The rules pinned here are the ones that answer
// that: nothing covers the thread (the dock and its rules are gone), the way back down is small
// and quiet, green belongs to the mark, the live move and Approve, no text runs past its card,
// motion is the contract's (rows 180 ms with a 6 px rise, numbers 400 ms, the one breath on
// Approve) and every bit of it stops under reduced motion.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LAYOUT = read('ui/design/layout.css');
const AGENT = read('ui/design/agent.css');
const CARD = read('ui/design/chatcard.css');
const CARDS = read('ui/design/cards.css');
const COMPONENTS = read('ui/design/components.css');
const DOM = read('ui/core/dom.js');

function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule for "${selector}"`);
  return css.slice(at, css.indexOf('}', at));
}

function reduced(css: string): string {
  const at = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at >= 0, 'no reduced motion block');
  return css.slice(at);
}

test('there is no dock: nothing in the layout sizes, centres or raises a card over the thread', () => {
  assert.doesNotMatch(LAYOUT, /\.dock\b/, 'a dock rule is back in layout.css');
  assert.doesNotMatch(LAYOUT, /#dock-ask|#overlay/);
  assert.doesNotMatch(LAYOUT, /\.conversation:has\(/, 'the column reshapes itself around a card again');
  assert.doesNotMatch(AGENT + CARD, /position:\s*fixed/, 'something in the conversation is laid over the window');
  /* The two things drawn over the scroller are small and on its edges: the top fade and Latest. */
  const absolute = [...(AGENT + CARD).matchAll(/\n([^\n{]+)\{[^}]*position:\s*absolute/g)].map((m) => (m[1] as string).trim());
  for (const selector of absolute) {
    assert.ok(['.chat-who', '.transcript-fade', '.jump-latest', '.mcard-track', '.connection-copy'].includes(selector), `"${selector}" is laid over the thread`);
  }
});

test('the thread is one measure of 720 px, and the composer sits on it', () => {
  assert.match(AGENT, /--thread-w:\s*720px;/);
  assert.match(block(AGENT, '.transcript-rows'), /width:\s*min\(100%, var\(--thread-w\)\);/);
  assert.match(block(AGENT, '.agent-composer'), /var\(--thread-w\)/);
  /* The person's words in a quiet bubble on the right; the assistant's bare on the left. */
  const bubble = block(AGENT, '.chat-said .chat-text');
  assert.match(bubble, /border-radius:\s*18px 18px 6px 18px;/);
  assert.match(bubble, /background:\s*var\(--bg-2\);/);
  assert.doesNotMatch(block(AGENT, '.chat-reply'), /background|border:/, 'the assistant has a bubble');
});

test('Latest is small and quiet on the thread\'s bottom edge, never a bar across it', () => {
  const jump = block(AGENT, '.jump-latest');
  assert.doesNotMatch(jump, /\bright:\s*0/, 'Latest runs the width of the column');
  assert.doesNotMatch(jump, /box-shadow/, 'Latest floats on a shadow');
  assert.match(jump, /background:\s*var\(--bg-1\);/);
  assert.match(jump, /color:\s*var\(--text-2\);/);
  assert.match(jump, /bottom:\s*var\(--s-2\);/);
  assert.doesNotMatch(jump, /--agent|--ink/, 'Latest wears a colour');
});

test('green is the mark\'s, the live move\'s and Approve\'s, and nothing else in the conversation wears it', () => {
  const inks = [...AGENT.matchAll(/\n([^\n{]+)\{[^}]*var\(--(ink|live)\)[^}]*\}/g)].map((m) => (m[1] as string).trim());
  for (const selector of inks) {
    assert.ok(['.agent-seat', '.chat-working-mark', '.agent-waiting-glyph'].includes(selector), `"${selector}" is green in the conversation`);
  }
  assert.doesNotMatch(block(AGENT, '.composer-field:focus-within'), /--ink/, 'the box lights green on focus');
  assert.doesNotMatch(block(AGENT, '.composer-send'), /--ink/, 'the send button is green');
  const cardInks = [...CARD.matchAll(/\n([^\n{]+)\{[^}]*var\(--ink\)[^}]*\}/g)].map((m) => (m[1] as string).trim());
  for (const selector of cardInks) {
    assert.ok(/needs_you|mcard-track-fill|@keyframes mcard-lit/.test(selector), `"${selector}" is green on the card`);
  }
  /* A done move, a failed one and a gain are words and figures in the text tones; red is a loss. */
  assert.doesNotMatch(CARDS, /var\(--up\)/, 'a card paints a gain green');
  assert.doesNotMatch(CARD, /var\(--down\)/, 'the move card paints something red');
});

test('no text can run past a card: the move and its lines wrap inside it', () => {
  assert.match(block(CARD, '.mcard-move'), /min-width:\s*0;/);
  assert.match(block(CARD, '.mcard-move'), /flex-wrap:\s*wrap;/);
  assert.match(block(CARD, '.mcard-move'), /overflow-wrap:\s*anywhere;/);
  assert.match(block(CARD, '.mcard-line'), /overflow-wrap:\s*anywhere;/);
  assert.match(block(CARD, '.mcard-address-line'), /word-break:\s*break-all;/);
  assert.match(block(CARDS, '.tcard'), /overflow-wrap:\s*anywhere;/);
  assert.match(block(AGENT, '.chat-text'), /overflow-wrap:\s*anywhere;/);
  /* A banner holding an id wraps it: a flex item is as wide as its longest word unless told. */
  assert.match(COMPONENTS, /\.banner > span\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere;\s*\}/);
});

test('the one thing that breathes is Approve, slowly, and it never changes size', () => {
  const breath = block(COMPONENTS, '.btn-primary[data-live="true"]:not(:disabled)');
  assert.match(breath, /animation:\s*ask-breathe 2600ms/);
  const keys = COMPONENTS.slice(COMPONENTS.indexOf('@keyframes ask-breathe'), COMPONENTS.indexOf('.btn-lg'));
  assert.doesNotMatch(keys, /transform|scale|width|height/, 'the breath changes the button\'s size');
  assert.match(keys, /box-shadow:\s*0 0 0 5px/);
  /* Nothing else in the conversation runs forever. */
  for (const [name, css] of [['agent.css', AGENT], ['chatcard.css', CARD], ['cards.css', CARDS]] as const) {
    assert.doesNotMatch(css, /infinite/, `${name} runs an animation forever`);
  }
});

test('motion is the contract\'s: rows enter in 180 ms with a 6 px rise, numbers roll in 400 ms', () => {
  assert.match(AGENT, /@keyframes row-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(6px\);\s*\}\s*\}/);
  assert.match(block(AGENT, '.transcript-rows > *'), /animation:\s*row-in 180ms var\(--ease-out\) both;/);
  assert.match(DOM, /var ROLL_MS = 400;/);
  /* The working card's track resumes where the move is rather than restarting. */
  assert.match(CARD, /animation:\s*mcard-pace var\(--track-dur, 45s\) [^;]+ var\(--track-at, 0s\) both;/);
});

test('every motion stops under reduced motion', () => {
  const agent = reduced(AGENT);
  assert.match(agent, /\.transcript-rows > \*/);
  assert.match(agent, /animation:\s*none;/);
  const card = reduced(CARD);
  assert.match(card, /\.mcard\[data-lit="true"\]/);
  assert.match(card, /\.mcard\[data-state="working"\] \.mcard-track-fill \{ animation: none; \}/);
  assert.match(card, /\.mcard-state-word\[data-fade\]/);
  assert.match(reduced(COMPONENTS), /animation-duration:\s*1ms !important;/);
});

test('the dock-era card head a screen builds still has its rules, outside the dead dock', () => {
  assert.match(block(COMPONENTS, '.dock-head'), /justify-content:\s*space-between;/);
  assert.match(block(COMPONENTS, '.dock-close'), /width:\s*30px;/);
  assert.match(block(COMPONENTS, '.dock-actions'), /justify-content:\s*flex-end;/);
});

test('a chip carries no dot', () => {
  assert.match(COMPONENTS, /\.chip > \.dot\s*\{\s*display:\s*none;\s*\}/);
});

/* Criterion 5.3: a stage change is a fade of 200 to 300 ms on the word. The card's state word
   went to the rows' 180 ms in this rebuild and card-proof caught it. */
test('the state word changes with a fade of 200 to 300 ms', () => {
  for (const name of ['a', 'b']) {
    const rule = block(CARD, `.mcard-state-word[data-fade="${name}"],\n.mcard-line[data-fade="${name}"]`);
    const ms = Number((new RegExp(`chatcard-fade-${name} (\\d+)ms`).exec(rule) ?? [])[1]);
    assert.ok(ms >= 200 && ms <= 300, `the fade is ${ms} ms`);
  }
});

/* Found in the proofs at a 550 px column (2026-09-23): the state word dropped under the move so
   "Done · 21s" took a second line and the card jumped 20 px on landing; a long record squeezed
   its label to two letters a line; an id ran under its Copy; "4 USDC" in a reply read as two
   spaces. */
test('the card keeps one head row, labels keep their words, and a reply figure keeps a word gap', () => {
  assert.match(block(CARD, '.mcard-head'), /flex-wrap:\s*nowrap/);
  assert.match(block(CARDS, '.tcard-line-label'), /min-width:\s*6em/);
  assert.match(block(CARDS, '.tcard-line[data-wrap="true"] .tcard-line-value'), /flex:\s*1 1 0/);
  assert.match(block(CARD, '.tcard-ref-value'), /flex:\s*0 0 auto/);
  assert.match(block(CARD, '.tcard-line.tcard-recorded'), /flex-direction:\s*column/);
  assert.match(block(AGENT, '.chat-text strong,\n.chat-text b'), /word-spacing:\s*-0\.3em/);
});
