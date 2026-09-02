/* Phosphor motion: the only requestAnimationFrame loop in the window.
   Every canvas registers here. Nothing else calls rAF directly.

   window.PhosphorMotion
     register(node, draw, opts)  -> handle
     reduced()                   -> boolean, live
     onReducedChange(fn)         -> unsubscribe
     fitCanvas(canvas, dprCap)   -> { w, h, dpr, changed }
     once(fn)                    -> schedule one frame of non-canvas work

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
  var lastTick = 0;

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
    }, { threshold: 0.01 });
  }

  function reduced() {
    return motionQuery.matches === true;
  }

  function wants(handle) {
    if (!handle.alive) return false;
    if (document.hidden) return false;
    if (!handle.visible) return false;
    if (handle.due) return true;
    if (!handle.running) return false;
    if (handle.isStatic) return false;
    return true;
  }

  function pump() {
    if (rafId) return;
    for (var i = 0; i < handles.length; i += 1) {
      if (wants(handles[i])) {
        rafId = requestAnimationFrame(tick);
        return;
      }
    }
    if (onceQueue.length) rafId = requestAnimationFrame(tick);
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
    var handle = {
      node: node,
      draw: draw,
      alive: true,
      running: options.autoStart !== false,
      isStatic: options.isStatic === true,
      visible: observer ? false : true,
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
        if (observer && node) observer.unobserve(node);
        if (node) delete node.__phosphorMotion;
      }
    };
    handles.push(handle);
    if (node) {
      node.__phosphorMotion = handle;
      if (observer) observer.observe(node);
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
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
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
    handles: function () { return handles.slice(); }
  };
})();
