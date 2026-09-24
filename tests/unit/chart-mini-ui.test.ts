// The comparison charts: one read-only canvas per slot 1 to 3, in a grid beside the primary.
//
// The server keeps every slot as its own store and serves it on GET /api/chart?slot=n, a 404
// for a slot no layout has filled. Nothing tells the window the layout as a list, so the
// window probes the three slots on boot and on a timer while any are up, fetches one slot when
// a chart frame names it, and the grid follows what answered: one chart fills, two sit side by
// side, three and four go two by two.
//
// Run against the REAL ui/chart/mini.js over a stand-in DOM whose canvas records what was
// drawn, so what is asserted is the picture: candles, the server's plot lines, levels, drawn
// lines and zones, a header naming the coin and the timeframe, and a last price tag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const SOURCE = readFileSync(new URL('../../ui/chart/mini.js', import.meta.url), 'utf8');

/* A 2d context that writes down every call, so a test can count candles and read labels. */
function recorder(): Any {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ctx: Any = { calls, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic' };
  for (const op of ['setTransform', 'fillRect', 'clearRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillText', 'setLineDash', 'rect', 'clip', 'save', 'restore', 'closePath', 'arc']) {
    ctx[op] = (...args: unknown[]) => {
      calls.push({ op, args });
    };
  }
  ctx.measureText = (text: string) => ({ width: String(text).length * 6 });
  return ctx;
}

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const node: Any = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    style: {},
    childNodes: [],
    parentNode: null,
    clientWidth: 400,
    clientHeight: 240,
    width: 0,
    height: 0,
    get children() {
      return node.childNodes;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: Any, before: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      const at = before === null ? node.childNodes.length : node.childNodes.indexOf(before);
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: () => {},
  };
  if (tagName === 'canvas') {
    node.ctx = recorder();
    node.getContext = () => node.ctx;
  }
  return node;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function bars(count: number, base = 3000): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    out.push({ t: 1_760_000_400 + i * 14_400, o: base, h: base + 40, l: base - 40, c: up ? base + 20 : base - 20, v: 10 + i });
  }
  return out;
}

function slotPayload(slot: number, over: Any = {}): Any {
  const candles = bars(60);
  return {
    slot,
    rev: 3,
    lastDriver: 'agent',
    view: { product: 'ETH-USD', provider: 'auto', granularitySec: 14_400, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } },
    candles,
    meta: { source: 'hyperliquid', stale: false, built: 'candles', feed: 'live', error: null },
    indicators: [
      { id: 'ema_20', type: 'ema', label: 'ema 20', pane: 'price', source: 'agent', plots: [{ key: 'v', style: 'line', values: candles.map((c) => c.c - 5) }] },
      { id: 'rsi_14', type: 'rsi', label: 'rsi 14', pane: 'rsi', source: 'agent', plots: [{ key: 'v', style: 'line', values: candles.map(() => 50) }] },
    ],
    levels: [{ id: 'lv_1', price: 3010, label: 'support', source: 'agent' }],
    marks: [],
    drawings: [
      { id: 'c1_tl_1', kind: 'line', label: 'trend', source: 'agent', line: { a: { t: candles[10].t, price: 2980 }, b: { t: candles[50].t, price: 3020 } } },
      { id: 'c1_zn_1', kind: 'zone', label: 'demand', source: 'agent', zone: { high: 3005, low: 2990 } },
    ],
    agentObjects: 3,
    products: ['BTC-USD', 'ETH-USD'],
    timeframes: [{ sec: 60, label: '1m' }, { sec: 14_400, label: '4h' }],
    ...over,
  };
}

type World = {
  mini: Any;
  stage: Any;
  fetches: string[];
  frame: (payload: Any) => void;
  answers: Record<number, Any | null>;
  tick: (ms: number) => void;
  fresh: Record<number, boolean>;
  timer: () => void;
};

