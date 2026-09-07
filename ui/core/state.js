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

  /* How many objects this is willing to look at before it stops looking.
     512 covers every slice on the payload with room over: a policy, a lock, a wallet of a dozen
     rows, the twenty proposals /api/state now carries, the agent roster and the board. Past it
     the answer is "assume it changed", which costs a redraw of something that already looked
     right. That is the direction to be wrong in: the other one is a screen quietly showing a
     number that has moved.

     Scalars are free. Only an object or an array that is not already the same object spends any
     of this, so a list whose rows arrived as the same objects costs one. */
  var COMPARE_BUDGET = 512;

  /* Did this slice move.
     It used to be JSON.stringify on both sides, always. The payload was described as small, and
     it was not: at 1000 proposals the proposals slice was 744 KB, a stringify of it measured
     0.67 ms, and this runs it twice, so 1.33 ms of main-thread work per state frame went on
     answering a question whose answer was usually "nothing moved". A frame arrives every 15 s at
     rest and up to 8 times a second with a trading feed live.

     Nothing is serialised at all now. It walks the two values, stops at the first thing that
     differs, and stops altogether once it has looked at COMPARE_BUDGET objects. Identity is
     checked before anything else at every level, so the case the 304 path in net.js already makes
     common (the same object) is one comparison, and a re-parsed payload whose rows came back as
     the same objects is one per row.

     Giving up reads as "changed", so a slice too big to walk is rendered rather than skipped. The
     reconcilers in ui/core/dom.js are keyed and their setters diff before they write, so a render
     of a list that did not move writes nothing to the DOM. */
  function same(a, b) {
    return walk(a, b, { left: COMPARE_BUDGET });
  }

  function walk(a, b, budget) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (budget.left <= 0) return false;
    budget.left -= 1;

    var aIsList = Array.isArray(a);
    if (aIsList !== Array.isArray(b)) return false;

    var i;
    if (aIsList) {
      if (a.length !== b.length) return false;
      for (i = 0; i < a.length; i += 1) {
        if (!walk(a[i], b[i], budget)) return false;
      }
      return true;
    }

    var keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!walk(a[key], b[key], budget)) return false;
    }
    return true;
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
