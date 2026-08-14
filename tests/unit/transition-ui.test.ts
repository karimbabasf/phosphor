// The mode switch is dressed with a fall of characters, and the dressing sits on top of the
// approval gate for about a second. So these tests are not about whether it looks right.
// They are about the rule that outranks the effect: the mode change happens exactly once,
// whatever the browser does, and the cover always comes off.
//
// The three ways this could have gone wrong, all locked down here:
//   - the swap running while the page is still visible, so a human sees the old mode blink
//     into the new one and then get rained on;
//   - a browser that never gives a frame (reduced motion, a hidden tab, no 2d context)
//     swallowing the switch entirely, which for an agent-driven app means the one-word
//     switch silently does nothing;
//   - a run that starts and never ends, leaving an opaque canvas over a pending approval.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

interface Harness {
  sandbox: Sandbox;
  rain: any;
  frames: Array<(now: number) => void>;
  timers: Array<{ id: number; fn: () => void; ms: number }>;
  appended: any[];
  removed: any[];
  navigated: string[];
  store: Record<string, string>;
  tick(now: number): void;
  runTimers(): void;
}

function fakeContext(): Sandbox {
  return {
    globalAlpha: 1,
    fillStyle: '',
    font: '',
    textBaseline: '',
    globalCompositeOperation: '',
    setTransform: () => {},
    measureText: () => ({ width: 8 }),
    fillRect: () => {},
    fillText: () => {},
    clearRect: () => {},
    drawImage: () => {},
  };
}

interface Options {
  reducedMotion?: boolean;
  hidden?: boolean;
  noContext?: boolean;
  handoff?: string | null;
}

/* ui/transition.js is a browser script that installs one global and then, on its own last
   line, runs the arriving half of a switch. Everything it touches is faked here, including
   the clock: frames are handed out by the test rather than by a compositor, which is the
   only way to assert what happens on the frame the cover completes. */
