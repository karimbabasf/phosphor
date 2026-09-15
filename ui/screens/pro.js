/* Pro: a 12-column grid at most 1440 wide, for a person who already holds
   crypto and wants to see everything and set the rules.

   Four panels on a full-height grid, and none of them starts shut. Three of
   them used to, so the screen a person landed on was one open panel and three
   title bars over half a page of nothing, and a shut panel head looked exactly
   like a static one, so nothing on the deck read as clickable either. Karim,
   2026-09-09: "nothing clickable, nothing unclickable ... has to be dynamic and
   always fill the blank spaces."

   A panel now carries its content. The grid is two rows, the second one grows
   to close the page, and anything taller than its box scrolls inside the box
   with a fade at the cut rather than pushing the page down. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;
  var marks = window.PhosphorMarks;

  /* How long a Money row stays marked after its figure moved: the digits roll,
     the ground tints in the coin's colour and the change sits beside the
     value, then all three settle. Long enough to be seen from the corner of
     an eye, short enough that two frames in a row read as two changes. */
  var CHANGED_MS = 1200;

  /* The trading venue is a second feed, not part of the state frame, so this
     screen asks for it on its own clock and only while it is the visible one. */
  var TRADE_POLL_MS = 20000;

  var refs = {};
  var mounted = false;

  /* What the venue last said, and whether the last ask worked. A number from a
     read that failed is not a number this panel is allowed to print. */
  var trade = { data: null, failed: false, reason: '' };

  /* 'intents' is a place like any other as far as the wallet is concerned, and
     it reached the screen as the raw id in the one sentence that names a place
     a person has to act on. */
  var CHAIN_NAMES = {
    eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR',
    intents: 'NEAR Intents', hyperliquid: 'Hyperliquid'
  };

  /* Allowlist entries that are venues rather than addresses. The policy stores
     the id it checks against; the window shows the name a person knows it by. */
  var VENUE_NAMES = {
    'oneclick:1click.chaindefuser.com': '1Click',
    'intents.near': 'NEAR Intents',
    'hyperliquid-perps': 'Hyperliquid'
  };

  /* One glyph per kind of rule on the Policy card, so a person can tell an ask
     from a refusal before reading it: a hand for what gets asked, a wall for
     what gets refused, a stack of coins for what is held back, a door for
     where money may go. Strokes on a 0 0 16 16 box in currentColor, drawn
     here so the window loads no icon set. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GLYPHS = {
    /* The same drawing as Basic's rules strip (ui/screens/basic.js HAND), so
       the ask rule reads as one thing on both screens. */
    hand: [
      'M4.75 9V4.75a1.25 1.25 0 0 1 2.5 0V8.5M7.25 8.5V3.25a1.25 1.25 0 0 1 2.5 0V8.5M9.75 8.5V4.25a1.25 1.25 0 0 1 2.5 0V10.5M4.75 9l-1.3-1.3a1.24 1.24 0 0 0-1.75 1.75L5 12.75A4.25 4.25 0 0 0 8 14h1.25a3 3 0 0 0 3-3v-.5'
    ],
    wall: [
      'M3.75 3.75h8.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1z',
      'M2.75 6.6h10.5M2.75 9.4h10.5',
      'M8 3.75v2.85M5.4 6.6v2.8M10.6 6.6v2.8M8 9.4v2.85'
    ],
    coin: [
      'M8 6.5c3.2 0 5.25-1 5.25-2.25S11.2 2 8 2 2.75 3 2.75 4.25 4.8 6.5 8 6.5z',
      'M2.75 4.25V8c0 1.25 2.05 2.25 5.25 2.25S13.25 9.25 13.25 8V4.25',
      'M2.75 8v3.75C2.75 13 4.8 14 8 14s5.25-1 5.25-2.25V8'
    ],
    door: [
      'M12 13.33V4a1.33 1.33 0 0 0-1.33-1.33H5.33A1.33 1.33 0 0 0 4 4v9.33',
      'M1.33 13.33h13.33',
      'M9.33 8v.01'
    ]
  };

  /* Built in the svg namespace rather than by innerHTML, the way dom.mark does
     it. Null where there is no namespace to build in (the unit harness), and
     the rule draws without its glyph. */
  function glyph(name) {
    var paths = GLYPHS[name];
    if (!paths || typeof document.createElementNS !== 'function') return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (var i = 0; i < paths.length; i += 1) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }

  function boot() {
    var host = document.getElementById('view-pro');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    window.PhosphorReceipts.onChange(function () {
      if (refs.activityBody) {
        window.PhosphorReceipts.render(refs.activityBody, { limit: 25 });
        renderFeeTotal();
        refs.activityCut();
      }
    });
    loadTrade();
    window.setInterval(function () {
      if (document.hidden) return;
      if (document.body.dataset.view !== 'pro') return;
      loadTrade();
    }, TRADE_POLL_MS);
  }

  function build(host) {
    var grid = dom.el('div', 'pro-grid pro-dense');

    /* Money: one row per COIN, with the places it sits in folded under it.
       It used to be one flat row per holding, so ETH in four places was four
       rows that a person had to add up themselves to answer "how much ETH do I
       have", and the coin they own was never on screen as one thing. */
    var money = panel('Money', 'span-7', 'holdings');
    var bar = dom.el('div', 'comp-bar');
    bar.setAttribute('aria-hidden', 'true');
    money.body.appendChild(bar);
    var moneyList = dom.el('div', 'holding-list scrolls');
    money.body.appendChild(moneyList);
    var emptyNote = dom.el('p', 'meta');
    money.body.appendChild(emptyNote);
    grid.appendChild(money.node);

    /* Trading. Phosphor reaches two venues and this deck named one of them: the
       money at NEAR Intents is a row in the wallet above, and the money at the
       trading venue was on no screen but the trade screen. */
    var trading = linkPanel('Trading', 'span-5', 'account', 'Open the trade screen');
    var tradingBody = dom.el('div', 'stack grow spread');
    trading.body.appendChild(tradingBody);
    grid.appendChild(trading.node);

    /* Activity: receipts, with fees per row and a total for the window. */
    var activity = panel('Activity', 'span-7', 'activity');
    var activityBody = dom.el('div', 'panel-body-flush activity-list scrolls grow');
    activity.body.appendChild(activityBody);
    var feeRow = dom.el('div', 'between panel-total');
    feeRow.appendChild(dom.el('span', 'label', 'Fees in this window'));
    var feeValue = dom.el('span', 'body mono');
    feeRow.appendChild(feeValue);
    activity.body.appendChild(feeRow);
    grid.appendChild(activity.node);

    /* Policy: what the app will do, as rules a person can read in one look.
       Karim, 2026-09-14: "this thing should be policy and not limits, we
       shouldnt have limits unless specified." So a rule that is not set is not
       drawn, the count in the sub line counts only what is drawn, and the one
       meter on the card sits under the one rule it belongs to. The surface
       keeps its id, because the beam finds it by name. */
    /* TWO REGIONS, AND ONLY THE FIRST ONE SCROLLS.

       The rules are the part whose length this window does not control, a
       policy can carry five of them or fifteen, so the rules are the part that
       scrolls, with the allowlist folded under the rule it belongs to. The
       line under them, which tells a person how to change a rule, is fixed
       furniture and stays on screen whatever the policy says. */
    var limits = panel('Policy', 'span-5', 'rules');
    var limitsBody = dom.el('div', 'stack-2 grow limits-body');
    var limitsRules = dom.el('div', 'rules scrolls grow');
    var limitsFoot = dom.el('div', 'stack-2');
    limitsBody.appendChild(limitsRules);
    limitsBody.appendChild(limitsFoot);
    limits.body.appendChild(limitsBody);
    grid.appendChild(limits.node);

    host.appendChild(grid);

    refs = {
      money: money,
      moneyPanel: money.node,
      moneyList: moneyList,
      bar: bar,
      emptyNote: emptyNote,
      trading: trading,
      tradingBody: tradingBody,
      limits: limits,
      limitsRules: limitsRules,
      limitsFoot: limitsFoot,
      activity: activity,
      activityBody: activityBody,
      feeValue: feeValue,
      moneyCut: cuts(moneyList),
      activityCut: cuts(activityBody),
      limitsCut: cuts(limitsRules)
    };

    window.PhosphorReceipts.load();
  }

  /* A PANEL IS A TITLE, ONE LINE THAT STANDS IN FOR THE REST, AND ITS CONTENT.

     The head used to be a button and the panel used to fold. Three of the four
     started shut, which is why the deck was half empty, and a head that folds
     is drawn exactly like a head that does nothing, which is why nothing read
     as clickable. So a head is a static readout now: no caret, no cursor, no
     hover. The things that open on this screen say so instead. */
  function panel(title, span, surface) {
    var node = dom.el('section', 'panel ' + span);
    node.dataset.surface = surface;

    var head = dom.el('div', 'panel-head');
    var heading = dom.el('div', 'panel-heading');
    heading.appendChild(dom.el('h2', 'title-sm', title));
    var summary = dom.el('p', 'panel-summary');
    heading.appendChild(summary);
    head.appendChild(heading);

    var right = dom.el('div', 'panel-head-right');
    var lead = dom.el('span', 'panel-lead mono tick');
    right.appendChild(lead);
    head.appendChild(right);

    var body = dom.el('div', 'panel-body panel-fill');
    node.appendChild(head);
    node.appendChild(body);

    return { node: node, head: head, body: body, summary: summary, lead: lead };
  }

  /* The same panel, whole, as one target. It is a link rather than a button
     because it goes somewhere: role and keys say so, and the foot says so in
     words, because a surface that navigates and does not admit it is the thing
     this screen was rebuilt to stop doing. */
  function linkPanel(title, span, surface, hint) {
    var p = panel(title, span, surface);
    p.node.className += ' opens';
    p.node.setAttribute('role', 'link');
    p.node.tabIndex = 0;
    p.node.setAttribute('aria-label', title + '. ' + hint);

    var foot = dom.el('div', 'panel-foot');
    foot.appendChild(dom.el('span', 'meta', hint));
    foot.appendChild(dom.el('span', 'chev'));
    p.node.appendChild(foot);

    function go() {
      window.PhosphorShell.setView('trade', { fromClick: true });
    }
    dom.on(p.node, 'click', go);
    dom.on(p.node, 'keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      go();
    });
    return p;
  }

  /* A region that scrolls inside itself says where it was cut, so a sentence
     sliced in half is drawn as a sentence sliced in half rather than as the end
     of the list. The attribute drives the mask; the mask is not painted at all
     when there is nothing over the edge. */
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

  /* The one number on this screen that is the answer to the question somebody
     opened it for. It sits in the head of the Money panel rather than under its
     table, because a total below five rows of a table is a footnote and this is
     the headline. */
  function setSummary(p, text) {
    dom.setText(p.summary, text || '');
    dom.setHidden(p.summary, !text);
  }

  function setLead(p, text) {
    dom.setNumber(p.lead, text || '');
    dom.setHidden(p.lead, !text);
  }

  function chainName(id) {
    return CHAIN_NAMES[id] || String(id || '');
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    renderMoney(state);
    renderLimits(state);
    renderFeeTotal();
  }

  /* WHAT YOU OWN, ONE ROW PER COIN.

     The window listed one row per holding, so ETH sitting in four places was
     four rows and the question "how much ETH do I have" was arithmetic the
     person had to do. Karim, 2026-09-08: "the what we own thing should show all
     of what we own and what coins and the value."

     A coin is the row. Its places are under it, and they are only drawn when
     there is more than one, because a fold over a single place hides nothing
     and costs a click. */
  function groupByCoin(rows) {
    var order = [];
    var bySymbol = {};
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var symbol = String(row.symbol || '');
      /* A pool position is its own thing: its symbol is a pair and its quantity
         is a count of positions, so adding it to a coin's amount would be
         adding two different units together. */
      var id = row.kind === 'lp' ? 'lp:' + symbol + ':' + (row.tokenId || i) : symbol;
      var group = bySymbol[id];
      if (!group) {
        group = {
          id: id,
          symbol: symbol,
          kind: row.kind,
          quantity: 0,
          valueUsd: 0,
          share: 0,
          places: [],
          priced: true,
          countable: row.kind !== 'lp'
        };
        bySymbol[id] = group;
        order.push(group);
      }
      group.quantity += Number(row.quantity) || 0;
      group.valueUsd += Number(row.valueUsd) || 0;
      group.share += Number(row.share) || 0;
      if (row.priced === false) group.priced = false;
      group.places.push(row);
    }
    order.sort(function (a, b) { return b.valueUsd - a.valueUsd; });
    return order;
  }

  /* Where a holding sits, in the words the rest of the window uses. `intents`
     was reaching the screen as the raw id while every other place said
     Ethereum or Arbitrum, so one row in five was speaking a different language. */
  function placeName(row) {
    if (row.kind === 'intents') return 'NEAR Intents';
    if (row.kind === 'hyperliquid') return 'Hyperliquid';
    if (row.kind === 'lp') return 'Pool' + (row.chain ? ', ' + chainName(row.chain) : '');
    return chainName(row.chain);
  }

  /* A value this app could not work out is not a value of zero, and the two
     printed the same. */
  function valueText(row) {
    return row.priced === false ? 'not priced' : dom.usd(row.valueUsd);
  }

  function renderMoney(state) {
    var wallet = state.wallet || {};
    var rows = Array.isArray(wallet.rows) ? wallet.rows.slice() : [];

    if (!rows.length && !store.loaded()) {
      renderMoneySkeleton();
      return;
    }
    delete refs.moneyList.dataset.skeleton;

    var stale = Array.isArray(wallet.stale) ? wallet.stale : [];

    /* NOTHING HELD AND NOTHING READ ARE DIFFERENT ANSWERS.

       An empty wallet drew an empty box: no rows, no sentence, a panel with a
       title and nothing under it, which reads as a render that failed rather
       than as a wallet with nothing in it. And a wallet the app could not read
       drew "Nothing held" over a total of $0.00, which is the one thing this
       codebase says over and over not to do: a hole and a zero must never print
       the same, because $0.00 beside money somebody owns reads as "you have
       nothing". */
    if (!rows.length) {
      renderComposition([]);
      dom.reconcile(refs.moneyList, [], function (item) { return item; });
      if (stale.length) {
        setLead(refs.money, '--');
        setSummary(refs.money, 'Unread');
        refs.moneyList.appendChild(emptyBlock('Could not read what you hold',
          'The ' + stale.map(chainName).join(' and ') + ' read failed. What is there is unknown, not zero.'));
      } else {
        setLead(refs.money, dom.usd(0));
        setSummary(refs.money, 'Nothing held');
        refs.moneyList.appendChild(emptyBlock('Nothing here yet',
          'Ask your assistant where to send money, and it will give you an address.'));
      }
      dom.setHidden(refs.emptyNote, true);
      refs.moneyCut();
      return;
    }

    var coins = groupByCoin(rows);

    /* WHERE IT SITS, SAID ONCE.

       Phosphor holds money in two places and the wallet is one of them, so
       every row on this panel now reads "NEAR Intents" under the symbol: the
       same four words four times, which is the column doing no work. When the
       whole wallet is in one place the panel says so in its own summary and the
       rows drop the line. The moment a coin sits somewhere else, or in more
       than one place, the per row label comes back, because then it is the
       answer to a real question. */
    var common = onePlace(coins);

    dom.reconcile(refs.moneyList, coins, function (coin) {
      return coin.id;
    }, function () {
      var wrap = dom.el('div', 'holding');
      var head = dom.el('button', 'holding-head');
      head.type = 'button';
      head.appendChild(marks.disc(''));
      var name = dom.el('div', 'holding-name');
      name.appendChild(dom.el('span', 'holding-symbol'));
      name.appendChild(dom.el('span', 'holding-where meta'));
      head.appendChild(name);
      /* The value is the figure, the amount is the footnote under it. Three
         right-aligned number columns is what made every row read the same.
         The change sits to the left of the value and is only visible while
         the row is marked changed. */
      var figures = dom.el('div', 'holding-figures');
      figures.appendChild(dom.el('span', 'holding-value tick'));
      figures.appendChild(dom.el('span', 'holding-qty mono'));
      figures.appendChild(dom.el('span', 'holding-delta mono'));
      head.appendChild(figures);
      head.appendChild(dom.el('span', 'chev'));
      wrap.appendChild(head);
      var places = dom.el('div', 'holding-places');
      wrap.appendChild(places);
      dom.on(head, 'click', function () {
        if (wrap.dataset.single === 'true') return;
        var open = wrap.dataset.open === 'true';
        dom.setAttr(wrap, 'data-open', open ? null : 'true');
        refs.moneyCut();
      });
      lightWith(wrap, head);
      return wrap;
    }, function (wrap, coin) {
      var head = wrap.children[0];
      var mark = head.children[0];
      var name = head.children[1];
      var figures = head.children[2];
      var single = coin.places.length < 2;
      dom.setAttr(wrap, 'data-single', single ? 'true' : null);
      wrap.dataset.coin = coin.id;
      /* A coin in one place opens onto nothing, so it is a static readout and
         is drawn as one. Only a row that has something under it is a target. */
      dom.setAttr(head, 'class', single ? 'holding-head' : 'holding-head opens');

      if (mark.dataset.symbol !== coin.symbol) {
        mark.dataset.symbol = coin.symbol;
        marks.paint(mark, coin.symbol);
        /* The row carries its coin's colour too, so the change tint can be
           the coin's own rather than a state colour. */
        var colour = marks.colourFor(coin.symbol);
        if (colour) wrap.style.setProperty('--coin', colour);
        else wrap.style.removeProperty('--coin');
      }

      dom.setText(name.children[0], coin.symbol);
      /* One place is named on the row itself, because a fold that opens onto a
         single line is a click that tells a person what they already knew. */
      dom.setText(name.children[1], single ? placeName(coin.places[0])
        : coin.places.length + ' places');
      dom.setHidden(name.children[1], common !== '');
      dom.setNumber(figures.children[0], coin.priced ? dom.usd(coin.valueUsd) : 'not priced');
      dom.setAttr(figures.children[0], 'data-unpriced', coin.priced ? null : 'true');
      dom.setText(figures.children[1], coin.countable ? dom.qty(coin.quantity) : '');
      markChanged(wrap, figures.children[2], coin);

      dom.reconcile(wrap.children[1], single ? [] : coin.places, function (row, i) {
        return (row.kind || 'token') + ':' + (row.chain || '') + ':' + i;
      }, function () {
        var line = dom.el('div', 'holding-place');
        line.appendChild(dom.el('span', 'meta grow'));
        line.appendChild(dom.el('span', 'mono meta'));
        line.appendChild(dom.el('span', 'mono'));
        return line;
      }, function (line, row) {
        dom.setText(line.children[0], placeName(row));
        dom.setText(line.children[1], dom.qty(row.quantity));
        dom.setText(line.children[2], valueText(row));
        dom.setAttr(line.children[2], 'data-unpriced', row.priced === false ? 'true' : null);
      });
    });

    renderComposition(coins);

    /* The total is the head of the panel, so it is the first thing read rather
       than a sum under a list. */
    setLead(refs.money, dom.usd(wallet.totalUsd || 0));
    setSummary(refs.money, moneySummary(coins, wallet, common));

    var notes = [];
    if (wallet.emptyCount) notes.push(wallet.emptyCount + ' empty, not listed');
    /* Per-chain staleness badges are gone from every row that reads fine. Only
       a place that actually failed is named, and it is named in words. */
    if (stale.length) {
      notes.push('Could not check ' + stale.map(chainName).join(', ') + '. Holdings there are unknown, not zero.');
    }
    dom.setText(refs.emptyNote, notes.join('. '));
    dom.setHidden(refs.emptyNote, !notes.length);
    dom.setAttr(refs.emptyNote, 'class', stale.length ? 'meta warn' : 'meta');
    refs.moneyCut();
  }

  /* THE SHAPE OF THE WALLET, ONCE, AS A BAR.

     The rows carried a third number column for each coin's share of the total,
     and three right-aligned figures per row is why they all read the same. The
     share is one fact about the whole wallet rather than nine facts about nine
     coins, so it is drawn once, as one 4px bar under the head.

     Each segment is its coin's brand colour, the same one the mark on its row
     wears (ui/design/marks.js), so the bar and the list are read as the same
     facts. It is the one thing on this deck that is coloured and is not a
     state, and it is allowed because a coin's colour is its name: the state
     colours keep their meaning because a brand colour never lands on a
     number. A coin without a colour takes the quiet text tone. */
  function renderComposition(coins) {
    var priced = [];
    var total = 0;
    for (var i = 0; i < coins.length; i += 1) {
      if (!coins[i].priced || coins[i].valueUsd <= 0) continue;
      priced.push(coins[i]);
      total += coins[i].valueUsd;
    }
    dom.setHidden(refs.bar, priced.length < 2 || total <= 0);
    if (priced.length < 2 || total <= 0) {
      dom.clear(refs.bar);
      return;
    }

    dom.reconcile(refs.bar, priced, function (coin) {
      return coin.id;
    }, function () {
      var seg = dom.el('span', 'comp-seg');
      lightWith(seg, seg);
      return seg;
    }, function (seg, coin) {
      seg.dataset.coin = coin.id;
      seg.style.flexGrow = String(coin.valueUsd / total);
      seg.style.setProperty('--seg', marks.colourFor(coin.symbol) || 'var(--text-3)');
      seg.title = coin.symbol + ' ' + dom.pct(coin.valueUsd / total);
    });
  }

  /* A coin is one thing in two places on this panel, so pointing at either one
     lights both. Pointer only: on a touch screen a hover is a tap that has not
     decided yet, and this would fire on the way to opening a row. */
  function lightWith(owner, target) {
    if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    dom.on(target, 'mouseenter', function () { light(owner.dataset.coin, true); });
    dom.on(target, 'mouseleave', function () { light(owner.dataset.coin, false); });
    dom.on(target, 'focus', function () { light(owner.dataset.coin, true); });
    dom.on(target, 'blur', function () { light(owner.dataset.coin, false); });
  }

  function light(id, on) {
    if (!id || !refs.moneyPanel) return;
    var found = refs.moneyPanel.querySelectorAll('[data-coin="' + CSS.escape(id) + '"]');
    for (var i = 0; i < found.length; i += 1) {
      dom.setAttr(found[i], 'data-lit', on ? 'true' : null);
    }
  }

  /* A row whose figure just moved says so for a moment, so a change that
     arrived while the person was reading something else is still visible when
     they look back: the value rolls (dom.setNumber), the row tints in its
     coin's colour and the change sits beside the value, signed, in the
     direction's colour. Karim, 2026-09-14: "so it is clear when something
     happens." The change is in dollars when the value moved and in coin when
     only the amount did; the first fill is not a change. */
  function markChanged(wrap, delta, coin) {
    var usd = coin.priced ? Number(coin.valueUsd) : null;
    var qty = coin.countable ? Number(coin.quantity) : null;
    var was = wrap.__shown;
    wrap.__shown = { usd: usd, qty: qty };
    if (!was) return;
    var byUsd = usd !== null && was.usd !== null ? usd - was.usd : 0;
    var byQty = qty !== null && was.qty !== null ? qty - was.qty : 0;
    /* Under half a cent is a rounding of the same number, not a move. */
    if (Math.abs(byUsd) < 0.005) byUsd = 0;
    if (byUsd === 0 && byQty === 0) return;
    var moved = byUsd !== 0 ? byUsd : byQty;
    dom.setText(delta, (moved > 0 ? '+' : '-') + (byUsd !== 0
      ? dom.usd(Math.abs(byUsd))
      : dom.qty(Math.abs(byQty)) + ' ' + coin.symbol));
    dom.setAttr(delta, 'data-dir', moved > 0 ? 'up' : 'down');
    dom.setAttr(wrap, 'data-changed', 'true');
    if (wrap.__changeTimer) window.clearTimeout(wrap.__changeTimer);
    wrap.__changeTimer = window.setTimeout(function () {
      dom.setAttr(wrap, 'data-changed', null);
      wrap.__changeTimer = 0;
    }, CHANGED_MS);
  }

  /* The coins, counted, plus anything the panel could not price. An unpriced
     row is named in the summary rather than left for somebody to spot in the
     list, because it is the one thing on this panel that makes the total wrong. */
  /* The one place the whole wallet sits in, or an empty string when there is
     more than one. Two coins in one place each is still one place; a coin in
     two places is not. */
  function onePlace(coins) {
    var found = '';
    for (var i = 0; i < coins.length; i += 1) {
      if (coins[i].places.length !== 1) return '';
      var where = placeName(coins[i].places[0]);
      if (found === '') found = where;
      else if (found !== where) return '';
    }
    return found;
  }

  function moneySummary(coins, wallet, common) {
    if (!coins.length) return 'Nothing held';
    var unpriced = [];
    for (var i = 0; i < coins.length; i += 1) {
      if (!coins[i].priced) unpriced.push(coins[i].symbol);
    }
    var parts = [coins.length === 1 ? '1 coin' : coins.length + ' coins'];
    if (common) parts.push('all in ' + common);
    var places = 0;
    for (var j = 0; j < coins.length; j += 1) places += coins[j].places.length;
    if (!common && places > coins.length) parts.push(places + ' places');
    if (Array.isArray(wallet.stale) && wallet.stale.length) {
      parts.push(wallet.stale.length === 1 ? '1 chain unread' : wallet.stale.length + ' chains unread');
    }
    if (unpriced.length) parts.push(unpriced.join(', ') + ' not priced');
    return parts.join(', ');
  }

  function renderMoneySkeleton() {
    if (refs.moneyList.dataset.skeleton === 'true') return;
    refs.moneyList.dataset.skeleton = 'true';
    dom.clear(refs.moneyList);
    dom.setHidden(refs.bar, true);
    for (var i = 0; i < 4; i += 1) {
      var line = dom.el('div', 'holding-place');
      var bar = dom.el('div', 'skel grow');
      bar.style.height = '14px';
      line.appendChild(bar);
      refs.moneyList.appendChild(line);
    }
  }

  /* ---------- the trading venue ---------- */

  /* The second of the two venues this app reaches. Its money is in no state
     frame: /api/trade is the only place it exists, and this deck did not read
     it, so a person holding a position could see every dollar except the ones
     at risk. */
  function loadTrade() {
    if (!mounted) return;
    return api.trade()
      .then(function (result) {
        trade.data = result && result.data ? result.data : null;
        trade.failed = false;
        trade.reason = '';
        renderTrading();
      })
      .catch(function (err) {
        /* Nothing that arrived before is redrawn as if it were current. A
           number from a read that failed is a claim this panel cannot make. */
        trade.failed = true;
        trade.reason = net.readable(err, true);
        renderTrading();
      });
  }

  function renderTrading() {
    if (!refs.tradingBody) return;
    var host = refs.tradingBody;
    dom.clear(host);

    if (trade.failed) {
      setLead(refs.trading, '--');
      setSummary(refs.trading, 'Hyperliquid, unread');
      var facts = dom.el('div', 'facts');
      fact(facts, 'Trading money', '--');
      fact(facts, 'Spare', '--');
      host.appendChild(facts);
      host.appendChild(dom.el('p', 'meta warn', trade.reason
        || 'The trading venue did not answer, so these are unknown rather than zero.'));
      return;
    }

    var data = trade.data;
    var account = data && data.account;
    if (!data || !account || account.accountKnown === false) {
      setLead(refs.trading, '');
      setSummary(refs.trading, 'Hyperliquid');
      host.appendChild(emptyBlock('Still reading the account',
        'The venue has not said yet what kind of account this is.'));
      return;
    }

    var funded = typeof account.equityUsd === 'number'
      || typeof account.freeUsd === 'number';
    if (!funded) {
      setLead(refs.trading, '');
      setSummary(refs.trading, 'Hyperliquid, not funded');
      host.appendChild(emptyBlock('No trading money yet',
        'Ask your assistant to fund the trading account, and it will ask you first.'));
      return;
    }

    setLead(refs.trading, typeof account.equityUsd === 'number' ? dom.usd(account.equityUsd) : '');
    var positions = Array.isArray(data.positions) ? data.positions : [];
    setSummary(refs.trading, 'Hyperliquid' + (positions.length
      ? ', ' + (positions.length === 1 ? '1 position open' : positions.length + ' positions open')
      : ', nothing open'));

    var box = dom.el('div', 'facts');
    fact(box, 'Trading money', typeof account.equityUsd === 'number' ? dom.usd(account.equityUsd) : '--');
    fact(box, 'Spare', typeof account.freeUsd === 'number' ? dom.usd(account.freeUsd) : '--');
    host.appendChild(box);

    /* How much of the account is still between the position and a forced close.
       It is the third figure of a leveraged account and it comes off the same
       read as the other two, drawn with the meter the trade screen uses so the
       two screens do not disagree about what a margin bar looks like. */
    if (typeof account.healthPct === 'number') {
      var wrap = dom.el('div', 'stack-2');
      var top = dom.el('div', 'between');
      top.appendChild(dom.el('span', 'label', 'Safety margin'));
      var value = dom.el('span', 'body mono');
      dom.setText(value, dom.pct(account.healthPct));
      top.appendChild(value);
      wrap.appendChild(top);
      var meter = dom.el('div', 'meter');
      var fill = dom.el('div', 'meter-fill');
      fill.style.width = Math.max(0, Math.min(1, account.healthPct)) * 100 + '%';
      if (account.healthPct < 0.3) fill.dataset.tone = 'down';
      else if (account.healthPct < 0.5) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      wrap.appendChild(meter);
      host.appendChild(wrap);
    } else if (account.unified) {
      /* The venue publishes no whole-account health figure for a unified
         account, and approximating one from numbers this feed does not carry is
         the one thing not to do on a panel about money at risk. */
      host.appendChild(dom.el('p', 'meta',
        'This is a unified account, so the venue publishes no single safety margin for it.'));
    }

    /* One line per position: which way, how much, and what it is worth so far.
       The whole panel goes to the trade screen, which is where the rest is. */
    var block = dom.el('div', 'position-block stack-2');
    if (!positions.length) {
      block.appendChild(dom.el('p', 'body dim', 'Nothing open'));
    } else {
      for (var i = 0; i < positions.length; i += 1) {
        block.appendChild(positionLine(positions[i]));
      }
    }
    host.appendChild(block);
  }

  function positionLine(position) {
    var row = dom.el('div', 'between position-line');
    var left = dom.el('span', 'body');
    var side = position.side === 'short' ? 'Short' : 'Long';
    var size = typeof position.sizeCoin === 'number' ? dom.qty(position.sizeCoin) + ' ' : '';
    dom.setText(left, side + ' ' + size + String(position.coin || '')
      + (typeof position.notionalUsd === 'number' ? ', ' + dom.usd(position.notionalUsd) : ''));
    row.appendChild(left);
    var pnl = dom.el('span', 'mono');
    if (typeof position.unrealisedUsd === 'number') {
      dom.setText(pnl, (position.unrealisedUsd >= 0 ? '+' : '') + dom.usd(position.unrealisedUsd));
      pnl.className = 'mono ' + (position.unrealisedUsd >= 0 ? 'up' : 'down');
    }
    row.appendChild(pnl);
    return row;
  }

  /* THE POLICY CARD.

     Rules, in the order a person needs them: what gets asked, what gets
     refused at once, what gets refused over a day, what is held back for gas,
     and where money may go. Each one is the server's own sentence
     (src/policy/render.ts) said in the app's voice, so the card and the
     assistant never disagree about a number. A rule that is not set is not
     drawn, which is what "no limits unless specified" means here: an unset
     allowlist draws no door, a policy with no daily cap draws no meter. The
     sentences this card does not know the shape of (an issuer cap, a
     forbidden issuer) still render, verbatim, behind a wall, because a rule
     the app enforces is a rule the person gets to read. */
  var allowOpen = false;

  function renderLimits(state) {
    dom.clear(refs.limitsRules);
    dom.clear(refs.limitsFoot);
    var policy = state.policy || {};
    var sentences = state.sentences || policy.sentences || [];
    var daily = state.dailyLimit;
    var rules = parseRules(sentences, policy);
    var drawn = 0;

    if (rules.kill) {
      var kill = rule('wall', 'Refuses everything while the kill switch is on.');
      kill.node.dataset.rule = 'kill';
      kill.node.dataset.tone = 'down';
      refs.limitsRules.appendChild(kill.node);
      drawn += 1;
    }

    if (rules.ask) {
      var ask = rule('hand', 'Asks you before anything above ' + rules.ask + '.');
      ask.node.dataset.rule = 'ask';
      refs.limitsRules.appendChild(ask.node);
      drawn += 1;
    }

    if (rules.perTx) {
      var once = rule('wall', 'Refuses any single transaction above ' + rules.perTx + '.');
      once.node.dataset.rule = 'refuse';
      refs.limitsRules.appendChild(once.node);
      drawn += 1;
    }

    /* The one meter on the card, under the one rule it measures. Only a cap
       the daily counter knows about draws it: a sentence with no counter
       behind it is a rule, not a gauge. */
    if (rules.perDay) {
      var day = rule('wall', 'Refuses more than ' + rules.perDay + ' in any 24 hours.');
      day.node.dataset.rule = 'daily';
      if (daily && daily.capUsd > 0) {
        var spent = Number(daily.spentUsd) || 0;
        var used = Math.min(1, spent / daily.capUsd);
        var figure = dom.el('span', 'rule-figure', usdShort(spent) + ' used');
        /* resetsAt is when the oldest counted spend leaves the window, not
           midnight. A cap that rolls is described as rolling. */
        figure.title = daily.resetsAt === null || spent === 0
          ? 'Nothing has been spent in the last 24 hours.'
          : 'The oldest of it stops counting ' + resetWords(daily.resetsAt) + '.';
        day.node.appendChild(figure);
        var meter = dom.el('div', 'rule-meter');
        meter.style.setProperty('--used', (used * 100).toFixed(2) + '%');
        /* The fill is a scale, not a width, so the bar never lays out again. */
        meter.style.setProperty('--used-scale', used.toFixed(4));
        /* Something spent is drawn as something spent. Against a $25,000 cap a
           real $22.84 is 0.09 percent, which rounds to a sub-pixel sliver and
           reads as a fault rather than as a number. */
        dom.setAttr(meter, 'data-spent', spent > 0 ? 'true' : null);
        if (used > 0.8) {
          meter.dataset.tone = 'warn';
          figure.dataset.tone = 'warn';
        }
        meter.appendChild(dom.el('i'));
        day.node.appendChild(meter);
      }
      refs.limitsRules.appendChild(day.node);
      drawn += 1;
    }

    /* THE GAS FLOORS ARE ONE RULE, NOT FOUR.
       They arrive as one sentence per chain, and four lines that differ in two
       words each are four lines nobody reads. One rule naming the four
       numbers says the same thing and can be taken in at a glance. */
    if (rules.gas.length) {
      var gas = rule('coin', rules.gas.length === 1
        ? 'Keeps gas back on ' + chainName(rules.gas[0].chain) + '.'
        : 'Keeps gas back on each chain.');
      gas.node.dataset.rule = 'gas';
      gas.text.appendChild(dom.el('span', 'meta mono', rules.gas.map(function (g) {
        return chainName(g.chain) + ' ' + g.amount;
      }).join(', ')));
      refs.limitsRules.appendChild(gas.node);
      drawn += 1;
    }

    for (var o = 0; o < rules.other.length; o += 1) {
      var other = rule('wall', rules.other[o]);
      other.node.dataset.rule = 'other';
      refs.limitsRules.appendChild(other.node);
      drawn += 1;
    }

    /* The destination allowlist existed in the policy engine with no way to
       see it. This is where it lives: the rule names the venues and counts the
       wallets, and the addresses fold under it. An address is checked
       character by character on the day somebody has a reason to and is noise
       on every other day; a venue name is read at a glance and is the half of
       this list that answers a question. */
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    if (allow.length) {
      var venues = [];
      var addresses = [];
      for (var a = 0; a < allow.length; a += 1) {
        if (VENUE_NAMES[allow[a]]) venues.push(VENUE_NAMES[allow[a]]);
        else addresses.push(allow[a]);
      }
      var names = venues.slice();
      if (addresses.length) {
        names.unshift(addresses.length === 1 ? '1 wallet of yours' : addresses.length + ' wallets of yours');
      }
      var sentence = 'Pays only ' + listWords(names) + '.';

      var door = rule('door', sentence, addresses.length ? 'button' : 'div');
      door.node.dataset.rule = 'destinations';
      refs.limitsRules.appendChild(door.node);
      drawn += 1;

      if (addresses.length) {
        door.node.className += ' opens';
        door.node.type = 'button';
        door.node.setAttribute('aria-label', sentence);
        door.node.appendChild(dom.el('span', 'chev'));
        var box = dom.el('div', 'allowlist');
        for (var b = 0; b < addresses.length; b += 1) {
          box.appendChild(dom.el('p', 'addr dim', addresses[b]));
        }
        dom.setHidden(box, !allowOpen);
        dom.setAttr(door.node, 'aria-expanded', allowOpen ? 'true' : 'false');
        dom.setAttr(door.node, 'data-open', allowOpen ? 'true' : null);
        dom.on(door.node, 'click', function () {
          allowOpen = box.hidden;
          dom.setHidden(box, !allowOpen);
          dom.setAttr(door.node, 'aria-expanded', allowOpen ? 'true' : 'false');
          dom.setAttr(door.node, 'data-open', allowOpen ? 'true' : null);
          refs.limitsCut();
        });
        refs.limitsRules.appendChild(box);
      }
    }

    if (!drawn) {
      refs.limitsRules.appendChild(emptyBlock('No rules set',
        'Everything your assistant does will ask you first.'));
    }

    refs.limitsFoot.appendChild(askLine());
    setSummary(refs.limits, policySummary(drawn, daily));
    refs.limitsCut();
  }

  /* One rule row: the glyph, the sentence, and room on the right for the one
     figure a rule may carry. The sentence is a span of its own so a second
     line (the gas amounts) can sit under it. */
  function rule(kind, text, tag) {
    var node = dom.el(tag || 'div', 'rule');
    var mark = dom.el('span', 'rule-glyph');
    var svg = glyph(kind);
    if (svg) mark.appendChild(svg);
    node.appendChild(mark);
    var body = dom.el('div', 'rule-text');
    body.appendChild(dom.el('span', 'rule-line', text));
    node.appendChild(body);
    return { node: node, text: body };
  }

  /* What the sentences say, by shape. The three caps are always sent by the
     server and always render; gas floors and the rest render only when set.
     Any sentence with a shape this card does not know is kept whole. */
  function parseRules(sentences, policy) {
    var out = { ask: '', perTx: '', perDay: '', gas: [], other: [], kill: false };
    for (var i = 0; i < sentences.length; i += 1) {
      var line = String(sentences[i]).trim();
      var found;
      if (/allowed destinations/i.test(line)) continue;
      if ((found = /^ask me before anything above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.ask = found[1];
      else if ((found = /^refuse any single transaction above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.perTx = found[1];
      else if ((found = /^refuse more than (\$[\d,]+(?:\.\d+)?) in any 24 hours\.?$/i.exec(line))) out.perDay = found[1];
      else if ((found = /^keep at least (.+) of gas on (\w+)\.?$/i.exec(line))) out.gas.push({ amount: found[1], chain: found[2] });
      else if (/^kill switch on/i.test(line)) out.kill = true;
      else if (line) out.other.push(line);
    }
    /* The typed policy outranks the sentence when both are there, so a number
       never comes from a regex when it can come from a field. */
    var gate = policy && policy.approval;
    if (gate && typeof gate.thresholdUsd === 'number') out.ask = usdShort(gate.thresholdUsd);
    return out;
  }

  /* "a, b and c": a list in a sentence, not a list with commas. */
  function listWords(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* Whole dollars when the figure is whole, cents when it is not: "$120" and
     "$1,150.20", never "$120.00". */
  function usdShort(value) {
    var n = Number(value) || 0;
    var cents = Math.round(n * 100);
    return dom.usd(n, cents % 100 === 0 ? 0 : 2);
  }

  /* One sentence, rather than an Edit button on every rule that only ever
     opened a toast saying the same thing. Seven buttons that cannot do what
     they offer is worse than no button: it teaches a person that the controls
     on this screen are decoration. It sits last, under the rules, because this
     panel holds more than its box on a short window and something has to be
     the thing below the cut. */
  function askLine() {
    return dom.el('p', 'meta', 'Ask your assistant to change a rule. Every change waits for your click.');
  }

  /* The count of what is drawn, then the day's spend in words: "4 rules,
     nothing spent today" or "4 rules, $120 spent today". */
  function policySummary(drawn, daily) {
    var parts = [drawn === 1 ? '1 rule' : drawn + ' rules'];
    if (daily && daily.capUsd > 0) {
      var spent = Number(daily.spentUsd) || 0;
      parts.push(spent > 0 ? usdShort(spent) + ' spent today' : 'nothing spent today');
    }
    return parts.join(', ');
  }

  function resetWords(iso) {
    if (!iso) return 'in 24 hours';
    var when = new Date(iso).getTime();
    if (!isFinite(when)) return 'in 24 hours';
    var hours = Math.max(0, Math.round((when - Date.now()) / 3600000));
    if (hours < 1) return 'within the hour';
    return 'in ' + hours + (hours === 1 ? ' hour' : ' hours');
  }

  function renderFeeTotal() {
    if (!refs.feeValue) return;
    var total = window.PhosphorReceipts.feeTotal();
    dom.setText(refs.feeValue, total > 0 ? dom.fee(total) : 'None yet');

    var list = window.PhosphorReceipts.get();
    var count = Array.isArray(list) ? list.length : 0;
    setSummary(refs.activity, count === 0 ? 'Nothing has happened yet'
      : (count === 1 ? '1 receipt' : count + ' receipts') + (total > 0 ? ', ' + dom.fee(total) + ' in fees' : ''));
  }

  function fact(host, label, value) {
    if (!value) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body mono', value));
    host.appendChild(row);
  }

  function emptyBlock(title, note) {
    var empty = dom.el('div', 'empty');
    empty.appendChild(dom.el('p', 'empty-title', title));
    empty.appendChild(dom.el('p', '', note));
    return empty;
  }

  window.PhosphorPro = { boot: boot };
})();
