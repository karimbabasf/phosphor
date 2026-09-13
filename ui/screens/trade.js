/* Trade: the chart fills the world, a rail on its right.

   FOUR ZONES IN THE RAIL, ONE HIERARCHY. Status is what the account is: the
   coin, the mark, the free collateral and what the plans have put at risk. Open
   is what is running: each position with its profit and the distance to its
   exits. Waiting is what the app is holding for a condition: each plan as one
   English line with its conditions as dots. Done is what happened: fills and
   ended plans, one line each. Every zone is exactly as tall as what is in it, an
   empty zone is one line, and the room left under the last zone is plain rail
   ground. Karim, 2026-09-09, on the old four-card rail: "this layout overall
   just looks shit". Three of the four cards were empty and each empty one cost
   as much height as a full one.

   The two controls on the rail, Close and Cancel, are the only way a person
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

  /* How long a pressed Close or Cancel waits for its second press. */
  var CONFIRM_MS = 4000;
  /* How long a row that just appeared is marked as entering: the enter
     animation plus a beat, so a refresh landing mid-animation cannot cut it. */
  var ENTER_MS = 260;
  var DONE_ROWS = 20;

  function boot() {
    var host = document.getElementById('view-trade');
    if (!host) return;
    build(host);
    mounted = true;

    events.on('trade', function () { refresh(); });

    /* The chart engine's own boot wires listeners, starts a 5 s watchdog and a
       one second bar-close timer. None of that should run in a window whose
       owner never opens trade, so it starts the first time the view is on
       screen and never before. */
    window.addEventListener('phosphor:view', function (event) {
      if (!event.detail || event.detail.view !== 'trade') return;
      startChart();
      refresh();
    });
    if (window.PhosphorShell.view() === 'trade') {
      startChart();
      refresh();
    }

    events.on('candles', function () {
      if (charted && typeof window.candlesPushed === 'function') window.candlesPushed();
    });
    events.on('candle', function (frame) {
      if (charted && typeof window.candleLive === 'function') window.candleLive(frame);
    });
    events.on('chart', function (frame) {
      if (charted && typeof window.chartPushed === 'function') window.chartPushed(frame.rev);
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

    var resizer = dom.el('div', 'split-h');
    resizer.dataset.splitHandle = 'deck-rail';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.tabIndex = 0;

    var rail = dom.el('div', 'trade-rail');
    var status = zone('trade-status');
    var open = zone('trade-open', 'Open');
    var waiting = zone('trade-waiting', 'Waiting');
    var done = zone('trade-done', 'Done');
    waiting.body.className += ' scrolls';
    done.body.className += ' scrolls';

    rail.appendChild(status.node);
    rail.appendChild(open.node);
    rail.appendChild(waiting.node);
    rail.appendChild(done.node);

    wrap.appendChild(main);
    wrap.appendChild(resizer);
    wrap.appendChild(rail);
    host.appendChild(wrap);

    refs.rail = rail;
    refs.statusBody = status.body;
    refs.openBody = open.body;
    refs.waitingBody = waiting.body;
    refs.doneBody = done.body;

    refs.paintCuts = [cuts(waiting.body), cuts(done.body)];

    if (typeof window.splitBoot === 'function') window.splitBoot();
  }

  /* A zone is a heading and a body on the rail's own ground. It is deliberately
     not a .panel: four bordered cards down a 320 px rail is what made three
     empty answers cost as much room as the one full one. */
  function zone(name, title) {
    var node = dom.el('section', 'trade-zone ' + name);
    if (title) {
      var head = dom.el('div', 'trade-zone-head');
      head.appendChild(dom.el('h2', '', title));
      node.appendChild(head);
    }
    var body = dom.el('div', 'trade-zone-body');
    node.appendChild(body);
    return { node: node, body: body };
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

     One row: a segmented control holding the market and the six timeframes,
     the indicator command, Layers, and one status line on the right. What used
     to be a floating word, three chips and a venue cycling button is one
     control grammar at 26 px. Under 560 px the row wraps, on purpose. */
  function buildBar() {
    var bar = dom.el('div', 'chart-bar');

    /* The segment. The market is its first cell and the timeframes fill the
       rest: ui/chart/chart.js writes button.timeframe[data-sec] into
       #timeframes and marks the current one .on, which is the contract the
       segment styles against. */
    var seg = dom.el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Market and timeframe');
    seg.appendChild(symbolControl());
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
       latency beside it when the feed is live. The engine also appends its
       two situational controls here (back to live, clear the agent's
       drawings). */
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

    refs.latency = latency;
    return bar;
  }

  /* ---------- Layers ----------

     The seven overlays and the volume pane as check rows in one popover, with
     the venue that is serving the candles as its foot. A popover rather than
     a row of chips, because eight chips is a toolbar and the bar has room for
     one word. It scales in from its own corner over 150 ms and closes on
     Escape or a click anywhere else. */
  function layersControl() {
    var wrap = dom.el('div', 'layers-wrap');

    var button = dom.el('button', 'layers opens');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'chart-layers');
    button.appendChild(dom.el('span', '', 'Layers'));
    button.appendChild(dom.el('span', 'chev'));

    var pop = dom.el('div', 'layers-pop');
    pop.id = 'chart-layers';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', 'What the chart draws');
    pop.tabIndex = -1;

    var rows = dom.el('div', 'layers-rows');
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var row = layerRow(OVERLAYS[i].label);
      row.dataset.overlay = OVERLAYS[i].id;
      dom.on(row, 'click', onOverlayRow);
      rows.appendChild(row);
    }
    var volume = layerRow('Volume');
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

    dom.on(button, 'click', function () {
      if (pop.dataset.open === 'true') closeLayers();
      else openLayers();
    });
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || pop.dataset.open !== 'true') return;
      event.preventDefault();
      closeLayers();
    });
    /* A click anywhere else shuts it. Written as a walk rather than through
       contains(), because the unit harness's stand-in nodes have neither. */
    dom.on(document, 'click', function (event) {
      if (pop.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      closeLayers();
    });

    refs.layersButton = button;
    refs.layersPop = pop;
    refs.layerRows = rows;
    refs.volumeRow = volume;
    return wrap;
  }

  /* One check row: a drawn box and a word. aria-checked is the whole state. */
  function layerRow(label) {
    var row = dom.el('button', 'layers-row');
    row.type = 'button';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', 'true');
    row.appendChild(dom.el('i', 'layers-check'));
    row.appendChild(dom.el('span', '', label));
    return row;
  }

  function openLayers() {
    if (!refs.layersPop) return;
    renderOverlays();
    dom.setAttr(refs.layersPop, 'data-open', 'true');
    dom.setAttr(refs.layersButton, 'aria-expanded', 'true');
    var first = refs.layerRows && refs.layerRows.children[0];
    if (first && first.focus) first.focus();
  }

  function closeLayers() {
    if (!refs.layersPop) return;
    dom.setAttr(refs.layersPop, 'data-open', null);
    dom.setAttr(refs.layersButton, 'aria-expanded', 'false');
    if (refs.layersButton && refs.layersButton.focus) refs.layersButton.focus();
  }

  /* ---------- the market ----------

     This was a native <select>, so it drew OS chrome and was the one element on
     the surface that did not look finished. It is a listbox now, on the
     timeframe pills' own metrics, and it carries the window's whole opening
     grammar through .opens rather than half of it.

     It writes the focus to /api/trade, which sets the trading view's symbol AND
     the chart's product server side and broadcasts both, so one write moves the
     canvas and the rail together. Nothing here touches the chart engine. */
  function symbolControl() {
    var wrap = dom.el('div', 'trade-symbol-wrap');

    var button = dom.el('button', 'trade-symbol opens');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'trade-markets');
    button.setAttribute('aria-label', 'Which market');
    var label = dom.el('span', '', '--');
    button.appendChild(label);
    button.appendChild(dom.el('span', 'chev'));

    var menu = dom.el('div', 'trade-menu');
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
    /* A click anywhere else shuts it. Written as a walk rather than through
       contains(), because the unit harness's stand-in nodes have neither. */
    dom.on(document, 'click', function (event) {
      if (menu.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      closeMenu();
    });

    refs.symbolButton = button;
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
       overlay toggles are: the bar is never in a state the payload disagrees
       with, and a refusal arrives as the answer to this click. */
    data.symbol = coin;
    render();
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
    dom.setText(refs.symbolLabel, current || '--');
    dom.setAttr(refs.symbolButton, 'disabled', list.length ? null : true);
    dom.setAttr(refs.symbolMenu, 'aria-activedescendant', null);

    dom.reconcile(refs.symbolMenu, list, function (product) {
      return String(product);
    }, function () {
      var option = dom.el('div', 'trade-option');
      option.setAttribute('role', 'option');
      return option;
    }, function (option, product, i) {
      dom.setAttr(option, 'id', 'trade-market-' + i);
      option.dataset.product = product;
      dom.setText(option, product);
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

  function setChecked(row, on) {
    dom.setAttr(row, 'aria-checked', on ? 'true' : 'false');
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
    renderLatency();
    if (typeof window.chartInvalidate === 'function') window.chartInvalidate();
  }

  /* The venue's own round trip, written beside the state word the engine
     owns. The stylesheet shows it only while the feed reads live: a latency
     on a delayed feed is a number about the wrong thing. */
  function renderLatency() {
    if (!refs.latency) return;
    var venue = data && data.venue;
    var ms = venue && typeof venue.latencyMs === 'number' && isFinite(venue.latencyMs) ? Math.round(venue.latencyMs) : null;
    dom.setText(refs.latency, ms === null ? '' : ms + ' ms');
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
      })
      .catch(function (err) {
        console.error('[trade]', err);
      });
  }

  function render() {
    renderOverlays();
    renderSymbol();
    renderStatus();
    renderOpen();
    renderWaiting();
    renderDone();
    renderSpotlight();
    for (var i = 0; refs.paintCuts && i < refs.paintCuts.length; i += 1) refs.paintCuts[i]();
  }

  /* ---------- zone one: status ----------

     The coin, the mark, and three figures: what is free to put behind a plan,
     what the placed and open plans have posted, and the most they can lose at
     their stops. The mark is the biggest type on the surface and everything
     under it is quiet. Max loss is a line only when there is one: a zero there
     is not a fact anybody reads.

     Every name below is the payload's own: an Account is { accountKnown,
     freeUsd, atRiskUsd, maxLossUsd, ... }. */
  function renderStatus() {
    var host = refs.statusBody;
    dom.clear(host);

    var mark = dom.el('div', 'trade-mark');
    mark.appendChild(dom.el('span', 'trade-mark-coin', symbolOf() || 'Market'));
    var price = dom.el('span', 'trade-mark-price');
    dom.setText(price, priceText(markOf()));
    mark.appendChild(price);
    host.appendChild(mark);

    var account = data && data.account;

    /* A venue that is not answering has not said the account is empty, it has
       said nothing, and those are different sentences. So the line names the
       venue's own words and the figures under it read as unknown rather than as
       the empty state, which would be the window inventing a fact. */
    if (venueDown()) {
      host.appendChild(dom.el('p', 'trade-line warn', data.venue.error
        ? 'No route to the venue: ' + data.venue.error + '. The window keeps asking.'
        : 'No route to the venue. The window keeps asking.'));
      host.appendChild(accountFacts(account, true));
      return;
    }

    /* accountKnown is false until the feed has settled which kind of account
       this is, and every figure is null while it is. Waiting is not the same
       answer as empty, so it does not get the empty answer. */
    if (account && account.accountKnown === false) {
      host.appendChild(dom.el('p', 'trade-line', 'Still reading the account. The venue has not said what kind it is.'));
      return;
    }
    if (!funded()) {
      host.appendChild(dom.el('p', 'trade-line', 'No trading money yet. Ask your assistant to fund it.'));
      return;
    }

    host.appendChild(accountFacts(account, false));
  }

  /* The three figures a person reads first. `unknown` draws the free row
     whatever the payload holds, because a missing row and a row reading -- say
     different things and only the second one is true when the venue has gone
     quiet. At risk is the app's own sum over its own plans, so it stays a
     number either way. */
  function accountFacts(account, unknown) {
    var facts = dom.el('div', 'facts');
    var free = account && typeof account.freeUsd === 'number' ? dom.usd(account.freeUsd) : '';
    fact(facts, 'Free', free || (unknown ? '--' : ''));
    var atRisk = account && typeof account.atRiskUsd === 'number' ? account.atRiskUsd : 0;
    fact(facts, 'At risk', dom.usd(atRisk));
    var maxLoss = account && typeof account.maxLossUsd === 'number' ? account.maxLossUsd : 0;
    if (maxLoss > 0) fact(facts, 'Max loss', dom.usd(maxLoss));
    return facts;
  }

  function fact(host, label, value) {
    if (!value) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body mono', value));
    host.appendChild(row);
  }

  /* ---------- zone two: open ----------

     One row per position: the side and the coin as the title, the profit
     beside it, then size, entry and the distance to the stop and the target as
     signed percentages of the mark. The exits come from the open plan on that
     coin, or from the working triggers when no plan of this app's is behind
     the position. Close posts the plan's id, so a position with no plan has no
     button: there is no door for it.

     Every name below is the payload's: a Position is
     { coin, side, sizeCoin, notionalUsd, entryPx, markPx, liqPx, unrealisedUsd,
       ... }. */
  function renderOpen() {
    var host = refs.openBody;
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    if (!positions.length) {
      dom.clear(host);
      host.appendChild(empty('Nothing open.'));
      return;
    }
    dom.reconcile(host, positions, function (p) {
      return String(p.coin).toUpperCase();
    }, function (p) {
      var row = tradeRow('position', String(p.coin).toUpperCase());
      var head = dom.el('div', 'trade-row-head');
      head.appendChild(dom.el('span', 'trade-title'));
      head.appendChild(dom.el('span', 'trade-pnl mono'));
      row.appendChild(head);
      row.appendChild(dom.el('div', 'facts'));
      row.appendChild(dom.el('div', 'trade-row-foot'));
      return row;
    }, function (row, p) {
      var coin = String(p.coin).toUpperCase();
      var head = row.children[0];
      dom.setText(head.children[0], (p.side === 'short' ? 'Short ' : 'Long ') + coin);
      var pnl = head.children[1];
      var up = typeof p.unrealisedUsd === 'number' && p.unrealisedUsd >= 0;
      pnl.className = 'trade-pnl mono ' + (up ? 'up' : 'down');
      dom.setText(pnl, typeof p.unrealisedUsd === 'number' ? signedUsd(p.unrealisedUsd) : '');

      var facts = row.children[1];
      dom.clear(facts);
      fact(facts, 'Size', typeof p.sizeCoin === 'number' ? dom.qty(p.sizeCoin, precisionOf(coin)) : '');
      fact(facts, 'Entry', typeof p.entryPx === 'number' ? priceText(p.entryPx) : '');
      var exits = exitsOf(coin);
      var mark = typeof p.markPx === 'number' ? p.markPx : markFor(coin);
      fact(facts, 'Stop', distance(exits.stop, mark));
      fact(facts, 'Target', distance(exits.target, mark));

      var foot = row.children[2];
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

  /* ---------- zone three: waiting ----------

     Every plan that is not open and not done: an idea the agent drew, a plan
     waiting on its conditions, a plan whose entry rests on the venue. One
     English line each, built from the plan's own fields, so the sentence on
     the rail is the sentence on the chart. Under it the conditions as dots:
     filled when the watcher says it holds, hollow when it does not or when
     nothing is watching yet. Cancel is only offered where the host would take
     it, which is a waiting or a placed plan. */
  function renderWaiting() {
    var host = refs.waitingBody;
    var plans = plansOf().filter(function (p) {
      return p.status === 'idea' || p.status === 'waiting' || p.status === 'placed';
    });
    if (!plans.length) {
      dom.clear(host);
      host.appendChild(empty('Nothing waiting.'));
      return;
    }
    dom.reconcile(host, plans, function (p) {
      return String(p.id);
    }, function (p) {
      var row = tradeRow('plan', String(p.id));
      row.appendChild(dom.el('p', 'trade-row-line'));
      row.appendChild(dom.el('ul', 'trade-conds'));
      row.appendChild(dom.el('p', 'trade-row-state'));
      row.appendChild(dom.el('div', 'trade-row-foot'));
      return row;
    }, function (row, p) {
      dom.setText(row.children[0], planLine(p));

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

      var state = row.children[2];
      var said = planState(p);
      state.className = 'trade-row-state' + (said.warn ? ' warn' : '');
      dom.setText(state, said.text);
      dom.setHidden(state, !said.text);

      var foot = row.children[3];
      dom.clear(foot);
      if (p.status === 'waiting' || p.status === 'placed') foot.appendChild(actButton('Cancel', 'cancel', String(p.id)));
    });
  }

  /* "Long ETH $200 at 3x, market, stop 3,180, target 3,420". The shape a
     person can check against the chart in one look. */
  function planLine(plan) {
    var side = plan.side === 'short' ? 'Short' : 'Long';
    var bits = [side + ' ' + String(plan.symbol || '').toUpperCase() + ' ' + dom.usd(plan.sizeUsd, 0) + ' at ' + plan.leverage + 'x'];
    bits.push(entryWord(plan.entry));
    if (typeof plan.stop === 'number') bits.push('stop ' + planPx(plan.stop));
    if (typeof plan.target === 'number') bits.push('target ' + planPx(plan.target));
    return bits.join(', ');
  }

  function entryWord(entry) {
    if (!entry || typeof entry !== 'object') return 'market';
    if (entry.type === 'limit') return 'limit ' + planPx(entry.px);
    if (entry.type === 'stop') return 'stop entry ' + planPx(entry.px);
    return 'market';
  }

  function planPx(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  /* The conditions with what the watcher says about each. A waiting plan
     carries `holds` from the server, in the server's own words. An idea or a
     placed plan carries nothing, because nothing is watching it, so its
     conditions print from the plan itself in the same words and all hollow. */
  function conditionRows(plan) {
    if (Array.isArray(plan.holds)) {
      return plan.holds.map(function (h) {
        return { condition: String(h.condition || ''), holds: h.holds === true };
      });
    }
    var when = Array.isArray(plan.when) ? plan.when : [];
    return when.map(function (c) {
      return { condition: conditionText(c), holds: false };
    });
  }

  /* The same sentences src/trade/plan.ts renderCondition writes, so a plan
     reads the same before and after it is armed. Prices here are the plan's
     own digits, no separators, exactly as the server prints them. */
  function conditionText(c) {
    if (!c || typeof c !== 'object') return '';
    if (c.type === 'close') {
      var at = c.at && typeof c.at.px === 'number' ? String(c.at.px) : 'line ' + String(c.at && c.at.line || '');
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

  /* The one line under a plan that says what it is waiting on besides its
     conditions. Amber is this window's colour for waiting on a person, and a
     locked plan is exactly that: it re-arms on the next unlock. A blind one is
     waiting on the feed, which is the same kind of wait. */
  function planState(plan) {
    if (plan.status === 'idea') return { text: 'idea, not armed', warn: false };
    if (plan.locked === true) return { text: 'waiting, needs unlock', warn: true };
    if (plan.blind === true) return { text: 'waiting, feed stale', warn: true };
    if (plan.status === 'placed') return { text: 'placed, the venue holds the entry', warn: false };
    return { text: '', warn: false };
  }

  /* ---------- zone four: done ----------

     The only zone that grows, so it scrolls inside itself. Fills and ended
     plans in one tape, newest first, one line each, the last twenty. Nothing
     here animates in: the list is reconciled by key and a row that is already
     on screen keeps its identity. The host belongs to the reconciler, so
     nothing is appended under it that would have to be put back after every
     pass. */
  function renderDone() {
    var host = refs.doneBody;
    var rows = doneRows();
    if (!rows.length) {
      dom.clear(host);
      host.appendChild(empty('Nothing yet.'));
      return;
    }

    dom.reconcile(host, rows, function (row) {
      return row.key;
    }, function () {
      var node = dom.el('div', 'done-row');
      node.appendChild(dom.el('span', 'meta mono'));
      node.appendChild(dom.el('span', 'body grow truncate'));
      node.appendChild(dom.el('span', 'body mono'));
      return node;
    }, function (node, row) {
      node.dataset.spotKey = row.spotKey;
      dom.setText(node.children[0], dom.clock(row.at));
      dom.setText(node.children[1], row.text);
      dom.setAttr(node.children[1], 'title', row.title || null);
      node.children[2].className = 'body mono' + (row.dim ? ' dimmer' : '');
      dom.setText(node.children[2], row.tail);
    });
  }

  function doneRows() {
    var out = [];
    var fills = (data && Array.isArray(data.fills)) ? data.fills : [];
    for (var i = 0; i < fills.length; i += 1) {
      var fill = fills[i];
      /* The field names are the payload's own: a Fill is
         { tid, coin, side, px, sizeCoin, atMs, ... }. This read fill.sz, fill.size
         and fill.time, none of which the payload has ever carried, so every row
         said "Bought BTC 0" with no time beside it whatever had traded. */
      out.push({
        key: 'fill:' + (fill.tid || fill.atMs || '') + ':' + i,
        spotKey: 'fill:' + String(fill.tid || ''),
        at: fill.atMs,
        text: (fill.side === 'sell' || fill.side === 'A' ? 'Sold ' : 'Bought ')
          + (fill.coin || '') + ' ' + dom.qty(fill.sizeCoin, precisionOf(fill.coin)),
        tail: typeof fill.px === 'number' ? dom.usd(fill.px) : '',
        dim: false
      });
    }
    var plans = plansOf();
    for (var p = 0; p < plans.length; p += 1) {
      var plan = plans[p];
      if (plan.status !== 'done') continue;
      var ended = endedText(plan);
      out.push({
        key: 'plan:' + plan.id,
        spotKey: 'plan:' + plan.id,
        at: Date.parse(plan.updatedAt || plan.createdAt || '') || 0,
        text: ended.text,
        title: ended.title,
        tail: String(plan.id),
        dim: true
      });
    }
    out.sort(function (a, b) { return timeOf(b.at) - timeOf(a.at); });
    return out.slice(0, DONE_ROWS);
  }

  function timeOf(at) {
    var n = typeof at === 'number' ? at : Date.parse(String(at || ''));
    return isFinite(n) ? n : 0;
  }

  /* Why a plan ended, as the verb a person would use. A failure carries its
     reason on the line, because "failed" alone is the one word here that
     leaves a person with a question. */
  function endedText(plan) {
    var reason = String(plan.endReason || '');
    var who = (plan.side === 'short' ? 'short ' : 'long ') + String(plan.symbol || '').toUpperCase();
    var verbs = { stopped: 'Stopped', targeted: 'Hit target', closed: 'Closed', cancelled: 'Cancelled', expired: 'Expired' };
    if (Object.prototype.hasOwnProperty.call(verbs, reason)) return { text: verbs[reason] + ' ' + who, title: '' };
    if (reason.indexOf('failed:') === 0) {
      var why = reason.slice('failed:'.length).trim();
      return { text: 'Failed, ' + why, title: who + ': ' + why };
    }
    return { text: 'Ended ' + who, title: reason };
  }

  /* ---------- rows and the two controls ---------- */

  /* A row the agent can point at. The key is what a highlight names: the kind
     and the id, exactly as the payload carries them. A row that has just
     appeared enters; the mark comes off after the animation so a later pass
     can tell a new row from one that was already there. */
  function tradeRow(kind, id) {
    var row = dom.el('div', 'trade-row trade-enter');
    row.dataset.spotKey = kind + ':' + id;
    window.setTimeout(function () { row.classList.remove('trade-enter'); }, ENTER_MS);
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
     highlight. An object on the canvas is lit through chartSpotActive, which
     the engine asks as it draws each label.

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
    var reduced = !!(window.PhosphorMotion && window.PhosphorMotion.reduced());
    var rows = spotRows();
    var lit = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (spotActive[rows[i].dataset.spotKey] === true) lit += 1;
    }
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var on = spotActive[row.dataset.spotKey] === true;
      flag(row, 'spot', on);
      /* The rest of the rail steps back only when the pointer landed on the
         rail. A highlight on a chart level dims nothing here. */
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

  /* ---------- what the rail reads ---------- */

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
       zone that looks like a render that failed. */
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

  window.PhosphorTrade = { boot: boot, refresh: refresh };
})();
