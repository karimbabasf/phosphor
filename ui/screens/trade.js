/* Trade: full bleed, chart on the left, a 360 px rail on the right.

   Five things in the rail: Position, Account, Your rules, What happened, Your
   assistant. The BOOK panel is merged into Position, the MARKET block is gone
   with its eight derived restatements, and ACCOUNT is three figures rather
   than eleven. Three overlay toggles, not seven. */
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
    { id: 'mandateWall', label: 'Rules' }
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

    /* The chart control row: market, timeframes, indicators, then the feed. */
    var bar = dom.el('div', 'chart-bar');
    var product = dom.el('select', 'input chart-select');
    product.id = 'product';
    bar.appendChild(product);
    var timeframes = dom.el('div', 'hstack-2');
    timeframes.id = 'timeframes';
    bar.appendChild(timeframes);
    var cmd = dom.el('input', 'input chart-cmd');
    cmd.id = 'chart-cmd';
    cmd.type = 'text';
    cmd.placeholder = 'Indicators';
    bar.appendChild(cmd);
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

    var toggles = dom.el('div', 'hstack-2');
    for (var i = 0; i < OVERLAYS.length; i += 1) {
      var toggle = dom.el('button', 'chip');
      toggle.type = 'button';
      toggle.dataset.overlay = OVERLAYS[i].id;
      toggle.setAttribute('aria-pressed', 'true');
      toggle.dataset.tone = 'ink';
      toggle.appendChild(dom.el('span', '', OVERLAYS[i].label));
      toggles.appendChild(toggle);
      dom.on(toggle, 'click', onToggle);
    }
    bar.appendChild(toggles);
    main.appendChild(bar);

    /* Three toggles, all on. The old build shipped seven with six defaulting to
       on, which made the row chrome rather than a control. */
    window.TRADE_OVERLAYS = { position: true, liquidation: true, mandateWall: true };

    /* The stage. Every id the chart engine looks for lives here. The in-flight
       signal the old trade page never had is now the feed dot in the bar
       above, which the engine sets busy while a read is out. */
    var stage = dom.el('div', 'chart-stage');
    stage.id = 'panel-chart';
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

    var position = panel('Position');
    var account = panel('Account');
    var rules = panel('Your rules');
    var happened = panel('What happened');
    var assistant = panel('');
    assistant.head.hidden = true;
    assistant.node.classList.add('grow');

    rail.appendChild(position.node);
    rail.appendChild(account.node);
    rail.appendChild(rules.node);
    rail.appendChild(happened.node);
    rail.appendChild(assistant.node);

    wrap.appendChild(main);
    wrap.appendChild(resizer);
    wrap.appendChild(rail);
    host.appendChild(wrap);

    refs = {
      positionBody: position.body,
      accountBody: account.body,
      rulesBody: rules.body,
      happenedBody: happened.body,
      toggles: toggles,
      status: status
    };

    window.PhosphorAgent.mount(assistant.body, { compact: true });
    if (typeof window.splitBoot === 'function') window.splitBoot();
  }

  function panel(title) {
    var node = dom.el('section', 'panel');
    var head = dom.el('div', 'panel-head');
    head.appendChild(dom.el('h2', 'title-sm', title));
    var body = dom.el('div', 'panel-body stack');
    node.appendChild(head);
    node.appendChild(body);
    return { node: node, head: head, body: body };
  }

  function onToggle(event) {
    var button = event.currentTarget;
    var on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.setAttr(button, 'data-tone', on ? 'ink' : null);
    if (!window.TRADE_OVERLAYS) window.TRADE_OVERLAYS = {};
    window.TRADE_OVERLAYS[button.dataset.overlay] = on;
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
    renderPosition();
    renderAccount();
    renderRules();
    renderHappened();
  }

  /* Position carries what the BOOK panel used to say. The forced close price
     and the distance to it are one line, not four spellings of one number. */
  function renderPosition() {
    var host = refs.positionBody;
    dom.clear(host);
    var positions = (data && Array.isArray(data.positions)) ? data.positions : [];
    if (!positions.length) {
      host.appendChild(emptyBlock('Nothing is open', 'A rule your assistant armed is the only thing that opens a position.'));
      return;
    }

    for (var i = 0; i < positions.length; i += 1) {
      var p = positions[i];
      var block = dom.el('div', 'stack-2');
      var top = dom.el('div', 'between');
      top.appendChild(dom.el('span', 'title-sm', (p.side === 'short' ? 'Short ' : 'Long ') + (p.coin || p.product || '')));
      var value = dom.el('span', 'body mono');
      dom.setText(value, typeof p.valueUsd === 'number' ? dom.usd(p.valueUsd) : '');
      top.appendChild(value);
      block.appendChild(top);

      var facts = dom.el('div', 'facts');
      fact(facts, 'Size', typeof p.size === 'number' ? dom.qty(p.size) : '');
      fact(facts, 'Entry', typeof p.entryPx === 'number' ? dom.usd(p.entryPx) : '');
      fact(facts, 'Mark', typeof p.markPx === 'number' ? dom.usd(p.markPx) : '');
      if (typeof p.unrealizedPnl === 'number') {
        var pnl = dom.el('div', 'fact');
        pnl.appendChild(dom.el('span', 'label', 'Up or down'));
        var amount = dom.el('span', 'body mono ' + (p.unrealizedPnl >= 0 ? 'up' : 'down'));
        dom.setText(amount, dom.usd(p.unrealizedPnl));
        pnl.appendChild(amount);
        facts.appendChild(pnl);
      }
      block.appendChild(facts);

      if (typeof p.liquidationPx === 'number') {
        var away = typeof p.markPx === 'number' && p.markPx
          ? Math.abs(p.markPx - p.liquidationPx) / p.markPx
          : null;
        var line = dom.el('p', 'body warn');
        dom.setText(line, 'Forced close at ' + dom.usd(p.liquidationPx)
          + (away === null ? '' : ', ' + dom.pct(away) + ' away'));
        block.appendChild(line);
      }
      host.appendChild(block);
    }
  }

  /* Three figures. Maintenance margin, net and gross exposure and the shock
     line are gone: the safety margin bar already encodes the headroom. */
  function renderAccount() {
    var host = refs.accountBody;
    dom.clear(host);
    var account = data && data.account;
    /* An account object with no numbers in it is the same thing to a person as
       no account at all, so it gets the same sentence rather than an empty
       panel that looks like a render that failed. */
    var funded = account && (typeof account.equity === 'number'
      || typeof account.free === 'number'
      || typeof account.health === 'number');
    if (!funded) {
      host.appendChild(emptyBlock('No trading money yet',
        'Ask your assistant to fund the trading account, and it will ask you first.'));
      return;
    }
    var facts = dom.el('div', 'facts');
    fact(facts, 'Trading money', typeof account.equity === 'number' ? dom.usd(account.equity) : '');
    fact(facts, 'Spare', typeof account.free === 'number' ? dom.usd(account.free) : '');
    host.appendChild(facts);

    if (typeof account.health === 'number') {
      var wrap = dom.el('div', 'stack-2');
      var top = dom.el('div', 'between');
      top.appendChild(dom.el('span', 'label', 'Safety margin'));
      var value = dom.el('span', 'body mono');
      dom.setText(value, dom.pct(account.health));
      top.appendChild(value);
      wrap.appendChild(top);
      var meter = dom.el('div', 'meter');
      var fill = dom.el('div', 'meter-fill');
      fill.style.width = Math.max(0, Math.min(1, account.health)) * 100 + '%';
      if (account.health < 0.3) fill.dataset.tone = 'down';
      else if (account.health < 0.5) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      wrap.appendChild(meter);
      host.appendChild(wrap);
    }
  }

  function renderRules() {
    var host = refs.rulesBody;
    dom.clear(host);
    var mandates = (data && Array.isArray(data.mandates)) ? data.mandates : [];
    if (!mandates.length) {
      host.appendChild(emptyBlock('No rules are armed', 'A rule is the only way anything opens or closes here.'));
      return;
    }
    for (var i = 0; i < mandates.length; i += 1) {
      var m = mandates[i];
      var block = dom.el('div', 'stack-2');
      block.appendChild(dom.el('p', 'body', m.summary || m.id || 'A rule'));
      if (typeof m.spentUsd === 'number' && typeof m.budgetUsd === 'number' && m.budgetUsd > 0) {
        var top = dom.el('div', 'between');
        top.appendChild(dom.el('span', 'meta', 'Budget'));
        var used = dom.el('span', 'meta mono');
        dom.setText(used, dom.usd(m.spentUsd) + ' of ' + dom.usd(m.budgetUsd, 0));
        top.appendChild(used);
        block.appendChild(top);
        var meter = dom.el('div', 'meter');
        var fill = dom.el('div', 'meter-fill');
        fill.style.width = Math.min(1, m.spentUsd / m.budgetUsd) * 100 + '%';
        meter.appendChild(fill);
        block.appendChild(meter);
      }
      host.appendChild(block);
    }
  }

  function renderHappened() {
    var host = refs.happenedBody;
    var rows = (data && Array.isArray(data.fills)) ? data.fills.slice(0, 20) : [];
    if (!rows.length) {
      dom.clear(host);
      host.appendChild(emptyBlock('Nothing yet', 'Fills and cancels land here as they happen.'));
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

  function emptyBlock(title, note) {
    var empty = dom.el('div', 'empty');
    empty.appendChild(dom.el('p', 'empty-title', title));
    empty.appendChild(dom.el('p', '', note));
    return empty;
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
