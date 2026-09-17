// The beam's properties, and none of them is a tidiness preference.
//
// One: what happens ON a surface is an attribute, and what happens on the
// assistant's seat light while a call is held is one more attribute on the
// status line in the head of the conversation. agent.css owns every pixel
// of the edge and the light, so a theme change or a reduced-motion
// preference reaches them without this file knowing. The one style the beam
// writes is the geometry of its own landing ring, as custom properties the
// stylesheet reads: colour, stroke and timing never come from here.
//
// Two: geometry is read at fire time and at the landing, never per frame.
// There is no frame loop in this file at all since 2026-09-16: the dot and
// the ring are moved by motion.dev through PhosphorMotion.animate, and the
// canvas streak that used to carry the flight is gone with the loop that
// drew it. A getBoundingClientRect per frame is the forced layout the
// performance audit found in the chart and told the rebuild not to repeat.
//
// The stub DOM below counts layout reads and the motion stub records what
// was asked to move, so all of it is asserted by running the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/beam/beam.js', import.meta.url), 'utf8');

type Any = Record<string, any>;

let rectReads = 0;

/* A DOM small enough to read and honest about the parts the beam touches:
   attributes, children, the parent chain, the one layout read, and the
   custom properties the ring is placed with. */
function makeEl(tag: string, id = ''): Any {
  const el: Any = {
    tagName: tag,
    id,
    className: '',
    attrs: Object.create(null) as Any,
    children: [] as Any[],
    parentNode: null as unknown as Any,
    isConnected: true,
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

type Moved = { target: Any; keyframes: Any; options: Any };

type World = {
  sandbox: Any;
  beam: Any;
  doc: Any;
  el: (id: string) => Any;
  layer: () => Any;
  moved: Moved[];
  /* Finish every animation motion.dev was handed so far, the way the browser would a few
     frames later, and let the beam's own continuations run. */
  land: () => Promise<void>;
  timers: () => void;
};

/* The window the beam expects: a stage, a conversation with the dock in it,
   three tabs, two views (one on screen, one behind it), and the fixed layer.
   That is enough to exercise every branch of surface(). */
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
  /* The dock: on screen only while something waits for a click. */
  const dock = add('div', 'overlay', 'dock', conversation);
  dock.getBoundingClientRect = () => {
    rectReads += 1;
    return { left: 0, top: 0, width: 0, height: 0 };
  };
  const topbar = add('header', 'topbar', null, body);
  const tabBasic = add('button', 'tab-basic', 'tab-basic', topbar);
  add('button', 'tab-trade', 'tab-trade', topbar);
  tabBasic.setAttribute('aria-selected', 'true');

  const viewBasic = add('section', 'view-basic', null, stage);
  viewBasic.setAttribute('data-active', 'true');
  add('div', 'holdings-basic', 'holdings', viewBasic);

  const viewTrade = add('section', 'view-trade', null, stage);
  add('div', 'chart-trade', 'chart', viewTrade);

  const layer = add('div', 'beam', null, body);

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

  let made = 0;
  const doc: Any = {
    body,
    documentElement: makeEl('html', 'html'),
    getElementById: (id: string) => nodes.get(id) || null,
    querySelector: (selector: string) => matchAll(selector)[0] || null,
    querySelectorAll: matchAll,
    createElement: (tag: string) => {
      made += 1;
      return makeEl(tag, `made-${made}`);
    },
    addEventListener() {},
  };

  const moved: Moved[] = [];
  const pending: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let clock = 0;
  const sandbox: Any = {
    console,
    performance: { now: () => clock },
    getComputedStyle: () => ({
      getPropertyValue(name: string) {
        if (name === 'border-radius') return '20px';
        return '';
      },
    }),
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.location = { search: '' };
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  sandbox.setTimeout = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };
  sandbox.clearTimeout = () => {};
  /* The one-second wait for a surface to have a box: each poll is a frame, and the clock
     moves so the wait can run out. */
  sandbox.requestAnimationFrame = (fn: () => void) => {
    clock += 100;
    timers.push(fn);
    return timers.length;
  };
  /* The motion helper (ui/design/motion.js): records every animation it is handed and finishes
     each one when the test says so. */
  sandbox.PhosphorMotion = {
    reduced: () => options.reduced === true,
    animate(target: Any, keyframes: Any, opts: Any) {
      moved.push({ target, keyframes, options: opts });
      let resolve: () => void = () => {};
      const finished = new Promise<void>((r) => {
        resolve = r;
      });
      pending.push(resolve);
      return { finished, stop() {} };
    },
  };

  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/beam/beam.js' });

  return {
    sandbox,
    beam: sandbox.PhosphorBeam,
    doc,
    el: (id: string): Any => nodes.get(id) as Any,
    layer: () => layer,
    moved,
    land: async () => {
      const due = pending.splice(0, pending.length);
      for (const resolve of due) resolve();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    timers: () => {
      const due = timers.splice(0, timers.length);
      for (const fn of due) fn();
    },
  };
}

test('the look lives in the stylesheet: the one style beam.js writes is the ring\'s geometry, as custom properties', () => {
  const uses = SOURCE.match(/\.style\b[^\n]*/g) ?? [];
  assert.ok(uses.length > 0, 'the ring is placed somehow, and this test is not looking at it');
  for (const use of uses) {
    assert.ok(/^\.style\.setProperty\('--beam-[a-z]'/.test(use.trim()), `beam.js writes a style that is not the ring's geometry: ${use.trim()}`);
  }
  assert.equal(/\boffsetHeight\b|\boffsetWidth\b/.test(SOURCE), false, "beam.js reads a surface's size");
});

test('no canvas and no loop: the flight and the ring are motion.dev\'s', () => {
  assert.equal(/getContext|fitCanvas|PhosphorMotion\.register|requestAnimationFrame\(draw|globalCompositeOperation/.test(SOURCE), false, 'the canvas streak is still in the file');
  assert.ok(SOURCE.includes('.animate('), 'nothing goes through motion.dev');
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
  /* The tone stays for the fade and then goes: a surface at rest carries nothing. */
  world.timers();
  assert.equal(panel.getAttribute('data-glow-tone'), null, 'a residual tone stayed on the surface');
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
  assert.equal(world.beam.surface('dock'), world.el('overlay'));
});

test('the flight is one dot on a spring: it leaves the step marker, arcs over the content and gives way to the ring', async () => {
  const world = build();
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  assert.equal(world.moved.length, 2, 'the flight is one spring on x and one arc on y, on one dot');
  const glide = world.moved[0];
  const arc = world.moved[1];
  assert.equal(glide.target.className, 'beam-dot');
  assert.equal(arc.target, glide.target, 'the spring and the arc move different things');
  assert.equal(glide.target.getAttribute('data-tone'), 'glow');
  assert.equal(glide.target.parentNode, world.layer(), 'the dot is not in the fixed layer');
  /* From the middle of the row to the middle of the panel (the stub gives every element the
     same box), and the arc's middle keyframe is above both ends. */
  assert.deepEqual([...glide.keyframes.x], [160, 160]);
  assert.equal(glide.options.type, 'spring', 'x is not a spring');
  assert.equal(arc.keyframes.y.length, 3);
  assert.ok(arc.keyframes.y[1] < arc.keyframes.y[0] && arc.keyframes.y[1] < arc.keyframes.y[2], 'the dot does not arc');
  assert.ok(arc.keyframes.y[1] >= 16, 'the arc leaves the window');
  assert.equal(arc.keyframes.opacity[0], 0, 'the dot pops in at full strength');
  assert.equal(arc.keyframes.opacity[arc.keyframes.opacity.length - 1], 0, 'the dot stays after the ring takes over');
  /* No canvas: nothing else was drawn. */
  assert.equal(world.layer().children.length, 1);

  await world.land();
  assert.equal(world.layer().children.length, 1, 'the dot was not taken down at the landing, or no ring came');
  const ring = world.layer().children[0];
  assert.equal(ring.className, 'beam-ring');
  assert.equal(ring.getAttribute('data-tone'), 'glow');
  /* The ring is the panel's box, on the panel's corners, as the stylesheet's custom properties. */
  assert.deepEqual({ ...ring.styles }, { '--beam-x': '10px', '--beam-y': '20px', '--beam-w': '300px', '--beam-h': '200px', '--beam-r': '20px' });
  const breath = world.moved[2];
  assert.equal(breath.target, ring);
  /* Two breaths, scale 1 to 1.06 and back, then gone. */
  assert.deepEqual([...breath.keyframes.scale], [1, 1.06, 1, 1.06, 1, 1]);
  assert.equal(breath.keyframes.opacity[breath.keyframes.opacity.length - 1], 0, 'the ring never fades');
  await world.land();
  assert.equal(world.layer().children.length, 0, 'the ring stayed in the layer after its fade');
});

test('geometry is read at fire time and once at the landing, never per frame', async () => {
  const world = build();
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  const atLaunch = rectReads;
  assert.ok(atLaunch > 0, 'the flight was launched without reading where it was going');
  await world.land();
  assert.equal(rectReads, atLaunch + 1, 'the landing read more than the one box the ring needs');
  await world.land();
  assert.equal(rectReads, atLaunch + 1, 'the ring read layout while it breathed');
});

test('the surface work reads no layout at all', () => {
  const world = build();
  rectReads = 0;
  world.beam.hold('holdings');
  world.beam.release('holdings', true);
  world.beam.wait('holdings', true);
  world.beam.wait('holdings', false);
  assert.equal(rectReads, 0);
});

test('the flight lands: the surface it was aimed at is lit when it arrives, and not before', async () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'wait', then: 'hold' });
  assert.equal(panel.getAttribute('data-glow'), null, 'the surface lit before the light got there');
  await world.land();
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(panel.getAttribute('data-glow-tone'), 'wait');
  assert.equal(world.el('agent-status').getAttribute('data-live'), 'true');
});

test('reduced motion is a fade only: no flight, the light already there, the ring with no breath', async () => {
  const world = build({ reduced: true });
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  assert.equal(panel.getAttribute('data-glow'), 'on', 'the light waited for a flight under reduced motion');
  assert.equal(world.moved.length, 1, 'a dot flew under reduced motion');
  assert.equal(world.layer().children.length, 1, 'something other than the ring is in the layer');
  const ring = world.moved[0];
  assert.equal(ring.target.className, 'beam-ring');
  assert.equal(ring.keyframes.scale, undefined, 'the ring breathed under reduced motion');
  assert.ok(Array.isArray(ring.keyframes.opacity), 'the ring did not fade');
  await world.land();
  assert.equal(world.layer().children.length, 0);
});

test('a tool that answers before its flight lands leaves no stuck glow or seat', async () => {
  // The race the beam existed to have: switch, set_theme and trade_focus all answer in well under
  // the flight, so the release arrives before the hold. The hold is armed at fire time, so the
  // release cancels it and the arrival lights nothing.
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  world.beam.release('holdings', true); // the result beat the flight
  await world.land();
  assert.equal(panel.getAttribute('data-glow'), null, 'the surface kept a glow with no call behind it');
  assert.equal(seat.getAttribute('data-live'), null, 'the seat light stayed live after the call was done');
});

test('a fast failure still shows: an early release with an error breathes the surface rose', async () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  world.beam.release('holdings', false); // failed before the flight landed
  await world.land();
  assert.equal(panel.getAttribute('data-glow-tone'), 'down', 'a fast failure showed nothing');
  assert.equal(world.el('agent-status').getAttribute('data-live'), null, 'the seat outlived a failed call');
  const rose = world.moved.find((m) => m.target.className === 'beam-ring' && m.target.getAttribute('data-tone') === 'down');
  assert.ok(rose, 'no rose ring for the failure');
});

