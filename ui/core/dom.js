/* Phosphor DOM helpers. The keyed reconciler is the point of this file: a list
   that rebuilds with textContent = '' throws away focus, scroll position and
   every running transition, and it is what made the old deck flash on a frame
   the numbers had not moved. */
(function () {
  'use strict';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(node, text) {
    if (!node) return;
    var value = text === undefined || text === null ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null || value === false || value === undefined) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      return;
    }
    var next = value === true ? '' : String(value);
    if (node.getAttribute(name) !== next) node.setAttribute(name, next);
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (node.hidden !== !!hidden) node.hidden = !!hidden;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    /* The reconciler's idea of what is on screen has to go with the nodes it
       named. It survived a clear, so the next pass reused elements that were no
       longer in the document and skipped the ones it thought were already
       there. */
    node.__keyed = null;
  }

  /* A number that changes crossfades rather than snapping, so a total that
     ticks does not read as a repaint. No digit scrolling. */
  function setNumber(node, text) {
    if (!node) return;
    var value = text === undefined || text === null ? '' : String(text);
    if (node.textContent === value) return;
    if (!node.textContent || window.PhosphorMotion.reduced()) {
      node.textContent = value;
      return;
    }
    node.dataset.ticking = 'true';
    window.setTimeout(function () {
      node.textContent = value;
      node.dataset.ticking = 'false';
    }, 140);
  }

  /* Reconcile a list against keyed data. `create(item)` builds a node once,
     `update(node, item, index)` fills it every pass. Nodes keep their identity
     across renders, so a row being hovered or focused stays where it is. */
  function reconcile(parent, items, keyOf, create, update) {
    if (!parent) return;
    var existing = parent.__keyed || {};
    var next = {};
    var previous = null;

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var key = String(keyOf(item, i));
      var node = existing[key];
      if (!node) {
        node = create(item, i);
        node.dataset.key = key;
      }
      next[key] = node;
      if (update) update(node, item, i);
      var wanted = previous ? previous.nextSibling : parent.firstChild;
      if (node !== wanted) parent.insertBefore(node, wanted);
      previous = node;
    }

    for (var key2 in existing) {
      if (!Object.prototype.hasOwnProperty.call(existing, key2)) continue;
      if (next[key2]) continue;
      var stale = existing[key2];
      if (stale.parentNode === parent) parent.removeChild(stale);
    }

    parent.__keyed = next;
  }

  /* ---------- Formatting ---------- */

  function usd(value, digits) {
    var n = Number(value);
    if (!isFinite(n)) return '$0.00';
    var d = digits === undefined ? 2 : digits;
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  /* Places follow the asset when the caller knows them, and a size that really
     traded is never rounded away: a 0.001 fill printed as 0 says nothing
     happened, which is the one thing this list must not say. Eight places is the
     venue's own ceiling on size. */
  function qty(value, digits) {
    var n = Number(value);
    if (!isFinite(n)) return '0';
    var d = digits === undefined ? (Math.abs(n) >= 1000 ? 2 : 4) : digits;
    for (var places = d; places <= 8; places += 1) {
      var out = n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: places });
      if (n === 0 || Number(out.replace(/,/g, '')) !== 0) return out;
    }
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
  }

  /* Fees are the one figure that runs from a tenth of a cent to a few dollars,
     so the places follow the number: two unless two would round it to zero. */
  function fee(value) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    if (n === 0) return '$0.00';
    return usd(n, Math.abs(n) < 0.01 ? 4 : 2);
  }

  function pct(value, digits) {
    var n = Number(value);
    if (!isFinite(n)) return '0%';
    return (n * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  /* Whole minutes and above only. A person does not need seconds to know when
     something happened, and a ticking seconds count is motion with no meaning. */
  function ago(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (!isFinite(then)) return '';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function clock(iso) {
    if (!iso) return '';
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function on(node, type, handler, options) {
    if (!node) return function () {};
    node.addEventListener(type, handler, options);
    return function () { node.removeEventListener(type, handler, options); };
  }

  function debounce(fn, ms) {
    var timer = 0;
    return function () {
      var args = arguments;
      var self = this;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  window.PhosphorDom = {
    el: el,
    setText: setText,
    setAttr: setAttr,
    setHidden: setHidden,
    setNumber: setNumber,
    clear: clear,
    reconcile: reconcile,
    usd: usd,
    fee: fee,
    qty: qty,
    pct: pct,
    ago: ago,
    clock: clock,
    on: on,
    debounce: debounce
  };
})();
