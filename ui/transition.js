/* The mode switch, as a fall of characters.
 *
 * Karim, 2026-08-14: switching modes should not be a cut. The screen comes apart into a
 * waterfall of terminal characters and the mode that was asked for is standing behind it
 * when the rain clears.
 *
 * WHERE THIS LIVES AND WHY. ui/style.css:5 forbids transitions on this surface, and that
 * law is not being bent here: nothing in the DOM animates. The whole effect is one canvas
 * that does not exist until a switch is asked for and is removed the moment it ends, which
 * is the same split [[2026-08-13-phosphor-motion-lives-on-canvas]] settled for the chart.
 * It is also why the element is styled from here rather than from a stylesheet: it carries
 * no design tokens, it appears on two pages with two different stylesheets, and a rule for
 * an element that is absent 99.9% of the time reads as a permanent part of the surface.
 *
 * WHAT IT COSTS AT REST. Nothing. No canvas, no listener, no timer, no rAF. The steady
 * state of this file is a few hundred bytes of closure.
 *
 * WHAT IT COSTS WHILE PLAYING. Per frame: one full-surface erase and one full-surface
 * fill, two colour switches, and one fillText per column (about 190 on a 1512px screen).
 * The trails are not drawn; they are what is left of earlier heads after the erase, which
 * is phosphor decay and is the reason the classic version of this effect is cheap. Measured
 * on the built-in Retina panel: see the numbers in the commit.
 *
 * THE RULE THAT OUTRANKS THE EFFECT. This app moves real money and the approval gate lives
 * under this canvas. So the animation may never be the reason a mode change fails to happen
 * or a screen stays hidden:
 *   - the canvas is pointer-events: none, so every click still lands on the page below;
 *   - the mode change runs from a callback that is guaranteed to fire exactly once, by the
 *     frame loop, by the watchdog, or synchronously if animation is unavailable;
 *   - reduced motion, a hidden tab and a missing 2d context all skip straight to the swap;
 *   - a watchdog tears the canvas down after MAX_MS no matter what the loop is doing.
 * A backgrounded tab is the one that matters most: rAF does not fire there, so an agent's
 * switch would silently never happen. That is why document.hidden is checked up front and
 * again on every visibilitychange while a run is live.
 */
