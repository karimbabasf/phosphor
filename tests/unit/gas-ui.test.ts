// The GAS overlay draws a number a person is going to repeat out loud, so these tests are
// about the five ways it could be confidently wrong rather than about how it looks:
//
//   - a remainder dropped. Four categories cannot be counted (a receipt still being read, a
//     hash no chain we can reach knows, a move signed as an intent, a fee with no price) and
//     one is pure loss (reverted). Every one of them is printed when it is non-zero and NONE
//     of them is printed when it is zero, because "0 pending" is chrome and chrome is what
//     makes a person stop reading the line that matters;
//   - a slice priced at nothing reported as free. $0.00 in a column headed GAS reads as free
//     and means "no price was available";
//   - gas units rounded. They are a decimal string end to end because the sum goes past 2^53,
//     and one Number() anywhere in the print path silently loses the tail;
//   - a hardcoded colour. The ring reads its palette off the custom properties at draw time,
//     so a theme is one palette rather than two. The sentinel test below fails on any hex;
//   - the ring left animating. It sweeps once per open and holds an animation frame while it
//     does, and a frame that outlives the overlay paints into a canvas nobody can see.
//
// Driven through the file's own public surface in a vm with a small fake DOM and a recording
// canvas context, the same way tests/unit/agent-panel-ui.test.ts drives the agent panel. The
// data is a fixture of the spec 2.4 GasReport shape, never the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

function ui(name: string): string {
  return readFileSync(new URL('../../ui/' + name, import.meta.url), 'utf8');
}

/** The CSS box .gasring gives the canvas. The view falls back to its own copy of this number
 *  when the measure comes back zero, which is what a dialog does before showModal(). */
const RING_PX = 150;

/** Sentinels rather than colours. Anything the view paints that is not one of these came
 *  from a literal in the source, which is the thing the palette rule forbids. */
const SENTINEL: Record<string, string> = {
  '--green-hi': 'TOKEN/green-hi',
  '--green': 'TOKEN/green',
  '--green-dim': 'TOKEN/green-dim',
  '--green-faint': 'TOKEN/green-faint',
  '--green-ghost': 'TOKEN/green-ghost',
  '--bg': 'TOKEN/bg',
};

/** The real values, for the one test that has to see the derived tail arithmetic. */
const REAL: Record<string, string> = {
  '--green-hi': '#8cffab',
  '--green': '#33ff66',
  '--green-dim': 'rgba(51, 255, 102, 0.62)',
  '--green-faint': 'rgba(51, 255, 102, 0.38)',
  '--green-ghost': 'rgba(51, 255, 102, 0.22)',
  '--bg': '#0b0d0b',
};

function makeCtx(rec: Any): Any {
  const ctx: Any = {
    font: '',
    textAlign: '',
    textBaseline: '',
    lineWidth: 1,
    strokeStyle: '',
    beginPath() {},
    closePath() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    /* Every paint starts here, so the records hold ONE paint rather than every paint since
       the overlay opened. A sweep is several frames and summing three of them says the ring
       covers three circles. */
    clearRect() {
      rec.arcs = [];
      rec.texts = [];
      rec.filled = [];
      rec.stroked = [];
      rec.styles = [];
    },
    stroke() {
      rec.styles.push(ctx.strokeStyle);
      rec.stroked.push(ctx.strokeStyle);
    },
    fill() {
      rec.filled.push(ctx.fillStyle);
    },
    // The centre is not recorded because nothing here asserts on it: what the tests below
    // check is the geometry of the sweep, which is radius and the two angles. Named with
    // leading underscores so the signature still reads as the canvas API it is standing in
    // for, rather than being trimmed to the two arguments this happens to use.
    arc(_cx: number, _cy: number, r: number, a0: number, a1: number, ccw?: boolean) {
      rec.arcs.push({ r, a0, a1, ccw: Boolean(ccw) });
    },
    fillText(text: string, x: number, y: number) {
      rec.texts.push({ text: String(text), x, y, ink: ctx.fillStyle });
    },
    measureText(text: string) {
      // 11px monospace on this machine, near enough for the fit gate the view applies.
      return { width: String(text).length * 6.5 };
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      rec.transforms.push([a, b, c, d, e, f]);
    },
  };
  let fillStyle = '';
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (v: string) => {
      fillStyle = v;
      rec.styles.push(v);
    },
  });
  return ctx;
}