function build(answers: Record<number, Any | null>): World {
  const stage = makeNode('div');
  stage.id = 'panel-chart';
  const primary = makeNode('div');
  primary.id = 'chartwrap';
  stage.appendChild(primary);
  const fetches: string[] = [];
  const fresh: Record<number, boolean> = {};
  const streams: Any = {};
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const world: Any = { answers, fresh };
  const intervals: Array<() => void> = [];

  const sandbox: Any = {
    console,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    document: {
      createElement: (tag: string) => makeNode(tag),
      getElementById: (id: string) => (id === 'panel-chart' ? stage : null),
      documentElement: makeNode('html'),
    },
  };
  sandbox.window = {
    document: sandbox.document,
    devicePixelRatio: 2,
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 0;
    },
    PhosphorDom: { el: (tag: string, className?: string, text?: string) => {
      const n = makeNode(tag);
      if (className) n.className = className;
      if (text !== undefined) n.textContent = String(text);
      return n;
    }, setText: (n: Any, t: string) => { n.textContent = String(t); } },
    PhosphorEvents: {
      on: (type: string, fn: Any) => {
        streams[type] = fn;
        return () => {};
      },
    },
    PhosphorNet: {
      getJson: async (path: string) => {
        fetches.push(path);
        const slot = Number(new URL('http://x' + path).searchParams.get('slot'));
        const answer = world.answers[slot];
        if (answer === null || answer === undefined) {
          const err: Any = new Error('no chart in slot ' + slot);
          err.status = 404;
          throw err;
        }
        return { data: answer, fresh: world.fresh[slot] !== false, status: 200 };
      },
    },
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/chart/mini.js' });
  const mini = sandbox.window.PhosphorMini;
  return {
    mini,
    stage,
    fetches,
    frame: (payload: Any) => streams.chart && streams.chart(payload),
    answers,
    fresh,
    tick: (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
    },
    timer: () => {
      for (const fn of intervals) fn();
    },
  };
}

async function settle(): Promise<void> {
  // A few microtask turns, for the chain of slot fetches.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('boot probes the slots in order and puts up one chart per filled slot', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  assert.deepEqual(world.fetches, ['/api/chart?slot=1', '/api/chart?slot=2']);
  assert.equal(world.stage.dataset.n, '2');
  const minis = withClass(world.stage, 'mini');
  assert.equal(minis.length, 1);
  assert.equal(minis[0].dataset.slot, '1');
});

test('the header is the coin in the first tone and the timeframe in the third, and the last price', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  const [head] = withClass(world.stage, 'mini-head');
  const [coin] = withClass(head, 'mini-coin');
  const [tf] = withClass(head, 'mini-tf');
  assert.equal(coin.textContent, 'ETH');
  assert.equal(tf.textContent, '4h');
  const [last] = withClass(head, 'mini-last');
  // The newest close: bar 59 is odd, so it closed 20 under the base.
  assert.equal(last.textContent, '2,980.00');
  assert.ok(String(last.className).includes('mono'), 'a number not in the mono face');
});

test('the canvas carries the candles, the price plot, the level, the line and the zone, in Geist', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  const [canvas] = withClass(world.stage, 'mini-canvas');
  const calls = canvas.ctx.calls as Array<{ op: string; args: unknown[] }>;
  assert.ok(canvas.ctx.font.startsWith('11px "Geist"'), canvas.ctx.font);
  // 40 visible bars: each is a body (fillRect), so at least that many after the ground.
  const bodies = calls.filter((c) => c.op === 'fillRect').length;
  assert.ok(bodies >= 41, `${bodies} rects for 40 candles and the ground`);
  const labels = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
  // A marking's name is not printed over the candles here: its price docks on the axis in a
  // chip, the way the primary docks it.
  for (const name of ['support', 'trend', 'demand']) assert.ok(!labels.some((l) => l.startsWith(name)), `${name} printed over the candles: ${JSON.stringify(labels)}`);
  const texts = calls.filter((c) => c.op === 'fillText');
  const level = texts.find((c) => /^3,010/.test(String(c.args[0])));
  assert.ok(level, `the level's price is on the axis: ${JSON.stringify(labels)}`);
  assert.ok(Number(level.args[1]) > 300, 'in the axis gutter, right of the plot');
  // The plot line and the trend line are strokes; the sub-pane indicator is not drawn at all.
  assert.ok(calls.filter((c) => c.op === 'stroke').length >= 2);
  assert.ok(!labels.some((l) => l.includes('rsi')), 'a sub-pane indicator was drawn on a price-only canvas');
  // Device pixels: a 400 x 240 body at dpr 2.
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 480);
});

