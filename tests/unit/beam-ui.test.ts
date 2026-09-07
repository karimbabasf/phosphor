// The beam's two properties, and neither is a tidiness preference.
//
// One: what happens ON a surface is an attribute and one appended child.
// components.css owns every pixel of the glow and the scan, so a theme change
// or a reduced-motion preference reaches them without this file knowing. A
// style property written here would be a second place the look lives.
//
// Two: the loop reads no layout. Rects are read at fire time, once, and the
// flight runs off those numbers. A getBoundingClientRect inside a draw is a
// forced synchronous layout at display rate, which is the exact cost the
// performance audit found in the chart and told the rebuild not to repeat.
//
// The stub DOM below counts layout reads, so both are asserted by running the
// file rather than by reading it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/beam/beam.js', import.meta.url), 'utf8');

type Any = Record<string, any>;

let rectReads = 0;

/* A DOM small enough to read and honest about the parts the beam touches:
   attributes, children, the parent chain, and the two layout properties. */
function makeEl(tag: string, id = ''): Any {
  const el: Any = {
    tagName: tag,
    id,
    className: '',
    attrs: Object.create(null) as Any,
    children: [] as Any[],
    parentNode: null as Any,
    styles: Object.create(null) as Any,
    offsetHeight: 220,
    style: {
      setProperty(name: string, value: string) {
        el.styles[name] = value;
      },
    },
    setAttribute(name: string, value: string) {
      el.attrs[name] = String(value);
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    removeAttribute(name: string) {
      delete el.attrs[name];
    },
    appendChild(child: Any) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child: Any) {
      const at = el.children.indexOf(child);
      if (at >= 0) el.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    getBoundingClientRect() {
      rectReads += 1;
      return { left: 10, top: 20, width: 300, height: 200 };
    },
  };
  return el;
}

type World = {
  sandbox: Any;
  beam: Any;
  doc: Any;
  el: (id: string) => Any;
  frame: (now: number) => void;
  draws: () => number;
};

/* The window the beam expects: a stage, a conversation, three tabs, and two
   views, one on screen and one behind it. That is enough to exercise every
   branch of surface(). */
function build(options: { reduced?: boolean } = {}): World {
  rectReads = 0;

  const nodes = new Map<string, Any>();
  function add(tag: string, id: string, surface: string | null, parent: Any | null): Any {
    const el = makeEl(tag, id);
    if (surface) el.setAttribute('data-surface', surface);
    if (parent) parent.appendChild(el);
    nodes.set(id, el);
    return el;
  }

  const body = makeEl('body', 'body');
  const stage = add('div', 'stage', 'window', body);
  add('div', 'conversation', 'assistant', stage);
  const topbar = add('header', 'topbar', null, body);
  const tabBasic = add('button', 'tab-basic', 'tab-basic', topbar);
  add('button', 'tab-trade', 'tab-trade', topbar);
  tabBasic.setAttribute('aria-selected', 'true');

  const viewBasic = add('section', 'view-basic', null, stage);
  viewBasic.setAttribute('data-active', 'true');
  add('div', 'holdings-basic', 'holdings', viewBasic);

  const viewTrade = add('section', 'view-trade', null, stage);
  add('div', 'chart-trade', 'chart', viewTrade);

  const canvas = makeEl('canvas', 'beam');
  let drawn = 0;
  const ctx: Any = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    arc() {
      drawn += 1;
    },
    moveTo() {},
    lineTo() {},
    stroke() {
      drawn += 1;
    },
    fill() {},
    fillRect() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
  };
  canvas.getContext = () => ctx;
  nodes.set('beam', canvas);

  function matchAll(selector: string): Any[] {
    const attr = /^\[data-surface="([^"]*)"\]$/.exec(selector);
    const out: Any[] = [];
    if (attr) {
      nodes.forEach((node) => {
        if (node.getAttribute && node.getAttribute('data-surface') === attr[1]) out.push(node);
      });
      return out;
    }
    if (selector === '.tab[aria-selected="true"]') {
      nodes.forEach((node) => {
        if (node.getAttribute && node.getAttribute('aria-selected') === 'true') out.push(node);
      });
    }
    return out;
  }

  const doc: Any = {
    body,
    documentElement: makeEl('html', 'html'),
    getElementById: (id: string) => nodes.get(id) || null,
    querySelector: (selector: string) => matchAll(selector)[0] || null,
    querySelectorAll: matchAll,
    createElement: (tag: string) => makeEl(tag),
    addEventListener() {},
  };

  let draw: ((now: number, since: number) => void) | null = null;
  const handle: Any = {
    start() {},
    stop() {},
    invalidate() {},
    destroy() {
      draw = null;
    },
  };

  const timers: Array<() => void> = [];
  const sandbox: Any = {
    console,
    performance: { now: () => 0 },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      getPropertyValue(name: string) {
        if (name === '--agent') return '#33FF66';
        if (name === '--warn') return '#F5B942';
        if (name === '--down') return '#FF5A6E';
        if (name === '--dur-beam') return '320ms';
        if (name === '--ease-in-out') return 'cubic-bezier(0.77, 0, 0.175, 1)';
        return '';
      },
    }),
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.location = { search: '' };
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  sandbox.devicePixelRatio = 2;
  sandbox.setTimeout = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };
  sandbox.clearTimeout = () => {};
  sandbox.PhosphorMotion = {
    reduced: () => options.reduced === true,
    fitCanvas: () => ({ w: 1440, h: 900, dpr: 2, changed: true }),
    register(_node: Any, fn: (now: number, since: number) => void) {
      draw = fn;
      return handle;
    },
  };

  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/beam/beam.js' });

  return {
    sandbox,
    beam: sandbox.PhosphorBeam,
    doc,
    el: (id: string) => nodes.get(id),
    frame: (now: number) => {
      if (draw) draw(now, 16);
    },
    draws: () => drawn,
  };
}

