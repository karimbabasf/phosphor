/* Trade: the chart fills the world, a rail on its right.

   THREE ZONES IN THE RAIL, NOT FOUR CARDS. Karim, 2026-09-09, on a screenshot
   of the old build: "this layout overall just looks shit". Three of the four
   cards were empty in that shot, and each empty one spent a heading, a centred
   title and a sentence saying so, so an empty panel cost as much height as a
   full one and the single panel carrying real data was squeezed into the bottom.

   What the account IS sits at the top, dense, with the mark price as the
   biggest thing on the surface. What is RUNNING is under it: the open position
   and the armed rules are one question, not two panels. What has HAPPENED takes
   every pixel that is left and scrolls inside itself. A routine empty state is
   one line; the sentence that explains the surface is kept for a person who has
   never seen it.

   The chart engine is not rewritten here: its chrome takes the window's tokens
   and its canvas takes the window's palette. Three overlay toggles, not seven. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;

  var refs = {};
  var mounted = false;
  var data = null;

  var OVERLAYS = [
    { id: 'position', label: 'Position' },
    { id: 'liquidation', label: 'Forced close' },
    { id: 'mandateWall', label: 'Rule wall' }
  ];

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
  }

  var charted = false;

  function startChart() {
    if (charted) return;
    if (typeof window.chartBoot !== 'function') return;
    charted = true;
    window.chartBoot();
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
    var running = zone('trade-running', 'Running');
    var fills = zone('trade-fills', 'What happened');
    running.body.className += ' scrolls';
    fills.body.className += ' scrolls';

    rail.appendChild(status.node);
    rail.appendChild(running.node);
    rail.appendChild(fills.node);

    wrap.appendChild(main);
    wrap.appendChild(resizer);
    wrap.appendChild(rail);
    host.appendChild(wrap);

    refs.statusBody = status.body;
    refs.runningBody = running.body;
    refs.runningNote = running.note;
    refs.fillsBody = fills.body;

    refs.paintCuts = [cuts(running.body), cuts(fills.body)];

    if (typeof window.splitBoot === 'function') window.splitBoot();
  }

  /* A zone is a heading and a body on the rail's own ground. It is deliberately
     not a .panel: four bordered cards down a 320 px rail is what made three
     empty answers cost as much room as the one full one. */
  function zone(name, title) {
    var node = dom.el('section', 'trade-zone ' + name);
    var note = null;
    if (title) {
      var head = dom.el('div', 'trade-zone-head');
      head.appendChild(dom.el('h2', '', title));
      note = dom.el('span', 'trade-zone-note');
      head.appendChild(note);
      node.appendChild(head);
    }
    var body = dom.el('div', 'trade-zone-body');
    node.appendChild(body);
    return { node: node, body: body, note: note };
  }

  /* A region that scrolls inside itself says where it was cut, so a fill sliced
     in half is drawn as a fill sliced in half rather than as the end of the
     tape, and a second armed rule under the fold is visibly under the fold. The
     same reading the dashboards use. */
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

  /* ---------- the bar above the chart ---------- */

  /* Two halves with a rule between them: what the chart is OF on the left, what
     is drawn ON it on the right. They used to be one undifferentiated row, so
     three buttons named after rail panels read as navigation to those panels. */
  function buildBar() {
    var bar = dom.el('div', 'chart-bar');

    var left = dom.el('div', 'trade-bar-group');
    left.appendChild(symbolControl());
    var timeframes = dom.el('div', 'hstack-2');
    timeframes.id = 'timeframes';
    left.appendChild(timeframes);
    bar.appendChild(left);

    bar.appendChild(dom.el('div', 'trade-bar-div'));

    var right = dom.el('div', 'trade-bar-group');
    var cmd = dom.el('input', 'input chart-cmd');
    cmd.id = 'chart-cmd';
    cmd.type = 'text';
    cmd.placeholder = 'Indicators';
    cmd.setAttribute('aria-label', 'What should the chart show');
    right.appendChild(cmd);

    /* The word says what the row is for. Without it three pressed pills read as
       three places to go rather than as three things the chart is drawing, so it
       travels with them: on a narrow window the group wraps whole rather than
       leaving the word stranded beside the field above. */
    var draw = dom.el('div', 'trade-draw');
    draw.appendChild(dom.el('span', 'trade-bar-label', 'Draw'));
    var toggles = dom.el('div', 'hstack-2');
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var toggle = dom.el('button', 'chip trade-toggle');
      toggle.type = 'button';
      toggle.dataset.overlay = OVERLAYS[i].id;
      setToggle(toggle, true);
      toggle.appendChild(dom.el('span', 'dot'));
      toggle.appendChild(dom.el('span', '', OVERLAYS[i].label));
      toggles.appendChild(toggle);
      dom.on(toggle, 'click', onToggle);
    }
    draw.appendChild(toggles);
    right.appendChild(draw);
    bar.appendChild(right);

    /* The status cluster the chart engine drives: one dot that answers "is this
       price current", and the venue it came from. It replaced three loading
       blocks and a meta line that each said part of the same thing. */
    var status = dom.el('span', 'chartstatus grow');
    status.id = 'chart-status';
    var feed = dom.el('span', 'feed');
    feed.id = 'chart-feed';
    feed.dataset.feed = 'offline';
    feed.setAttribute('role', 'status');
    feed.appendChild(dom.el('i'));
    feed.appendChild(dom.el('b', '', 'offline'));
    status.appendChild(feed);
    var venue = dom.el('button', 'venue');
    venue.id = 'chart-provider';
    venue.type = 'button';
    venue.textContent = '--';
    status.appendChild(venue);
    bar.appendChild(status);

    refs.toggles = toggles;
    return bar;
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
     These three used to write a window global instead, and nothing has ever read
     it, so pressing one moved nothing on the chart. The toggle flips at once and
     rolls back if the write is refused, so the control is never in a state the
     payload disagrees with. */
  function onToggle(event) {
    var button = event.currentTarget;
    var on = button.getAttribute('aria-pressed') !== 'true';
    setToggle(button, on);
    net.postJson('/api/trade', { overlay: { name: button.dataset.overlay, on: on } })
      .then(function () { return refresh(); })
      .catch(function (err) {
        setToggle(button, !on);
        if (window.PhosphorToast) window.PhosphorToast.show(net.readable(err), 'down');
      });
  }

  /* aria-pressed is the whole state. It used to also carry a tone attribute that
     painted the pressed one like a chip carrying a status, which is what made a
     toggle read as a label. */
  function setToggle(button, on) {
    dom.setAttr(button, 'aria-pressed', on ? 'true' : 'false');
  }

  /* What the payload says is on, not what this window last pressed: an agent can
     move an overlay too, and the toggles follow it. */
  function renderOverlays() {
    var overlays = data && data.overlays;
    if (!overlays || !refs.toggles) return;
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var button = refs.toggles.children[i];
      if (button) setToggle(button, overlays[OVERLAYS[i].id] !== false);
    }
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
      })
      .catch(function (err) {
        console.error('[trade]', err);
      });
  }

  function render() {
    renderOverlays();
    renderSymbol();
    renderStatus();
    renderRunning();
    renderFills();
    for (var i = 0; refs.paintCuts && i < refs.paintCuts.length; i += 1) refs.paintCuts[i]();
  }

  /* ---------- zone one: what the account is ----------

     Mark price and the account's health are what a person looks at first, so
     the mark is the biggest type on the surface and everything under it is
     quiet. The figures are a facts grid rather than a card: a 320 px rail has
     no room to spend a border and two paddings on four numbers.

     Every name below is the payload's own: an Account is { accountKnown,
     equityUsd, freeUsd, healthPct, unified }. This read equity, free and health,
     so the funded check never passed and a funded account was told it had no
     trading money in it. */
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
      host.appendChild(dom.el('p', 'trade-line', firstRun()
        ? 'No trading money yet. Ask your assistant to fund the trading account, and it will ask you first.'
        : 'No trading money yet. Ask your assistant to fund it.'));
      return;
    }

    host.appendChild(accountFacts(account, false));

    if (typeof account.healthPct === 'number') {
      var meter = dom.el('div', 'meter');
      var fill = dom.el('div', 'meter-fill');
      fill.style.width = Math.max(0, Math.min(1, account.healthPct)) * 100 + '%';
      if (account.healthPct < 0.3) fill.dataset.tone = 'down';
      else if (account.healthPct < 0.5) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      host.appendChild(meter);
    } else if (account.unified) {
      /* The venue publishes no whole-account health figure for a unified
         account, and the formula for one needs per-token numbers this feed does
         not carry. Approximating a margin number is the one thing not to do
         here, so the rail says there is not one. */
      host.appendChild(dom.el('p', 'trade-line',
        'This is a unified account, so the venue publishes no single safety margin for it.'));
    }
  }

  /* ---------- zone two: what is running ----------

     The position and the rules are one question: is anything of mine moving,
     and under what. They were two panels, and with nothing open and nothing
     armed that was two headings, two centred titles and two sentences, which is
     six lines to say nothing twice. */
  function renderRunning() {
    var host = refs.runningBody;
    dom.clear(host);
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    var mandates = (data && Array.isArray(data.mandates)) ? data.mandates : [];

    dom.setText(refs.runningNote, mandates.length
      ? mandates.length + (mandates.length === 1 ? ' rule armed' : ' rules armed')
      : '');

    if (!positions.length) {
      host.appendChild(dom.el('p', 'trade-line', 'Nothing is open.'));
    }
    for (var i = 0; i < positions.length; i += 1) host.appendChild(positionBlock(positions[i]));

    if (!mandates.length) {
      /* The sentence that says what this surface is for is kept for the one
         person who needs it: somebody who has never seen it. Everybody else has
         read it already and is here to see a number. */
      host.appendChild(dom.el('p', 'trade-line', firstRun()
        ? 'No rules are armed. A rule your assistant armed is the only thing that opens or closes anything here.'
        : 'No rules are armed.'));
    }
    for (var m = 0; m < mandates.length; m += 1) host.appendChild(mandateBlock(mandates[m]));
  }

  /* Position carries what the BOOK panel used to say. The forced close price and
     the distance to it are one line, and the distance is the server's own figure
     rather than a second one worked out here from two prices.

     Every name below is the payload's: a Position is
     { coin, side, sizeCoin, notionalUsd, entryPx, markPx, liqPx, unrealisedUsd,
       liqReachable, liqDistancePct, ... }. This read valueUsd, size,
     unrealizedPnl, liquidationPx and product, none of which the payload has ever
     carried, so an open position drew a heading, an entry and a mark and nothing
     else: no value, no size, no profit and no forced-close line. */
  function positionBlock(p) {
    var block = dom.el('div', 'stack-2');
    var top = dom.el('div', 'between');
    top.appendChild(dom.el('span', 'trade-strong', (p.side === 'short' ? 'Short ' : 'Long ') + (p.coin || '')));
    var value = dom.el('span', 'body mono');
    dom.setText(value, typeof p.notionalUsd === 'number' ? dom.usd(p.notionalUsd) : '');
    top.appendChild(value);
    block.appendChild(top);

    var facts = dom.el('div', 'facts');
    fact(facts, 'Size', typeof p.sizeCoin === 'number' ? dom.qty(p.sizeCoin) : '');
    fact(facts, 'Entry', typeof p.entryPx === 'number' ? dom.usd(p.entryPx) : '');
    if (typeof p.unrealisedUsd === 'number') {
      var pnl = dom.el('div', 'fact');
      pnl.appendChild(dom.el('span', 'label', 'Up or down'));
      var amount = dom.el('span', 'body mono ' + (p.unrealisedUsd >= 0 ? 'up' : 'down'));
      dom.setText(amount, dom.usd(p.unrealisedUsd));
      pnl.appendChild(amount);
      facts.appendChild(pnl);
    }
    block.appendChild(facts);
    block.appendChild(liquidationLine(p));
    return block;
  }

  /* liqReachable false means the collateral behind this position is bigger than
     the position, so no price the venue can reach takes it and the server leaves
     the three distances empty on purpose. Null means the venue has published no
     liquidation price yet. Neither of those is "no risk", so neither prints a
     number, and neither is left silent either. */
  function liquidationLine(p) {
    if (p.liqReachable === false) {
      return dom.el('p', 'meta', 'Nothing can force this closed at the size it is.');
    }
    if (typeof p.liqPx !== 'number') {
      return dom.el('p', 'meta', 'The venue has not published a forced close price for this yet.');
    }
    var line = dom.el('p', 'trade-line warn');
    /* liqDistancePct is already a percentage: the server sends gap * 100 / mark.
       dom.pct multiplies by a hundred, so it would report 12% as 1,200%. */
    dom.setText(line, 'Forced close at ' + dom.usd(p.liqPx)
      + (typeof p.liqDistancePct === 'number' ? ', ' + p.liqDistancePct.toFixed(1) + '% away' : ''));
    return line;
  }

  function mandateBlock(m) {
    var block = dom.el('div', 'stack-2');
    /* english is the rule in sentences, and it is the whole point of a
       mandate: a person approved words, not a program hash. This read a
       summary key the payload has never carried, so every armed rule rendered
       as its bare id with no budget under it. */
    var said = Array.isArray(m.english) ? m.english : [];
    if (said.length) {
      for (var s = 0; s < said.length; s += 1) block.appendChild(dom.el('p', 'trade-line strong', said[s]));
    } else {
      block.appendChild(dom.el('p', 'trade-line strong', m.id || 'A rule'));
    }
    var spent = m.used && typeof m.used.notionalUsd === 'number' ? m.used.notionalUsd : null;
    var budget = m.envelope && typeof m.envelope.maxNotionalUsd === 'number'
      ? m.envelope.maxNotionalUsd
      : null;
    if (spent !== null && budget !== null && budget > 0) {
      var top = dom.el('div', 'between');
      top.appendChild(dom.el('span', 'meta', 'Budget'));
      var used = dom.el('span', 'meta mono');
      dom.setText(used, dom.usd(spent) + ' of ' + dom.usd(budget, 0));
      top.appendChild(used);
      block.appendChild(top);
      var meter = dom.el('div', 'meter');
      var fill = dom.el('div', 'meter-fill');
      fill.style.width = Math.min(1, spent / budget) * 100 + '%';
      if (spent > 0) fill.dataset.spent = 'true';
      meter.appendChild(fill);
      block.appendChild(meter);
    }
    return block;
  }

  /* ---------- zone three: what happened ----------

     The only zone that grows. Fills arrive constantly, so nothing here animates
     in: the list is reconciled by key and a row that is already on screen keeps
     its identity. The host belongs to the reconciler, so nothing is appended
     under it that would have to be put back after every pass. */
  function renderFills() {
    var host = refs.fillsBody;
    var rows = (data && Array.isArray(data.fills)) ? data.fills.slice(0, 40) : [];
    if (!rows.length) {
      dom.clear(host);
      host.appendChild(dom.el('p', 'trade-line', firstRun()
        ? 'Nothing yet. Fills and cancels land here as they happen.'
        : 'Nothing yet.'));
      return;
    }

    dom.reconcile(host, rows, function (fill, i) {
      return (fill.tid || fill.atMs || '') + ':' + i;
    }, function () {
      var row = dom.el('div', 'between fill-row');
      row.appendChild(dom.el('span', 'meta mono'));
      row.appendChild(dom.el('span', 'body grow truncate'));
      row.appendChild(dom.el('span', 'body mono'));
      return row;
    }, function (row, fill) {
      /* The field names are the payload's own: a Fill is
         { tid, coin, side, px, sizeCoin, atMs, ... }. This read fill.sz, fill.size
         and fill.time, none of which the payload has ever carried, so every row
         said "Bought BTC 0" with no time beside it whatever had traded. */
      dom.setText(row.children[0], dom.clock(fill.atMs));
      dom.setText(row.children[1], (fill.side === 'sell' || fill.side === 'A' ? 'Sold ' : 'Bought ')
        + (fill.coin || '') + ' ' + dom.qty(fill.sizeCoin, precisionOf(fill.coin)));
      dom.setText(row.children[2], typeof fill.px === 'number' ? dom.usd(fill.px) : '');
    });
  }

  /* ---------- what the rail reads ---------- */

  /* The mark for the market the surface is focused on. markets[] is the venue's
     own list and carries it whether or not anything is open; a position on the
     same market carries the identical number, and is the fallback for the frame
     before the market list has landed. */
  function markOf() {
    var symbol = symbolOf();
    if (!symbol) return null;
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

  /* Somebody who has never seen this screen gets the sentence that says what it
     is for. Nothing held, nothing armed, nothing traded and no money is the only
     state that can mean that. */
  function firstRun() {
    if (!data) return true;
    if (Array.isArray(data.positions) && data.positions.length) return false;
    if (Array.isArray(data.mandates) && data.mandates.length) return false;
    if (Array.isArray(data.fills) && data.fills.length) return false;
    return !funded();
  }

  /* How many places this asset actually trades in, off the venue's own metadata.
     Undefined when the market is not in the payload, which leaves dom.qty on its
     general rule; either way it never prints a real size as zero. */
  function precisionOf(coin) {
    var markets = (data && Array.isArray(data.markets)) ? data.markets : [];
    for (var i = 0; i < markets.length; i += 1) {
      if (markets[i].coin !== coin) continue;
      return typeof markets[i].szDecimals === 'number' ? markets[i].szDecimals : undefined;
    }
    return undefined;
  }

  /* The three figures a person reads first. `unknown` draws the row whatever the
     payload holds, because a missing row and a row reading -- say different
     things and only the second one is true when the venue has gone quiet. */
  function accountFacts(account, unknown) {
    var facts = dom.el('div', 'facts');
    var equity = account && typeof account.equityUsd === 'number' ? dom.usd(account.equityUsd) : '';
    var free = account && typeof account.freeUsd === 'number' ? dom.usd(account.freeUsd) : '';
    var health = account && typeof account.healthPct === 'number' ? dom.pct(account.healthPct) : '';
    fact(facts, 'Trading money', equity || (unknown ? '--' : ''));
    fact(facts, 'Spare', free || (unknown ? '--' : ''));
    fact(facts, 'Safety margin', health || (unknown ? '--' : ''));
    return facts;
  }

  function fact(host, label, value) {
    if (!value) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body mono', value));
    host.appendChild(row);
  }

  window.PhosphorTrade = { boot: boot, refresh: refresh };
})();
