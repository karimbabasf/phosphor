// The Basic column's one moment of pleasure, and what keeps it honest.
//
// Basic is a quiet number, one sentence, a rules strip and a list. This pass added three things
// and each of them is a place to lie to someone who has never held a wallet: a delta line that
// must never show a number the frame did not carry, an allocation bar that must add up, and a
// change tint that must land on the row that moved and leave again.
//
// It drives the real ui/screens/basic.js (with ui/core/dom.js, ui/core/state.js and
// ui/design/marks.js beside it) against a DOM small enough to read: the node operations those
// files use, nothing more, so the assertions are about the column rather than a framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const DOM_SOURCE = read('../../ui/core/dom.js');
const STATE_SOURCE = read('../../ui/core/state.js');
const MARKS_SOURCE = read('../../ui/design/marks.js');
const BASIC_SOURCE = read('../../ui/screens/basic.js');

function make(tag: string): Any {
  const props: Record<string, string> = {};
  const node: Any = {
    tag,
    className: '',
    children: [] as Any[],
    parentNode: null as Any | null,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    hidden: false,
    style: {
      props,
      setProperty: (name: string, value: string) => { props[name] = value; },
      removeProperty: (name: string) => { delete props[name]; },
    },
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 400,
    __on: {} as Record<string, Array<(event?: unknown) => void>>,
  };
  Object.defineProperty(node, 'textContent', {
    get(): string {
      if (node.children.length === 0) return node.__text ?? '';
      return node.children.map((c: Any) => c.textContent).join('');
    },
    set(value: string) {
      node.children.length = 0;
      node.__text = String(value);
    },
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null });
  Object.defineProperty(node, 'nextSibling', {
    get(): Any | null {
      const parent = node.parentNode;
      if (!parent) return null;
      const at = parent.children.indexOf(node);
      return at === -1 ? null : parent.children[at + 1] ?? null;
    },
  });
  node.appendChild = (child: Any) => node.insertBefore(child, null);
  node.insertBefore = (child: Any, before: Any) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? node.children.length : node.children.indexOf(before);
    node.children.splice(at === -1 ? node.children.length : at, 0, child);
    child.parentNode = node;
    return child;
  };
  node.removeChild = (child: Any) => {
    const at = node.children.indexOf(child);
    if (at !== -1) node.children.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  node.setAttribute = (name: string, value: string) => { node.attrs[name] = String(value); };
  node.getAttribute = (name: string) => (name in node.attrs ? node.attrs[name] : null);
  node.hasAttribute = (name: string) => name in node.attrs;
  node.removeAttribute = (name: string) => { delete node.attrs[name]; };
  node.addEventListener = (type: string, handler: (event?: unknown) => void) => {
    (node.__on[type] ??= []).push(handler);
  };
  node.removeEventListener = () => {};
  node.querySelector = () => null;
  return node;
}

/* Every node carrying a class, flattened: the query language here is "which rows are in it".
   An svg built in its namespace takes its class by attribute, so both spellings count. */
function all(node: Any, className: string, found: Any[] = []): Any[] {
  const classes = `${node.className} ${node.attrs.class ?? ''}`.split(' ');
  if (classes.includes(className)) found.push(node);
  for (const child of node.children) all(child, className, found);
  return found;
}

function holding(name: string, valueUsd: number, quantityLine: string): Any {
  return { name, valueUsd, valueLine: `$${valueUsd.toFixed(2)}`, quantityLine };
}

function frame(totalUsd: number | null, holdings: Any[]): Any {
  return {
    basic: { totalUsd, totalLine: totalUsd === null ? 'still checking' : `$${totalUsd.toFixed(2)}`, holdings, warning: null },
    policy: { outbound: { humanClickAboveUsd: 100, maxPerTransactionUsd: 10000, maxPerSessionUsd: 25000 } },
    proposals: [],
    lock: { state: 'unlocked' },
    wallet: { stale: [] },
  };
}

function build() {
  const host = make('section');
  const timers: Array<{ id: number; fn: () => void }> = [];
  let seq = 0;
  const win: Any = {
    setTimeout: (fn: () => void) => { seq += 1; timers.push({ id: seq, fn }); return seq; },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at !== -1) timers.splice(at, 1);
    },
    addEventListener: () => {},
    PhosphorMotion: { reduced: () => false },
    PhosphorReceipts: { onChange: () => {}, load: () => {}, get: () => [], render: () => {} },
    PhosphorMoneyIn: { render: () => {} },
  };
  const sandbox: Any = {
    console,
    window: win,
    document: {
      createElement: (tag: string) => make(tag),
      createElementNS: (_ns: string, tag: string) => make(tag),
      getElementById: (id: string) => (id === 'view-basic' ? host : null),
    },
  };
  createContext(sandbox);
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE_SOURCE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(MARKS_SOURCE, sandbox, { filename: 'ui/design/marks.js' });
  runInContext(BASIC_SOURCE, sandbox, { filename: 'ui/screens/basic.js' });
  win.PhosphorBasic.boot();

  return {
    host,
    put: (state: Any) => win.PhosphorState.put(state),
    delta: () => all(host, 'hero-delta')[0],
    balance: () => all(host, 'balance')[0],
    bar: () => all(host, 'alloc')[0],
    segments: () => all(host, 'alloc-seg'),
    strip: () => all(host, 'strip')[0],
    rows: () => all(host, 'row').filter((row) => row.parentNode === all(host, 'panel-body-flush')[0]),
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.fn();
    },
  };
}

