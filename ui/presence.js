/* presence.js: the agent SEAT light, in the status bar of the pro and trade windows.
 *
 * ONE job: say whether ANY agent holds the MCP seat and is working right now, whoever started
 * it. An agent running in a terminal on the other side of the desk lights this exactly like one
 * started from the panel in this window, because what it reads is the seat itself (src/agents.ts,
 * connected() and activityAt()) rather than a process this window owns. So a human who just
 * asked for something sees motion instead of a frozen screen, and stillness when nothing is
 * working anywhere.
 *
 * IT IS NOT THE PANEL'S GLOBE. ui/agent-globe.js draws a wireframe sphere inside the agent
 * panel, and that one knows about a single process: the driver that panel started. Read them
 * this way and they never collide. Ball in the window chrome, anything anywhere; sphere in the
 * panel, the agent in that panel. The basic screen hides the status bar (ui/style.css), so
 * there the panel's globe is the only agent light on the page.
 *
 * It is the same idea as Warden's orb and the pulse maths below are lifted from it verbatim
 * (web/viz/shared/scene/AgentCore.tsx: agentCorePulseState / agentCoreSpinMultiplier): a
 * sin(t*2.2) wave drives a heart-scale of 1.04 + w*0.08 and a glow of 1 + crest*0.28, and a
 * working agent spins 1.35x faster. Warden draws a 3D WebGL globe; this is a 2D phosphor-green
 * port, because a lit globe would fight a CRT terminal, but the BEHAVIOUR is the stolen one.
 *
 * Three states, from the two facts this module is told (is an agent connected, when was its
 * last tool call):
 *   working       connected AND a tool call within IDLE_MS   -> full bright, pulsing, spinning
 *   idle          connected but quiet for longer             -> dull, still (it is there, resting)
 *   disconnected  no agent holds the seat                    -> a faint ghost, no motion
 *
 * It renders two things when their canvases are on the page (each optional, handled alone):
 *   #agent-orb     the ball in the status bar
 *   #agent-pulse   the oscilloscope strip under the log, the "something alive" that fills the
 *                  gap so a busy window is never a dead one. Neither window carries this
 *                  canvas right now, so today the orb is the whole of what gets drawn.
 *
 * Driven entirely from outside through window.PhosphorPresence:
 *   note()                     a tool call just happened NOW (from the SSE 'activity' event)
 *   setState(connected, at)    the seat state from /api/state (also seeds the last-activity
 *                              clock so a fresh page load is right before any event arrives)
 */