test('money arriving is one breath of the ring around the panel, with no flight', () => {
  const world = build();
  const panel = world.el('holdings-basic');
  world.beam.decay('holdings');
  assert.equal(panel.getAttribute('data-glow'), 'on');
  assert.equal(world.moved.length, 1);
  assert.equal(world.moved[0].target.className, 'beam-ring');
  world.timers();
  assert.equal(panel.getAttribute('data-glow'), null, 'the edge stayed on after the breath');
});

test('a trade proposal aimed at position lands on the chart when no position surface exists', () => {
  // 'position' is the trade deck, which the trade screen carries. Until it lands, the beam falls
  // back to the chart on the same view, so a trade proposal is never aimed at nothing (the old bug:
  // surface() returned null and the amber wait painted nowhere).
  const world = build();
  assert.equal(world.beam.surface('position'), world.el('tab-trade'), 'a trade proposal lit nothing');
});

test('a dock that never opens hands the flight to the conversation it came from', async () => {
  // A propose verb flies to the dock, which only has a box once the proposal is waiting for a
  // click. One the app refused outright never opens it, so after the wait the light lands on the
  // assistant rather than at 0,0 under the composer, and the hold still balances.
  const world = build();
  const seat = world.el('agent-status');
  world.beam.fire({ from: world.el('conversation'), to: 'dock', tone: 'wait', then: 'hold' });
  assert.equal(world.moved.length, 0, 'the flight left before the dock had a box');
  for (let i = 0; i < 12; i += 1) world.timers();
  assert.equal(world.moved.length, 2, 'the flight never left');
  await world.land();
  const ring = world.layer().children[0];
  assert.equal(ring.getAttribute('data-tone'), 'wait');
  assert.equal(seat.getAttribute('data-live'), 'true');
  world.beam.release('dock', true);
  assert.equal(seat.getAttribute('data-live'), null);
});

test('a flight whose target leaves the DOM mid-flight lands nothing and keeps the seat balanced', async () => {
  const world = build();
  const panel = world.el('holdings-basic');
  const seat = world.el('agent-status');
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  panel.isConnected = false; // the view swapped it out while the light was on its way
  await world.land();
  assert.equal(seat.getAttribute('data-live'), null, 'the seat stayed live for a target that is gone');
  assert.equal(world.layer().children.length, 0, 'a ring was drawn around an element that is gone');
  // A later, present target still lights, so the drop did not leave the count negative or a
  // stale cancel behind: fire again and let it land.
  panel.isConnected = true;
  world.beam.fire({ from: world.el('conversation'), to: 'holdings', tone: 'glow', then: 'hold' });
  await world.land();
  assert.equal(seat.getAttribute('data-live'), 'true');
  assert.equal(panel.getAttribute('data-glow'), 'on');
});
