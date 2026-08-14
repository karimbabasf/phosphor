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
 *
 * ---------------------------------------------------------------------------------------
 * SECOND PASS, 2026-08-14. Karim, after watching the first one: "it just looks cheap".
 * He was right, and the captures said why. The first version put every column on the screen
 * at once, pre-spread down the page, all of them the same brightness and the same length.
 * Nothing fell: the screen filled with green confetti and then dissolved behind an ordinary
 * crossfade that happened to have characters drawn over it. Five things were missing, and
 * all five are what separates this effect from a screensaver clone:
 *
 *   1. A FRONT. The fall now arrives. Columns start above the top edge with a staggered
 *      lead, so a leading edge sweeps down the page. That is the word he used: waterfall.
 *   2. A HEAD. The leading five rows of every column are redrawn every frame through a
 *      luminance ramp, white-hot at the tip and stepping down to the body green. One glyph
 *      a shade brighter than its trail cannot be found on a full screen, and a fall whose
 *      head cannot be found has no direction.
 *   3. BLOOM. The program is called phosphor and nothing glowed. The heads are stamped into
 *      a sixth-scale buffer and lifted back over the frame with `lighter`, so the upscale
 *      itself is the blur. One small clear, one rect per column, one composite.
 *   4. THE VEIL DOES THE COVERING. The ground is no longer a flat wash over the whole page.
 *      It is a moving front: the old screen is eaten from the top down behind the rain, and
 *      the new one is uncovered from the top down as the rain drains. The characters are the
 *      reason the screen goes, rather than decoration on top of a dissolve.
 *   5. SHIMMER AND DEPTH. The hot rows are re-rolled every frame, so the front crawls. Every
 *      column carries one of three depth tiers, which sets its speed and its brightness, and
 *      roughly a quarter of the slots stay empty, so the streams read as streams instead of
 *      as a filled field.
 *
 * The alphabet was also thinned. Full stops, commas and colons are one or two lit pixels at
 * this size, and mixed in with capitals and box-drawing they gave the field the uneven,
 * dusty texture that read as noise rather than as text.
 *
 * WHAT IT COSTS WHILE PLAYING. Per frame: one full-surface erase and one full-surface fill
 * on the tail buffer, one to three full-surface composites on the visible canvas, one
 * fillText per row each head crossed, five per live column for the hot zone, and one small
 * fillRect per live column into the glow buffer. The tail is not drawn: it is what is left
 * of earlier heads after the erase, which is phosphor decay and is the reason the classic
 * version of this effect is cheap. Measured numbers are in the commit.
 */
