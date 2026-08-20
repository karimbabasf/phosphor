/* agent-globe.js: the rotating globe the agent panel draws, twice, at two sizes.
 *
 * ONE job: say what the agent is doing without a word. It does that in two places, and they
 * are the same drawing on purpose rather than two pictures that nearly agree:
 *
 *   the idle panel   no agent. It is the whole panel, it turns, and it says "press me".
 *   the link badge   an agent. It is about forty pixels in the corner of the live panel, and
 *                    it turns fast and bright while the agent works, slow and dim while it
 *                    waits, and holds one still frame when it is stopped.
 *
 * The badge is why `tune` and `hold` exist; everything else here was already what the idle
 * globe needed. Neither the speed nor the brightness is decided in this file: whoever mounts
 * a globe says what each state looks like, and this draws it.
 *
 * WHY A GLOBE AND NOT THE ORB. ui/presence.js already draws a ball, and it means something
 * else: it is the seat light, and it is on when an agent is WORKING. Two lit balls on one
 * screen saying different things is worse than either alone, so this is a wireframe sphere,
 * a shape the orb never takes. It is Warden's motif (web/viz/shared/scene, gyro rings around
 * a core) flattened to 2D for the same reason presence.js flattened the orb: a shaded WebGL
 * planet would fight a CRT terminal.
 *
 * WHAT IT COSTS. One rAF while it is running, and nothing at all otherwise. It stops itself
 * when the tab is hidden, because a globe nobody can see is a battery bill, and it draws one
 * still frame and never loops when the reader has asked for reduced motion. Two of these on
 * one panel would be two rAF loops, so driver-chat.js runs exactly one at a time and the two
 * are never on screen together.
 *
 * IT IS NOT A BUTTON, AND IT IS NOT A CONTROL. driver-chat.js wraps the idle one in a button
 * and leaves the badge alone. This file draws and nothing else: it has no listeners, reads no
 * state, and calls no API. Whoever mounts it decides when it runs and how fast.
 */

'use strict';

