// The quit sheet's way out: Shutting down, from the yes until the process ends.
//
// ui/screens/quit.js runs for real over a small DOM, with the real ui/core/dom.js and the real
// ui/design/motion.js, the api replaced by reads the test answers by hand, and a clock the test
// moves, so every beat and hold is a number here rather than a wait. What is proven: the yes
// keeps the card and turns it into Shutting down; the shell hears quit only once the backend's
// report has counted the moves (or the read gave up); each step lands only on its own signal,
// one beat apart and in order, and a step with no signal never lands; a move being sent leaves
// the lock to the stop; the mark goes out a slab per step and the last with the close; the card
// says closed inside the shell's QUIT_PAINT; Escape and a click outside do nothing once it is
// going; under reduced motion the same steps land with nothing animated; and the words the shell
// sends and reads (src-tauri/src/main.rs) are the ones this page speaks. tsc never sees ui/, so
// this is the check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const MOTION = read('../../ui/design/motion.js');
const QUIT = read('../../ui/screens/quit.js');
const CSS = read('../../ui/design/screens.css');
const SHELL = read('../../src-tauri/src/main.rs');

const QUIT_PAINT_MS = Number(/const QUIT_PAINT: Duration = Duration::from_millis\((\d+)\);/.exec(SHELL)?.[1]);

/* ---------- a clock the test moves ---------- */

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms?: number) => number;
  clearTimeout: (id: number) => void;
  advance: (ms: number) => Promise<void>;
};

function clock(): Clock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at > end) continue;
          if (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[0] < next[0])) next = entry;
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

/* ---------- a DOM small enough to read ---------- */

function makeDom(time: Clock, animated: Any[]) {
  function makeNode(tagName: string): Any {
    const attrs: Record<string, string> = {};
    const listeners: Record<string, Array<(event: Any) => void>> = {};
    let ownText = '';
    const node: Any = {
      tagName: tagName.toUpperCase(),
      className: '',
      hidden: false,
      type: '',
      tabIndex: 0,
      open: false,
      style: { setProperty(name: string, value: string) { node.style[name] = value; } } as Any,
      childNodes: [] as Any[],
      parentNode: null as unknown as Any,
      get textContent(): string {
        return node.childNodes.length ? node.childNodes.map((c: Any) => c.textContent).join('') : ownText;
      },
      set textContent(value: string) {
        ownText = String(value);
        for (const child of node.childNodes) child.parentNode = null;
        node.childNodes = [];
      },
      get firstChild() { return node.childNodes[0] ?? null; },
      get children() { return node.childNodes; },
      appendChild(child: Any) {
        child.parentNode?.removeChild(child);
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      removeChild(child: Any) {
        const at = node.childNodes.indexOf(child);
        if (at >= 0) node.childNodes.splice(at, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name: string, value: string) { attrs[name] = String(value); },
      setAttributeNS(_ns: string, name: string, value: string) { attrs[name] = String(value); },
      getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
      hasAttribute(name: string) { return name in attrs; },
      removeAttribute(name: string) { delete attrs[name]; },
      addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
      removeEventListener() {},
      dispatch(type: string, event: Any = {}) {
        let stopped = false;
        const full = Object.assign({ target: node, currentTarget: node, preventDefault() { stopped = true; } }, event);
        for (const fn of listeners[type] ?? []) fn(full);
        return stopped;
      },
      click() { node.dispatch('click'); },
      focus() { node.focused = true; },
      showModal() { node.open = true; },
      close() { node.open = false; },
      querySelector(selector: string) { return find(node, selector)[0] ?? null; },
      getClientRects() { return node.hidden ? [] : [{}]; },
      getBoundingClientRect() { return { height: 40 * node.childNodes.length }; },
      // The Web Animations API as far as motion.js reaches: it finishes when its duration has
      // passed on the test's clock, and every call is written down.
      animate(keyframes: Any[], options: Any) {
        const duration = Number(options && options.duration) || 0;
        animated.push({ node, keyframes, duration });
        return {
          finished: new Promise((resolve) => time.setTimeout(() => resolve(undefined), duration)),
          cancel() {},
        };
      },
    };
    return node;
  }
  return makeNode;
}

function matches(node: Any, selector: string): boolean {
  const parts = selector.trim().match(/^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!parts) return false;
  const [, tag, classes, attrsPart] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  // An svg is classed through setAttribute (dom.js mark), everything else through className.
  const names = String(node.className || node.getAttribute('class') || '').split(' ');
  for (const cls of classes.split('.').filter(Boolean)) {
    if (!names.includes(cls)) return false;
  }
  for (const raw of attrsPart.match(/\[[^\]]+\]/g) ?? []) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(raw);
    if (!m) return false;
    const value = node.getAttribute(m[1]);
    if (m[2] === undefined ? value === null : value !== m[2]) return false;
  }
  return true;
}