function makeNode(tag: string, created: Any[]): Any {
  let text = '';
  const rec: Any = { arcs: [], texts: [], filled: [], stroked: [], styles: [], transforms: [] };
  const node: Any = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {} as Any,
    attrs: {} as Record<string, string>,
    children: [] as Any[],
    listeners: {} as Record<string, Array<(ev: Any) => void>>,
    width: 0,
    height: 0,
    rec,
    appendChild(child: Any) {
      node.children.push(child);
      return child;
    },
    setAttribute(k: string, v: string) {
      node.attrs[k] = String(v);
    },
    getAttribute(k: string) {
      return node.attrs[k] ?? null;
    },
    addEventListener(kind: string, fn: (ev: Any) => void) {
      (node.listeners[kind] ??= []).push(fn);
    },
    fire(kind: string, ev: Any = {}) {
      for (const fn of node.listeners[kind] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
    },
    /* The LAYOUT box, which is what the view reads. A bounding rect would be the visual one
       and the overlay panel opens from transform: scale(0.95). */
    clientWidth: RING_PX,
    clientHeight: RING_PX,
    getBoundingClientRect: () => ({ width: RING_PX * 0.95, height: RING_PX * 0.95 }),
    getContext: () => (node.ctx ??= makeCtx(rec)),
    get textContent() {
      if (node.children.length === 0) return text;
      return node.children.map((c: Any) => c.textContent).join('');
    },
    set textContent(value: string) {
      text = String(value);
      node.children = [];
    },
  };
  created.push(node);
  return node;
}

function slice(key: string, feeUsd: number, gasUsed: string, txCount: number, moveCount: number, share: number): Any {
  return { key, label: key, feeUsd, feeNative: feeUsd / 2000, symbol: 'ETH', gasUsed, txCount, moveCount, share };
}

/** A spec 2.4 GasReport. Every remainder zero, so a test that wants one says so. */
function report(over: Any = {}): Any {
  return {
    window: '7d',
    fromTs: '2026-08-13T14:22:00.000Z',
    toTs: '2026-08-20T14:22:00.000Z',
    totalUsd: 1,
    totalGasUsed: '9007199254740993',
    txCount: 15,
    moveCount: 12,
    byAction: [
      slice('swap', 0.62, '600000', 6, 6, 0.62),
      slice('deposit', 0.21, '300000', 4, 4, 0.21),
      slice('withdraw', 0.16, '250000', 3, 3, 0.16),
      slice('transfer', 0.01, '40000', 1, 1, 0.01),
      slice('consolidate', 0, '14553', 1, 1, 0),
    ],
    byChain: [slice('arb', 0.7, '900000', 10, 9, 0.7), slice('base', 0.3, '304553', 5, 4, 0.3)],
    byKind: [],
    byVenue: [],
    reverted: { feeUsd: 0, txCount: 0 },
    unpriced: { txCount: 0, gasUsed: '0' },
    pending: { moveCount: 0 },
    unknown: { moveCount: 0 },
    intentOnly: { moveCount: 0 },
    movedUsd: 1400,
    gasBps: 7.14,
    venueFeeUsd: 0,
    ...over,
  };
}

interface Harness {
  views: Any;
  box: Any;
  errors: string[];
  urls: string[];
  frames: number;
  answer: Any;
  fail: { status: number } | null;
  open(): Promise<void>;
  settle(): Promise<void>;
  frame(ts: number): void;
  pending(): number;
  unit(i: number): Any;
  rows(i: number): string[][];
  notes(): Array<{ cls: string; text: string }>;
  windows(): Any[];
}

