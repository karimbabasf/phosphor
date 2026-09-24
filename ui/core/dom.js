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

  /* The app's own mark, as an svg that points at the one copy index.html holds
     (<symbol id="phosphor-mark">), so every mark in the window is the colour of
     the element that holds it. Built in the svg namespace rather than by
     innerHTML: the screens that draw a mark are the screens that also render a
     model's text, and they are held to never assigning markup at all. Returns
     null where there is no svg namespace to build in, which is the test
     harness's stand-in document, and every caller treats null as "no mark". */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  /* With a state it is the animated mark of contract 6: `svg.mark[data-state]`, which
     ui/design/mark.css draws idle, working or done. */
  function mark(className, state) {
    if (typeof document.createElementNS !== 'function') return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    var names = (state ? 'mark ' : '') + (className || '');
    if (names.trim()) svg.setAttribute('class', names.trim());
    if (state) svg.setAttribute('data-state', state);
    svg.setAttribute('viewBox', '0 0 58.05 64.75');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#phosphor-mark');
    use.setAttributeNS(XLINK_NS, 'xlink:href', '#phosphor-mark');
    svg.appendChild(use);
    return svg;
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

  /* A number that changes rolls its digits rather than snapping: each digit
     that differs slides out in the direction the number moved and the new one
     slides in behind it, with a short blur to hide the overlap, so a price that
     ticks reads as a price ticking and a total that grows is seen to grow.

     Only digits roll; the currency sign, the separators and the spaces stay
     as plain text so the width and the baseline never move. When the browser
     cannot animate (the unit harness, reduced motion) the value is set at once,
     and the node's textContent is the whole contract either way: it always
     reads as the plain value. 400 ms on the window's ease-out, the number
     grammar the design contract names. */
  var ROLL_MS = 400;
  var ROLL_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

  function setNumber(node, text) {
    if (!node) return;
    var value = text === undefined || text === null ? '' : String(text);
    if (node.textContent === value) return;
    var motion = window.PhosphorMotion;
    var still = !!(motion && typeof motion.reduced === 'function' && motion.reduced());
    if (!node.textContent || still || !canRoll(node)) {
      node.textContent = value;
      return;
    }
    roll(node, node.textContent, value);
  }

  function canRoll(node) {
    return typeof node.animate === 'function'
      && typeof document !== 'undefined'
      && typeof document.createElement === 'function';
  }

  function numeric(text) {
    var n = parseFloat(String(text).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  function roll(node, from, to) {
    var was = numeric(from);
    var now = numeric(to);
    /* Up when the number grew, down when it shrank, and up for anything that
       is not a number at all. */
    var dir = was !== null && now !== null && now < was ? -1 : 1;
    var token = (node.__roll || 0) + 1;
    node.__roll = token;

    var ease = ROLL_EASE;
    while (node.firstChild) node.removeChild(node.firstChild);
    var pending = [];
    var changed = 0;
    for (var i = 0; i < to.length; i += 1) {
      var ch = to.charAt(i);
      var old = i < from.length ? from.charAt(i) : '';
      if (!/[0-9]/.test(ch) || ch === old) {
        node.appendChild(document.createTextNode(ch));
        continue;
      }
      var cell = document.createElement('span');
      cell.className = 'rd';
      cell.textContent = ch;
      if (/[0-9]/.test(old)) {
        var out = document.createElement('span');
        out.className = 'rd-out';
        out.setAttribute('aria-hidden', 'true');
        out.textContent = old;
        cell.appendChild(out);
        pending.push(out.animate([
          { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' },
          { transform: 'translateY(' + (dir * -0.6) + 'em)', opacity: 0, filter: 'blur(2px)' }
        ], { duration: ROLL_MS, easing: ease, delay: changed * 14, fill: 'forwards' }));
      }
      pending.push(cell.animate([
        { transform: 'translateY(' + (dir * 0.6) + 'em)', opacity: 0, filter: 'blur(2px)' },
        { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' }
      ], { duration: ROLL_MS, easing: ease, delay: changed * 14, fill: 'backwards' }));
      changed += 1;
      node.appendChild(cell);
    }
    /* Back to plain text once the roll has settled, so the node the next
       comparison reads is the value and nothing else. A roll that starts
       before this one settles takes the token with it and this cleanup
       stands down. */
    function settle() {
      if (node.__roll !== token) return;
      node.textContent = to;
    }
    var done = 0;
    if (!pending.length) { settle(); return; }
    for (var k = 0; k < pending.length; k += 1) {
      var animation = pending[k];
      var finish = function () { done += 1; if (done === pending.length) settle(); };
      if (animation && animation.finished && typeof animation.finished.then === 'function') {
        animation.finished.then(finish, finish);
      } else {
        window.setTimeout(finish, ROLL_MS + changed * 14 + 20);
      }
    }
  }

  /* Reconcile a list against keyed data. `create(item)` builds a node once,
     `update(node, item, index)` fills it every pass. Nodes keep their identity
     across renders, so a row being hovered or focused stays where it is.

     THE HOST BELONGS TO THE RECONCILER. Everything in it after this returns is
     a row this call placed, and anything else in there is removed.

     It used to remove only the nodes it had named itself, tracked on __keyed,
     which meant a hand-appended empty block was invisible to it. Rows arrived,
     went in above the block because the first one is inserted at firstChild,
     and the block stayed: the trade screen listed six fills with "Nothing yet.
     Fills and cancels land here as they happen." sitting under them. A loading
     skeleton left the same way. So a caller may still append its own empty
     state or skeleton straight to the host, and the next populated pass takes
     it away without being told about it. A caller that wants a footer under a
     reconciled list has to re-append it after each pass, the way Basic's
     See all button already does. */
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

    /* Every row this pass placed sits in order from the first child, so
       everything after the last of them is a leftover: a row that has gone from
       the data, an empty state, a skeleton. An empty list leaves nothing
       placed, so the whole host goes. */
    var leftover = previous ? previous.nextSibling : parent.firstChild;
    while (leftover) {
      var after = leftover.nextSibling;
      parent.removeChild(leftover);
      leftover = after;
    }

    parent.__keyed = next;
  }

  /* ---------- Formatting ---------- */

  /* An unknown value prints nothing, never $0.00: null, undefined, an empty
     string and anything that is not a number are "we do not know", and a zero
     in their place told a person their money was gone. A real 0 is still $0.00. */
  function known(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function usd(value, digits) {
    var n = known(value);
    if (n === null) return '';
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
    var n = known(value);
    if (n === null) return '';
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
    mark: mark,
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
