/* Phosphor state cache. Renderers subscribe to a slice and are called when
   that slice changes, so an SSE frame that moved one number does not run every
   renderer in the window. */
(function () {
  'use strict';

  var current = {};
  var slices = {};
  var everyone = [];
  var loadedOnce = false;

  function get() {
    return current;
  }

  function loaded() {
    return loadedOnce;
  }

  /* Reference equality on the slice root is the cheap correct test: the server
     builds a fresh object per read, so an unchanged slice arrives as a new
     object only when the payload itself was re-parsed. The 304 path in net.js
     hands back the cached object, so an unchanged read short circuits here. */
  function put(next) {
    if (!next || typeof next !== 'object') return;
    var previous = current;
    current = next;
    loadedOnce = true;

    for (var key in slices) {
      if (!Object.prototype.hasOwnProperty.call(slices, key)) continue;
      var before = previous ? previous[key] : undefined;
      var after = next[key];
      if (before === after) continue;
      if (same(before, after)) continue;
      fire(slices[key], after, next);
    }

    for (var i = 0; i < everyone.length; i += 1) {
      try {
        everyone[i](next, previous);
      } catch (err) {
        console.error('[state] subscriber', err);
      }
    }
  }

  /* A shallow value test for the primitives and a JSON test for the rest.
     The payload is small (one wallet, one policy, a handful of proposals) and
     this runs once per frame, so the stringify is cheaper than the renders it
     prevents. */
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (err) {
      return false;
    }
  }

  function fire(list, value, whole) {
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](value, whole);
      } catch (err) {
        console.error('[state] slice', err);
      }
    }
  }

  function select(key, handler) {
    if (!slices[key]) slices[key] = [];
    slices[key].push(handler);
    if (loadedOnce) {
      try {
        handler(current[key], current);
      } catch (err) {
        console.error('[state] slice', err);
      }
    }
    return function () {
      var list = slices[key];
      if (!list) return;
      var at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    };
  }

  function subscribe(handler) {
    everyone.push(handler);
    if (loadedOnce) {
      try {
        handler(current, null);
      } catch (err) {
        console.error('[state] subscriber', err);
      }
    }
    return function () {
      var at = everyone.indexOf(handler);
      if (at >= 0) everyone.splice(at, 1);
    };
  }

  window.PhosphorState = {
    get: get,
    put: put,
    select: select,
    subscribe: subscribe,
    loaded: loaded
  };
})();
