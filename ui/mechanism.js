/* MECHANISM: the agent's body, drawn.
 *
 * Everything else on this surface reports what has already happened. This panel reports that
 * something IS happening, which is the one thing a log line structurally cannot say: a line is
 * appended once and never changes, and the interesting part of an agent action is the gap
 * between it arriving and it finishing.
 *
 * Why a canvas and not CSS. ui/style.css states the law of this surface: no radius, no shadow,
 * no gradient, no transition, and exactly two animations, both steps(1) opacity. That law is
 * right and this file does not break it. It moves the motion to where this surface has always
 * had motion: the chart pane, which tweens continuously under a drag and has never read as a
 * second design language. A canvas is also the only place phosphor persistence exists as a
 * primitive. A CRT cell does not cut to black, it decays, and decay is one translucent fill
 * per frame here and is not expressible in CSS at all.
 *
 * The rule the whole file turns on: NOTHING IS TIMED TO A PREDICTED DURATION. Phosphor is an
 * MCP server behind a stdio proxy, so the model thinks in another process and its call arrives
 * already whole. There is no progress to report and no length to guess. So every action winds
 * on an open-ended loop and releases on the real event. A 200ms read and an 8s swap wear the
 * same choreography and neither looks wrong. That is the archer holding the draw.
 */

