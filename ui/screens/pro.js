/* Pro: the same conversation on the left, the trading side on the right.

   The trading side reads top to bottom: your money in one line (this file),
   then the market, the chart, and the positions and orders under it
   (ui/screens/trade.js, which builds into #view-trade). The two views show
   together on Pro, and on Trade, which is the same screen under the name the
   server still uses for it (ui/design/pro.css).

   Your money is the balance total with what it is, from the same server view
   the Basic panel draws (state.basic), and beside it the trading account:
   what it holds, what is free, what is at risk. Those come off the trade
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
       first time the trading side is on screen. */
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
    var line = dom.el('section', 'pro-sum');
    line.setAttribute('aria-label', 'Your money');

    var money = dom.el('div', 'pro-sum-money');
    money.dataset.surface = 'holdings';
    var total = dom.el('p', 'pro-sum-total mono tick');
    total.hidden = true;
    var skel = dom.el('span', 'skel pro-sum-skel');
    skel.setAttribute('aria-hidden', 'true');
    var caption = dom.el('p', 'pro-sum-caption');
    money.appendChild(total);
    money.appendChild(skel);
    money.appendChild(caption);
    line.appendChild(money);

    var account = dom.el('div', 'pro-sum-account');
    account.dataset.surface = 'account';
    account.setAttribute('aria-label', 'Your trading account');
    var figures = dom.el('dl', 'pro-sum-figures');
    var note = dom.el('p', 'pro-sum-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    var fund = dom.el('button', 'btn btn-ghost btn-sm pro-sum-fund');
    fund.type = 'button';
    fund.appendChild(dom.el('span', 'btn-label', 'Add some'));
    fund.hidden = true;
    account.appendChild(figures);
    account.appendChild(note);
    account.appendChild(fund);
    line.appendChild(account);

    host.appendChild(line);

    refs = {
      total: total,
      skel: skel,
      caption: caption,
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
  }

  /* ---------- the trading account ---------- */

  /* Four answers, each its own sentence, because they mean different things
     to a person deciding a trade:
       no read yet, or the venue has not answered (collateral.funded null)
       the venue is not answering now: the figures read as unknown, never zero
       nothing on the account, or only dust (collateral.funded false)
       money on it: what it holds, what is free, what is at risk. */
  function renderTrading() {
    if (!mounted) return;
    var data = trade && trade.data ? trade.data : null;
    var account = data && data.account ? data.account : null;
    var collateral = data && data.collateral ? data.collateral : null;
    var funded = collateral && typeof collateral.funded === 'boolean' ? collateral.funded : null;

    if (!data) return say('', [], false);

    if (venueDown(data)) {
      return say('', [
        { key: 'equity', label: 'Trading money', value: '--', dim: true },
        { key: 'free', label: 'Free', value: '--', dim: true }
      ], false);
    }

    if (funded === null || (account && account.accountKnown === false)) {
      return say('Checking your trading account.', [], false);
    }

    if (funded === false) return say('No trading money yet.', [], true);

    var items = [];
    items.push({ key: 'equity', label: 'Trading money', value: usdOr(account && account.equityUsd), dim: !isNum(account && account.equityUsd) });
    items.push({ key: 'free', label: 'Free', value: usdOr(account && account.freeUsd), dim: !isNum(account && account.freeUsd) });
    /* At risk is the app's own sum over its own plans, so it is always a
       number; it is only worth a column once something is at stake. */
    var atRisk = account && isNum(account.atRiskUsd) ? account.atRiskUsd : 0;
    if (atRisk > 0) items.push({ key: 'risk', label: 'At risk', value: dom.usd(atRisk), dim: false });
    return say('', items, false);
  }

  function say(note, items, offerFund) {
    dom.setText(refs.note, note);
    dom.setHidden(refs.note, !note);
    dom.setHidden(refs.fund, !offerFund);
    dom.reconcile(refs.figures, items, function (item) {
      return item.key;
    }, function () {
      var cell = dom.el('div', 'pro-sum-figure');
      cell.appendChild(dom.el('dt', 'pro-sum-label'));
      cell.appendChild(dom.el('dd', 'pro-sum-value mono tick'));
      return cell;
    }, function (cell, item) {
      dom.setText(cell.children[0], item.label);
      dom.setNumber(cell.children[1], item.value);
      dom.setAttr(cell.children[1], 'data-dim', item.dim ? 'true' : null);
    });
    dom.setHidden(refs.figures, !items.length);
  }

  /* The one action on an empty account: ask the assistant, in the thread, in
     the person's own words. The move it proposes waits for the click on its
     card like every other. With nobody at the wheel the button says what to do
     first rather than failing quietly. */
  function askToFund() {
    var agent = window.PhosphorAgent;
    var sent = !!(agent && typeof agent.send === 'function' && agent.send(FUND_ASK));
    if (sent) return;
    dom.setText(refs.note, 'Start your assistant, then ask it to add money to your trading account.');
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
