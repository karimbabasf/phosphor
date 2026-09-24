// The splitters let a person rearrange a window that holds a signing key, so these tests are
// not about whether the drag feels nice. They are about the four things that make a resizable
// deck safe to ship:
//
//   - a pane cannot be dragged to nothing, and the conversation cannot be put away at all:
//     Approve lives on the move card in the thread, so a thread dragged or hidden out of
//     sight is a window arranged to hide the one control that releases money;
//   - a pane cannot be grown past the point where its neighbour hits its own floor;
//   - what a person leaves is what they come back to, and a size stored on a big screen is
//     clamped to a small one rather than applied blindly to it;
//   - reset means the CSS default, which is a property removed, not a number this file keeps
//     a second copy of.
//
// ui/split.js is a browser script, not a module: it declares vars and functions and does
// nothing until splitBoot is called. Running it in a context makes every one of those a
// property of the sandbox, which is the whole test surface. Same harness as
// tests/unit/chart-ui.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const SOURCE = readFileSync(new URL('../../ui/split.js', import.meta.url), 'utf8');

/** A localStorage that behaves, or one that refuses everything the way a locked-down browser
 *  profile does. Both are real cases: the second is why the script keeps its own copy. */
function makeStorage(broken = false): Any {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => {
      if (broken) throw new Error('storage is disabled');
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('storage is disabled');
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (broken) throw new Error('storage is disabled');
      map.delete(k);
    },
  };
}

