/* Basic: one 640 px column, for a person who has never held a wallet.

   The one job is to answer "is my money OK" and get one safe yes or no out of
   them. No prices, no donut, no chains, no hex, no percentages under an hour.

   The hero is unboxed: the total, then one sentence that says what is happening
   to the money right now. Under it the rules strip, which is the safety model in
   one line and the surface policy_show lands on. Everything below the strip is a
   surface, because a bordered box is the mark of something the assistant can
   touch, and static text is not given one. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  /* How long a row that just moved keeps the afterglow. The same figure as a
     surface's decay, because it is the same idea at row scale. */
  var CHANGED_MS = 2400;

  /* The three chains POST /api/yield/withdraw accepts. Anything else, including
     nothing, is refused 400 before the request reaches a rail. */
  var WITHDRAW_CHAINS = ['eth', 'base', 'arb'];

  /* Basic does not name a chain anywhere else, on purpose. It names one here,
     and only when money is earning on more than one, because the alternative is
     a button that moves one of two positions and does not say which. */
  var CHAIN_NAMES = { eth: 'Ethereum', base: 'Base', arb: 'Arbitrum' };

  var refs = {};
  var mounted = false;
  var allActivity = false;

  function boot() {
    var host = document.getElementById('view-basic');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    /* The hero sentence is the assistant's state as much as the money's, and the
       phase moves on driver frames the store never sees. */
    window.addEventListener('phosphor:agent-phase', renderState);
    window.PhosphorReceipts.onChange(function () {
      if (refs.activity.node.dataset.open === 'true') renderActivity();
    });
  }

  function build(host) {
    var col = dom.el('div', 'basic-col');

    /* The hero has no field and no box of its own. A second canvas at a second
       cell size drew a rectangle you could see the edges of, and a border here
       would say the assistant can act on a number. The one page field runs
       behind the column and the total is the largest quiet thing on it. */
    var hero = dom.el('section', 'hero');
    var total = dom.el('p', 'balance tick');
    total.dataset.role = 'total';
    var line = dom.el('p', 'hero-line');
    line.dataset.role = 'state';
    hero.appendChild(total);
    hero.appendChild(line);
    col.appendChild(hero);

    var warning = dom.el('div', 'banner');
    warning.dataset.tone = 'warn';
    warning.setAttribute('role', 'alert');
    warning.hidden = true;
    var warnText = dom.el('span');
    warnText.dataset.role = 'warning';
    warning.appendChild(warnText);
    col.appendChild(warning);

    /* Your rules, one strip. It teaches the safety model in a sentence and it is
       where policy_show lands, so it is a surface without being a box. */
    var strip = dom.el('p', 'strip');
    strip.dataset.surface = 'rules';
    col.appendChild(strip);

    var hold = panel('What you hold', 'holdings');
    var holdBody = dom.el('div', 'panel-body-flush');
    hold.node.appendChild(holdBody);
    var smallNote = dom.el('p', 'meta panel-body');
    smallNote.hidden = true;
    hold.node.appendChild(smallNote);
    col.appendChild(hold.node);

    var earning = panel('Earning', 'earning');
    var earningBody = dom.el('div', 'panel-body stack');
    earning.node.appendChild(earningBody);
    col.appendChild(earning.node);

    var moneyIn = fold('Money in', 'Where to send money', 'moneyin');
    col.appendChild(moneyIn.node);

    var activity = fold('Activity', 'What happened, newest first', 'activity');
    col.appendChild(activity.node);

    host.appendChild(col);

    refs = {
      total: total,
      state: line,
      warning: warning,
      warnText: warnText,
      strip: strip,
      holdBody: holdBody,
      smallNote: smallNote,
      earningBody: earningBody,
      moneyIn: moneyIn,
      activity: activity,
      activityBody: activity.body
    };

    moneyIn.onOpen(function () {
      window.PhosphorMoneyIn.render(moneyIn.body);
    });
    activity.onOpen(function () {
      window.PhosphorReceipts.load();
      renderActivity();
    });
  }

  function panel(title, surface) {
    var node = dom.el('section', 'panel');
    node.dataset.surface = surface;
    var head = dom.el('div', 'panel-head');
    head.appendChild(dom.el('h2', 'title-sm', title));
    node.appendChild(head);
    return { node: node, head: head };
  }

  function fold(title, note, surface) {
    var node = dom.el('section', 'fold');
    node.dataset.surface = surface;
    var head = dom.el('button', 'fold-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    var left = dom.el('div', 'stack-2');
    left.appendChild(dom.el('span', 'title-sm', title));
    left.appendChild(dom.el('span', 'meta', note));
    head.appendChild(left);
    /* The caret is drawn, not typed. A glyph in a control reads as an arrow in
       the label, and the window has none of those. */
    var mark = dom.el('span', 'fold-mark');
    mark.setAttribute('aria-hidden', 'true');
    head.appendChild(mark);
    var body = dom.el('div', 'fold-body panel-body');
    body.hidden = true;
    node.appendChild(head);
    node.appendChild(body);

    var opened = [];
    dom.on(head, 'click', function () {
      var open = node.dataset.open === 'true';
      if (open) {
        delete node.dataset.open;
        body.hidden = true;
        head.setAttribute('aria-expanded', 'false');
        return;
      }
      node.dataset.open = 'true';
      body.hidden = false;
      head.setAttribute('aria-expanded', 'true');
      for (var i = 0; i < opened.length; i += 1) opened[i]();
    });

    return {
      node: node,
      body: body,
      onOpen: function (fn) { opened.push(fn); }
    };
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    var basic = state.basic || {};

    dom.setNumber(refs.total, basic.totalLine || '');
    renderState();
    renderRules(state);

    dom.setText(refs.warnText, basic.warning || '');
    dom.setHidden(refs.warning, !basic.warning);

    renderHoldings(basic);
    renderEarning(state, basic);

    if (refs.activity.node.dataset.open === 'true') renderActivity();
  }

  /* Four sentences, one of them true. The order is the window's order: a locked
     wallet outranks a pending ask, which outranks a working assistant. */
  function renderState() {
    if (!mounted) return;
    var state = store.get() || {};
    var lock = state.lock || {};
    var word = 'Nothing is connected to it right now.';
    if (lock.state === 'locked' || lock.state === 'no_wallet' || lock.state === 'needs_migration') {
      word = 'Locked. Nothing moves.';
    } else if (pendingCount(state) > 0) {
      word = 'Waiting for you.';
    } else if (window.PhosphorAgent && typeof window.PhosphorAgent.isWorking === 'function'
      && window.PhosphorAgent.isWorking()) {
      word = 'Your assistant is reading it.';
    }
    dom.setText(refs.state, word);
  }

  function pendingCount(state) {
    if (!Array.isArray(state.proposals)) return 0;
    var count = 0;
    for (var i = 0; i < state.proposals.length; i += 1) {
      var p = state.proposals[i];
      if (p && (p.status === 'pending' || p.status === 'pending_unlock')) count += 1;
    }
    return count;
  }

  /* The three numbers a person has to know, in the order they meet them: the one
     that stops the assistant and asks, then the two that stop it outright. */
  function renderRules(state) {
    var out = (state.policy && state.policy.outbound) || {};
    var parts = [];
    if (typeof out.humanClickAboveUsd === 'number') {
      parts.push('Asks you above ' + dom.usd(out.humanClickAboveUsd, 0) + '.');
    }
    if (typeof out.maxPerTransactionUsd === 'number' && typeof out.maxPerSessionUsd === 'number') {
      parts.push('Refuses above ' + dom.usd(out.maxPerTransactionUsd, 0) + ' at once and '
        + dom.usd(out.maxPerSessionUsd, 0) + ' a day.');
    } else if (typeof out.maxPerTransactionUsd === 'number') {
      parts.push('Refuses above ' + dom.usd(out.maxPerTransactionUsd, 0) + ' at once.');
    }
    dom.setText(refs.strip, parts.length ? parts.join(' ') : 'No limits are set yet.');
  }

  /* Dust is not an answer to "is my money OK". A row worth under a dollar is
     counted rather than listed, so the list is the things a person would
     actually name if you asked them what they had. */
  function renderHoldings(basic) {
    var all = Array.isArray(basic.holdings) ? basic.holdings : [];
    var holdings = [];
    var small = 0;
    for (var h = 0; h < all.length; h += 1) {
      if (Number(all[h].valueUsd) >= 1) holdings.push(all[h]);
      else small += 1;
    }
    dom.setText(refs.smallNote, small === 0 ? '' : (small === 1
      ? 'One smaller holding, not listed.'
      : small + ' smaller holdings, not listed.'));
    dom.setHidden(refs.smallNote, small === 0);

    if (!holdings.length && !store.loaded()) {
      renderHoldSkeleton();
      return;
    }
    if (!holdings.length) {
      dom.clear(refs.holdBody);
      delete refs.holdBody.dataset.skeleton;
      refs.holdBody.__keyed = null;
      refs.holdBody.appendChild(emptyBlock('Nothing here yet',
        'Open Money in and send something to one of your addresses.'));
      return;
    }
    if (refs.holdBody.dataset.skeleton === 'true') {
      dom.clear(refs.holdBody);
      delete refs.holdBody.dataset.skeleton;
    }

    dom.reconcile(refs.holdBody, holdings, function (row) {
      return row.name;
    }, function () {
      var node = dom.el('div', 'row');
      var main = dom.el('div', 'row-main');
      main.appendChild(dom.el('span', 'body'));
      var side = dom.el('div', 'row-side stack-2');
      side.appendChild(dom.el('span', 'body mono tick'));
      side.appendChild(dom.el('span', 'meta mono'));
      node.appendChild(main);
      node.appendChild(side);
      return node;
    }, function (node, row) {
      dom.setText(node.children[0].children[0], row.name);
      dom.setNumber(node.children[1].children[0], row.valueLine);
      dom.setText(node.children[1].children[1], row.quantityLine);
      markChanged(node, row.valueLine);
    });
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

  function renderHoldSkeleton() {
    if (refs.holdBody.dataset.skeleton === 'true') return;
    refs.holdBody.dataset.skeleton = 'true';
    dom.clear(refs.holdBody);
    for (var i = 0; i < 3; i += 1) {
      var row = dom.el('div', 'row');
      var left = dom.el('div', 'skel grow');
      left.style.height = '16px';
      var right = dom.el('div', 'skel');
      right.style.height = '16px';
      right.style.width = '84px';
      row.appendChild(left);
      row.appendChild(right);
      refs.holdBody.appendChild(row);
    }
  }

  /* The panel is always here, empty or not. It is where yield_read lands, and a
     surface that only exists once it has something on it is a surface the beam
     cannot aim at.

     BasicView.earning is a sentence the server already wrote, not an object.
     This read .line, .summary and .madeLine off it, so the panel unhid on a
     truthy string and rendered an empty paragraph over the button. */
  function renderEarning(state, basic) {
    var earning = typeof basic.earning === 'string' ? basic.earning : '';
    var y = state.yield;
    dom.clear(refs.earningBody);

    if (!earning && !(y && (y.totalPrincipalUsd || y.totalValueUsd))) {
      refs.earningBody.appendChild(emptyBlock('Nothing is earning',
        'Ask your assistant to put some of your dollars to work.'));
      return;
    }

    if (earning) refs.earningBody.appendChild(dom.el('p', 'body', earning));

    var chains = withdrawChains(y);
    if (!chains.length) return;
    var actions = dom.el('div', 'hstack-2 wrap');
    for (var c = 0; c < chains.length; c += 1) {
      actions.appendChild(withdrawButton(chains[c], chains.length > 1));
    }
    refs.earningBody.appendChild(actions);
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
      name ? 'Bring back the money on ' + CHAIN_NAMES[chain] : 'Bring it back'));
    dom.on(button, 'click', function () {
      window.PhosphorShell.setPending(button, true, 'Bringing it back');
      api.yieldWithdraw({ chain: chain })
        .then(function () { return window.PhosphorShell.refresh({}); })
        .catch(function (err) { window.PhosphorToast.show(net.readable(err, true), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    });
    return button;
  }

  /* Five rows, newest first, and a way to the rest that is a real action rather
     than a word that goes nowhere. */
  function renderActivity() {
    var host = refs.activityBody;
    var all = window.PhosphorReceipts.get();
    if (refs.seeAll && refs.seeAll.parentNode) refs.seeAll.parentNode.removeChild(refs.seeAll);
    window.PhosphorReceipts.render(host, allActivity ? {} : { limit: 5 });
    if (allActivity || all.length <= 5) return;
    var more = dom.el('button', 'btn btn-quiet see-all');
    more.type = 'button';
    more.appendChild(dom.el('span', 'btn-label', 'See all'));
    dom.on(more, 'click', function () {
      allActivity = true;
      renderActivity();
    });
    refs.seeAll = more;
    host.appendChild(more);
  }

  function emptyBlock(title, note) {
    var empty = dom.el('div', 'empty');
    empty.appendChild(dom.el('p', 'empty-title', title));
    empty.appendChild(dom.el('p', '', note));
    return empty;
  }

  window.PhosphorBasic = { boot: boot };
})();
