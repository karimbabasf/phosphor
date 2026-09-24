// How things open, close and change in the window, in one grammar (Karim, 2026-09-23: "there
// are no smooth animations when clicking out of stuff"). A popover, panel, confirm, menu or
// dialog grows from 0.96 and fades in over 220 ms and goes back the same way in 200 ms on the exit curve;
// clicking outside, Escape and the close button take the same exit; nothing leaves the screen
// before its exit is over; a card or a panel that changes size slides to it; the world dips
// between views; and none of it moves with motion reduced. The sheets are read as text, and
// ui/design/motion.js is run in a stand-in with an animate() whose ends the test decides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const bare = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ');
const MOTION = read('../../ui/design/motion.js');
const CSS = bare(read('../../ui/design/motion.css'));
const TOKENS = read('../../ui/design/tokens.css');
const HTML = read('../../ui/index.html');
const SHELL = bare(read('../../ui/screens/shell.js'));
const POP = bare(read('../../ui/design/trade.css'));

function load(opts: { reduced?: boolean } = {}) {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const win: Any = {
    matchMedia: () => ({ matches: !!opts.reduced, addEventListener() {} }),
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].live = false; },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  };
  win.window = win;
  win.document = { addEventListener() {}, documentElement: { style: { setProperty() {} } }, hidden: false };
  runInContext(MOTION, createContext(win), { filename: 'ui/design/motion.js' });
  const runTimers = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  return { M: win.PhosphorMotion, timers, runTimers };
}

