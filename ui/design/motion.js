/* Phosphor motion: the only requestAnimationFrame loop in the window.
   Every canvas registers here. Nothing else calls rAF directly.

   window.PhosphorMotion
     register(node, draw, opts)  -> handle
     reduced()                   -> boolean, live
     onReducedChange(fn)         -> unsubscribe
     fitCanvas(canvas, dprCap)   -> { w, h, dpr, changed }
     once(fn)                    -> schedule one frame of non-canvas work
     spring()                    -> a CSS easing string, cached: motion.dev's
                                    spring as linear(), or the ease-out curve
                                    when the vendored file is not there

   handle
     start()       run the draw loop (subject to visibility)
     stop()        stop it; the last painted frame stays
     invalidate()  paint exactly one frame, even while stopped
     setFps(n)     change the cap
     setStatic(b)  a static handle paints once and then idles
     destroy()     unregister and release the observer
*/
(function () {
  'use strict';

  var handles = [];
  var onceQueue = [];
  var rafId = 0;
  var timerId = 0;
  var lastTick = 0;

  /* How close a handle's next paint has to be before the loop waits for it in
     requestAnimationFrame rather than in a timer. On a 120 Hz display a 30 fps
     field is due every 33 ms, so waiting in rAF means 90 of every 120 callbacks
     walk the list and return having done nothing. One 60 Hz frame plus a little
     is the threshold that idles on both refresh rates without ever landing
     late. */
  var FRAME_SLACK = 20;

  var motionQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };
  var reducedListeners = [];

  var observer = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        var handle = entries[i].target.__phosphorMotion;
        if (!handle) continue;
        var wasVisible = handle.visible;
        handle.visible = entries[i].isIntersecting;
        if (handle.visible && !wasVisible) handle.due = true;
      }
      pump();
      /* A margin, so a field starts drifting just before it is scrolled to
         rather than snapping into motion under the reader's eye. */
    }, { threshold: 0.01, rootMargin: '240px' });
  }

  function reduced() {
    return motionQuery.matches === true;
  }

  function wants(handle) {
    if (!handle.alive) return false;
    if (document.hidden) return false;
    /* A canvas that has never painted gets its first frame wherever it is. A
       2d context taken with alpha:false starts opaque black, so an unpainted
       canvas below the fold is not an empty area, it is a black rectangle, and
       a person who scrolls to it sees the hole before they see the paint. */
    if (handle.frames === 0) return true;
    if (!handle.visible) return false;
    if (handle.due) return true;
    if (!handle.running) return false;
    if (handle.isStatic) return false;
    return true;
  }

  /* The loop sleeps between paints rather than waking on every display frame to
     discover it has nothing to do. It finds the soonest handle, and if that is
     more than one frame away it waits in a timer and re-enters rAF just before
     the paint is due, so the frame still lands on the compositor's clock. */
  function pump() {
    if (rafId || timerId) return;

    var soonest = Infinity;
    if (onceQueue.length) soonest = 0;
    var now = performance.now();
    for (var i = 0; i < handles.length && soonest > 0; i += 1) {
      var handle = handles[i];
      if (!wants(handle)) continue;
      if (handle.due || !handle.lastPaint) {
        soonest = 0;
        break;
      }
      var gap = handle.frameMs - (now - handle.lastPaint);
      if (gap < 0) gap = 0;
      if (gap < soonest) soonest = gap;
    }
    if (soonest === Infinity) return;

    if (soonest > FRAME_SLACK) {
      timerId = window.setTimeout(function () {
        timerId = 0;
        rafId = requestAnimationFrame(tick);
      }, soonest - FRAME_SLACK);
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function idle() {
    if (rafId) cancelAnimationFrame(rafId);
    if (timerId) window.clearTimeout(timerId);
    rafId = 0;
    timerId = 0;
  }

  function tick(now) {
    rafId = 0;
    var dt = lastTick ? now - lastTick : 16;
    lastTick = now;

    if (onceQueue.length) {
      var queued = onceQueue;
      onceQueue = [];
      for (var q = 0; q < queued.length; q += 1) {
        try { queued[q](now); } catch (err) { report(err); }
      }
    }

    for (var i = 0; i < handles.length; i += 1) {
      var handle = handles[i];
      if (!wants(handle)) continue;
      var gap = handle.due ? 0 : handle.frameMs;
      if (now - handle.lastPaint < gap - 1) continue;
      var since = handle.lastPaint ? now - handle.lastPaint : dt;
      handle.lastPaint = now;
      handle.due = false;
      var started = performance.now();
      try {
        handle.draw(now, since);
      } catch (err) {
        handle.alive = false;
        report(err);
      }
      var cost = performance.now() - started;
      handle.frames += 1;
      handle.totalMs += cost;
      if (cost > handle.worstMs) handle.worstMs = cost;
    }

    pump();
  }

  function report(err) {
    if (window.console && console.error) console.error('[motion]', err);
  }

  function register(node, draw, opts) {
    var options = opts || {};
    /* A fixed full-window overlay is never off screen, so watching it is work
       for nothing and the first frames would wait on an observer callback that
       can only ever say yes. observe:false is for those. */
    var watched = options.observe !== false && observer !== null && !!node;
    var handle = {
      node: node,
      draw: draw,
      alive: true,
      running: options.autoStart !== false,
      isStatic: options.isStatic === true,
      visible: !watched,
      due: true,
      frameMs: 1000 / (options.fps || 24),
      lastPaint: 0,
      frames: 0,
      totalMs: 0,
      worstMs: 0,
      start: function () { handle.running = true; handle.due = true; pump(); },
      stop: function () { handle.running = false; },
      invalidate: function () { handle.due = true; pump(); },
      setFps: function (fps) { handle.frameMs = 1000 / (fps || 24); },
      setStatic: function (value) {
        handle.isStatic = value === true;
        if (!handle.isStatic) handle.due = true;
        pump();
      },
      stats: function () {
        return {
          frames: handle.frames,
          meanMs: handle.frames ? handle.totalMs / handle.frames : 0,
          worstMs: handle.worstMs
        };
      },
      resetStats: function () { handle.frames = 0; handle.totalMs = 0; handle.worstMs = 0; },
      destroy: function () {
        handle.alive = false;
        var at = handles.indexOf(handle);
        if (at >= 0) handles.splice(at, 1);
        if (watched) observer.unobserve(node);
        if (node) delete node.__phosphorMotion;
      }
    };
    handles.push(handle);
    if (node) {
      node.__phosphorMotion = handle;
      if (watched) observer.observe(node);
    }
    pump();
    return handle;
  }

  function once(fn) {
    onceQueue.push(fn);
    pump();
  }

  function fitCanvas(canvas, dprCap) {
    var cap = dprCap || 2;
    var dpr = Math.min(window.devicePixelRatio || 1, cap);
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    var changed = canvas.width !== pw || canvas.height !== ph;
    if (changed) {
      canvas.width = pw;
      canvas.height = ph;
    }
    return { w: w, h: h, dpr: dpr, changed: changed };
  }

  function onReducedChange(fn) {
    reducedListeners.push(fn);
    return function () {
      var at = reducedListeners.indexOf(fn);
      if (at >= 0) reducedListeners.splice(at, 1);
    };
  }

  /* THE SPRING. motion.dev (ui/vendor/motion-13.3.0.js, window.Motion) turns
     spring(visualDuration, bounce) into a CSS transition string such as
     "750ms linear(0, 0.064, 0.1977, ...)": a real spring sampled into the
     linear() easing that stylesheets and the Web Animations API both take.
     It is sampled once, here, and split in two: the easing is what spring()
     returns (dom.js setNumber hands it to animate()), and both halves land on
     the root as --dur-spring and --ease-spring so plain CSS writes
     `transition: transform var(--dur-spring) var(--ease-spring)` and gets the
     physics with no script per element.

     No bounce: the window's motion is crisp rather than playful, and 0.4 s of
     visual duration settles a 20 px move in the time the eye gives it.

     Without the vendored file (the unit harness has no window at all, and a
     page that failed to load it still has to move) the easing is the strong
     ease-out the rest of the window uses and the duration is its number
     duration, so nothing that reads either has to know which it got. */
  var SPRING_EASE_FALLBACK = 'cubic-bezier(0.23, 1, 0.32, 1)';
  var SPRING_DUR_FALLBACK = '300ms';
  var springEase = '';
  var springDur = '';

  function spring() {
    if (springEase) return springEase;
    var Motion = window.Motion;
    if (Motion && typeof Motion.spring === 'function') {
      try {
        var text = String(Motion.spring(0.4, 0));
        var parts = /^\s*([0-9.]+m?s)\s+(linear\(.*\))\s*$/.exec(text);
        if (parts) {
          springDur = parts[1];
          springEase = parts[2];
        }
      } catch (err) {
        report(err);
      }
    }
    if (!springEase) {
      springEase = SPRING_EASE_FALLBACK;
      springDur = SPRING_DUR_FALLBACK;
    }
    return springEase;
  }

  function springDuration() {
    spring();
    return springDur;
  }

  /* Written at boot, once, on the root: the one place the stylesheet reads
     the spring from. Guarded, because the file also runs where there is no
     document to write to. Written again when the vendored file lands. */
  function seedSpringTokens() {
    var root = typeof document !== 'undefined' && document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--ease-spring', spring());
    root.style.setProperty('--dur-spring', springDuration());
  }
  seedSpringTokens();

  /* The vendored file is 147 KB and nothing on screen waits for it, so it is
     fetched after the window's load event rather than parsed in front of the
     first paint, which it had cost 14 ms (Karim, 2026-09-14: "speed and
     performance shouldnt be lost"). Until it lands every reader gets the
     fallback curve; when it lands the spring is sampled once, the root tokens
     are rewritten, and the next transition takes the physics. Same origin, so
     the page's script-src 'self' admits it. */
  function loadSpringLater() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (typeof window.addEventListener !== 'function' || window.Motion) return;
    function fetchIt() {
      var tag = document.createElement('script');
      tag.src = './vendor/motion-13.3.0.js';
      tag.async = true;
      tag.onload = function () {
        springEase = '';
        springDur = '';
        seedSpringTokens();
      };
      (document.head || document.documentElement).appendChild(tag);
    }
    if (document.readyState === 'complete') window.setTimeout(fetchIt, 0);
    else window.addEventListener('load', function () { window.setTimeout(fetchIt, 0); }, { once: true });
  }
  loadSpringLater();

  if (motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function () {
      for (var i = 0; i < handles.length; i += 1) handles[i].due = true;
      for (var j = 0; j < reducedListeners.length; j += 1) {
        try { reducedListeners[j](reduced()); } catch (err) { report(err); }
      }
      pump();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      idle();
      lastTick = 0;
      return;
    }
    for (var i = 0; i < handles.length; i += 1) handles[i].due = true;
    pump();
  });

  window.PhosphorMotion = {
    register: register,
    once: once,
    reduced: reduced,
    onReducedChange: onReducedChange,
    fitCanvas: fitCanvas,
    spring: spring,
    springDuration: springDuration,
    handles: function () { return handles.slice(); }
  };
})();
