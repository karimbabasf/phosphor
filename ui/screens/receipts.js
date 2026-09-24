/* Activity: what happened, newest first, each row a receipt.

   One list component, mounted by the Pro card and by the Basic fold. It reads
   /api/receipts, which is the one place that knows what a move cost and what
   the balance was on each side of it, and it owns the window (24h, 7d, All),
   the kind (All, Swaps, Trades, Moves, Bots) and the paging: the server keeps
   the taxonomy and the cursor, this file keeps the chips and the rows.

   The rows themselves are PhosphorReceipt.row and updateRow (receipt.js), so
   a receipt is drawn one way wherever it appears. A click emits receipt:open
   and nothing else: the card that opens is the receipt's business.

   The global is PhosphorReceipts rather than PhosphorActivity because
   ui/activity.js is the custody idle beacon and got there first. Two different
   things called activity is how one of them silently stops running. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;

  var PAGE = 25;
  var MAX = 200;
  var HOUR = 3600000;

  /* The time chips. `next` is the wider window the empty state offers, so a
     day with nothing in it is one click from the week. */
  var WINDOWS = [
    { id: '24h', label: '24h', ms: 24 * HOUR, words: 'last 24 hours', next: '7d', ask: 'Show 7 days?' },
    { id: '7d', label: '7d', ms: 7 * 24 * HOUR, words: 'last 7 days', next: 'all', ask: 'Show all?' },
    { id: 'all', label: 'All', ms: 0, words: 'all time', next: null, ask: '' }
  ];

  /* The kind chips. The ids are the four words GET /api/receipts accepts
     (src/http/receipts.ts RECEIPT_KINDS), so the window never lists rails. */
  var KINDS = [
    { id: 'all', label: 'All', noun: '' },
    { id: 'swap', label: 'Swaps', noun: 'swaps' },
    { id: 'trade', label: 'Trades', noun: 'trades' },
    { id: 'move', label: 'Moves', noun: 'moves' },
    { id: 'bot', label: 'Bots', noun: 'bots' }
  ];

  var instances = [];

  function windowOf(id) {
    for (var i = 0; i < WINDOWS.length; i += 1) if (WINDOWS[i].id === id) return WINDOWS[i];
    return WINDOWS[0];
  }

  function kindOf(id) {
    for (var i = 0; i < KINDS.length; i += 1) if (KINDS[i].id === id) return KINDS[i];
    return KINDS[0];
  }

  /* ---------- one list ---------- */

  /* options:
       window     '24h' | '7d' | 'all', the time chip that starts selected (24h)
       kind       'all' | 'swap' | 'trade' | 'move' | 'bot' (all)
       chips      whether the filter row is drawn (true)
       limit      rows per page (25)
       compact    Basic's fold: a few rows and "See all" in place of "Show more"
       filtersHost where the chips go when they must sit outside the scrolling
                  region (the Pro card head); the list's own host otherwise
       source     what receipt:open says it came from ('activity')
       onMeta     called with { words, count, total, feesUsd, state } after
                  every paint, for the card head that describes the window */
  function list(host, options) {
    var opts = options || {};
    var it = {
      host: host,
      filtersHost: opts.filtersHost || host,
      window: opts.window || '24h',
      kind: opts.kind || 'all',
      chips: opts.chips !== false,
      limit: opts.limit || PAGE,
      compact: opts.compact === true,
      source: opts.source || 'activity',
      onMeta: typeof opts.onMeta === 'function' ? opts.onMeta : null,
      rows: [],
      total: 0,
      hasMore: false,
      feesUsd: 0,
      state: 'idle',
      seq: 0,
      nodes: {}
    };
    build(it);
    instances.push(it);
    return {
      load: function () { return load(it); },
      setWindow: function (id) { setWindow(it, id); },
      setKind: function (id) { setKind(it, id); },
      expand: function () { expand(it); },
      get: function () { return it.rows; },
      query: function () { return { window: it.window, kind: it.kind }; }
    };
  }

  function build(it) {
    var filters = dom.el('div', 'activity-filters');
    filters.appendChild(chipRow(it, 'Time', WINDOWS, function () { return it.window; }, function (id) { setWindow(it, id); }));
    filters.appendChild(chipRow(it, 'Kind', KINDS, function () { return it.kind; }, function (id) { setKind(it, id); }));
    dom.setHidden(filters, !it.chips);
    it.filtersHost.appendChild(filters);

    var rows = dom.el('div', 'activity-rows');
    it.host.appendChild(rows);
    var foot = dom.el('div', 'activity-foot');
    it.host.appendChild(foot);

    it.nodes = { filters: filters, rows: rows, foot: foot };
  }

  /* A row of pills, one pressed. aria-pressed is the state; the stylesheet
     reads it, and so does a screen reader. */
  function chipRow(it, label, items, current, pick) {
    var row = dom.el('div', 'chip-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    for (var i = 0; i < items.length; i += 1) {
      (function (item) {
        var chip = dom.el('button', 'chip chip-filter', item.label);
        chip.type = 'button';
        chip.dataset.id = item.id;
        chip.setAttribute('aria-pressed', current() === item.id ? 'true' : 'false');
        dom.on(chip, 'click', function () { pick(item.id); });
        row.appendChild(chip);
      })(items[i]);
    }
    return row;
  }

  function pressChips(it) {
    var rows = it.nodes.filters.children;
    var wanted = [it.window, it.kind];
    for (var r = 0; r < rows.length; r += 1) {
      var chips = rows[r].children;
      for (var c = 0; c < chips.length; c += 1) {
        chips[c].setAttribute('aria-pressed', chips[c].dataset.id === wanted[r] ? 'true' : 'false');
      }
    }
  }

  /* ---------- reading ---------- */

  function read(it, before, limit) {
    var win = windowOf(it.window);
    var params = ['limit=' + limit];
    if (win.ms) params.push('since=' + (Date.now() - win.ms));
    if (before) params.push('before=' + before);
    if (it.kind !== 'all') params.push('kind=' + it.kind);
    return net.getJson('/api/receipts?' + params.join('&'), { busy: 'activity', label: 'Reading what happened' });
  }

  function take(result) {
    var data = (result && result.data) || {};
    var receipts = Array.isArray(data.receipts) ? data.receipts : [];
    return {
      receipts: receipts,
      total: typeof data.total === 'number' ? data.total : receipts.length,
      hasMore: data.hasMore === true,
      feesUsd: typeof data.feesUsd === 'number' ? data.feesUsd : 0
    };
  }

  /* The first page, or the same depth again on a refresh: a transactions frame
     that lands while somebody is three pages down must not fold the list back
     to one page under them. */
  function load(it) {
    var seq = ++it.seq;
    it.state = it.rows.length ? 'refreshing' : 'loading';
    paint(it);
    var depth = Math.min(MAX, Math.max(it.limit, it.rows.length));
    return read(it, 0, depth)
      .then(function (result) {
        if (seq !== it.seq) return it.rows;
        var got = take(result);
        it.rows = got.receipts;
        it.total = got.total;
        it.hasMore = got.hasMore;
        it.feesUsd = got.feesUsd;
        it.state = 'ready';
        paint(it);
        return it.rows;
      })
      .catch(function () {
        if (seq !== it.seq) return it.rows;
        it.state = 'error';
        paint(it);
        return it.rows;
      });
  }

  /* The next page, older than the last row on screen. */
  function more(it) {
    if (it.state === 'loading' || it.state === 'more' || !it.rows.length) return;
    var seq = ++it.seq;
    var last = it.rows[it.rows.length - 1];
    var before = Date.parse(last.at);
    if (!isFinite(before)) return;
    it.state = 'more';
    paint(it);
    read(it, before, PAGE)
      .then(function (result) {
        if (seq !== it.seq) return;
        var got = take(result);
        it.rows = it.rows.concat(got.receipts);
        it.total = got.total;
        it.hasMore = got.hasMore;
        it.feesUsd = got.feesUsd;
        it.state = 'ready';
        paint(it);
      })
      .catch(function () {
        if (seq !== it.seq) return;
        it.state = 'error';
        paint(it);
      });
  }

  function setWindow(it, id) {
    if (it.window === id) return;
    it.window = id;
    it.rows = [];
    load(it);
  }

  function setKind(it, id) {
    if (it.kind === id) return;
    it.kind = id;
    it.rows = [];
    load(it);
  }

  /* Basic's "See all": the same list with its chips and its pages. */
  function expand(it) {
    it.compact = false;
    it.chips = true;
    it.limit = PAGE;
    it.rows = [];
    load(it);
  }

  /* ---------- drawing ---------- */

  function paint(it) {
    var nodes = it.nodes;
    dom.setHidden(nodes.filters, !it.chips);
    pressChips(it);
    paintRows(it);
    paintFoot(it);
    if (it.onMeta) {
      it.onMeta({
        words: windowOf(it.window).words,
        window: it.window,
        kind: it.kind,
        count: it.rows.length,
        total: it.total,
        feesUsd: it.feesUsd,
        state: it.state
      });
    }
  }

  function paintRows(it) {
    var host = it.nodes.rows;
    if (it.state === 'loading') {
      dom.clear(host);
      host.__keyed = null;
      for (var i = 0; i < 3; i += 1) {
        var skel = dom.el('div', 'row');
        var bar = dom.el('div', 'skel grow');
        bar.style.height = '18px';
        skel.appendChild(bar);
        host.appendChild(skel);
      }
      return;
    }
    if (host.__keyed === null || host.__keyed === undefined) dom.clear(host);
    dom.reconcile(host, it.rows, function (receipt) {
      return receipt.id;
    }, function () {
      var node = window.PhosphorReceipt.row();
      dom.on(node, 'click', function () {
        var current = null;
        for (var i = 0; i < it.rows.length; i += 1) {
          if (it.rows[i].id === node.dataset.key) current = it.rows[i];
        }
        if (current && window.PhosphorEvents) {
          window.PhosphorEvents.emit('receipt:open', { receipt: current, source: it.source });
        }
      });
      return node;
    }, function (node, receipt) {
      window.PhosphorReceipt.updateRow(node, receipt);
    });
  }

  /* Under the rows: the way to the next page, or the sentence that says why
     there is nothing, with the one click that widens the window. Never a
     blank card. */
  function paintFoot(it) {
    var foot = it.nodes.foot;
    dom.clear(foot);

    if (it.state === 'error') {
      var failed = dom.el('div', 'activity-empty');
      failed.appendChild(dom.el('p', 'activity-empty-line', 'The app could not read what happened.'));
      failed.appendChild(link('Try again', function () { load(it); }));
      foot.appendChild(failed);
      return;
    }

    if (it.state === 'loading') return;

    if (!it.rows.length) {
      foot.appendChild(emptyState(it));
      return;
    }

    if (it.compact) {
      foot.appendChild(button('See all', function () { expand(it); }, false));
      return;
    }

    if (it.hasMore || it.state === 'more') {
      foot.appendChild(button(it.state === 'more' ? 'Loading more' : 'Show more', function () { more(it); }, it.state === 'more'));
    }
  }

  function emptyState(it) {
    var win = windowOf(it.window);
    var kind = kindOf(it.kind);
    var box = dom.el('div', 'activity-empty');
    var line;
    if (win.ms) {
      line = kind.noun ? 'No ' + kind.noun + ' in the ' + win.words + '.' : 'Nothing in the ' + win.words + '.';
    } else if (kind.noun) {
      line = kind.id === 'trade'
        ? 'No trades here yet. Fills are on the Trade screen.'
        : 'No ' + kind.noun + ' yet.';
    } else {
      line = 'Nothing has happened yet.';
    }
    box.appendChild(dom.el('p', 'activity-empty-line', line));
    if (win.next) {
      box.appendChild(link(win.ask, function () { setWindow(it, win.next); }));
    } else if (!kind.noun) {
      box.appendChild(dom.el('p', 'activity-empty-note',
        'When your assistant moves money, every action lands here as a receipt.'));
    }
    return box;
  }

  function button(label, onClick, pending) {
    var more = dom.el('button', 'btn btn-ghost activity-more');
    more.type = 'button';
    more.disabled = pending === true;
    more.appendChild(dom.el('span', 'btn-label', label));
    dom.on(more, 'click', onClick);
    return more;
  }

  function link(label, onClick) {
    var node = dom.el('button', 'activity-link', label);
    node.type = 'button';
    dom.on(node, 'click', onClick);
    return node;
  }

  /* A proposal that executed is a new receipt, and the server says so with one
     transactions frame (src/http/sse.ts broadcastTransactions). Every mounted
     list re-reads its own window at its own depth. Only lists that have read
     once: a fold that was never opened does not start reading receipts
     because gas landed on an old row. */
  if (window.PhosphorEvents && typeof window.PhosphorEvents.on === 'function') {
    window.PhosphorEvents.on('transactions', function () {
      for (var i = 0; i < instances.length; i += 1) {
        if (instances[i].state !== 'idle') load(instances[i]);
      }
    });
  }

  window.PhosphorReceipts = {
    list: list,
    WINDOWS: WINDOWS,
    KINDS: KINDS
  };
})();