function load(opts: Options = {}): Harness {
  const source = readFileSync(new URL('../../ui/transition.js', import.meta.url), 'utf8');
  const frames: Array<(now: number) => void> = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  const appended: any[] = [];
  const removed: any[] = [];
  const navigated: string[] = [];
  const store: Record<string, string> = {};
  if (opts.handoff !== undefined && opts.handoff !== null) store['phosphor.rain'] = opts.handoff;

  const body: Sandbox = {
    appendChild: (node: any) => {
      appended.push(node);
      node.parentNode = body;
      return node;
    },
    removeChild: (node: any) => {
      removed.push(node);
      node.parentNode = null;
      return node;
    },
  };

  const document: Sandbox = {
    body,
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    hidden: opts.hidden === true,
    createElement: () => ({
      style: {},
      width: 0,
      height: 0,
      parentNode: null,
      setAttribute: () => {},
      getContext: () => (opts.noContext ? null : fakeContext()),
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  let timerId = 1;
  const sandbox: Sandbox = {
    document,
    devicePixelRatio: 2,
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: (query: string) => ({ matches: opts.reducedMotion === true && query.indexOf('reduced-motion') >= 0 }),
    getComputedStyle: () => ({
      backgroundColor: 'rgb(11, 13, 11)',
      getPropertyValue: (name: string) => (name === '--green' ? '#33ff66' : '#8cffab'),
    }),
    requestAnimationFrame: (fn: (now: number) => void) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      const id = timerId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    sessionStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
    location: {
      set href(url: string) {
        navigated.push(url);
      },
      get href() {
        return navigated.length ? navigated[navigated.length - 1] : '';
      },
    },
    console,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/transition.js' });

  return {
    sandbox,
    rain: sandbox.PHOSPHOR_RAIN,
    frames,
    timers,
    appended,
    removed,
    navigated,
    store,
    tick(now: number) {
      const pending = frames.splice(0, frames.length);
      for (const fn of pending) fn(now);
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.fn();
    },
  };
}

/* ---------- the shape of the fall ---------- */

test('the cover is complete before the mode changes', () => {
  const { rain } = load();
  const cover = rain.timings.coverMs;

  // Anything before the end of the cover is a page that can still be seen through.
  for (const at of [0, 1, cover * 0.25, cover * 0.5, cover * 0.9, cover - 1]) {
    const p = rain.phaseAt(at, 'swap');
    assert.equal(p.swap, false, `swapped at ${at}ms, while the veil was only ${p.veil}`);
    assert.ok(p.veil < 1, `veil already ${p.veil} at ${at}ms`);
  }

  /* The hold is the whole window in which the change can first be seen by the loop, and the
     veil is exactly opaque across all of it. Frames land where they land: without the hold
     the mode would change on whichever frame first crossed the cover, by then already into
     the reveal, and the switch itself would show faintly through. */
  for (const at of [cover, cover + 1, cover + rain.timings.holdMs - 1]) {
    const p = rain.phaseAt(at, 'swap');
    assert.equal(p.swap, true);
    assert.equal(p.veil, 1, `veil was ${p.veil} at ${at}ms, inside the hold`);
    assert.equal(p.done, false);
  }
});

test('a swap ends clear, and ends', () => {
  const { rain } = load();
  const settled = rain.timings.coverMs + rain.timings.holdMs;
  const end = settled + rain.timings.revealMs;

  const mid = rain.phaseAt(settled + rain.timings.revealMs * 0.5, 'swap');
  assert.ok(mid.veil > 0 && mid.veil < 1, `mid-reveal veil was ${mid.veil}`);
  assert.ok(mid.rain > 0, 'the rain went before the ground did');

  const done = rain.phaseAt(end, 'swap');
  assert.equal(done.done, true);
  assert.equal(done.veil, 0);
  assert.equal(done.rain, 0);
  // Past the end stays past the end: a late frame cannot reopen the cover.
  const late = rain.phaseAt(end + 5000, 'swap');
  assert.equal(late.done, true);
  assert.equal(late.veil, 0);
});

test('a leave stops at the cover, and an arrive starts there', () => {
  const { rain } = load();
  const cover = rain.timings.coverMs;

  /* Nothing after the cover would ever be seen on a page that is being navigated away from,
     and drawing it would hold the navigation. */
  const leaving = rain.phaseAt(cover, 'leave');
  assert.equal(leaving.swap, true);
  assert.equal(leaving.done, true);
  assert.equal(leaving.veil, 1);

  /* The other half of that same fall, on the page that arrives: covered at its first frame,
     which is what makes the two pages read as one continuous transition. */
  const arriving = rain.phaseAt(0, 'arrive');
  assert.equal(arriving.veil, 1);
  assert.equal(arriving.done, false);
  assert.equal(rain.phaseAt(rain.timings.holdMs + rain.timings.revealMs, 'arrive').done, true);
});

/* ---------- the handoff ---------- */

test('only a handoff from the navigation in flight is honoured', () => {
  const { rain } = load();
  const now = 1_760_000_000_000;
  assert.equal(rain.handoffFresh(String(now - 10), now), true);
  assert.equal(rain.handoffFresh(null, now), false);
  assert.equal(rain.handoffFresh('', now), false);
  assert.equal(rain.handoffFresh('not-a-number', now), false);
  // A tab restored tomorrow must not replay a reveal over a page nobody switched to.
  assert.equal(rain.handoffFresh(String(now - 86_400_000), now), false);
  // A clock that went backwards is not evidence of anything.
  assert.equal(rain.handoffFresh(String(now + 60_000), now), false);
});

test('a stale handoff is consumed rather than left to fire later', () => {
  const h = load({ handoff: '1' });
  assert.equal('phosphor.rain' in h.store, false, 'the flag survived the page that ignored it');
  assert.equal(h.appended.length, 0, 'a stale flag put a cover over the page');
});

/* ---------- the rule that outranks the effect ---------- */

test('reduced motion changes the mode without a canvas', () => {
  const h = load({ reducedMotion: true });
  let applied = 0;
  h.rain.swap(() => {
    applied++;
  });
  assert.equal(applied, 1, 'the mode change did not happen');
  assert.equal(h.appended.length, 0, 'something was drawn under reduced motion');
  assert.equal(h.frames.length, 0);
});

test('a hidden tab navigates immediately rather than waiting for a frame it never gets', () => {
  // The one that matters most: requestAnimationFrame does not fire in a backgrounded tab,
  // so a run that waits for its own cover would drop an agent's switch on the floor.
  const h = load({ hidden: true });
  h.rain.leave(() => {
    h.sandbox.location.href = '/trade';
  });
  assert.deepEqual(h.navigated, ['/trade']);
  assert.equal(h.appended.length, 0);
});

test('a browser with no 2d context still switches', () => {
  const h = load({ noContext: true });
  let applied = 0;
  h.rain.swap(() => {
    applied++;
  });
  assert.equal(applied, 1);
});

test('the mode changes once, on the frame the cover completes', () => {
  const h = load();
  let applied = 0;
  h.rain.swap(() => {
    applied++;
  });
  assert.equal(h.appended.length, 1, 'no canvas went up');
  assert.equal(applied, 0, 'the mode changed before anything covered it');

  h.tick(1000); // first frame: t0
  assert.equal(applied, 0);
  h.tick(1000 + h.rain.timings.coverMs * 0.5);
  assert.equal(applied, 0, 'the mode changed halfway through the cover');
  h.tick(1000 + h.rain.timings.coverMs);
  assert.equal(applied, 1);
  h.tick(1000 + h.rain.timings.coverMs + 60);
  assert.equal(applied, 1, 'the mode change ran twice');

  h.tick(1000 + h.rain.timings.coverMs + h.rain.timings.holdMs + h.rain.timings.revealMs);
  assert.equal(h.removed.length, 1, 'the cover stayed up after the fall ended');
  assert.equal(h.rain.playing(), false);
});

test('a second switch during a fall is not a second canvas', () => {
  const h = load();
  h.rain.swap(() => {});
  let applied = 0;
  h.rain.swap(() => {
    applied++;
  });
  // Ignored as an animation, honoured as a mode change: an agent calling switch twice in a
  // second must still end on the mode it asked for last.
  assert.equal(applied, 1);
  assert.equal(h.appended.length, 1);
});

test('the watchdog takes the cover off a run that stops getting frames', () => {
  const h = load();
  let applied = 0;
  h.rain.swap(() => {
    applied++;
  });
  h.tick(1000);
  assert.equal(h.removed.length, 0);

  // The compositor goes quiet: no more frames, ever. This is the state that would strand an
  // opaque canvas over a pending approval.
  h.runTimers();
  assert.equal(applied, 1, 'the mode change was lost with the frames');
  assert.equal(h.removed.length, 1, 'the cover was left over the page');
  assert.equal(h.rain.playing(), false);
});

test('a leave holds its cover until the next page, and the watchdog still clears it', () => {
  const h = load();
  h.rain.leave(() => {
    h.sandbox.location.href = '/trade';
  });
  h.tick(1000);
  h.tick(1000 + h.rain.timings.coverMs);

  assert.deepEqual(h.navigated, ['/trade']);
  assert.ok(h.store['phosphor.rain'], 'the arriving page was told nothing');
  /* Still up: lifting it here would show the page being left for as long as the next
     document takes to arrive, which is the frame this whole effect exists to hide. */
  assert.equal(h.removed.length, 0);

  // Unless the navigation never lands, which is what the watchdog is for.
  h.runTimers();
  assert.equal(h.removed.length, 1);
});

test('the alphabet is the one this program is written in', () => {
  const { rain } = load();
  assert.ok(rain.glyphs.length > 40);
  // Box-drawing characters, because the panel frames are built out of them and the point of
  // the fall is that the interface comes apart into what it is made of.
  assert.ok(rain.glyphs.indexOf('┼') >= 0);
  // No katakana: that is the film's alphabet, not this program's.
  assert.equal(/[゠-ヿ]/.test(rain.glyphs), false);
});
