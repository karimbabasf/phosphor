/* Basic: one 640 px column, for a person who has never held a wallet.

   The one job is to answer "is my money OK" and get one safe yes or no out of
   them. No prices, no donut, no chains, no hex, no percentages under an hour.

   The eye lands on the total first, the rules second, what is held third: the
   hero is unboxed, the total is the largest quiet thing on the page and the one
   sentence under it says what is happening to the money right now. Under it the
   rules strip, which is the safety model in one line and the surface
   policy_show lands on. Everything below the strip is a surface, because a
   bordered box is the mark of something the assistant can touch, and static
   text is not given one. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var marks = window.PhosphorMarks;

  /* How long a row that just moved keeps its tint and its delta: long enough to
     be seen by someone who was reading the number above, short enough that
     three ticks in a row do not leave the list lit. */
  var CHANGED_MS = 1200;

  /* How many receipts the Activity fold shows before "See all". */
  var FOLD_ROWS = 5;

  var refs = {};
  var mounted = false;

  /* The first total the window saw this session. The frame carries no day
     change, so the one honest comparison is against the moment the person
     opened the window. */
  var firstTotal = null;

  /* The icon set arrives with the foundation. Until it is on this branch the
     call is guarded, and the strip and the folds draw without their icon. */
  function icon(name, className) {
    if (!window.PhosphorIcons || typeof window.PhosphorIcons.svg !== 'function') return null;
    return window.PhosphorIcons.svg(name, className);
  }

  /* A token mark at a size: the foundation's logo, or the disc it replaces
     until the merge lands. */
  function logo(symbol, size) {
    if (typeof marks.logo === 'function') return marks.logo(symbol, size);
    return marks.disc(symbol);
  }

  function colourOf(symbol) {
    return typeof marks.colour === 'function' ? marks.colour(symbol) : marks.colourFor(symbol);
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
  }

  function build(host) {
    var col = dom.el('div', 'basic-col');

    /* The hero has no field and no box of its own. A second canvas at a second
       cell size drew a rectangle you could see the edges of, and a border here
       would say the assistant can act on a number. The one page field runs
       behind the column and the total is the largest quiet thing on it. */
    var hero = dom.el('section', 'hero');
    var total = dom.el('p', 'balance mono tick');
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
       where policy_show lands, so it is a surface without being a box. The
       icon at its left is the one Pro's Policy card gives the ask rule, so
       the sentence reads as a rule rather than a stray line of text. */
    var strip = dom.el('p', 'strip');
    strip.dataset.surface = 'rules';
    var glyph = dom.el('span', 'strip-glyph');
    var waiting = icon('waiting');
    if (waiting) glyph.appendChild(waiting);
    strip.appendChild(glyph);
    var stripText = dom.el('span', 'strip-text');
    strip.appendChild(stripText);
    col.appendChild(strip);

    var hold = card('What you hold', 'holdings');
    var holdBody = dom.el('div', 'hold-list');
    hold.node.appendChild(holdBody);
    var smallNote = dom.el('p', 'meta hold-note');
    smallNote.hidden = true;
    hold.node.appendChild(smallNote);
    col.appendChild(hold.node);

    var moneyIn = fold('Money in', 'Where to send money', 'moneyin');
    col.appendChild(moneyIn.node);

    var activity = fold('Activity', 'Last 24 hours', 'activity');
    col.appendChild(activity.node);

    host.appendChild(col);

    /* The five newest receipts of the last day, and "See all" for the rest with
       the same chips Pro has. The list reads only once the fold opens: a window
       that never looks at Activity does not read receipts. */
    var activityList = window.PhosphorReceipts.list(activity.body, {
      compact: true,
      chips: false,
      limit: FOLD_ROWS,
      window: '24h',
      kind: 'all',
      source: 'activity',
      onMeta: function (meta) { dom.setText(activity.meta, activityWords(meta)); }
    });

    refs = {
      total: total,
      delta: delta,
      state: line,
      alloc: alloc,
      warning: warning,
      warnText: warnText,
      strip: strip,
      stripText: stripText,
      hold: hold,
      holdBody: holdBody,
      smallNote: smallNote,
      moneyIn: moneyIn,
      activity: activity,
      activityList: activityList
    };

    moneyIn.onOpen(function () {
      window.PhosphorMoneyIn.render(moneyIn.body);
    });
    var read = false;
    activity.onOpen(function () {
      if (read) return;
      read = true;
      activityList.load();
    });
  }

  /* A CARD IS A TITLE, ONE LINE OF META, A HAIRLINE, AND ITS CONTENT: the
     same head Pro's cards wear, so the two screens are one window read at two
     distances. */
  function card(title, surface) {
    var node = dom.el('section', 'panel card');
    node.dataset.surface = surface;
    var head = dom.el('div', 'card-head');
    head.appendChild(dom.el('h2', 'card-title', title));
    var meta = dom.el('p', 'card-meta');
    meta.hidden = true;
    head.appendChild(meta);
    node.appendChild(head);
    return { node: node, head: head, meta: meta };
  }

  /* A fold is the same card shut: the head is the control, the meta says what
     is behind it, and the chevron says it opens. */
  function fold(title, note, surface) {
    var node = dom.el('section', 'fold card');
    node.dataset.surface = surface;
    var head = dom.el('button', 'fold-head card-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(dom.el('span', 'card-title', title));
    var right = dom.el('span', 'fold-head-right');
    var meta = dom.el('span', 'card-meta', note);
    right.appendChild(meta);
    var mark = dom.el('span', 'fold-mark');
    mark.setAttribute('aria-hidden', 'true');
    var chevron = icon('chevron-down');
    if (chevron) mark.appendChild(chevron);
    right.appendChild(mark);
    head.appendChild(right);
    var body = dom.el('div', 'fold-body');
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
      meta: meta,
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
      dom.setHidden(refs.hold.meta, true);
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

    dom.setText(refs.hold.meta, holdings.length === 1 ? '1 coin' : holdings.length + ' coins');
    dom.setHidden(refs.hold.meta, false);

    dom.reconcile(refs.holdBody, holdings, function (row) {
      return row.name;
    }, function () {
      var node = dom.el('div', 'row');
      node.appendChild(dom.el('span', 'row-mark'));
      var main = dom.el('div', 'row-main');
      main.appendChild(dom.el('span', 'row-name'));
      var side = dom.el('div', 'row-side');
      /* The value line holds the change beside the value, so a number that
         moved says by how much, in the direction's colour, for a moment. */
      var value = dom.el('div', 'row-value');
      value.appendChild(dom.el('span', 'row-delta mono'));
      value.appendChild(dom.el('span', 'row-usd mono tick'));
      side.appendChild(value);
      side.appendChild(dom.el('span', 'row-qty mono'));
      node.appendChild(main);
      node.appendChild(side);
      return node;
    }, function (node, row) {
      var mark = node.children[0];
      var symbol = symbolOf(row.name);
      if (mark.dataset.symbol !== symbol) {
        mark.dataset.symbol = symbol;
        dom.clear(mark);
        mark.appendChild(logo(symbol, 24));
        /* The row reads the coin's colour too, for the tint a change lands on. */
        var colour = colourOf(symbol);
        if (colour) node.style.setProperty('--coin', colour);
        else node.style.removeProperty('--coin');
      }
      dom.setText(node.children[1].children[0], row.name);
      dom.setNumber(node.children[2].children[0].children[1], row.valueLine);
      dom.setText(node.children[2].children[1], row.quantityLine);
      markChanged(node, row);
    });
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
      var colour = colourOf(symbolOf(row.name));
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

  /* The fold's one line of meta: the window, then what it cost, the way the
     Pro card says it. Before the fold has read anything it names the window. */
  function activityWords(meta) {
    var words = meta.words.charAt(0).toUpperCase() + meta.words.slice(1);
    if (meta.state === 'error') return words + ', unread';
    if (meta.state === 'loading' && !meta.count) return words;
    if (!meta.total) return words + ', nothing yet';
    return words + ', ' + (meta.feesUsd > 0 ? dom.fee(meta.feesUsd) + ' in fees' : 'no fees');
  }

  function emptyBlock(title, note) {
    var empty = dom.el('div', 'empty');
    empty.appendChild(dom.el('p', 'empty-title', title));
    empty.appendChild(dom.el('p', '', note));
    return empty;
  }

  window.PhosphorBasic = { boot: boot };
})();
