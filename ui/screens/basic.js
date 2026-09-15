/* Basic: one 640 px column, for a person who has never held a wallet.

   The one job is to answer "is my money OK" and get one safe yes or no out of
   them. No prices, no donut, no chains, no hex, no percentages under an hour.

   The hero is unboxed: the total, then one sentence that says what is happening
   to the money right now. Under it the rules strip, which is the safety model in
   one line and the surface policy_show lands on. Everything below the strip is a
   surface, because a bordered box is the mark of something the assistant can
   touch, and static text is not given one. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var marks = window.PhosphorMarks;

  /* How long a row that just moved keeps its tint and its delta: long enough to
     be seen by someone who was reading the number above, short enough that
     three ticks in a row do not leave the list lit. */
  var CHANGED_MS = 1200;

  /* The hand on the rules strip: an open palm on a 16 box, 1.5 stroke, the
     same drawing Pro's Policy card gives the ask rule. */
  var HAND = 'M4.75 9V4.75a1.25 1.25 0 0 1 2.5 0V8.5M7.25 8.5V3.25a1.25 1.25 0 0 1 2.5 0V8.5'
    + 'M9.75 8.5V4.25a1.25 1.25 0 0 1 2.5 0V10.5'
    + 'M4.75 9l-1.3-1.3a1.24 1.24 0 0 0-1.75 1.75L5 12.75A4.25 4.25 0 0 0 8 14h1.25a3 3 0 0 0 3-3v-.5';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var refs = {};
  var mounted = false;
  var allActivity = false;

  /* The first total the window saw this session. The frame carries no day
     change, so the one honest comparison is against the moment the person
     opened the window. */
  var firstTotal = null;

  /* One stroked path in the svg namespace, built rather than assigned as
     markup. Null where there is no namespace to build in, which is the unit
     harness, and every caller treats null as "no glyph". */
  function glyph(className, path) {
    if (typeof document.createElementNS !== 'function') return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', path);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
    return svg;
  }

  function boot() {
    var host = document.getElementById('view-basic');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    /* The hero sentence is the assistant's state as much as the money's, and the
       phase moves on driver frames the store never sees. */
    window.addEventListener('phosphor:agent-phase', renderState);
    window.PhosphorReceipts.onChange(function () {
      if (refs.activity.node.dataset.open === 'true') renderActivity();
    });
  }

  function build(host) {
    var col = dom.el('div', 'basic-col');

    /* The hero has no field and no box of its own. A second canvas at a second
       cell size drew a rectangle you could see the edges of, and a border here
       would say the assistant can act on a number. The one page field runs
       behind the column and the total is the largest quiet thing on it. */
    var hero = dom.el('section', 'hero');
    var total = dom.el('p', 'balance tick');
    total.dataset.role = 'total';
    /* The change since the window opened, in the direction's colour, and only
       while there is one: a zero is nothing to say, and a number the frame
       does not carry is never invented. */
    var delta = dom.el('p', 'hero-delta mono tick');
    delta.dataset.role = 'delta';
    delta.hidden = true;
    var line = dom.el('p', 'hero-line');
    line.dataset.role = 'state';
    hero.appendChild(total);
    hero.appendChild(delta);
    hero.appendChild(line);
    col.appendChild(hero);

    /* What the money is made of: one segment per coin by share, each in the
       coin's own colour. It is the one coloured thing on the page and it is
       information, so it carries no label and no box. */
    var alloc = dom.el('div', 'alloc');
    alloc.setAttribute('aria-hidden', 'true');
    alloc.hidden = true;
    col.appendChild(alloc);

    var warning = dom.el('div', 'banner');
    warning.dataset.tone = 'warn';
    warning.setAttribute('role', 'alert');
    warning.hidden = true;
    var warnText = dom.el('span');
    warnText.dataset.role = 'warning';
    warning.appendChild(warnText);
    col.appendChild(warning);

    /* Your rules, one strip. It teaches the safety model in a sentence and it is
       where policy_show lands, so it is a surface without being a box. The hand
       at its left is the same glyph Pro's Policy card gives the ask rule, so
       the sentence reads as a rule rather than a stray line of text. */
    var strip = dom.el('p', 'strip');
    strip.dataset.surface = 'rules';
    var hand = glyph('strip-glyph', HAND);
    if (hand) strip.appendChild(hand);
    var stripText = dom.el('span', 'strip-text');
    strip.appendChild(stripText);
    col.appendChild(strip);

    var hold = panel('What you hold', 'holdings');
    var holdBody = dom.el('div', 'panel-body-flush scrolls');
    hold.node.appendChild(holdBody);
    var smallNote = dom.el('p', 'meta panel-body');
    smallNote.hidden = true;
    hold.node.appendChild(smallNote);
    col.appendChild(hold.node);

    var moneyIn = fold('Money in', 'Where to send money', 'moneyin');
    col.appendChild(moneyIn.node);

    var activity = fold('Activity', 'What happened, newest first', 'activity');
    col.appendChild(activity.node);

    host.appendChild(col);

    refs = {
      total: total,
      delta: delta,
      state: line,
      alloc: alloc,
      warning: warning,
      warnText: warnText,
      strip: strip,
      stripText: stripText,
      holdBody: holdBody,
      smallNote: smallNote,
      moneyIn: moneyIn,
      activity: activity,
      activityBody: activity.body,
      holdCut: cuts(holdBody)
    };

    moneyIn.onOpen(function () {
      window.PhosphorMoneyIn.render(moneyIn.body);
    });
    activity.onOpen(function () {
      window.PhosphorReceipts.load();
      renderActivity();
    });
  }

  /* The column takes the height of the window, so the list of what is held is
     what gives when there is more of it than there is room. A list cut by an
     edge says so: a coin sliced in half by the bottom of a box reads as the end
     of the list, and this list is the answer to "is my money OK". */
  function cuts(node) {
    function paint() {
      var top = node.scrollTop > 2;
      var bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 2;
      dom.setAttr(node, 'data-cut', top && bottom ? 'both' : (top ? 'top' : (bottom ? 'bottom' : null)));
    }
    dom.on(node, 'scroll', paint, { passive: true });
    if (window.ResizeObserver) new window.ResizeObserver(paint).observe(node);
    paint();
    return paint;
  }

  function panel(title, surface) {
    var node = dom.el('section', 'panel');
    node.dataset.surface = surface;
    var head = dom.el('div', 'panel-head');
    head.appendChild(dom.el('h2', 'title-sm', title));
    node.appendChild(head);
    return { node: node, head: head };
  }

  function fold(title, note, surface) {
    var node = dom.el('section', 'fold');
    node.dataset.surface = surface;
    var head = dom.el('button', 'fold-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    var left = dom.el('div', 'stack-2');
    left.appendChild(dom.el('span', 'title-sm', title));
    left.appendChild(dom.el('span', 'meta', note));
    head.appendChild(left);
    /* The caret is drawn, not typed. A glyph in a control reads as an arrow in
       the label, and the window has none of those. */
    var mark = dom.el('span', 'fold-mark');
    mark.setAttribute('aria-hidden', 'true');
    head.appendChild(mark);
    var body = dom.el('div', 'fold-body panel-body');
    body.hidden = true;
    node.appendChild(head);
    node.appendChild(body);

    var opened = [];
    dom.on(head, 'click', function () {
      var open = node.dataset.open === 'true';
      if (open) {
        delete node.dataset.open;
        body.hidden = true;
        head.setAttribute('aria-expanded', 'false');
        return;
      }
      node.dataset.open = 'true';
      body.hidden = false;
      head.setAttribute('aria-expanded', 'true');
      for (var i = 0; i < opened.length; i += 1) opened[i]();
    });

    return {
      node: node,
      body: body,
      onOpen: function (fn) { opened.push(fn); }
    };
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    var basic = state.basic || {};

    dom.setNumber(refs.total, basic.totalLine || '');
    renderDelta(basic);
    renderState();
    renderRules(state);

    dom.setText(refs.warnText, basic.warning || '');
    dom.setHidden(refs.warning, !basic.warning);

    renderHoldings(basic, state);

    if (refs.activity.node.dataset.open === 'true') renderActivity();
  }

  /* The change since the window opened. A total the frame could not settle
     (still checking, or checking after a write) is null, and null is not a
     number to compare, so the line waits rather than guessing; the first real
     total after the window opened is the mark everything after is measured
     from. Under half a cent either way, there is nothing to say. */
  function renderDelta(basic) {
    var total = typeof basic.totalUsd === 'number' && isFinite(basic.totalUsd) ? basic.totalUsd : null;
    if (total !== null && firstTotal === null) firstTotal = total;
    var change = total === null || firstTotal === null ? 0 : total - firstTotal;
    if (Math.abs(change) < 0.005) {
      dom.setHidden(refs.delta, true);
      return;
    }
    var up = change > 0;
    dom.setAttr(refs.delta, 'data-dir', up ? 'up' : 'down');
    dom.setNumber(refs.delta, (up ? '+' : '-') + dom.usd(Math.abs(change), 2) + ' since you opened');
    dom.setHidden(refs.delta, false);
  }

  /* Five sentences, one of them true. The order is the window's order: a locked
     wallet outranks a pending ask, which outranks a number still being checked
     (the server's checkingLine, under the number and never in its slot), which
     outranks a working assistant. */
  function renderState() {
    if (!mounted) return;
    var state = store.get() || {};
    var lock = state.lock || {};
    var basic = state.basic || {};
    var word = 'Nothing is connected to it right now.';
    if (lock.state === 'locked' || lock.state === 'no_wallet' || lock.state === 'needs_migration') {
      word = 'Locked. Nothing moves.';
    } else if (pendingCount(state) > 0) {
      word = 'Waiting for you.';
    } else if (basic.checkingLine) {
      word = basic.checkingLine;
    } else if (window.PhosphorAgent && typeof window.PhosphorAgent.isWorking === 'function'
      && window.PhosphorAgent.isWorking()) {
      word = 'Your assistant is reading it.';
    }
    dom.setText(refs.state, word);
  }

  function pendingCount(state) {
    if (!Array.isArray(state.proposals)) return 0;
    var count = 0;
    for (var i = 0; i < state.proposals.length; i += 1) {
      var p = state.proposals[i];
      if (p && (p.status === 'pending' || p.status === 'pending_unlock')) count += 1;
    }
    return count;
  }

  /* The three numbers a person has to know, in the order they meet them: the one
     that stops the assistant and asks, then the two that stop it outright. */
  function renderRules(state) {
    var out = (state.policy && state.policy.outbound) || {};
    var parts = [];
    if (typeof out.humanClickAboveUsd === 'number') {
      parts.push('Asks you above ' + dom.usd(out.humanClickAboveUsd, 0) + '.');
    }
    if (typeof out.maxPerTransactionUsd === 'number' && typeof out.maxPerSessionUsd === 'number') {
      parts.push('Refuses above ' + dom.usd(out.maxPerTransactionUsd, 0) + ' at once and '
        + dom.usd(out.maxPerSessionUsd, 0) + ' a day.');
    } else if (typeof out.maxPerTransactionUsd === 'number') {
      parts.push('Refuses above ' + dom.usd(out.maxPerTransactionUsd, 0) + ' at once.');
    }
    dom.setText(refs.stripText, parts.length ? parts.join(' ') : 'No limits are set yet.');
  }

  /* Dust is not an answer to "is my money OK". A row worth under a dollar is
     counted rather than listed, so the list is the things a person would
     actually name if you asked them what they had. */
  function renderHoldings(basic, state) {
    /* A read that failed and a wallet with nothing in it both arrive here as an
       empty list, and they are opposite answers to the one question this screen
       exists for. The banner above already says the read failed; the panel used
       to sit under it saying the wallet is empty and telling a person to go and
       send themselves money. */
    var wallet = (state && state.wallet) || {};
    var unread = Array.isArray(wallet.stale) && wallet.stale.length > 0;
    var all = Array.isArray(basic.holdings) ? basic.holdings : [];
    var holdings = [];
    var small = 0;
    for (var h = 0; h < all.length; h += 1) {
      if (Number(all[h].valueUsd) >= 1) holdings.push(all[h]);
      else small += 1;
    }
    dom.setText(refs.smallNote, small === 0 ? '' : (small === 1
      ? 'One smaller holding, not listed.'
      : small + ' smaller holdings, not listed.'));
    dom.setHidden(refs.smallNote, small === 0);

    renderAlloc(holdings);

    if (!holdings.length && !store.loaded()) {
      renderHoldSkeleton();
      return;
    }
    if (!holdings.length) {
      dom.clear(refs.holdBody);
      delete refs.holdBody.dataset.skeleton;
      refs.holdBody.__keyed = null;
      refs.holdBody.appendChild(unread
        ? emptyBlock('Could not read what you hold',
          'This is not a wallet with nothing in it. The app will show what is there as soon as the read works.')
        : emptyBlock('Nothing here yet',
          'Open Money in and send something to one of your addresses.'));
      return;
    }
    if (refs.holdBody.dataset.skeleton === 'true') {
      dom.clear(refs.holdBody);
      delete refs.holdBody.dataset.skeleton;
    }

    dom.reconcile(refs.holdBody, holdings, function (row) {
      return row.name;
    }, function () {
      var node = dom.el('div', 'row');
      node.appendChild(marks.disc(''));
      var main = dom.el('div', 'row-main');
      main.appendChild(dom.el('span', 'body'));
      var side = dom.el('div', 'row-side stack-2');
      /* The value line holds the change beside the value, so a number that
         moved says by how much, in the direction's colour, for a moment. */
      var value = dom.el('div', 'row-value');
      value.appendChild(dom.el('span', 'row-delta mono'));
      value.appendChild(dom.el('span', 'body mono tick'));
      side.appendChild(value);
      side.appendChild(dom.el('span', 'meta mono'));
      node.appendChild(main);
      node.appendChild(side);
      return node;
    }, function (node, row) {
      var mark = node.children[0];
      var symbol = symbolOf(row.name);
      if (mark.dataset.symbol !== symbol) {
        mark.dataset.symbol = symbol;
        marks.paint(mark, symbol);
        /* The row reads the coin's colour too, for the tint a change lands on. */
        var colour = marks.colourFor(symbol);
        if (colour) node.style.setProperty('--coin', colour);
        else node.style.removeProperty('--coin');
      }
      dom.setText(node.children[1].children[0], row.name);
      dom.setNumber(node.children[2].children[0].children[1], row.valueLine);
      dom.setText(node.children[2].children[1], row.quantityLine);
      markChanged(node, row);
    });
    refs.holdCut();
  }

  /* The bar under the hero. Shares are of what is listed, and one coin makes
     no shape, so the bar waits for a second one. A coin without a brand
     colour takes the quiet text colour, which the stylesheet falls back to. */
  function renderAlloc(holdings) {
    var total = 0;
    for (var i = 0; i < holdings.length; i += 1) total += Math.max(0, Number(holdings[i].valueUsd) || 0);
    var shown = holdings.length >= 2 && total > 0;
    dom.reconcile(refs.alloc, shown ? holdings : [], function (row) {
      return row.name;
    }, function () {
      return dom.el('span', 'alloc-seg');
    }, function (seg, row) {
      var share = Math.max(0, Number(row.valueUsd) || 0) / total;
      seg.style.flexGrow = String(share);
      var colour = marks.colourFor(symbolOf(row.name));
      if (colour) seg.style.setProperty('--coin', colour);
      else seg.style.removeProperty('--coin');
      seg.title = row.name + ', ' + dom.pct(share, 0);
    });
    dom.setHidden(refs.alloc, !shown);
  }

  /* This screen is given names rather than tickers, because a person who has
     never held a wallet reads "US dollars (USDC)" and not "USDC". The mark is
     drawn off the ticker inside the name, and a name with no ticker in it, like
     the pooled row, gets the generic coin. */
  function symbolOf(name) {
    var text = String(name || '');
    var found = /\(([A-Za-z0-9]+)\)\s*$/.exec(text);
    if (found) return found[1];
    return /^[A-Za-z0-9]{2,6}$/.test(text) ? text : '';
  }

  /* A row whose number just moved tints in its coin's colour for a moment and
     says by how much beside the value, so a change that arrived while the
     person was reading something else is still visible when they look back.
     The first fill is not a change. */
  function markChanged(node, row) {
    var next = row.valueLine === undefined || row.valueLine === null ? '' : String(row.valueLine);
    var had = node.dataset.shown;
    var usd = Number(row.valueUsd);
    var was = node.__usd;
    node.dataset.shown = next;
    node.__usd = isFinite(usd) ? usd : undefined;
    if (had === undefined || had === next) return;
    var delta = node.children[2].children[0].children[0];
    var moved = isFinite(usd) && typeof was === 'number' ? usd - was : 0;
    if (Math.abs(moved) >= 0.005) {
      dom.setAttr(delta, 'data-dir', moved > 0 ? 'up' : 'down');
      dom.setText(delta, (moved > 0 ? '+' : '-') + dom.usd(Math.abs(moved), 2));
    } else {
      dom.setText(delta, '');
    }
    node.dataset.changed = 'true';
    if (node.__changeTimer) window.clearTimeout(node.__changeTimer);
    node.__changeTimer = window.setTimeout(function () {
      delete node.dataset.changed;
      node.__changeTimer = 0;
    }, CHANGED_MS);
  }

  function renderHoldSkeleton() {
    if (refs.holdBody.dataset.skeleton === 'true') return;
    refs.holdBody.dataset.skeleton = 'true';
    dom.clear(refs.holdBody);
    for (var i = 0; i < 3; i += 1) {
      var row = dom.el('div', 'row');
      var left = dom.el('div', 'skel grow');
      left.style.height = '16px';
      var right = dom.el('div', 'skel');
      right.style.height = '16px';
      right.style.width = '84px';
      row.appendChild(left);
      row.appendChild(right);
      refs.holdBody.appendChild(row);
    }
  }

  /* Five rows, newest first, and a way to the rest that is a real action rather
     than a word that goes nowhere. */
  function renderActivity() {
    var host = refs.activityBody;
    var all = window.PhosphorReceipts.get();
    if (refs.seeAll && refs.seeAll.parentNode) refs.seeAll.parentNode.removeChild(refs.seeAll);
    window.PhosphorReceipts.render(host, allActivity ? {} : { limit: 5 });
    if (allActivity || all.length <= 5) return;
    var more = dom.el('button', 'btn btn-quiet see-all');
    more.type = 'button';
    more.appendChild(dom.el('span', 'btn-label', 'See all'));
    dom.on(more, 'click', function () {
      allActivity = true;
      renderActivity();
    });
    refs.seeAll = more;
    host.appendChild(more);
  }

  function emptyBlock(title, note) {
    var empty = dom.el('div', 'empty');
    empty.appendChild(dom.el('p', 'empty-title', title));
    empty.appendChild(dom.el('p', '', note));
    return empty;
  }

  window.PhosphorBasic = { boot: boot };
})();