(function (global) {
  'use strict';

  /* Timings. The whole thing is under a second: it marks the change, it does not become an
     event of its own. Cover is short because nothing is being read during it; reveal is
     longer because that is the part someone actually watches. */
  var COVER_MS = 380;
  /* A beat of nothing but rain, and the only part of the run where the veil is exactly
     opaque. Frames land where they land, so without it the mode would change on whichever
     frame first crosses the cover, by then already a percent or two into the reveal, and
     the switch itself would be faintly visible through it. It also reads better: the fall
     arrives, holds, and then there is a different screen behind it. */
  var HOLD_MS = 70;
  var REVEAL_MS = 560;
  var MAX_MS = 4000; // watchdog; roughly four times the longest honest run

  /* How much of the standing image is erased per frame at 60fps. Everything visible except
     the current head is a leftover, so this single number sets the streak length: at these
     speeds it leaves a tail of roughly twenty rows. */
  var DECAY = 0.12;

  var CELL_PX = 13; // matches --fs, so the fall is on the same grid as the text it replaces
  var ROW_RATIO = 1.15;
  var MAX_DPR = 2; // a 3rd or 4th device pixel buys nothing on glyphs this small and costs area
  var MIN_SPEED = 60; // rows per second
  var MAX_SPEED = 145;
  var MAX_FILL = 4; // most rows one column may draw in a frame, however long that frame was

  /* The page's own alphabet: ASCII plus the box-drawing characters the panel frames are
     built from. A katakana set would be the film's alphabet rather than this program's, and
     the point of the effect is that the interface comes apart into what it is made of. */
  var GLYPHS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>[]{}()/\\|-_=+*#$%&@?!:;.,^~' + '─│┌┐└┘├┤┬┴┼';

  /* Handed across a navigation, because two of the three switches change page. The value is
     a timestamp: a flag with no age would replay the reveal on a tab reopened tomorrow. */
  var HANDOFF_KEY = 'phosphor.rain';
  var HANDOFF_MAX_AGE_MS = 4000;

  var FALLBACK_GROUND = 'rgb(11, 13, 11)';
  var FALLBACK_BODY = '#33ff66';
  var FALLBACK_HEAD = '#8cffab';

  /* The one live run, or null. A second switch arriving mid-fall is ignored rather than
     stacked: an agent can call switch in a loop, and two canvases would be two watchdogs. */
  var live = null;

  /* ---------- pure parts, exported for the tests ---------- */

  /* Where a run is at a given moment. Everything the frame loop needs to draw and to decide
     is in here, so the shape of the effect can be asserted without a browser.

     veil    opacity of the ground colour that hides the page: 1 is a covered screen
     rain    opacity of the characters themselves
     spawn   whether an exhausted column starts again at the top
     swap    true on the first tick at or after full cover, which is when the mode changes
     done    true when the canvas has nothing left to say */
  function phaseAt(elapsed, kind) {
    var e = elapsed < 0 ? 0 : elapsed;
    if (kind === 'arrive') e = e + COVER_MS; // the cover already happened, on the page before

    if (e < COVER_MS) {
      var t = e / COVER_MS;
      return {
        // Slow to start and quick to close, so the screen stays readable until it does not.
        veil: Math.pow(t, 1.7),
        rain: t * 3 < 1 ? t * 3 : 1,
        spawn: true,
        swap: false,
        done: false,
      };
    }

    if (kind === 'leave') {
      // This page is about to be replaced. Nothing after the cover would ever be seen, and
      // drawing it would only delay the navigation.
      return { veil: 1, rain: 1, spawn: false, swap: true, done: true };
    }

    if (e < COVER_MS + HOLD_MS) {
      return { veil: 1, rain: 1, spawn: true, swap: true, done: false };
    }

    var u = (e - COVER_MS - HOLD_MS) / REVEAL_MS;
    if (u >= 1) return { veil: 0, rain: 0, spawn: false, swap: true, done: true };
    return {
      // The ground clears faster than the rain does, which is what puts the new screen
      // behind the fall rather than after it.
      veil: (1 - u) * (1 - u),
      rain: u < 0.55 ? 1 : (1 - u) / 0.45,
      spawn: u < 0.45,
      swap: true,
      done: false,
    };
  }

  /* A handoff is only worth honouring while the navigation it belongs to is still in flight.
     Anything older is a tab that was reopened, restored or duplicated. */
  function handoffFresh(raw, now) {
    var stamp = Number(raw);
    if (!raw || !isFinite(stamp)) return false;
    var age = now - stamp;
    return age >= 0 && age < HANDOFF_MAX_AGE_MS;
  }

  /* ---------- environment ---------- */

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) {
      return false;
    }
  }

  /* Every reason to skip the animation, in one place. A hidden tab is in here because rAF is
     frozen there: the run would never reach its own swap. */
  function canAnimate() {
    if (reducedMotion()) return false;
    if (typeof global.requestAnimationFrame !== 'function') return false;
    if (!global.document || !global.document.body) return false;
    if (global.document.hidden) return false;
    return true;
  }

  function rgbaFrom(colour, alpha) {
    var m = /^rgba?\(([^)]+)\)$/.exec(String(colour || '').trim());
    if (!m) return 'rgba(11, 13, 11, ' + alpha + ')';
    var parts = m[1].split(',');
    if (parts.length < 3) return 'rgba(11, 13, 11, ' + alpha + ')';
    return 'rgba(' + parts[0].trim() + ', ' + parts[1].trim() + ', ' + parts[2].trim() + ', ' + alpha + ')';
  }

  /* Read from the live page rather than from a constant, because the basic view replaces the
     ground and the family. Re-read after the swap so the reveal clears to the colour of the
     mode that is arriving, not the one that left. */
  function palette() {
    var doc = global.document;
    var ground = FALLBACK_GROUND;
    var body = FALLBACK_BODY;
    var head = FALLBACK_HEAD;
    try {
      var bodyStyle = global.getComputedStyle(doc.body);
      if (bodyStyle.backgroundColor && bodyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        ground = bodyStyle.backgroundColor;
      }
      var rootStyle = global.getComputedStyle(doc.documentElement);
      body = (rootStyle.getPropertyValue('--green') || '').trim() || FALLBACK_BODY;
      head = (rootStyle.getPropertyValue('--green-hi') || '').trim() || FALLBACK_HEAD;
    } catch (err) {
      /* a page with no computed style is a page with no screen; the fallbacks are the
         pro surface's own colours */
    }
    return { ground: ground, body: body, head: head };
  }

  /* ---------- the run ---------- */

  function buildColumns(run) {
    var rows = Math.ceil(run.h / run.rowH) + 2;
    var count = Math.ceil(run.w / run.cellW) + 1;
    var cols = new Array(count);
    /* A run that starts covered is the second half of a fall that began on the page before,
       so its columns start spread down the screen. Starting them above the top edge would
       show the front arriving twice, once per page. */
    var high = run.kind === 'arrive' ? rows * 0.75 : rows * 0.9;
    var low = run.kind === 'arrive' ? -rows * 0.25 : -rows * 0.9;
    for (var i = 0; i < count; i++) {
      cols[i] = {
        y: low + Math.random() * (high - low),
        speed: MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED),
        last: -1, // the row the head was on last frame; -1 means it has not been on one
        from: -1,
        row: -1,
      };
    }
    run.rows = rows;
    run.cols = cols;
  }

  function sizeRun(run) {
    var doc = global.document;
    run.w = Math.max(1, doc.documentElement.clientWidth || global.innerWidth || 1);
    run.h = Math.max(1, doc.documentElement.clientHeight || global.innerHeight || 1);
    run.dpr = Math.min(global.devicePixelRatio || 1, MAX_DPR);

    var pw = Math.max(1, Math.floor(run.w * run.dpr));
    var ph = Math.max(1, Math.floor(run.h * run.dpr));
    run.canvas.width = pw;
    run.canvas.height = ph;
    run.canvas.style.width = run.w + 'px';
    run.canvas.style.height = run.h + 'px';
    run.buffer.width = pw;
    run.buffer.height = ph;
    run.pw = pw;
    run.ph = ph;

    /* The buffer works in CSS pixels and the visible canvas in device pixels. The text half
       wants the readable coordinate system; the composite half is two whole-surface
       operations that never need one. */
    run.bctx.setTransform(run.dpr, 0, 0, run.dpr, 0, 0);
    run.bctx.font = CELL_PX + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    run.bctx.textBaseline = 'top';
    run.cellW = Math.max(4, run.bctx.measureText('M').width);
    run.rowH = CELL_PX * ROW_RATIO;
    buildColumns(run);
  }

  function stepRain(run, dt, p) {
    var ctx = run.bctx;

    /* Erase rather than paint over. A translucent black wash is the usual way to get the
       trail, but it leaves the buffer opaque, and an opaque buffer cannot be lifted off the
       new screen during the reveal. destination-out fades the standing image toward
       transparent instead, which composites correctly at any veil. */
    var erase = 1 - Math.pow(1 - DECAY, dt * 60);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, ' + erase + ')';
    ctx.fillRect(0, 0, run.w, run.h);
    ctx.globalCompositeOperation = 'source-over';

    var cols = run.cols;
    var i;
    var col;
    var r;

    /* Advance first, then draw in two passes, so the colour is set twice per frame rather
       than twice per column. */
    for (i = 0; i < cols.length; i++) {
      col = cols[i];
      col.from = col.last;
      col.y += col.speed * dt;
      col.row = Math.floor(col.y);
      if (col.y > run.rows) {
        if (p.spawn) {
          col.y = -Math.random() * 12;
          col.row = Math.floor(col.y);
          col.from = -1;
          col.speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
        } else {
          col.y = run.rows + 1; // parked off the bottom, drawn no more
          col.row = run.rows + 1;
        }
      }
    }

    /* The rows the head crossed since the last frame. At these speeds a column moves one to
       three rows per frame, so without this the streak is a dotted line: the first version
       drew the head and the row behind it and nothing else, and the gaps were plain on the
       screen at the first look. Bounded because a stalled frame must not turn into a column
       of a hundred glyphs. */
    ctx.fillStyle = run.colours.body;
    for (i = 0; i < cols.length; i++) {
      col = cols[i];
      if (col.from < 0) continue;
      var first = col.row - MAX_FILL;
      if (col.from + 1 > first) first = col.from + 1;
      for (r = first; r < col.row; r++) {
        if (r >= 0 && r < run.rows) {
          ctx.fillText(GLYPHS.charAt((Math.random() * GLYPHS.length) | 0), i * run.cellW, r * run.rowH);
        }
      }
    }

    ctx.fillStyle = run.colours.head;
    for (i = 0; i < cols.length; i++) {
      col = cols[i];
      if (col.row >= 0 && col.row < run.rows) {
        ctx.fillText(GLYPHS.charAt((Math.random() * GLYPHS.length) | 0), i * run.cellW, col.row * run.rowH);
      }
      col.last = col.row;
    }
  }

  function composite(run, p) {
    var ctx = run.ctx;
    ctx.clearRect(0, 0, run.pw, run.ph);
    if (p.veil > 0) {
      ctx.globalAlpha = p.veil > 1 ? 1 : p.veil;
      ctx.fillStyle = run.colours.ground;
      ctx.fillRect(0, 0, run.pw, run.ph);
    }
    if (p.rain > 0) {
      ctx.globalAlpha = p.rain > 1 ? 1 : p.rain;
      ctx.drawImage(run.buffer, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  /* The mode change itself. Called exactly once per run, from whichever of the three paths
     gets there first, and never twice. */
  function fire(run) {
    if (run.fired) return;
    run.fired = true;
    var action = run.action;
    run.action = null;
    if (typeof action === 'function') {
      try {
        action();
      } catch (err) {
        /* A thrown mode change must not strand the canvas over the page. */
        if (global.console && global.console.error) global.console.error('phosphor: mode change failed', err);
      }
    }
    // The arriving mode may own a different ground; the reveal clears to that one.
    if (run.kind === 'swap') run.colours = palette();
    // Firing a leave run IS the navigation, so from here the cover has to stay up.
    if (run.kind === 'leave') run.hold = true;
  }

  function teardown(run) {
    if (run.torn) return;
    run.torn = true;
    if (run.raf) global.cancelAnimationFrame(run.raf);
    if (run.watchdog) global.clearTimeout(run.watchdog);
    global.removeEventListener('resize', run.onResize);
    global.document.removeEventListener('visibilitychange', run.onHide);
    if (run.canvas.parentNode) run.canvas.parentNode.removeChild(run.canvas);
    if (live === run) live = null;
  }

  function finish(run) {
    if (run.ended) return;
    run.ended = true;
    fire(run);
    if (run.raf) {
      global.cancelAnimationFrame(run.raf);
      run.raf = 0;
    }
    /* A navigation is in flight. Lifting the cover now would put the page being left back on
       screen for however long the next document takes to arrive, which is the one frame this
       whole effect exists to hide. The canvas stays and the watchdog is left armed, so a
       navigation that never lands is still cleaned up. */
    if (run.hold) return;
    teardown(run);
  }

  function start(kind, action) {
    var doc = global.document;
    var canvas = doc.createElement('canvas');
    /* Set here rather than in a stylesheet: see the note at the top. inset is not used
       because this has to hold up on whatever the oldest engine in the house is. */
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '2147483000';
    canvas.setAttribute('aria-hidden', 'true');

    var ctx = canvas.getContext('2d');
    var buffer = doc.createElement('canvas');
    var bctx = buffer.getContext('2d');
    if (!ctx || !bctx) {
      if (typeof action === 'function') action();
      return null;
    }

    var run = {
      kind: kind,
      action: action,
      canvas: canvas,
      ctx: ctx,
      buffer: buffer,
      bctx: bctx,
      colours: palette(),
      t0: 0,
      last: 0,
      raf: 0,
      watchdog: 0,
      fired: false,
      ended: false,
    };

    run.onResize = function () {
      if (!run.ended) sizeRun(run);
    };
    /* A tab that goes away mid-fall never gets another frame, so the run is settled now
       rather than left for a watchdog to find. */
    run.onHide = function () {
      if (doc.hidden) {
        finish(run);
        teardown(run);
      }
    };

    sizeRun(run);
    doc.body.appendChild(canvas);
    /* One frame drawn before returning, because an arriving run has to be covering the page
       by the browser's first paint. Waiting for rAF shows the new mode bare for a frame,
       which is the cut this replaces. For the other two kinds the veil is zero here and this
       is a clear of an empty canvas. */
    composite(run, phaseAt(0, kind));
    global.addEventListener('resize', run.onResize);
    doc.addEventListener('visibilitychange', run.onHide);
    run.watchdog = global.setTimeout(function () {
      finish(run);
      teardown(run);
    }, MAX_MS);

    live = run;

    function frame(now) {
      if (run.ended) return;
      if (!run.t0) {
        run.t0 = now;
        run.last = now;
      }
      // Clamped because a stalled frame would otherwise teleport every column past the
      // bottom edge in one step and empty the screen.
      var dt = Math.min((now - run.last) / 1000, 0.05);
      run.last = now;

      var p = phaseAt(now - run.t0, kind);
      stepRain(run, dt, p);
      composite(run, p);
      if (p.swap) fire(run);
      if (p.done) {
        finish(run);
        return;
      }
      run.raf = global.requestAnimationFrame(frame);
    }

    run.raf = global.requestAnimationFrame(frame);
    return run;
  }

  /* ---------- the three doors ---------- */

  /* basic and pro are two renderings of one page, so the change happens under the cover and
     the same canvas carries both halves. */
  function swap(apply) {
    if (live || !canAnimate()) {
      if (typeof apply === 'function') apply();
      return;
    }
    start('swap', apply);
  }

  /* trade is a different page. The fall covers this one, the flag is left for the next one,
     and the reveal happens over there. */
  function leave(navigate) {
    if (live || !canAnimate()) {
      if (typeof navigate === 'function') navigate();
      return;
    }
    start('leave', function () {
      try {
        global.sessionStorage.setItem(HANDOFF_KEY, String(Date.now()));
      } catch (err) {
        /* private mode, or storage disabled: the switch still happens, it just cuts */
      }
      if (typeof navigate === 'function') navigate();
    });
  }

  /* The other half of leave(). Runs at load, from this file's own body rather than from a
     ready event, so the cover is standing before the arriving page has a chance to paint. */
  function arrive() {
    var raw = null;
    try {
      raw = global.sessionStorage.getItem(HANDOFF_KEY);
      if (raw !== null) global.sessionStorage.removeItem(HANDOFF_KEY);
    } catch (err) {
      return;
    }
    if (!handoffFresh(raw, Date.now())) return;
    if (live || !canAnimate()) return;
    start('arrive', null);
  }

  global.PHOSPHOR_RAIN = {
    swap: swap,
    leave: leave,
    arrive: arrive,
    playing: function () {
      return live !== null;
    },
    // Exported to be tested directly: the shape of the fall and the age rule on the handoff
    // are the two things that decide whether a mode change is visible and whether it lands.
    phaseAt: phaseAt,
    handoffFresh: handoffFresh,
    timings: { coverMs: COVER_MS, holdMs: HOLD_MS, revealMs: REVEAL_MS, maxMs: MAX_MS },
    glyphs: GLYPHS,
  };

  if (global.document && global.document.body) arrive();
})(window);