function find(root: Any, selector: string): Any[] {
  const out: Any[] = [];
  const walk = (n: Any): void => {
    for (const child of n.childNodes) {
      if (matches(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/* ---------- the window ---------- */

type Report = { moving: string[]; lines: Any[] } | null;
type Read = { resolve: (report: Report) => void };
type World = { win: Any; body: Any; time: Clock; reads: Read[]; animated: Any[] };

const MOVING = (n: number): Report => ({
  moving: Array.from({ length: n }, (_, i) => `p${i}`),
  lines: n > 0 ? [{ kind: 'moving', tone: 'safe', lead: `${n} moves are on their way.`, rest: 'They finish without Phosphor.' }] : [],
});

function world(opts: { reduced: boolean }): World {
  const time = clock();
  const animated: Any[] = [];
  const makeNode = makeDom(time, animated);
  const body = makeNode('body');
  const root = makeNode('html');
  const reads: Read[] = [];
  const doc: Any = {
    body,
    documentElement: root,
    createElement: makeNode,
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    getElementById: () => null,
    addEventListener() {},
  };
  const sandbox: Any = {
    console,
    document: doc,
    Promise,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: opts.reduced, addEventListener() {} }),
  };
  sandbox.window = sandbox;
  // Every read of GET /api/quit waits for the test to answer it, in the order they were made.
  sandbox.PhosphorApi = {
    quit: () => new Promise((resolve) => {
      reads.push({ resolve: (report: Report) => resolve(report === null ? { ok: false } : { ok: true, data: report }) });
    }),
  };
  sandbox.PhosphorIcons = {
    svg: (name: string) => {
      const icon = makeNode('svg');
      icon.className = 'icon';
      icon.setAttribute('data-icon', name);
      return icon;
    },
  };
  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(MOTION, sandbox, { filename: 'ui/design/motion.js' });
  runInContext(QUIT, sandbox, { filename: 'ui/screens/quit.js' });
  return { win: sandbox, body, time, reads, animated };
}

const dialogOf = (w: World): Any => find(w.body, 'dialog')[0];
const cardOf = (w: World): Any => find(w.body, 'div.quit-card')[0];
const buttonNamed = (w: World, label: string): Any => find(w.body, 'button').find((b: Any) => b.textContent === label) as Any;
const rowOf = (w: World, step: string): Any => find(w.body, `li.quit-step[data-step="${step}"]`)[0];
const markOf = (w: World): Any => find(w.body, 'svg.quit-mark')[0];

function row(w: World, step: string): { state: string; name: string; word: string; note: string; glyph: string } {
  const r = rowOf(w, step);
  const note = find(r, 'span.quit-step-note')[0];
  const glyph = find(r, 'span.quit-step-glyph')[0].childNodes[0];
  const glyphKind = glyph.className === 'spinner' ? 'spinner' : glyph.className === 'quit-step-done' ? 'done' : `icon:${glyph.getAttribute('data-icon')}`;
  return {
    state: r.getAttribute('data-state'),
    name: find(r, 'span.quit-step-name')[0].textContent,
    word: find(r, 'span.quit-step-word')[0].textContent,
    note: note.hidden ? '' : note.textContent,
    glyph: glyphKind,
  };
}

/* The sheet up with this report, and Quit (or Quit now) pressed. The yes's own read is left
   unanswered, for the test to answer. */
async function pressQuit(w: World, sheet: Report): Promise<void> {
  assert.equal(w.win.__phosphorQuit(), 'asking');
  w.reads[0].resolve(sheet);
  await w.time.advance(0);
  const label = sheet && sheet.moving.length > 0 ? 'Quit now' : 'Quit';
  buttonNamed(w, label).click();
  await w.time.advance(0);
}

/* Past the card's arrival (the sheet's exit and the card's change of height), with the yes's
   read answered. */
async function handOver(w: World, sheet: Report, fresh: Report): Promise<void> {
  await pressQuit(w, sheet);
  await w.time.advance(500);
  w.reads[1].resolve(fresh);
  await w.time.advance(0);
}

/* ---------- the way out ---------- */

test('the yes keeps the card and turns it into Shutting down, and the shell hears quit only once the moves are counted', async () => {
  const w = world({ reduced: false });
  await pressQuit(w, MOVING(2));

  assert.equal(dialogOf(w).open, true, 'the dialog stays up: the window never just dims');
  assert.equal(w.win.__phosphorQuitState(), 'asking', 'nothing is stopped before the moves are counted');
  assert.equal(w.body.getAttribute('data-quitting'), 'true', 'the lock screen the wallet lock raises is kept under the card');
  await w.time.advance(500);

  assert.equal(find(cardOf(w), 'h2.title')[0].textContent, 'Shutting down');
  assert.equal(find(cardOf(w), 'button').length, 0, 'the card has nothing left to press');
  assert.deepEqual(row(w, 'moves'), { state: 'active', name: 'Moves on their way', word: 'Checking', note: '', glyph: 'spinner' });
  assert.deepEqual(row(w, 'lock'), { state: 'wait', name: 'Wallet', word: '', note: '', glyph: 'icon:lock' });
  assert.deepEqual(row(w, 'stop'), { state: 'wait', name: 'Phosphor', word: '', note: '', glyph: 'icon:stop' });
  assert.equal(markOf(w).getAttribute('data-state'), 'working', 'the mark scans while anything is left to stop');
  assert.equal(markOf(w).getAttribute('data-dark'), '0');

  w.reads[1].resolve(MOVING(1));
  await w.time.advance(0);
  assert.equal(w.win.__phosphorQuitState(), 'quit', 'counted: the shell may stop things now');
  assert.deepEqual(row(w, 'moves'), { state: 'done', name: '1 move on its way', word: 'Noted', note: 'It finishes without Phosphor.', glyph: 'done' });
  assert.deepEqual(row(w, 'lock'), { state: 'active', name: 'Wallet', word: 'Locking', note: '', glyph: 'spinner' });
  assert.equal(row(w, 'stop').state, 'wait');
  assert.equal(markOf(w).getAttribute('data-dark'), '1', 'the front slab goes out with the first step');
});

test('each step lands on the shell\'s word, a beat apart and in order, and the card closes inside QUIT_PAINT', async () => {
  const w = world({ reduced: false });
  await handOver(w, MOVING(0), MOVING(0));
  assert.deepEqual(row(w, 'moves'), { state: 'done', name: 'Nothing on its way', word: 'Checked', note: '', glyph: 'done' });

  w.win.__phosphorQuitStep('locked');
  w.win.__phosphorQuitStep('stopping');
  await w.time.advance(0);
  assert.equal(row(w, 'lock').state, 'active', 'the lock lands a beat after the moves, never with them');
  assert.equal(row(w, 'stop').state, 'wait', 'and the row under it waits with it');

  await w.time.advance(180);
  assert.deepEqual(row(w, 'lock'), { state: 'done', name: 'Wallet', word: 'Locked', note: '', glyph: 'done' });
  assert.deepEqual(row(w, 'stop'), { state: 'active', name: 'Phosphor', word: 'Stopping', note: '', glyph: 'spinner' });
  assert.equal(markOf(w).getAttribute('data-dark'), '2');

  await w.time.advance(5000);
  assert.equal(row(w, 'stop').state, 'active', 'a backend still draining is still stopping');
  assert.equal(w.win.__phosphorQuitState(), 'quit');

  const stoppedAt = w.time.now();
  w.win.__phosphorQuitStep('stopped');
  await w.time.advance(0);
  assert.deepEqual(row(w, 'stop'), { state: 'done', name: 'Phosphor', word: 'Stopped', note: '', glyph: 'done' });
  assert.equal(markOf(w).getAttribute('data-dark'), '3');
  assert.equal(w.win.__phosphorQuitState(), 'quit', 'the last step is seen before the card goes');

  await w.time.advance(180);
  assert.equal(markOf(w).getAttribute('data-dark'), '4', 'the last light goes out with the close');
  let closedAt = -1;
  for (let i = 0; i < 40 && closedAt < 0; i += 1) {
    await w.time.advance(50);
    if (w.win.__phosphorQuitState() === 'closed') closedAt = w.time.now();
  }
  assert.ok(closedAt > 0, 'the card says closed');
  assert.ok(closedAt - stoppedAt < QUIT_PAINT_MS, `closed ${closedAt - stoppedAt} ms after the stop, inside the shell's ${QUIT_PAINT_MS} ms`);
  assert.equal(cardOf(w).style.visibility, 'hidden', 'the card went out before the window did');
  assert.ok(w.animated.some((a) => a.node === cardOf(w) && a.duration === 200), 'the way out is the dialog\'s own');
});

test('a step with no signal never lands, however long the window stays up', async () => {
  const w = world({ reduced: false });
  await handOver(w, MOVING(0), MOVING(0));
  await w.time.advance(60_000);
  assert.equal(row(w, 'lock').state, 'active', 'no lock word, no tick');
  assert.equal(row(w, 'stop').state, 'wait', 'no stop word, no tick');
  assert.equal(markOf(w).getAttribute('data-dark'), '1');
  assert.equal(w.win.__phosphorQuitState(), 'quit', 'never closed on a timer');

  assert.equal(w.win.__phosphorQuitStep('landed'), 'quit', 'a word the page does not know changes nothing');
  assert.equal(row(w, 'lock').state, 'active');
});

test('a move being sent leaves the lock to the stop, and both land in order once it has stopped', async () => {
  const w = world({ reduced: false });
  await handOver(w, MOVING(1), MOVING(1));
  w.win.__phosphorQuitStep('sending');
  w.win.__phosphorQuitStep('stopping');
  await w.time.advance(180);
  assert.deepEqual(row(w, 'lock'), { state: 'held', name: 'Wallet', word: 'Waiting', note: 'It locks as Phosphor stops.', glyph: 'icon:lock' });
  assert.deepEqual(row(w, 'stop'), { state: 'active', name: 'Phosphor', word: 'Stopping', note: 'A move is being sent. It finishes first.', glyph: 'spinner' });

  const stoppedAt = w.time.now();
  w.win.__phosphorQuitStep('stopped');
  await w.time.advance(0);
  assert.equal(row(w, 'lock').state, 'done', 'the key went with the process: locked');
  assert.equal(row(w, 'stop').state, 'active', 'the stop lands a beat later, under it');
  await w.time.advance(180);
  assert.equal(row(w, 'stop').state, 'done');

  let closedAt = -1;
  for (let i = 0; i < 40 && closedAt < 0; i += 1) {
    await w.time.advance(50);
    if (w.win.__phosphorQuitState() === 'closed') closedAt = w.time.now();
  }
  assert.ok(closedAt > 0 && closedAt - stoppedAt < QUIT_PAINT_MS, `the slowest finish, ${closedAt - stoppedAt} ms, fits the shell's ${QUIT_PAINT_MS} ms`);
});

test('a read that never answers is never ticked, and the sheet\'s own report stands in when there was one', async () => {
  const blind = world({ reduced: false });
  assert.equal(blind.win.__phosphorQuit(), 'asking');
  await blind.time.advance(600);
  buttonNamed(blind, 'Quit').click();
  await blind.time.advance(599);
  assert.equal(blind.win.__phosphorQuitState(), 'asking', 'the read gets its 600 ms');
  await blind.time.advance(1);
  assert.equal(blind.win.__phosphorQuitState(), 'quit', 'and the quit goes on without it');
  assert.deepEqual(row(blind, 'moves'), { state: 'unknown', name: 'Moves on their way', word: 'Not checked', note: 'Anything already sent still finishes.', glyph: 'icon:send' });

  const sighted = world({ reduced: false });
  await pressQuit(sighted, MOVING(2));
  await sighted.time.advance(600);
  assert.equal(sighted.win.__phosphorQuitState(), 'quit');
  assert.deepEqual(row(sighted, 'moves'), { state: 'done', name: '2 moves on their way', word: 'Noted', note: 'They finish without Phosphor.', glyph: 'done' });
});

test('Escape and a click outside do nothing once the card is going, and a late sheet report cannot redraw it', async () => {
  const w = world({ reduced: false });
  assert.equal(w.win.__phosphorQuit(), 'asking');
  await w.time.advance(600);
  buttonNamed(w, 'Quit').click();
  await w.time.advance(0);
  w.reads[0].resolve(MOVING(3));
  await w.time.advance(500);
  assert.equal(find(cardOf(w), 'h2.title')[0].textContent, 'Shutting down', 'the sheet\'s late answer did not bring the sheet back');

  const dialog = dialogOf(w);
  assert.equal(dialog.dispatch('cancel'), true, 'Escape is held');
  dialog.dispatch('click', { target: dialog });
  await w.time.advance(0);
  assert.equal(dialog.open, true);
  assert.equal(w.win.__phosphorQuitState(), 'asking');
  w.reads[1].resolve(MOVING(0));
  await w.time.advance(0);
  assert.equal(w.win.__phosphorQuitState(), 'quit');
});

test('under reduced motion the same steps land in the same order, and nothing animates', async () => {
  const w = world({ reduced: true });
  await pressQuit(w, MOVING(0));
  assert.equal(find(cardOf(w), 'h2.title')[0].textContent, 'Shutting down', 'the card changes at once');
  w.reads[1].resolve(MOVING(0));
  await w.time.advance(0);
  assert.equal(row(w, 'moves').state, 'done');

  w.win.__phosphorQuitStep('locked');
  w.win.__phosphorQuitStep('stopping');
  await w.time.advance(180);
  assert.equal(row(w, 'lock').state, 'done');
  assert.equal(row(w, 'stop').state, 'active');
  w.win.__phosphorQuitStep('stopped');
  await w.time.advance(180);
  assert.equal(row(w, 'stop').state, 'done');
  assert.equal(markOf(w).getAttribute('data-dark'), '3');
  await w.time.advance(180 + 320);
  assert.equal(w.win.__phosphorQuitState(), 'closed', 'the hold, then closed at once: no way out to wait for');
  assert.deepEqual(w.animated, [], 'not one element was animated');

  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*svg\.mark\.quit-mark\[data-dark\] \{\s*animation: none;/, 'the mark stops scanning');
  for (const [dark, out] of [['1', '--m4'], ['2', '--m3'], ['3', '--m2'], ['4', '--m1']]) {
    assert.ok(new RegExp(`svg\\.mark\\.quit-mark\\[data-dark="${dark}"\\] \\{[^}]*${out}: 0\\.12`).test(CSS), `slab ${out} is simply out at ${dark}`);
  }
});

test('the mark goes out a slab per step, front to back, and the lock screen stays under the card', () => {
  for (const [dark, out] of [['1', 'quit-out-4'], ['2', 'quit-out-3'], ['3', 'quit-out-2'], ['4', 'quit-out-1']]) {
    const rule = new RegExp(`svg\\.mark\\.quit-mark\\[data-dark="${dark}"\\] \\{\\s*animation:([^}]*)\\}`).exec(CSS);
    assert.ok(rule, `a rule for ${dark} dark`);
    assert.ok(rule![1].includes(out), `${out} starts at ${dark}`);
    assert.equal(rule![1].includes('scale'), false, 'nothing about the mark changes size');
  }
  assert.match(CSS, /body\[data-quitting="true"\] #screen-lock \{\s*visibility: hidden;/);
});

test('the words the shell sends and reads are the ones this page speaks', () => {
  const sent = [...SHELL.matchAll(/StopStep::\w+ => "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(sent, ['locked', 'sending', 'stopping', 'stopped']);
  for (const word of sent) assert.ok(QUIT.includes(`word === '${word}'`), `the page takes ${word}`);
  for (const phase of ['asking', 'quit', 'closed']) {
    assert.ok(SHELL.includes(`Some("${phase}") => PageAnswer::`), `the shell reads ${phase}`);
    assert.ok(QUIT.includes(`'${phase}'`), `the page says ${phase}`);
  }
  assert.ok(QUIT_PAINT_MS > 0 && QUIT_PAINT_MS <= 1500, 'the shell\'s last wait is found, and short');
});
