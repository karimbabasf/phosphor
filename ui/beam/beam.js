/* The beam: where the assistant's light lands.

   A phosphor screen glows where the beam hits and fades once it has moved on,
   which is the name of the product and exactly the feedback this window owes a
   person. A tool call sends one point of light from its step row in the
   conversation to the panel the tool touched: the dot leaves the row, arcs
   over the content on a spring, and lands as a ring on the panel's own edge
   that breathes twice and fades. The panel keeps a quiet edge while the call
   is open and lets it go when the result is back. Amber while a person still
   has to click, rose when the tool failed. While any call is held, the
   assistant's seat light (the status line in the head of the conversation,
   #agent-status) is live: that line is where "working" is shown.

   It used to be a streak on a canvas with a bloom that decayed over two and a
   half seconds, which read as a scanner (Karim, 2026-09-16: "remove the
   scanning animation and just fix that entire animation with motion.dev").
   The flight and the ring are motion.dev now, through PhosphorMotion.animate,
   and there is no canvas and no loop of this file's own.

   window.PhosphorBeam
     fire(opts)        one flight. opts:
                         from  an element, or {x, y} in window coordinates
                         to    a data-surface id, or {x, y}
                         tone  'glow' | 'wait' | 'down'
                         then  'hold' | 'decay' | 'none', default 'decay'
                         done  called on arrival, after `then`
     hold(id, tone)    the edge held and the seat light live, while a tool is in flight
     release(id, ok)   let go: the edge fades, the seat light settles; rose when ok is false
     decay(id, tone)   one breath of the ring and the edge, no flight: "this changed"
     wait(id, on)      amber, held while a proposal waits for a click
     surface(id)       the element for a surface id, or null

   WHAT THIS FILE WRITES. Everything that happens ON a surface is two
   attributes (data-glow, data-glow-tone) and everything on the seat light is
   one (data-live); agent.css draws all of it, so a theme change or a
   reduced-motion preference reaches the edge without this file knowing. The
   dot and the ring are elements of its own in the fixed #beam layer, moved by
   motion.dev, and the one style this file sets is their geometry: the ring's
   box, as custom properties the stylesheet reads. Colour, stroke, timing and
   easing all live in the stylesheet or in the motion options here.

   The budget: geometry is read at fire time and once more at the landing,
   never inside anything that runs per frame, because nothing here runs per
   frame; motion.dev owns the frames. */