const COINS = [
  holding('US dollars (USDC)', 750, '750.00'),
  holding('Ether (ETH)', 250, '0.06'),
];

test('the balance keeps its tick, and the delta line waits for a change that is real', () => {
  const world = build();
  world.put(frame(1000, COINS));
  assert.ok(world.balance().className.split(' ').includes('tick'), 'the total lost the tick class');
  assert.equal(world.balance().textContent, '$1000.00');
  assert.equal(world.delta().hidden, true, 'the first total is the mark, not a change');

  world.put(frame(1000.42, COINS));
  assert.equal(world.delta().hidden, false);
  assert.equal(world.delta().textContent, '+$0.42 since you opened');
  assert.equal(world.delta().getAttribute('data-dir'), 'up');

  world.put(frame(999.5, COINS));
  assert.equal(world.delta().textContent, '-$0.50 since you opened');
  assert.equal(world.delta().getAttribute('data-dir'), 'down');

  /* Back to where it opened: nothing to say, so nothing is said. */
  world.put(frame(1000, COINS));
  assert.equal(world.delta().hidden, true);
});

test('a total the frame could not settle is not a number, so the delta waits and the mark holds', () => {
  const world = build();
  world.put(frame(1000, COINS));
  world.put(frame(null, COINS));
  assert.equal(world.delta().hidden, true, 'a null total was compared as if it were zero');
  /* The mark is still the first real total, not the null that came between. */
  world.put(frame(1001, COINS));
  assert.equal(world.delta().textContent, '+$1.00 since you opened');
});

test('the allocation bar is one segment per listed coin, by share, in the coin colour', () => {
  const world = build();
  world.put(frame(1000.75, [...COINS, holding('Dust', 0.75, '0.75')]));
  const segments = world.segments();
  assert.equal(world.bar().hidden, false);
  assert.equal(segments.length, 2, 'dust under a dollar is counted, not drawn');
  assert.equal(segments[0].style.flexGrow, '0.75');
  assert.equal(segments[1].style.flexGrow, '0.25');
  assert.equal(segments[0].style.props['--coin'], '#2775CA');
  assert.equal(segments[1].style.props['--coin'], '#627EEA');

  /* A coin with no brand colour leaves the property unset and the stylesheet falls back. */
  world.put(frame(1000, [holding('XUSD', 600, '600.00'), holding('Ether (ETH)', 400, '0.1')]));
  assert.equal(world.segments()[0].style.props['--coin'], undefined);

  /* One coin makes no shape. */
  world.put(frame(600, [holding('XUSD', 600, '600.00')]));
  assert.equal(world.bar().hidden, true);
  assert.equal(world.segments().length, 0);
});

test('a row whose value moved carries its delta and its tint for a beat, then settles', () => {
  const world = build();
  world.put(frame(1000, COINS));
  const eth = world.rows()[1];
  assert.equal(eth.dataset.changed, undefined, 'the first fill is not a change');
  assert.equal(eth.style.props['--coin'], '#627EEA', 'the row does not carry its coin colour');

  world.put(frame(1010.5, [COINS[0], holding('Ether (ETH)', 260.5, '0.06')]));
  assert.equal(world.rows()[1], eth, 'the row lost its identity across a render');
  assert.equal(eth.dataset.changed, 'true');
  const delta = all(eth, 'row-delta')[0];
  assert.equal(delta.textContent, '+$10.50');
  assert.equal(delta.getAttribute('data-dir'), 'up');
  assert.equal(world.rows()[0].dataset.changed, undefined, 'a row that did not move was marked');

  world.runTimers();
  assert.equal(eth.dataset.changed, undefined, 'the tint never left');
});

test('the rules strip keeps its surface and its sentence, with the hand at its left', () => {
  const world = build();
  world.put(frame(1000, COINS));
  const strip = world.strip();
  assert.equal(strip.dataset.surface, 'rules');
  assert.equal(all(strip, 'strip-glyph').length, 1, 'no hand on the strip');
  assert.equal(all(strip, 'strip-text')[0].textContent,
    'Asks you above $100. Refuses above $10,000 at once and $25,000 a day.');
});