/* An element whose animations end when the test says so. */
function node(height = 100): Any {
  const attrs: Record<string, string> = {};
  const el: Any = {
    hidden: false,
    open: false,
    style: {},
    height,
    anims: [] as Any[],
    animate(frames: Any, options: Any) {
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const finished = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      finished.catch(() => {});
      const anim = { frames, options, finished, cancelled: false, finish: () => resolve(), cancel() { anim.cancelled = true; reject(new Error('cancelled')); } };
      el.anims.push(anim);
      return anim;
    },
    getBoundingClientRect: () => ({ height: el.height }),
    getClientRects: () => (el.hidden ? [] : [{}]),
    setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
    removeAttribute: (k: string) => { delete attrs[k]; },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    showModal() { el.open = true; },
    close() { el.open = false; },
  };
  return el;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('one grammar: the tokens, the sheet and the script say 0.96, 220 ms in and 200 ms out on the exit curve', () => {
  assert.match(TOKENS, /--dur-open:\s*220ms;/);
  assert.match(TOKENS, /--dur-close:\s*200ms;/);
  /* A close at 160 ms on the ease-out was half gone in 21 to 42 ms and read as a snap (hunt B). */
  assert.match(TOKENS, /--ease-exit:\s*cubic-bezier\(0\.4, 0, 0\.6, 1\);/);
  assert.match(MOTION, /var EXIT_EASE = 'cubic-bezier\(0\.4, 0, 0\.6, 1\)';/);
  assert.match(TOKENS, /--dur-morph:\s*240ms;/);
  assert.match(TOKENS, /--dur-view:\s*200ms;/);
  assert.match(TOKENS, /--scale-open:\s*0\.96;/);
  assert.match(MOTION, /var OPEN_MS = 220;/, 'the script and the token disagree on the way in');
  assert.match(MOTION, /var CLOSE_MS = 200;/, 'the script and the token disagree on the way out');
  assert.match(MOTION, /var MORPH_MS = 240;/);
  assert.match(MOTION, /var SCALE_FROM = 0\.96;/);
  const links = [...HTML.matchAll(/<link rel="stylesheet" href="\.\/design\/([\w.-]+\.css)">/g)].map((m) => m[1]);
  assert.equal(links.at(-2), 'motion.css', 'the motion sheet is not the last before the presses');
  // The popovers drawn as .pop keep their own rules, on the same tokens.
  assert.match(POP, /transform:\s*scale\(var\(--scale-open\)\);[\s\S]*?transition:\s*opacity var\(--dur-close\)/);
  assert.match(POP, /\.pop\[data-open="true"\]\s*\{[^}]*transition-duration:\s*var\(--dur-open\), var\(--dur-open\), 0s;/);
});

test('a thing that opens by its hidden attribute keeps its box for the exit and cannot be pressed on the way out', () => {
  const pop = CSS.match(/\[data-motion="pop"\]\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(pop, /display var\(--dur-open\) allow-discrete/, 'display is not held for the exit');
  const hidden = CSS.match(/\[data-motion="pop"\]\[hidden\]\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(hidden, /opacity:\s*0;/);
  assert.match(hidden, /transform:\s*scale\(var\(--scale-open\)\);/);
  assert.match(hidden, /pointer-events:\s*none;/, 'a Freeze on its way out can still be pressed');
  assert.match(hidden, /transition-duration:\s*var\(--dur-close\);/, 'the way out is not the faster one');
  assert.match(hidden, /transition-timing-function:\s*var\(--ease-exit\);/, 'the way out snaps on the ease-out');
  assert.match(CSS, /@starting-style\s*\{\s*\[data-motion="pop"\]:not\(\[hidden\]\)\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(var\(--scale-open\)\);/);
  assert.match(HTML, /<div class="brake-panel" id="brake-panel"[^>]*data-motion="pop" hidden>/, 'the freeze confirm snaps');
  assert.doesNotMatch(HTML, /id="screen-lock"[^>]*data-motion/, 'the lock screen has its own unlock moment');
  assert.match(CSS, /dialog\[data-motion\]\[data-closing="true"\]\s*\{[^}]*opacity:\s*0;/);
  assert.match(CSS, /dialog\[data-motion\]\[data-closing="true"\]::backdrop\s*\{[^}]*opacity:\s*0;/, 'the scrim stays when the card goes');
});

test('nothing moves with motion reduced', () => {
  const calm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(calm.length > 0, 'there is no reduced motion path');
  for (const sel of ['[data-motion]', '[data-motion]::backdrop', '.stage[data-moving="true"]', '.world']) {
    assert.ok(calm.includes(sel), `${sel} still moves with motion reduced`);
  }
  assert.match(calm, /transition:\s*none !important;/);

  const { M, timers } = load({ reduced: true });
  const el = node();
  let done = 0;
  M.leave(el, () => { done += 1; });
  assert.equal(done, 1, 'a close waited on a motion that is off');
  assert.equal(el.anims.length, 0);
  let changed = 0;
  M.morph(el, () => { changed += 1; });
  assert.equal(changed, 1);
  assert.equal(el.anims.length, 0, 'a height slid with motion reduced');
  const dialog = node();
  dialog.showModal();
  M.closeDialog(dialog);
  assert.equal(dialog.open, false, 'a dialog waited on a motion that is off');
  assert.equal(timers.length, 0);
});

test('a close keeps the node until its exit is over, then hides it; one opened again meanwhile stays', async () => {
  const { M } = load();
  const el = node();
  let hidden = 0;
  M.leave(el, () => { hidden += 1; });
  assert.equal(hidden, 0, 'the node went before its exit');
  assert.deepEqual(JSON.parse(JSON.stringify(el.anims[0].frames)), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }]);
  assert.equal(el.anims[0].options.duration, 200);
  assert.equal(el.anims[0].options.easing, 'cubic-bezier(0.4, 0, 0.6, 1)');
  assert.equal(el.style.pointerEvents, 'none', 'a node on its way out can be pressed');
  el.anims[0].finish();
  await settle();
  assert.equal(hidden, 1);
  assert.equal(el.style.pointerEvents, '');

  const again = node();
  let gone = 0;
  M.leave(again, () => { gone += 1; });
  M.enter(again);
  await settle();
  assert.equal(again.anims[0].cancelled, true, 'the exit ran on under the open');
  assert.equal(gone, 0, 'a node opened mid exit was hidden anyway');
  assert.equal(again.style.pointerEvents, '');
  assert.deepEqual(JSON.parse(JSON.stringify(again.anims[1].frames)), [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }]);
  assert.equal(again.anims[1].options.duration, 220);
});

test('a dialog closes after its card and scrim have gone, and one asked for again mid close stays open', () => {
  const { M, runTimers, timers } = load();
  const dialog = node();
  M.openDialog(dialog);
  assert.equal(dialog.open, true);
  M.closeDialog(dialog);
  assert.equal(dialog.open, true, 'the dialog closed before its exit');
  assert.equal(dialog.getAttribute('data-closing'), 'true');
  assert.equal(timers[0].ms, 200);
  runTimers();
  assert.equal(dialog.open, false);
  assert.equal(dialog.getAttribute('data-closing'), null);

  M.openDialog(dialog);
  M.closeDialog(dialog);
  M.openDialog(dialog);
  runTimers();
  assert.equal(dialog.open, true, 'a dialog opened again mid close was closed anyway');
  assert.equal(dialog.getAttribute('data-closing'), null);
});

test('a change of height slides from what it was to what it is, and a swap fades the old part out first', async () => {
  const { M } = load();
  const card = node(100);
  const shown = node();
  M.morph(card, () => { card.height = 180; }, { fade: shown });
  assert.deepEqual(JSON.parse(JSON.stringify(card.anims[0].frames)), [{ height: '100px' }, { height: '180px' }]);
  assert.equal(card.anims[0].options.duration, 240);
  assert.equal(card.style.overflow, 'hidden', 'the growing card spills while it grows');
  assert.deepEqual(JSON.parse(JSON.stringify(shown.anims[0].frames)), [{ opacity: 0 }, { opacity: 1 }]);
  card.anims[0].finish();
  await settle();
  assert.equal(card.style.overflow, '', 'the card stays clipped after it settled');

  const panel = node(300);
  const leaving = node();
  let swapped = 0;
  M.swap(panel, leaving, () => { swapped += 1; leaving.hidden = true; panel.height = 200; });
  assert.equal(swapped, 0, 'the old part went before its exit');
  assert.equal(leaving.style.pointerEvents, 'none');
  leaving.anims[0].finish();
  await settle();
  assert.equal(swapped, 1);
  assert.equal(leaving.style.pointerEvents, '');
  assert.deepEqual(JSON.parse(JSON.stringify(panel.anims[0].frames)), [{ height: '300px' }, { height: '200px' }]);
});

test('the world dips between views and its track slides only while it does', () => {
  assert.match(SHELL, /var DIP_MS = 70;/);
  assert.match(SHELL, /var RISE_MS = 170;/);
  assert.ok(70 + 170 <= 260, 'a switch takes longer than the view token allows');
  assert.match(SHELL, /if \(changed && !opts\.silent && opts\.fromClick && canDip\(\)\) dip\(\);\s*else showView\(changed\);/, 'a swap the server asked for animates, or a click does not');
  assert.match(SHELL, /refs\.stage\.dataset\.moving = 'true';/);
  assert.match(CSS, /\.stage\[data-moving="true"\]\s*\{\s*transition:\s*grid-template-columns var\(--dur-view\) var\(--ease-out\);/);
  assert.doesNotMatch(bare(read('../../ui/design/layout.css')), /viewin|data-swapping/, 'the one-sided fade is back');
});
