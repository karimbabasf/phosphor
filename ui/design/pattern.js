/* Phosphor pattern: the hiding-squares field.

   A grid of square cells. Each cell holds a square. 3D value-gradient noise
   (two space axes, one slow time axis) decides how far each square opens:
   where the noise is low the square fills its cell and the field reads solid,
   where it is high the square shrinks, slides and twists, and the ground shows
   at the cell corners.

   The field is the app's status light. Four intensities: idle, working,
   waiting, locked. State changes ease over about 600 ms, they never jump.

   window.PhosphorPattern
     mount(node, options) -> field

   field
     setState(name)    'idle' | 'working' | 'waiting' | 'locked'
     state             current name
     resize()          re-fit after a layout change
     refreshColors()   re-read the CSS custom properties after a theme change
     destroy()         drop the motion handle and the canvas
     stats()           motion handle stats, for the measurement harness

   Geometry is constrained so a square never leaves its own cell, which is why
   there is no per-cell clip. Squares share one fill colour, so the only thing
   that reads is the ground between them.
*/
(function () {
  'use strict';

  var FALLBACK_SQUARE = [0x16, 0x17, 0x1b];
  var FALLBACK_GROUND = [0x09, 0x09, 0x0b];

  /* Shape limits at full openness, as fractions of the cell. */
  var SHRINK = 0.46;      /* how much smaller a fully open square gets */
  var OFFSET = 0.22;      /* slide, the reference intensity of 18 per 100 */
  var ROT_MAX = 0.30;     /* radians */
  var NOISE_SPAN = 4.0;   /* noise units across the whole field width */
  var BLEED = 0.6;        /* px of overdraw, hides antialiased cell seams */
  var HALF_BLEED = 0.3;
  var ROT_EPS = 0.006;    /* below this the cheap fillRect path is used */
  var EASE_TAU = 200;     /* ms, about 600 ms to settle */
  var RAMP_STEPS = 32;
  var NOISE_GAIN = 1.35;  /* lifts Perlin's practical range toward -1..1 */

  var STATES = {
    idle:    { open: 0.52, gate: 0.46, zRate: 0.025, contrast: 1.00, rowMix: 0 },
    working: { open: 1.00, gate: 0.28, zRate: 0.115, contrast: 1.00, rowMix: 0 },
    waiting: { open: 0.30, gate: 0.50, zRate: 0.000, contrast: 1.00, rowMix: 1 },
    locked:  { open: 0.26, gate: 0.58, zRate: 0.011, contrast: 0.66, rowMix: 0 }
  };

  /* ---------------------------------------------------------------- noise */

  /* Improved Perlin in 3D over a permutation table shuffled from the seed.
     No dependency: the table, the fade curve and the gradients are all here. */
  function makeNoise(seed) {
    var base = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i += 1) base[i] = i;

    var s = (seed >>> 0) || 0x9e3779b9;
    for (i = 255; i > 0; i -= 1) {
      s ^= (s << 13); s = s >>> 0;
      s ^= (s >>> 17);
      s ^= (s << 5); s = s >>> 0;
      var j = s % (i + 1);
      var swap = base[i]; base[i] = base[j]; base[j] = swap;
    }

    var p = new Uint8Array(512);
    for (i = 0; i < 512; i += 1) p[i] = base[i & 255];

    function grad(hash, x, y, z) {
      var h = hash & 15;
      var u = h < 8 ? x : y;
      var v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
      return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }

    return function noise3(x, y, z) {
      var fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
      var X = fx & 255, Y = fy & 255, Z = fz & 255;
      x -= fx; y -= fy; z -= fz;

      var u = x * x * x * (x * (x * 6 - 15) + 10);
      var v = y * y * y * (y * (y * 6 - 15) + 10);
      var w = z * z * z * (z * (z * 6 - 15) + 10);

      var A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
      var B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;

      var x1 = x - 1, y1 = y - 1, z1 = z - 1;

      var g0 = grad(p[AA], x, y, z);
      var g1 = grad(p[BA], x1, y, z);
      var g2 = grad(p[AB], x, y1, z);
      var g3 = grad(p[BB], x1, y1, z);
      var g4 = grad(p[AA + 1], x, y, z1);
      var g5 = grad(p[BA + 1], x1, y, z1);
      var g6 = grad(p[AB + 1], x, y1, z1);
      var g7 = grad(p[BB + 1], x1, y1, z1);

      var a0 = g0 + u * (g1 - g0);
      var a1 = g2 + u * (g3 - g2);
      var a2 = g4 + u * (g5 - g4);
      var a3 = g6 + u * (g7 - g6);

      var b0 = a0 + v * (a1 - a0);
      var b1 = a2 + v * (a3 - a2);
      return b0 + w * (b1 - b0);
    };
  }

  /* ---------------------------------------------------------------- colour */

  function parseColor(text, fallback) {
    var raw = (text || '').replace(/^\s+|\s+$/g, '');
    if (!raw) return fallback;
    if (raw.charAt(0) === '#') {
      var hex = raw.slice(1);
      if (hex.length === 3) {
        hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) +
              hex.charAt(2) + hex.charAt(2);
      }
      if (hex.length < 6) return fallback;
      var n = parseInt(hex.slice(0, 6), 16);
      if (isNaN(n)) return fallback;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var parts = raw.match(/[\d.]+/g);
    if (parts && parts.length >= 3) {
      return [Math.round(+parts[0]) & 255, Math.round(+parts[1]) & 255, Math.round(+parts[2]) & 255];
    }
    return fallback;
  }

  function readToken(name, fallback) {
    if (!name) return fallback;
    if (name.charAt(0) !== '-') return parseColor(name, fallback);
    var style = getComputedStyle(document.documentElement);
    return parseColor(style.getPropertyValue(name), fallback);
  }

  /* A ladder of fill strings from the ground colour up to the square colour.
     Built once, indexed per frame, so easing contrast allocates nothing. */
  function buildRamp(ground, square) {
    var ramp = new Array(RAMP_STEPS + 1);
    for (var i = 0; i <= RAMP_STEPS; i += 1) {
      var t = i / RAMP_STEPS;
      var r = Math.round(ground[0] + (square[0] - ground[0]) * t);
      var g = Math.round(ground[1] + (square[1] - ground[1]) * t);
      var b = Math.round(ground[2] + (square[2] - ground[2]) * t);
      ramp[i] = 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    return ramp;
  }

  /* ----------------------------------------------------------------- mount */

  function mount(node, options) {
    var opts = options || {};
    var motion = window.PhosphorMotion;
    /* A cell has a size, not a count. Seventeen across a 1440 window made
       85 px tiles that read as a floor rather than a field, and the same count
       inside a 300 px panel made 17 px ones. The target is a physical size and
       the count follows the container. */
    var cellPx = Math.max(8, opts.cellPx || 42);
    var fixedCells = opts.cells ? Math.max(2, Math.round(opts.cells)) : 0;
    /* Scales the whole amplitude. The hero card sits on top of the field and
       wants it quieter there than out in the margins. */
    var amp = opts.amplitude === undefined ? 1 : opts.amplitude;
    var seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
    var fps = opts.fps || 24;

    var canvas = document.createElement('canvas');
    var css = canvas.style;
    css.position = 'absolute';
    css.inset = '0';
    css.top = '0'; css.left = '0';
    css.width = '100%';
    css.height = '100%';
    css.display = 'block';
    css.pointerEvents = 'none';
    css.opacity = String(opts.opacity === undefined ? 1 : opts.opacity);
    node.appendChild(canvas);

    var ctx = canvas.getContext('2d', { alpha: false });
    var noise3 = makeNoise(seed);

    /* One extra pull on the seed picks the row that shifts while waiting.
       It never moves once chosen, so a state change cannot make it jump. */
    var pick = seed || 1;
    pick ^= (pick << 13); pick = pick >>> 0;
    pick ^= (pick >>> 17);
    pick ^= (pick << 5); pick = pick >>> 0;
    var rowPick = (pick % 1000) / 1000;

    var squareRgb = FALLBACK_SQUARE;
    var groundRgb = FALLBACK_GROUND;
    var ramp = null;
    var groundFill = '#09090B';

    var viewW = 0, viewH = 0, dpr = 1;
    var cell = 1, cellHalf = 0.5, cols = 2, rows = 1;
    var originX = 0, originY = 0, shiftRow = 0;
    var colPx = null, rowPx = null, colN = null, rowN = null;

    var state = STATES[opts.state] ? opts.state : 'idle';
    var target = STATES[state];
    var open = target.open, gate = target.gate, zRate = target.zRate;
    var contrast = target.contrast, rowMix = target.rowMix;
    var z = 0;
    var handle = null;
    var destroyed = false;

    function refreshColors() {
      squareRgb = readToken(opts.squareColor || '--bg-2', FALLBACK_SQUARE);
      groundRgb = readToken(opts.groundColor || '--bg-0', FALLBACK_GROUND);
      ramp = buildRamp(groundRgb, squareRgb);
      groundFill = ramp[0];
      if (handle) handle.invalidate();
    }

    function layout() {
      var fit = motion.fitCanvas(canvas, 2);
      viewW = fit.w; viewH = fit.h; dpr = fit.dpr;

      cols = fixedCells || Math.max(2, Math.round(viewW / cellPx));
      cell = viewW / cols;
      cellHalf = cell * 0.5;
      rows = Math.max(1, Math.ceil(viewH / cell) + 1);
      originX = 0;
      originY = -(rows * cell - viewH) * 0.5;
      shiftRow = Math.min(rows - 1, Math.floor(rowPick * rows));

      var step = NOISE_SPAN / cols;
      colPx = new Float32Array(cols);
      colN = new Float32Array(cols);
      rowPx = new Float32Array(rows);
      rowN = new Float32Array(rows);
      var i;
      for (i = 0; i < cols; i += 1) {
        colPx[i] = originX + i * cell;
        colN[i] = i * step;
      }
      for (i = 0; i < rows; i += 1) {
        rowPx[i] = originY + i * cell;
        rowN[i] = i * step;
      }
    }

    /* Every param eases toward its target with the same framerate independent
       exponential step, so a state change is one smooth slide, not a cut. */
    function ease(dtMs) {
      var k = 1 - Math.exp(-dtMs / EASE_TAU);
      open += (target.open - open) * k;
      gate += (target.gate - gate) * k;
      zRate += (target.zRate - zRate) * k;
      contrast += (target.contrast - contrast) * k;
      rowMix += (target.rowMix - rowMix) * k;
    }

    function snap() {
      open = target.open; gate = target.gate; zRate = target.zRate;
      contrast = target.contrast; rowMix = target.rowMix;
    }

    function settled() {
      return Math.abs(target.open - open) < 0.002 &&
             Math.abs(target.gate - gate) < 0.002 &&
             Math.abs(target.zRate - zRate) < 0.0004 &&
             Math.abs(target.contrast - contrast) < 0.004 &&
             Math.abs(target.rowMix - rowMix) < 0.004;
    }

    function draw(now, dtMs) {
      var dt = dtMs > 0 ? (dtMs > 100 ? 100 : dtMs) : 16;
      if (motion.reduced()) snap(); else ease(dt);
      z += zRate * dt * 0.001;

      var base = dpr;
      ctx.setTransform(base, 0, 0, base, 0, 0);
      ctx.fillStyle = groundFill;
      ctx.fillRect(0, 0, viewW, viewH);

      var level = Math.round(contrast * RAMP_STEPS);
      if (level < 0) level = 0; else if (level > RAMP_STEPS) level = RAMP_STEPS;
      if (level === 0) { finish(); return; }
      ctx.fillStyle = ramp[level];

      var span = 1 - gate;
      if (span < 0.02) span = 0.02;
      var invSpan = 1 / span;
      var slide = OFFSET * cell * amp;
      var rowShift = cell * 0.42 * rowMix;
      var rowKeep = 1 - rowMix;
      var rowSide = cell * 0.84;
      var transformed = false;
      var r, c;

      for (r = 0; r < rows; r += 1) {
        var py = rowPx[r];
        var ny = rowN[r];
        var isShift = (r === shiftRow && rowMix > 0.002);

        for (c = 0; c < cols; c += 1) {
          var nx = colN[c];

          var hn = (noise3(nx, ny, z) * NOISE_GAIN * 0.5 + 0.5 - gate) * invSpan;
          if (hn < 0) hn = 0; else if (hn > 1) hn = 1;
          hn = hn * hn * (3 - 2 * hn); /* pushes cells toward shut or open */

          var mag = hn * open;
          var side = cell - cell * SHRINK * mag;
          var dx = 0, dy = 0, rot = 0;

          if (mag > 0.0005) {
            var ox = noise3(nx + 41.3, ny + 17.7, z * 0.83 + 9.1);
            var oy = noise3(nx + 5.9, ny + 63.1, z * 0.71 + 31.4);
            dx = ox * slide * mag;
            dy = oy * slide * mag;
            rot = (ox * 0.6 - oy * 0.6) * ROT_MAX * mag;
          }

          if (isShift) {
            side = side + (rowSide - side) * rowMix;
            dx = dx * rowKeep + rowShift;
            dy = dy * rowKeep;
            rot = rot * rowKeep;
          }

          var half = side * 0.5;
          var cx = colPx[c] + cellHalf;
          var cy = py + cellHalf;
          var spin = rot < 0 ? -rot : rot;

          if (spin > ROT_EPS) {
            var co = Math.cos(rot), si = Math.sin(rot);
            var reach = half * ((co < 0 ? -co : co) + (si < 0 ? -si : si));
            var room = cellHalf - reach;
            if (room < 0) room = 0;
            if (dx > room) dx = room; else if (dx < -room) dx = -room;
            if (dy > room) dy = room; else if (dy < -room) dy = -room;
            ctx.setTransform(base * co, base * si, -base * si, base * co,
                             base * (cx + dx), base * (cy + dy));
            ctx.fillRect(-half - HALF_BLEED, -half - HALF_BLEED,
                         side + BLEED, side + BLEED);
            transformed = true;
          } else {
            var flat = cellHalf - half;
            if (flat < 0) flat = 0;
            if (dx > flat) dx = flat; else if (dx < -flat) dx = -flat;
            if (dy > flat) dy = flat; else if (dy < -flat) dy = -flat;
            if (transformed) {
              ctx.setTransform(base, 0, 0, base, 0, 0);
              transformed = false;
            }
            var x0 = Math.round((cx + dx - half) * dpr) / dpr;
            var y0 = Math.round((cy + dy - half) * dpr) / dpr;
            var x1 = Math.round((cx + dx + half) * dpr) / dpr;
            var y1 = Math.round((cy + dy + half) * dpr) / dpr;
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          }
        }
      }

      if (transformed) ctx.setTransform(base, 0, 0, base, 0, 0);
      finish();
    }

    /* Waiting settles into a held frame. Once nothing is left to move there is
       nothing to redraw, so the handle goes static and stops costing frames. */
    function finish() {
      if (!handle || motion.reduced()) return;
      if (zRate < 0.0004 && zRate > -0.0004 && settled() && !handle.isStatic) {
        handle.setStatic(true);
      }
    }

    refreshColors();
    layout();
    if (motion.reduced()) snap();

    handle = motion.register(node, draw, {
      fps: fps,
      isStatic: motion.reduced()
    });

    var unsubscribe = motion.onReducedChange(function (isReduced) {
      if (destroyed) return;
      if (isReduced) { snap(); handle.setStatic(true); }
      else { handle.setStatic(false); handle.start(); }
      handle.invalidate();
    });

    var field = {
      state: state,
      setState: function (name) {
        if (!STATES[name] || name === state) return;
        state = name;
        field.state = name;
        target = STATES[name];
        if (motion.reduced()) { snap(); handle.invalidate(); return; }
        handle.setStatic(false);
        handle.start();
        handle.invalidate();
      },
      resize: function () {
        layout();
        handle.setStatic(motion.reduced());
        handle.invalidate();
      },
      refreshColors: refreshColors,
      stats: function () { return handle.stats(); },
      resetStats: function () { handle.resetStats(); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        unsubscribe();
        handle.destroy();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };

    return field;
  }

  window.PhosphorPattern = { mount: mount };
})();
