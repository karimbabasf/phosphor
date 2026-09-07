/* The beam: where the assistant's light lands.

   A phosphor screen glows where the beam hits and fades once it has moved on,
   which is the name of the product and exactly the feedback this window owes a
   person. A tool call sends a point of light from its step row in the
   conversation to the panel the tool touched. The panel lights, holds a scan
   while the call is open, and decays over two and a half seconds once the
   result is back. Amber while a person still has to click, rose when the tool
   failed.

   window.PhosphorBeam
     fire(opts)        one flight. opts:
                         from  an element, or {x, y} in window coordinates
                         to    a data-surface id, or {x, y}
                         tone  'glow' | 'wait' | 'down'
                         then  'hold' | 'decay' | 'none', default 'decay'
                         done  called on arrival, after `then`
     hold(id, tone)    the scan, while a tool is in flight
     release(id, ok)   stop the scan, then glow and decay; rose when ok is false
     decay(id, tone)   glow once and fade, no flight
     wait(id, on)      amber, held while a proposal waits for a click
     surface(id)       the element for a surface id, or null

   THE CANVAS CARRIES THE FLIGHT AND NOTHING ELSE. Everything that happens on a
   surface is two attributes (data-glow, data-glow-tone) and one appended child
   (.surface-scan); the Surfaces block in components.css draws all of it. This
   file never writes a style property to a surface, so a theme change or a
   reduced-motion preference reaches the glow without it knowing.

   The budget, and each line of it is a rule the performance audit wrote:
   the rAF handle exists only while a flight is in the air and unregisters
   itself when the last one lands; rects are read at fire time and never inside
   the loop; the canvas clears the box it drew last frame rather than the
   window; device pixels are capped at 2; nothing is allocated per frame. */