test('a chart frame for a slot refetches that slot and redraws it', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  const before = world.fetches.length;
  world.answers[1] = slotPayload(1, { view: { product: 'SOL-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } } });
  world.frame({ type: 'chart', rev: 4, slot: 1 });
  world.tick(60);
  await settle();
  assert.ok(world.fetches.length > before, 'the frame fetched nothing');
  const [coin] = withClass(world.stage, 'mini-coin');
  assert.equal(coin.textContent, 'SOL');
  assert.equal(withClass(world.stage, 'mini-tf')[0].textContent, '1m');
});

test('a layout that shrinks takes its charts down: the timer re-probes and a 404 removes the slot', async () => {
  // A slot that is gone sends no frame to say so, which is why the pass runs on a timer.
  const world = build({ 1: slotPayload(1), 2: slotPayload(2, { view: { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } } }), 3: null });
  world.mini.boot();
  await settle();
  assert.equal(world.stage.dataset.n, '3');
  assert.equal(withClass(world.stage, 'mini').length, 2);
  world.answers[1] = null;
  world.timer();
  await settle();
  assert.equal(world.stage.dataset.n, '1');
  assert.equal(withClass(world.stage, 'mini').length, 0);
  assert.equal(world.stage.childNodes[0].id, 'chartwrap', 'the primary is no longer the first thing on the stage');
});

test('a frame for the primary fetches nothing: a probe on every one would be a 404 in the console per frame', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  const before = world.fetches.length;
  world.frame({ type: 'chart', rev: 5, slot: 0 });
  world.frame({ type: 'chart', rev: 6 });
  world.tick(60);
  await settle();
  assert.equal(world.fetches.length, before);
});

test('a frame for a slot that has just been emptied takes that chart down without touching the others', async () => {
  const world = build({ 1: slotPayload(1), 2: slotPayload(2), 3: null });
  world.mini.boot();
  await settle();
  assert.equal(withClass(world.stage, 'mini').length, 2);
  world.answers[2] = null;
  world.frame({ type: 'chart', rev: 7, slot: 2 });
  world.tick(60);
  await settle();
  assert.deepEqual(withClass(world.stage, 'mini').map((m) => m.dataset.slot), ['1']);
  assert.equal(world.stage.dataset.n, '2');
});

test('three comparison charts make four, laid out two by two', async () => {
  const world = build({ 1: slotPayload(1), 2: slotPayload(2), 3: slotPayload(3) });
  world.mini.boot();
  await settle();
  assert.equal(world.stage.dataset.n, '4');
  assert.deepEqual(withClass(world.stage, 'mini').map((m) => m.dataset.slot), ['1', '2', '3']);
});

test('a burst of frames for one slot is one fetch, and an unchanged answer is not redrawn', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  const before = world.fetches.length;
  world.frame({ type: 'chart', rev: 5, slot: 1 });
  world.frame({ type: 'chart', rev: 6, slot: 1 });
  world.frame({ type: 'chart', rev: 7, slot: 1 });
  world.tick(60);
  await settle();
  assert.equal(world.fetches.length - before, 1, 'three frames inside 50 ms cost more than one fetch');
  const [canvas] = withClass(world.stage, 'mini-canvas');
  const drawn = canvas.ctx.calls.length;
  world.fresh[1] = false;
  world.frame({ type: 'chart', rev: 5, slot: 1 });
  world.tick(60);
  await settle();
  assert.equal(canvas.ctx.calls.length, drawn, 'a 304 repainted the canvas');
});

test('the canvas for a slot can be asked for, and a slot with no chart answers null', async () => {
  const world = build({ 1: slotPayload(1), 2: null });
  world.mini.boot();
  await settle();
  assert.equal(world.mini.canvasOf(1).className, 'mini-canvas');
  assert.equal(world.mini.canvasOf(2), null);
  assert.equal(world.mini.canvasOf(0), null);
});

test('nothing the server sends reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});
