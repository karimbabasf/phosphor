// Trade's pop-ups and in-place panels open ready: whole, in view, the moment they open (Karim,
// 2026-09-23: "for the trade pop ups, I want to have it ready scrolled"), and the deck's tab row
// keeps the eye in a slot of its own at every width. The measuring runs in a real window
// (scratchpad WKWebView passes at 960, 1180 and 1440); these hold the wiring that makes it so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TRADE = readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8');
const CHART = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../ui/design/trade.css', import.meta.url), 'utf8');

test('a confirm grows with the list scrolling under it, not after it has grown', () => {
  // The plan is measured inside the morph's change, where the card already has its final
  // height, and the scroll runs on the morph's own clock.
  assert.match(TRADE, /function grow\(row\) \{\s*var plan = \[\];\s*morph\(row, function \(\) \{\s*paintConfirm\(row\);\s*plan = revealPlan\(row\);\s*\}\);\s*glide\(plan\);/);
  assert.doesNotMatch(TRADE, /\.then\(function \(\) \{ reveal\(row\); \}\)/, 'the scroll after the grow is back');
  assert.match(TRADE, /var GLIDE_MS = 240;/, 'the glide is off the morph clock (motion.js MORPH_MS)');
  // A refused close and its Details open ready too.
  assert.match(TRADE, /open\.phase = 'failed';[\s\S]{0,900}?grow\(row\);/);
  assert.match(TRADE, /event\.preventDefault\(\);\s*details\.open = true;\s*scrollNow\(revealPlan\(row, details\)\);/);
});

test('every sheet is fitted inside what shows it before it opens, and a list opens on its active row', () => {
  assert.match(TRADE, /function popover\(wrap, button, pop, onOpen\) \{\s*function open\(\) \{\s*if \(onOpen\) onOpen\(\);\s*fitPop\(pop\);/);
  assert.match(TRADE, /showActive\(refs\.symbolMenu, true\);\s*fitPop\(sheet\);\s*dom\.setAttr\(sheet, 'data-open', 'true'\);/);
  assert.match(TRADE, /fitPop\(refs\.cmdMenu\);\s*dom\.setAttr\(refs\.cmdMenu, 'data-open', 'true'\);/);
  assert.match(CHART, /trade\.fitPop\(menu\);\s*if \(open\) menu\.dataset\.open = 'true';/, 'the More timeframes sheet');
  assert.match(CSS, /\.pop \{\s*translate: var\(--pop-dx, 0px\) 0;\s*overflow-y: auto;/);
  assert.match(CSS, /\.pop\[data-side="up"\] \{\s*top: auto;\s*bottom: calc\(100% \+ 6px\);/);
});

test('the deck tab row gives way from the left, so nothing runs under the eye at its end', () => {
  assert.match(CSS, /\.trade-account \{\s*display: flex;\s*flex-direction: row-reverse;\s*flex-wrap: wrap;[^}]*height: 20px;\s*overflow: hidden;/);
  assert.match(CSS, /\.trade-account-free \{ order: -1; \}/, 'Free is the figure that stays');
});
