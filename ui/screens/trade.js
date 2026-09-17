/* Trade: a strip, the chart, and one tabbed panel under it.

   THREE PANES, READ TOP TO BOTTOM. The strip is the market as an exchange
   header reads it: the coin with its logo (which is also the market picker),
   the venue, the mark price at 28 px that ticks in colour, the 24 hour change
   as plain coloured text, the day's high and low, and on the right the two
   figures a person checks before a plan (free, at risk).
   The chart takes the whole width under it. The deck under the chart is one
   panel with three tabs, Open, Waiting and Done, each with its count, instead
   of three columns of which two were usually empty. Karim, 2026-09-14: the
   price should "look like a price tag and not a balance", and "transactions
   should look like transactions too"; the direction of 2026-09-15 is
   Hyperliquid's own grammar for both. The class name trade-rail stays on the
   deck: the spotlight and the tests read it.

   PANES CAN BE HIDDEN. The chart and the deck each carry an eye-off control in
   their header, the bar's Layout menu (ui/screens/shell.js) lists every pane
   of the mode with a checkbox, and ui/split.js holds the state and reflows
   the grid.

   THE TAPE IS THE LAST 24 HOURS. Fills and ended plans newer than a day are
   listed; Show more reveals the next twenty older ones. A fill row opens the
   shared receipt card through the receipt:open event, and ends in the
   explorer link when the fill carries one.

   The two controls on the deck, Close and Cancel, are the only way a person
   reduces exposure from here. They confirm inline (the button becomes "Sure?"
   for four seconds) rather than through a dialog, and they post to the human
   door, /api/trade/action, which no agent tool opens onto.

   The chart engine is not rewritten here: its chrome takes the window's tokens
   and its canvas takes the window's palette. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;

  var refs = {};
  var mounted = false;
  var data = null;

  /* The seven overlays the server knows (src/trade/view.ts OVERLAYS), in the
     order the Layers popover lists them, each as a sentence case word. */
  var OVERLAYS = [
    { id: 'position', label: 'Position' },
    { id: 'liquidation', label: 'Liquidation' },
    { id: 'planStop', label: 'Plan stop' },
    { id: 'stops', label: 'Stops' },
    { id: 'targets', label: 'Targets' },
    { id: 'orders', label: 'Orders' },
    { id: 'fills', label: 'Fills' }
  ];

  /* The three tabs on the deck, in reading order. */
  var TABS = [
    { id: 'open', label: 'Open' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'done', label: 'Done' }
  ];

  /* How long a pressed Close or Cancel waits for its second press. */
  var CONFIRM_MS = 4000;
  /* How long a row that just appeared is marked as entering: the enter
     animation plus a beat, so a refresh landing mid-animation cannot cut it. */
  var ENTER_MS = 260;
  /* The tape's window, and how many older rows one press of Show more adds. */
  var DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
  var DONE_PAGE = 20;
  /* How often the day's candles behind the 24h figures are read again. */
  var RANGE_MS = 60 * 1000;

  function boot() {
    var host = document.getElementById('view-trade');
    if (!host) return;
    build(host);
    mounted = true;

    events.on('trade', function () { refresh(); });

    /* The chart engine's own boot wires listeners, starts a 5 s watchdog and a
       one second bar-close timer. None of that should run in a window whose
       owner never opens trade, so it starts the first time the view is on
       screen and never before. The day's candles are read on the same cue. */
    window.addEventListener('phosphor:view', function (event) {
      if (!event.detail || event.detail.view !== 'trade') return;
      startChart();
      refresh();
      loadRange();
    });
    if (window.PhosphorShell.view() === 'trade') {
      startChart();
      refresh();
      loadRange();
    }
    events.on('candles', function () {
      if (charted && typeof window.candlesPushed === 'function') window.candlesPushed();
    });
    events.on('candle', function (frame) {
      if (charted && typeof window.candleLive === 'function') window.candleLive(frame);
    });
    events.on('chart', function (frame) {
      // A comparison chart's frame is the mini renderer's (ui/chart/mini.js): the primary
      // used to refetch its whole payload on it, for a chart that had not changed.
      var slot = frame && typeof frame.slot === 'number' ? frame.slot : 0;
      if (slot === 0 && charted && typeof window.chartPushed === 'function') window.chartPushed(frame.rev);
    });
    /* The server asking for a picture. A window that has never shown the
       chart has nothing to picture, and the server's three second wait says so
       in the digest. */
    events.on('snapshot', function (frame) {
      if (charted && frame && typeof window.chartSnapshot === 'function') window.chartSnapshot(frame.slot, frame.reqId);
    });
  }

  var charted = false;

  function startChart() {
    if (charted) return;
    if (typeof window.chartBoot !== 'function') return;
    charted = true;
    window.chartBoot();
    /* The comparison charts boot beside the engine and probe their slots
       themselves; they subscribe to the chart frames on their own. */
    if (window.PhosphorMini) window.PhosphorMini.boot();
  }

  function build(host) {
    var wrap = dom.el('div', 'trade-wrap');
    wrap.dataset.split = 'trade';

    wrap.appendChild(buildStrip());

    var main = dom.el('div', 'trade-main');
    main.appendChild(buildBar());

    /* The stage. Every id the chart engine looks for lives here. The in-flight
       signal the old trade page never had is now the feed dot in the bar
       above, which the engine sets busy while a read is out. */
    var stage = dom.el('div', 'chart-stage');
    stage.id = 'panel-chart';
    stage.dataset.surface = 'chart';
    var chartwrap = dom.el('div', 'chartwrap');
    chartwrap.id = 'chartwrap';
    chartwrap.tabIndex = 0;
    chartwrap.setAttribute('role', 'img');
    chartwrap.setAttribute('aria-label',
      'price chart: drag to pan, wheel to zoom, arrow keys to move, 0 for live');
    var canvas = dom.el('canvas');
    canvas.id = 'chart';
    chartwrap.appendChild(canvas);
    /* A canvas, not a div: chart.js draws the last price tag, the crosshair and
       the legend onto it with its own 2d context. */
    var hud = dom.el('canvas');
    hud.id = 'chart-hud';
    chartwrap.appendChild(hud);
    stage.appendChild(chartwrap);
    main.appendChild(stage);

    /* The handle between the chart and the deck: a horizontal bar, dragged up
       and down. ui/split.js owns the drag and writes --deck on the wrap. */
    var resizer = dom.el('div', 'split-h');
    resizer.dataset.splitHandle = 'deck-rail';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'horizontal');
    resizer.setAttribute('aria-label', 'Resize the panel under the chart');
    resizer.tabIndex = 0;

    /* The deck keeps the class name trade-rail: the spotlight, the stylesheet
       and the tests all read it, and a rename would buy nothing they can see. */
    var deck = dom.el('div', 'trade-rail');
    /* The beam's surface for everything about positions and plans
       (ui/beam/trace.js routes trade, trade_read, propose_trade here). */
    deck.dataset.surface = 'position';
    deck.appendChild(buildTabs());

    var open = panel('open', 'Open');
    var waiting = panel('waiting', 'Waiting');
    var done = panel('done', 'Done');

    /* The column headings over the open positions and over the tape, hidden
       over an empty list: a heading over one sentence is a table with no
       rows. */
    var head = columnHead('pos-head', POSITION_COLUMNS);
    open.node.insertBefore(head, open.body);
    var tapeHead = columnHead('tape-head', TAPE_COLUMNS);
    done.node.insertBefore(tapeHead, done.body);

    /* The tape's foot sits under the list host, never in it: dom.reconcile
       owns the host and removes anything it did not place. */
    var foot = dom.el('div', 'trade-foot');
    var more = dom.el('button', 'btn btn-ghost btn-sm trade-more');
    more.type = 'button';
    more.appendChild(dom.el('span', 'btn-label', 'Show more'));
    dom.on(more, 'click', onMore);
    foot.appendChild(more);
    foot.hidden = true;
    done.node.appendChild(foot);

    deck.appendChild(open.node);
    deck.appendChild(waiting.node);
    deck.appendChild(done.node);

    wrap.appendChild(main);
    wrap.appendChild(resizer);
    wrap.appendChild(deck);
    host.appendChild(wrap);

    refs.wrap = wrap;
    refs.rail = deck;
    refs.openBody = open.body;
    refs.openHead = head;
    refs.waitingBody = waiting.body;
    refs.doneBody = done.body;
    refs.doneHead = tapeHead;
    refs.doneFoot = foot;
    refs.more = more;
    refs.panels = { open: open.node, waiting: waiting.node, done: done.node };

    refs.paintCuts = [cuts(open.body), cuts(waiting.body), cuts(done.body)];

    selectTab('open');

    if (typeof window.splitBoot === 'function') window.splitBoot();
  }

  /* ---------- the strip ----------

     One row, the way an exchange header reads: the market, the venue, the
     price, the day, then the account. Its height is its
     content plus its padding, never a number, and on a narrow world the groups
     wrap onto a second line rather than being squeezed (Karim, 2026-09-15:
     "the top looks super squished and squeezed"). Built once and filled every
     pass, so the price ticks in place and a figure that changes rolls rather
     than the strip being torn down for a number that moved. */
  function buildStrip() {
    var strip = dom.el('div', 'trade-strip');
    strip.setAttribute('role', 'region');
    strip.setAttribute('aria-label', 'Market');
    var row = dom.el('div', 'strip-row');
    strip.appendChild(row);

    row.appendChild(symbolControl());
    row.appendChild(venueChip());

    /* THE PRICE BLOCK. The venue's mark at 32 px mono, the cents one step
       quieter so the figure reads as a price and not as a run of characters
       (Karim, 2026-09-16: "that main price number should look like a price
       and not just a blob of text"), and the day's change on the line under
       it, the way an exchange header stacks them. On a tick the digits flip
       to the direction's colour and settle back to the text colour over
       600 ms, and never a background flash: the digits are the price, the box
       is not. data-tick is set on change and cleared when the animation ends. */
    var block = dom.el('div', 'strip-price');
    var px = dom.el('span', 'px trade-mark-price');
    px.setAttribute('title', 'Mark price');
    var whole = dom.el('span', 'px-whole');
    var cents = dom.el('span', 'px-cents');
    px.appendChild(whole);
    px.appendChild(cents);
    dom.on(px, 'animationend', function () { dom.setAttr(px, 'data-tick', null); });
    block.appendChild(px);
    var change = stripStat('24h', 'trade-change');
    block.appendChild(change.node);
    row.appendChild(block);

    /* The day's extremes, two figures with the label over the value. */
    var day = dom.el('div', 'strip-day');
    var high = stripStat('24h high', 'trade-high');
    var low = stripStat('24h low', 'trade-low');
    day.appendChild(high.node);
    day.appendChild(low.node);
    row.appendChild(day);

    /* The right half: the two figures, a cell of the row in its own right, so
       a narrow world can put them on the second line (trade.css). */
    var stats = dom.el('div', 'strip-stats');
    row.appendChild(stats);

    /* What the venue says when it has something to say: a notice on its own
       row under the strip, there only while there is something to say. The row
       never makes room for a sentence, and nothing is reserved for the notice
       either: the chart under it flexes when it appears. An icon for the kind
       of news, then the sentence, on a wash in the tone of the news. */
    var line = dom.el('p', 'trade-line');
    line.hidden = true;
    var text = dom.el('span', 'trade-line-text');
    line.appendChild(text);
    /* The venue's own words, under the sentence, for whoever has the
       developer switch on: the plain sentence is what a person reads, the raw
       error is jargon (Karim read it as scary debug output). Hidden until the
       switch is on (devmode.css), and hidden outright while there is none. */
    var raw = dom.el('span', 'trade-line-raw mono');
    raw.setAttribute('data-dev-only', '');
    raw.hidden = true;
    line.appendChild(raw);
    strip.appendChild(line);

    refs.strip = strip;
    refs.price = px;
    refs.priceWhole = whole;
    refs.priceCents = cents;
    refs.change = change.value;
    refs.high = high.value;
    refs.low = low.value;
    refs.statusLine = line;
    refs.statusText = text;
    refs.statusRaw = raw;
    refs.stats = stats;
    return strip;
  }

  /* A small figure on the strip: the label over the value, mono, tabular. */
  function stripStat(label, className) {
    var node = dom.el('div', 'strip-stat ' + className);
    node.appendChild(dom.el('span', 'strip-label', label));
    var value = dom.el('span', 'strip-value', '--');
    node.appendChild(value);
    return { node: node, value: value };
  }

  /* The venue: its mark and its name, and a dot for the account socket that
     serves the figures. The chart bar keeps its own dot for the bars' feed,
     because those are two sockets and they can differ. */
  function venueChip() {
    var chip = dom.el('span', 'trade-venue');
    chip.appendChild(logo('HYPE', 16));
    chip.appendChild(dom.el('span', 'trade-venue-name', 'Hyperliquid'));
    var dot = dom.el('i', 'trade-venue-dot');
    dot.setAttribute('aria-hidden', 'true');
    chip.appendChild(dot);
    refs.venue = chip;
    return chip;
  }

  /* ---------- the tabs ----------

     One row of three tabs with their counts in mono, the deck's eye-off control
     at its right end. The active tab is underlined in ink; arrow keys move
     between them, Home and End jump. */
  function buildTabs() {
    var row = dom.el('div', 'trade-tabs');
    var list = dom.el('div', 'trade-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Open, waiting and done');
    refs.tabs = {};
    refs.counts = {};
    for (var i = 0; i < TABS.length; i += 1) {
      var tab = dom.el('button', 'trade-tab');
      tab.type = 'button';
      tab.id = 'trade-tab-' + TABS[i].id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'trade-panel-' + TABS[i].id);
      tab.setAttribute('aria-selected', 'false');
      /* Not data-tab: the shell owns every [data-tab] in the document as a
         mode tab and would write aria-selected on these too. */
      tab.dataset.deckTab = TABS[i].id;
      tab.appendChild(dom.el('span', 'trade-tab-label', TABS[i].label));
      var count = dom.el('span', 'trade-tab-count mono', '0');
      tab.appendChild(count);
      dom.on(tab, 'click', onTab);
      dom.on(tab, 'keydown', onTabKey);
      list.appendChild(tab);
      refs.tabs[TABS[i].id] = tab;
      refs.counts[TABS[i].id] = count;
    }
    row.appendChild(list);
    /* The chart's way back sits here while the chart is hidden, then the
       deck's own eye-off. */
    var back = paneRestore('chart');
    if (back) row.appendChild(back);
    var hide = paneControl('deck');
    if (hide) row.appendChild(hide);
    return row;
  }

  function onTab(event) {
    selectTab(event.currentTarget.dataset.deckTab);
  }

  function onTabKey(event) {
    var at = tabIndex(event.currentTarget.dataset.deckTab);
    var next = at;
    if (event.key === 'ArrowRight') next = (at + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (at + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next].id);
    var tab = refs.tabs[TABS[next].id];
    if (tab && tab.focus) tab.focus();
  }

  function tabIndex(id) {
    for (var i = 0; i < TABS.length; i += 1) {
      if (TABS[i].id === id) return i;
    }
    return 0;
  }

  function selectTab(id) {
    if (!refs.tabs || !refs.tabs[id]) return;
    refs.tab = id;
    for (var i = 0; i < TABS.length; i += 1) {
      var on = TABS[i].id === id;
      var tab = refs.tabs[TABS[i].id];
      dom.setAttr(tab, 'aria-selected', on ? 'true' : 'false');
      dom.setAttr(tab, 'tabindex', on ? '0' : '-1');
      dom.setHidden(refs.panels[TABS[i].id], !on);
    }
    repaintCuts();
  }

  /* A panel is a tabpanel holding one list host that scrolls inside itself.
     The host belongs to the reconciler; a heading or a foot is a sibling. */
  function panel(id, title) {
    var node = dom.el('section', 'trade-panel trade-' + id);
    node.id = 'trade-panel-' + id;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', 'trade-tab-' + id);
    node.setAttribute('aria-label', title);
    node.hidden = true;
    var body = dom.el('div', 'trade-list scrolls');
    node.appendChild(body);
    return { node: node, body: body };
  }

  /* How many rows a tab holds, beside its word. A zero is written as a zero:
     the tab is a count, not an apology. */
  function setCount(id, n) {
    var node = refs.counts && refs.counts[id];
    if (!node) return;
    dom.setText(node, String(n));
    dom.setAttr(node, 'data-zero', n > 0 ? null : 'true');
  }

  /* A region that scrolls inside itself says where it was cut, so a fill sliced
     in half is drawn as a fill sliced in half rather than as the end of the
     tape, and a second plan under the fold is visibly under the fold. The same
     reading the dashboards use. */
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

  /* ---------- the bar above the chart ----------

     One row: a segmented control holding the eight timeframes, the indicator
     command, Layers, one status line on the right, and the chart pane's
     eye-off control at the end. The market moved up to the strip, where its
     logo is. Under 560 px the row wraps, on purpose. */
  function buildBar() {
    var bar = dom.el('div', 'chart-bar');

    /* The segment. ui/chart/chart.js writes button.timeframe[data-sec] into
       #timeframes and marks the current one .on, which is the contract the
       segment styles against. */
    var seg = dom.el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Timeframe');
    var timeframes = dom.el('div', 'seg-cells');
    timeframes.id = 'timeframes';
    seg.appendChild(timeframes);
    bar.appendChild(seg);

    var cmd = dom.el('input', 'input chart-cmd');
    cmd.id = 'chart-cmd';
    cmd.type = 'text';
    cmd.placeholder = 'Indicators';
    cmd.setAttribute('aria-label', 'What should the chart show');
    bar.appendChild(cmd);

    bar.appendChild(layersControl());

    /* The status cluster the chart engine drives: one dot that answers "is
       this price current", the state word the engine writes, and the venue's
       delay beside it, which the engine writes too, off the socket serving
       the bars. The engine also appends its two situational controls here
       (back to live, clear the agent's drawings). */
    var status = dom.el('span', 'chartstatus');
    status.id = 'chart-status';
    var feed = dom.el('span', 'feed');
    feed.id = 'chart-feed';
    feed.dataset.feed = 'offline';
    feed.setAttribute('role', 'status');
    feed.appendChild(dom.el('i'));
    feed.appendChild(dom.el('b', '', 'offline'));
    var latency = dom.el('span', 'feed-ms');
    latency.id = 'chart-latency';
    feed.appendChild(latency);
    status.appendChild(feed);
    bar.appendChild(status);

    /* The deck's way back sits here while the deck is hidden, then the
       chart's own eye-off. */
    var back = paneRestore('deck');
    if (back) bar.appendChild(back);
    var hide = paneControl('chart');
    if (hide) bar.appendChild(hide);
    return bar;
  }

  /* ---------- popovers ----------

     Layers on the chart bar and the market list are the same control: a
     button that opens a small raised sheet under itself, closed by Escape, by
     a click anywhere else, or by its own button. A click outside is found by
     a walk rather than through contains(), because the unit harness's
     stand-in nodes have neither. The bar's Layout menu (shell.js) opens the
     same way. */
  function popover(wrap, button, pop, onOpen) {
    function open() {
      if (onOpen) onOpen();
      dom.setAttr(pop, 'data-open', 'true');
      dom.setAttr(button, 'aria-expanded', 'true');
      var first = firstRow(pop);
      if (first && first.focus) first.focus();
    }
    function close() {
      dom.setAttr(pop, 'data-open', null);
      dom.setAttr(button, 'aria-expanded', 'false');
      if (button.focus) button.focus();
    }
    dom.on(button, 'click', function () {
      if (pop.dataset.open === 'true') close();
      else open();
    });
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || pop.dataset.open !== 'true') return;
      event.preventDefault();
      close();
    });
    dom.on(document, 'click', function (event) {
      if (pop.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      close();
    });
    return { open: open, close: close };
  }

  function firstRow(pop) {
    var rows = pop.children[0];
    return rows && rows.children ? rows.children[0] : null;
  }

  /* One check row: a drawn box and a word. aria-checked is the whole state. */
  function checkRow(label) {
    var row = dom.el('button', 'check-row layers-row');
    row.type = 'button';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', 'true');
    row.appendChild(dom.el('i', 'check layers-check'));
    row.appendChild(dom.el('span', '', label));
    return row;
  }

  function setChecked(row, on) {
    dom.setAttr(row, 'aria-checked', on ? 'true' : 'false');
  }

  /* ---------- Layers ----------

     The seven overlays and the volume pane as check rows in one popover, with
     the venue that is serving the candles as its foot. A popover rather than
     a row of chips, because eight chips is a toolbar and the bar has room for
     one word. */
  function layersControl() {
    var wrap = dom.el('div', 'layers-wrap');

    var button = dom.el('button', 'layers opens');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'chart-layers');
    button.appendChild(dom.el('span', '', 'Layers'));
    button.appendChild(icon('chevron-down', 'chev-icon'));

    var pop = dom.el('div', 'layers-pop pop');
    pop.id = 'chart-layers';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', 'What the chart draws');
    pop.tabIndex = -1;

    var rows = dom.el('div', 'layers-rows');
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var row = checkRow(OVERLAYS[i].label);
      row.dataset.overlay = OVERLAYS[i].id;
      dom.on(row, 'click', onOverlayRow);
      rows.appendChild(row);
    }
    var volume = checkRow('Volume');
    volume.dataset.layer = 'volume';
    dom.on(volume, 'click', onVolumeRow);
    rows.appendChild(volume);
    pop.appendChild(rows);

    /* The venue word. The engine writes what is actually serving the candles
       into #chart-provider, the same id the old cycling button had. */
    var foot = dom.el('div', 'layers-foot');
    foot.appendChild(dom.el('span', 'layers-foot-label', 'Venue'));
    var venue = dom.el('span', 'venue');
    venue.id = 'chart-provider';
    venue.textContent = '--';
    foot.appendChild(venue);
    pop.appendChild(foot);

    wrap.appendChild(button);
    wrap.appendChild(pop);

    refs.layersButton = button;
    refs.layersPop = pop;
    refs.layerRows = rows;
    refs.volumeRow = volume;
    refs.layers = popover(wrap, button, pop, renderOverlays);
    return wrap;
  }

  /* The eye-off control for a pane header, from ui/split.js so every header
     draws the same one. Null in a document with nothing to build it in. The
     way back is the bar's Layout menu (ui/screens/shell.js). */
  function paneRestore(name) {
    var split = window.PhosphorSplit;
    return split && typeof split.paneRestore === 'function' ? split.paneRestore(name) : null;
  }

  function paneControl(name) {
    return window.PhosphorSplit.paneControl(name);
  }

  /* ---------- the market ----------

     The strip's first cell: the coin's logo and its ticker, which opens a
     listbox of the markets the app charts. It was a native <select> once,
     which drew OS chrome, and then a cell in the bar's segment; the exchange
     header puts the coin first with its mark, so it lives on the strip now.

     It writes the focus to /api/trade, which sets the trading view's symbol AND
     the chart's product server side and broadcasts both, so one write moves the
     canvas and the deck together. Nothing here touches the chart engine. */
  function symbolControl() {
    var wrap = dom.el('div', 'trade-symbol-wrap');

    var button = dom.el('button', 'trade-symbol opens');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'trade-markets');
    button.setAttribute('aria-label', 'Which market');
    var mark = dom.el('span', 'trade-symbol-logo');
    button.appendChild(mark);
    var label = dom.el('span', 'trade-mark-coin', '--');
    button.appendChild(label);
    button.appendChild(icon('chevron-down', 'chev-icon'));

    var menu = dom.el('div', 'trade-menu pop');
    menu.id = 'trade-markets';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Which market');
    menu.tabIndex = -1;

    wrap.appendChild(button);
    wrap.appendChild(menu);

    dom.on(button, 'click', function () {
      if (menu.dataset.open === 'true') closeMenu();
      else openMenu();
    });
    dom.on(button, 'keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu();
    });
    dom.on(menu, 'keydown', onMenuKey);
    dom.on(menu, 'click', function (event) {
      var option = optionOf(event.target);
      if (option) pick(option.dataset.product);
    });
    dom.on(document, 'click', function (event) {
      if (menu.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      closeMenu();
    });

    refs.symbolButton = button;
    refs.symbolLogo = mark;
    refs.symbolLabel = label;
    refs.symbolMenu = menu;
    return wrap;
  }

  function within(node, root) {
    for (var at = node; at; at = at.parentNode) {
      if (at === root) return true;
    }
    return false;
  }

  function optionOf(node) {
    for (var at = node; at; at = at.parentNode) {
      if (at.dataset && at.dataset.product) return at;
    }
    return null;
  }

  var menuActive = '';

  function openMenu() {
    var menu = refs.symbolMenu;
    if (!menu || !products().length) return;
    menuActive = currentProduct();
    renderSymbol();
    dom.setAttr(menu, 'data-open', 'true');
    dom.setAttr(refs.symbolButton, 'aria-expanded', 'true');
    if (menu.focus) menu.focus();
  }

  function closeMenu() {
    var menu = refs.symbolMenu;
    if (!menu) return;
    dom.setAttr(menu, 'data-open', null);
    dom.setAttr(refs.symbolButton, 'aria-expanded', 'false');
    if (refs.symbolButton && refs.symbolButton.focus) refs.symbolButton.focus();
  }

  function onMenuKey(event) {
    var list = products();
    var at = list.indexOf(menuActive);
    if (event.key === 'Escape' || event.key === 'Tab') {
      closeMenu();
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(menuActive);
      return;
    }
    var next = at;
    if (event.key === 'ArrowDown') next = Math.min(list.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else return;
    event.preventDefault();
    menuActive = list[next] || menuActive;
    renderSymbol();
  }

  function pick(product) {
    if (!product) return;
    closeMenu();
    var coin = String(product).split('-')[0].toUpperCase();
    var was = data ? data.symbol : null;
    if (!data || coin === was) return;
    /* Optimistic, and rolled back if the write is refused, the same way the
       overlay toggles are: the strip is never in a state the payload disagrees
       with, and a refusal arrives as the answer to this click. */
    data.symbol = coin;
    render();
    loadRange();
    net.postJson('/api/trade', { focus: { symbol: coin } })
      .then(function () { return refresh(); })
      .catch(function (err) {
        data.symbol = was;
        render();
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err), 'down');
      });
  }

  function products() {
    return (data && Array.isArray(data.products)) ? data.products : [];
  }

  function currentProduct() {
    var symbol = symbolOf();
    var list = products();
    for (var i = 0; i < list.length; i += 1) {
      if (String(list[i]).split('-')[0].toUpperCase() === symbol) return list[i];
    }
    return symbol;
  }

  function symbolOf() {
    return (data && data.symbol) ? String(data.symbol).toUpperCase() : '';
  }

  function renderSymbol() {
    if (!refs.symbolLabel) return;
    var list = products();
    var current = currentProduct();
    var symbol = symbolOf();
    dom.setText(refs.symbolLabel, symbol || '--');
    setLogo(refs.symbolLogo, symbol, 20);
    dom.setAttr(refs.symbolButton, 'disabled', list.length ? null : true);
    dom.setAttr(refs.symbolMenu, 'aria-activedescendant', null);

    dom.reconcile(refs.symbolMenu, list, function (product) {
      return String(product);
    }, function (product) {
      var option = dom.el('div', 'trade-option');
      option.setAttribute('role', 'option');
      option.appendChild(logo(String(product).split('-')[0].toUpperCase(), 16));
      option.appendChild(dom.el('span', 'trade-option-name'));
      return option;
    }, function (option, product, i) {
      dom.setAttr(option, 'id', 'trade-market-' + i);
      option.dataset.product = product;
      dom.setText(option.children[1], product);
      dom.setAttr(option, 'aria-selected', product === current ? 'true' : 'false');
      dom.setAttr(option, 'data-active', product === menuActive ? 'true' : null);
      if (product === menuActive) dom.setAttr(refs.symbolMenu, 'aria-activedescendant', 'trade-market-' + i);
    });
  }

  /* The overlay set lives on the server and reaches the canvas through the
     /api/trade payload, which ui/chart/trade-overlay.js reads as data.overlays.
     The row flips at once and rolls back if the write is refused, so the
     control is never in a state the payload disagrees with. */
  function onOverlayRow(event) {
    var row = event.currentTarget;
    var on = row.getAttribute('aria-checked') !== 'true';
    setChecked(row, on);
    net.postJson('/api/trade', { overlay: { name: row.dataset.overlay, on: on } })
      .then(function () { return refresh(); })
      .catch(function (err) {
        setChecked(row, !on);
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err), 'down');
      });
  }

  /* The volume pane is built in this window and the server has never heard of
     it, so its row talks to the engine and nothing leaves the machine. */
  function onVolumeRow(event) {
    var row = event.currentTarget;
    var on = row.getAttribute('aria-checked') !== 'true';
    if (typeof window.chartSetVolume === 'function') window.chartSetVolume(on);
    setChecked(row, volumeOn(on));
  }

  function volumeOn(fallback) {
    if (typeof window.chartVolumeOn === 'function') return window.chartVolumeOn() !== false;
    return fallback !== false;
  }

  /* What the payload says is on, not what this window last pressed: an agent can
     move an overlay too, and the rows follow it. */
  function renderOverlays() {
    var overlays = data && data.overlays;
    if (refs.layerRows && overlays) {
      for (var i = 0; i < OVERLAYS.length; i += 1) {
        var row = refs.layerRows.children[i];
        if (row) setChecked(row, overlays[OVERLAYS[i].id] !== false);
      }
    }
    if (refs.volumeRow) setChecked(refs.volumeRow, volumeOn(true));
    if (typeof window.chartInvalidate === 'function') window.chartInvalidate();
  }

  /* ---------- data ---------- */

  function refresh() {
    if (!mounted) return;
    return api.trade()
      .then(function (result) {
        if (!result.fresh && data) return;
        data = result.data;
        /* The overlay projection reads this and nothing else, so it moves
           before the render that draws on top of it. */
        window.TRADE = data;
        render();
        ensureRange();
      })
      .catch(function (err) {
        console.error('[trade]', err);
      });
  }

  function render() {
    renderOverlays();
    renderSymbol();
    renderStrip();
    renderOpen();
    renderWaiting();
    renderDone();
    renderSpotlight();
    repaintCuts();
  }

  /* Where each list is cut, painted after every render and again once a row
     has finished entering: the enter rise is a transform, and a row still
     4 px below its place counts as overflow, so a list that fits exactly read
     as cut at the bottom and kept the fade after the row had settled. */
  function repaintCuts() {
    for (var i = 0; refs.paintCuts && i < refs.paintCuts.length; i += 1) refs.paintCuts[i]();
  }

  /* ---------- the day's candles ----------

     The trade payload carries no yesterday (a Market is { coin, markPx,
     fundingRateHourly, premiumPct, openInterestUsd, atr, maxLeverage } and
     nothing about the day), and the chart's own candles cover a day only at
     the wider timeframes. So the strip reads 25 hourly bars for the focused
     market from /api/candles, once a minute and on every market change: the
     close 24 bars back is the price a day ago, the high and low are over the
     24 bars since, and the change is the live mark against that close. */
  var range = { symbol: '', open: null, high: null, low: null };
  var rangeTimer = 0;
  var rangeSeq = 0;
  var rangeAsked = '';

  function onTrade() {
    return !!(window.PhosphorShell && typeof window.PhosphorShell.view === 'function' && window.PhosphorShell.view() === 'trade');
  }

  function loadRange() {
    if (!mounted || !net || typeof net.getJson !== 'function') return;
    var product = currentProduct();
    var symbol = symbolOf();
    if (!symbol || !product) return;
    var seq = ++rangeSeq;
    rangeAsked = symbol;
    net.getJson('/api/candles?product=' + encodeURIComponent(product) + '&granularity=3600&limit=25')
      .then(function (result) {
        if (seq !== rangeSeq) return;
        setRange(symbol, Array.isArray(result.data) ? result.data : []);
      })
      .catch(function () {
        if (seq !== rangeSeq) return;
        setRange(symbol, []);
      })
      .then(scheduleRange);
  }

  /* The first payload lands after boot, and a market change can land on a
     trade frame as well as on a pick, so every payload checks that the day
     on the strip is the day of the market on the strip. Only while the trade
     view is up: the deck refreshes on every trade frame whichever tab shows. */
  function ensureRange() {
    var symbol = symbolOf();
    if (!symbol || !onTrade()) return;
    if (range.symbol === symbol || rangeAsked === symbol) return;
    loadRange();
  }

  function scheduleRange() {
    window.clearTimeout(rangeTimer);
    if (!onTrade()) return;
    rangeTimer = window.setTimeout(loadRange, RANGE_MS);
  }

  function setRange(symbol, candles) {
    var day = candles.slice(-25);
    if (day.length < 2) {
      range = { symbol: symbol, open: null, high: null, low: null };
    } else {
      var since = day[0];
      var high = null;
      var low = null;
      for (var i = 1; i < day.length; i += 1) {
        if (typeof day[i].h === 'number' && (high === null || day[i].h > high)) high = day[i].h;
        if (typeof day[i].l === 'number' && (low === null || day[i].l < low)) low = day[i].l;
      }
      range = { symbol: symbol, open: typeof since.c === 'number' ? since.c : null, high: high, low: low };
    }
    renderDay();
  }

  /* ---------- the strip, filled ---------- */

  function renderStrip() {
    renderPrice();
    renderDay();
    renderVenue();

    var account = data && data.account;

    /* A venue that is not answering has not said the account is empty, it has
       said nothing, and those are different sentences. So the line says what
       is wrong in plain words, keeps the venue's own words behind the
       developer switch, and the figures under it read as unknown rather than
       as the empty state, which would be the window inventing a fact. A
       socket that is shut is red with the link struck through; a socket that
       is open and answering with an error is amber with a warning; a read
       skipped because there is no wallet yet is a quiet wait, keyed off the
       error's text until the feed carries it as a flag of its own. */
    if (venueDown()) {
      var raw = data.venue.error ? String(data.venue.error) : '';
      if (/no wallet/i.test(raw)) {
        statusLine('Nothing to read until a wallet exists.', null, 'waiting', raw);
      } else if (data.venue.connected === false) {
        statusLine('Not connected to Hyperliquid. Trying again.', 'down', 'link-off', raw);
      } else {
        statusLine('Hyperliquid is not answering one of our reads. Trying again.', 'warn', 'warning', raw);
      }
      renderFigures(account, true);
      return;
    }

    /* accountKnown is false until the feed has settled which kind of account
       this is, and every figure is null while it is. Waiting is not the same
       answer as empty, so it does not get the empty answer. */
    if (account && account.accountKnown === false) {
      statusLine('Still reading the account. The venue has not said what kind it is.', null, 'waiting');
      renderFigures(null, false);
      return;
    }
    if (!funded()) {
      statusLine('No trading money yet. Ask your assistant to fund it.', null, 'deposit');
      renderFigures(null, false);
      return;
    }

    statusLine('', null, null);
    renderFigures(account, false);
  }

  /* The notice under the row. `tone` is the wash behind it (warn, down, or
     none for a quiet wait), `iconName` the drawn icon ahead of the sentence,
     `raw` the venue's own words for the developer switch. The icon is swapped
     only when its name changes, so a line that is repainted every tick keeps
     its node. Empty text takes the row away. */
  function statusLine(text, tone, iconName, raw) {
    var line = refs.statusLine;
    var name = text ? iconName : null;
    if ((line.dataset.icon || null) !== name) {
      var old = line.firstChild;
      if (old && old !== refs.statusText) line.removeChild(old);
      if (name) line.insertBefore(icon(name, 'icon-16 trade-line-icon'), refs.statusText);
      dom.setAttr(line, 'data-icon', name);
    }
    var words = text && raw ? String(raw) : '';
    dom.setAttr(line, 'data-tone', text ? tone : null);
    dom.setText(refs.statusText, text);
    dom.setText(refs.statusRaw, words);
    dom.setHidden(refs.statusRaw, !words);
    dom.setAttr(line, 'title', text || null);
    dom.setHidden(line, !text);
  }

  /* THE PRICE. Set as text, not rolled: an exchange header does not roll its
     digits, it recolours them. The tick attribute is set on a change and
     cleared by the animation's end; the same direction twice inside 600 ms
     restarts it, which is what the reflow between the two writes is for.
     Reduced motion skips the tick altogether. */
  var lastPx = {};

  function renderPrice() {
    var symbol = symbolOf();
    var mark = markOf();
    setPrice(priceText(mark));
    if (typeof mark !== 'number' || !isFinite(mark) || !symbol) return;

    var was = lastPx[symbol];
    lastPx[symbol] = mark;
    if (typeof was !== 'number' || was === mark) return;
    if (window.PhosphorMotion.reduced()) return;
    dom.setAttr(refs.price, 'data-tick', null);
    void refs.price.offsetWidth;
    dom.setAttr(refs.price, 'data-tick', mark > was ? 'up' : 'down');
  }

  /* The day. The change is the mark against the close a day ago, as
     "-2,188.00 / -2.78%" in the direction's colour and nothing else: no chip,
     no wash. High and low are the day's extremes. All three read -- until the
     candles for this market have landed. */
  function renderDay() {
    var symbol = symbolOf();
    var mark = markOf();
    var have = range.symbol === symbol && typeof range.open === 'number' && range.open > 0
      && typeof mark === 'number' && isFinite(mark);
    if (!have) {
      dom.setText(refs.change, '--');
      dom.setAttr(refs.change, 'data-dir', null);
      dom.setText(refs.high, range.symbol === symbol ? priceText(range.high) : '--');
      dom.setText(refs.low, range.symbol === symbol ? priceText(range.low) : '--');
      return;
    }
    var delta = mark - range.open;
    var pct = (delta / range.open) * 100;
    var dir = Math.abs(delta) < 1e-9 ? null : (delta > 0 ? 'up' : 'down');
    dom.setText(refs.change, signedPlain(delta, decimalsOf(mark)) + ' / ' + (pct > 0 ? '+' : pct < 0 ? '-' : '') + Math.abs(pct).toFixed(2) + '%');
    dom.setAttr(refs.change, 'data-dir', dir);
    dom.setText(refs.high, priceText(range.high));
    dom.setText(refs.low, priceText(range.low));
  }

  /* The figure in two spans: everything up to the point, then the point and
     the places after it, which the stylesheet sets one step quieter. "--"
     and a price with no point go whole. */
  function setPrice(text) {
    var at = text.lastIndexOf('.');
    if (at < 1 || !/^\$?[\d,]+\.\d+$/.test(text)) {
      dom.setText(refs.priceWhole, text);
      dom.setText(refs.priceCents, '');
      return;
    }
    dom.setText(refs.priceWhole, text.slice(0, at));
    dom.setText(refs.priceCents, text.slice(at));
  }

  /* A signed number in the price's own places, without the currency sign:
     the sign is the news, the unit is the price beside it. */
  function signedPlain(value, decimals) {
    var abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (value > 0 ? '+' : value < 0 ? '-' : '') + abs;
  }

  function decimalsOf(price) {
    var abs = Math.abs(price);
    if (abs >= 1) return 2;
    return abs >= 0.01 ? 4 : 6;
  }

  /* The venue dot: the account socket's state, which the payload names. */
  function renderVenue() {
    var venue = data && data.venue;
    var state = !venue ? null : (venue.connected === false || venue.error ? 'down' : (venue.degraded ? 'delayed' : 'live'));
    dom.setAttr(refs.venue, 'data-feed', state);
    dom.setAttr(refs.venue, 'title', state === 'live' ? 'Account feed live'
      : state === 'delayed' ? 'Account feed delayed' : state === 'down' ? 'Account feed down' : null);
  }

  /* THE FIGURES, right-aligned: the label above, the number under it.
     `unknown` draws Free whatever the payload holds, because a missing
     figure and a figure reading -- say different things and only the second
     one is true when the venue has gone quiet. At risk is the app's own sum
     over its own plans, so it stays a number either way. Reconciled by key so
     a figure that changes rolls its digits and one that goes is removed. */
  function renderFigures(account, unknown) {
    var free = account && typeof account.freeUsd === 'number' ? account.freeUsd : null;
    var atRisk = account && typeof account.atRiskUsd === 'number' ? account.atRiskUsd : 0;

    var items = [];
    if (account || unknown) {
      if (free !== null || unknown) items.push({ key: 'free', label: 'Free', value: free !== null ? dom.usd(free) : '--', dim: free === null });
      items.push({ key: 'risk', label: 'At risk', value: dom.usd(atRisk), dim: false });
    }

    dom.reconcile(refs.stats, items, function (item) {
      return item.key;
    }, function () {
      var stat = dom.el('div', 'strip-stat');
      stat.appendChild(dom.el('span', 'strip-label'));
      stat.appendChild(dom.el('span', 'strip-value mono'));
      return stat;
    }, function (stat, item) {
      dom.setText(stat.children[0], item.label);
      stat.children[1].className = 'strip-value mono' + (item.dim ? ' dim' : '');
      dom.setNumber(stat.children[1], item.value);
    });
    dom.setHidden(refs.stats, items.length === 0);
  }

  /* ---------- Open ----------

     One line per position, under column headings: the coin with its logo and
     side, then size, entry, mark, profit, and the distance to the stop and
     the target as signed percentages of the mark. The exits come from the
     open plan on that coin, or from the working triggers when no plan of this
     app's is behind the position. Close posts the plan's id, so a position
     with no plan has no button: there is no door for it.

     Every name below is the payload's: a Position is
     { coin, side, sizeCoin, notionalUsd, entryPx, markPx, liqPx, unrealisedUsd,
       ... }. */
  var POSITION_COLUMNS = ['Asset', 'Size', 'Entry', 'Mark', 'PnL', 'Stop', 'Target'];
  var TAPE_COLUMNS = ['Time', 'Side', 'Asset', 'Size', 'Value'];

  /* A row of column headings in 11/500 muted, on the same grid as the rows
     under it. Hidden until the list has rows. */
  function columnHead(className, columns) {
    var head = dom.el('div', className);
    head.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < columns.length; i += 1) {
      head.appendChild(dom.el('span', 'pos-col', columns[i]));
    }
    head.hidden = true;
    return head;
  }

  function renderOpen() {
    var host = refs.openBody;
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    setCount('open', positions.length);
    dom.setHidden(refs.openHead, !positions.length);
    if (!positions.length) {
      dom.clear(host);
      host.appendChild(empty('Nothing open.'));
      return;
    }
    dom.reconcile(host, positions, function (p) {
      return String(p.coin).toUpperCase();
    }, function (p) {
      var coin = String(p.coin).toUpperCase();
      var row = tradeRow('position', coin);
      row.className += ' pos-row';
      var asset = dom.el('div', 'pos-asset');
      asset.appendChild(logo(coin, 20));
      asset.appendChild(dom.el('span', 'pos-coin', coin));
      asset.appendChild(dom.el('span', 'trade-pill pos-side'));
      asset.appendChild(dom.el('span', 'pos-lev mono'));
      row.appendChild(asset);
      row.appendChild(dom.el('span', 'pos-size mono'));
      row.appendChild(dom.el('span', 'pos-entry mono'));
      row.appendChild(dom.el('span', 'pos-mark mono'));
      row.appendChild(dom.el('span', 'trade-pnl pos-pnl mono'));
      row.appendChild(dom.el('span', 'pos-stop mono'));
      row.appendChild(dom.el('span', 'pos-target mono'));
      row.appendChild(dom.el('div', 'trade-row-foot'));
      return row;
    }, function (row, p) {
      var coin = String(p.coin).toUpperCase();
      var asset = row.children[0];
      var short = p.side === 'short';
      dom.setText(asset.children[2], short ? 'Short' : 'Long');
      dom.setAttr(asset.children[2], 'data-tone', short ? 'down' : 'up');
      dom.setText(asset.children[3], typeof p.leverage === 'number' ? p.leverage + 'x' : '');

      var mark = typeof p.markPx === 'number' ? p.markPx : markFor(coin);
      var exits = exitsOf(coin);
      dom.setText(row.children[1], typeof p.sizeCoin === 'number' ? dom.qty(p.sizeCoin, precisionOf(coin)) : '--');
      dom.setText(row.children[2], typeof p.entryPx === 'number' ? priceText(p.entryPx) : '--');
      dom.setText(row.children[3], typeof mark === 'number' ? priceText(mark) : '--');
      var pnl = row.children[4];
      var up = typeof p.unrealisedUsd === 'number' && p.unrealisedUsd >= 0;
      pnl.className = 'trade-pnl pos-pnl mono ' + (up ? 'up' : 'down');
      dom.setText(pnl, typeof p.unrealisedUsd === 'number' ? signedUsd(p.unrealisedUsd) : '--');
      dom.setText(row.children[5], distance(exits.stop, mark) || '--');
      dom.setText(row.children[6], distance(exits.target, mark) || '--');

      var foot = row.children[7];
      dom.clear(foot);
      if (exits.plan) foot.appendChild(actButton('Close', 'close', exits.plan.id));
    });
  }

  /* The stop and the target a position is protected by. The open plan on the
     coin first, since its numbers are the ones the person approved; failing
     that, the working triggers the venue holds. */
  function exitsOf(coin) {
    var plans = plansOf();
    for (var i = 0; i < plans.length; i += 1) {
      var plan = plans[i];
      if (plan.status !== 'open' || String(plan.symbol).toUpperCase() !== coin) continue;
      return {
        plan: plan,
        stop: typeof plan.stop === 'number' ? plan.stop : null,
        target: typeof plan.target === 'number' ? plan.target : null
      };
    }
    var out = { plan: null, stop: null, target: null };
    var orders = (data && Array.isArray(data.orders)) ? data.orders : [];
    for (var o = 0; o < orders.length; o += 1) {
      var order = orders[o];
      if (String(order.coin).toUpperCase() !== coin || order.kind !== 'trigger') continue;
      if (typeof order.triggerPx !== 'number') continue;
      if (order.role === 'stop' && out.stop === null) out.stop = order.triggerPx;
      if (order.role === 'target' && out.target === null) out.target = order.triggerPx;
    }
    return out;
  }

  /* Where a price sits against the mark, signed: under it reads negative,
     over it positive, whichever side the position is on. One decimal, and the
     sign is always written so a stop and a target cannot be told apart by
     magnitude alone. */
  function distance(price, mark) {
    if (typeof price !== 'number' || typeof mark !== 'number' || !isFinite(price) || !isFinite(mark) || mark <= 0) return '';
    var pct = ((price - mark) / mark) * 100;
    var rounded = Math.abs(pct) < 0.05 ? 0 : pct;
    return (rounded > 0 ? '+' : rounded < 0 ? '-' : '') + Math.abs(rounded).toFixed(1) + '%';
  }

  function signedUsd(value) {
    return (value > 0 ? '+' : '') + dom.usd(value);
  }

  /* ---------- Waiting ----------

     Every plan that is not open and not done: an idea the agent drew, a plan
     waiting on its conditions, a plan whose entry rests on the venue. One
     English line each, built from the plan's own fields, so the sentence on
     the deck is the sentence on the chart, with its state as a pill beside it:
     Idea, Armed (with the armed icon in ink), Placed, or the two waits on a
     person, Needs unlock and Feed stale, in the waiting colour. Under it the
     conditions as dots: filled when the watcher says it holds, hollow when it
     does not or when nothing is watching yet. Cancel is only offered where the
     host would take it, which is a waiting or a placed plan. */
  function renderWaiting() {
    var host = refs.waitingBody;
    var plans = plansOf().filter(function (p) {
      return p.status === 'idea' || p.status === 'waiting' || p.status === 'placed';
    });
    setCount('waiting', plans.length);
    if (!plans.length) {
      dom.clear(host);
      host.appendChild(empty('Nothing waiting.'));
      return;
    }
    dom.reconcile(host, plans, function (p) {
      return String(p.id);
    }, function (p) {
      var row = tradeRow('plan', String(p.id));
      row.className += ' plan-row';
      var head = dom.el('div', 'plan-head');
      head.appendChild(dom.el('p', 'trade-row-line'));
      head.appendChild(dom.el('span', 'trade-pill trade-row-state'));
      row.appendChild(head);
      row.appendChild(dom.el('ul', 'trade-conds'));
      row.appendChild(dom.el('div', 'trade-row-foot'));
      return row;
    }, function (row, p) {
      var head = row.children[0];
      dom.setText(head.children[0], planLine(p));
      paintState(head.children[1], planState(p));

      var conds = row.children[1];
      dom.clear(conds);
      var rows = conditionRows(p);
      for (var i = 0; i < rows.length; i += 1) {
        var item = dom.el('li', 'trade-cond');
        item.dataset.holds = rows[i].holds ? 'true' : 'false';
        item.appendChild(dom.el('i', 'trade-cond-dot'));
        item.appendChild(dom.el('span', '', rows[i].condition));
        conds.appendChild(item);
      }
      dom.setHidden(conds, rows.length === 0);

      var foot = row.children[2];
      dom.clear(foot);
      if (p.status === 'waiting' || p.status === 'placed') foot.appendChild(actButton('Cancel', 'cancel', String(p.id)));
    });
  }

  /* The state pill, rebuilt from its parts: the icon when the state has one,
     then the word. The classes carry the tone the tests and the stylesheet
     read. */
  function paintState(pill, state) {
    dom.clear(pill);
    pill.className = 'trade-pill trade-row-state' + (state.warn ? ' warn' : '');
    dom.setAttr(pill, 'data-tone', state.tone || null);
    dom.setAttr(pill, 'title', state.title || null);
    if (state.icon) pill.appendChild(icon(state.icon, 'icon-14'));
    pill.appendChild(dom.el('span', '', state.text));
  }

  /* "Long ETH $200 at 3x, market, stop 3,180, target 3,420". The shape a
     person can check against the chart in one look. */
  function planLine(plan) {
    var side = plan.side === 'short' ? 'Short' : 'Long';
    var bits = [side + ' ' + String(plan.symbol || '').toUpperCase() + ' ' + dom.usd(plan.sizeUsd, 0) + ' at ' + plan.leverage + 'x'];
    bits.push(entryWord(plan.entry, plan.symbol));
    if (typeof plan.stop === 'number') bits.push('stop ' + planPx(plan.stop, plan.symbol));
    if (typeof plan.target === 'number') bits.push('target ' + planPx(plan.target, plan.symbol));
    return bits.join(', ');
  }

  function entryWord(entry, coin) {
    if (!entry || typeof entry !== 'object') return 'market';
    if (entry.type === 'limit') return 'limit ' + planPx(entry.px, coin);
    if (entry.type === 'stop') return 'stop entry ' + planPx(entry.px, coin);
    return 'market';
  }

  /* Every price in a plan's sentences, the same way: grouped thousands and at
     most the market's own places, which on Hyperliquid is six less the size
     places (BTC trades in tenths, ETH in cents). A market the payload does not
     list keeps the plan's own digits, grouped. */
  function planPx(value, coin) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    var sz = precisionOf(coin);
    var places = typeof sz === 'number' ? Math.max(0, Math.min(8, 6 - sz)) : 8;
    return value.toLocaleString('en-US', { maximumFractionDigits: places });
  }

  /* The conditions with what the watcher says about each. A waiting plan
     carries `holds` from the server, one per condition in the plan's own
     order (src/trade/watch.ts), so the sentence is written here from the
     condition and the server's answer sits beside it. An idea or a placed
     plan carries nothing, because nothing is watching it, so its conditions
     print the same way and all hollow. A payload with answers but no
     conditions to write them from keeps the server's own words. */
  function conditionRows(plan) {
    var when = Array.isArray(plan.when) ? plan.when : [];
    var holds = Array.isArray(plan.holds) ? plan.holds : null;
    if (holds && holds.length !== when.length) {
      return holds.map(function (h) {
        return { condition: String(h.condition || ''), holds: h.holds === true };
      });
    }
    return when.map(function (c, i) {
      return { condition: conditionText(c, plan.symbol), holds: !!(holds && holds[i] && holds[i].holds === true) };
    });
  }

  /* The same sentences src/trade/plan.ts renderCondition writes, so a plan
     reads the same before and after it is armed, with its prices in the
     format the rest of the line uses (planPx). */
  function conditionText(c, coin) {
    if (!c || typeof c !== 'object') return '';
    if (c.type === 'close') {
      var at = c.at && typeof c.at.px === 'number' ? planPx(c.at.px, coin) : 'line ' + String(c.at && c.at.line || '');
      if (c.wick === 'through') {
        var other = c.is === 'above' ? 'below' : 'above';
        return 'a ' + c.tf + ' bar wicks ' + other + ' ' + at + ' and closes back ' + c.is + ' it';
      }
      return 'a ' + c.tf + ' bar closes ' + c.is + ' ' + at;
    }
    if (c.type === 'volume') return 'volume on the ' + c.tf + ' is at least ' + String(c.atLeast) + 'x its 20-bar average';
    var parts = [];
    if (c.after !== undefined) parts.push('after ' + c.after);
    if (c.before !== undefined) parts.push('before ' + c.before);
    return parts.length ? parts.join(' and ') : 'any time';
  }

  /* The pill beside a plan. Amber is this window's colour for waiting on a
     person, and a locked plan is exactly that: it re-arms on the next unlock.
     A blind one is waiting on the feed, which is the same kind of wait. */
  function planState(plan) {
    if (plan.status === 'idea') return { text: 'Idea', tone: null, warn: false, title: 'Drawn, not armed' };
    if (plan.locked === true) return { text: 'Needs unlock', tone: 'warn', warn: true, title: 'Waiting: it re-arms on the next unlock' };
    if (plan.blind === true) return { text: 'Feed stale', tone: 'warn', warn: true, title: 'Waiting on the feed' };
    if (plan.status === 'placed') return { text: 'Placed', tone: 'ink', icon: 'armed', warn: false, title: 'The venue holds the entry' };
    return { text: 'Armed', tone: 'ink', icon: 'armed', warn: false, title: 'Watching its conditions' };
  }

  /* ---------- Done ----------

     The tape: fills and ended plans as dense rows, newest first, the last 24
     hours by default and twenty older ones per press of Show more. A fill row
     reads the way an exchange's own fills read: the clock, the side as a
     pill, the coin with its logo, the size, the value in the side's own colour
     (a buy green, a sell red, the same as its pill), and the explorer link at
     the end when the fill carries one. A fill row opens the shared receipt
     card. An ended plan keeps its sentence, takes a glyph instead of a logo,
     and shows what it closed for where the value would be, when the payload
     says. The list is reconciled by key and a row that is already on screen
     keeps its identity; the host belongs to the reconciler, so Show more sits
     under it, not in it. The tab's count is the day's rows, whatever Show
     more has revealed under them. */
  var doneExtra = 0;

  function renderDone() {
    var host = refs.doneBody;
    var rows = doneRows();
    var cut = doneWindow(rows);
    setCount('done', cut.day);
    dom.setHidden(refs.doneHead, !cut.list.length);
    dom.setHidden(refs.doneFoot, cut.more <= 0);
    dom.setAttr(refs.more, 'title', cut.more > 0 ? cut.more + ' older' : null);
    if (!cut.list.length) {
      dom.clear(host);
      host.appendChild(empty(rows.length ? 'Nothing in the last 24 hours.' : 'Nothing yet.'));
      return;
    }

    dom.reconcile(host, cut.list, function (row) {
      return row.key;
    }, function (row) {
      return row.fill ? fillRow(row) : endedRow(row);
    }, function (node, row) {
      node.dataset.spotKey = row.spotKey;
      if (row.fill) fillFill(node, row);
      else fillEnded(node, row);
    });
  }

  /* The window: everything newer than a day, plus what Show more has
     revealed. Rows arrive newest first, so the day is a prefix, and `day` is
     how many rows it holds. */
  function doneWindow(rows) {
    var since = Date.now() - DONE_WINDOW_MS;
    var inDay = 0;
    while (inDay < rows.length && timeOf(rows[inDay].at) >= since) inDay += 1;
    var shown = Math.min(rows.length, inDay + doneExtra);
    return { list: rows.slice(0, shown), more: rows.length - shown, day: inDay };
  }

  function onMore() {
    doneExtra += DONE_PAGE;
    renderDone();
    repaintCuts();
  }

  /* A fill row: a button in all but name, since the receipt card opens from
     it, with the explorer link as its own anchor at the end. Children in the
     order the stylesheet places them. */
  function fillRow(row) {
    var node = dom.el('div', 'done-row fill-row');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.appendChild(dom.el('span', 'tx-when meta mono'));
    node.appendChild(dom.el('span', 'trade-pill tx-side'));
    var asset = dom.el('span', 'tx-asset');
    asset.appendChild(logo(row.coin, 20));
    asset.appendChild(dom.el('span', 'tx-coin', row.coin));
    node.appendChild(asset);
    node.appendChild(dom.el('span', 'tx-size mono'));
    node.appendChild(dom.el('span', 'tx-amount mono'));
    node.appendChild(dom.el('span', 'tx-link'));
    dom.on(node, 'click', onFillRow);
    dom.on(node, 'keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onFillRow(event);
    });
    return node;
  }

  function fillFill(node, row) {
    node.__fill = row.fill;
    dom.setText(node.children[0], dom.clock(row.at));
    var side = node.children[1];
    dom.setText(side, row.sold ? 'Sell' : 'Buy');
    dom.setAttr(side, 'data-tone', row.sold ? 'down' : 'up');
    dom.setText(node.children[3], row.size);
    var amount = node.children[4];
    dom.setAttr(amount, 'data-dir', row.dir || null);
    dom.setNumber(amount, row.amount);
    dom.setAttr(node, 'title', row.sub || null);
    dom.setAttr(node, 'aria-label', (row.sold ? 'Sold ' : 'Bought ') + row.coin + ' ' + row.size + (row.sub ? ', ' + row.sub : '') + '. Open the receipt.');
    paintLink(node.children[5], row.url);
  }

  /* The explorer link, an anchor only when there is somewhere to go. It is
     the row's own link, so a click on it does not also open the receipt. */
  function paintLink(cell, url) {
    dom.clear(cell);
    if (!url) return;
    var link = dom.el('a', 'tx-open');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.setAttribute('aria-label', 'View on Hyperliquid');
    link.title = 'View on Hyperliquid';
    link.appendChild(icon('external', 'icon-14'));
    dom.on(link, 'click', function (event) { event.stopPropagation(); });
    dom.on(link, 'keydown', function (event) { event.stopPropagation(); });
    cell.appendChild(link);
  }

  /* An ended plan: the clock, the glyph, the sentence across the middle, and
     what it closed for where the value would be, signed and in the sign's
     colour, or nothing when the payload carries no figure. */
  function endedRow(row) {
    var node = dom.el('div', 'done-row ended-row');
    node.appendChild(dom.el('span', 'tx-when meta mono'));
    node.appendChild(endedMark(row.glyph));
    node.appendChild(dom.el('span', 'tx-title'));
    node.appendChild(dom.el('span', 'tx-amount mono'));
    return node;
  }

  function fillEnded(node, row) {
    dom.setText(node.children[0], row.at ? dom.clock(row.at) : '');
    dom.setText(node.children[2], row.text);
    dom.setAttr(node.children[2], 'title', row.title || null);
    var amount = node.children[3];
    dom.setAttr(amount, 'data-dir', row.dir || null);
    dom.setNumber(amount, row.amount);
  }

  /* A plan that ended: the done icon when it ended the way it was meant to,
     the refused icon when it was cancelled, expired or failed. */
  function endedMark(glyph) {
    var node = dom.el('span', 'tx-mark');
    node.setAttribute('aria-hidden', 'true');
    var svg = icon(glyph === 'cross' ? 'refused' : 'done', 'icon-14');
    if (svg) node.appendChild(svg);
    return node;
  }

  /* A row pressed: the fill it carries goes to the receipt card, mapped to
     the shape src/http/receipts.ts emits, and the card is the one the money
     screens open. The row is data; nothing here reads it back as markup. */
  function onFillRow(event) {
    var node = event.currentTarget;
    if (!node || !node.__fill) return;
    openReceipt(mapFill(node.__fill));
  }

  function openReceipt(receipt) {
    events.emit('receipt:open', { receipt: receipt, source: 'trade' });
  }

  /* A fill as a Receipt (src/http/receipts.ts) for the shared card: what left
     and what arrived, the venue fee, the venue's transaction when the fill
     carries one (feed-ws.ts keeps hash and url only when the venue stated real
     ones). A buy sends dollars out and brings the coin in; a sell the other
     way. `side` and `closed` let the card say Bought, Sold or Trade closed:
     a fill that realised a profit or a loss closed something. The venue
     writes a zero for an opening fill, so a close at exactly break even reads
     as an open, which is the one case the payload cannot tell apart. */
  function mapFill(fill) {
    var coin = String(fill.coin || '').toUpperCase();
    var sold = fill.side === 'sell' || fill.side === 'A';
    var px = typeof fill.px === 'number' ? fill.px : null;
    var size = typeof fill.sizeCoin === 'number' ? fill.sizeCoin : null;
    var notional = notionalOf(fill);
    /* The dollar leg to the cent: the card prints an amount in its coin's own
       places, and a notional of 91.6152 USDC is not a fact the venue stated. */
    var dollars = notional !== null ? Math.round(notional * 100) / 100 : null;
    var closed = typeof fill.closedPnlUsd === 'number' && fill.closedPnlUsd !== 0;
    var qty = size !== null ? dom.qty(size, precisionOf(coin)) : '';
    var at = fill.atMs ? new Date(fill.atMs).toISOString() : '';
    var summary = (sold ? 'Sold ' : 'Bought ') + qty + ' ' + coin
      + (px !== null ? ' at ' + priceText(px) : '') + ' on Hyperliquid'
      + (closed ? ', ' + signedUsd(fill.closedPnlUsd) + ' realised' : '')
      + (fill.liquidation ? ', a liquidation' : '') + '.';
    return {
      id: 'fill:' + String(fill.tid || fill.atMs || ''),
      kind: 'trade',
      side: sold ? 'sell' : 'buy',
      closed: closed,
      at: at,
      headline: (sold ? 'Sold ' : 'Bought ') + coin + ' ' + qty,
      summary: summary,
      fromChain: 'hyperliquid',
      toChain: 'hyperliquid',
      venue: 'Hyperliquid',
      amount: sold ? size : dollars,
      symbol: sold ? coin : 'USDC',
      received: sold
        ? (dollars !== null ? { symbol: 'USDC', amount: dollars } : null)
        : (size !== null ? { symbol: coin, amount: size } : null),
      valueUsd: notional,
      price: px,
      feesUsd: typeof fill.feeUsd === 'number' ? fill.feeUsd : null,
      txids: typeof fill.hash === 'string' && fill.hash
        ? [{ chain: 'hyperliquid', hash: fill.hash, url: typeof fill.url === 'string' ? fill.url : null }]
        : [],
      balanceBefore: null,
      balanceAfter: null,
      status: 'done'
    };
  }

  function notionalOf(fill) {
    if (typeof fill.notionalUsd === 'number') return fill.notionalUsd;
    var px = typeof fill.px === 'number' ? fill.px : null;
    return px !== null && typeof fill.sizeCoin === 'number' ? fill.sizeCoin * px : null;
  }

  function doneRows() {
    var out = [];
    var fills = (data && Array.isArray(data.fills)) ? data.fills : [];
    for (var i = 0; i < fills.length; i += 1) {
      var fill = fills[i];
      /* The field names are the payload's own: a Fill is
         { tid, coin, side, px, sizeCoin, notionalUsd, atMs, ... , hash, url },
         the last two only when the venue stated real ones. */
      var sold = fill.side === 'sell' || fill.side === 'A';
      var px = typeof fill.px === 'number' ? fill.px : null;
      var notional = notionalOf(fill);
      var coin = String(fill.coin || '').toUpperCase();
      out.push({
        key: 'fill:' + (fill.tid || fill.atMs || '') + ':' + i,
        spotKey: 'fill:' + String(fill.tid || ''),
        fill: fill,
        at: fill.atMs,
        coin: coin,
        sold: sold,
        size: dom.qty(fill.sizeCoin, precisionOf(coin)),
        amount: notional !== null ? dom.usd(notional) : '',
        dir: notional !== null ? (sold ? 'down' : 'up') : '',
        sub: px !== null ? 'at ' + priceText(px) + ', ' + dom.clock(fill.atMs) : '',
        url: fill.url || ''
      });
    }
    var plans = plansOf();
    for (var p = 0; p < plans.length; p += 1) {
      var plan = plans[p];
      if (plan.status !== 'done') continue;
      var ended = endedText(plan);
      /* What the plan closed for, when the payload says (closedPnlUsd, the
         fill's own field name). Nothing is printed for a plan without one. */
      var pnl = typeof plan.closedPnlUsd === 'number' && isFinite(plan.closedPnlUsd) ? plan.closedPnlUsd : null;
      out.push({
        key: 'plan:' + plan.id,
        spotKey: 'plan:' + plan.id,
        fill: null,
        at: Date.parse(plan.updatedAt || plan.createdAt || '') || 0,
        coin: '',
        glyph: ended.clean ? 'check' : 'cross',
        text: ended.text,
        title: ended.title,
        amount: pnl !== null ? signedUsd(pnl) : '',
        dir: pnl === null || pnl === 0 ? '' : (pnl > 0 ? 'up' : 'down')
      });
    }
    out.sort(function (a, b) { return timeOf(b.at) - timeOf(a.at); });
    return out;
  }

  function timeOf(at) {
    var n = typeof at === 'number' ? at : Date.parse(String(at || ''));
    return isFinite(n) ? n : 0;
  }

  /* Why a plan ended, as the verb a person would use. A failure carries its
     reason on the line, because "failed" alone is the one word here that
     leaves a person with a question. `clean` is whether the plan ran its
     course (its stop, its target, or a close) rather than being cut short,
     which is the difference between the check and the cross on its row. */
  function endedText(plan) {
    var reason = String(plan.endReason || '');
    var who = (plan.side === 'short' ? 'short ' : 'long ') + String(plan.symbol || '').toUpperCase();
    var verbs = { stopped: 'Stopped', targeted: 'Hit target', closed: 'Closed', cancelled: 'Cancelled', expired: 'Expired' };
    var clean = reason === 'stopped' || reason === 'targeted' || reason === 'closed';
    if (Object.prototype.hasOwnProperty.call(verbs, reason)) return { text: verbs[reason] + ' ' + who, title: '', clean: clean };
    if (reason.indexOf('failed:') === 0) {
      var why = reason.slice('failed:'.length).trim();
      return { text: 'Failed, ' + why, title: who + ': ' + why, clean: false };
    }
    return { text: 'Ended ' + who, title: reason, clean: false };
  }

  /* ---------- logos and icons ----------

     The real marks through ui/design/marks.js and the shared sprite through
     ui/design/icons.js. */
  function logo(coin, size) {
    return window.PhosphorMarks.logo(coin, size);
  }

  /* The logo inside a built control, replaced only when the coin changes. */
  function setLogo(slot, coin, size) {
    if (!slot) return;
    if (slot.dataset.coin === coin) return;
    slot.dataset.coin = coin;
    dom.clear(slot);
    if (coin) slot.appendChild(logo(coin, size));
  }

  function icon(name, className) {
    return window.PhosphorIcons.svg(name, className);
  }

  /* ---------- rows and the two controls ---------- */

  /* A row the agent can point at. The key is what a highlight names: the kind
     and the id, exactly as the payload carries them. A row that has just
     appeared enters; the mark comes off after the animation so a later pass
     can tell a new row from one that was already there. */
  function tradeRow(kind, id) {
    var row = dom.el('div', 'trade-row trade-enter');
    row.dataset.spotKey = kind + ':' + id;
    window.setTimeout(function () {
      row.classList.remove('trade-enter');
      repaintCuts();
    }, ENTER_MS);
    return row;
  }

  function empty(text) {
    return dom.el('p', 'trade-empty', text);
  }

  /* The inline confirm. One press arms the button, which says "Sure?" for
     four seconds; a second press in that window posts. The armed key lives
     here rather than on the node, because a trade frame can rebuild the row
     between the two presses and the person's first press must survive it. */
  var armed = null;
  var acts = {};

  function actButton(label, action, id) {
    var button = dom.el('button', 'btn btn-ghost trade-act');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    button.dataset.label = label;
    var key = action + ':' + id;
    acts[key] = button;
    paintAct(button);
    dom.on(button, 'click', onAct);
    return button;
  }

  function paintAct(button) {
    var key = button.dataset.action + ':' + button.dataset.id;
    var on = armed !== null && armed.key === key;
    dom.setText(button, on ? 'Sure?' : button.dataset.label);
    dom.setAttr(button, 'data-armed', on ? 'true' : null);
  }

  function disarm() {
    if (armed === null) return;
    window.clearTimeout(armed.timer);
    var was = armed;
    armed = null;
    if (acts[was.key]) paintAct(acts[was.key]);
  }

  function onAct(event) {
    var button = event.currentTarget;
    var key = button.dataset.action + ':' + button.dataset.id;
    if (armed !== null && armed.key === key) {
      disarm();
      send(button);
      return;
    }
    disarm();
    armed = { key: key, timer: window.setTimeout(disarm, CONFIRM_MS) };
    paintAct(button);
  }

  /* The post itself. The button says what it is doing while the venue answers,
     and a refusal arrives as the answer to this press, in the venue's words. */
  function send(button) {
    var action = button.dataset.action;
    var id = button.dataset.id;
    button.disabled = true;
    dom.setText(button, action === 'close' ? 'Closing' : 'Cancelling');
    api.tradeAction({ action: action, id: id })
      .then(function () { return refresh(); })
      .catch(function (err) {
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err), 'down');
      })
      .then(function () {
        button.disabled = false;
        paintAct(button);
      });
  }

  /* ---------- the spotlight ----------

     A highlight arrives on the trade payload: a kind, an id and a note. The
     window renders every one. The row it names gets an amber ring that pulses
     twice over 1.2 s, the rows beside it drop to 0.55 for the same 1.2 s, and
     the note sits under the row for as long as the server carries the
     highlight. The tab holding the row is brought up, so a pointer never
     lands behind a tab. An object on the canvas is lit through
     chartSpotActive, which the engine asks as it draws each label.

     A highlight pulses ONCE, when it arrives. The payload carries it on every
     frame until it expires, and a ring that fired on every frame would be a
     strobe on the one surface where the agent is trying to point at one thing.
     Reduced motion keeps the ring and the dim as plain changes of state and
     drops the pulse. */
  var SPOT_MS = 1200;
  var spotSeen = {};
  var spotActive = {};
  var spotTimer = 0;

  function spotKeyOf(h) {
    var id = String(h.id || '').trim();
    /* A position is named by its coin, and the row is keyed by the coin as the
       venue writes it. */
    if (h.kind === 'position') id = id.toUpperCase();
    return h.kind + ':' + id;
  }

  function renderSpotlight() {
    var list = (data && Array.isArray(data.highlights)) ? data.highlights : [];
    var live = {};
    var fresh = [];
    var keep = {};
    for (var i = 0; i < list.length; i += 1) {
      var h = list[i];
      if (!h || typeof h.kind !== 'string' || typeof h.id !== 'string') continue;
      var key = spotKeyOf(h);
      live[key] = h;
      /* The same row pointed at again is a new highlight (the server replaces
         the old one and stamps it), so the stamp is what has been seen. */
      var stamp = key + '@' + String(h.atMs !== undefined ? h.atMs : h.at || '');
      keep[stamp] = true;
      if (spotSeen[stamp]) continue;
      fresh.push(key);
    }
    /* Stamps that have expired are let go, so a window that stays open all
       day does not keep every pointer it ever saw. */
    spotSeen = keep;
    paintCallouts(live);
    if (fresh.length) spot(fresh);
  }

  /* Every row on the deck with the tab it sits under. */
  function spotRows() {
    var out = [];
    var bodies = [refs.openBody, refs.waitingBody, refs.doneBody];
    for (var b = 0; b < bodies.length; b += 1) {
      var kids = bodies[b] ? bodies[b].children : [];
      for (var k = 0; k < kids.length; k += 1) {
        if (kids[k].dataset && kids[k].dataset.spotKey) out.push(kids[k]);
      }
    }
    return out;
  }

  function tabOf(row) {
    for (var at = row; at; at = at.parentNode) {
      if (at === refs.openBody) return 'open';
      if (at === refs.waitingBody) return 'waiting';
      if (at === refs.doneBody) return 'done';
    }
    return '';
  }

  /* The note under the row, built with textContent: it is the agent's own
     sentence and it is data. Present while the highlight is live, gone with it. */
  function paintCallouts(live) {
    var rows = spotRows();
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var h = live[row.dataset.spotKey];
      var note = h && typeof h.note === 'string' ? h.note.trim() : '';
      var callout = calloutOf(row);
      if (!note) {
        if (callout) dom.setHidden(callout, true);
        continue;
      }
      if (!callout) {
        callout = dom.el('p', 'trade-callout');
        row.appendChild(callout);
      }
      dom.setText(callout, note);
      dom.setHidden(callout, false);
    }
  }

  function calloutOf(row) {
    var kids = row.children;
    for (var i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i].className === 'trade-callout') return kids[i];
    }
    return null;
  }

  function spot(keys) {
    var hit = {};
    for (var k = 0; k < keys.length; k += 1) {
      hit[keys[k]] = true;
      spotActive[keys[k]] = true;
    }
    var reduced = window.PhosphorMotion.reduced();
    var rows = spotRows();
    var lit = 0;
    var bring = '';
    for (var i = 0; i < rows.length; i += 1) {
      if (spotActive[rows[i].dataset.spotKey] === true) lit += 1;
      if (hit[rows[i].dataset.spotKey] && !bring) bring = tabOf(rows[i]);
    }
    if (bring) selectTab(bring);
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var on = spotActive[row.dataset.spotKey] === true;
      flag(row, 'spot', on);
      /* The rest of the deck steps back only when the pointer landed on the
         deck. A highlight on a chart level dims nothing here. */
      flag(row, 'dim', !on && lit > 0);
      if (hit[row.dataset.spotKey] && !reduced && typeof row.animate === 'function') pulse(row);
    }
    window.clearTimeout(spotTimer);
    spotTimer = window.setTimeout(unspot, SPOT_MS);
    if (typeof window.chartInvalidate === 'function') window.chartInvalidate(true);
  }

  function unspot() {
    spotActive = {};
    var rows = spotRows();
    for (var i = 0; i < rows.length; i += 1) {
      flag(rows[i], 'spot', false);
      flag(rows[i], 'dim', false);
    }
    if (typeof window.chartInvalidate === 'function') window.chartInvalidate(true);
  }

  function flag(row, name, on) {
    if (on) row.dataset[name] = 'true';
    else if (row.dataset[name] !== undefined) delete row.dataset[name];
  }

  /* Two rings over 1.2 s: on, off, on, off. Box shadow rather than outline,
     because it follows the row's radius, and WAAPI rather than a class so the
     pulse cannot be restarted by a repaint half way through. */
  function pulse(row) {
    var ring = '0 0 0 2px ' + warnColour();
    var none = '0 0 0 0 rgba(0, 0, 0, 0)';
    row.animate([
      { boxShadow: none, offset: 0 },
      { boxShadow: ring, offset: 0.2 },
      { boxShadow: none, offset: 0.5 },
      { boxShadow: ring, offset: 0.7 },
      { boxShadow: none, offset: 1 }
    ], { duration: SPOT_MS, easing: 'ease-out' });
  }

  /* The token, read off the document so a recoloured window rings in its own
     amber. The literal is the token's shipped value, for a document that
     cannot be asked. */
  function warnColour() {
    if (typeof window.getComputedStyle === 'function' && document.documentElement) {
      var value = window.getComputedStyle(document.documentElement).getPropertyValue('--warn');
      if (value && value.trim()) return value.trim();
    }
    return '#F5B942';
  }

  /* The canvas asks this as it draws each label. ui/chart/chart.js reads it
     through chartSpotOn and draws the same amber ring around the label. */
  window.chartSpotActive = function (kind, id) {
    return spotActive[spotKeyOf({ kind: kind, id: id })] === true;
  };

  /* ---------- what the deck reads ---------- */

  function plansOf() {
    return (data && Array.isArray(data.plans)) ? data.plans : [];
  }

  /* The mark for the market the surface is focused on. markets[] is the venue's
     own list and carries it whether or not anything is open; a position on the
     same market carries the identical number, and is the fallback for the frame
     before the market list has landed. */
  function markOf() {
    var symbol = symbolOf();
    if (!symbol) return null;
    return markFor(symbol);
  }

  function markFor(symbol) {
    var markets = (data && Array.isArray(data.markets)) ? data.markets : [];
    for (var i = 0; i < markets.length; i += 1) {
      if (String(markets[i].coin).toUpperCase() !== symbol) continue;
      return typeof markets[i].markPx === 'number' ? markets[i].markPx : null;
    }
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    for (var j = 0; j < positions.length; j += 1) {
      if (String(positions[j].coin).toUpperCase() !== symbol) continue;
      if (typeof positions[j].markPx === 'number') return positions[j].markPx;
    }
    return null;
  }

  /* Two places is right for a major and wrong for a coin that trades under a
     cent, and the biggest number on the surface is the one that must not read
     as $0.00. */
  function priceText(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '--';
    var abs = Math.abs(value);
    if (abs >= 1) return dom.usd(value);
    return dom.usd(value, abs >= 0.01 ? 4 : 6);
  }

  function venueDown() {
    var venue = data && data.venue;
    if (!venue) return false;
    return venue.connected === false || !!venue.error;
  }

  function funded() {
    var account = data && data.account;
    /* An account object with no numbers in it is the same thing to a person as
       no account at all, so it gets the same sentence rather than an empty
       strip that looks like a render that failed. */
    return !!(account && (typeof account.equityUsd === 'number'
      || typeof account.freeUsd === 'number'
      || typeof account.healthPct === 'number'));
  }

  /* How many places this asset actually trades in, off the venue's own metadata.
     Undefined when the market is not in the payload, which leaves dom.qty on its
     general rule; either way it never prints a real size as zero. */
  function precisionOf(coin) {
    var markets = (data && Array.isArray(data.markets)) ? data.markets : [];
    for (var i = 0; i < markets.length; i += 1) {
      if (String(markets[i].coin).toUpperCase() !== String(coin).toUpperCase()) continue;
      return typeof markets[i].szDecimals === 'number' ? markets[i].szDecimals : undefined;
    }
    return undefined;
  }

  window.PhosphorTrade = { boot: boot, refresh: refresh, mapFill: mapFill, selectTab: selectTab };
})();
