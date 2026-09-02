/* Pro: a 12-column grid at most 1440 wide, for a person who already holds
   crypto and wants to see everything and set the rules.

   Five panels and one modal. The chart moved to trade, which is the single
   biggest de-noising move available and costs nothing because trade is one
   word away. The donut, the fragmentation block and the LOG and GAS modals are
   gone: fees ride on the Activity rows now, with a total for the window. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;
  var fixtures = window.PhosphorFixtures;

  var refs = {};
  var mounted = false;

  var CHAIN_NAMES = {
    eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR'
  };

  function boot() {
    var host = document.getElementById('view-pro');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    window.PhosphorActivity.onChange(function () {
      if (refs.activityBody) {
        window.PhosphorActivity.render(refs.activityBody, { limit: 12 });
        renderFeeTotal();
      }
    });
  }

  function build(host) {
    var grid = dom.el('div', 'pro-grid');

    /* Money: one table. Ready to move and Trading money are rows in it rather
       than panels of their own, because they are money the person holds. */
    var money = panel('Money', 'span-8');
    var moneyWrap = dom.el('div', 'table-wrap');
    moneyWrap.style.setProperty('--table-max', '440px');
    var table = dom.el('table', 'table');
    var head = dom.el('thead');
    var headRow = dom.el('tr');
    ['What', 'Where', 'Amount', 'Value', 'Share'].forEach(function (label, i) {
      var th = dom.el('th', i >= 2 ? 'num' : '', label);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    var body = dom.el('tbody');
    table.appendChild(head);
    table.appendChild(body);
    moneyWrap.appendChild(table);
    money.body.appendChild(moneyWrap);
    var moneyTotal = dom.el('div', 'between panel-total');
    moneyTotal.appendChild(dom.el('span', 'label', 'Total'));
    var totalValue = dom.el('span', 'title mono tick');
    moneyTotal.appendChild(totalValue);
    money.body.appendChild(moneyTotal);
    var emptyNote = dom.el('p', 'meta');
    money.body.appendChild(emptyNote);
    grid.appendChild(money.node);

    /* Earning. */
    var earning = panel('Earning', 'span-4');
    var earningBody = dom.el('div', 'stack');
    earning.body.appendChild(earningBody);
    grid.appendChild(earning.node);

    /* Your limits: the policy as sentences, the daily limit, the allowlist. */
    var limits = panel('Your limits', 'span-5');
    var limitsBody = dom.el('div', 'stack');
    limits.body.appendChild(limitsBody);
    grid.appendChild(limits.node);

    /* Activity: receipts, with fees per row and a total for the window. */
    var activity = panel('Activity', 'span-7');
    var activityBody = dom.el('div', 'panel-body-flush activity-list');
    activity.body.appendChild(activityBody);
    var feeRow = dom.el('div', 'between panel-total');
    feeRow.appendChild(dom.el('span', 'label', 'Fees in this window'));
    var feeValue = dom.el('span', 'body mono');
    feeRow.appendChild(feeValue);
    activity.body.appendChild(feeRow);
    grid.appendChild(activity.node);

    /* Your assistant. */
    var assistant = panel('', 'span-12');
    assistant.head.hidden = true;
    var assistantBody = dom.el('div', 'agent-panel');
    assistant.body.appendChild(assistantBody);
    grid.appendChild(assistant.node);

    host.appendChild(grid);

    refs = {
      moneyPanel: money.node,
      moneyBody: body,
      totalValue: totalValue,
      emptyNote: emptyNote,
      earningPanel: earning.node,
      earningBody: earningBody,
      limitsBody: limitsBody,
      activityPanel: activity.node,
      activityBody: activityBody,
      feeValue: feeValue
    };

    window.PhosphorAgent.mount(assistantBody);
    window.PhosphorActivity.load();
  }

  function panel(title, span) {
    var node = dom.el('section', 'panel ' + span);
    var head = dom.el('div', 'panel-head');
    head.appendChild(dom.el('h2', 'title-sm', title));
    var body = dom.el('div', 'panel-body');
    node.appendChild(head);
    node.appendChild(body);
    return { node: node, head: head, body: body };
  }

  function chainName(id) {
    return CHAIN_NAMES[id] || String(id || '');
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    renderMoney(state);
    renderEarning(state);
    renderLimits(state);
    renderFeeTotal();
  }

  function renderMoney(state) {
    var wallet = state.wallet || {};
    var rows = Array.isArray(wallet.rows) ? wallet.rows.slice() : [];

    /* Ready to move and Trading money join the table as rows. */
    var extra = [];
    if (state.intents && typeof state.intents.totalUsd === 'number' && state.intents.totalUsd > 0) {
      extra.push({
        kind: 'intents',
        symbol: 'Ready to move',
        chain: '',
        quantity: null,
        valueUsd: state.intents.totalUsd,
        share: wallet.totalUsd ? state.intents.totalUsd / wallet.totalUsd : 0
      });
    }
    if (state.trade && state.trade.account && typeof state.trade.account.equity === 'number') {
      extra.push({
        kind: 'trading',
        symbol: 'Trading money',
        chain: '',
        quantity: null,
        valueUsd: state.trade.account.equity,
        share: wallet.totalUsd ? state.trade.account.equity / wallet.totalUsd : 0
      });
    }
    var all = rows.concat(extra);

    if (!all.length && !store.loaded()) {
      renderMoneySkeleton();
      return;
    }
    delete refs.moneyBody.dataset.skeleton;

    dom.reconcile(refs.moneyBody, all, function (row, i) {
      return (row.kind || 'token') + ':' + row.symbol + ':' + (row.chain || '') + ':' + i;
    }, function () {
      var tr = dom.el('tr');
      tr.appendChild(dom.el('td', 'strong'));
      tr.appendChild(dom.el('td', 'dim'));
      tr.appendChild(dom.el('td', 'num mono'));
      tr.appendChild(dom.el('td', 'num mono tick'));
      tr.appendChild(dom.el('td', 'num mono dim'));
      return tr;
    }, function (tr, row) {
      dom.setText(tr.children[0], row.symbol);
      dom.setText(tr.children[1], row.chain ? chainName(row.chain) : '');
      dom.setText(tr.children[2], row.quantity === null || row.quantity === undefined
        ? '' : dom.qty(row.quantity));
      dom.setNumber(tr.children[3], dom.usd(row.valueUsd));
      dom.setText(tr.children[4], dom.pct(row.share || 0));
    });

    dom.setNumber(refs.totalValue, dom.usd(wallet.totalUsd || 0));

    var notes = [];
    if (wallet.emptyCount) notes.push(wallet.emptyCount + ' empty, not listed');
    /* Per-chain staleness badges are gone from every row that reads fine. Only
       a chain that actually failed is named, and it is named in words. */
    var stale = Array.isArray(wallet.stale) ? wallet.stale : [];
    if (stale.length) {
      notes.push('Could not check ' + stale.map(chainName).join(', ') + '. Holdings there are unknown, not zero.');
    }
    dom.setText(refs.emptyNote, notes.join('. '));
    dom.setHidden(refs.emptyNote, !notes.length);
    dom.setAttr(refs.emptyNote, 'class', stale.length ? 'meta warn' : 'meta');
  }

  function renderMoneySkeleton() {
    if (refs.moneyBody.dataset.skeleton === 'true') return;
    refs.moneyBody.dataset.skeleton = 'true';
    dom.clear(refs.moneyBody);
    for (var i = 0; i < 5; i += 1) {
      var tr = dom.el('tr');
      for (var c = 0; c < 5; c += 1) {
        var td = dom.el('td');
        var bar = dom.el('div', 'skel');
        bar.style.height = '14px';
        td.appendChild(bar);
        tr.appendChild(td);
      }
      refs.moneyBody.appendChild(tr);
    }
  }

  function renderEarning(state) {
    var y = state.yield;
    dom.clear(refs.earningBody);
    if (!y) {
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'Nothing is earning'));
      empty.appendChild(dom.el('p', '', 'Ask your assistant to put some of your dollars to work.'));
      refs.earningBody.appendChild(empty);
      return;
    }

    var facts = dom.el('div', 'facts');
    fact(facts, 'Supplied', typeof y.principalUsd === 'number' ? dom.usd(y.principalUsd) : '');
    fact(facts, 'Earned', typeof y.earnedUsd === 'number' ? dom.usd(y.earnedUsd, 4) : '');
    fact(facts, 'Rate today', typeof y.apy === 'number' ? dom.pct(y.apy, 2) : '');
    refs.earningBody.appendChild(facts);

    var actions = dom.el('div', 'hstack-2');
    var withdraw = dom.el('button', 'btn');
    withdraw.appendChild(dom.el('span', 'btn-label', 'Bring it back'));
    actions.appendChild(withdraw);

    var auto = dom.el('button', 'btn btn-ghost');
    auto.appendChild(dom.el('span', 'btn-label', y.auto ? 'Auto-earn is on' : 'Auto-earn is off'));
    actions.appendChild(auto);
    refs.earningBody.appendChild(actions);

    dom.on(withdraw, 'click', function () {
      window.PhosphorShell.setPending(withdraw, true, 'Bringing it back');
      api.yieldWithdraw({})
        .then(function () { return window.PhosphorShell.refresh({}); })
        .catch(function (err) { window.PhosphorToast.show(net.readable(err, true), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(withdraw, false); });
    });
  }

  function renderLimits(state) {
    dom.clear(refs.limitsBody);
    var policy = state.policy || {};
    var sentences = state.sentences || policy.sentences || [];

    /* The daily limit: rolling 24 hours, survives a restart, so it is a limit a
       person can reason about rather than one that resets when the app does. */
    var daily = state.dailyLimit || (fixtures.active ? fixtures.dailyLimit() : null);
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
      if (used > 0.8) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      block.appendChild(meter);
      block.appendChild(dom.el('p', 'meta', 'Resets ' + resetWords(daily.resetsAt) + '.'));
      refs.limitsBody.appendChild(block);
    }

    /* The destination sentence is dropped here because the allowlist gets its
       own block below, and printing eight addresses twice on one panel is how a
       person stops reading either copy. */
    var spoken = sentences.filter(function (line) {
      return !/allowed destinations/i.test(String(line));
    });
    if (spoken.length) {
      var list = dom.el('div', 'stack-2');
      for (var i = 0; i < spoken.length; i += 1) {
        var row = dom.el('div', 'between limit-row');
        row.appendChild(dom.el('span', 'body grow', spoken[i]));
        var edit = dom.el('button', 'btn btn-quiet');
        edit.appendChild(dom.el('span', 'btn-label', 'Edit'));
        row.appendChild(edit);
        dom.on(edit, 'click', function () {
          window.PhosphorToast.show('Ask your assistant to change this. A limit change files a request you have to click.');
        });
        list.appendChild(row);
      }
      refs.limitsBody.appendChild(list);
    }

    /* The destination allowlist existed in the policy engine with no way to see
       it. This is where it lives now. */
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    var wrap = dom.el('div', 'stack-2');
    wrap.appendChild(dom.el('p', 'label', 'Money can only go to these'));
    if (!allow.length) {
      wrap.appendChild(dom.el('p', 'meta', 'No list is set, so a destination is checked against your limits alone.'));
    } else {
      var box = dom.el('div', 'allowlist');
      for (var a = 0; a < allow.length; a += 1) {
        box.appendChild(dom.el('p', 'addr dim', allow[a]));
      }
      wrap.appendChild(box);
    }
    refs.limitsBody.appendChild(wrap);
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
    var total = window.PhosphorActivity.feeTotal();
    dom.setText(refs.feeValue, total > 0 ? dom.fee(total) : 'None yet');
  }

  function fact(host, label, value) {
    if (!value) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body mono', value));
    host.appendChild(row);
  }

  window.PhosphorPro = { boot: boot };
})();
