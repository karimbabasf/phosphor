/* The field: vertical hairlines bent by drifting Perlin noise, the same one the
   website draws behind its hero (phosphor-site, js/page.js, after reactbits'
   Waves without React or its pointer physics), carried into the window for
   the first run. Light at low alpha on the ink, so it reads as a texture the
   eye rests on rather than a picture it looks at. Karim, 2026-09-15: "a
   completely black screen on the background", with "the same shader on the
   website" behind the welcome.

   In the window it owns no animation loop. The canvas registers with
   PhosphorMotion at 30 fps, paints once under reduced motion, and is released
   when the screen closes. A mask on the canvas (firstrun.css) clears an
   ellipse behind the card, sized here from the card's box, so the card sits on
   plain ground and the lines fade in around it.

   window.PhosphorField
     mount(canvas, opts) -> handle   opts.clear: the element whose box the mask
                                      clears; opts.fps: the cap, 30 by default
     refit()                         re-read the cleared element's box now
     unmount()                       stop drawing and release the canvas */
(function () {
  'use strict';

  var cfg = { xGap: 10, yGap: 24, ampX: 32, ampY: 16, speedX: 0.0125, speedY: 0.005 };
  /* The lines are the warm light every surface lifts toward (--hi-rgb in
     tokens.css), read once per mount, so the field sits on the charcoal in the
     window's own light rather than a cool grey of its own. */
  var STROKE_ALPHA = 0.14;
  function strokeOf() {
    var hi = '';
    try { hi = getComputedStyle(document.documentElement).getPropertyValue('--hi-rgb').trim(); } catch (e) { hi = ''; }
    return 'rgba(' + (hi || '255, 232, 220') + ', ' + STROKE_ALPHA + ')';
  }
  var DPR_CAP = 2;
  var FPS = 30;

  /* Perlin, with its own permutation table: no dependency, and the same table
     the site uses, shuffled once per load so no two runs bend alike. */
  var perm = new Uint8Array(512);
  (function shuffle() {
    var p = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i += 1) p[i] = i;
    for (i = 255; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (i = 0; i < 512; i += 1) perm[i] = p[i & 255];
  })();
  var grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function g(i, j) { return grad[perm[(i & 255) + perm[j & 255]] & 7]; }
  function dot(v, dx, dy) { return v[0] * dx + v[1] * dy; }
  function noise(x, y) {
    var X = Math.floor(x);
    var Y = Math.floor(y);
    x -= X;
    y -= Y;
    var u = fade(x);
    return lerp(
      lerp(dot(g(X, Y), x, y), dot(g(X + 1, Y), x - 1, y), u),
      lerp(dot(g(X, Y + 1), x, y - 1), dot(g(X + 1, Y + 1), x - 1, y - 1), u),
      fade(y));
  }

  var live = null;

  function mount(canvas, opts) {
    unmount();
    var motion = window.PhosphorMotion;
    if (!canvas || !motion || typeof motion.register !== 'function' || typeof canvas.getContext !== 'function') return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var options = opts || {};
    var state = {
      canvas: canvas,
      ctx: ctx,
      clear: options.clear || null,
      stroke: strokeOf(),
      W: 0,
      H: 0,
      lines: [],
      dirty: true,
      handle: null,
      observer: null,
      onResize: null,
      offReduced: null
    };
    live = state;

    /* Sized to the canvas's own box (fixed, inset 0: the window), at most two
       device pixels per CSS pixel. The lines are rebuilt only when that box
       changes, which is what makes a frame cheap. */
    function size() {
      var fit = motion.fitCanvas(canvas, DPR_CAP);
      if (fit.changed || fit.w !== state.W || fit.h !== state.H || state.lines.length === 0) {
        state.W = fit.w;
        state.H = fit.h;
        ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
        state.lines = [];
        var nx = Math.ceil((state.W + 200) / cfg.xGap);
        var ny = Math.ceil((state.H + 30) / cfg.yGap);
        var x0 = (state.W - cfg.xGap * nx) / 2;
        var y0 = (state.H - cfg.yGap * ny) / 2;
        for (var i = 0; i <= nx; i += 1) {
          var pts = [];
          for (var j = 0; j <= ny; j += 1) pts.push({ x: x0 + cfg.xGap * i, y: y0 + cfg.yGap * j, px: 0, py: 0 });
          state.lines.push(pts);
        }
      }
      state.dirty = false;
      refit();
    }

    function step(t) {
      for (var i = 0; i < state.lines.length; i += 1) {
        var pts = state.lines[i];
        for (var j = 0; j < pts.length; j += 1) {
          var p = pts[j];
          var m = noise((p.x + t * cfg.speedX) * 0.002, (p.y + t * cfg.speedY) * 0.0015) * 12;
          p.px = p.x + Math.cos(m) * cfg.ampX;
          p.py = p.y + Math.sin(m) * cfg.ampY;
        }
      }
    }

    /* One smooth curve through each column (Catmull-Rom as cubic Beziers), so
       a bend is a bend and never a joint between two straight sticks. */
    function paint() {
      ctx.clearRect(0, 0, state.W, state.H);
      ctx.strokeStyle = state.stroke;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var i = 0; i < state.lines.length; i += 1) {
        var pts = state.lines[i];
        var n = pts.length - 1;
        ctx.moveTo(pts[0].px, pts[0].py);
        for (var j = 0; j < n; j += 1) {
          var a = pts[Math.max(0, j - 1)];
          var b = pts[j];
          var c = pts[j + 1];
          var d = pts[Math.min(n, j + 2)];
          ctx.bezierCurveTo(
            b.px + (c.px - a.px) / 6, b.py + (c.py - a.py) / 6,
            c.px - (d.px - b.px) / 6, c.py - (d.py - b.py) / 6,
            c.px, c.py);
        }
      }
      ctx.stroke();
    }

    function draw(now) {
      if (state.dirty) size();
      step(now || 0);
      paint();
    }

    var reduced = typeof motion.reduced === 'function' && motion.reduced();
    state.handle = motion.register(canvas, draw, { fps: options.fps || FPS, observe: false, isStatic: reduced });
    if (typeof motion.onReducedChange === 'function') {
      state.offReduced = motion.onReducedChange(function (on) {
        if (state.handle) state.handle.setStatic(on);
      });
    }
    state.onResize = function () {
      state.dirty = true;
      if (state.handle) state.handle.invalidate();
    };
    window.addEventListener('resize', state.onResize);
    if (state.clear && typeof ResizeObserver === 'function') {
      state.observer = new ResizeObserver(function () { refit(); });
      state.observer.observe(state.clear);
    }
    return state.handle;
  }

  /* The mask clears an ellipse behind the card: fully clear out to 62 percent
     of its radius, so each radius is the card's half size over 0.62, and the
     centre is the card's own, wherever the screen has put it. */
  function refit() {
    if (!live || !live.clear || typeof live.clear.getBoundingClientRect !== 'function') return;
    var box = live.clear.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var style = live.canvas.style;
    style.setProperty('--rx', Math.round(box.width / 2 / 0.62) + 'px');
    style.setProperty('--ry', Math.round(box.height / 2 / 0.62) + 'px');
    style.setProperty('--fx', Math.round(box.left + box.width / 2) + 'px');
    style.setProperty('--fy', Math.round(box.top + box.height / 2) + 'px');
  }

  function unmount() {
    var state = live;
    if (!state) return;
    live = null;
    if (state.handle) state.handle.destroy();
    if (state.observer) state.observer.disconnect();
    if (state.offReduced) state.offReduced();
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    state.lines = [];
  }

  window.PhosphorField = { mount: mount, refit: refit, unmount: unmount };
})();