test('the look lives in the stylesheet: the only style property written is the scan height', () => {
  const uses = SOURCE.match(/\.style\b[^\n]*/g) ?? [];
  assert.ok(uses.length > 0, 'beam.js writes no style at all, so this test is not looking at it');
  for (const use of uses) {
    assert.ok(
      /^\.style\.setProperty\('--scan-h'/.test(use),
      `beam.js writes a style property other than the scan height: ${use.trim()}`,
    );
  }
});

test('a beam aimed at a surface that is not in the window is a no-op, not a throw', () => {
  const world = build();
  assert.equal(world.beam.surface('nothing-here'), null);
  world.beam.fire({ from: { x: 0, y: 0 }, to: 'nothing-here', tone: 'glow' });
  world.beam.hold('nothing-here');
  world.beam.release('nothing-here', true);
  world.beam.decay('nothing-here');
  world.beam.wait('nothing-here', true);
});

test('a hold lights the surface and hangs a scan on it', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.hold('holdings');
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.children.length, 1);
  assert.equal(panel.children[0].className, 'surface-scan');
  assert.equal(panel.children[0].styles['--scan-h'], '220px');
});

test('a failed tool releases rose and takes the scan with it', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.hold('holdings');
  world.beam.release('holdings', false);
  assert.equal(panel.getAttribute('data-glow-tone'), 'down');
  assert.equal(panel.getAttribute('data-glow'), null, 'the glow is still held after a release');
  assert.equal(panel.children.length, 0, 'the scan outlived the tool call');
});

test('two tools on one surface keep one scan, and the last one out ends it', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.hold('holdings');
  world.beam.hold('holdings');
  assert.equal(panel.children.length, 1);
  world.beam.release('holdings', true);
  assert.equal(panel.children.length, 1, 'a tool still in flight lost its scan');
  world.beam.release('holdings', true);
  assert.equal(panel.children.length, 0);
});

test('an amber wait is held until it is turned off', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.wait('holdings', true);
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.getAttribute('data-glow-tone'), 'wait');
  assert.equal(panel.children.length, 0, 'a wait is not a tool in flight and draws no scan');
  world.beam.wait('holdings', false);
  assert.equal(panel.getAttribute('data-glow'), null);
});

test('a wait outranks a tool: the amber holds while a call runs under it', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.wait('holdings', true);
  world.beam.hold('holdings');
  assert.equal(panel.getAttribute('data-glow-tone'), 'wait');
  world.beam.release('holdings', true);
  assert.equal(panel.getAttribute('data-glow'), 'on', 'the release cleared a glow a person is waiting on');
});

test('a surface in the view on screen wins, and one behind it lands on its tab', () => {
  const world = build();
  assert.equal(world.beam.surface('holdings'), world.el('holdings-basic'));
  assert.equal(world.beam.surface('chart'), world.el('tab-trade'), 'a chart tool in basic did not light the trade tab');
  assert.equal(world.beam.surface('window'), world.el('stage'));
  assert.equal(world.beam.surface('assistant'), world.el('conversation'));
  assert.equal(world.beam.surface('tabs'), world.el('tab-basic'));
});

test('the flight reads geometry once and the loop reads none of it', () => {
  const world = build();
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  const atLaunch = rectReads;
  assert.ok(atLaunch > 0, 'the flight was launched without reading where it was going');
  for (let now = 16; now <= 320; now += 16) world.frame(now);
  assert.equal(rectReads, atLaunch, 'the draw loop read layout');
  assert.ok(world.draws() > 0, 'the loop painted nothing');
});

test('the surface work reads no layout at all beyond the scan height', () => {
  const world = build();
  rectReads = 0;
  world.beam.hold('holdings');
  world.beam.release('holdings', true);
  world.beam.decay('holdings');
  world.beam.wait('holdings', true);
  world.beam.wait('holdings', false);
  assert.equal(rectReads, 0);
});

test('the flight lands: the surface it was aimed at is lit when it arrives', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'wait', then: 'hold' });
  assert.equal(panel.getAttribute('data-glow'), null, 'the surface lit before the light got there');
  for (let now = 16; now <= 400; now += 16) world.frame(now);
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.getAttribute('data-glow-tone'), 'wait');
});

test('reduced motion skips the flight and lands the light immediately', () => {
  const world = build({ reduced: true });
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(world.draws(), 0, 'a flight was drawn under reduced motion');
});
