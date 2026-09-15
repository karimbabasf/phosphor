// The beam's two properties, and neither is a tidiness preference.
//
// One: what happens ON a surface is an attribute, and what happens on the
// assistant's seat light while a call is held is one more attribute on the
// status line in the head of the conversation. components.css owns every
// pixel of the glow and the light, so a theme change or a reduced-motion
// preference reaches them without this file knowing. A style property
// written here would be a second place the look lives. (It used to hang a
// sweeping band on the held surface; the sweep read as a scanner, so the
// working signal moved to the seat light on 2026-09-14.)
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
    parentNode: null as unknown as Any,
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
  const conversation = add('div', 'conversation', 'assistant', stage);
  /* The seat light: the status line agent.js builds in the head of the
     conversation, which the beam finds by id and sets live while it holds. */
  add('div', 'agent-status', null, conversation);
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
    el: (id: string): Any => nodes.get(id) as Any,
    frame: (now: number) => {
      if (draw) draw(now, 16);
    },
    draws: () => drawn,
  };
}

test('the look lives in the stylesheet: beam.js writes no style property at all', () => {
  const uses = SOURCE.match(/\.style\b[^\n]*/g) ?? [];
  assert.deepEqual(uses, [], `beam.js writes a style property: ${uses.map((u) => u.trim()).join(', ')}`);
  assert.equal(/\boffsetHeight\b|\boffsetWidth\b/.test(SOURCE), false, "beam.js reads a surface's size");
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

test('a hold lights the surface and sets the seat light live, and hangs nothing on the panel', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.hold('holdings');
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.children.length, 0, 'the hold appended something to the surface');
  assert.equal(seat.getAttribute('data-live'), 'true', 'the seat light did not come on');
});

test('a failed tool releases rose and the seat light settles with it', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.hold('holdings');
  world.beam.release('holdings', false);
  assert.equal(panel.getAttribute('data-glow-tone'), 'down');
  assert.equal(panel.getAttribute('data-glow'), null, 'the glow is still held after a release');
  assert.equal(seat.getAttribute('data-live'), null, 'the seat light outlived the tool call');
});

test('two tools keep one seat light, on any surfaces, and the last one out ends it', () => {
  const world = build();
  const seat = world.el('agent-status');
  world.beam.hold('holdings');
  world.beam.hold('chart');
  assert.equal(seat.getAttribute('data-live'), 'true');
  world.beam.release('holdings', true);
  assert.equal(seat.getAttribute('data-live'), 'true', 'a tool still in flight lost the seat light');
  world.beam.release('chart', true);
  assert.equal(seat.getAttribute('data-live'), null);
  /* A release with nothing held is a no-op that cannot push the count below zero. */
  world.beam.release('chart', true);
  world.beam.hold('holdings');
  assert.equal(seat.getAttribute('data-live'), 'true', 'a stray release left the count negative');
  world.beam.release('holdings', true);
  assert.equal(seat.getAttribute('data-live'), null);
});

test('a window with no seat light in it takes a hold without a throw', () => {
  const world = build();
  const seat = world.el('agent-status');
  seat.parentNode.removeChild(seat);
  world.doc.getElementById = (id: string) => (id === 'agent-status' ? null : world.el(id) || null);
  world.beam.hold('holdings');
  assert.equal(world.el('holdings-basic').getAttribute('data-glow'), 'on');
  world.beam.release('holdings', true);
});

test('an amber wait is held until it is turned off', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.wait('holdings', true);
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.getAttribute('data-glow-tone'), 'wait');
  assert.equal(seat.getAttribute('data-live'), null, 'a wait is not a tool in flight and does not light the seat');
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

test('the surface work reads no layout at all', () => {
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

test('a tool that answers before its flight lands leaves no stuck glow or seat', () => {
  // The race the beam existed to have: switch, set_theme and trade_focus all answer in well under
  // the 320 ms flight, so the release arrives before the hold. The hold is armed at fire time, so
  // the release cancels it and the arrival lights nothing.
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  world.beam.release('holdings', true); // the result beat the flight
  for (let now = 16; now <= 400; now += 16) world.frame(now);
  assert.equal(panel.getAttribute('data-glow'), null, 'the surface kept a glow with no call behind it');
  assert.equal(seat.getAttribute('data-live'), null, 'the seat light stayed live after the call was done');
});

test('a fast failure still shows: an early release with an error flashes the surface rose', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  world.beam.release('holdings', false); // failed before the flight landed
  for (let now = 16; now <= 400; now += 16) world.frame(now);
  assert.equal(panel.getAttribute('data-glow-tone'), 'down', 'a fast failure showed nothing');
  assert.equal(world.el('agent-status').getAttribute('data-live'), null, 'the seat outlived a failed call');
});

test('a trade proposal aimed at position lands on the chart when no position surface exists', () => {
  // 'position' is the trade deck, which the trade screen carries. Until it lands, the beam falls
  // back to the chart on the same view, so a trade proposal is never aimed at nothing (the old bug:
  // surface() returned null and the amber wait painted nowhere).
  const world = build();
  assert.equal(world.beam.surface('position'), world.el('tab-trade'), 'a trade proposal lit nothing');
});

test('a flight whose target leaves the DOM mid-flight lands nothing and keeps the seat balanced', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  panel.isConnected = false; // the view swapped it out while the light was on its way
  for (let now = 16; now <= 400; now += 16) world.frame(now);
  assert.equal(seat.getAttribute('data-live'), null, 'the seat stayed live for a target that is gone');
  // A later, present target still lights, so the drop did not leave the count negative.
  world.beam.hold('holdings');
  assert.equal(seat.getAttribute('data-live'), 'true');
});