function load(storage: Any = makeStorage()): Any {
  const sandbox: Any = {
    document: {
      body: { classList: { add() {}, remove() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.localStorage = storage;
  sandbox.requestAnimationFrame = () => 1;
  sandbox.cancelAnimationFrame = () => {};
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/split.js' });
  return sandbox;
}

/** A fake pane: the only thing the script asks an element for is its box, plus the listeners
 *  and the two attribute calls a handle node takes. */
function pane(size: number, horiz: boolean): Any {
  const node: Any = {
    size,
    listeners: {} as Record<string, Array<(ev: Any) => void>>,
    addEventListener(kind: string, fn: (ev: Any) => void) {
      (node.listeners[kind] ??= []).push(fn);
    },
    fire(kind: string, ev: Any = {}) {
      for (const fn of node.listeners[kind] ?? []) fn({ preventDefault() {}, ...ev });
    },
    focus() {},
    attrs: {} as Record<string, string>,
    style: {
      props: {} as Record<string, string>,
      setProperty(k: string, v: string) { node.style.props[k] = v; },
      removeProperty(k: string) { delete node.style.props[k]; },
    },
    getBoundingClientRect: () => (horiz ? { width: node.size, height: 40 } : { width: 400, height: node.size }),
    setAttribute(k: string, v: string) { node.attrs[k] = v; },
    removeAttribute(k: string) { delete node.attrs[k]; },
    getAttribute(k: string) { return node.attrs[k] ?? null; },
  };
  return node;
}

/** One wired handle, built the way splitBoot() builds them, against fake panes. */
function handle(s: Any, page: string, id: string, sizes: { pane: number; give?: number }): Any {
  const conf = s.SPLIT_PAGES[page][id];
  const horiz = conf.axis === 'x';
  return {
    page,
    id,
    conf,
    node: pane(0, horiz),
    pane: pane(sizes.pane, horiz),
    host: pane(sizes.pane, horiz),
    give: sizes.give === undefined ? null : pane(sizes.give, horiz),
    bounds: null,
    size: null,
    frame: 0,
    from: 0,
    start: 0,
    pending: 0,
    active: false,
  };
}

/** What the applied size is, read back off the property the script wrote. */
function applied(h: Any): number | null {
  const raw = h.host.style.props[h.conf.prop];
  return raw === undefined ? null : parseInt(raw, 10);
}

test('the deck has a floor, and a drag that asks for zero lands on it', () => {
  const s = load();
  // One handle in the window now. Pro is a grid and basic is a column, so
  // neither needs dragging; trade keeps its deck under the chart and it is the
  // only thing a pointer can squeeze. The axis is y: the handle is a
  // horizontal bar and the pane is measured by its height.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 400);

  // The pointer is thrown at the bottom edge of the window: the deck, gone.
  s.splitApply(h, s.splitAt(h, 2000));

  assert.equal(applied(h), s.SPLIT_PAGES.trade['deck-rail'].min, 'the deck stops at its floor');
  assert.ok(applied(h)! >= 120, 'and the floor keeps the tab row and two rows under it on screen');
});

test('every handle has a floor, and so does the pane it takes from', () => {
  const s = load();
  for (const page of Object.keys(s.SPLIT_PAGES)) {
    for (const id of Object.keys(s.SPLIT_PAGES[page])) {
      const conf = s.SPLIT_PAGES[page][id];
      assert.ok(conf.min > 0, page + '.' + id + ' has a floor');
      assert.ok(conf.giveMin > 0, page + '.' + id + ' leaves its neighbour a floor');
    }
  }
  // The deck under the chart (2026-09-14): 120 keeps the tab row and two rows
  // under it on screen, which is where it opens (Karim, 2026-09-16: as small
  // as possible by default), and 364 keeps the chart column at its stage's
  // own 320 px minimum plus the 44 px bar above it.
  assert.equal(s.SPLIT_PAGES.trade['deck-rail'].axis, 'y');
  assert.equal(s.SPLIT_PAGES.trade['deck-rail'].min, 120);
  assert.equal(s.SPLIT_PAGES.trade['deck-rail'].giveMin, 364);
});

test('a pane cannot be grown past the point where its neighbour hits its own floor', () => {
  const s = load();
  // The deck is 400 tall and the chart has 900: the chart's floor is 364, so
  // there are 536 pixels to take and not one more. The deck sits BELOW the
  // chart, so the drag that grows it runs up, which is why the signs read
  // backwards.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 0);

  assert.equal(s.splitAt(h, -60), 460, 'a small drag moves the boundary one for one');
  assert.equal(s.splitAt(h, -5000), 936, 'a big one stops where the chart would be squeezed');
  assert.equal(s.splitAt(h, 5000), 120, 'and the other way, at the deck own floor');
});

test('a handle whose pointer runs the other way still grows the right pane', () => {
  const s = load();
  // The deck is a bottom pane, so dragging the pointer UP makes it taller.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 0);

  assert.equal(s.splitAt(h, -60), 460, 'up makes the deck taller');
  assert.equal(s.splitAt(h, 60), 340, 'down makes it shorter');
  assert.equal(s.splitAt(h, 5000), 120, 'and it stops at its floor');
});

test('a size survives a reload, and a reset forgets it', () => {
  const storage = makeStorage();

  const first = load(storage);
  const h = handle(first, 'trade', 'deck-rail', { pane: 400, give: 900 });
  first.splitBegin(h, 0);
  first.splitApply(h, first.splitAt(h, -140)); // dragged up: the deck grew by 140
  assert.equal(applied(h), 540);
  first.splitWrite(h.page, h.id, h.size);

  // A new page, a new script, the same browser profile.
  const second = load(storage);
  assert.equal(second.splitRead('trade', 'deck-rail'), 540, 'the size came back');
  const back = handle(second, 'trade', 'deck-rail', { pane: 400, give: 900 });
  second.splitRestore(back);
  assert.equal(applied(back), 540);
  assert.equal(back.pane.getAttribute('data-sized'), '', 'and the pane is marked as one a person sized');

  // Reset: the property goes, the mark goes, the key goes. The default is the stylesheet's.
  second.splitReset(back);
  assert.equal(applied(back), null);
  assert.equal(back.pane.getAttribute('data-sized'), null);
  assert.equal(second.splitRead('trade', 'deck-rail'), null);
  assert.equal(storage.map.has('phosphor.split.trade.deck-rail'), false);
});

test('a stored size that no longer fits is clamped, and the stored one is left alone', () => {
  const storage = makeStorage();
  storage.setItem('phosphor.split.trade.deck-rail', '1200');

  const s = load(storage);
  // A much shorter window: 400 in the deck, 900 in the chart, the chart's floor 364.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitRestore(h);

  assert.equal(applied(h), 936, 'clamped to what this window can give');
  assert.equal(
    storage.map.get('phosphor.split.trade.deck-rail'),
    '1200',
    'the size chosen on the taller screen is still there for when it comes back',
  );
});

test('on Pro and the Vault the divider sizes the world, inside its range, and never squeezes the conversation', () => {
  // The world is clamp(560px, var(--trade, 55vw), 1400px) in pro.css, and the handle carries
  // the same two numbers. It sits to the right of the conversation, so dragging right shrinks
  // it: the sign is -1. The conversation gives the room and keeps 400 of it.
  const conf = load().SPLIT_PAGES.stage.conversation;
  assert.equal(conf.pane, '.world');
  assert.equal(conf.prop, '--trade');
  assert.equal(conf.sign, -1);
  assert.equal(conf.min, 560);
  assert.equal(conf.max, 1400);
  assert.equal(conf.give, '.conversation');
  assert.equal(conf.giveMin, 400);

  // A width stored on a 27 inch screen comes back inside the ceiling on a wide window.
  const wide = makeStorage();
  wide.setItem('phosphor.split.stage.conversation', '2000');
  const s = load(wide);
  const h = handle(s, 'stage', 'conversation', { pane: 1400, give: 1160 });
  s.splitRestore(h);
  assert.equal(applied(h), 1400, 'the ceiling holds even when the conversation has room');
  assert.equal(wide.map.get('phosphor.split.stage.conversation'), '2000', 'the stored value is left alone');

  // Under the floor on any window.
  const narrow = makeStorage();
  narrow.setItem('phosphor.split.stage.conversation', '200');
  const t = load(narrow);
  const g = handle(t, 'stage', 'conversation', { pane: 704, give: 576 });
  t.splitRestore(g);
  assert.equal(applied(g), 560, 'the floor holds');

  // At 1280: 704 of world and 576 of conversation. A drag left grows the world until the
  // conversation is down to its 400, and not a pixel more; a drag right shrinks it.
  const u = load();
  const k = handle(u, 'stage', 'conversation', { pane: 704, give: 576 });
  u.splitBegin(k, 0);
  assert.equal(u.splitAt(k, -40), 744, 'left grows the world one for one');
  assert.equal(u.splitAt(k, -5000), 880, 'and stops where the conversation keeps its 400');
  assert.equal(u.splitAt(k, 100), 604, 'right shrinks it');
  assert.equal(u.splitAt(k, 5000), 560, 'down to its floor');
});

test('storage that refuses everything does not cost a person their drag', () => {
  const s = load(makeStorage(true));
  assert.equal(s.splitRead('pro', 'deck-agent'), null, 'nothing to restore, and no throw');

  s.splitWrite('pro', 'deck-agent', 320);
  assert.equal(s.splitRead('pro', 'deck-agent'), 320, 'the in-memory copy carries the session');

  s.splitForget('pro', 'deck-agent');
  assert.equal(s.splitRead('pro', 'deck-agent'), null);
});

test('a stored value that is not a size is treated as absent', () => {
  const storage = makeStorage();
  const s = load(storage);
  for (const junk of ['', 'wide', '0', '-40', 'NaN']) {
    storage.map.set('phosphor.split.pro.deck-agent', junk);
    delete s.SPLIT_MEM['phosphor.split.pro.deck-agent'];
    assert.equal(s.splitRead('pro', 'deck-agent'), null, junk + ' is not a size');
  }
});

test('a keyboard press moves the same boundary the pointer does, and is written down', () => {
  const storage = makeStorage();
  const s = load(storage);
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  const events: string[] = [];
  s.window.dispatchEvent = (ev: Any) => events.push(ev.type);
  s.CustomEvent = function (type: string) { return { type }; } as any;
  s.Event = function (type: string) { return { type }; } as any;

  s.splitKeydown(h, { key: 'ArrowUp', preventDefault() {} });
  assert.equal(applied(h), 416, 'one arrow is one nudge, in the direction the pointer goes');
  assert.equal(storage.map.get('phosphor.split.trade.deck-rail'), '416', 'and it is remembered');

  s.splitKeydown(h, { key: 'Enter', preventDefault() {} });
  assert.equal(applied(h), null, 'Enter puts it back to the stylesheet default');
  assert.equal(storage.map.has('phosphor.split.trade.deck-rail'), false);

  assert.ok(events.includes('phosphor:split'), 'and the deck is told to redraw its frames');
});

test('a keyboard press on the inverted handle respects the same inversion', () => {
  const s = load();
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.window.dispatchEvent = () => {};
  s.CustomEvent = function (type: string) { return { type }; } as any;
  s.Event = function (type: string) { return { type }; } as any;

  s.splitKeydown(h, { key: 'ArrowDown', preventDefault() {} });
  assert.equal(applied(h), 384, 'down shortens a bottom pane, the way dragging down does');
});

test('a handle with no neighbour to take from can still take the spare room, and no more', () => {
  const s = load();
  // No slack at all: the chart is already on its own floor, so the deck has
  // nothing left to take.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 364 });
  s.splitBegin(h, 0);
  assert.equal(s.splitAt(h, -5000), 400, 'there is nothing to take, so nothing moves');
  assert.equal(s.splitAt(h, 5000), 120, 'and it can always be given back, down to the floor');
});

test('a window too small for both floors keeps the safety surface', () => {
  const s = load();
  // The pane is already under its own floor and there is nothing to take.
  assert.equal(s.splitClamp(20, 168, 40), 168, 'the floor wins a contradiction');
  assert.equal(s.splitClamp(900, 168, 40), 168);
});

// ---------- panes that can be hidden ----------

/** A stage and a trade wrap for the pane state to be written on, found by their selectors. */
function hosts(): { nodes: Record<string, Any>; querySelector: (sel: string) => Any } {
  const make = (): Any => {
    const attrs: Record<string, string> = {};
    return {
      attrs,
      setAttribute(k: string, v: string) { attrs[k] = v; },
      removeAttribute(k: string) { delete attrs[k]; },
      getAttribute(k: string) { return attrs[k] ?? null; },
    };
  };
  const nodes: Record<string, Any> = { '.stage': make(), '.trade-wrap': make() };
  return { nodes, querySelector: (sel: string) => nodes[sel] ?? null };
}

function loadWithHosts(storage: Any = makeStorage()): { s: Any; nodes: Record<string, Any>; events: Any[] } {
  const { nodes, querySelector } = hosts();
  const events: Any[] = [];
  const sandbox: Any = {
    document: {
      body: { classList: { add() {}, remove() {} } },
      querySelector,
      querySelectorAll: () => [],
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    CustomEvent: function (type: string, init: Any) { return { type, detail: init?.detail }; },
    Event: function (type: string) { return { type }; },
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = (ev: Any) => events.push(ev);
  sandbox.localStorage = storage;
  sandbox.requestAnimationFrame = () => 1;
  sandbox.cancelAnimationFrame = () => {};
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/split.js' });
  return { s: sandbox, nodes, events };
}

test('every pane starts on screen, and the two are the chart and the deck: the conversation is not one', () => {
  const s = load();
  // Through JSON: the arrays are built in the vm's realm and a strict deep compare tests
  // prototypes as well as values.
  assert.deepEqual(
    JSON.parse(JSON.stringify(s.splitPaneList().map((p: Any) => [p.name, p.hidden]))),
    [['chart', false], ['deck', false]],
  );
  // A conversation hidden on an older build comes back: nothing reads the old key.
  const storage = makeStorage();
  storage.map.set('phosphor.pane.conversation', 'hidden');
  const old = loadWithHosts(storage);
  old.s.splitBoot();
  assert.equal(old.nodes['.stage'].getAttribute('data-pane-conversation'), null);
  for (const pane of s.splitPaneList()) assert.ok(typeof pane.label === 'string' && pane.label.length > 0, pane.name + ' has a word');
  assert.equal(s.splitPaneHidden('deck'), false);
  assert.equal(s.splitPaneHidden('nothing'), false, 'a pane that does not exist is not hidden either');
});

test('asked for one view, the list holds the panes that view has: the chart and the deck on Trade', () => {
  // The Layout menu is on the bar, so a row for a pane the mode does not draw would be a
  // checkbox that does nothing.
  const s = load();
  const names = (view?: string) => JSON.parse(JSON.stringify(s.splitPaneList(view).map((p: Any) => p.name)));
  assert.deepEqual(names('trade'), ['chart', 'deck']);
  assert.deepEqual(names('pro'), [], 'Pro shows the deck alone and has nothing to arrange');
  assert.deepEqual(names('basic'), []);
  assert.deepEqual(names('vault'), []);
  assert.deepEqual(names(), ['chart', 'deck'], 'no view asked for means every pane');
  assert.deepEqual(JSON.parse(JSON.stringify(s.PhosphorSplit.panes('trade').map((p: Any) => p.name))), ['chart', 'deck'],
    'the window API takes the view too');
});

test('the dock gate is gone: nothing watches an #overlay, and nothing can hide the thread', () => {
  assert.doesNotMatch(SOURCE, /#overlay/);
  assert.doesNotMatch(SOURCE, /MutationObserver/);
  const { s } = loadWithHosts();
  assert.equal(s.splitPaneSet('conversation', false), false, 'there is no pane called conversation');
  assert.equal(s.splitPaneHidden('conversation'), false);
});

test('hiding a pane writes the attribute the stylesheet reads, tells the page, and comes back after a reload', () => {
  const storage = makeStorage();
  const first = loadWithHosts(storage);
  assert.equal(first.s.splitPaneSet('deck', false), true, 'the answer is the state the pane was left in');
  assert.equal(first.nodes['.trade-wrap'].getAttribute('data-pane-deck'), 'hidden');
  assert.equal(first.nodes['.stage'].getAttribute('data-pane-conversation'), null, 'another pane was touched');
  assert.equal(storage.map.get('phosphor.pane.deck'), 'hidden');
  assert.deepEqual(
    first.events.map((e) => [e.type, e.detail?.name, e.detail?.hidden]),
    [['phosphor:pane', 'deck', true], ['resize', undefined, undefined]],
    'the page is told by name and as a resize',
  );

  // A new page, the same profile: the deck is still hidden, applied when the deck boots.
  const second = loadWithHosts(storage);
  assert.equal(second.s.splitPaneHidden('deck'), true);
  second.s.splitBoot();
  assert.equal(second.nodes['.trade-wrap'].getAttribute('data-pane-deck'), 'hidden');

  // Shown again: the attribute goes, and so does the key. Shown is the default, so it is not
  // written down.
  assert.equal(second.s.splitPaneSet('deck', true), false);
  assert.equal(second.nodes['.trade-wrap'].getAttribute('data-pane-deck'), null);
  assert.equal(storage.map.has('phosphor.pane.deck'), false);
});

test('a toggle flips the pane, and a pane that is not in the table is refused', () => {
  const { s, nodes } = loadWithHosts();
  assert.equal(s.splitPaneToggle('chart'), true);
  assert.equal(nodes['.trade-wrap'].getAttribute('data-pane-chart'), 'hidden');
  assert.equal(s.splitPaneToggle('chart'), false);
  assert.equal(nodes['.trade-wrap'].getAttribute('data-pane-chart'), null);
  assert.equal(s.splitPaneSet('gate', false), false, 'there is no pane called gate');
});

test('storage that refuses everything still hides and shows a pane for the session', () => {
  const { s, nodes } = loadWithHosts(makeStorage(true));
  s.splitPaneSet('chart', false);
  assert.equal(s.splitPaneHidden('chart'), true);
  assert.equal(nodes['.trade-wrap'].getAttribute('data-pane-chart'), 'hidden');
  s.splitPaneSet('chart', true);
  assert.equal(s.splitPaneHidden('chart'), false);
});

test('a stored word that is not "hidden" leaves the pane on screen', () => {
  const storage = makeStorage();
  storage.map.set('phosphor.pane.chart', 'gone');
  const s = load(storage);
  assert.equal(s.splitPaneHidden('chart'), false);
});

test('the pane API is on the window under one name, for the headers and the bar\'s Layout menu', () => {
  const s = load();
  assert.equal(typeof s.PhosphorSplit.paneHidden, 'function');
  assert.equal(typeof s.PhosphorSplit.setPane, 'function');
  assert.equal(typeof s.PhosphorSplit.togglePane, 'function');
  assert.equal(typeof s.PhosphorSplit.panes, 'function');
  assert.equal(typeof s.PhosphorSplit.paneControl, 'function');
  assert.equal(s.PhosphorSplit.paneControl('deck'), null, 'no document to build a control in, so none');
});

test('two presses on a handle put it back to the stylesheet default', () => {
  const storage = makeStorage();
  const s = load(storage);
  s.window.dispatchEvent = () => {};
  s.CustomEvent = function (type: string) { return { type }; } as any;
  s.Event = function (type: string) { return { type }; } as any;

  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  h.lastDown = 0;
  s.splitWire(h);

  // One press, a drag, a release: the deck is 480 tall and the browser remembers.
  h.node.fire('pointerdown', { button: 0, clientY: 0, pointerId: 1 });
  s.splitApply(h, s.splitAt(h, -80));
  h.node.fire('pointerup', {});
  assert.equal(applied(h), 480);
  assert.equal(storage.map.get('phosphor.split.trade.deck-rail'), '480');

  // Two presses in a row, which is a double click on the handle.
  h.node.fire('pointerdown', { button: 0, clientY: 0, pointerId: 2 });
  h.node.fire('pointerdown', { button: 0, clientY: 0, pointerId: 3 });

  assert.equal(applied(h), null, 'the property is gone, so the CSS default is what shows');
  assert.equal(h.pane.getAttribute('data-sized'), null);
  assert.equal(storage.map.has('phosphor.split.pro.deck-agent'), false, 'and it is not remembered');
});

test('the way back: a restore control draws for its pane, names it, and shows it on a click', () => {
  const { s } = loadWithHosts();
  assert.equal(s.PhosphorSplit.paneRestore('deck'), null, 'no document to build a control in, so none');
  /* A document that can make an element: the control is one button wearing the eye. */
  const made: Any[] = [];
  s.document.createElement = (tag: string) => {
    const node: Any = { tag, attrs: {} as Record<string, string>, children: [] as Any[], listeners: {} as Record<string, Array<() => void>> };
    node.setAttribute = (k: string, v: string) => { node.attrs[k] = v; };
    node.getAttribute = (k: string) => node.attrs[k] ?? null;
    node.appendChild = (c: Any) => { node.children.push(c); };
    node.addEventListener = (kind: string, fn: () => void) => { (node.listeners[kind] = node.listeners[kind] || []).push(fn); };
    node.click = () => { (node.listeners.click || []).forEach((fn: () => void) => fn()); };
    made.push(node);
    return node;
  };
  s.PhosphorIcons = { svg: (name: string) => ({ icon: name }) };
  const back = s.PhosphorSplit.paneRestore('deck');
  assert.ok(back, 'no restore control');
  assert.equal(back.className, 'pane-show');
  assert.equal(back.getAttribute('data-pane'), 'deck');
  assert.equal(back.getAttribute('aria-label'), 'Show the positions and orders');
  assert.deepEqual(back.children, [{ icon: 'show' }]);
  s.PhosphorSplit.setPane('deck', false);
  assert.equal(s.PhosphorSplit.paneHidden('deck'), true);
  back.click();
  assert.equal(s.PhosphorSplit.paneHidden('deck'), false, 'the click did not bring the pane back');
  assert.equal(s.PhosphorSplit.paneRestore('conversation'), null, 'the conversation has no way back because it never goes');
  assert.equal(s.PhosphorSplit.paneRestore('nothing'), null);
});
