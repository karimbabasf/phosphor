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

  /* The same figure as a surface's decay: a row that just moved keeps the
     afterglow for as long as the panel it sits in would. */
  var CHANGED_MS = 2400;

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
    intents: 'NEAR Intents'
  };

  /* Allowlist entries that are venues rather than addresses. The policy stores
     the id it checks against; the window shows the name a person knows it by. */
  var VENUE_NAMES = {
    'oneclick:1click.chaindefuser.com': '1Click',
    'intents.near': 'NEAR Intents',
    'hyperliquid-perps': 'Hyperliquid'
  };

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

    /* Limits: the policy, the daily spend and the allowlist. It is reference
       material, so it reads as reference material: sentences, one meter, and
       the addresses behind the one thing on this deck worth a click to open. */
    /* THREE REGIONS, AND ONLY THE MIDDLE ONE SCROLLS.

       The whole body used to scroll, so on a short panel the thing under the cut
       was whatever happened to be last: the one control on the panel, or half of
       the sentence that tells a person how to change a limit. The sentences are
       the part whose length this window does not control, a policy can carry
       five of them or fifteen, so the sentences are the part that scrolls. The
       spend meter above and the allowlist and the footnote below are fixed
       furniture and stay on screen whatever the policy says. */
    var limits = panel('Limits', 'span-5', 'rules');
    var limitsBody = dom.el('div', 'stack-2 grow limits-body');
    var limitsSpend = dom.el('div', 'stack-2');
    var limitsRules = dom.el('div', 'stack-2 scrolls grow');
    var limitsFoot = dom.el('div', 'stack-2');
    limitsBody.appendChild(limitsSpend);
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
      limitsSpend: limitsSpend,
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
         right-aligned number columns is what made every row read the same. */
      var figures = dom.el('div', 'holding-figures');
      figures.appendChild(dom.el('span', 'holding-value tick'));
      figures.appendChild(dom.el('span', 'holding-qty mono'));
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
        mark.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" focusable="false">'
          + marks.markFor(coin.symbol) + '</svg>';
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
      markChanged(figures.children[0], coin.priced ? dom.usd(coin.valueUsd) : 'not priced');

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

     The segments are steps of neutral lightness off --text and never a hue. A
     coloured wallet is a wallet where the one number that means something, a
     loss or a chain that would not answer, no longer stands out. */
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

    var last = priced.length - 1;
    dom.reconcile(refs.bar, priced, function (coin) {
      return coin.id;
    }, function () {
      var seg = dom.el('span', 'comp-seg');
      lightWith(seg, seg);
      return seg;
    }, function (seg, coin, index) {
      seg.dataset.coin = coin.id;
      seg.style.flexGrow = String(coin.valueUsd / total);
      /* Lightest first, and the run is spread over however many coins there
         are, so two coins are told apart as easily as nine. */
      var step = last === 0 ? 0 : (index / last);
      seg.style.setProperty('--seg', 'color-mix(in srgb, var(--text) '
        + Math.round(88 - step * 66) + '%, var(--bg-2))');
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

  /* A row whose number just moved carries the afterglow for a moment, so a
     change that arrived while the person was reading something else is still
     visible when they look back. The first fill is not a change. */
  function markChanged(node, value) {
    var next = value === undefined || value === null ? '' : String(value);
    var had = node.dataset.shown;
    node.dataset.shown = next;
    if (had === undefined || had === next) return;
    node.dataset.changed = 'true';
    if (node.__changeTimer) window.clearTimeout(node.__changeTimer);
    node.__changeTimer = window.setTimeout(function () {
      delete node.dataset.changed;
      node.__changeTimer = 0;
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

  function renderLimits(state) {
    dom.clear(refs.limitsSpend);
    dom.clear(refs.limitsRules);
    dom.clear(refs.limitsFoot);
    var policy = state.policy || {};
    var sentences = state.sentences || policy.sentences || [];

    /* The daily limit: rolling 24 hours, survives a restart, so it is a limit a
       person can reason about rather than one that resets when the app does. */
    var daily = state.dailyLimit;
    if (daily) {
      var block = dom.el('div', 'stack-2');
      var top = dom.el('div', 'between');
      top.appendChild(dom.el('span', 'label', 'Limit per day'));
      var value = dom.el('span', 'body mono');
      dom.setText(value, dom.usd(daily.spentUsd) + ' of ' + dom.usd(daily.capUsd, 0));
      top.appendChild(value);
      block.appendChild(top);
      var meter = dom.el('div', 'meter');
      var fill = dom.el('div', 'meter-fill');
      var used = daily.capUsd ? Math.min(1, daily.spentUsd / daily.capUsd) : 0;
      fill.style.width = (used * 100).toFixed(1) + '%';
      /* Something spent is drawn as something spent. Against a $25,000 cap a
         real $22.84 is 0.09 percent, which rounds to a sub-pixel sliver and
         reads as a fault rather than as a number. */
      dom.setAttr(fill, 'data-spent', daily.spentUsd > 0 ? 'true' : null);
      if (used > 0.8) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      block.appendChild(meter);
      /* resetsAt is when the oldest counted spend leaves the window, not
         midnight. A cap that rolls is described as rolling. */
      block.appendChild(dom.el('p', 'meta', daily.resetsAt === null
        ? 'Nothing has been spent in the last 24 hours.'
        : 'The oldest of it stops counting ' + resetWords(daily.resetsAt) + '.'));
      refs.limitsSpend.appendChild(block);
    }

    /* The destination sentence is dropped here because the allowlist gets its
       own block below, and printing eight addresses twice on one panel is how a
       person stops reading either copy. */
    var spoken = sentences.filter(function (line) {
      return !/allowed destinations/i.test(String(line));
    });

    /* THE GAS FLOORS ARE ONE RULE, NOT FOUR.
       They arrived as four sentences of identical shape, one per chain, and
       four lines that differ in two words each are four lines nobody reads. One
       line naming the four numbers says the same thing and can be taken in at a
       glance. Anything that is not a gas floor keeps its own sentence, because
       those genuinely are separate rules. */
    var gas = [];
    var rules = [];
    for (var i = 0; i < spoken.length; i += 1) {
      var line = String(spoken[i]);
      var found = /^keep at least (.+) of gas on (\w+)\.?$/i.exec(line);
      if (found) gas.push({ amount: found[1], chain: found[2] });
      else rules.push(line);
    }

    if (rules.length) {
      var list = dom.el('div', 'stack-2');
      for (var r = 0; r < rules.length; r += 1) {
        list.appendChild(dom.el('p', 'body limit-line', rules[r]));
      }
      refs.limitsRules.appendChild(list);
    }

    if (gas.length) {
      var gasRow = dom.el('div', 'between limit-line');
      gasRow.appendChild(dom.el('span', 'body', gas.length === 1 ? 'Gas kept back' : 'Gas kept back on each chain'));
      var amounts = gas.map(function (g) { return chainName(g.chain) + ' ' + g.amount; }).join(', ');
      gasRow.appendChild(dom.el('span', 'meta mono', amounts));
      refs.limitsRules.appendChild(gasRow);
    }

    /* The destination allowlist existed in the policy engine with no way to see
       it. This is where it lives now. */
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    var wrap = dom.el('div', 'stack-2');
    if (!allow.length) {
      wrap.appendChild(dom.el('p', 'label', 'Money can only go to your own wallets and these venues'));
      wrap.appendChild(dom.el('p', 'meta', 'No list is set, so a destination is checked against your limits alone.'));
      refs.limitsFoot.appendChild(wrap);
      refs.limitsFoot.appendChild(askLine());
      setSummary(refs.limits, limitsSummary(state));
      refs.limitsCut();
      return;
    }

    /* The addresses fold and the names do not. An address is checked character
       by character on the day somebody has a reason to and is noise on every
       other day; a venue name is read at a glance and is the half of this list
       that answers a question. */
    var venues = [];
    var addresses = [];
    for (var a = 0; a < allow.length; a += 1) {
      if (VENUE_NAMES[allow[a]]) venues.push(VENUE_NAMES[allow[a]]);
      else addresses.push(allow[a]);
    }

    var head = dom.el('button', 'allow-head opens');
    head.type = 'button';
    var headText = addresses.length === 1 ? '1 wallet of yours' : addresses.length + ' wallets of yours';
    if (venues.length) headText += ', ' + venues.join(', ');
    /* One line, truncated. It wrapped to two, and on a short panel that put the
       one control here half under the cut, which is the fade hiding a button
       rather than a footnote. The whole list is one click away and the label
       carries it for a reader who cannot see the end of the line. */
    var label = dom.el('span', 'body grow truncate', 'Money can only go to ' + headText);
    head.setAttribute('aria-label', 'Money can only go to ' + headText);
    head.appendChild(label);
    head.appendChild(dom.el('span', 'chev'));
    wrap.appendChild(head);

    var box = dom.el('div', 'allowlist');
    box.hidden = true;
    for (var b = 0; b < addresses.length; b += 1) {
      box.appendChild(dom.el('p', 'addr dim', addresses[b]));
    }
    dom.on(head, 'click', function () {
      var open = !box.hidden;
      dom.setHidden(box, open);
      dom.setAttr(head, 'aria-expanded', open ? 'false' : 'true');
      refs.limitsCut();
    });
    dom.setAttr(head, 'aria-expanded', 'false');
    if (addresses.length) wrap.appendChild(box);
    refs.limitsFoot.appendChild(wrap);
    refs.limitsFoot.appendChild(askLine());

    setSummary(refs.limits, limitsSummary(state));
    refs.limitsCut();
  }

  /* One sentence, rather than an Edit button on every rule that only ever opened
     a toast saying the same thing. Seven buttons that cannot do what they offer
     is worse than no button: it teaches a person that the controls on this
     screen are decoration.

     It sits last, under the allowlist, because this panel holds more than its
     box on a short window and something has to be the thing below the cut. A
     line of prose is the right thing: putting it above the allowlist pushed the
     one control on the panel off the bottom, so the fade was hiding a button
     rather than a footnote. */
  function askLine() {
    return dom.el('p', 'meta',
      'Ask your assistant to change any of these. A limit change files a request you have to click.');
  }

  /* The three facts somebody opens Limits to check: what gets asked, what gets
     refused, and how much of today's room is gone. */
  function limitsSummary(state) {
    var parts = [];
    var gate = state.policy && state.policy.approval;
    var ask = gate && typeof gate.thresholdUsd === 'number' ? gate.thresholdUsd : null;
    if (ask === null) {
      var sentences = state.sentences || (state.policy && state.policy.sentences) || [];
      for (var i = 0; i < sentences.length; i += 1) {
        var found = /ask me before anything above \$([\d,.]+)/i.exec(String(sentences[i]));
        if (found) { ask = Number(found[1].replace(/,/g, '')); break; }
      }
    }
    if (ask !== null && isFinite(ask)) parts.push('Asks above ' + dom.usd(ask, 0));
    var daily = state.dailyLimit;
    if (daily && daily.capUsd) {
      parts.push(dom.usd(daily.spentUsd) + ' of ' + dom.usd(daily.capUsd, 0) + ' used today');
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