var PhosphorGlobe = (function () {
  var LAT_RINGS = 5;   // rings of latitude, excluding the poles
  var MERIDIANS = 12;  // half-circles pole to pole
  var SEG = 44;        // segments per full circle, enough that the limb reads as curved
  var BANDS = 6;       // depth buckets; every segment in a bucket strokes in one path
  var TILT = 0.42;     // radians the axis leans toward the reader, so rings read as rings
  var SPIN_S = 18;     // seconds per turn, slow enough to be a presence and not a spinner
  var RING_S = 26;     // the two gyro rings, which turn the other way and slower

  /* The rings, as planes rather than as ellipses. `lean` is how far the plane's normal is
     off the globe's axis, `phase` sets them apart so they never lie on top of each other,
     `scale` is the radius as a multiple of the globe's, and `light` is how loud each one is
     allowed to be: the outer one leads and the inner one supports. */
  var RINGS = [
    { lean: 1.22, phase: 0, scale: 1.36, light: 1 },
    { lean: 0.72, phase: 2.1, scale: 1.1, light: 0.52 },
  ];

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function norm(a) {
    var m = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
    return [a[0] / m, a[1] / m, a[2] / m];
  }

  function reduced() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {
      return false;
    }
  }

  /* Read the colour out of the page rather than carrying one. The pro deck hands us its
     phosphor green and the basic screen hands us its calm blue, and this file never learns
     which is which: that is the whole reason the two screens can share the component.

     RESOLVED FROM THE CANVAS, never from the root. The pro terminal's tokens are on :root
     and would have been found either way; the basic screen's are on body[data-view='basic']
     and are not, so reading the root returned nothing, the fallback was taken, and a
     phosphor-green globe was drawn in the middle of the one screen that may never look like
     a terminal. Custom properties inherit, so the element that is going to be painted is
     always the right place to ask. */
  function readRgb(name, fallback, node) {
    var raw = '';
    try {
      raw = getComputedStyle(node || document.documentElement).getPropertyValue(name).trim();
    } catch (err) {
      raw = '';
    }
    var hex = raw.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    var fn = raw.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    /* oklch() and every other modern space: there is no arithmetic here that would convert
       it, so the value is resolved by the browser instead. A one-pixel canvas is cheaper
       than a colour-space library and it is exact, because it is the same engine that will
       paint the rest of the screen. */
    if (raw) {
      try {
        var probe = document.createElement('canvas');
        probe.width = 1;
        probe.height = 1;
        var pctx = probe.getContext('2d');
        pctx.fillStyle = '#000';
        pctx.fillStyle = raw;
        pctx.fillRect(0, 0, 1, 1);
        var px = pctx.getImageData(0, 0, 1, 1).data;
        if (px[3] > 0) return [px[0], px[1], px[2]];
      } catch (err) {
        /* a canvas that will not give up a pixel falls through to the caller's colour */
      }
    }
    return fallback;
  }

  function create(canvas, opts) {
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var options = opts || {};
    /* How loud this globe is allowed to be. The calm screen's blue is a low-chroma token and
       lands dimmer than the terminal's green at the same alpha, so it asks for more. Applied
       to every stroke and to the bloom, and clamped where it would otherwise pass 1. */
    var gain = typeof options.gain === 'number' ? options.gain : 1;

    /* THE DIAL, AND WHY THERE IS ONE. The badge is this same drawing used as a status light,
       and a light that cannot change is not a light: it has to be bright and quick while the
       agent writes and dim and slow while it waits. Both are one multiplier rather than two
       copies of the draw code, because there is one globe in this app and there should stay
       one. `drive` multiplies the mount's own gain instead of replacing it, so the calm
       screen's louder globe stays the louder one at every state. Both start at the idle
       globe's own numbers, so a mount that never calls tune is the globe this file always
       drew. */
    var rate = 1;
    var drive = 1;

    /* The floor under the radius, and why a caller is allowed to drop it. A globe that fills a
       panel must never shrink to a dot when the panel is dragged narrow, so eighteen pixels is
       the smallest it may be. The badge IS a dot: forty pixels of corner, where that floor
       would draw a sphere half again wider than its own canvas. */
    var minR = typeof options.minRadius === 'number' ? options.minRadius : 18;

    /* Resolved on the first frame, not here. The basic screen's tokens hang off
       body[data-view='basic'], and the attribute that switches them on is written by the
       first state frame, which lands AFTER this component is mounted. Reading at create
       time would have caught the page one attribute short of being dressed. */
    var rgb = null;
    var raf = 0;
    var running = false;
    /* The turn, ACCUMULATED rather than read off a start time. A globe whose angle is
       elapsed/SPIN_S jumps the moment the rate changes, because the new speed says it should
       already be somewhere else; adding one frame's worth of turn at the current rate carries
       it on from where it is. It is also what keeps a tab that was away for a minute from
       spinning a minute of catch-up on its way back. */
    var clock = 0;
    var last = 0;
    var frames = 0;

    function rgba(a) {
      var v = a * gain * drive;
      if (v > 1) v = 1;
      return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + v.toFixed(3) + ')';
    }

    function resolve() {
      rgb = readRgb(options.colorVar || '--green', [51, 255, 102], canvas);
    }

    /* Resampled a few times a second rather than cached once, because the token this reads
       can move under a mounted canvas and there is no event that says so. The basic screen's
       palette hangs off body[data-view='basic'], which the FIRST STATE FRAME writes: at mount
       the attribute is not there yet, the calm blue does not resolve, and a globe cached at
       that instant stays phosphor green on the calm screen for as long as the window is open.
       A mode swap is the same problem later. Three getComputedStyle reads a second is not a
       cost worth an observer and a teardown path. */
    var RESAMPLE_FRAMES = 20;

    /* The backing store follows the CSS box times DPR, so the wireframe is a hairline on a
       retina panel instead of a smear. Capped at 2: a third device pixel on a one-pixel
       stroke buys nothing and costs the whole surface again. */
    function fit() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width));
      var h = Math.max(1, Math.round(r.height));
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    /* One point of the sphere, spun about its own axis and then leaned toward the reader.
       Returns screen coordinates plus the depth that decides how bright the segment is:
       +1 is the near pole of the line of sight, -1 the far one. */
    function project(lat, lon, spin, cx, cy, r) {
      var cl = Math.cos(lat);
      var x = cl * Math.sin(lon + spin);
      var y = Math.sin(lat);
      var z = cl * Math.cos(lon + spin);
      var yt = y * Math.cos(TILT) - z * Math.sin(TILT);
      var zt = y * Math.sin(TILT) + z * Math.cos(TILT);
      return { x: cx + x * r, y: cy - yt * r, z: zt };
    }

    /* Segments are bucketed by depth and each bucket is stroked once. A per-segment alpha
       would be a thousand fillStyle changes a frame for a difference the eye reads as six
       steps anyway. */
    function strokeBands(bands, r) {
      for (var b = 0; b < BANDS; b++) {
        var pts = bands[b];
        if (!pts.length) continue;
        var depth = b / (BANDS - 1); // 0 is the far side, 1 the near
        ctx.strokeStyle = rgba((0.07 + depth * 0.5).toFixed(3));
        ctx.lineWidth = 0.7 + depth * 0.55;
        ctx.beginPath();
        for (var i = 0; i < pts.length; i += 4) {
          ctx.moveTo(pts[i], pts[i + 1]);
          ctx.lineTo(pts[i + 2], pts[i + 3]);
        }
        ctx.stroke();
      }
    }

    function draw(elapsed) {
      if (rgb === null || frames % RESAMPLE_FRAMES === 0) resolve();
      frames += 1;
      var box = fit();
      /* A collapsed panel still gets frames, because nothing tells this file the panel was
         folded away. Two property reads and a return is the whole cost of that case. */
      if (box.w < 8 || box.h < 8) return;
      ctx.clearRect(0, 0, box.w, box.h);
      var cx = box.w / 2;
      var cy = box.h / 2;
      var r = Math.max(minR, Math.min(box.w, box.h) * 0.30);
      /* Fewer lines on a small globe. The counts above are read at panel size, where they are
         a wireframe; at badge size the same counts land five strokes inside one pixel and the
         sphere fills in solid, which is the one thing a wireframe is for not doing. */
      var lats = r < 16 ? 3 : LAT_RINGS;
      var meridians = r < 16 ? 7 : MERIDIANS;
      var spin = (elapsed / SPIN_S) * Math.PI * 2;

      // The atmosphere: a soft bloom that stops the wireframe reading as a flat diagram.
      var glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.55);
      glow.addColorStop(0, rgba(0.11));
      glow.addColorStop(0.55, rgba(0.05));
      glow.addColorStop(1, rgba(0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.55, 0, Math.PI * 2);
      ctx.fill();

      var bands = [];
      for (var b = 0; b < BANDS; b++) bands.push([]);
      function push(a, c) {
        var depth = (a.z + c.z) / 2;
        var idx = Math.round(((depth + 1) / 2) * (BANDS - 1));
        if (idx < 0) idx = 0;
        if (idx > BANDS - 1) idx = BANDS - 1;
        var into = bands[idx];
        into.push(a.x, a.y, c.x, c.y);
      }

      var i, j, lat, lon, prev, next;

      // Latitude rings, evenly spread between the poles and never on them.
      for (i = 1; i <= lats; i++) {
        lat = -Math.PI / 2 + (Math.PI * i) / (lats + 1);
        prev = project(lat, 0, spin, cx, cy, r);
        for (j = 1; j <= SEG; j++) {
          next = project(lat, (Math.PI * 2 * j) / SEG, spin, cx, cy, r);
          push(prev, next);
          prev = next;
        }
      }

      // Meridians, pole to pole.
      for (i = 0; i < meridians; i++) {
        lon = (Math.PI * 2 * i) / meridians;
        prev = project(-Math.PI / 2, lon, spin, cx, cy, r);
        for (j = 1; j <= SEG; j++) {
          next = project(-Math.PI / 2 + (Math.PI * j) / SEG, lon, spin, cx, cy, r);
          push(prev, next);
          prev = next;
        }
      }

      strokeBands(bands, r);

      /* The limb. One circle at the silhouette, brighter than anything crossing it, because
         a wireframe without an edge reads as a ball of wool rather than as a sphere. */
      ctx.strokeStyle = rgba(0.42);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      /* The gyro rings. Two circles standing off the surface, turning the other way, and
         projected through the same maths as the sphere rather than drawn as squashed
         ellipses: a ring that is really in the scene passes BEHIND the globe for half its
         length and in front for the other half, and that crossing is the whole read. They
         are Warden's, and they are the part that says this is an agent and not a planet. */
      var ringSpin = -(elapsed / RING_S) * Math.PI * 2;
      for (i = 0; i < RINGS.length; i++) {
        drawRing(RINGS[i], ringSpin, cx, cy, r);
      }
    }

    /* One orbital ring, as a circle in a plane whose normal is spun about the globe's axis.
       u and v span that plane, so cos(t)*u + sin(t)*v walks the circle, and the same TILT
       and depth bucketing the sphere uses then place it in the picture. */
    function drawRing(spec, spin, cx, cy, r) {
      var n = [Math.sin(spec.lean) * Math.sin(spin + spec.phase), Math.cos(spec.lean), Math.sin(spec.lean) * Math.cos(spin + spec.phase)];
      // Any vector not parallel to the normal gives a first basis vector by cross product.
      var u = norm(cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
      var v = norm(cross(n, u));
      var rr = r * spec.scale;
      var bands = [];
      for (var b = 0; b < BANDS; b++) bands.push([]);
      var prev = ringPoint(u, v, 0, cx, cy, rr);
      for (var j = 1; j <= SEG; j++) {
        var next = ringPoint(u, v, (Math.PI * 2 * j) / SEG, cx, cy, rr);
        var depth = (prev.z + next.z) / 2;
        var idx = Math.round(((depth + 1) / 2) * (BANDS - 1));
        if (idx < 0) idx = 0;
        if (idx > BANDS - 1) idx = BANDS - 1;
        bands[idx].push(prev.x, prev.y, next.x, next.y);
        prev = next;
      }
      for (var k = 0; k < BANDS; k++) {
        if (!bands[k].length) continue;
        var lit = k / (BANDS - 1);
        ctx.strokeStyle = rgba(((0.08 + lit * 0.42) * spec.light).toFixed(3));
        ctx.lineWidth = 0.8 + lit * 0.5;
        ctx.beginPath();
        for (var m = 0; m < bands[k].length; m += 4) {
          ctx.moveTo(bands[k][m], bands[k][m + 1]);
          ctx.lineTo(bands[k][m + 2], bands[k][m + 3]);
        }
        ctx.stroke();
      }
    }

    function ringPoint(u, v, t, cx, cy, rr) {
      var c = Math.cos(t);
      var s2 = Math.sin(t);
      var x = u[0] * c + v[0] * s2;
      var y = u[1] * c + v[1] * s2;
      var z = u[2] * c + v[2] * s2;
      var yt = y * Math.cos(TILT) - z * Math.sin(TILT);
      var zt = y * Math.sin(TILT) + z * Math.cos(TILT);
      return { x: cx + x * rr, y: cy - yt * rr, z: zt };
    }

    function frame(now) {
      if (!running) return;
      if (!last) last = now;
      var dt = (now - last) / 1000;
      last = now;
      // A quarter second is the most any one frame is allowed to be worth: see `clock`.
      if (dt > 0.25) dt = 0.25;
      clock += dt * rate;
      draw(clock);
      raf = requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (running && !raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    }

    return {
      start: function () {
        if (running) return;
        running = true;
        /* Re-read every time, not once. A mode swap changes which stylesheet is dressing
           this canvas while the component stays mounted, and a colour cached from the
           screen before would keep the old surface's hue on the new one. */
        resolve();
        if (reduced()) {
          /* One frame, held. The shape still says what it says; it just stops moving, which
             is exactly what was asked for. */
          running = false;
          draw(clock || 2.4);
          return;
        }
        document.addEventListener('visibilitychange', onVisibility);
        last = 0;
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        clock = 0;
        last = 0;
        document.removeEventListener('visibilitychange', onVisibility);
        try {
          var box = canvas.getBoundingClientRect();
          ctx.clearRect(0, 0, Math.max(1, box.width), Math.max(1, box.height));
        } catch (err) {
          /* a canvas already off the page has nothing to clear */
        }
      },
      /* Stop turning, and KEEP THE PICTURE. `stop` clears the canvas because the idle globe
         leaves the page when it stops, and a canvas about to be hidden should not hold a
         frame. The badge does not leave: a stopped agent still has a corner, and what that
         corner has to say is "here, and not working", which is this shape standing still. */
      hold: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
        document.removeEventListener('visibilitychange', onVisibility);
        resolve();
        draw(clock || 2.4);
      },
      /* How fast and how loud, from here on. Applied to the next frame rather than to the
         canvas, so a badge that is already turning changes speed where it is. */
      tune: function (next) {
        if (!next) return;
        if (typeof next.rate === 'number') rate = next.rate;
        if (typeof next.gain === 'number') drive = next.gain;
      },
      running: function () {
        return running;
      },
    };
  }

  return { create: create, readRgb: readRgb };
})();

if (typeof module === 'object' && module.exports) module.exports = PhosphorGlobe;