function load(opts: { tokens?: Record<string, string>; reduced?: boolean; dpr?: number } = {}): Harness {
  const created: Any[] = [];
  const tokens = opts.tokens ?? SENTINEL;
  const queue: Array<{ id: number; fn: (ts: number) => void }> = [];
  let nextFrame = 1;

  const state: Any = { urls: [], errors: [], answer: report(), fail: null, frames: 0 };

  const document: Any = {
    createElement: (tag: string) => makeNode(tag, created),
    createTextNode: (value: string) => {
      const n = makeNode('#text', created);
      n.textContent = String(value);
      return n;
    },
  };

  const sandbox: Any = {
    document,
    console,
    devicePixelRatio: opts.dpr ?? 1,
    matchMedia: () => ({ matches: Boolean(opts.reduced) }),
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => tokens[name] ?? '',
      color: tokens['--green'] ?? '',
    }),
    requestAnimationFrame: (fn: (ts: number) => void) => {
      const id = nextFrame++;
      queue.push({ id, fn });
      state.frames++;
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      const i = queue.findIndex((f) => f.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    fetch: (url: string) => {
      state.urls.push(url);
      if (state.fail) return Promise.resolve({ ok: false, status: state.fail.status, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state.answer) });
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(ui('deck-views.js'), sandbox, { filename: 'ui/deck-views.js' });

  const box = makeNode('div', created);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };

  const harness: Harness = {
    views: sandbox.PhosphorViews,
    box,
    get errors() {
      return state.errors;
    },
    get urls() {
      return state.urls;
    },
    get frames() {
      return state.frames;
    },
    get answer() {
      return state.answer;
    },
    set answer(v: Any) {
      state.answer = v;
    },
    get fail() {
      return state.fail;
    },
    set fail(v: { status: number } | null) {
      state.fail = v;
    },
    async open() {
      sandbox.PhosphorViews.gas(box, (msg: string) => state.errors.push(msg));
      await settle();
    },
    settle,
    frame(ts: number) {
      const next = queue.shift();
      if (next) next.fn(ts);
    },
    pending: () => queue.length,
    unit(i: number) {
      const wrap = box.children[1].children[i];
      const body = wrap.children[1];
      return { head: wrap.children[0], canvas: body.children[0], rows: body.children[1].children[0].children[1] };
    },
    rows(i: number) {
      return harness
        .unit(i)
        .rows.children.map((tr: Any) => tr.children.map((td: Any) => td.textContent));
    },
    notes() {
      return box.children[2].children.map((n: Any) => ({ cls: n.className, text: n.textContent }));
    },
    windows() {
      return box.children[0].children[0].children;
    },
  };
  return harness;
}

/* ---------- the shape of it ---------- */

test('one endpoint, one auth path, and the window is the only argument', async () => {
  const h = load();
  await h.open();
  assert.deepEqual(h.urls, ['/api/gas?window=7d'], 'opens on the endpoint default, through getJson');
  const source = ui('deck-views.js');
  assert.equal((source.match(/innerHTML|insertAdjacentHTML/g) ?? []).length, 0, 'this file assigns no markup, ever');
});

test('the table is the authority: every slice is in it, including the ones the ring cannot label', async () => {
  const h = load();
  await h.open();
  const rows = h.rows(0);
  assert.equal(rows.length, 5, 'all five action slices, not just the labelled ones');
  assert.deepEqual(rows[0], ['swap', '$0.62', '62.00%', '600,000', '6']);
  assert.deepEqual(rows[3], ['transfer', '$0.01', '1.00%', '40,000', '1']);
  assert.deepEqual(h.rows(1).map((r) => r[0]), ['arb', 'base'], 'and the chain ring has its own table');
});

test('a sub-cent bill is printed to four places, in the table and in the hole in the ring', async () => {
  const h = load();
  h.answer = report({
    totalUsd: 0.0004,
    byAction: [slice('swap', 0.0003, '600000', 6, 6, 0.75), slice('transfer', 0.0001, '40000', 1, 1, 0.25)],
  });
  await h.open();
  h.frame(0);
  h.frame(1000);
  assert.deepEqual(h.rows(0)[0], ['swap', '$0.0003', '75.00%', '600,000', '6'], '$0.00 in a column headed GAS reads as free');
  const centre = h.unit(0).canvas.rec.texts.map((t: Any) => t.text);
  assert.ok(centre.includes('$0.0004'), 'and the middle of the ring holds the same figure: ' + centre.join(' '));
});

