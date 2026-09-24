/* Pro's header: your money, then your trading account, over the positions.

   Pro is your money and your positions: this header over the positions,
   orders and the last day's trades, stacked in one scroll (ui/screens/trade.js
   builds that deck into #view-trade; ui/design/pro.css decides which parts
   each view shows). Trade has no header of its own: the market leads there,
   and the trading account sits at its deck's tab row.

   Your money is the balance total with what it is, from the same server view
   the Basic panel draws (state.basic), and the coins it holds in brief. The
   trading account is what it holds, what is free, what the open plans have in
   them and the most they can lose if every stop fills. Those come off the trade
   payload, which trade.js reads on every `trade` frame of the stream and hands
   over as a `phosphor:trade` event, so nothing here polls. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;

  /* The sentence the one action on an empty trading account sends: the
     assistant proposes the move, and the card in the thread asks for the
     click. It never names an amount for the person. */
  var FUND_ASK = 'Help me add money to my trading account.';

  /* How many coins the header names before it counts the rest. */
  var COINS_SHOWN = 3;

  var refs = {};
  var mounted = false;

  /* The last trade payload trade.js read, or null before the trade bundle has
     loaded or its first read has landed. */
  var trade = null;

  function boot() {
    var host = document.getElementById('view-pro');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(renderBalance);

    window.addEventListener('phosphor:trade', function (event) {
      trade = event && event.detail ? event.detail : null;
      renderTrading();
    });

    /* The chart and the deck are a late load (ui/core/lazy.js), fetched the
       first time Pro or Trade is on screen. */
    window.addEventListener('phosphor:view', function (event) {
      var view = event && event.detail ? event.detail.view : null;
      if (view === 'pro' || view === 'trade') loadTrading();
    });

    renderBalance();
    renderTrading();
  }

  function loadTrading() {
    if (window.PhosphorLazy && typeof window.PhosphorLazy.load === 'function') window.PhosphorLazy.load('trade');
  }

  function build(host) {
    var head = dom.el('section', 'pro-sum');
    head.setAttribute('aria-label', 'Your money');

    /* The balance: the one lead figure on Pro, with the server's words for
       it, and the coins it holds in brief under it. */
    var money = dom.el('div', 'pro-sum-money');
    money.dataset.surface = 'holdings';
    var lead = dom.el('div', 'pro-sum-lead');
    var total = dom.el('p', 'pro-sum-total num tick');
    total.hidden = true;
    var skel = dom.el('span', 'skel pro-sum-skel');
    skel.setAttribute('aria-hidden', 'true');
    var caption = dom.el('p', 'pro-sum-caption');
    lead.appendChild(total);
    lead.appendChild(skel);
    lead.appendChild(caption);
    money.appendChild(lead);
    var coins = dom.el('ul', 'pro-coins');
    coins.setAttribute('aria-label', 'What your balance holds');
    coins.hidden = true;
    money.appendChild(coins);
    head.appendChild(money);

    /* The trading account: its figures as tiles, or one sentence and the
       way to fill it when there is nothing on it. */
    var account = dom.el('div', 'pro-sum-account');
    account.dataset.surface = 'account';
    account.setAttribute('aria-label', 'Your trading account');
    account.appendChild(dom.el('h3', 'pro-sum-head', 'Trading account'));
    var figures = dom.el('dl', 'pro-sum-figures');
    var note = dom.el('p', 'pro-sum-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    var fund = dom.el('button', 'btn btn-sm pro-sum-fund');
    fund.type = 'button';
    fund.appendChild(dom.el('span', 'btn-label', 'Add trading money'));
    fund.hidden = true;
    account.appendChild(figures);
    account.appendChild(note);
    account.appendChild(fund);
    head.appendChild(account);

    host.appendChild(head);

    refs = {
      host: host,
      total: total,
      skel: skel,
      caption: caption,
      coins: coins,
      account: account,
      figures: figures,
      note: note,
      fund: fund
    };

    dom.on(fund, 'click', askToFund);
  }

  /* ---------- the balance ---------- */

  /* The figure and the words under it are the server's, the same two the
     Basic panel prints, so the two modes never disagree about the total. */
  function renderBalance() {
    if (!mounted || !store.loaded()) return;
    var basic = (store.get() || {}).basic || {};
    if (refs.skel.parentNode) refs.skel.parentNode.removeChild(refs.skel);
    dom.setNumber(refs.total, basic.totalLine || '');
    dom.setHidden(refs.total, !basic.totalLine);
    dom.setText(refs.caption, basic.caption || '');
    dom.setAttr(refs.caption, 'data-alone', basic.totalLine ? null : 'true');
    renderCoins(Array.isArray(basic.holdings) ? basic.holdings : []);
  }

  /* The coins in brief: the largest first, each with its logo and what it is
     worth, and a count of the rest. The full list is Basic's. */
  function renderCoins(holdings) {
    var shown = holdings.slice(0, COINS_SHOWN);
    var rest = holdings.length - shown.length;
    var items = shown.map(function (h) { return { key: String(h.symbol), h: h }; });
    if (rest > 0) items.push({ key: '+rest', rest: rest });
    dom.reconcile(refs.coins, items, function (item) {
      return item.key;
    }, function (item) {
      var li = dom.el('li', item.rest ? 'pro-coin pro-coin-rest' : 'pro-coin');
      if (!item.rest) {
        var marks = window.PhosphorMarks;
        if (marks && typeof marks.logo === 'function') li.appendChild(marks.logo(String(item.h.symbol), 18));
        li.appendChild(dom.el('span', 'pro-coin-name'));
        li.appendChild(dom.el('span', 'pro-coin-value num'));
      } else {
        li.appendChild(dom.el('span', 'pro-coin-name'));
      }
      return li;
    }, function (li, item) {
      if (item.rest) {
        dom.setText(li.children[0], '+' + item.rest + ' more');
        return;
      }
      dom.setText(li.children[1], String(item.h.symbol));
      dom.setAttr(li, 'title', item.h.name && item.h.name !== item.h.symbol ? String(item.h.name) : null);
      dom.setText(li.children[2], item.h.valueLine || '');
    });
    dom.setHidden(refs.coins, items.length === 0);
  }

  /* ---------- the trading account ---------- */

  /* Four answers, each its own sentence, because they mean different things
     to a person deciding a trade:
       no read yet, or the venue has not answered (collateral.funded null)
       the venue is not answering now: the figures read as unknown, never zero
       nothing on the account, or only dust (collateral.funded false)
       money on it: what it holds, what is free, what the plans have in them
       and the most they can lose. */
  function renderTrading() {
    if (!mounted) return;
    var data = trade && trade.data ? trade.data : null;
    var account = data && data.account ? data.account : null;
    var collateral = data && data.collateral ? data.collateral : null;
    var funded = collateral && typeof collateral.funded === 'boolean' ? collateral.funded : null;

    dom.setAttr(refs.host, 'data-quiet', quiet(data) ? 'true' : null);

    if (!data) return say('', [], false, null);

    if (venueDown(data)) {
      return say('Hyperliquid is not answering. These come back on their own.', [
        { key: 'equity', label: 'Trading money', value: '--', dim: true },
        { key: 'free', label: 'Free', value: '--', dim: true }
      ], false, null);
    }

    if (funded === null || (account && account.accountKnown === false)) {
      return say('Checking your trading account.', [], false, null);
    }

    if (funded === false) {
      return say('No trading money yet. Once there is some, Pro shows your positions, your orders and what they made.', [], true, false);
    }

    var items = [];
    items.push({ key: 'equity', label: 'Trading money', value: usdOr(account && account.equityUsd), dim: !isNum(account && account.equityUsd) });
    items.push({ key: 'free', label: 'Free', value: usdOr(account && account.freeUsd), dim: !isNum(account && account.freeUsd) });
    /* What the app's own open plans have posted, and what their stops cap the
       loss at. Both are the app's sums over its own plans, so they are only
       worth a tile once a plan is live; a position opened elsewhere is not in
       them, which the title says. */
    var inTrades = account && isNum(account.atRiskUsd) ? account.atRiskUsd : 0;
    if (inTrades > 0) {
      items.push({ key: 'margin', label: 'In trades', value: dom.usd(inTrades), dim: false, title: 'What your open plans have posted as margin.' });
      var maxLoss = account && isNum(account.maxLossUsd) ? account.maxLossUsd : null;
      if (maxLoss !== null && maxLoss > 0) {
        items.push({ key: 'loss', label: 'Max loss', value: dom.usd(maxLoss), dim: false, title: 'The most your open plans lose if every stop fills, fees in. Positions opened outside Phosphor are not counted.' });
      }
    }
    return say('', items, false, true);
  }

  function say(note, items, offerFund, funded) {
    dom.setText(refs.note, note);
    dom.setHidden(refs.note, !note);
    dom.setHidden(refs.fund, !offerFund);
    dom.setAttr(refs.host, 'data-funded', funded === null ? null : (funded ? 'true' : 'false'));
    dom.reconcile(refs.figures, items, function (item) {
      return item.key;
    }, function () {
      var cell = dom.el('div', 'pro-sum-figure');
      cell.appendChild(dom.el('dt', 'pro-sum-label'));
      cell.appendChild(dom.el('dd', 'pro-sum-value num tick'));
      return cell;
    }, function (cell, item) {
      dom.setText(cell.children[0], item.label);
      dom.setNumber(cell.children[1], item.value);
      dom.setAttr(cell.children[1], 'data-dim', item.dim ? 'true' : null);
      dom.setAttr(cell, 'title', item.title || null);
    });
    dom.setHidden(refs.figures, !items.length);
  }

  /* Nothing on the deck to list: no position, no plan and no fill. Pro then
     draws its header alone, calm, rather than three empty sections. */
  function quiet(data) {
    if (!data) return false;
    var none = function (list) { return !Array.isArray(list) || list.length === 0; };
    return none(data.positions) && none(data.plans) && none(data.fills);
  }

  /* The one action on an empty account: ask the assistant, in the thread, in
     the person's own words. The move it proposes waits for the click on its
     card like every other. With nobody at the wheel the button says what to do
     first rather than failing quietly. */
  function askToFund() {
    var agent = window.PhosphorAgent;
    var sent = !!(agent && typeof agent.send === 'function' && agent.send(FUND_ASK));
    if (sent) return;
    dom.setText(refs.note, 'Start your agent, then ask it to add money to your trading account.');
    dom.setHidden(refs.note, false);
  }

  function venueDown(data) {
    var venue = data && data.venue;
    if (!venue) return false;
    return venue.connected === false || !!venue.error;
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /* A figure the venue did not state is a dash, never $0.00. */
  function usdOr(value) {
    return isNum(value) ? dom.usd(value) : '--';
  }

  window.PhosphorPro = { boot: boot };
})();