(function () {
  'use strict';

  var TONE_TOKEN = { glow: '--agent', wait: '--warn', down: '--down' };
  var TONE_FALLBACK = { glow: '51,255,102', wait: '245,185,66', down: '255,90,110' };

  /* Twelve samples lagging by 0.022 of the path each: the tail covers about a
     quarter of the curve, which at 320 ms is roughly 85 ms of trail. Shorter
     reads as a dot being dragged, longer as a stripe. */
  var TAIL = 12;
  var TAIL_LAG = 0.022;
  var HEAD_R = 1.5; /* 3 px across, the spec's head */
  var HALO_R = 12;
  var LIFT = 80; /* the control point, lifted toward the top of the window */
  var TAU = Math.PI * 2;
  var GLOW_IN_MS = 120;
  var DECAY_MS = 2400;
  var CLEAR_PAD = 22;
  var SLOW_MS = 4000;
  var DEFAULT_MS = 320;

  /* ?beam=slow stretches one flight to four seconds so a screenshot can catch
     the head in the air. It is read from the query string once and from nowhere
     else: nothing a frame or a tool carries can slow the window down. */
  var slow = false;
  try {
    slow = /(^|[?&])beam=slow(&|$)/.test(String(window.location.search || ''));
  } catch (err) {
    slow = false;
  }

  var canvas = null;
  var ctx = null;
  var dpr = 1;
  var fitted = false;
  var flights = [];
  var handle = null;
  var teardownAt = 0;

  /* The box painted last frame, in CSS pixels, so the next frame clears what it
     has to and leaves the rest of a full-window canvas alone. */
  var dirty = null;
  var dx0 = 0;
  var dy0 = 0;
  var dx1 = 0;
  var dy1 = 0;

  /* Scratch for the curve. Module scalars rather than a returned object,
     because this is the one path that runs at display rate. */
  var px = 0;
  var py = 0;

  var records = Object.create(null);

  /* ------------------------------------------------------------- surfaces */

  function report(err) {
    if (window.console && console.error) console.error('[beam]', err);
  }

  function esc(value) {
    return String(value).replace(/["\\]/g, '');
  }

  /* The view a node sits in, or null when it sits outside all of them (the
     topbar, the stage itself). The views are #view-basic, #view-pro and
     #view-trade, so the id is the test rather than a class lookup. */
  function viewOf(node) {
    var walk = node;
    while (walk) {
      if (walk.id && String(walk.id).indexOf('view-') === 0) return walk;
      walk = walk.parentNode;
    }
    return null;
  }

  function activeTab() {
    return document.querySelector('.tab[aria-selected="true"]');
  }

  /* A tool whose panel is in another mode lands on that mode's tab, so a chart
     tool called from Basic lights the Trade tab a beat before the server moves
     the window. That beat is the point: the light arrives first and the view
     follows it. */
  function surface(id) {
    if (!id) return null;
    var key = String(id);
    if (key === 'window') return document.getElementById('stage');
    if (key === 'assistant') return document.getElementById('conversation');
    if (key === 'tabs') return activeTab();

    var found = document.querySelectorAll('[data-surface="' + esc(key) + '"]');
    var hidden = null;
    for (var i = 0; i < found.length; i += 1) {
      var node = found[i];
      var view = viewOf(node);
      if (!view) return node;
      if (view.getAttribute('data-active') === 'true') return node;
      if (!hidden) hidden = view;
    }
    if (hidden) {
      var mode = String(hidden.id).slice('view-'.length);
      return document.querySelector('[data-surface="tab-' + esc(mode) + '"]');
    }
    return null;
  }

  /* ---------------------------------------------------------------- glow */

  function recordFor(id) {
    var key = String(id);
    var rec = records[key];
    if (!rec) {
      rec = {
        id: key,
        holds: 0,
        waiting: false,
        pulse: false,
        tone: 'glow',
        scan: null,
        el: null,
        wroteGlow: '',
        wroteTone: '',
        pulseTimer: 0,
        toneTimer: 0
      };
      records[key] = rec;
    }
    return rec;
  }

  /* One place writes the attributes, from one record, so a wait held under a
     tool call and a tool call that fails under a wait both come out right
     without either caller knowing about the other. */
  function paint(rec) {
    var el = surface(rec.id);
    if (!el) return;
    if (el !== rec.el) {
      /* The surface moved: a view swapped, so the panel a call was aimed at is
         now the tab, or the other way round. The old element has to give its
         attributes back or it keeps a glow with nothing behind it. */
      if (rec.el) {
        rec.el.removeAttribute('data-glow');
        rec.el.removeAttribute('data-glow-tone');
        if (rec.scan && rec.scan.parentNode) rec.scan.parentNode.removeChild(rec.scan);
        rec.scan = null;
      }
      rec.el = el;
      rec.wroteGlow = '';
      rec.wroteTone = '';
    }

    var tone = rec.waiting ? 'wait' : rec.tone;
    var on = rec.holds > 0 || rec.waiting || rec.pulse ? 'on' : '';

    if (tone !== rec.wroteTone) {
      el.setAttribute('data-glow-tone', tone);
      rec.wroteTone = tone;
    }
    if (on !== rec.wroteGlow) {
      if (on) el.setAttribute('data-glow', 'on');
      else el.removeAttribute('data-glow');
      rec.wroteGlow = on;
    }

    if (rec.holds > 0 && !rec.scan) {
      var scan = document.createElement('div');
      scan.className = 'surface-scan';
      /* The bar travels the surface's own height, so it reaches the bottom edge
         of a tall panel and a short one alike. Read here, at the event, never
         in the loop. */
      scan.style.setProperty('--scan-h', (el.offsetHeight || 0) + 'px');
      el.appendChild(scan);
      rec.scan = scan;
    } else if (rec.holds <= 0 && rec.scan) {
      if (rec.scan.parentNode) rec.scan.parentNode.removeChild(rec.scan);
      rec.scan = null;
    }

    /* The tone outlives the glow, because a rose surface fading out has to stay
       rose the whole way down. Once the decay is over the attribute goes, so a
       surface at rest carries nothing. */
    if (rec.toneTimer) {
      window.clearTimeout(rec.toneTimer);
      rec.toneTimer = 0;
    }
    if (!on && tone !== 'glow') {
      rec.toneTimer = window.setTimeout(function () {
        rec.toneTimer = 0;
        rec.tone = 'glow';
        if (rec.el && !rec.wroteGlow) {
          rec.el.removeAttribute('data-glow-tone');
          rec.wroteTone = '';
        }
      }, DECAY_MS);
    }
  }

  function hold(id, tone) {
    if (!id) return;
    var rec = recordFor(id);
    rec.holds += 1;
    if (tone && TONE_TOKEN[tone]) rec.tone = tone;
    paint(rec);
  }

  function release(id, ok) {
    if (!id) return;
    var rec = records[String(id)];
    if (!rec) return;
    if (rec.holds > 0) rec.holds -= 1;
    /* An error is the louder signal: it colours the surface even while another
       call is still holding it, because the thing a person needs to see is that
       something failed, not that something else is still running. */
    if (ok === false) rec.tone = 'down';
    else if (rec.tone !== 'down') rec.tone = 'glow';
    paint(rec);
  }

  /* Glow once and fade: the shape of "this changed on its own". The attribute
     goes on now and comes off after the rise, which hands the fall to the CSS
     transition rather than running it here. */
  function decay(id, tone) {
    if (!id) return;
    var rec = recordFor(id);
    if (tone && TONE_TOKEN[tone]) rec.tone = tone;
    rec.pulse = true;
    paint(rec);
    if (rec.pulseTimer) window.clearTimeout(rec.pulseTimer);
    rec.pulseTimer = window.setTimeout(function () {
      rec.pulseTimer = 0;
      rec.pulse = false;
      paint(rec);
    }, GLOW_IN_MS + 20);
  }

  function wait(id, on) {
    if (!id) return;
    var rec = recordFor(id);
    rec.waiting = on !== false;
    paint(rec);
  }

  /* --------------------------------------------------------------- colour */

  function parseRgb(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    var value = raw.trim();
    var hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
    if (hex) {
      var body = hex[1];
      if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
      return parseInt(body.slice(0, 2), 16) + ',' +
        parseInt(body.slice(2, 4), 16) + ',' +
        parseInt(body.slice(4, 6), 16);
    }
    var rgb = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(value);
    if (rgb) return Math.round(Number(rgb[1])) + ',' + Math.round(Number(rgb[2])) + ',' + Math.round(Number(rgb[3]));
    return fallback;
  }

  function millis(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    var ms = /^\s*([0-9.]+)ms/.exec(raw);
    if (ms) return Number(ms[1]);
    var s = /^\s*([0-9.]+)s/.exec(raw);
    if (s) return Number(s[1]) * 1000;
    return fallback;
  }

  /* --------------------------------------------------------------- easing */

  /* The flight eases on the window's own --ease-in-out rather than on a curve
     picked here, so the beam and every CSS transition in the window move the
     same way. Newton-Raphson on the bezier's x, six passes, which lands inside
     a thousandth over this range. */
  function easeFor(raw) {
    var m = /cubic-bezier\(\s*([-0-9.]+)\s*,\s*([-0-9.]+)\s*,\s*([-0-9.]+)\s*,\s*([-0-9.]+)\s*\)/.exec(String(raw || ''));
    var x1 = m ? Number(m[1]) : 0.77;
    var y1 = m ? Number(m[2]) : 0;
    var x2 = m ? Number(m[3]) : 0.175;
    var y2 = m ? Number(m[4]) : 1;
    return {
      ax: 1 - 3 * x2 + 3 * x1, bx: 3 * x2 - 6 * x1, cx: 3 * x1,
      ay: 1 - 3 * y2 + 3 * y1, by: 3 * y2 - 6 * y1, cy: 3 * y1
    };
  }

  function easeAt(e, p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    var t = p;
    for (var i = 0; i < 6; i += 1) {
      var x = ((e.ax * t + e.bx) * t + e.cx) * t - p;
      var d = (3 * e.ax * t + 2 * e.bx) * t + e.cx;
      if (d < 1e-6 && d > -1e-6) break;
      t -= x / d;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return ((e.ay * t + e.by) * t + e.cy) * t;
  }

  /* ---------------------------------------------------------------- canvas */

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = document.getElementById('beam');
    if (!canvas || typeof canvas.getContext !== 'function') {
      canvas = null;
      return null;
    }
    ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas = null;
      return null;
    }
    fit();
    if (typeof ResizeObserver === 'function' && document.body) {
      new ResizeObserver(fit).observe(document.body);
    }
    return canvas;
  }

  /* The one layout read outside fire, and it is in a ResizeObserver callback,
     which is where the rebuild rules put geometry. */
  function fit() {
    if (!canvas || !window.PhosphorMotion) return;
    var size = window.PhosphorMotion.fitCanvas(canvas, 2);
    dpr = size.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = null;
    fitted = true;
  }

  function pointOf(source) {
    if (!source) return null;
    if (typeof source.x === 'number' && typeof source.y === 'number') {
      return { x: source.x, y: source.y };
    }
    if (typeof source.getBoundingClientRect !== 'function') return null;
    var rect = source.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function bound(x, y, r) {
    if (!dirty) {
      dirty = true;
      dx0 = x - r;
      dy0 = y - r;
      dx1 = x + r;
      dy1 = y + r;
      return;
    }
    if (x - r < dx0) dx0 = x - r;
    if (y - r < dy0) dy0 = y - r;
    if (x + r > dx1) dx1 = x + r;
    if (y + r > dy1) dy1 = y + r;
  }

  function at(f, t) {
    var u = 1 - t;
    px = u * u * f.x0 + 2 * u * t * f.cx + t * t * f.x1;
    py = u * u * f.y0 + 2 * u * t * f.cy + t * t * f.y1;
  }

  function draw(now) {
    if (dirty) {
      ctx.clearRect(dx0 - CLEAR_PAD, dy0 - CLEAR_PAD,
        (dx1 - dx0) + CLEAR_PAD * 2, (dy1 - dy0) + CLEAR_PAD * 2);
      dirty = null;
    }

    /* Light adds. A beam crossing its own tail brightens rather than repainting
       over it, which is the difference between a moving dot and a moving
       light. */
    ctx.globalCompositeOperation = 'lighter';

    for (var i = flights.length - 1; i >= 0; i -= 1) {
      var f = flights[i];
      var p = (now - f.startedAt) / f.durationMs;
      if (p < 0) p = 0;
      var t = easeAt(f.ease, p > 1 ? 1 : p);

      ctx.fillStyle = f.css;
      for (var s = TAIL; s >= 1; s -= 1) {
        var tt = t - s * TAIL_LAG;
        if (tt <= 0) continue;
        var k = 1 - s / (TAIL + 1);
        at(f, tt);
        ctx.globalAlpha = 0.40 * k * k;
        ctx.beginPath();
        ctx.arc(px, py, 0.5 + 2.0 * k, 0, TAU);
        ctx.fill();
        bound(px, py, 3);
      }

      at(f, t);
      var hx = px;
      var hy = py;

      /* The halo is one gradient built at fire time and stamped by moving the
         transform, so the loop allocates nothing. */
      ctx.globalAlpha = 0.9;
      ctx.setTransform(dpr, 0, 0, dpr, hx * dpr, hy * dpr);
      ctx.fillStyle = f.halo;
      ctx.fillRect(-HALO_R, -HALO_R, HALO_R * 2, HALO_R * 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.globalAlpha = 1;
      ctx.fillStyle = f.css;
      ctx.beginPath();
      ctx.arc(hx, hy, HEAD_R, 0, TAU);
      ctx.fill();
      bound(hx, hy, HALO_R);

      if (p >= 1) {
        flights.splice(i, 1);
        arrive(f);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (flights.length === 0) {
      if (dirty) {
        ctx.clearRect(dx0 - CLEAR_PAD, dy0 - CLEAR_PAD,
          (dx1 - dx0) + CLEAR_PAD * 2, (dy1 - dy0) + CLEAR_PAD * 2);
        dirty = null;
      }
      /* Out of band, because destroying a handle from inside the loop's own
         walk would skip the handle that shifts into its place. */
      if (handle && !teardownAt) {
        teardownAt = window.setTimeout(teardown, 0);
      }
    }
  }

  function teardown() {
    teardownAt = 0;
    if (flights.length > 0) return;
    if (handle) {
      handle.destroy();
      handle = null;
    }
  }

  function arrive(f) {
    if (f.then === 'hold') hold(f.to, f.tone);
    else if (f.then === 'decay') decay(f.to, f.tone);
    if (typeof f.done === 'function') {
      try {
        f.done();
      } catch (err) {
        report(err);
      }
    }
  }

  /* ----------------------------------------------------------------- fire */

  function fire(opts) {
    var o = opts || {};
    var tone = TONE_TOKEN[o.tone] ? o.tone : 'glow';
    var then = o.then === 'hold' || o.then === 'none' ? o.then : 'decay';

    var target = typeof o.to === 'string' ? surface(o.to) : o.to;
    if (!target) return;

    var motion = window.PhosphorMotion;

    /* Reduced motion has no flight: the light is simply already there. The
       glow keeps its short fade, because that fade is meaning rather than
       decoration, and components.css shortens it under the preference. */
    if (!motion || motion.reduced()) {
      arrive({ to: o.to, tone: tone, then: then, done: o.done });
      return;
    }
    if (!ensureCanvas()) {
      arrive({ to: o.to, tone: tone, then: then, done: o.done });
      return;
    }
    if (!fitted) fit();

    var from = pointOf(o.from);
    var to = pointOf(target);
    if (!from || !to) {
      arrive({ to: o.to, tone: tone, then: then, done: o.done });
      return;
    }

    var root = getComputedStyle(document.documentElement);
    var rgb = parseRgb(root.getPropertyValue(TONE_TOKEN[tone]), TONE_FALLBACK[tone]);
    var duration = slow ? SLOW_MS : millis(root.getPropertyValue('--dur-beam'), DEFAULT_MS);

    var halo = ctx.createRadialGradient(0, 0, 0, 0, 0, HALO_R);
    halo.addColorStop(0, 'rgba(' + rgb + ',0.55)');
    halo.addColorStop(0.45, 'rgba(' + rgb + ',0.16)');
    halo.addColorStop(1, 'rgba(' + rgb + ',0)');

    flights.push({
      x0: from.x,
      y0: from.y,
      x1: to.x,
      y1: to.y,
      /* Lifted toward the top of the window, so the light arcs over the
         content rather than sliding across it. */
      cx: (from.x + to.x) / 2,
      cy: (from.y + to.y) / 2 - LIFT,
      css: 'rgb(' + rgb + ')',
      halo: halo,
      ease: easeFor(root.getPropertyValue('--ease-in-out')),
      startedAt: (window.performance && performance.now ? performance.now() : Date.now()),
      durationMs: duration,
      to: o.to,
      tone: tone,
      then: then,
      done: o.done
    });

    if (teardownAt) {
      window.clearTimeout(teardownAt);
      teardownAt = 0;
    }
    if (!handle) {
      /* fps 120 rather than a cap: a flight is a foreground animation and
         should paint on every frame the display offers. observe:false because
         a fixed full-window canvas is never off screen and watching it is
         work for nothing. */
      handle = motion.register(canvas, draw, { fps: 120, observe: false });
    } else {
      handle.start();
    }
  }

  window.PhosphorBeam = {
    fire: fire,
    hold: hold,
    release: release,
    decay: decay,
    wait: wait,
    surface: surface
  };
})();