test('a slice with no price says unpriced rather than $0.00', async () => {
  const h = load();
  await h.open();
  const row = h.rows(0)[4];
  assert.deepEqual(row, ['consolidate', 'unpriced', '0.00%', '14,553', '1']);
  assert.ok(!row.includes('$0.00'), 'free and unpriced are different facts');
});

test('gas units survive the print path: no Number() rounds the tail off', async () => {
  const h = load();
  await h.open();
  const line = h.notes().find((n) => n.text.indexOf('gas units, over') >= 0);
  assert.ok(line, 'the total in units is printed');
  // 2^53 + 1. Through Number() this prints ...992 and the last digit is silently lost.
  assert.match(line!.text, /9,007,199,254,740,993 gas units, over 15 transactions\./);
});

/* ---------- the remainders ---------- */

test('a remainder that is zero prints nothing', async () => {
  const h = load();
  await h.open();
  const text = h.notes().map((n) => n.text).join('\n');
  for (const word of ['still reading', 'unknown:', 'signed as an intent', 'unpriced:', 'REVERTED']) {
    assert.ok(text.indexOf(word) < 0, '"' + word + '" is chrome when its count is zero');
  }
  assert.match(text, /gas cost 7\.1 bp of the \$1,400\.00 this app moved\./);
});

test('every remainder that is non-zero prints, and reverted is the red one', async () => {
  const h = load();
  h.answer = report({
    reverted: { feeUsd: 0.04, txCount: 2 },
    unpriced: { txCount: 3, gasUsed: '14553' },
    pending: { moveCount: 4 },
    unknown: { moveCount: 1 },
    intentOnly: { moveCount: 2 },
    venueFeeUsd: 12.5,
  });
  await h.open();
  const notes = h.notes();
  const text = notes.map((n) => n.text).join('\n');
  assert.match(text, /REVERTED: \$0\.04 burned on 2 transactions that moved nothing\./);
  assert.match(text, /still reading: 4 movements whose receipts have not landed\./);
  assert.match(text, /no chain this app can reach has a receipt for 1 movement\./);
  assert.match(text, /2 movements were signed as an intent: no gas of ours, settled by a solver\./);
  assert.match(text, /unpriced: 3 transactions burned 14,553 gas units/);
  assert.match(text, /venue fees \$12\.50/);
  const revert = notes.find((n) => n.text.indexOf('REVERTED') === 0);
  assert.equal(revert!.cls, 'gasnote red', 'the only pure loss on this surface is the only red on it');
});

test('no denominator is said out loud rather than printed as zero', async () => {
  const h = load();
  h.answer = report({ gasBps: null, movedUsd: 0 });
  await h.open();
  const text = h.notes().map((n) => n.text).join('\n');
  assert.match(text, /nothing moved in this window, so there is nothing to weigh the gas against\./);
  assert.ok(text.indexOf(' bp of ') < 0, 'and never a bp figure with nothing under the line');
});

/* ---------- the ring ---------- */

test('the canvas is announced, and what it announces is the top of the table', async () => {
  const h = load();
  await h.open();
  const label = h.unit(0).canvas.getAttribute('aria-label');
  assert.equal(h.unit(0).canvas.getAttribute('role'), 'img');
  assert.match(label, /^Gas by action, the last 7 days\. \$1\.00 in total\. Largest: swap 62\.00%, deposit 21\.00%, withdraw 16\.00%\./);
  assert.ok(label.indexOf('transfer') < 0, 'three slices, not nineteen');
  assert.match(label, /The table beside this ring holds every slice\./);
  assert.match(h.unit(1).canvas.getAttribute('aria-label'), /^Gas by chain, /);
});

