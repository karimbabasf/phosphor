// The splitters let a person rearrange a window that holds a signing key, so these tests are
// not about whether the drag feels nice. They are about the four things that make a resizable
// deck safe to ship:
//
//   - a pane cannot be dragged to nothing, and the APPROVAL GATE's floor is bigger than the
//     rest. A gate dragged out of sight is a window arranged to hide the one control that
//     stops money moving, and it is the reason the minimums exist at all;
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

test('the rail has a floor, and a drag that asks for zero lands on it', () => {
  const s = load();
  // One handle in the window now. Pro is a grid and basic is a column, so
  // neither needs dragging; trade keeps its rail and it is the only thing a
  // pointer can squeeze.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 400);

  // The pointer is thrown at the far edge of the window: the rail, gone.
  s.splitApply(h, s.splitAt(h, 2000));

  assert.equal(applied(h), s.SPLIT_PAGES.trade['deck-rail'].min, 'the rail stops at its floor');
  assert.ok(applied(h)! >= 320, 'and the floor keeps a forced-close line on one line');
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
  // Raised from the old table: 320 keeps the rail's longest line unwrapped and
  // 620 keeps the chart wide enough to hold the bars its own controls offer.
  assert.equal(s.SPLIT_PAGES.trade['deck-rail'].min, 320);
  assert.equal(s.SPLIT_PAGES.trade['deck-rail'].giveMin, 620);
});

test('a pane cannot be grown past the point where its neighbour hits its own floor', () => {
  const s = load();
  // The rail is 400 wide and the chart has 900: the chart's floor is 620, so
  // there are 280 pixels to take and not one more. The rail sits on the RIGHT,
  // so the drag that grows it runs left, which is why the signs read backwards.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 0);

  assert.equal(s.splitAt(h, -60), 460, 'a small drag moves the boundary one for one');
  assert.equal(s.splitAt(h, -5000), 680, 'a big one stops where the chart would be squeezed');
  assert.equal(s.splitAt(h, 5000), 320, 'and the other way, at the rail own floor');
});

test('a handle whose pointer runs the other way still grows the right pane', () => {
  const s = load();
  // The rail is a right-hand pane, so dragging the pointer LEFT makes it wider.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitBegin(h, 0);

  assert.equal(s.splitAt(h, -60), 460, 'left widens the rail');
  assert.equal(s.splitAt(h, 60), 340, 'right narrows it');
  assert.equal(s.splitAt(h, 5000), 320, 'and it stops at its floor');
});

test('a size survives a reload, and a reset forgets it', () => {
  const storage = makeStorage();

  const first = load(storage);
  const h = handle(first, 'trade', 'deck-rail', { pane: 400, give: 900 });
  first.splitBegin(h, 0);
  first.splitApply(h, first.splitAt(h, -140)); // dragged left: the rail grew by 140
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
  storage.setItem('phosphor.split.trade.deck-rail', '900');

  const s = load(storage);
  // A much smaller window: 400 in the rail, 900 in the chart, the chart's floor 620.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 900 });
  s.splitRestore(h);

  assert.equal(applied(h), 680, 'clamped to what this window can give');
  assert.equal(
    storage.map.get('phosphor.split.trade.deck-rail'),
    '900',
    'the size chosen on the bigger screen is still there for when it comes back',
  );
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

  s.splitKeydown(h, { key: 'ArrowLeft', preventDefault() {} });
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

  s.splitKeydown(h, { key: 'ArrowRight', preventDefault() {} });
  assert.equal(applied(h), 384, 'right narrows a right-hand pane, the way dragging right does');
});

test('a handle with no neighbour to take from can still take the spare room, and no more', () => {
  const s = load();
  // No slack at all: the chart is already on its own floor, so the rail has
  // nothing left to take.
  const h = handle(s, 'trade', 'deck-rail', { pane: 400, give: 620 });
  s.splitBegin(h, 0);
  assert.equal(s.splitAt(h, -5000), 400, 'there is nothing to take, so nothing moves');
  assert.equal(s.splitAt(h, 5000), 320, 'and it can always be given back, down to the floor');
});

test('a window too small for both floors keeps the safety surface', () => {
  const s = load();
  // The pane is already under its own floor and there is nothing to take.
  assert.equal(s.splitClamp(20, 320, 40), 320, 'the floor wins a contradiction');
  assert.equal(s.splitClamp(900, 320, 40), 320);
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

  // One press, a drag, a release: the rail is 480 wide and the browser remembers.
  h.node.fire('pointerdown', { button: 0, clientX: 0, pointerId: 1 });
  s.splitApply(h, s.splitAt(h, -80));
  h.node.fire('pointerup', {});
  assert.equal(applied(h), 480);
  assert.equal(storage.map.get('phosphor.split.trade.deck-rail'), '480');

  // Two presses in a row, which is a double click on the handle.
  h.node.fire('pointerdown', { button: 0, clientX: 0, pointerId: 2 });
  h.node.fire('pointerdown', { button: 0, clientX: 0, pointerId: 3 });

  assert.equal(applied(h), null, 'the property is gone, so the CSS default is what shows');
  assert.equal(h.pane.getAttribute('data-sized'), null);
  assert.equal(storage.map.has('phosphor.split.pro.deck-agent'), false, 'and it is not remembered');
});