(function () {
  'use strict';

  var TONES = { glow: true, wait: true, down: true };

  /* The flight. Its visual duration is the window's --dur-beam (320 ms): the
     spring on x lands the dot in that time and settles a beat after; the arc
     on y rises to LIFT above the higher end and comes down in the same beat.
     ?beam=slow stretches a flight twelve times so a screenshot can catch the
     dot in the air. It is read from the query string once and from nowhere
     else: nothing a frame or a tool carries can slow the window down. */
  var LIFT = 80;
  var FLIGHT_S = 0.32;
  var SLOW_FLIGHT = 12;
  var SLOW_RING = 3;
  /* The ring: two breaths, scale 1 to 1.06 and back, in one second, then
     gone. Under reduced motion it is a fade and nothing else. */
  var RING_S = 1.0;
  var RING_REDUCED_S = 0.6;
  /* How long the tone attribute outlives the edge, so a rose edge fading out
     stays rose the whole way down (agent.css --dur-edge-out). */
  var EDGE_OUT_MS = 400;
  var GLOW_IN_MS = 160;

  var slow = false;
  try {
    slow = /(^|[?&])beam=slow(&|$)/.test(String(window.location.search || ''));
  } catch (err) {
    slow = false;
  }

  var records = Object.create(null);

  /* ------------------------------------------------------------- surfaces */

  function report(err) {
    if (window.console && console.error) console.error('[beam]', err);
  }

  function esc(value) {
    return String(value).replace(/["\\]/g, '');
  }

  /* The view a node sits in, or null when it sits outside all of them (the
     topbar, the stage itself, the conversation). The views are #view-basic,
     #view-pro, #view-trade and #view-vault, so the id is the test. */
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

  /* A surface that does not exist yet falls back to one that does, on the
     same screen. 'position' is the trade deck: until it lands the chart on
     the same view takes the light. 'dock' is the decision dock, which is only
     on screen while something waits for a click: a proposal the app refused
     outright never opens it, and the flight then lands on the conversation
     the request came from. */
  var FALLBACK = { position: 'chart', dock: 'assistant' };

  function resolve(key) {
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
    /* A tool whose panel is in another mode lands on that mode's tab, so a
       chart tool called from Basic lights the Trade tab a beat before the
       server moves the window. That beat is the point: the light arrives
       first and the view follows it. */
    if (hidden) {
      var mode = String(hidden.id).slice('view-'.length);
      return document.querySelector('[data-surface="tab-' + esc(mode) + '"]');
    }
    return null;
  }

  function surface(id) {
    if (!id) return null;
    var key = String(id);
    var el = resolve(key);
    if (!el && FALLBACK[key]) el = resolve(FALLBACK[key]);
    return el;
  }

  /* An element is a target only once it has a box: a display:none panel or one
     in a view still crossfading in measures at zero, and a flight to 0,0 lands
     under the composer. isConnected is a cheap detach check with no layout in
     it; the rect read is a layout read, at fire time or at the landing. */
  function visible(el) {
    if (!el || el.isConnected === false || typeof el.getBoundingClientRect !== 'function') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /* ---------------------------------------------------------------- edge */

  function recordFor(id) {
    var key = String(id);
    var rec = records[key];
    if (!rec) {
      rec = {
        id: key,
        holds: 0,
        /* THE RACE. A hold is armed at fire time and applied on arrival, so a
           result that comes back faster than the flight (switch, set_theme,
           trade_focus all answer in well under it) has something to cancel.
           `armed` counts flights on the way to holding this surface;
           `cancels` counts releases that arrived before their flight, so the
           arrival knows to skip the hold rather than stick an edge with no
           call behind it. `errored` carries a rose flash for a failure that
           beat its flight. */
        armed: 0,
        cancels: 0,
        errored: 0,
        waiting: false,
        pulse: false,
        tone: 'glow',
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
         attributes back or it keeps an edge with nothing behind it. */
      if (rec.el) {
        rec.el.removeAttribute('data-glow');
        rec.el.removeAttribute('data-glow-tone');
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

    /* The tone outlives the edge for the length of its fade, so a rose edge
       going out stays rose the whole way. Then the attribute goes, so a
       surface at rest carries nothing at all. */
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
      }, EDGE_OUT_MS);
    }
  }

  /* THE SEAT LIGHT. One count across every surface: a tool in flight anywhere
     is the assistant at work, so the status line in the head of the
     conversation is live while the count is above zero and settles the moment
     the last call lets go. One attribute, read by the status line's own
     block in agent.css; the breathing and the light through the verb are
     drawn there. The element is looked up at the event, never kept: the
     column rebuilds its head when it mounts, and a held reference would be
     the old one. */
  var liveHolds = 0;

  function seat() {
    return document.getElementById('agent-status');
  }

  function paintSeat() {
    var line = seat();
    if (!line) return;
    if (liveHolds > 0) {
      if (line.getAttribute('data-live') !== 'true') line.setAttribute('data-live', 'true');
    } else if (line.getAttribute('data-live') !== null) {
      line.removeAttribute('data-live');
    }
  }

  function hold(id, tone) {
    if (!id) return;
    var rec = recordFor(id);
    rec.holds += 1;
    liveHolds += 1;
    if (tone && TONES[tone]) rec.tone = tone;
    paint(rec);
    paintSeat();
  }

  /* A flight that intends to hold arms its record now, so the surface can be
     released before the light has arrived. */
  function arm(id) {
    if (!id) return;
    recordFor(id).armed += 1;
  }

  /* A flight that will never arrive (no target, or the target left the DOM
     on the way) gives its arming back, and takes with it any release that
     already answered it, so the next flight to the same surface starts even. */
  function disarm(id) {
    if (!id) return;
    var rec = records[String(id)];
    if (!rec) return;
    if (rec.armed > 0) rec.armed -= 1;
    if (rec.cancels > rec.armed) {
      rec.cancels -= 1;
      if (rec.errored > rec.cancels) rec.errored = rec.cancels;
    }
  }

  function release(id, ok) {
    if (!id) return;
    var rec = records[String(id)];
    if (!rec) return;
    if (rec.holds > 0) {
      rec.holds -= 1;
      if (liveHolds > 0) liveHolds -= 1;
      /* An error is the louder signal: it colours the surface even while
         another call is still holding it, because the thing a person needs to
         see is that something failed, not that something else is still
         running. */
      if (ok === false) rec.tone = 'down';
      else if (rec.tone !== 'down') rec.tone = 'glow';
      paint(rec);
      paintSeat();
      return;
    }
    /* The result beat the flight: cancel the hold it would otherwise apply on
       arrival. The seat light was never lit for this call (hold() runs on
       arrival), so nothing there to settle. A failure still gets its one rose
       flash when the flight lands. */
    if (rec.armed > rec.cancels) {
      rec.cancels += 1;
      if (ok === false) rec.errored += 1;
    }
  }

  /* One breath: the shape of "this changed on its own". The edge comes on
     for its rise and hands the fall to the stylesheet's transition; the ring
     breathes once around the panel and goes. */
  function decay(id, tone) {
    if (!id) return;
    var rec = recordFor(id);
    if (tone && TONES[tone]) rec.tone = tone;
    rec.pulse = true;
    paint(rec);
    if (rec.pulseTimer) window.clearTimeout(rec.pulseTimer);
    rec.pulseTimer = window.setTimeout(function () {
      rec.pulseTimer = 0;
      rec.pulse = false;
      paint(rec);
    }, GLOW_IN_MS + 20);
    ring(surface(rec.id), rec.waiting ? 'wait' : rec.tone);
  }

  function wait(id, on) {
    if (!id) return;
    var rec = recordFor(id);
    rec.waiting = on !== false;
    paint(rec);
  }

  /* ---------------------------------------------------------------- layer */

  /* One fixed layer over the whole window holds the dot and the ring, so no
     panel's overflow can clip either. index.html carries it; a page without
     it (the update window, a test page) gets one made here. */
  var host = null;

  function layer() {
    if (host && host.isConnected !== false) return host;
    var found = document.getElementById('beam');
    if (found && String(found.tagName || '').toLowerCase() === 'canvas') found = null;
    if (!found) {
      found = document.createElement('div');
      found.id = 'beam';
      found.className = 'beam-layer';
      found.setAttribute('aria-hidden', 'true');
      var root = document.body || document.documentElement;
      if (root) root.appendChild(found);
    }
    host = found;
    return host;
  }

  function motion() {
    var m = window.PhosphorMotion;
    return m && typeof m.animate === 'function' ? m : null;
  }

  function reduced() {
    var m = window.PhosphorMotion;
    return !m || (typeof m.reduced === 'function' && m.reduced());
  }

  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function after(animation, fn) {
    var finished = animation && animation.finished;
    if (finished && typeof finished.then === 'function') {
      finished.then(fn, function (err) { report(err); fn(); });
      return;
    }
    fn();
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

  /* ----------------------------------------------------------------- ring */

  /* The landing: a ring the size of the panel, on its own edge with its own
     corners, that breathes twice and fades. The one layout read here is the
     panel's box, taken at the landing rather than at fire time, because a
     view can swap under a flight. The geometry goes to the stylesheet as
     custom properties; the stroke, the colour and the layer are its. */
  function ring(el, tone) {
    var m = motion();
    if (!m || !el || el.isConnected === false || typeof el.getBoundingClientRect !== 'function') return;
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    var node = document.createElement('span');
    node.className = 'beam-ring';
    node.setAttribute('data-tone', TONES[tone] ? tone : 'glow');
    place(node, rect, radiusOf(el));
    layer().appendChild(node);

    var k = slow ? SLOW_RING : 1;
    var animation;
    if (reduced()) {
      animation = m.animate(node, { opacity: [0, 1, 0] }, { duration: RING_REDUCED_S * k, ease: 'easeInOut', times: [0, 0.3, 1] });
    } else {
      animation = m.animate(node, {
        opacity: [0, 1, 1, 1, 1, 0],
        scale: [1, 1.06, 1, 1.06, 1, 1]
      }, { duration: RING_S * k, ease: 'easeInOut', times: [0, 0.2, 0.45, 0.7, 0.9, 1] });
    }
    after(animation, function () { remove(node); });
  }

  function place(node, rect, radius) {
    node.style.setProperty('--beam-x', rect.left + 'px');
    node.style.setProperty('--beam-y', rect.top + 'px');
    node.style.setProperty('--beam-w', rect.width + 'px');
    node.style.setProperty('--beam-h', rect.height + 'px');
    node.style.setProperty('--beam-r', radius);
  }

  /* The panel's own corners, so the ring sits on its edge rather than boxing
     it. A style read, not a layout read. */
  function radiusOf(el) {
    try {
      var value = getComputedStyle(el).getPropertyValue('border-radius');
      return value && value.trim() ? value.trim() : '0px';
    } catch (err) {
      return '0px';
    }
  }

  /* --------------------------------------------------------------- arrive */

  function arrive(f) {
    if (f.then === 'hold') {
      var rec = f.to ? recordFor(f.to) : null;
      if (rec && rec.armed > 0) rec.armed -= 1;
      if (rec && rec.cancels > 0) {
        /* The result already came back. Skip the hold, and if it failed give
           the surface its one rose breath so a fast failure still shows. */
        rec.cancels -= 1;
        if (rec.errored > 0) {
          rec.errored -= 1;
          decay(f.to, 'down');
        }
      } else {
        hold(f.to, f.tone);
      }
    } else if (f.then === 'decay') {
      decay(f.to, f.tone);
    }
    if (typeof f.done === 'function') {
      try {
        f.done();
      } catch (err) {
        report(err);
      }
    }
  }

  /* ----------------------------------------------------------------- fire */

  /* Wait up to a second for a surface to exist and have a box, then run the
     body. A tool that switches the view fires its light a beat before the
     panel it names is mounted or crossfaded in, and a flight measured then
     lands at 0,0 under the composer. Resolved fresh on each poll, because the
     element that answers a surface id changes as views swap. A dock that
     never opens hands the flight to its fallback. */
  var WAIT_MS = 1000;

  function now() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  function later(fn) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(fn);
    else window.setTimeout(fn, 16);
  }

  function whenVisible(id, run) {
    var direct = typeof id !== 'string';
    var first = direct ? id : surface(id);
    if (direct || visible(first)) {
      run(first);
      return;
    }
    var startedAt = now();
    var poll = function () {
      var el = surface(id);
      if (visible(el)) {
        run(el);
        return;
      }
      if (now() - startedAt >= WAIT_MS) {
        var alt = FALLBACK[id] ? surface(FALLBACK[id]) : null;
        run(visible(alt) ? alt : null);
        return;
      }
      later(poll);
    };
    later(poll);
  }

  function fire(opts) {
    var o = opts || {};
    var tone = TONES[o.tone] ? o.tone : 'glow';
    var then = o.then === 'hold' || o.then === 'none' ? o.then : 'decay';
    /* The hold is armed now, not on arrival, so a release that beats the
       flight is not lost (see recordFor). */
    if (then === 'hold' && typeof o.to === 'string') arm(o.to);
    whenVisible(o.to, function (target) { launch(o, tone, then, target); });
  }

  function launch(o, tone, then, target) {
    var f = { to: o.to, tone: tone, then: then, done: o.done };
    if (!target) {
      /* Nothing to aim at even after the wait: give back the armed hold so the
         seat and the count stay balanced. */
      if (then === 'hold' && typeof o.to === 'string') disarm(o.to);
      return;
    }

    var m = motion();
    var from = pointOf(o.from);
    var to = pointOf(target);
    var named = typeof o.to === 'string';

    /* Reduced motion has no flight: the light is simply already there, the
       ring fades in and out where it landed, and the edge keeps its short
       fade because that fade is meaning rather than decoration. The same
       when there is nothing to fly between, or no motion.dev to fly with. */
    if (!m || reduced() || !from || !to) {
      if (named) ring(target, tone);
      arrive(f);
      return;
    }

    var dot = document.createElement('span');
    dot.className = 'beam-dot';
    dot.setAttribute('data-tone', tone);
    layer().appendChild(dot);

    /* The arc, in two motions on one dot. A spring carries x to the target
       and settles there on its own clock; y rises to LIFT above the higher
       end (never above the window) and comes back down in one beat, with the
       dot transparent at both ends of the path, so it appears out of the step
       row and gives way to the ring. The landing is the arc's end, not the
       spring's rest: by then x is as good as there, and a ring that waited
       for the last thousandth of a spring would leave a gap with nothing on
       screen. */
    var k = slow ? SLOW_FLIGHT : 1;
    var beat = FLIGHT_S * k;
    var peak = Math.max(16, Math.min(from.y, to.y) - LIFT);
    var glide = m.animate(dot, { x: [from.x, to.x] }, { type: 'spring', visualDuration: beat, bounce: 0 });
    /* motion.dev reads a value's own options alone when it has any, so the
       duration is named on each rather than once above them. */
    var arc = m.animate(dot, {
      y: [from.y, peak, to.y],
      opacity: [0, 1, 1, 0]
    }, {
      y: { duration: beat * 1.15, ease: ['easeOut', 'easeIn'], times: [0, 0.42, 1] },
      opacity: { duration: beat * 1.15, ease: 'linear', times: [0, 0.1, 0.85, 1] }
    });

    after(arc, function () {
      if (glide && typeof glide.stop === 'function') glide.stop();
      remove(dot);
      /* The target left the DOM while the light was on its way: a view
         swapped it out. Land nothing and give back the armed hold. */
      if (target.isConnected === false) {
        if (then === 'hold' && named) disarm(o.to);
        return;
      }
      if (named) ring(target, tone);
      arrive(f);
    });
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