test('a slice under two percent gets no label on the ring, and lives in the table', async () => {
  const h = load();
  await h.open();
  h.frame(0);
  h.frame(1000);
  const drawn = h.unit(0).canvas.rec.texts.map((t: Any) => t.text);
  assert.ok(drawn.includes('swap'), 'the largest slice is labelled');
  assert.ok(drawn.includes('withdraw'), 'and so is a sixteen percent one');
  assert.ok(!drawn.includes('transfer'), 'one percent is a label overlapping its neighbour');
  assert.ok(!drawn.includes('consolidate'), 'and a zero slice has no arc to sit on');
  assert.ok(drawn.includes('$1.00'), 'the total is in the hole in the middle');
  assert.ok(h.rows(0).some((r) => r[0] === 'transfer'), 'the unlabelled slice is in the table');

  // A label the colour of the slice under it is a label nobody can read. The two brightest
  // steps are near solid, so they take the ground colour; everything below takes bright ink.
  const ink = (text: string) => h.unit(0).canvas.rec.texts.find((t: Any) => t.text === text).ink;
  assert.equal(ink('swap'), SENTINEL['--bg'], 'dark ink on the brightest slice');
  assert.equal(ink('withdraw'), SENTINEL['--green-hi'], 'and bright ink once the slice goes faint');
});

test('every colour the ring paints came off a custom property', async () => {
  const h = load();
  await h.open();
  h.frame(0);
  h.frame(1000);
  const allowed = new Set(Object.values(SENTINEL));
  for (const i of [0, 1]) {
    for (const style of h.unit(i).canvas.rec.styles) {
      assert.ok(allowed.has(style), 'painted ' + JSON.stringify(style) + ', which is not a token off the page');
    }
    assert.ok(h.unit(i).canvas.rec.filled.length > 0, 'and it did paint');
  }
});

test('past the ladder the tail is derived from one token, not invented', async () => {
  const h = load({ tokens: REAL });
  h.answer = report({
    byAction: [0.3, 0.25, 0.15, 0.12, 0.09, 0.06, 0.03].map((v, i) => slice('a' + i, v, '1000', 1, 1, v)),
  });
  await h.open();
  h.frame(0);
  h.frame(1000);
  const filled = h.unit(0).canvas.rec.filled;
  assert.deepEqual(filled.slice(0, 5), [REAL['--green-hi'], REAL['--green'], REAL['--green-dim'], REAL['--green-faint'], REAL['--green-ghost']], 'the ladder first, brightest at the top');
  const tail = filled.slice(5, 7).map((v: string) => /^rgba\(51, 255, 102, ([\d.]+)\)$/.exec(v));
  assert.ok(tail[0] && tail[1], 'the tail is opacity steps of --green: ' + filled.slice(5, 7).join(' '));
  const alphas = tail.map((m: RegExpExecArray | null) => Number(m![1]));
  assert.ok(alphas[0] < 0.22 && alphas[1] < alphas[0], 'and it keeps going down: ' + alphas.join(' > '));
});

test('the backing store follows devicePixelRatio', async () => {
  const h = load({ dpr: 2 });
  await h.open();
  h.frame(0);
  const canvas = h.unit(0).canvas;
  assert.equal(canvas.width, RING_PX * 2, 'two device pixels per CSS pixel');
  assert.equal(canvas.height, RING_PX * 2);
  assert.deepEqual(canvas.rec.transforms[0], [2, 0, 0, 2, 0, 0], 'and the context is scaled back to CSS units');
});

/* ---------- the motion, which is rationed ---------- */

test('the ring sweeps in once and lands on a full circle', async () => {
  const h = load();
  await h.open();
  const canvas = h.unit(0).canvas;

  h.frame(0);
  assert.equal(canvas.rec.arcs.filter((a: Any) => !a.ccw).length, 0, 'nothing is drawn at the start of the sweep');

  h.frame(150);
  const half = canvas.rec.arcs.filter((a: Any) => !a.ccw).reduce((n: number, a: Any) => n + (a.a1 - a.a0), 0);
  assert.ok(half > 0 && half < Math.PI * 2 - 0.2, 'and part of it in the middle: ' + half);

  h.frame(300);
  assert.equal(h.pending(), 0, 'the sweep stops scheduling once it lands');
  const arcs = canvas.rec.arcs.filter((a: Any) => !a.ccw && a.r > 50);
  const swept = arcs.reduce((n: number, a: Any) => n + (a.a1 - a.a0), 0);
  assert.ok(swept > Math.PI * 2 - 0.15 && swept <= Math.PI * 2, 'a full ring, less the hairline trims: ' + swept);
});

