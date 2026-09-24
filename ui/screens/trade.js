/* Trade: the market, the chart, and one tabbed panel under it.

   It builds into #view-trade, under the money line of ui/screens/pro.js. Pro
   shows the same line over the tabbed panel alone, so the positions and
   orders are one element on both (ui/design/pro.css). The conversation stays
   on the left the whole time.

   THREE PANES, READ TOP TO BOTTOM. The market line is the coin with its logo
   (which is also the market picker), the price, the day's change as a signed
   figure and the day's high and low. The chart takes the whole width under
   it. The deck under the chart is one panel with three tabs, Positions,
   Orders and History, each with its count, and what the trading account
   holds at the tab row's right end. On Pro the same deck stands alone and
   the three panels stack in one scroll under their own heads. Karim,
   2026-09-14: the price should "look like a price tag and not a balance",
   and "transactions should look like transactions too". The class name
   trade-rail stays on the deck: the spotlight and the tests read it.

   A POSITION IS A SMALL CARD OF FIGURES, each with its own label, never a row
   under column heads: a heading far from its figure is a table a nervous
   person has to decode, and a table wider than its box scrolled sideways
   under a hidden scrollbar with Close past the window's edge. The card holds
   the coin and its side, the size, the profit, and entry, mark, liquidation,
   stop and target, each in words when there is none ("No stop").

   ONE COLOUR RULE. Green in this window is the mark, the live move and
   Approve, and red is a real loss: a position's side, a buy or a sell, the
   day's change and a price tick are words and signs, never a colour. A loss
   on a position or a plan is the one figure here that takes red.

   PANES CAN BE HIDDEN. The chart and the deck each carry an eye-off control in
   their header, the bar's Layout menu (ui/screens/shell.js) lists every pane
   of the mode with a checkbox, and ui/split.js holds the state.

   THE TAPE IS THE LAST 24 HOURS. Fills and ended plans newer than a day are
   listed; Show more reveals the next twenty older ones. A fill row opens the
   shared receipt card through the receipt:open event, and ends in the
   explorer link when the fill carries one.

   The two controls on the deck, Close and Cancel, are the only way a person
   reduces exposure from here. A press grows a confirm under its own card that
   says what will happen in figures, answered by two buttons with no timer,
   never a dialog; they post to the human door, /api/trade/action, which no
   agent tool opens onto.

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

  /* The one list writes every href in this window (core/links.js). */
  function setHref(anchor, url) {
    var links = window.PhosphorLinks;
    return !!links && typeof links.setHref === 'function' && links.setHref(anchor, url);
  }

  /* The overlays the server knows (src/trade/view.ts OVERLAYS), in the order
     the Layers popover lists them, each as a sentence case word. A plan's
     stop and the venue's stop orders are one idea to a person, so one row
     carries both ids and flips them together. */
  var OVERLAYS = [
    { id: 'position', ids: ['position'], label: 'Position' },
    { id: 'liquidation', ids: ['liquidation'], label: 'Liquidation' },
    { id: 'stops', ids: ['planStop', 'stops'], label: 'Stops' },
    { id: 'targets', ids: ['targets'], label: 'Targets' },
    { id: 'orders', ids: ['orders'], label: 'Orders' },
    { id: 'fills', ids: ['fills'], label: 'Fills' }
  ];

  /* The three tabs on the deck, in reading order, and the head each panel
     wears when Pro stacks them. The ids are the old words, kept because the
     spotlight and the tests key on them. */
  var TABS = [
    { id: 'open', label: 'Positions', head: 'Positions' },
    { id: 'waiting', label: 'Orders', head: 'Orders' },
    { id: 'done', label: 'History', head: 'Last 24 hours' }
  ];
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

    /* The stream says the trading view moved; the payload is read once per
       frame. This is what keeps positions and orders current on Pro and Trade. */
    events.on('trade', function () { refresh(); });

    /* The chart engine's own boot wires listeners, starts a 5 s watchdog and a
       one second bar-close timer. None of that should run in a window whose
       owner never opens Trade, so it starts the first time the chart is on
       screen and never before. The day's candles are read on the same cue.
       Pro shows the deck alone, so it only reads the payload. */
    window.addEventListener('phosphor:view', function (event) {
      var view = event.detail ? event.detail.view : null;
      if (view !== 'pro' && !isTradingView(view)) return;
      refresh();
      if (!isTradingView(view)) return;
      startChart();
      loadRange();
    });
    refresh();
    if (isTradingView(window.PhosphorShell.view())) {
      startChart();
      loadRange();
    }
    events.on('candles', function () {
      if (charted && typeof window.candlesPushed === 'function') window.candlesPushed();
    });
    events.on('candle', function (frame) {
      if (charted && typeof window.candleLive === 'function') window.candleLive(frame);
      onCandle(frame);
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

  /* The view that draws the market line and the chart. */
  function isTradingView(view) {
    return view === 'trade';
  }

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
    /* The surface that lights for everything about positions and plans. */
    deck.dataset.surface = 'position';
    deck.appendChild(buildTabs());

    /* The panels scroll inside one body on Pro and one at a time on Trade. */
    var panels = dom.el('div', 'trade-panels scrolls');
    var open = panel(TABS[0]);
    var waiting = panel(TABS[1]);
    var done = panel(TABS[2]);

    /* The tape keeps column headings, hidden over an empty list: its rows are
       one kind of line read down its columns. A heading over one sentence is
       a table with no rows. */
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

    panels.appendChild(open.node);
    panels.appendChild(waiting.node);
    panels.appendChild(done.node);
    deck.appendChild(panels);

    wrap.appendChild(main);
    wrap.appendChild(resizer);
    wrap.appendChild(deck);
    host.appendChild(wrap);

    refs.wrap = wrap;
    refs.rail = deck;
    refs.panelsBody = panels;
    refs.openBody = open.body;
    refs.waitingBody = waiting.body;
    refs.doneBody = done.body;
    refs.doneHead = tapeHead;
    refs.doneFoot = foot;
    refs.more = more;
    refs.panels = { open: open.node, waiting: waiting.node, done: done.node };
    refs.heads = { open: open.count, waiting: waiting.count, done: done.count };

    refs.paintCuts = [cuts(panels), cuts(open.body), cuts(waiting.body), cuts(done.body)];

    /* Escape inside an open confirm answers it the harmless way. */
    dom.on(deck, 'keydown', onDeckKey);

    selectTab('open');

    if (typeof window.splitBoot === 'function') window.splitBoot();
  }

  /* ---------- the strip ----------

     One row, the way an exchange header reads: the market with where it
     trades under it, the price with the day's change, and the day's high and
     low. The account is not here: what the trading account holds sits at the
     deck's tab row, and on Pro in its own header (ui/screens/pro.js). Its
     height is its content plus its padding, never a number, and on a narrow
     world the day's figures go before anything is squeezed (Karim,
     2026-09-15: "the top looks super squished and squeezed"). Built once and
     filled every pass, so the price changes in place rather than the strip
     being torn down for a number that moved. */
  function buildStrip() {
    var strip = dom.el('div', 'trade-strip');
    strip.setAttribute('role', 'region');
    strip.setAttribute('aria-label', 'Market');
    var row = dom.el('div', 'strip-row');
    strip.appendChild(row);

    row.appendChild(symbolControl());

    /* THE PRICE BLOCK. The chart's last trade (the tape, below), the cents
       one step quieter so the figure reads as a price and not as a run of
       characters (Karim, 2026-09-16: "that main price number should look like
       a price and not just a blob of text"), and the day's change beside it
       as a signed figure. The price changes in place and is never coloured:
       the digits are the news. */
    var block = dom.el('div', 'strip-price');
    var px = dom.el('span', 'px trade-mark-price');
    var whole = dom.el('span', 'px-whole');
    var cents = dom.el('span', 'px-cents');
    px.appendChild(whole);
    px.appendChild(cents);
    block.appendChild(px);
    var change = stripStat('in 24h', 'trade-change');
    block.appendChild(change.node);
    row.appendChild(block);

    /* The day's extremes, two figures with the label over the value. */
    var day = dom.el('div', 'strip-day');
    var high = stripStat('24h high', 'trade-high');
    var low = stripStat('24h low', 'trade-low');
    day.appendChild(high.node);
    day.appendChild(low.node);
    row.appendChild(day);

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
    return strip;
  }

  /* A small figure on the strip: the label over the value, tabular. */
  function stripStat(label, className) {
    var node = dom.el('div', 'strip-stat ' + className);
    node.appendChild(dom.el('span', 'strip-label', label));
    var value = dom.el('span', 'strip-value num', '--');
    node.appendChild(value);
    return { node: node, value: value };
  }

  /* ---------- the tabs ----------

     One row of three tabs with their counts, one underline that slides to the
     tab that is up, what the trading account holds at the right, and the
     deck's eye-off control at the end. Arrow keys move between the tabs, Home
     and End jump. A count of zero is not written: an empty tab says so when
     it is opened. */
  function buildTabs() {
    var row = dom.el('div', 'trade-tabs');
    var list = dom.el('div', 'trade-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Positions, orders and history');
    var indicator = dom.el('span', 'trade-tab-indicator');
    indicator.setAttribute('aria-hidden', 'true');
    list.appendChild(indicator);
    refs.tabIndicator = indicator;
    refs.tabList = list;
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
      var count = dom.el('span', 'trade-tab-count num', '0');
      count.dataset.zero = 'true';
      tab.appendChild(count);
      dom.on(tab, 'click', onTab);
      dom.on(tab, 'keydown', onTabKey);
      list.appendChild(tab);
      refs.tabs[TABS[i].id] = tab;
      refs.counts[TABS[i].id] = count;
    }
    row.appendChild(list);

    /* What the trading account holds, where a trade is decided: Trade has no
       money line of its own, so the one figure that says whether a trade fits
       (free) and the account it comes out of sit here. Pro draws the account
       in its own header and hides these. */
    var account = dom.el('dl', 'trade-account');
    account.setAttribute('aria-label', 'Your trading account');
    var total = accountStat('Trading money', 'trade-account-total');
    var free = accountStat('Free', 'trade-account-free');
    account.appendChild(total.node);
    account.appendChild(free.node);
    account.hidden = true;
    row.appendChild(account);
    refs.account = account;
    refs.accountTotal = total.value;
    refs.accountFree = free.value;

    /* The chart's way back sits here while the chart is hidden, then the
       deck's own eye-off. */
    var back = paneRestore('chart');
    if (back) row.appendChild(back);
    var hide = paneControl('deck');
    if (hide) row.appendChild(hide);

    if (window.ResizeObserver) new window.ResizeObserver(placeTabIndicator).observe(list);
    return row;
  }

  function accountStat(label, className) {
    var node = dom.el('div', 'trade-account-stat ' + className);
    node.appendChild(dom.el('dt', 'trade-account-label', label));
    var value = dom.el('dd', 'trade-account-value num tick');
    node.appendChild(value);
    return { node: node, value: value };
  }

  /* Only a funded account the venue has answered for: anything else is the
     money line's to say on Pro, and a figure nobody stated is never a zero. */
  function renderAccount() {
    if (!refs.account) return;
    var account = data && data.account ? data.account : null;
    var collateral = data && data.collateral ? data.collateral : null;
    var funded = !!(collateral && collateral.funded === true);
    var known = !!(account && account.accountKnown !== false && isNum(account.equityUsd));
    var show = funded && known && !venueDown();
    dom.setHidden(refs.account, !show);
    if (!show) return;
    dom.setNumber(refs.accountTotal, dom.usd(account.equityUsd));
    dom.setNumber(refs.accountFree, isNum(account.freeUsd) ? dom.usd(account.freeUsd) : '--');
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

  /* The panel that is up carries data-shown. Trade draws that one alone;
     Pro draws all three stacked, so the attribute is the tab's choice and the
     stylesheet is the view's. A switch fades the new panel in with a small
     rise while the underline slides to its tab, the grammar of the mode
     switch above. */
  function selectTab(id) {
    if (!refs.tabs || !refs.tabs[id]) return;
    var was = refs.tab;
    refs.tab = id;
    for (var i = 0; i < TABS.length; i += 1) {
      var on = TABS[i].id === id;
      var tab = refs.tabs[TABS[i].id];
      dom.setAttr(tab, 'aria-selected', on ? 'true' : 'false');
      dom.setAttr(tab, 'tabindex', on ? '0' : '-1');
      dom.setAttr(refs.panels[TABS[i].id], 'data-shown', on ? 'true' : null);
    }
    placeTabIndicator();
    if (was && was !== id) riseIn(refs.panels[id]);
    repaintCuts();
  }

  function placeTabIndicator() {
    var tab = refs.tabs && refs.tab ? refs.tabs[refs.tab] : null;
    var bar = refs.tabIndicator;
    if (!tab || !bar || !bar.style || typeof bar.style.setProperty !== 'function') return;
    if (typeof tab.offsetWidth !== 'number') return;
    bar.style.setProperty('--tab-x', tab.offsetLeft + 'px');
    bar.style.setProperty('--tab-w', tab.offsetWidth + 'px');
    dom.setAttr(bar, 'data-placed', tab.offsetWidth > 0 ? 'true' : null);
  }

  /* The new panel comes up over the view's time from four pixels below. Not
     on Pro, where every panel is already on screen, and never under reduced
     motion. */
  function riseIn(node) {
    if (!node || typeof node.animate !== 'function' || isProView()) return;
    if (window.PhosphorMotion && window.PhosphorMotion.reduced()) return;
    node.animate([
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'none' }
    ], { duration: 200, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' });
  }

  function isProView() {
    return !!(window.PhosphorShell && typeof window.PhosphorShell.view === 'function' && window.PhosphorShell.view() === 'pro');
  }

  /* A panel is a tabpanel holding one list host. The head is what Pro shows
     over it; Trade names the panel with its tab. The host belongs to the
     reconciler; a heading or a foot is a sibling. */
  function panel(tab) {
    var node = dom.el('section', 'trade-panel trade-' + tab.id);
    node.id = 'trade-panel-' + tab.id;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', 'trade-tab-' + tab.id);
    var head = dom.el('div', 'trade-panel-head');
    head.appendChild(dom.el('h3', 'trade-panel-title', tab.head));
    var count = dom.el('span', 'trade-panel-count num');
    count.dataset.zero = 'true';
    head.appendChild(count);
    node.appendChild(head);
    var body = dom.el('div', 'trade-list scrolls');
    node.appendChild(body);
    return { node: node, body: body, count: count };
  }

  /* How many rows a tab holds, beside its word, and beside the panel's head
     on Pro. A zero is not drawn: the panel says so in its own line. */
  function setCount(id, n) {
    var nodes = [refs.counts && refs.counts[id], refs.heads && refs.heads[id]];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!nodes[i]) continue;
      dom.setText(nodes[i], String(n));
      dom.setAttr(nodes[i], 'data-zero', n > 0 ? null : 'true');
    }
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

     One row: a segmented control holding the timeframes as equal cells (the
     six everyday ones, and a More cell for the rest when the chart is
     narrow), the indicator field behind a search glyph, Layers, one status
     group on the right, and the two eyes past a hairline at the end. The
     market moved up to the strip, where its logo is. */
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

    bar.appendChild(indicatorControl());

    bar.appendChild(layersControl());

    /* The status group the chart engine drives: the words that answer "is
       this price current", which the engine writes ("Live", or what a slow or
       a paused feed means for the price). The dot and the latency slot are
       still built for the engine to write into and are never drawn. The
       engine also appends its two situational controls here (back to live,
       clear the agent's drawings), drawn as quiet buttons at the bar's
       control height. */
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

    /* The eyes, as one group past a hairline: the deck's way back while the
       deck is hidden, then the chart's own eye-off. */
    var eyes = dom.el('div', 'chart-bar-eyes');
    var back = paneRestore('deck');
    if (back) eyes.appendChild(back);
    var hide = paneControl('chart');
    if (hide) eyes.appendChild(hide);
    bar.appendChild(eyes);
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
    function close(returnFocus) {
      dom.setAttr(pop, 'data-open', null);
      dom.setAttr(button, 'aria-expanded', 'false');
      if (returnFocus !== false && button.focus) button.focus();
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
      close(focusStayed(wrap));
    });
    return { open: open, close: close };
  }

  function firstRow(pop) {
    var rows = pop.children[0];
    return rows && rows.children ? rows.children[0] : null;
  }

  /* One check row: a drawn box with the icon family's tick in it, and a
     word. aria-checked is the whole state. */
  function checkRow(label) {
    var row = dom.el('button', 'check-row layers-row');
    row.type = 'button';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', 'true');
    var box = dom.el('i', 'check layers-check');
    var tick = icon('check', 'layers-tick');
    if (tick) box.appendChild(tick);
    row.appendChild(box);
    row.appendChild(dom.el('span', '', label));
    return row;
  }

  /* ---------- the indicator field ----------

     A field that lists what it can add. Focused, it opens the twelve
     indicators by their plain names under it; typing narrows the list; a
     click or Enter adds one to the chart. Typed words still work the way the
     assistant writes them ("ema 50", "bbands 20 2.5", "clear"), and a word it
     does not know stays in the field with one line saying so, rather than
     vanishing. The engine parses and pushes (window.chartCommand). */
  var INDICATORS = [
    { type: 'sma', name: 'Simple moving average', short: 'SMA' },
    { type: 'ema', name: 'Exponential moving average', short: 'EMA' },
    { type: 'wma', name: 'Weighted moving average', short: 'WMA' },
    { type: 'vwap', name: 'Volume-weighted average price', short: 'VWAP' },
    { type: 'bbands', name: 'Bollinger Bands', short: 'BB' },
    { type: 'donchian', name: 'Donchian channel', short: 'DC' },
    { type: 'volume', name: 'Volume with its average', short: 'VOL' },
    { type: 'rsi', name: 'Relative strength index', short: 'RSI' },
    { type: 'macd', name: 'MACD', short: 'MACD' },
    { type: 'atr', name: 'Average true range', short: 'ATR' },
    { type: 'stoch', name: 'Stochastic', short: 'STOCH' },
    { type: 'obv', name: 'On-balance volume', short: 'OBV' }
  ];

  var cmdState = { list: [], active: -1 };

  function indicatorControl() {
    var wrap = dom.el('div', 'chart-cmd-wrap');
    wrap.appendChild(icon('search', 'chart-cmd-icon'));
    var cmd = dom.el('input', 'input chart-cmd');
    cmd.id = 'chart-cmd';
    cmd.type = 'text';
    cmd.placeholder = 'Add indicator';
    cmd.autocomplete = 'off';
    cmd.spellcheck = false;
    cmd.setAttribute('aria-label', 'Add an indicator to the chart');
    cmd.setAttribute('role', 'combobox');
    cmd.setAttribute('aria-autocomplete', 'list');
    cmd.setAttribute('aria-expanded', 'false');
    cmd.setAttribute('aria-controls', 'chart-cmd-menu');
    wrap.appendChild(cmd);

    var menu = dom.el('div', 'cmd-menu pop');
    menu.id = 'chart-cmd-menu';
    var list = dom.el('div', 'cmd-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Indicators');
    menu.appendChild(list);
    var none = dom.el('p', 'cmd-none');
    none.setAttribute('role', 'status');
    none.hidden = true;
    menu.appendChild(none);
    menu.appendChild(dom.el('p', 'cmd-hint', 'Add a length after the name, like ema 50.'));
    wrap.appendChild(menu);

    refs.cmd = cmd;
    refs.cmdMenu = menu;
    refs.cmdList = list;
    refs.cmdNone = none;

    dom.on(cmd, 'focus', function () { openCmd(); });
    dom.on(cmd, 'input', function () { openCmd(); });
    dom.on(cmd, 'keydown', onCmdKey);
    dom.on(cmd, 'blur', function () { closeCmd(); });
    /* mousedown, not click: the field keeps its focus, so its blur does not
       close the list under the pointer before the click lands. */
    dom.on(list, 'mousedown', function (event) {
      var item = cmdItemOf(event.target);
      if (!item) return;
      event.preventDefault();
      addIndicator(INDICATORS[Number(item.dataset.index)].type);
    });
    return wrap;
  }

  function cmdItemOf(node) {
    for (var at = node; at; at = at.parentNode) {
      if (at.dataset && at.dataset.index !== undefined) return at;
    }
    return null;
  }

  function cmdQuery() {
    return String(refs.cmd.value || '').trim().toLowerCase();
  }

  /* What the typed words match: the first word against the short form, the
     type and the plain name, so "rs", "moving" and "boll" all find theirs. */
  function cmdMatches(query) {
    var word = query.split(/\s+/)[0] || '';
    var out = [];
    for (var i = 0; i < INDICATORS.length; i += 1) {
      var it = INDICATORS[i];
      if (!word || it.type.indexOf(word) === 0 || it.short.toLowerCase().indexOf(word) === 0
        || it.name.toLowerCase().indexOf(word) >= 0) out.push(i);
    }
    return out;
  }

  function openCmd() {
    var query = cmdQuery();
    cmdState.list = cmdMatches(query);
    if (cmdState.active >= cmdState.list.length) cmdState.active = cmdState.list.length - 1;
    if (query && cmdState.list.length && cmdState.active < 0) cmdState.active = 0;
    if (!query) cmdState.active = -1;
    paintCmd(query);
    dom.setAttr(refs.cmdMenu, 'data-open', 'true');
    dom.setAttr(refs.cmd, 'aria-expanded', 'true');
  }

  function closeCmd() {
    dom.setAttr(refs.cmdMenu, 'data-open', null);
    dom.setAttr(refs.cmd, 'aria-expanded', 'false');
    dom.setAttr(refs.cmd, 'aria-activedescendant', null);
    cmdState.active = -1;
  }

  function paintCmd(query) {
    dom.reconcile(refs.cmdList, cmdState.list, function (index) {
      return String(index);
    }, function (index) {
      var item = dom.el('div', 'cmd-item');
      item.setAttribute('role', 'option');
      item.id = 'chart-cmd-' + INDICATORS[index].type;
      item.appendChild(dom.el('span', 'cmd-name', INDICATORS[index].name));
      item.appendChild(dom.el('span', 'cmd-short', INDICATORS[index].short));
      return item;
    }, function (item, index, at) {
      item.dataset.index = String(index);
      var on = at === cmdState.active;
      dom.setAttr(item, 'data-active', on ? 'true' : null);
      dom.setAttr(item, 'aria-selected', on ? 'true' : 'false');
    });
    var active = cmdState.active >= 0 ? INDICATORS[cmdState.list[cmdState.active]] : null;
    dom.setAttr(refs.cmd, 'aria-activedescendant', active ? 'chart-cmd-' + active.type : null);
    var word = query.split(/\s+/)[0] || '';
    dom.setText(refs.cmdNone, cmdState.list.length ? '' : 'No indicator called “' + word + '”.');
    dom.setHidden(refs.cmdNone, !!cmdState.list.length);
  }

  function onCmdKey(event) {
    if (event.key === 'Escape') {
      if (refs.cmdMenu.dataset.open === 'true') {
        event.preventDefault();
        closeCmd();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (refs.cmdMenu.dataset.open !== 'true') openCmd();
      var n = cmdState.list.length;
      if (!n) return;
      var step = event.key === 'ArrowDown' ? 1 : -1;
      cmdState.active = cmdState.active < 0 ? (step > 0 ? 0 : n - 1) : (cmdState.active + step + n) % n;
      paintCmd(cmdQuery());
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    var query = cmdQuery();
    if (!query && cmdState.active < 0) return;
    /* The words as typed first, the way the assistant writes them. */
    if (query && applyCommand(query)) return done();
    var pick = cmdState.active >= 0 ? cmdState.list[cmdState.active] : (cmdState.list.length === 1 ? cmdState.list[0] : -1);
    if (pick >= 0) {
      /* "moving 50" or "rs 9": the picked indicator with the figures typed. */
      var figures = query.split(/\s+/).slice(1).join(' ');
      if (applyCommand(INDICATORS[pick].type + (figures ? ' ' + figures : ''))) return done();
    }
    openCmd();

    function done() {
      refs.cmd.value = '';
      closeCmd();
    }
  }

  function addIndicator(type) {
    if (applyCommand(type)) {
      refs.cmd.value = '';
      closeCmd();
    }
  }

  function applyCommand(text) {
    return typeof window.chartCommand === 'function' && window.chartCommand(text) === true;
  }

  function setChecked(row, on) {
    dom.setAttr(row, 'aria-checked', on ? 'true' : 'false');
  }

  /* ---------- Layers ----------

     The overlays and the volume pane as check rows in one popover, with where
     the prices come from as its foot. A popover rather than a row of chips,
     because seven chips is a toolbar and the bar has room for one word. */
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

    /* Where the prices come from. The engine writes what is actually serving
       the candles into #chart-provider, the same id the old cycling button
       had, as a name. */
    var foot = dom.el('p', 'layers-foot');
    foot.appendChild(dom.el('span', 'layers-foot-label', 'Prices from '));
    var venue = dom.el('span', 'venue');
    venue.id = 'chart-provider';
    venue.textContent = 'the exchange';
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

     The strip's first cell: the coin's logo, its name and where it trades,
     which opens a list of the markets the app charts, each with its price.
     A search field heads the list once it passes ten. It was a native
     <select> once, which drew OS chrome, and then a cell in the bar's
     segment; the exchange header puts the coin first with its mark, so it
     lives on the strip now.

     It writes the focus to /api/trade, which sets the trading view's symbol AND
     the chart's product server side and broadcasts both, so one write moves the
     canvas and the deck together. Nothing here touches the chart engine. */
  var MENU_SEARCH_AT = 10;

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
    var words = dom.el('span', 'trade-symbol-words');
    var top = dom.el('span', 'trade-symbol-top');
    var label = dom.el('span', 'trade-mark-coin', '--');
    top.appendChild(label);
    top.appendChild(icon('chevron-down', 'chev-icon'));
    words.appendChild(top);
    words.appendChild(dom.el('span', 'trade-symbol-venue', 'on Hyperliquid'));
    button.appendChild(words);

    var sheet = dom.el('div', 'trade-menu pop');
    var search = dom.el('input', 'input trade-menu-search');
    search.type = 'search';
    search.placeholder = 'Find a market';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Find a market');
    search.setAttribute('aria-controls', 'trade-markets');
    search.hidden = true;
    sheet.appendChild(search);
    var menu = dom.el('div', 'trade-menu-list');
    menu.id = 'trade-markets';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Which market');
    menu.tabIndex = -1;
    sheet.appendChild(menu);

    wrap.appendChild(button);
    wrap.appendChild(sheet);

    dom.on(button, 'click', function () {
      if (sheet.dataset.open === 'true') closeMenu();
      else openMenu();
    });
    dom.on(button, 'keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu();
    });
    dom.on(sheet, 'keydown', onMenuKey);
    dom.on(search, 'input', function () {
      var list = menuList();
      if (list.indexOf(menuActive) < 0) menuActive = list[0] || '';
      renderSymbol();
    });
    dom.on(menu, 'click', function (event) {
      var option = optionOf(event.target);
      if (option) pick(option.dataset.product);
    });
    dom.on(document, 'click', function (event) {
      if (sheet.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      closeMenu(focusStayed(wrap));
    });

    refs.symbolButton = button;
    refs.symbolLogo = mark;
    refs.symbolLabel = label;
    refs.symbolSheet = sheet;
    refs.symbolSearch = search;
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
    var sheet = refs.symbolSheet;
    if (!sheet || !products().length) return;
    var searching = products().length > MENU_SEARCH_AT;
    refs.symbolSearch.value = '';
    dom.setHidden(refs.symbolSearch, !searching);
    menuActive = currentProduct();
    renderSymbol();
    dom.setAttr(sheet, 'data-open', 'true');
    dom.setAttr(refs.symbolButton, 'aria-expanded', 'true');
    var target = searching ? refs.symbolSearch : refs.symbolMenu;
    if (target.focus) target.focus();
  }

  function closeMenu(returnFocus) {
    var sheet = refs.symbolSheet;
    if (!sheet) return;
    dom.setAttr(sheet, 'data-open', null);
    dom.setAttr(refs.symbolButton, 'aria-expanded', 'false');
    if (returnFocus !== false && refs.symbolButton && refs.symbolButton.focus) refs.symbolButton.focus();
  }

  /* The markets the list shows: all of them, or the ones whose coin holds
     what is typed in the search. */
  function menuList() {
    var query = refs.symbolSearch && !refs.symbolSearch.hidden ? String(refs.symbolSearch.value || '').trim().toLowerCase() : '';
    var list = products();
    if (!query) return list;
    return list.filter(function (product) {
      return coinOfProduct(product).toLowerCase().indexOf(query) >= 0;
    });
  }

  /* A click outside a sheet closes it, and the focus goes back to its button
     unless the click gave it to something else. */
  function focusStayed(wrap) {
    var active = document.activeElement;
    return !active || active === document.body || within(active, wrap);
  }

  function onMenuKey(event) {
    var list = menuList();
    var at = list.indexOf(menuActive);
    if (event.key === 'Escape' || event.key === 'Tab') {
      closeMenu();
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    /* A space in the search is a space; on the list it picks. */
    var typing = event.target === refs.symbolSearch;
    if (event.key === 'Enter' || (event.key === ' ' && !typing)) {
      event.preventDefault();
      pick(menuActive);
      return;
    }
    if (typing && (event.key === 'Home' || event.key === 'End')) return;
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
    focusMarket(coinOfProduct(product).toUpperCase());
  }

  /* The market the strip, the chart and the deck are about. A position's
     card on Pro lands here too, on its way to Trade. */
  function focusMarket(coin) {
    var was = data ? data.symbol : null;
    if (!data || !coin || String(was || '').toUpperCase() === coin) return;
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
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err));
      });
  }

  function products() {
    return (data && Array.isArray(data.products)) ? data.products : [];
  }

  function currentProduct() {
    var symbol = symbolOf();
    var list = products();
    for (var i = 0; i < list.length; i += 1) {
      if (coinOfProduct(list[i]).toUpperCase() === symbol) return list[i];
    }
    return symbol;
  }

  function symbolOf() {
    return (data && data.symbol) ? String(data.symbol).toUpperCase() : '';
  }

  /* "BTC-USD" is the chart's id for the market; a person reads "BTC". */
  function coinOfProduct(product) {
    return String(product || '').split('-')[0];
  }

  function renderSymbol() {
    if (!refs.symbolLabel) return;
    var list = menuList();
    var current = currentProduct();
    var symbol = symbolOf();
    dom.setText(refs.symbolLabel, symbol ? displayCoin(symbol) : '--');
    setLogo(refs.symbolLogo, logoCoin(symbol), 28);
    dom.setAttr(refs.symbolButton, 'disabled', products().length ? null : true);
    dom.setAttr(refs.symbolMenu, 'aria-activedescendant', null);

    dom.reconcile(refs.symbolMenu, list, function (product) {
      return String(product);
    }, function (product) {
      var option = dom.el('div', 'trade-option');
      option.setAttribute('role', 'option');
      option.appendChild(logo(logoCoin(coinOfProduct(product)), 18));
      option.appendChild(dom.el('span', 'trade-option-name'));
      option.appendChild(dom.el('span', 'trade-option-price num'));
      return option;
    }, function (option, product, i) {
      dom.setAttr(option, 'id', 'trade-market-' + i);
      option.dataset.product = product;
      var coin = coinOfProduct(product);
      dom.setText(option.children[1], displayCoin(coin.toUpperCase()));
      var px = markFor(coin.toUpperCase());
      dom.setText(option.children[2], typeof px === 'number' ? priceText(px) : '');
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
    var ids = overlayIds(row.dataset.overlay);
    /* One write per id the row stands for, in order, so the server's own
       answer to each is the one that counts. */
    var chain = Promise.resolve();
    ids.forEach(function (name) {
      chain = chain.then(function () {
        return net.postJson('/api/trade', { overlay: { name: name, on: on } });
      });
    });
    chain
      .then(function () { return refresh(); })
      .catch(function (err) {
        setChecked(row, !on);
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err));
      });
  }

  function overlayIds(id) {
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      if (OVERLAYS[i].id === id) return OVERLAYS[i].ids;
    }
    return [id];
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
        if (!row) continue;
        /* A row that stands for two is on while either is on. */
        var on = OVERLAYS[i].ids.some(function (name) { return overlays[name] !== false; });
        setChecked(row, on);
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
        /* The money line on Pro says what the trading account holds, off this
           same read (ui/screens/pro.js). */
        if (typeof window.CustomEvent === 'function') {
          window.dispatchEvent(new window.CustomEvent('phosphor:trade', { detail: { data: data } }));
        }
      })
      .catch(function (err) {
        console.error('[trade]', err);
      });
  }

  function render() {
    renderOverlays();
    renderSymbol();
    renderStrip();
    renderAccount();
    renderOpen();
    renderWaiting();
    renderDone();
    renderSpotlight();
    placeTabIndicator();
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
    return !!(window.PhosphorShell && typeof window.PhosphorShell.view === 'function' && isTradingView(window.PhosphorShell.view()));
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
    /* The bars just read cover everything up to now, so what the tape folded
       in since the last read starts over. */
    tape.high = null;
    tape.low = null;
    renderDay();
  }

  /* ---------- the tape ----------

     The big figure is the chart's last trade, read off the same candle frames
     the chart draws its live bar from (SSE {type:'candle'}, 120 ms deltas, no
     fetch behind them). The venue's mark is a different number on a different
     socket: a smoothed oracle price ticking once a second, and it reached the
     strip through /api/trade and a six-part render, so the strip stepped while
     the chart moved per trade, cents to dollars apart (Karim, 2026-09-16: "the
     price is stalling"). The mark stays as the figure's title. The tape is one
     market's: a frame for any other market, or from a venue the strip does not
     name, is nobody's business here. Frames fold to one paint per animation
     frame, so a burst restarts the 600 ms tick once with the newest value
     instead of queueing a tick per trade. */
  var STRIP_VENUE = 'hyperliquid';
  var tape = { product: '', px: null, high: null, low: null };
  var tapeFrame = 0;

  function onCandle(frame) {
    if (!mounted || !frame || !frame.candle) return;
    if (frame.provider && frame.provider !== STRIP_VENUE) return;
    var product = currentProduct();
    if (!product || frame.product !== product) return;
    var bar = frame.candle;
    if (typeof bar.c !== 'number' || !isFinite(bar.c)) return;
    if (tape.product !== product) tape = { product: product, px: null, high: null, low: null };
    tape.px = bar.c;
    if (typeof bar.h === 'number' && (tape.high === null || bar.h > tape.high)) tape.high = bar.h;
    if (typeof bar.l === 'number' && (tape.low === null || bar.l < tape.low)) tape.low = bar.l;
    if (tapeFrame) return;
    tapeFrame = nextFrame(paintTape);
  }

  function paintTape() {
    tapeFrame = 0;
    renderPrice();
    renderDay();
  }

  function nextFrame(fn) {
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(fn);
    return window.setTimeout(fn, 16);
  }

  /* Whether the tape is about the market on the strip right now. */
  function onTape() {
    return !!tape.product && tape.product === currentProduct();
  }

  /* The figure on the strip: the last trade once the tape has one for this
     market, the venue's mark until then. */
  function priceOf() {
    if (onTape() && typeof tape.px === 'number') return tape.px;
    return markOf();
  }

  /* ---------- the strip, filled ---------- */

  function renderStrip() {
    renderPrice();
    renderDay();

    /* A venue that is not answering has not said the account is empty, it has
       said nothing, and those are different sentences. So the line says what
       is wrong in plain words and keeps the venue's own words behind the
       developer switch. A read skipped because there is no wallet yet is a
       quiet wait, keyed off the error's text until the feed carries it as a
       flag of its own. What the account holds, funded or not, is the money
       line's to say (ui/screens/pro.js reads collateral.funded). */
    if (venueDown()) {
      var raw = data.venue.error ? String(data.venue.error) : '';
      if (/no wallet/i.test(raw)) {
        statusLine('Nothing to read until a wallet exists.', null, 'waiting', raw);
      } else if (data.venue.connected === false) {
        statusLine('Not connected to Hyperliquid. Trying again.', 'down', 'link-off', raw);
      } else {
        statusLine('Hyperliquid is not answering one of our reads. Trying again.', 'warn', 'warning', raw);
      }
      return;
    }
    statusLine('', null, null);
  }

  /* The notice under the row. `tone` says which kind of news it is (warn,
     down, or none for a quiet wait) and the stylesheet keeps all three calm,
     `iconName` is the drawn icon ahead of the sentence, `raw` the venue's own
     words for the developer switch. The icon is swapped only when its name
     changes, so a line that is repainted every tick keeps its node. Empty text
     takes the row away. */
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

  /* THE PRICE. Set as text, not rolled and not coloured: at a trade every
     few hundred milliseconds a roll or a flash is a strobe beside the
     conversation. The mark is the title, so the venue's own number is one
     hover away from the last trade. */
  function renderPrice() {
    var mark = markOf();
    setPrice(priceText(priceOf()));
    dom.setAttr(refs.price, 'title', typeof mark === 'number' && isFinite(mark) ? 'Hyperliquid mark ' + priceText(mark) : null);
  }

  /* The day. The change is the price against the close a day ago, as
     "-$2,188 (-2.78%) in 24h", signed and never coloured: a market that fell
     is not the person's loss. High and low are the day's extremes, with what
     the tape has seen since the bars were read folded in. All three read --
     until the candles for this market have landed. */
  function renderDay() {
    var symbol = symbolOf();
    var price = priceOf();
    var have = range.symbol === symbol && typeof range.open === 'number' && range.open > 0
      && typeof price === 'number' && isFinite(price);
    var high = range.high;
    var low = range.low;
    if (range.symbol === symbol && onTape()) {
      if (typeof tape.high === 'number' && (high === null || tape.high > high)) high = tape.high;
      if (typeof tape.low === 'number' && (low === null || tape.low < low)) low = tape.low;
    }
    if (!have) {
      dom.setText(refs.change, '--');
      dom.setAttr(refs.change, 'data-dir', null);
      dom.setText(refs.high, range.symbol === symbol ? priceText(high) : '--');
      dom.setText(refs.low, range.symbol === symbol ? priceText(low) : '--');
      return;
    }
    var delta = price - range.open;
    var pct = (delta / range.open) * 100;
    var dir = Math.abs(delta) < 1e-9 ? null : (delta > 0 ? 'up' : 'down');
    dom.setText(refs.change, signedMoney(delta, Math.abs(delta) >= 1000 ? 0 : decimalsOf(price)) + ' (' + (pct > 0 ? '+' : pct < 0 ? '-' : '') + Math.abs(pct).toFixed(2) + '%)');
    dom.setAttr(refs.change, 'data-dir', dir);
    dom.setText(refs.high, priceText(high));
    dom.setText(refs.low, priceText(low));
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

  /* A signed dollar change in the given places: the sign first, then the
     unit, so "-$2,147" reads the way a person says it. */
  function signedMoney(value, decimals) {
    var abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (value > 0 ? '+' : value < 0 ? '-' : '') + '$' + abs;
  }

  function decimalsOf(price) {
    var abs = Math.abs(price);
    if (abs >= 1) return 2;
    return abs >= 0.01 ? 4 : 6;
  }

  /* ---------- Positions ----------

     One card per position: the coin with its logo, its side and its multiple
     (5x), and the size under it; the profit at the right with its return
     under it; then five labelled figures, entry, mark, liquidation, stop and
     target, each with where it sits from the mark. A position with no stop
     says "No stop": a dash read as missing data where the truth is
     "unprotected". Pro adds a track from the stop to the target with the mark
     on it.

     The exits come from the open plan on that coin, or from the working
     triggers when no plan of this app's is behind the position. Close posts the
     plan's id, so a position with no plan has no Close: it says it was opened
     elsewhere instead of leaving a gap a person reads as a bug. The card is a
     way to the chart: pressing it brings the market up on Trade.

     Every name below is the payload's: a Position is
     { coin, side, sizeCoin, notionalUsd, entryPx, markPx, liqPx, unrealisedUsd,
       roePct, leverage, marginUsedUsd, liqReachable, liqDistancePct, ... }. */
  var TAPE_COLUMNS = ['Time', 'Trade', 'Price', 'Value', 'Result'];

  /* The tape's headings in 12/500 in the second tone, on the same grid as the
     rows under it. Hidden until the list has rows. The Trade heading spans the
     side, the coin and the size. */
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
    reconcileRows(host, positions, function (p) {
      return coinKey(p.coin);
    }, makePosition, fillPosition);
    if (!positions.length) host.appendChild(empty('Nothing open.'));
  }

  function makePosition(p) {
    var row = tradeRow('position', coinKey(p.coin));
    row.className += ' pos-row';

    /* The coin: a press on it charts the market. A button in all but name,
       so the keyboard reaches it; the card's own Close stays its own button. */
    var asset = dom.el('div', 'pos-asset');
    asset.setAttribute('role', 'button');
    asset.tabIndex = 0;
    asset.appendChild(dom.el('span', 'pos-logo'));
    var name = dom.el('div', 'pos-name');
    var line = dom.el('div', 'pos-line');
    line.appendChild(dom.el('span', 'pos-coin'));
    line.appendChild(dom.el('span', 'pos-side'));
    line.appendChild(dom.el('span', 'pos-lev num'));
    name.appendChild(line);
    name.appendChild(dom.el('span', 'pos-size num'));
    asset.appendChild(name);
    row.appendChild(asset);

    var result = dom.el('div', 'pos-result');
    result.appendChild(dom.el('span', 'trade-pnl pos-pnl num'));
    result.appendChild(dom.el('span', 'pos-roe num'));
    row.appendChild(result);

    row.appendChild(dom.el('div', 'trade-row-foot'));

    var stats = dom.el('dl', 'pos-stats');
    stats.appendChild(stat('pos-entry', 'Entry'));
    stats.appendChild(stat('pos-mark', 'Mark'));
    stats.appendChild(stat('pos-liq', 'Liquidation'));
    stats.appendChild(stat('pos-stop', 'Stop'));
    stats.appendChild(stat('pos-target', 'Target'));
    row.appendChild(stats);

    row.appendChild(buildTrack());

    dom.on(row, 'click', onPositionPress);
    dom.on(asset, 'keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onPositionPress(event);
    });
    return row;
  }

  /* One labelled figure: the word, the value, and a quiet line saying where
     it sits. */
  function stat(className, label) {
    var node = dom.el('div', 'pos-stat ' + className);
    node.appendChild(dom.el('dt', 'pos-k', label));
    var value = dom.el('dd', 'pos-v');
    value.appendChild(dom.el('span', 'pos-figure num'));
    value.appendChild(dom.el('span', 'pos-sub num'));
    node.appendChild(value);
    return node;
  }

  function setStat(node, figure, sub, none) {
    var value = node.children[1];
    dom.setText(value.children[0], figure);
    dom.setText(value.children[1], sub || '');
    dom.setHidden(value.children[1], !sub);
    dom.setAttr(node, 'data-none', none ? 'true' : null);
  }

  function fillPosition(row, p) {
    var coin = displayCoin(coinKey(p.coin), p.coin);
    var key = coinKey(p.coin);
    var asset = row.children[0];
    setLogo(asset.children[0], logoCoin(key), 28);
    var line = asset.children[1].children[0];
    dom.setText(line.children[0], coin);
    paintSide(line.children[1], p.side === 'short' ? 'short' : 'long');
    dom.setText(line.children[2], isNum(p.leverage) ? p.leverage + 'x' : '');
    dom.setNumber(asset.children[1].children[1], isNum(p.sizeCoin) ? dom.qty(p.sizeCoin, precisionOf(key)) + ' ' + coin : '');
    asset.setAttribute('aria-label', coin + ', ' + (p.side === 'short' ? 'short' : 'long') + '. Show it on the chart.');

    /* The figures roll when they change (dom.setNumber), so a fill or a mark
       that moved under a position reads as a change and not as a redraw. */
    var mark = isNum(p.markPx) ? p.markPx : markFor(key);
    var exits = exitsOf(key);
    var result = row.children[1];
    var pnl = result.children[0];
    var loss = isNum(p.unrealisedUsd) && p.unrealisedUsd < 0;
    pnl.className = 'trade-pnl pos-pnl num' + (loss ? ' loss' : '');
    dom.setNumber(pnl, isNum(p.unrealisedUsd) ? signedUsd(p.unrealisedUsd) : '--');
    dom.setText(result.children[1], isNum(p.roePct) ? signedPct(p.roePct) : '');
    dom.setHidden(result.children[1], !isNum(p.roePct));

    var stats = row.children[3];
    setStat(stats.children[0], isNum(p.entryPx) ? priceText(p.entryPx) : '--', '');
    setStat(stats.children[1], isNum(mark) ? priceText(mark) : '--', '');
    var liq = liquidationOf(p);
    setStat(stats.children[2], liq.figure, liq.sub, liq.none);
    setStat(stats.children[3], exits.stop !== null ? priceText(exits.stop) : 'No stop', where(exits.stop, mark), exits.stop === null);
    setStat(stats.children[4], exits.target !== null ? priceText(exits.target) : 'No target', where(exits.target, mark), exits.target === null);

    paintTrack(row.children[4], p, exits, mark, liq);
    paintFoot(row.children[2], exits.plan);
    paintConfirm(row);
  }

  /* The liquidation price and how far the mark is from it. A position the
     venue says cannot be liquidated reads None; one it has not said reads
     unknown, never a price of zero. */
  function liquidationOf(p) {
    if (p.liqReachable === false) return { figure: 'None', sub: '', none: true, px: null };
    if (!isNum(p.liqPx) || p.liqPx <= 0) return { figure: '--', sub: '', none: true, px: null };
    var pct = isNum(p.liqDistancePct) ? Math.abs(p.liqDistancePct) : null;
    return {
      figure: priceText(p.liqPx),
      sub: pct === null ? '' : (pct >= 10 ? Math.round(pct) : pct.toFixed(1)) + '% away',
      none: false,
      px: p.liqPx
    };
  }

  /* Where a price sits against the mark, in words: "5.2% below", "6.0% above".
     Words rather than a sign, because a signed percentage beside a price
     reads as that price's change. */
  function where(price, mark) {
    if (!isNum(price) || !isNum(mark) || mark <= 0) return '';
    var pct = ((price - mark) / mark) * 100;
    if (Math.abs(pct) < 0.05) return 'at the mark';
    return Math.abs(pct).toFixed(1) + '% ' + (pct < 0 ? 'below' : 'above');
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
        stop: isNum(plan.stop) ? plan.stop : null,
        target: isNum(plan.target) ? plan.target : null
      };
    }
    var out = { plan: null, stop: null, target: null };
    var orders = (data && Array.isArray(data.orders)) ? data.orders : [];
    for (var o = 0; o < orders.length; o += 1) {
      var order = orders[o];
      if (String(order.coin).toUpperCase() !== coin || order.kind !== 'trigger') continue;
      if (!isNum(order.triggerPx)) continue;
      if (order.role === 'stop' && out.stop === null) out.stop = order.triggerPx;
      if (order.role === 'target' && out.target === null) out.target = order.triggerPx;
    }
    return out;
  }

  /* The foot: Close when this app holds the plan behind the position, and a
     quiet line saying why not otherwise. Rebuilt only when the plan changes,
     so a frame landing under the pointer never swaps the button out. */
  function paintFoot(foot, plan) {
    var id = plan ? String(plan.id) : '';
    if (foot.dataset.plan === id && foot.children.length) return;
    foot.dataset.plan = id;
    dom.clear(foot);
    if (plan) {
      foot.appendChild(actButton('Close', 'close', id));
      return;
    }
    var note = dom.el('span', 'pos-elsewhere', 'Opened elsewhere');
    note.title = 'Phosphor did not open this position, so it has no Close here. Close it on Hyperliquid, or ask your assistant.';
    foot.appendChild(note);
  }

  /* ---------- the track (Pro) ----------

     A line from the stop (or the liquidation price, when there is no stop)
     to the target, with the entry as a tick and the mark as a dot, so where
     the price sits between the two exits reads before any figure does. No
     colour: where the dot sits is the news. Drawn only when both ends are
     known. */
  function buildTrack() {
    var track = dom.el('div', 'pos-track');
    track.setAttribute('aria-hidden', 'true');
    track.appendChild(dom.el('span', 'pos-track-end pos-track-lo'));
    var bar = dom.el('span', 'pos-track-bar');
    bar.appendChild(dom.el('span', 'pos-track-run'));
    bar.appendChild(dom.el('span', 'pos-track-entry'));
    bar.appendChild(dom.el('span', 'pos-track-dot'));
    track.appendChild(bar);
    track.appendChild(dom.el('span', 'pos-track-end pos-track-hi'));
    track.hidden = true;
    return track;
  }

  function paintTrack(track, p, exits, mark, liq) {
    var lossEnd = exits.stop !== null ? exits.stop : liq.px;
    var winEnd = exits.target;
    var span = isNum(lossEnd) && isNum(winEnd) ? winEnd - lossEnd : 0;
    if (!span || !isNum(mark)) {
      dom.setHidden(track, true);
      return;
    }
    dom.setHidden(track, false);
    var at = function (px) {
      return Math.max(0, Math.min(1, (px - lossEnd) / span)) * 100;
    };
    var markAt = at(mark);
    var entryAt = isNum(p.entryPx) ? at(p.entryPx) : markAt;
    var style = track.style;
    if (style && typeof style.setProperty === 'function') {
      style.setProperty('--mark-at', markAt.toFixed(2) + '%');
      style.setProperty('--entry-at', entryAt.toFixed(2) + '%');
      style.setProperty('--run-from', Math.min(markAt, entryAt).toFixed(2) + '%');
      style.setProperty('--run-to', Math.max(markAt, entryAt).toFixed(2) + '%');
    }
    dom.setText(track.children[0], (exits.stop !== null ? 'Stop ' : 'Liquidation ') + priceText(lossEnd));
    dom.setText(track.children[2], 'Target ' + priceText(winEnd));
  }

  /* A press anywhere on a position card that is not one of its controls
     brings its market up on Trade, charted. */
  function onPositionPress(event) {
    var node = event.target;
    for (var at = node; at && at !== event.currentTarget; at = at.parentNode) {
      if (!at.tagName) continue;
      var tag = String(at.tagName).toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || (at.className && String(at.className).indexOf('trade-confirm') >= 0)) return;
    }
    var row = rowOf(event.currentTarget);
    var key = row && row.dataset.spotKey ? row.dataset.spotKey.slice('position:'.length) : '';
    if (!key) return;
    focusMarket(key);
    if (window.PhosphorShell && typeof window.PhosphorShell.setView === 'function' && window.PhosphorShell.view() !== 'trade') {
      window.PhosphorShell.setView('trade', { fromClick: true });
    }
  }

  function rowOf(node) {
    for (var at = node; at; at = at.parentNode) {
      if (at.dataset && at.dataset.spotKey) return at;
    }
    return null;
  }

  function signedUsd(value) {
    return (value > 0 ? '+' : '') + dom.usd(value);
  }

  function signedPct(value) {
    var rounded = Math.abs(value) < 0.05 ? 0 : value;
    return (rounded > 0 ? '+' : rounded < 0 ? '-' : '') + Math.abs(rounded).toFixed(1) + '%';
  }

  /* Which way a position or a plan leans: the icon family's arrow and the
     word, in the quiet tone. Rebuilt only when the side changes. */
  function paintSide(node, side) {
    if (node.dataset.side === side) return;
    node.dataset.side = side;
    dom.clear(node);
    node.appendChild(icon(side === 'short' ? 'short' : 'long', 'icon-14'));
    node.appendChild(dom.el('span', '', side === 'short' ? 'Short' : 'Long'));
  }

  /* ---------- Orders ----------

     Every plan that is not open and not done: an idea the agent drew, a plan
     watching for its moment, a plan whose entry rests on the venue. One
     English sentence each, built from the plan's own fields, with every price
     in dollars, and its state in a word beside it: Idea, Watching, Placed, or
     the two waits on a person, Needs unlock and Waiting for prices, in the
     waiting colour. Under it the conditions in plain words ("when a 1-hour
     candle closes under $211"), each with a check when the watcher says it
     holds and a clock when it does not or when nothing is watching yet.
     Cancel is only offered where the host would take it, which is a watching
     or a placed plan. */
  function renderWaiting() {
    var host = refs.waitingBody;
    var plans = plansOf().filter(function (p) {
      return p.status === 'idea' || p.status === 'waiting' || p.status === 'placed';
    });
    setCount('waiting', plans.length);
    reconcileRows(host, plans, function (p) {
      return String(p.id);
    }, function (p) {
      var row = tradeRow('plan', String(p.id));
      row.className += ' plan-row';
      var head = dom.el('div', 'plan-head');
      head.appendChild(dom.el('p', 'trade-row-line'));
      head.appendChild(dom.el('span', 'trade-row-state'));
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
        item.appendChild(icon(rows[i].holds ? 'done' : 'waiting', 'icon-14 trade-cond-mark'));
        item.appendChild(dom.el('span', '', rows[i].condition));
        conds.appendChild(item);
      }
      dom.setHidden(conds, rows.length === 0);

      var foot = row.children[2];
      var cancellable = p.status === 'waiting' || p.status === 'placed';
      var id = cancellable ? String(p.id) : '';
      if (foot.dataset.plan !== id || (cancellable && !foot.children.length)) {
        foot.dataset.plan = id;
        dom.clear(foot);
        if (cancellable) foot.appendChild(actButton('Cancel', 'cancel', id));
      }
      paintConfirm(row);
    });
    if (!plans.length) host.appendChild(empty('Nothing waiting.'));
  }

  /* The state beside a plan, rebuilt from its parts: the icon when the state
     has one, then the word. A word, not a pill: the two waits on a person
     take the waiting colour and everything else stays quiet. */
  function paintState(node, state) {
    dom.clear(node);
    node.className = 'trade-row-state' + (state.warn ? ' warn' : '');
    dom.setAttr(node, 'data-tone', state.tone || null);
    dom.setAttr(node, 'title', state.title || null);
    if (state.icon) node.appendChild(icon(state.icon, 'icon-14'));
    node.appendChild(dom.el('span', '', state.text));
  }

  /* "Long ETH $200 at 3x, market, stop $3,180, target $3,420". The shape a
     person can check against the chart in one look, every price in dollars. */
  function planLine(plan) {
    var side = plan.side === 'short' ? 'Short' : 'Long';
    var coin = displayCoin(String(plan.symbol || '').toUpperCase(), plan.symbol);
    var bits = [side + ' ' + coin + ' ' + dom.usd(plan.sizeUsd, 0) + ' at ' + plan.leverage + 'x'];
    bits.push(entryWord(plan.entry, plan.symbol));
    if (isNum(plan.stop)) bits.push('stop ' + planPx(plan.stop, plan.symbol));
    if (isNum(plan.target)) bits.push('target ' + planPx(plan.target, plan.symbol));
    return bits.join(', ');
  }

  function entryWord(entry, coin) {
    if (!entry || typeof entry !== 'object') return 'market';
    if (entry.type === 'limit') return 'limit ' + planPx(entry.px, coin);
    if (entry.type === 'stop') return 'stop entry ' + planPx(entry.px, coin);
    return 'market';
  }

  /* Every price in a plan's sentences, the same way: in dollars, grouped
     thousands and at most the market's own places, which on Hyperliquid is six
     less the size places (BTC trades in tenths, ETH in cents). A market the
     payload does not list keeps the plan's own digits, grouped. */
  function planPx(value, coin) {
    if (!isNum(value)) return '';
    var sz = precisionOf(String(coin || '').toUpperCase());
    var places = typeof sz === 'number' ? Math.max(0, Math.min(8, 6 - sz)) : 8;
    return (value < 0 ? '-$' : '$') + Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: places });
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

  /* The conditions src/trade/plan.ts renderCondition writes, said the way a
     person would: a bar is a candle, 1h is a 1-hour candle, and every price
     is in dollars (planPx). */
  function conditionText(c, coin) {
    if (!c || typeof c !== 'object') return '';
    if (c.type === 'close') {
      var at = c.at && isNum(c.at.px) ? planPx(c.at.px, coin) : 'the line ' + String(c.at && c.at.line || '');
      var over = c.is === 'above';
      if (c.wick === 'through') {
        return 'When a ' + tfWords(c.tf) + ' candle ' + (over ? 'dips under ' : 'spikes over ') + at + ' and closes back ' + (over ? 'over' : 'under') + ' it';
      }
      return 'When a ' + tfWords(c.tf) + ' candle closes ' + (over ? 'over ' : 'under ') + at;
    }
    if (c.type === 'volume') {
      return 'When ' + tfWords(c.tf) + ' volume is at least ' + String(c.atLeast) + ' times its recent average';
    }
    var parts = [];
    if (c.after !== undefined) parts.push('after ' + c.after);
    if (c.before !== undefined) parts.push('before ' + c.before);
    return parts.length ? 'Only ' + parts.join(' and ') : 'Any time';
  }

  /* "1h" as a person says it. */
  function tfWords(tf) {
    var words = { '1m': '1-minute', '3m': '3-minute', '5m': '5-minute', '15m': '15-minute', '30m': '30-minute',
      '1h': '1-hour', '2h': '2-hour', '4h': '4-hour', '8h': '8-hour', '12h': '12-hour', '1d': 'daily', '1w': 'weekly', '1M': 'monthly' };
    return Object.prototype.hasOwnProperty.call(words, tf) ? words[tf] : String(tf || '');
  }

  /* The word beside a plan. Amber is this window's colour for waiting on a
     person, and a locked plan is exactly that: it starts watching again on
     the next unlock. One that has no prices to watch is the same kind of
     wait. A watching or placed plan wears the armed icon in the quiet tone: it
     is working, and nothing about it is the person's to do. */
  function planState(plan) {
    if (plan.status === 'idea') return { text: 'Idea', tone: null, warn: false, title: 'Drawn by your assistant. Nothing is watching it yet.' };
    if (plan.locked === true) return { text: 'Needs unlock', tone: 'warn', warn: true, title: 'It starts watching again when you unlock Phosphor.' };
    if (plan.blind === true) return { text: 'Waiting for prices', tone: 'warn', warn: true, title: 'Prices stopped coming in. It watches again when they are back.' };
    if (plan.status === 'placed') return { text: 'Placed', tone: null, icon: 'armed', warn: false, title: 'Its entry order is waiting on Hyperliquid.' };
    return { text: 'Watching', tone: null, icon: 'armed', warn: false, title: 'Watching for its moment. Nothing is placed yet.' };
  }

  /* ---------- History ----------

     The tape: fills and ended plans as dense rows, newest first, the last 24
     hours by default and twenty older ones per press of Show more. A fill row
     reads the way an exchange's own fills read: the clock, Buy or Sell as a
     word, the coin with its logo and the size beside it, the price it filled
     at, the value, what a closing fill made or lost, and the explorer link at
     the end when the fill carries one. A buy and a sell are both plain: a
     sell is not a loss. A fill row opens the shared receipt card. An ended
     plan keeps its sentence, takes a glyph instead of a logo, and shows what
     it closed for in the result column, when the payload says, in red only
     when that was a loss. The list is reconciled by key and a row that
     is already on screen keeps its identity; the host belongs to the
     reconciler, so Show more sits under it, not in it. The tab's count is the
     day's rows, whatever Show more has revealed under them. */
  var doneExtra = 0;

  function renderDone() {
    var host = refs.doneBody;
    var rows = doneRows();
    var cut = doneWindow(rows);
    setCount('done', cut.day);
    dom.setHidden(refs.doneHead, !cut.list.length);
    dom.setHidden(refs.doneFoot, cut.more <= 0);
    dom.setAttr(refs.more, 'title', cut.more > 0 ? cut.more + ' older' : null);
    reconcileRows(host, cut.list, function (row) {
      return row.key;
    }, function (row) {
      return row.fill ? fillRow(row) : endedRow(row);
    }, function (node, row) {
      node.dataset.spotKey = row.spotKey;
      if (row.fill) fillFill(node, row);
      else fillEnded(node, row);
    });
    if (!cut.list.length) host.appendChild(empty(rows.length ? 'Nothing in the last 24 hours.' : 'Nothing yet.'));
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
     order the stylesheet places them: when, side, coin, size, price, value,
     result, link. */
  function fillRow(row) {
    var node = dom.el('div', 'done-row fill-row');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.appendChild(dom.el('span', 'tx-when meta num'));
    node.appendChild(dom.el('span', 'tx-side'));
    var asset = dom.el('span', 'tx-asset');
    asset.appendChild(logo(logoCoin(row.key0), 20));
    asset.appendChild(dom.el('span', 'tx-coin', row.coin));
    node.appendChild(asset);
    node.appendChild(dom.el('span', 'tx-size num'));
    node.appendChild(dom.el('span', 'tx-price num'));
    node.appendChild(dom.el('span', 'tx-amount num'));
    node.appendChild(dom.el('span', 'tx-result num'));
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
    dom.setAttr(side, 'data-side', row.sold ? 'sell' : 'buy');
    dom.setText(node.children[3], row.size);
    dom.setText(node.children[4], row.price);
    var amount = node.children[5];
    dom.setAttr(amount, 'data-dir', null);
    dom.setNumber(amount, row.amount);
    var result = node.children[6];
    dom.setAttr(result, 'data-dir', row.dir || null);
    dom.setNumber(result, row.result);
    dom.setAttr(node, 'title', row.sub || null);
    dom.setAttr(node, 'aria-label', (row.sold ? 'Sold ' : 'Bought ') + row.coin + ' ' + row.size + (row.sub ? ', ' + row.sub : '')
      + (row.result ? ', ' + row.result + (row.dir === 'loss' ? ' lost' : ' made') : '') + '. Open the receipt.');
    paintLink(node.children[7], row.url);
  }

  /* The explorer link, an anchor only when there is somewhere to go. It is
     the row's own link, so a click on it does not also open the receipt. */
  function paintLink(cell, url) {
    dom.clear(cell);
    var link = dom.el('a', 'tx-open');
    if (!setHref(link, url)) return;
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
     what it closed for in the result column, signed and red only for a loss,
     or nothing when the payload carries no figure. */
  function endedRow(row) {
    var node = dom.el('div', 'done-row ended-row');
    node.appendChild(dom.el('span', 'tx-when meta num'));
    node.appendChild(endedMark(row.glyph));
    node.appendChild(dom.el('span', 'tx-title'));
    node.appendChild(dom.el('span', 'tx-amount tx-result num'));
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
    var coin = displayCoin(coinKey(fill.coin), fill.coin);
    var sold = fill.side === 'sell' || fill.side === 'A';
    var px = typeof fill.px === 'number' ? fill.px : null;
    var size = typeof fill.sizeCoin === 'number' ? fill.sizeCoin : null;
    var notional = notionalOf(fill);
    /* The dollar leg to the cent: the card prints an amount in its coin's own
       places, and a notional of 91.6152 USDC is not a fact the venue stated. */
    var dollars = notional !== null ? Math.round(notional * 100) / 100 : null;
    var closed = typeof fill.closedPnlUsd === 'number' && fill.closedPnlUsd !== 0;
    var qty = size !== null ? dom.qty(size, precisionOf(coinKey(fill.coin))) : '';
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
      var key0 = coinKey(fill.coin);
      /* What a closing fill made or lost. The venue writes a zero for an
         opening fill, so a zero is no result rather than a break even. */
      var closed = isNum(fill.closedPnlUsd) && fill.closedPnlUsd !== 0 ? fill.closedPnlUsd : null;
      out.push({
        key: 'fill:' + (fill.tid || fill.atMs || '') + ':' + i,
        spotKey: 'fill:' + String(fill.tid || ''),
        fill: fill,
        at: fill.atMs,
        key0: key0,
        coin: displayCoin(key0, fill.coin),
        sold: sold,
        size: dom.qty(fill.sizeCoin, precisionOf(key0)),
        price: px !== null ? priceText(px) : '',
        amount: notional !== null ? dom.usd(notional) : '',
        result: closed !== null ? signedUsd(closed) : '',
        dir: closed !== null && closed < 0 ? 'loss' : '',
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
        dir: pnl !== null && pnl < 0 ? 'loss' : ''
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

  /* Rows through the keyed reconciler, with a way out: a row whose key has
     gone (a position closed, an order cancelled) fades and folds its height
     away before it is removed, so the rows under it slide up rather than
     jump the moment after a person pressed Close. The reconciler removes a
     leftover at once, so a leaving row is lifted out before each pass and put
     back where it stood after it, and finishes leaving whatever frames land
     meanwhile. */
  var leaving = [];

  function reconcileRows(host, items, keyOf, create, update) {
    var mine = leaving.filter(function (l) { return l.host === host && l.node.parentNode === host; });
    var kids = host.childNodes || host.children || [];
    var order = function (node) {
      for (var i = 0; i < kids.length; i += 1) if (kids[i] === node) return i;
      return kids.length;
    };
    var keyed = host.__keyed || {};
    var want = {};
    for (var i = 0; i < items.length; i += 1) want[String(keyOf(items[i], i))] = true;
    var going = [];
    for (var k in keyed) {
      if (!Object.prototype.hasOwnProperty.call(keyed, k) || want[k]) continue;
      if (keyed[k].parentNode !== host || keyed[k].dataset.leaving === 'true') continue;
      going.push({ node: keyed[k], host: host });
    }
    var back = mine.concat(going);
    for (var b = 0; b < back.length; b += 1) {
      back[b].at = order(back[b].node);
      back[b].next = back[b].node.nextSibling;
    }
    for (var m = 0; m < mine.length; m += 1) host.removeChild(mine[m].node);

    dom.reconcile(host, items, keyOf, create, update);

    /* Last first, so a run of leaving rows lands back in its own order. */
    back.sort(function (x, y) { return y.at - x.at; });
    for (var r = 0; r < back.length; r += 1) {
      var l = back[r];
      var ref = l.next && l.next.parentNode === host ? l.next : null;
      host.insertBefore(l.node, ref);
    }
    going.forEach(function (l) {
      l.node.dataset.leaving = 'true';
      leaving.push(l);
      leaveRow(l.node, function () {
        if (l.node.parentNode) l.node.parentNode.removeChild(l.node);
        leaving = leaving.filter(function (x) { return x !== l; });
        repaintCuts();
      });
    });
  }

  /* The way out: opacity and height to nothing on the exit curve. At once
     under reduced motion, or where nothing can animate. */
  function leaveRow(node, done) {
    var motion = window.PhosphorMotion;
    var still = !motion || (typeof motion.reduced === 'function' && motion.reduced());
    if (still || typeof node.animate !== 'function' || typeof node.getBoundingClientRect !== 'function') {
      done();
      return;
    }
    var height = node.getBoundingClientRect().height;
    if (node.style) {
      node.style.overflow = 'hidden';
      node.style.pointerEvents = 'none';
    }
    var anim = node.animate([
      { opacity: 1, height: height + 'px' },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }
    ], { duration: 240, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' });
    if (anim && anim.finished && typeof anim.finished.then === 'function') anim.finished.then(done, done);
    else done();
  }

  /* ---------- Close and Cancel ----------

     A press grows a confirm under its own card (motion.js morph), never a
     dialog and never a timer: the sentence says what will happen in figures,
     "Close 0.25 ETH at about $4,012. About $219 goes back to your trading
     money, with $17.80 profit.", and two buttons answer it, focus on the
     harmless one. A refusal stays in the card in plain words, with the app's
     own reason behind Details. One confirm is open at a time, and its state
     lives here rather than on the node, because a trade frame repaints the
     card between the press and the answer. */
  var confirm = null;

  function actButton(label, action, id) {
    var button = dom.el('button', 'btn btn-ghost btn-sm trade-act');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    button.dataset.label = label;
    button.appendChild(dom.el('span', 'btn-label', label));
    dom.on(button, 'click', onAct);
    return button;
  }

  function onAct(event) {
    var button = event.currentTarget;
    var row = rowOf(button);
    if (!row) return;
    var key = button.dataset.action + ':' + button.dataset.id;
    if (confirm && confirm.key === key) return;
    var before = confirm ? rowByKey(confirm.row) : null;
    if (before && before !== row) {
      confirm = null;
      paintConfirm(before);
    }
    confirm = { key: key, action: button.dataset.action, id: button.dataset.id, row: row.dataset.spotKey, phase: 'ask', say: '', detail: '' };
    morph(row, function () { paintConfirm(row); });
    var keep = confirmButton(row, 'keep');
    if (keep && keep.focus) keep.focus();
  }

  function rowByKey(spotKey) {
    var rows = spotRows();
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].dataset.spotKey === spotKey) return rows[i];
    }
    return null;
  }

  function morph(row, change) {
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.morph === 'function') motion.morph(row, change);
    else change();
  }

  function confirmOf(row) {
    var kids = row.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].className === 'trade-confirm') return kids[i];
    }
    return null;
  }

  function confirmButton(row, role) {
    var box = confirmOf(row);
    if (!box) return null;
    var actions = box.children[3];
    return actions ? actions.children[role === 'keep' ? 0 : 1] : null;
  }

  /* The confirm under a card, painted from the open confirm and the numbers
     on screen now, so "at about" follows the mark while the person reads. */
  function paintConfirm(row) {
    var open = confirm && confirm.row === row.dataset.spotKey ? confirm : null;
    var box = confirmOf(row);
    dom.setAttr(row, 'data-confirming', open ? 'true' : null);
    if (!open) {
      if (box) row.removeChild(box);
      return;
    }
    if (!box) {
      box = dom.el('div', 'trade-confirm');
      box.setAttribute('role', 'group');
      box.appendChild(dom.el('p', 'trade-confirm-text'));
      var error = dom.el('p', 'trade-confirm-error');
      error.setAttribute('role', 'alert');
      box.appendChild(error);
      var details = dom.el('details', 'trade-confirm-details');
      details.appendChild(dom.el('summary', '', 'Details'));
      details.appendChild(dom.el('p', 'trade-confirm-why'));
      box.appendChild(details);
      var actions = dom.el('div', 'trade-confirm-actions');
      var keep = dom.el('button', 'btn btn-quiet btn-sm trade-confirm-keep');
      keep.type = 'button';
      keep.appendChild(dom.el('span', 'btn-label'));
      dom.on(keep, 'click', onKeep);
      var go = dom.el('button', 'btn btn-sm trade-confirm-go');
      go.type = 'button';
      go.appendChild(dom.el('span', 'btn-label'));
      dom.on(go, 'click', onGo);
      actions.appendChild(keep);
      actions.appendChild(go);
      box.appendChild(actions);
      /* Before the spotlight's note, which stays the card's last line. */
      var callout = calloutOf(row);
      row.insertBefore(box, callout);
    }
    var words = confirmWords(open);
    box.setAttribute('aria-label', words.label);
    dom.setAttr(box, 'data-phase', open.phase);
    paintSentence(box.children[0], words.parts);
    dom.setText(box.children[1], open.phase === 'failed' ? open.say : '');
    dom.setHidden(box.children[1], open.phase !== 'failed');
    dom.setText(box.children[2].children[1], open.detail || '');
    dom.setHidden(box.children[2], !(open.phase === 'failed' && open.detail));
    var actionsNode = box.children[3];
    dom.setHidden(actionsNode, open.phase === 'sent');
    dom.setText(actionsNode.children[0].children[0], words.keep);
    dom.setText(actionsNode.children[1].children[0], open.phase === 'sending' ? words.going : (open.phase === 'failed' ? 'Try again' : words.go));
    actionsNode.children[0].disabled = open.phase === 'sending';
    actionsNode.children[1].disabled = open.phase === 'sending';
    dom.setAttr(actionsNode.children[1], 'data-pending', open.phase === 'sending' ? 'true' : null);
  }

  /* The sentence in parts, so the one figure that can be a loss is the one
     that takes red, and nothing arrives as markup. */
  function paintSentence(node, parts) {
    dom.clear(node);
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (typeof part === 'string') node.appendChild(dom.el('span', '', part));
      else node.appendChild(dom.el('span', 'num' + (part.loss ? ' loss' : ''), part.text));
    }
  }

  /* What the confirm says, from the card's own numbers. */
  function confirmWords(open) {
    if (open.action === 'close') return closeWords(open);
    return cancelWords(open);
  }

  function closeWords(open) {
    var coin = open.row.slice('position:'.length);
    var p = positionOf(coin);
    var name = displayCoin(coin, p && p.coin);
    var words = { label: 'Close ' + name + '?', keep: 'Keep it open', go: 'Close now', going: 'Closing', parts: [] };
    if (open.phase === 'sent') {
      words.parts = ['Close sent. It leaves this list once Hyperliquid fills it.'];
      return words;
    }
    if (!p) {
      words.parts = ['Close your ' + name + ' position at the market price.'];
      return words;
    }
    var mark = isNum(p.markPx) ? p.markPx : markFor(coin);
    var parts = ['Close '];
    parts.push({ text: isNum(p.sizeCoin) ? dom.qty(p.sizeCoin, precisionOf(coin)) + ' ' + name : name });
    if (isNum(mark)) {
      parts.push(' at about ');
      parts.push({ text: priceText(mark) });
    }
    parts.push('. ');
    var pnl = isNum(p.unrealisedUsd) ? p.unrealisedUsd : null;
    var back = isNum(p.marginUsedUsd) && pnl !== null ? p.marginUsedUsd + pnl : null;
    if (back !== null && back > 0) {
      parts.push('About ');
      parts.push({ text: dom.usd(back) });
      parts.push(' goes back to your trading money');
      if (pnl !== null && Math.abs(pnl) >= 0.005) {
        parts.push(pnl >= 0 ? ', with ' : ', after a ');
        parts.push({ text: dom.usd(Math.abs(pnl)), loss: pnl < 0 });
        parts.push(pnl >= 0 ? ' profit.' : ' loss.');
      } else {
        parts.push('.');
      }
    } else if (pnl !== null) {
      parts.push({ text: signedUsd(pnl), loss: pnl < 0 });
      parts.push(' on it so far.');
    }
    words.parts = parts;
    return words;
  }

  function cancelWords(open) {
    var plan = planOf(open.id);
    var placed = !!(plan && plan.status === 'placed');
    var words = {
      label: 'Cancel this order?',
      keep: 'Keep it',
      go: placed ? 'Cancel order' : 'Stop watching',
      going: 'Cancelling',
      parts: []
    };
    if (open.phase === 'sent') {
      words.parts = ['Cancelled. It leaves this list in a moment.'];
      return words;
    }
    words.parts = [placed
      ? 'Take this order off Hyperliquid. Nothing has filled, so nothing else changes.'
      : 'Stop watching for this. Nothing has been placed, so nothing else changes.'];
    return words;
  }

  function positionOf(coin) {
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    for (var i = 0; i < positions.length; i += 1) {
      if (coinKey(positions[i].coin) === coin) return positions[i];
    }
    return null;
  }

  function planOf(id) {
    var plans = plansOf();
    for (var i = 0; i < plans.length; i += 1) {
      if (String(plans[i].id) === String(id)) return plans[i];
    }
    return null;
  }

  function onKeep(event) {
    var row = rowOf(event.currentTarget);
    closeConfirm(row, true);
  }

  function closeConfirm(row, returnFocus) {
    if (!row || !confirm || confirm.row !== row.dataset.spotKey) return;
    var key = confirm.key;
    morph(row, function () {
      confirm = null;
      paintConfirm(row);
    });
    if (!returnFocus) return;
    var kids = row.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].className !== 'trade-row-foot') continue;
      var act = kids[i].children[0];
      if (act && act.dataset && act.dataset.action + ':' + act.dataset.id === key && act.focus) act.focus();
    }
  }

  /* The post itself, to the human door. A refusal is the answer to this
     press and stays in the card; what the app answered is behind Details. A
     request that never came back is not a refusal, so it does not say
     nothing changed: it says to check. */
  function onGo(event) {
    var row = rowOf(event.currentTarget);
    if (!row || !confirm || confirm.row !== row.dataset.spotKey || confirm.phase === 'sending') return;
    var open = confirm;
    open.phase = 'sending';
    open.say = '';
    open.detail = '';
    paintConfirm(row);
    api.tradeAction({ action: open.action, id: open.id })
      .then(function () {
        if (confirm !== open) return;
        open.phase = 'sent';
        morph(row, function () { paintConfirm(row); });
        return refresh();
      })
      .catch(function (err) {
        if (confirm !== open) return;
        open.phase = 'failed';
        var noun = open.action === 'close' ? 'close' : 'cancel';
        var status = err && typeof err.status === 'number' ? err.status : null;
        if (status !== null && status >= 400 && status < 500) {
          open.say = 'The ' + noun + ' did not go through. Nothing changed.';
          open.detail = net.readable(err);
        } else if (status !== null) {
          open.say = 'The app could not confirm the ' + noun + '. Check ' + (open.action === 'close' ? 'the position' : 'the order') + ' before you try again.';
          open.detail = net.readable(err);
        } else {
          open.say = net.readable(err);
          open.detail = '';
        }
        morph(row, function () { paintConfirm(row); });
        var again = confirmButton(row, 'go');
        if (again && again.focus) again.focus();
      });
  }

  /* Escape inside an open confirm is Keep. */
  function onDeckKey(event) {
    if (event.key !== 'Escape' || !confirm) return;
    var row = rowOf(event.target);
    if (!row || row.dataset.spotKey !== confirm.row) return;
    event.preventDefault();
    closeConfirm(row, true);
  }

  /* ---------- names, logos and small readers ----------

     A market's name is the venue's own spelling: kPEPE is a thousand PEPE,
     and upper-casing it changes what the row says. The key the rows, the
     spotlight and the plans compare on is the upper-case form; the logo is
     the coin's own, with the k dropped. */
  function coinKey(coin) {
    return String(coin || '').toUpperCase();
  }

  function displayCoin(key, raw) {
    if (raw && String(raw).toUpperCase() === key) return String(raw);
    var lists = [
      data && Array.isArray(data.markets) ? data.markets.map(function (m) { return m.coin; }) : [],
      data && Array.isArray(data.positions) ? data.positions.map(function (p) { return p.coin; }) : [],
      products().map(coinOfProduct)
    ];
    for (var l = 0; l < lists.length; l += 1) {
      for (var i = 0; i < lists[l].length; i += 1) {
        if (String(lists[l][i] || '').toUpperCase() === key) return String(lists[l][i]);
      }
    }
    return key;
  }

  function logoCoin(key) {
    var raw = displayCoin(String(key || '').toUpperCase());
    return /^k[A-Z0-9]/.test(raw) ? raw.slice(1).toUpperCase() : String(key || '').toUpperCase();
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
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
