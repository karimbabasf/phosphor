/* Pro: a 12-column grid at most 1440 wide, for a person who already holds
   crypto and wants to see everything and set the rules.

   The same four components Basic has, at higher density: rows 36 px instead of
   48, labels 13 px instead of 14. Four panels, four surfaces, and the chart is
   in trade, which is the single biggest de-noising move available and costs
   nothing because trade is one word away. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  /* The same figure as a surface's decay: a row that just moved keeps the
     afterglow for as long as the panel it sits in would. */
  var CHANGED_MS = 2400;

  var refs = {};
  var mounted = false;

  var CHAIN_NAMES = {
    eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR'
  };

  /* The three chains POST /api/yield/withdraw accepts. Anything else, including
     nothing, is refused 400 before the request reaches a rail. */
  var WITHDRAW_CHAINS = ['eth', 'base', 'arb'];

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
        window.PhosphorReceipts.render(refs.activityBody, { limit: 12 });
        renderFeeTotal();
      }
    });
  }

  function build(host) {
    var grid = dom.el('div', 'pro-grid pro-dense');

    /* Money: one table. Ready to move and Trading money are rows in it rather
       than panels of their own, because they are money the person holds. */
    var money = panel('Money', 'span-7', 'holdings');
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
    var earning = panel('Earning', 'span-5', 'earning');
    var earningBody = dom.el('div', 'stack');
    earning.body.appendChild(earningBody);
    grid.appendChild(earning.node);

    /* Your limits: the policy as sentences, the daily limit, the allowlist. */
    var limits = panel('Limits', 'span-5', 'rules');
    var limitsBody = dom.el('div', 'stack');
    limits.body.appendChild(limitsBody);
    grid.appendChild(limits.node);

    /* Activity: receipts, with fees per row and a total for the window. */
    var activity = panel('Activity', 'span-7', 'activity');
    var activityBody = dom.el('div', 'panel-body-flush activity-list');
    activity.body.appendChild(activityBody);
    var feeRow = dom.el('div', 'between panel-total');
    feeRow.appendChild(dom.el('span', 'label', 'Fees in this window'));
    var feeValue = dom.el('span', 'body mono');
    feeRow.appendChild(feeValue);
    activity.body.appendChild(feeRow);
    grid.appendChild(activity.node);

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

    window.PhosphorReceipts.load();
  }

  function panel(title, span, surface) {
    var node = dom.el('section', 'panel ' + span);
    node.dataset.surface = surface;
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

    /* Two blocks used to sit here adding Ready to move and Trading money rows
       from state.intents and state.trade. buildState emits neither key, so both
       were dead and the table never gained either row. Money held at Intents is
       already in wallet.rows as a row of kind intents; money at the trading
       venue is only in /api/trade, which this screen does not read, and inventing
       it from a key that does not exist was never going to show it. */
    var all = rows;

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
      markChanged(tr, dom.usd(row.valueUsd));
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

  /* Every name here is YieldView's own: totalPrincipalUsd, totalEarnedUsd,
     autoAllocate. This read principalUsd, earnedUsd, apy and auto, and fact()
     skips an empty value, so all three figures were dropped and the panel was
     two buttons with the auto one permanently reading off. */
  function renderEarning(state) {
    var y = state.yield;
    dom.clear(refs.earningBody);
    if (!y || (!y.totalPrincipalUsd && !y.totalValueUsd)) {
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'Nothing is earning'));
      empty.appendChild(dom.el('p', '', 'Ask your assistant to put some of your dollars to work.'));
      refs.earningBody.appendChild(empty);
      return;
    }

    var facts = dom.el('div', 'facts');
    fact(facts, 'Supplied', typeof y.totalPrincipalUsd === 'number' ? dom.usd(y.totalPrincipalUsd) : '');
    /* Places follow the number, the same rule fees use: four only when two would
       round the figure to nothing. A day's interest is fractions of a cent and a
       year's is not, and $94.1200 reads as a machine printing a float. */
    fact(facts, 'Earned', typeof y.totalEarnedUsd === 'number'
      ? dom.usd(y.totalEarnedUsd, Math.abs(y.totalEarnedUsd) < 0.01 ? 4 : 2)
      : '');
    var rate = rateOn(y);
    fact(facts, 'Rate', rate === null ? '' : dom.pct(rate, 2));
    refs.earningBody.appendChild(facts);

    /* basisUnknown counts positions this app can derive no cost for, so their
       value is in the total and what they made is in nothing. A figure that is
       short by an unknown amount is printed with the reason beside it. */
    if (y.basisUnknown > 0) {
      refs.earningBody.appendChild(dom.el('p', 'meta', y.basisUnknown === 1
        ? 'One position has no cost on record, so what it made is not in that figure.'
        : y.basisUnknown + ' positions have no cost on record, so what they made is not in that figure.'));
    }
    if (y.stale) {
      refs.earningBody.appendChild(dom.el('p', 'meta warn',
        'The last read of these failed. These are the numbers from the one before it.'));
    }

    var actions = dom.el('div', 'hstack-2 wrap');
    var chains = withdrawChains(y);
    for (var c = 0; c < chains.length; c += 1) {
      actions.appendChild(withdrawButton(chains[c], chains.length > 1));
    }

    var auto = dom.el('button', 'btn btn-ghost');
    auto.appendChild(dom.el('span', 'btn-label', y.autoAllocate ? 'Auto-earn is on' : 'Auto-earn is off'));
    actions.appendChild(auto);
    refs.earningBody.appendChild(actions);
  }

  /* The rate the money is actually getting, from the venue quote for the chain it
     is on. y.best is the best rate available anywhere, which is a different fact
     and would overstate the return every time the money is not on that chain. */
  function rateOn(y) {
    var chains = withdrawChains(y);
    var venues = Array.isArray(y.venues) ? y.venues : [];
    for (var i = 0; i < venues.length; i += 1) {
      if (chains.indexOf(venues[i].chain) < 0) continue;
      if (venues[i].rate && typeof venues[i].rate.apy === 'number') return venues[i].rate.apy;
    }
    return null;
  }

  /* Which chains the money is actually on. The route takes the whole position on
     one named chain and refuses any other value, so a button that sends nothing
     comes back "chain must be one of eth, base, arb; got ''" and moves no money.
     Both Bring it back buttons in this window did exactly that. */
  function withdrawChains(y) {
    var out = [];
    var positions = (y && Array.isArray(y.positions)) ? y.positions : [];
    for (var i = 0; i < positions.length; i += 1) {
      var chain = positions[i].chain;
      if (WITHDRAW_CHAINS.indexOf(chain) < 0 || out.indexOf(chain) >= 0) continue;
      out.push(chain);
    }
    if (!out.length && y && WITHDRAW_CHAINS.indexOf(y.chain) >= 0) out.push(y.chain);
    return out;
  }

  function withdrawButton(chain, name) {
    var button = dom.el('button', 'btn');
    button.type = 'button';
    button.appendChild(dom.el('span', 'btn-label',
      name ? 'Bring it back from ' + chainName(chain) : 'Bring it back'));
    dom.on(button, 'click', function () {
      window.PhosphorShell.setPending(button, true, 'Bringing it back');
      api.yieldWithdraw({ chain: chain })
        .then(function () { return window.PhosphorShell.refresh({}); })
        .catch(function (err) { window.PhosphorToast.show(net.readable(err, true), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    });
    return button;
  }

  function renderLimits(state) {
    dom.clear(refs.limitsBody);
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
      if (used > 0.8) fill.dataset.tone = 'warn';
      meter.appendChild(fill);
      block.appendChild(meter);
      /* resetsAt is when the oldest counted spend leaves the window, not
         midnight. A cap that rolls is described as rolling. */
      block.appendChild(dom.el('p', 'meta', daily.resetsAt === null
        ? 'Nothing has been spent in the last 24 hours.'
        : 'The oldest of it stops counting ' + resetWords(daily.resetsAt) + '.'));
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
        var edit = dom.el('button', 'btn btn-quiet btn-sm');
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
    wrap.appendChild(dom.el('p', 'label', 'Money can only go to your own wallets and these venues'));
    if (!allow.length) {
      wrap.appendChild(dom.el('p', 'meta', 'No list is set, so a destination is checked against your limits alone.'));
    } else {
      var box = dom.el('div', 'allowlist');
      for (var a = 0; a < allow.length; a += 1) {
        var entry = allow[a];
        var named = VENUE_NAMES[entry];
        if (named) {
          /* A venue is a name, not an id. An address has to be read character
             by character to be checked, and these two cannot be. */
          box.appendChild(dom.el('p', 'body', named));
          continue;
        }
        box.appendChild(dom.el('p', 'addr dim', entry));
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
    var total = window.PhosphorReceipts.feeTotal();
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