test('a refresh under an open overlay redraws and never sweeps again', async () => {
  const h = load();
  await h.open();
  h.frame(0);
  h.frame(150);
  h.frame(300);
  const canvas = h.unit(0).canvas;
  canvas.rec.arcs.length = 0;

  await h.views.gasRefresh();
  await h.settle();
  h.frame(400);
  assert.equal(h.pending(), 0, 'one frame, not an animation');
  const swept = canvas.rec.arcs
    .filter((a: Any) => !a.ccw && a.r > 50)
    .reduce((n: number, a: Any) => n + (a.a1 - a.a0), 0);
  assert.ok(swept > Math.PI * 2 - 0.15, 'and it is the finished ring, not a second count-up: ' + swept);
});

test('prefers-reduced-motion draws the final state directly', async () => {
  const h = load({ reduced: true });
  await h.open();
  h.frame(0);
  assert.equal(h.pending(), 0, 'one frame and no more');
  const swept = h
    .unit(0)
    .canvas.rec.arcs.filter((a: Any) => !a.ccw && a.r > 50)
    .reduce((n: number, a: Any) => n + (a.a1 - a.a0), 0);
  assert.ok(swept > Math.PI * 2 - 0.15, 'the whole ring on the first frame: ' + swept);
  assert.ok(h.unit(0).canvas.rec.texts.some((t: Any) => t.text === 'swap'), 'labels included');
});

test('closing cancels the frame it was holding', async () => {
  const h = load();
  await h.open();
  assert.equal(h.pending(), 1, 'a sweep is queued while it is open');
  h.views.gasClosed();
  assert.equal(h.pending(), 0, 'a frame that outlives the overlay paints into a detached canvas');
  h.urls.length = 0;
  await h.views.gasRefresh();
  assert.deepEqual(h.urls, [], 'and a shut overlay reads nothing');
});

/* ---------- the window selector ---------- */

test('the window selector refetches, and never leaves the old numbers under the new button', async () => {
  const h = load();
  await h.open();
  const buttons = h.windows();
  assert.deepEqual(buttons.map((b: Any) => b.textContent), ['24H', '7D', '30D', 'ALL']);
  assert.equal(buttons[1].className, 'tf on', '7d is the default and says so');

  h.fail = { status: 503 };
  buttons[2].fire('click');
  assert.deepEqual(h.urls[1], '/api/gas?window=30d');
  assert.equal(h.windows()[2].className, 'tf on', 'the pressed window is the lit one');
  assert.deepEqual(h.rows(0)[0], ['reading...'], 'the old window is cleared rather than left to read as the new one');
  await h.settle();
  assert.deepEqual(h.errors, ['cannot read the gas report: /api/gas?window=30d returned 503']);
});

test('a failed read reports through the caller onError path', async () => {
  const h = load();
  h.fail = { status: 500 };
  await h.open();
  assert.deepEqual(h.errors, ['cannot read the gas report: /api/gas?window=7d returned 500']);
  assert.deepEqual(h.rows(0)[0], ['reading...'], 'and it says nothing it does not know');
});

/* ---------- the button, on both decks ---------- */

test('GAS is the fourth button on both deck bars, and both decks wire it the same way', () => {
  for (const file of ['index.html', 'trade.html']) {
    const html = ui(file);
    const bar = html.slice(html.indexOf('<p class="deckbar">'), html.indexOf('</p>', html.indexOf('<p class="deckbar">')));
    const ids = [...bar.matchAll(/id="(open-[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['open-log', 'open-policy', 'open-history', 'open-gas'], file + ' has GAS fourth');
    assert.match(bar, /id="open-gas" aria-haspopup="dialog">\[ GAS \]</, file + ' builds it like its siblings');
  }
  for (const file of ['app.js', 'trade.js']) {
    const source = ui(file);
    assert.match(source, /\{ id: 'open-gas', open: openGasOverlay \}/, file + ' wires the button');
    assert.match(source, /onClose: PhosphorViews\.gasClosed/, file + ' tears the view down on close');
    assert.match(source, /PhosphorViews\.gasRefresh\(\)/, file + ' refreshes it when a receipt lands');
  }
});