(function () {
  'use strict';

  // Longer than a single tool call and the model's think time between calls, shorter than a
  // human's patience: a burst of agent work holds the light on across the gaps, and it dulls a
  // few seconds after the agent truly stops rather than flickering between every call.
  var IDLE_MS = 8000;

  // Read the app's own green once so the light can never drift from the palette. Fallback is
  // the literal token in style.css.
  function greenRgb() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--green').trim();
      var m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    } catch (e) {}
    return [51, 255, 102];
  }
  var G = greenRgb();
  function rgba(a) {
    return 'rgba(' + G[0] + ',' + G[1] + ',' + G[2] + ',' + a + ')';
  }

  // ---- state, set from outside ----
  var connected = false;
  var lastActivity = 0; // epoch ms of the last known tool call

  // ---- eased render values, so a state change glides rather than snaps ----
  var bright = 0.14; // current brightness, lerped toward the target for the state
  var spinAngle = 0; // the orb's rotating sheen
  var samples = null; // the strip's scrolling ring buffer of wave heights
  var lastT = null; // perf clock of the previous frame, for dt

  function working() {
    return connected && Date.now() - lastActivity < IDLE_MS;
  }

  // ---- canvases (either may be absent) ----
  var orb = document.getElementById('agent-orb');
  var strip = document.getElementById('agent-pulse');
  var orbCtx = orb && orb.getContext ? orb.getContext('2d') : null;
  var stripCtx = strip && strip.getContext ? strip.getContext('2d') : null;

  // Size the backing store to the CSS box times DPR, so the light is crisp on a retina panel.
  function fit(canvas, ctx) {
    if (!canvas || !ctx) return;
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { w: w, h: h };
  }

  function drawOrb(w, wave) {
    var box = fit(orb, orbCtx);
    if (!box) return;
    var ctx = orbCtx;
    ctx.clearRect(0, 0, box.w, box.h);
    var cx = box.w / 2;
    var cy = box.h / 2;
    var crest = (wave + 1) / 2;
    // Warden's numbers, applied only while working; at rest the ball is a plain disc.
    var heartScale = w ? 1.04 + wave * 0.08 : 1;
    var glowMult = w ? 1 + crest * 0.28 : 1;
    var base = Math.min(box.w, box.h) / 2;
    var coreR = base * 0.44 * heartScale;
    var glowR = base * (w ? 0.98 : 0.72) * glowMult;

    // Outer glow: a soft radial bloom, brighter and wider when working.
    var g = ctx.createRadialGradient(cx, cy, coreR * 0.5, cx, cy, glowR);
    g.addColorStop(0, rgba(0.55 * bright));
    g.addColorStop(1, rgba(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Core disc.
    var core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, coreR * 0.1, cx, cy, coreR);
    core.addColorStop(0, rgba(Math.min(1, 0.95 * bright + 0.05)));
    core.addColorStop(1, rgba(0.7 * bright));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Rotating sheen: a bright point orbiting the rim, the 2D stand-in for Warden's spinning
    // gyro rings. Only visible while working, where the spin is 1.35x.
    if (w) {
      var hx = cx + Math.cos(spinAngle) * coreR * 0.55;
      var hy = cy + Math.sin(spinAngle) * coreR * 0.55;
      var sheen = ctx.createRadialGradient(hx, hy, 0, hx, hy, coreR * 0.7);
      sheen.addColorStop(0, rgba(0.85 * bright));
      sheen.addColorStop(1, rgba(0));
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.arc(hx, hy, coreR * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawStrip(w, dt) {
    var box = fit(strip, stripCtx);
    if (!box) return;
    var ctx = stripCtx;
    var n = Math.max(2, Math.round(box.w));
    if (!samples || samples.length !== n) {
      samples = new Array(n);
      for (var i = 0; i < n; i++) samples[i] = 0;
    }
    // Advance the scroll: push one new height on the right, drop the oldest on the left. The
    // new height is a wave whose amplitude is the state. Working is a lively signal; idle is a
    // low resting ripple; disconnected flatlines.
    var phase = (performance.now() / 1000) * (w ? 7.5 : 2.2);
    var amp = w ? 0.72 : connected ? 0.12 : 0.03;
    var h = Math.sin(phase) * 0.6 + Math.sin(phase * 2.3 + 1.1) * 0.4;
    samples.shift();
    samples.push(h * amp);

    // Phosphor trail: fade the whole strip a little each frame instead of clearing, so the
    // crest leaves a decaying glow behind it, the same decay the app is named for.
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(11,13,11,0.28)';
    ctx.fillRect(0, 0, box.w, box.h);

    var mid = box.h / 2;
    var reach = box.h * 0.42;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(0.14 + 0.7 * bright * (w ? 1 : 0.5));
    ctx.beginPath();
    for (var x = 0; x < n; x++) {
      var y = mid - samples[x] * reach;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // A brighter head on the leading edge so the eye follows the live end.
    var hy = mid - samples[n - 1] * reach;
    var head = ctx.createRadialGradient(n - 1, hy, 0, n - 1, hy, 6);
    head.addColorStop(0, rgba(0.9 * bright));
    head.addColorStop(1, rgba(0));
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.arc(n - 1, hy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    if (lastT === null) lastT = now;
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    var w = working();
    // Target brightness by state, eased (Warden lerps its glow the same way).
    var target = w ? 1 : connected ? 0.5 : 0.14;
    bright += (target - bright) * (1 - Math.exp(-6 * dt));

    var t = now / 1000;
    var wave = Math.sin(t * 2.2); // the shared Warden wave
    spinAngle += dt * 2.4 * (w ? 1.35 : 1); // 1.35x while working, Warden's spin multiplier

    if (orbCtx) drawOrb(w, wave);
    if (stripCtx) drawStrip(w, dt);

    requestAnimationFrame(frame);
  }

  // Only run the loop if there is something to draw.
  if (orbCtx || stripCtx) requestAnimationFrame(frame);

  window.PhosphorPresence = {
    // A tool call happened now. Client clock, which on a loopback app is the server's clock.
    note: function () {
      lastActivity = Date.now();
    },
    // Seat state from /api/state. `at` is the server's epoch-ms of the last tool call (or null).
    setState: function (isConnected, at) {
      connected = !!isConnected;
      if (typeof at === 'number' && at > lastActivity) lastActivity = at;
      if (!connected) lastActivity = 0; // a dropped agent is idle at once, not IDLE_MS later
    },
  };
})();