(function (global) {
  'use strict';

  /* Timings. The whole thing is under a second and a half: it marks the change, it does not
     become an event of its own. The cover is longer than the first pass because the fall now
     has to travel: a front that arrives needs time to cross the page, and at 380ms the
     slower half of the columns never reached the bottom edge at all. */
  var COVER_MS = 520;
  /* A beat of nothing but rain, and the only part of the run where the veil is exactly
     opaque. Frames land where they land, so without it the mode would change on whichever
     frame first crosses the cover, by then already a percent or two into the reveal, and
     the switch itself would be faintly visible through it. It also reads better: the fall
     arrives, holds, and then there is a different screen behind it. */
  var HOLD_MS = 90;
  var REVEAL_MS = 600;
  var MAX_MS = 4000; // watchdog; roughly three times the longest honest run

  /* How far a glyph's memory reaches, in rows of head travel, at the nominal speed. This is
     the streak length, and it is written in rows rather than as a per-frame fade so that it
     stays what it says when the speeds are changed. A column faster than nominal streaks
     further and a slower one streaks less, which is most of what makes the field read as
     having depth. */
  var TRAIL_ROWS = 22;
  var NOMINAL_SPEED = 210; // rows per second, the middle of the range below after depth
  var TAIL_FLOOR = 0.04; // what is left of a glyph after TRAIL_ROWS, near enough to nothing

  var CELL_PX = 13; // matches --fs, so the fall is on the same grid as the text it replaces
  var COL_PITCH = 1.06; // a hair of gutter; columns that touch read as a wall, not as rain
  var ROW_RATIO = 1.2;
  var MAX_DPR = 2; // a 3rd or 4th device pixel buys nothing on glyphs this small and costs area
  var MIN_SPEED = 150; // rows per second, before the depth tier scales it
  var MAX_SPEED = 340;
  /* Most rows one column may deposit in a frame, however long that frame was. Capped by what
     the ring can still remember, so a stalled frame never deposits a character the screen
     did not show. */
  var MAX_FILL = 6;

  /* Frames an arriving run is stepped through before it is first drawn, so it lands in the
     state the leaving page's run was in rather than starting from an empty screen. One cover
     at 60fps, which is what the other page actually ran. */
  var PRIME_FRAMES = 30;

  /* The leading rows of a column, re-rendered every frame so the ramp can be drawn. This is
     bounded because everything behind it is handed to the tail buffer and never touched
     again. */
  var HOT_ROWS = 5;

  /* A character belongs to the ROW it was drawn on, not to the frame. Each column keeps the
     glyphs for the rows still inside its hot zone, and the hot pass renders those rather
     than rolling new ones.

     Karim, on the first cut of this second pass: "there is a tiny bit of flickering that I
     don't like". It was mine and it was new. Re-rendering the hot zone every frame is right,
     but rolling a fresh character into every one of those cells every frame is not: about
     675 glyphs were changing 60 times a second, which is a boil rather than a shimmer. The
     first pass never did it because it wrote each glyph into the tail buffer once and never
     touched it again. The ring keeps that property and still lets the ramp be redrawn.

     Long enough to hold every row from the head down to the one being deposited, plus one. */
  var RING = HOT_ROWS + 2;

  /* Odds per column per frame that one row behind the head takes a new character. This is
     the shimmer, and it is the whole of it: roughly ten glyphs a frame across the screen
     rather than every one of them. */
  var SHIMMER = 0.08;

  /* Three depth tiers: speed scale, brightness scale, and how many of the slots get it.
     Near columns are faster and brighter, which is the whole of the parallax here. */
  var DEPTH = [
    { speed: 1.0, light: 1.0, share: 0.34 },
    { speed: 0.82, light: 0.62, share: 0.4 },
    { speed: 0.64, light: 0.38, share: 0.26 },
  ];

  /* How many of the column slots carry a stream. The quarter that stay empty are the gutters,
     and they are the difference between reading this as rain and reading it as a fill. */
  var DENSITY = 0.74;
  var DENSE_COLS = 260; // past this many slots the density comes down rather than the frame rate

  /* The luminance ramp down from the head, as [mix toward white, alpha]. Row 0 is the tip.
     Nothing here is the film's neon: the tip is the page's own bright green pushed most of
     the way to white, so the fall still belongs to this program. */
  var RAMP = [
    [0.8, 1.0],
    [0.3, 0.94],
    [0.05, 0.84],
    [-0.35, 0.68],
    [-0.75, 0.54],
  ];
  var TAIL_ALPHA = 0.42; // what a glyph is worth the moment it leaves the hot zone

  /* The bloom. A seventh-scale buffer holding one small rect per head, lifted back over the
     frame with `lighter`: the bilinear upscale is the blur, which is why this costs one
     composite rather than a shadowBlur per glyph.

     The rect is much narrower than the cell it sits in, and that is the whole trick. At a
     sixth scale and a full cell wide the first attempt put a soft RECTANGLE behind every
     head, plain at full size and the last thing on the screen that still read as cheap. A
     mark of about one buffer pixel has no shape of its own left to show once it has been
     scaled back up, so what lands is a round bloom. */
  var GLOW_SCALE = 1 / 7;
  var GLOW_ALPHA = 0.58;
  var GLOW_W = 0.6; // of a cell
  var GLOW_H = 1.5; // of a row, centred a little above the head

  /* How much of a screen height the ground front takes to go from clear to opaque. A hard
     line would read as a wipe rather than as the rain taking the page away. */
  var EDGE_SOFT = 0.2;

  /* The page's own alphabet: ASCII plus the box-drawing characters the panel frames are
     built from. A katakana set would be the film's alphabet rather than this program's, and
     the point of the effect is that the interface comes apart into what it is made of.
     Weighted by repetition rather than picked evenly: letters and digits are the bulk of
     what is on the screen being replaced, and a field of box-drawing reads as a grid. The
     one-pixel punctuation the first pass carried (. , : ; ' `) is gone, because at 13px it
     is dust and dust is what made the field look like static. */
  var GLYPHS =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    '<>[]{}()/\\|-_=+*#$%&@?!' +
    '─│┌┐└┘├┤┬┴┼';

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

     veil    the most opaque the ground gets anywhere on screen: 1 is a covered page
     edge    where the ground front stands, in screen heights from the top. Below -EDGE_SOFT
             is a front that has not arrived; above 1 + EDGE_SOFT is one that has left
     rising  true while the front is giving the page back rather than taking it away
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
        /* The ceiling closes quickly and the front does the rest. Slow to start, so the page
           stays readable for the first breath after a switch is asked for. */
        veil: 1 - Math.pow(1 - t, 2.6),
        /* Decelerating, and set to be behind the leading columns the whole way down: the
           fastest heads reach the bottom around t = 0.36, by which time the dark has only
           reached a little past halfway. Rain first, then dark, is the order that reads as
           the characters being the reason the screen goes. */
        edge: (1 - Math.pow(1 - t, 1.8)) * (1 + 2 * EDGE_SOFT) - EDGE_SOFT,
        rising: false,
        rain: t * 4 < 1 ? t * 4 : 1,
        spawn: true,
        swap: false,
        done: false,
      };
    }

    if (kind === 'leave') {
      // This page is about to be replaced. Nothing after the cover would ever be seen, and
      // drawing it would only delay the navigation.
      return { veil: 1, edge: 2, rising: false, rain: 1, spawn: false, swap: true, done: true };
    }

    if (e < COVER_MS + HOLD_MS) {
      return { veil: 1, edge: 2, rising: false, rain: 1, spawn: true, swap: true, done: false };
    }

    var u = (e - COVER_MS - HOLD_MS) / REVEAL_MS;
    if (u >= 1) return { veil: 0, edge: 2, rising: true, rain: 0, spawn: false, swap: true, done: true };
    return {
      /* Held high on purpose. The front below is what uncovers the page, and a ceiling that
         fell at the same rate would turn the whole thing back into a crossfade. */
      veil: 1 - Math.pow(u, 2.2),
      /* Downward again, because the rain drains off the bottom edge and the top of the page
         is the first place with nothing left standing over it. */
      edge: (1 - Math.pow(1 - Math.min(u / 0.85, 1), 1.8)) * (1 + 2 * EDGE_SOFT) - EDGE_SOFT,
      rising: true,
      rain: u < 0.35 ? 1 : (1 - u) / 0.65,
      spawn: false,
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

  /* ---------- colour ---------- */

  /* Only the two greens are ever taken apart, and both are hex tokens in this repo. The
     ground is never parsed: it is handed to fillStyle whole, so basic's oklch ground works
     without this function knowing what oklch is. */
  function parseRGB(colour, fallback) {
    var s = String(colour || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var parts = m[1].split(/[,\s/]+/);
      if (parts.length >= 3) {
        var r = parseFloat(parts[0]);
        var g = parseFloat(parts[1]);
        var b = parseFloat(parts[2]);
        if (isFinite(r) && isFinite(g) && isFinite(b)) return [r, g, b];
      }
    }
    return fallback;
  }

  /* Positive t walks the colour toward white, negative t walks it toward the body green.
     One function for both ends of the ramp keeps RAMP readable as a single column of stops. */
  function toward(hi, body, t, alpha) {
    var target = t >= 0 ? [255, 255, 255] : body;
    var k = t >= 0 ? t : -t;
    var r = Math.round(hi[0] + (target[0] - hi[0]) * k);
    var g = Math.round(hi[1] + (target[1] - hi[1]) * k);
    var b = Math.round(hi[2] + (target[2] - hi[2]) * k);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
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

    var bodyRGB = parseRGB(body, [51, 255, 102]);
    var headRGB = parseRGB(head, [140, 255, 171]);

    /* Fifteen strings, built once per palette read rather than per glyph: three depth tiers
       by five ramp rows. The frame loop then draws a whole tier-row in one fillStyle, which
       is what keeps the hot zone at fifteen state changes a frame instead of a thousand. */
    var ramp = [];
    for (var d = 0; d < DEPTH.length; d++) {
      var row = [];
      for (var k = 0; k < RAMP.length; k++) {
        row.push(toward(headRGB, bodyRGB, RAMP[k][0], (RAMP[k][1] * DEPTH[d].light).toFixed(3)));
      }
      ramp.push(row);
    }
    var tail = [];
    for (var d2 = 0; d2 < DEPTH.length; d2++) {
      tail.push('rgba(' + bodyRGB[0] + ', ' + bodyRGB[1] + ', ' + bodyRGB[2] + ', ' + (TAIL_ALPHA * DEPTH[d2].light).toFixed(3) + ')');
    }

    return {
      ground: ground,
      ramp: ramp,
      tail: tail,
      glow: 'rgb(' + headRGB[0] + ', ' + headRGB[1] + ', ' + headRGB[2] + ')',
    };
  }

  /* ---------- the run ---------- */

  function pickDepth() {
    var r = Math.random();
    var acc = 0;
    for (var i = 0; i < DEPTH.length; i++) {
      acc += DEPTH[i].share;
      if (r < acc) return i;
    }
    return DEPTH.length - 1;
  }

  function buildColumns(run) {
    var rows = Math.ceil(run.h / run.rowH) + 2;
    var count = Math.ceil(run.w / run.cellW) + 1;
    var density = count > DENSE_COLS ? DENSITY * 0.82 : DENSITY;

    var cols = new Array(count);
    var byDepth = [[], [], []];
    var gutterRun = 0;

    for (var i = 0; i < count; i++) {
      var d = pickDepth();
      /* Everything starts above the top edge, which is the whole of the difference between a
         fall that arrives and a screen that fills. Squared, so the leaders are bunched into a
         front and the stragglers trail out behind it. An arriving run starts here too and is
         then fast-forwarded past it: see the priming in start(). */
      var lead = Math.random();
      var y = -rows * (0.02 + lead * lead * 1.15);
      /* The gutters. A slot that sits the run out is parked far enough above the page that
         no speed brings it down in time, which costs one comparison rather than a branch in
         the frame loop.

         Two in a row is a gutter and four in a row is a hole. An independent coin per slot
         gives runs of four often enough to be seen, and the first look had two of them, so
         the odds are cut hard once one column is already out and the run is capped at two.
         Not a fixed pattern: a regular gutter would read as a printed grid. */
      var out = Math.random() > density;
      if (gutterRun >= 2) out = false;
      else if (gutterRun === 1 && out) out = Math.random() < 0.35;
      if (out) {
        y = -rows * 4;
        gutterRun++;
      } else {
        gutterRun = 0;
      }

      var chars = new Array(RING);
      for (var c = 0; c < RING; c++) chars[c] = glyph();

      var col = {
        y: y,
        depth: d,
        speed: (MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)) * DEPTH[d].speed,
        row: Math.floor(y),
        // The last row handed to the tail buffer. Everything between here and the head is
        // the hot zone, re-rendered every frame so the ramp can be drawn over it.
        deposited: Math.floor(y) - HOT_ROWS,
        // The characters standing on the rows the head has most recently crossed, and the
        // last row that was given one.
        chars: chars,
        filled: Math.floor(y) - 1,
      };
      cols[i] = col;
      byDepth[d].push(i);
    }

    run.rows = rows;
    run.cols = cols;
    run.byDepth = byDepth;
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

    /* The tail buffer works in CSS pixels and the visible canvas in device pixels. The text
       half wants the readable coordinate system; the composite half is whole-surface
       operations that never need one. The hot zone is drawn straight onto the visible canvas
       under a transform it sets and clears itself, because it is not accumulated and putting
       it in the buffer would make it decay along with the tail. */
    run.bctx.setTransform(run.dpr, 0, 0, run.dpr, 0, 0);
    run.bctx.font = CELL_PX + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    run.bctx.textBaseline = 'top';
    run.ctx.font = run.bctx.font;
    run.ctx.textBaseline = 'top';
    run.cellW = Math.max(4, run.bctx.measureText('M').width * COL_PITCH);
    run.rowH = CELL_PX * ROW_RATIO;

    /* The glow buffer is a sixth of the device surface and is drawn in the same CSS pixels
       as everything else, so the frame loop never converts a coordinate. */
    run.glow.width = Math.max(1, Math.round(pw * GLOW_SCALE));
    run.glow.height = Math.max(1, Math.round(ph * GLOW_SCALE));
    /* Identity, deliberately, unlike the other two contexts. A mark this small at a
       fractional offset is antialiased differently on every row it steps through, and its
       brightness pulses with the coverage. The marks are rounded to whole buffer pixels
       instead, which is the second half of the flicker Karim saw and the one on the
       brightest thing on the screen. */
    run.gctx.setTransform(1, 0, 0, 1, 0, 0);
    run.gk = run.dpr * GLOW_SCALE;

    buildColumns(run);
  }

  function glyph() {
    return GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
  }

  /* The ring is indexed by screen row, so a character stays where it was put as the head
     moves off it. Rows go negative above the top edge, which is why the remainder is folded
     rather than used raw. */
  function ringIdx(row) {
    var i = row % RING;
    return i < 0 ? i + RING : i;
  }

  /* Advance every column, hand whatever has fallen out of the hot zone to the tail buffer,
     and fade what is already in there. Nothing is drawn twice: the tail buffer holds only
     what the hot zone has finished with. */
  function stepTails(run, dt, p) {
    var ctx = run.bctx;

    /* Erase rather than paint over. A translucent black wash is the usual way to get the
       trail, but it leaves the buffer opaque, and an opaque buffer cannot be lifted off the
       new screen during the reveal. destination-out fades the standing image toward
       transparent instead, which composites correctly at any veil.

       The rate is derived from TRAIL_ROWS rather than written down as a per-frame constant,
       so the streak stays the length it says it is when the speeds change. */
    var life = TRAIL_ROWS / NOMINAL_SPEED;
    var erase = 1 - Math.pow(TAIL_FLOOR, dt / life);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, ' + erase + ')';
    ctx.fillRect(0, 0, run.w, run.h);
    ctx.globalCompositeOperation = 'source-over';

    var cols = run.cols;
    var rows = run.rows;
    var i;
    var col;

    for (i = 0; i < cols.length; i++) {
      col = cols[i];
      col.y += col.speed * dt;
      col.row = Math.floor(col.y);
      if (col.y > rows) {
        if (p.spawn) {
          col.y = -Math.random() * 14;
          col.row = Math.floor(col.y);
          col.deposited = col.row - HOT_ROWS;
          col.filled = col.row - 1;
          col.depth = pickDepth();
          col.speed = (MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)) * DEPTH[col.depth].speed;
        } else {
          col.y = rows + 1; // parked off the bottom, drawn no more
          col.row = rows + 1;
        }
      }

      /* One new character per row the head has just landed on, and none for the rows it left
         behind. That is the whole of the flicker fix: what is on a row was decided when the
         head reached it. */
      var fillFrom = col.filled + 1;
      if (col.row - fillFrom >= RING) fillFrom = col.row - RING + 1;
      for (var fr = fillFrom; fr <= col.row; fr++) col.chars[ringIdx(fr)] = glyph();
      col.filled = col.row;

      // The shimmer, one row at a time and never the head, which is new anyway.
      if (HOT_ROWS > 1 && Math.random() < SHIMMER) {
        col.chars[ringIdx(col.row - 1 - ((Math.random() * (HOT_ROWS - 1)) | 0))] = glyph();
      }
    }

    /* Every row a head has left behind since the last frame, one glyph each, at the alpha
       the ramp ended on so there is no step in brightness where the hot zone stops. Bounded
       because a stalled frame must not turn into a column of a hundred glyphs.

       Grouped by depth tier so the fill colour is set three times a frame rather than once
       per glyph. */
    for (var d = 0; d < run.byDepth.length; d++) {
      var ids = run.byDepth[d];
      if (!ids.length) continue;
      ctx.fillStyle = run.colours.tail[d];
      for (var n = 0; n < ids.length; n++) {
        col = cols[ids[n]];
        if (col.depth !== d) continue; // re-rolled its tier on a respawn; it draws next frame
        var target = col.row - HOT_ROWS;
        if (target <= col.deposited) continue;
        var first = col.deposited + 1;
        if (target - first >= MAX_FILL) first = target - MAX_FILL + 1;
        for (var r = first; r <= target; r++) {
          // The character the screen already showed on that row, not a new one. A glyph that
          // changes as it freezes is a flicker at the hot zone's own edge.
          if (r >= 0 && r < rows) ctx.fillText(col.chars[ringIdx(r)], ids[n] * run.cellW, r * run.rowH);
        }
        col.deposited = target;
      }
    }
  }

  /* The ground. Not a flat wash: a front that walks down the page, opaque on the side the
     rain has already passed and clear on the side it has not. Carved with destination-out
     against a black gradient rather than drawn as a coloured one, because black-with-alpha
     is the one colour that can be written without knowing what colour space the arriving
     mode's ground is in. Basic's is oklch. */
  function ground(run, p) {
    var ctx = run.ctx;
    if (p.veil <= 0) return;

    ctx.globalAlpha = p.veil > 1 ? 1 : p.veil;
    ctx.fillStyle = run.colours.ground;
    ctx.fillRect(0, 0, run.pw, run.ph);
    ctx.globalAlpha = 1;

    // A front that has left the page entirely is a full cover, and needs no second pass.
    if (p.edge >= 1 + EDGE_SOFT) return;
    if (p.edge <= -EDGE_SOFT) {
      // Nothing is covered yet.
      ctx.clearRect(0, 0, run.pw, run.ph);
      return;
    }

    var top = (p.edge - EDGE_SOFT) * run.ph;
    var bottom = (p.edge + EDGE_SOFT) * run.ph;
    var grad = ctx.createLinearGradient(0, top, 0, bottom);
    if (p.rising) {
      // Giving the page back: everything above the front comes off.
      grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    } else {
      // Taking the page away: everything below the front is not covered yet.
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 1)');
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, run.pw, run.ph);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* The leading rows of every column, re-rendered every frame. Two things here cannot be had
     from the tail buffer: the ramp that makes the head findable, and the heads the bloom is
     built from. It is drawn straight onto the visible canvas, so nothing accumulates.

     The CHARACTERS come from each column's ring and are not re-rolled here. Only the colour
     and the alpha change from frame to frame, which is the difference between a fall that
     shimmers and one that boils. */
  function hot(run, p) {
    var ctx = run.ctx;
    var gctx = run.gctx;
    var cols = run.cols;
    var rows = run.rows;
    var cellW = run.cellW;
    var rowH = run.rowH;
    var i;
    var col;
    var row;

    gctx.clearRect(0, 0, run.glow.width, run.glow.height);
    gctx.fillStyle = run.colours.glow;

    ctx.setTransform(run.dpr, 0, 0, run.dpr, 0, 0);
    ctx.globalAlpha = p.rain > 1 ? 1 : p.rain;

    for (var d = 0; d < run.byDepth.length; d++) {
      var ids = run.byDepth[d];
      if (!ids.length) continue;
      var ramp = run.colours.ramp[d];
      for (var k = 0; k < HOT_ROWS; k++) {
        ctx.fillStyle = ramp[k];
        for (var n = 0; n < ids.length; n++) {
          i = ids[n];
          col = cols[i];
          row = col.row - k;
          if (row < 0 || row >= rows) continue;
          ctx.fillText(col.chars[ringIdx(row)], i * cellW, row * rowH);
        }
      }
    }

    /* The bloom, stamped as rects rather than as glyphs: at a seventh of the surface a
       character is barely a pixel across and a mark of the same size is the same smear once
       it has been scaled back up. Narrow, and a row and a half tall, so the glow sits on the
       tip and leans the way the column is going rather than washing the whole hot zone. */
    var gk = run.gk;
    var gx = cellW * (1 - GLOW_W) * 0.5;
    var gw = Math.max(2, Math.round(cellW * GLOW_W * gk));
    var gh = Math.max(3, Math.round(rowH * GLOW_H * gk));
    for (i = 0; i < cols.length; i++) {
      col = cols[i];
      row = col.row;
      if (row < 0 || row >= rows) continue;
      gctx.globalAlpha = DEPTH[col.depth].light;
      gctx.fillRect(Math.round((i * cellW + gx) * gk), Math.round((row - 0.35) * rowH * gk), gw, gh);
    }
    gctx.globalAlpha = 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (p.rain > 1 ? 1 : p.rain) * GLOW_ALPHA;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(run.glow, 0, 0, run.pw, run.ph);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function composite(run, p) {
    var ctx = run.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, run.pw, run.ph);

    ground(run, p);

    if (p.rain > 0) {
      ctx.globalAlpha = p.rain > 1 ? 1 : p.rain;
      ctx.drawImage(run.buffer, 0, 0);
      ctx.globalAlpha = 1;
      hot(run, p);
    }
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
    var glow = doc.createElement('canvas');
    var gctx = glow.getContext('2d');
    if (!ctx || !bctx || !gctx) {
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
      glow: glow,
      gctx: gctx,
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

    /* An arriving run is the second half of a fall that began on the page before, and the
       page before took its trail buffer and its column positions with it. Built fresh it
       starts thin: no trails at all on the first frame, and columns that have not had time
       to spread, so the reveal lifts off a scatter of short streaks rather than the fall the
       other page was showing a moment ago. Both looks were on the screen and the seam
       between them was the whole giveaway.

       So the run is fast-forwarded through the cover it missed, at the frame rate it would
       have run at, with no composite: the same arithmetic the leaving page did, arriving at
       the same state. About four milliseconds, once, while the page is loading anyway. */
    if (kind === 'arrive') {
      var priming = { spawn: true };
      for (var f = 0; f < PRIME_FRAMES; f++) stepTails(run, 1 / 60, priming);
    }

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
      stepTails(run, dt, p);
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