var MECHANISM = (function () {
  'use strict';

  var cv = null;
  var ctx = null;
  var wrap = null;
  var dpr = 1;
  var W = 0;
  var H = 0;
  var frame = 0;
  var last = 0;

  /* Read once from the stylesheet so this file adds no colour literal. ui/trade.css holds the
     zero-literal record across 720 lines and a hard-coded green here would be the first crack
     in it: a retint is currently a one-block edit and stays that way. */
  var C = null;

  function tokens() {
    if (C) return C;
    var s = getComputedStyle(document.documentElement);
    var pick = function (name, fallback) {
      var v = s.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    C = {
      bg: pick('--bg', '#0b0d0b'),
      hi: pick('--green-hi', '#8cffab'),
      on: pick('--green', '#33ff66'),
      dim: pick('--green-dim', 'rgba(51,255,102,0.62)'),
      faint: pick('--green-faint', 'rgba(51,255,102,0.38)'),
      ghost: pick('--green-ghost', 'rgba(51,255,102,0.22)'),
      red: pick('--red', '#ff3b30')
    };
    return C;
  }

  /* ---------- state ---------- */

  /* Open actions keyed by id. The store on the server guarantees exactly one settle per start,
     including on a throw, so this map cannot leak: see src/agent-action.ts. */
  var open = {};
  var openCount = 0;

  /* drive 0..1 eases toward wanted. This is the ONLY thing in the file with an easing constant
     and it is a physical one: a drive train has inertia, so it spins up over a few hundred ms
     and coasts down slower than it spun up. It is not a transition on a UI element. */
  var drive = 0;
  var wanted = 0;
  var phase = 0;        // accumulated rotation, radians
  var current = null;   // the action being dressed
  var release = null;   // { at, outcome, target } while the release plays
  var RELEASE_MS = 620;

  /* The activity trace. One sample per frame is far too many to keep, so a sample is pushed on
     a fixed clock and carries the drive level, which is what makes a busy minute legible as a
     shape rather than a list. */
  var trace = [];
  var TRACE_MAX = 240;
  var TRACE_MS = 250;
  var traceAt = 0;

  /* Marks on the trace where an action settled, so the eye can find the events inside the
     activity rather than only the activity. */
  var marks = [];
  var MARKS_MAX = 40;

  var IDLE_FRAME_MS = 90;   // at rest the gears still turn, but not at 60fps
  var MACHINE_W = 396;      // the machine occupies the left of the panel, the trace the rest
  // The one place this file writes text on the canvas. Matches the page's own mono stack at
  // its smallest step, so an axis label here is the same object as an axis label on the chart.
  var LABEL_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

  function reducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function now() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  /* ---------- input ---------- */

  function push(payload) {
    var a = payload && payload.action;
    if (!a) return;
    live = true;
    if (payload.phase === 'start') {
      if (!open[a.id]) openCount++;
      open[a.id] = a;
      current = a;
      wanted = 1;
    } else {
      if (open[a.id]) {
        delete open[a.id];
        openCount--;
      }
      release = { at: now(), outcome: a.outcome || 'ok', target: a.target, action: a };
      marks.push({ at: now(), outcome: a.outcome || 'ok' });
      if (marks.length > MARKS_MAX) marks.shift();
      if (openCount <= 0) {
        openCount = 0;
        wanted = 0;
        // current is deliberately kept: the panel goes on naming the last thing the agent did
        // rather than blanking, because a machine at rest is still a machine that just ran.
      }
    }
    words();
    start();
  }

  /* A window that reloaded mid-action still has to wind. The open set rides along on
     /api/state, so a refresh picks the machine up where it was rather than showing rest while
     a swap is in flight.

     Once, and only before the first live frame. /api/state is now refetched on every push from
     the venue feed, which on a moving market is several times a second, and each of those
     carries a snapshot that may already be a round trip out of date. Applying every one of
     them would let a stale snapshot cancel a wind that a 'start' frame had just begun: the
     machine would stutter to rest and back mid-action. The SSE channel is authoritative the
     moment it delivers anything, so this hands over the instant it does. */
  var live = false;

  function hydrate(list) {
    if (live) return;
    open = {};
    openCount = 0;
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) {
        open[list[i].id] = list[i];
        openCount++;
        current = list[i];
      }
    }
    wanted = openCount > 0 ? 1 : 0;
    words();
    start();
  }

  /* ---------- the words ----------
     DOM, not canvas. Text on a canvas is unselectable, invisible to a screen reader and blurry
     at fractional DPR, and none of that is a trade worth making for a label. The law applies
     in full here: these are textContent patches and carry no transition. */

  function setText(id, value, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== value) el.textContent = value;
    if (cls !== undefined && el.className !== cls) el.className = cls;
  }

  function words() {
    var busy = openCount > 0;
    var a = current;
    setText('mech-state', busy ? 'working' : 'idle', busy ? 'v hi' : 'v dim');
    setText('mech-label', a ? a.label : '--', 'v');
    var detail = a && a.detail ? a.detail : '';
    if (!busy && release && release.outcome !== 'ok') detail = release.outcome;
    setText('mech-detail', detail, release && !busy && release.outcome !== 'ok' ? 'dim red' : 'dim');
  }

  /* ---------- the loop ---------- */

  function start() {
    if (frame) return;
    last = now();
    frame = window.requestAnimationFrame(tick);
  }

  function tick(t) {
    frame = 0;
    /* Two different clocks, and conflating them cost a blank panel. `elapsed` is real time
       since the last frame and decides whether the idle gate opens. `dt` is the same figure
       clamped, and is only for integrating the physics: a tab that was backgrounded for a
       minute returns one enormous frame, and feeding that to the drive would snap the whole
       spin-up in a single step. Clamping before the gate is what broke it, because the clamp
       (64ms) sits below the idle interval (90ms), so `dt < IDLE_FRAME_MS` was permanently
       true and the machine skipped every frame forever. */
    var elapsed = t - last;
    var dt = Math.min(64, elapsed);

    /* Reduced motion is honoured by not moving, not by moving less. The panel still reports
       everything it reports: the words update, the stage shows the target it is on, the drive
       level snaps to loaded or idle so the difference is still visible. It simply does not
       turn, breathe, trail or sweep, and it draws once per change instead of per frame. */
    if (reducedMotion()) {
      last = t;
      drive = wanted;
      if (release && t - release.at > RELEASE_MS) release = null;
      draw(t);
      if (release) frame = window.requestAnimationFrame(tick);
      return;
    }

    /* At rest the machine still turns, because a dead panel on a surface whose subject is a
       working machine says the wrong thing. It turns slowly and it turns cheaply: frames are
       skipped until IDLE_FRAME_MS has passed, so an idle window costs about eleven frames a
       second instead of sixty and the rotation is too slow for the difference to be visible.
       Under load the skip is off and it runs at full rate. */
    var moving = drive > 0.002 || wanted > 0 || release !== null;
    if (!moving && elapsed < IDLE_FRAME_MS) {
      frame = window.requestAnimationFrame(tick);
      return;
    }
    last = t;

    /* Inertia. Spin-up is quicker than spin-down: a machine takes load fast and coasts. */
    var k = wanted > drive ? 0.0075 : 0.0028;
    drive += (wanted - drive) * (1 - Math.exp(-k * dt));
    if (Math.abs(wanted - drive) < 0.0015) drive = wanted;

    /* Rotation rate follows load, never a predicted duration. The idle rate is not zero. */
    var rate = 0.00018 + drive * 0.0042;
    phase += rate * dt;

    if (release && t - release.at > RELEASE_MS) release = null;

    if (t - traceAt > TRACE_MS) {
      traceAt = t;
      trace.push(drive);
      if (trace.length > TRACE_MAX) trace.shift();
    }

    draw(t);

    /* Always re-armed, deliberately, and this is the one place the panel spends anything at
       rest. An earlier version stopped dead when nothing was open, which is cheaper and is
       wrong: a machine frozen mid-tooth reads as a screenshot of a machine, and the whole
       claim of this surface is that you are watching one run.
       What makes it affordable is the idle gate above. At rest this draws about eleven frames
       a second over a canvas a few hundred pixels tall, which is less than the chart already
       spends on its own one-second countdown repaint. The browser suspends rAF entirely for a
       hidden tab, so a window left in the background costs nothing at all. */
    frame = window.requestAnimationFrame(tick);
  }

  /* ---------- sizing ---------- */

  function resize() {
    if (!wrap || !cv) return false;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    var d = window.devicePixelRatio || 1;
    if (!w || !h) return false;
    if (w === W && h === H && d === dpr) return false;
    W = w;
    H = h;
    dpr = d;
    // Reallocating the backing store per frame costs a full buffer allocation and a clear
    // every time. Same discipline as ui/chart.js: only on a real size change.
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return true;
  }

  /* ---------- drawing ---------- */

  function draw(t) {
    if (!ctx) return;
    var grew = resize();
    var c = tokens();

    /* Phosphor persistence, and the reason this panel is a canvas at all. Instead of clearing,
       the previous frame is knocked back toward the ground colour, so anything that moved
       leaves a decaying trail and anything static stays crisp because it is redrawn on top at
       full strength every frame. A hard clear would give flat sprite motion; this gives the
       smear a real tube leaves, which is the surface's own name. */
    ctx.globalCompositeOperation = 'source-over';
    if (grew || reducedMotion()) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    var cy = Math.round(H / 2) + 0.5;
    drawTrain(c, cy);
    drawStage(c, cy, t);
    drawTrace(c, cy);
  }

  /* The drive train. Three meshed gears stepping down, left to right: the ratio is real, so
     the small one visibly races and the big one barely moves, which is what makes it read as
     a mechanism rather than three circles spinning at one rate. */
  var GEARS = [
    { x: 58, r: 27, teeth: 14, dir: 1 },
    { x: 102, r: 17, teeth: 10, dir: -1 },
    { x: 131, r: 12, teeth: 8, dir: 1 }
  ];

  function drawTrain(c, cy) {
    for (var i = 0; i < GEARS.length; i++) {
      var g = GEARS[i];
      // Angular velocity scales inversely with radius through the mesh, which is the whole
      // point of a gear train and the only reason it reads as one.
      var a = phase * g.dir * (GEARS[0].r / g.r);
      gear(c, g.x, cy, g.r, g.teeth, a);
    }
    // The output shaft, running from the last gear into the stage.
    ctx.strokeStyle = c.ghost;
    ctx.beginPath();
    ctx.moveTo(GEARS[2].x + GEARS[2].r, cy);
    ctx.lineTo(178, cy);
    ctx.stroke();
  }

  function gear(c, x, y, r, teeth, a) {
    var lit = 0.30 + drive * 0.70;
    ctx.strokeStyle = drive > 0.5 ? c.on : c.dim;
    ctx.globalAlpha = lit;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    for (var i = 0; i < teeth; i++) {
      var th = a + (i / teeth) * Math.PI * 2;
      var cos = Math.cos(th);
      var sin = Math.sin(th);
      ctx.moveTo(x + cos * r, y + sin * r);
      ctx.lineTo(x + cos * (r + 3.5), y + sin * (r + 3.5));
    }
    ctx.stroke();

    // The hub. Two spokes are enough to show rotation and keep the centre readable; a full
    // spoke set at this size turns into a grey disc.
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, r * 0.22), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (var s = 0; s < 2; s++) {
      var ph = a + (s / 2) * Math.PI * 2;
      ctx.moveTo(x + Math.cos(ph) * r * 0.22, y + Math.sin(ph) * r * 0.22);
      ctx.lineTo(x + Math.cos(ph) * r * 0.86, y + Math.sin(ph) * r * 0.86);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ---------- the output stage ----------
     One geometry, dressed per target. Six dressings, not six characters: the difference between
     them is what the far end of the same shaft is driving, which is why they share a baseline,
     a scale and a stroke weight. A cast of mascots would read as a toy on a surface that moves
     real money; a tool head changing on one machine does not. */

  function drawStage(c, cy, t) {
    var rt = release ? Math.min(1, (t - release.at) / RELEASE_MS) : -1;
    var bad = release && release.outcome !== 'ok';
    var x0 = 188;
    var x1 = MACHINE_W - 8;

    /* Nothing has run yet, so no tool head is fitted. This used to fall through to the read
       scan, which draws a sweep across a cell grid and reads as a read in progress: the panel
       claimed the agent was working before it had ever done anything. A machine with no tool
       on the shaft is the honest picture of not started. */
    if (!current && !release) {
      stageRest(c, cy, x0, x1);
      return;
    }
    var target = release ? release.target : current.target;

    if (target === 'order') stageOrder(c, cy, x0, x1, rt, bad);
    else if (target === 'chart') stageChart(c, cy, x0, x1, rt, bad);
    else if (target === 'policy') stagePolicy(c, cy, x0, x1, rt, bad);
    else if (target === 'account') stageAccount(c, cy, x0, x1, rt, bad);
    else if (target === 'view') stageView(c, cy, x0, x1, rt, bad);
    else stageRead(c, cy, x0, x1, rt, bad);
  }

  /* REST. No tool fitted: the shaft ends in a coupling that turns with it and nothing else.
     It still moves, because the drive still turns, so the panel is never a frozen picture. */
  function stageRest(c, cy, x0, x1) {
    var cx = x0 + 22;
    ctx.strokeStyle = c.faint;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.stroke();
    // Two keys on the coupling face, so the rotation is visible on a plain circle.
    ctx.beginPath();
    for (var i = 0; i < 2; i++) {
      var th = phase * 2.2 + (i / 2) * Math.PI * 2;
      ctx.moveTo(cx + Math.cos(th) * 4, cy + Math.sin(th) * 4);
      ctx.lineTo(cx + Math.cos(th) * 11, cy + Math.sin(th) * 11);
    }
    ctx.stroke();
    // The empty tool post, which is what says a head COULD be fitted here.
    ctx.strokeStyle = c.ghost;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + 11, cy);
    ctx.lineTo(cx + 34, cy);
    ctx.moveTo(cx + 34, cy - 7);
    ctx.lineTo(cx + 34, cy + 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ORDER. The bow holds full draw for as long as the work is open, however long that is, and
     looses on the settle. This is the shape of the whole design: tension is a loop with no
     duration, the release is an event. */
  function stageOrder(c, cy, x0, x1, rt, bad) {
    var bx = x0 + 26;
    var tx = x1 - 18;
    // A held draw breathes rather than freezing: a still bow reads as a picture of a bow.
    var breathe = drive > 0.02 ? Math.sin(phase * 2.6) * 1.4 : 0;
    var pull = (rt >= 0 ? 0 : drive) * 15 + (drive > 0.02 ? breathe : 0);

    /* Three brightness tiers, and they are what makes this read as a bow rather than as one
       glyph. An earlier version drew the limb, the string and the arrow at one weight and they
       fused into a single `<|-` mark at this size. The limb is furniture and sits at the
       faintest tier; the string is the tension and follows the drive; the arrow is the thing
       about to happen and is always the brightest object on the stage. */
    var ny = cy;
    var nx = bx + 3 - pull;
    var topX = bx + 16 + Math.cos(Math.PI * 0.62) * 20;
    var topY = cy + Math.sin(Math.PI * 0.62) * 20;
    var botX = bx + 16 + Math.cos(Math.PI * 1.38) * 20;
    var botY = cy + Math.sin(Math.PI * 1.38) * 20;

    // The limb.
    ctx.strokeStyle = c.faint;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(bx + 16, cy, 20, Math.PI * 0.62, Math.PI * 1.38);
    ctx.stroke();

    // The string, drawn to the nock. Brightens with the draw, because tension is the state
    // this stage exists to show.
    ctx.strokeStyle = drive > 0.4 ? c.on : c.dim;
    ctx.globalAlpha = 0.4 + drive * 0.6;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(nx, ny);
    ctx.lineTo(botX, botY);
    ctx.stroke();

    /* The line of aim. Without it the stage is a bow, a void, and a target, and the void is
       most of it. Dashed and very faint, it says the two objects are related and gives the
       eye something to travel while the model is still thinking. */
    ctx.strokeStyle = c.ghost;
    ctx.globalAlpha = 0.30 + drive * 0.45;
    ctx.beginPath();
    for (var g = bx + 68; g < tx - 10; g += 9) {
      ctx.moveTo(g, cy);
      ctx.lineTo(g + 4, cy);
    }
    ctx.stroke();

    // The target: three rings, at the far end of the stage.
    ctx.strokeStyle = c.dim;
    ctx.globalAlpha = 0.55;
    for (var i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(tx, cy, i * 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The arrow. Held at the nock while winding, in flight during the release.
    var ax = nx + 6;
    if (rt >= 0) {
      var e = 1 - Math.pow(1 - rt, 3);
      // The HEAD lands on the target, not the nock: the flight is measured to tx minus the
      // shaft, or a 52px arrow finishes 52px past the rings it was aimed at.
      ax = nx + 6 + (tx - 52 - nx - 6) * Math.min(1, e * 1.35);
      ctx.strokeStyle = bad ? c.red : c.hi;
      if (rt > 0.72) {
        // Struck. The ring lights rather than the arrow, because what matters is the hit.
        ctx.globalAlpha = 1 - (rt - 0.72) / 0.28;
        ctx.beginPath();
        ctx.arc(tx, cy, 5 + (rt - 0.72) * 34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else {
      // Always the brightest tier, whatever the drive. It is the object the whole stage is
      // about, and at rest it is the only thing saying the machine is loaded and waiting.
      ctx.strokeStyle = c.hi;
      ctx.globalAlpha = 0.5 + drive * 0.5;
    }
    /* Long enough that the head clears the limb. The nock sits BEHIND the bow when the string
       is drawn, so a short arrow is entirely inside the arc and the two fuse into one mark:
       the shaft has to be longer than the draw plus the bow's radius before an arrowhead is
       ever visible. This is why it is 52 and not 18. */
    var SHAFT = 52;
    ctx.beginPath();
    ctx.moveTo(ax, cy);
    ctx.lineTo(ax + SHAFT, cy);
    ctx.moveTo(ax + SHAFT, cy);
    ctx.lineTo(ax + SHAFT - 7, cy - 4);
    ctx.moveTo(ax + SHAFT, cy);
    ctx.lineTo(ax + SHAFT - 7, cy + 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* CHART. A lathe: the head traverses the work and a profile appears behind it. The profile
     is drawn from the phase so it is the same curve every pass and reads as a cut, not noise. */
  function stageChart(c, cy, x0, x1, rt, bad) {
    var w = x1 - x0 - 20;
    var trav = (Math.sin(phase * 1.7) * 0.5 + 0.5);
    var hx = x0 + 10 + trav * w;

    ctx.strokeStyle = c.ghost;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(x0 + 6, cy + 16);
    ctx.lineTo(x1 - 6, cy + 16);
    ctx.stroke();

    // The cut profile, revealed left of the head.
    ctx.strokeStyle = drive > 0.4 ? c.on : c.dim;
    ctx.globalAlpha = 0.4 + drive * 0.6;
    ctx.beginPath();
    for (var x = x0 + 10; x < hx; x += 3) {
      var u = (x - x0 - 10) / w;
      var y = cy + 4 - Math.sin(u * 9.4) * 9 - Math.sin(u * 3.1) * 4;
      if (x === x0 + 10) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // The head.
    ctx.strokeStyle = rt >= 0 ? (bad ? c.red : c.hi) : c.hi;
    ctx.globalAlpha = 0.5 + drive * 0.5;
    ctx.beginPath();
    ctx.moveTo(hx, cy - 18);
    ctx.lineTo(hx, cy + 14);
    ctx.moveTo(hx - 4, cy + 14);
    ctx.lineTo(hx, cy + 20);
    ctx.lineTo(hx + 4, cy + 14);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* POLICY. A valve wheel. It creeps while the change is being weighed and seats a quarter
     turn on the settle, which is the only stage that ends somewhere different from where it
     started: a policy change that went through has moved something that stays moved. */
  var seat = 0;
  function stagePolicy(c, cy, x0, x1, rt, bad) {
    var cx = (x0 + x1) / 2;
    var a = phase * 0.5 + seat;
    if (rt >= 0 && rt < 0.02 && !bad) seat += Math.PI / 2;
    var r = 21;

    ctx.strokeStyle = rt >= 0 ? (bad ? c.red : c.hi) : drive > 0.4 ? c.on : c.dim;
    ctx.globalAlpha = 0.45 + drive * 0.55;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < 5; i++) {
      var th = a + (i / 5) * Math.PI * 2;
      ctx.moveTo(cx + Math.cos(th) * 4, cy + Math.sin(th) * 4);
      ctx.lineTo(cx + Math.cos(th) * r, cy + Math.sin(th) * r);
    }
    ctx.stroke();
    // The stem, so the wheel is attached to something.
    ctx.strokeStyle = c.ghost;
    ctx.beginPath();
    ctx.moveTo(cx - r - 10, cy);
    ctx.lineTo(cx - r, cy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ACCOUNT. A beam scale. It swings while the balance is unknown and levels when it is. */
  function stageAccount(c, cy, x0, x1, rt, bad) {
    var cx = (x0 + x1) / 2;
    var swing = drive * Math.sin(phase * 2.1) * 0.22;
    if (rt >= 0) swing *= 1 - rt;
    var hw = 34;
    var dx = Math.cos(swing) * hw;
    var dy = Math.sin(swing) * hw;

    ctx.strokeStyle = rt >= 0 && bad ? c.red : drive > 0.4 ? c.on : c.dim;
    ctx.globalAlpha = 0.45 + drive * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - dy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();
    // The column.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 20);
    ctx.moveTo(cx - 9, cy + 20);
    ctx.lineTo(cx + 9, cy + 20);
    ctx.stroke();
    // The pans.
    for (var s = -1; s <= 1; s += 2) {
      var px = cx + s * dx;
      var py = cy + s * dy;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py + 9);
      ctx.moveTo(px - 7, py + 9);
      ctx.lineTo(px + 7, py + 9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* VIEW. An iris. Three arc segments counter-rotating, aligning on the settle. */
  function stageView(c, cy, x0, x1, rt, bad) {
    var cx = (x0 + x1) / 2;
    ctx.strokeStyle = rt >= 0 ? (bad ? c.red : c.hi) : drive > 0.4 ? c.on : c.dim;
    ctx.globalAlpha = 0.45 + drive * 0.55;
    for (var i = 0; i < 3; i++) {
      var spread = rt >= 0 ? (1 - rt) * 0.9 : 0.9;
      var a = phase * (i % 2 ? -0.9 : 0.9) + (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 12 + i * 6, a, a + spread + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* READ. A scan across a cell grid, the cheapest thing on the surface for the most frequent
     action there is. Seventeen of the thirty-six tools are reads and they must not upstage a
     swap, so this one is deliberately the quietest dressing of the six. */
  function stageRead(c, cy, x0, x1, rt, bad) {
    var cols = 22;
    var rows = 3;
    var gap = 7;
    var gw = cols * gap;
    var sx = (x0 + x1) / 2 - gw / 2;
    var sy = cy - ((rows - 1) * gap) / 2;
    var head = (Math.sin(phase * 2.2) * 0.5 + 0.5) * cols;

    for (var r = 0; r < rows; r++) {
      for (var i = 0; i < cols; i++) {
        var d = Math.abs(i - head);
        var lit = d < 3 ? 1 - d / 3 : 0;
        ctx.globalAlpha = 0.12 + lit * (0.35 + drive * 0.53);
        ctx.strokeStyle = lit > 0.55 ? (rt >= 0 && bad ? c.red : c.hi) : c.faint;
        ctx.beginPath();
        ctx.moveTo(sx + i * gap, sy + r * gap);
        ctx.lineTo(sx + i * gap + 3, sy + r * gap);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- the activity trace ----------
     The right of the panel, and the reason the panel is full width. A minute of agent activity
     as one shape: how hard it has been working and when each action landed. The chart proves a
     scope trace belongs on this surface; this is the same idea pointed at the agent. */

  function drawTrace(c, cy) {
    var x0 = MACHINE_W + 18;
    var x1 = W - 4;
    if (x1 - x0 < 60) return;

    /* The baseline is measured from the BOTTOM of the canvas, not from the centre. The panel
       is 72px tall at full width and 48px stacked, and an axis placed relative to the middle
       put its labels below the canvas edge at the smaller size, where they simply vanished.
       Anchoring to H means the trace keeps its scale on a phone and only loses the words. */
    var base = H - 15;
    var tall = base - (cy - 20);
    var roomForLabels = H >= 62;

    ctx.strokeStyle = c.ghost;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x1, base);
    ctx.stroke();
    // A rule at the left, separating the machine from what it has been doing.
    ctx.beginPath();
    ctx.moveTo(MACHINE_W + 6, cy - 26);
    ctx.lineTo(MACHINE_W + 6, cy + 26);
    ctx.stroke();
    ctx.globalAlpha = 1;

    /* The time axis, and it is what stops this half of the panel reading as empty.
       On a full-width window the trace occupies two thirds of the surface, and until an agent
       has been busy for a minute most of that is one hairline. Unscaled, a hairline across a
       thousand pixels is a void. Scaled, it is a scope at rest, and the difference is four
       ticks and two words. Drawn from the same constants the samples use, so a tick always
       lands where the sample of that age would. */
    var seconds = (TRACE_MAX * TRACE_MS) / 1000;
    var stepPx = (x1 - x0) / (TRACE_MAX - 1);
    ctx.strokeStyle = c.ghost;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    for (var s = 0; s <= seconds; s += 15) {
      var tx = x1 - (s * 1000 / TRACE_MS) * stepPx;
      if (tx < x0) break;
      ctx.moveTo(tx, base);
      ctx.lineTo(tx, base + 4);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (roomForLabels) {
      ctx.fillStyle = c.faint;
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText('-' + Math.round(seconds) + 's', x0 + 2, base + 5);
      ctx.textAlign = 'right';
      ctx.fillText('now', x1 - 2, base + 5);
      ctx.textAlign = 'left';
    }

    if (trace.length < 2) return;
    var span = x1 - x0;
    var step = span / (TRACE_MAX - 1);

    ctx.strokeStyle = c.on;
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    // Oldest sample at the left edge of the window it would have occupied, so the trace scrolls
    // rather than stretching as the buffer fills.
    var lead = TRACE_MAX - trace.length;
    for (var i = 0; i < trace.length; i++) {
      var x = x0 + (lead + i) * step;
      var y = base - trace[i] * tall;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Settle marks. Position is derived from age against the same clock the trace samples on,
    // so a mark sits over the activity that produced it.
    var t = now();
    for (var m = 0; m < marks.length; m++) {
      var age = (t - marks[m].at) / TRACE_MS;
      var mi = TRACE_MAX - 1 - age;
      if (mi < lead || mi > TRACE_MAX - 1) continue;
      var mx = x0 + mi * step;
      ctx.strokeStyle = marks[m].outcome === 'ok' ? c.hi : c.red;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(mx, base + 3);
      ctx.lineTo(mx, base + 8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- boot ---------- */

  function boot() {
    cv = document.getElementById('mech');
    wrap = document.getElementById('mechwrap');
    if (!cv || !wrap || !cv.getContext) return;
    ctx = cv.getContext('2d');
    resize();
    words();
    start();
    window.addEventListener('resize', function () {
      resize();
      start();
    });
  }

  return { boot: boot, push: push, hydrate: hydrate };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    MECHANISM.boot();
  });
} else {
  MECHANISM.boot();
}
