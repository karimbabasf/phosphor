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

    /* Money: one row per COIN, with the places it sits in folded under it.
       It used to be one flat row per holding, so ETH in four places was four
       rows that a person had to add up themselves to answer "how much ETH do I
       have", and the coin they own was never on screen as one thing. */
    var money = panel('Money', 'span-7', 'holdings');
    var moneyList = dom.el('div', 'holding-list');
    money.body.appendChild(moneyList);
    var emptyNote = dom.el('p', 'meta');
    money.body.appendChild(emptyNote);
    grid.appendChild(money.node);

    /* Earning. Folded when it is empty, because "nothing is earning" is a whole
       sentence and does not need a panel opened to be read. */
    var earning = panel('Earning', 'span-5', 'earning', { folded: true });
    var earningBody = dom.el('div', 'stack');
    earning.body.appendChild(earningBody);
    grid.appendChild(earning.node);

    /* Activity: receipts, with fees per row and a total for the window. */
    var activity = panel('Activity', 'span-7', 'activity', { folded: true });
    var activityBody = dom.el('div', 'panel-body-flush activity-list');
    activity.body.appendChild(activityBody);
    var feeRow = dom.el('div', 'between panel-total');
    feeRow.appendChild(dom.el('span', 'label', 'Fees in this window'));
    var feeValue = dom.el('span', 'body mono');
    feeRow.appendChild(feeValue);
    activity.body.appendChild(feeRow);
    grid.appendChild(activity.node);

    /* Limits: the policy, the daily spend and the allowlist. Folded, and it is
       the panel the complaint was really about: seven sentences, seven buttons
       that only ever said "ask your assistant", and five raw addresses. It is
       reference material, so it reads as reference material now. */
    var limits = panel('Limits', 'span-5', 'rules', { folded: true });
    var limitsBody = dom.el('div', 'stack');
    limits.body.appendChild(limitsBody);
    grid.appendChild(limits.node);

    host.appendChild(grid);

    refs = {
      money: money,
      moneyPanel: money.node,
      moneyList: moneyList,
      emptyNote: emptyNote,
      earning: earning,
      earningPanel: earning.node,
      earningBody: earningBody,
      limits: limits,
      limitsBody: limitsBody,
      activity: activity,
      activityPanel: activity.node,
      activityBody: activityBody,
      feeValue: feeValue
    };

    window.PhosphorReceipts.load();
  }

  /* A PANEL IS A TITLE, ONE LINE THAT STANDS IN FOR THE REST, AND A FOLD.

     Karim, 2026-09-08: "i fucking hate the pro mode, looks too full of
     information, looks like a dictionary. we need titles, maybe sub
     information, and the rest fucking foldable."

     He is describing a screen with no hierarchy. Every panel was open, every
     panel was the same weight, and the Limits panel alone was seven full
     sentences with seven buttons and five raw addresses under them, so the
     screen had no shape and nothing to land on. Density is not the problem on
     an operator deck: undifferentiated density is.

     So a panel now owes a person one line even when it is shut. The summary is
     the fact you would have opened it for, and a section is folded by default
     when its detail is reference rather than news. The fold is remembered for
     the session, because a person who opens the allowlist to read it should not
     have to open it again on the next state frame. */
  function panel(title, span, surface, options) {
    var opts = options || {};
    var node = dom.el('section', 'panel ' + span);
    node.dataset.surface = surface;

    var head = dom.el('button', 'panel-head panel-fold');
    head.type = 'button';
    var heading = dom.el('div', 'panel-heading');
    heading.appendChild(dom.el('h2', 'title-sm', title));
    var summary = dom.el('p', 'panel-summary');
    heading.appendChild(summary);
    head.appendChild(heading);

    var right = dom.el('div', 'panel-head-right');
    var lead = dom.el('span', 'panel-lead mono tick');
    right.appendChild(lead);
    right.appendChild(dom.el('span', 'panel-caret'));
    head.appendChild(right);

    var body = dom.el('div', 'panel-body');
    node.appendChild(head);
    node.appendChild(body);

    var folded = opts.folded === true;
    function paint() {
      dom.setAttr(node, 'data-folded', folded ? 'true' : null);
      dom.setAttr(head, 'aria-expanded', folded ? 'false' : 'true');
      dom.setHidden(body, folded);
    }
    dom.on(head, 'click', function () {
      folded = !folded;
      paint();
    });
    paint();

    return { node: node, head: head, body: body, summary: summary, lead: lead };
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
    renderEarning(state);
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
    if (row.kind === 'yield') return 'Earning' + (row.chain ? ', ' + chainName(row.chain) : '');
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
    delete refs.moneyList.dataset.skeleton;

    var coins = groupByCoin(all);

    dom.reconcile(refs.moneyList, coins, function (coin) {
      return coin.id;
    }, function () {
      var wrap = dom.el('div', 'holding');
      var head = dom.el('button', 'holding-head');
      head.type = 'button';
      var name = dom.el('div', 'holding-name');
      name.appendChild(dom.el('span', 'holding-symbol'));
      name.appendChild(dom.el('span', 'holding-where meta'));
      head.appendChild(name);
      var figures = dom.el('div', 'holding-figures');
      figures.appendChild(dom.el('span', 'holding-qty mono meta'));
      figures.appendChild(dom.el('span', 'holding-value mono tick'));
      figures.appendChild(dom.el('span', 'holding-share mono meta'));
      head.appendChild(figures);
      wrap.appendChild(head);
      var places = dom.el('div', 'holding-places');
      wrap.appendChild(places);
      dom.on(head, 'click', function () {
        if (wrap.dataset.single === 'true') return;
        var open = wrap.dataset.open === 'true';
        dom.setAttr(wrap, 'data-open', open ? null : 'true');
      });
      return wrap;
    }, function (wrap, coin) {
      var head = wrap.children[0];
      var name = head.children[0];
      var figures = head.children[1];
      var single = coin.places.length < 2;
      dom.setAttr(wrap, 'data-single', single ? 'true' : null);

      dom.setText(name.children[0], coin.symbol);
      /* One place is named on the row itself, because a fold that opens onto a
         single line is a click that tells a person what they already knew. */
      dom.setText(name.children[1], single ? placeName(coin.places[0])
        : coin.places.length + ' places');
      dom.setText(figures.children[0], coin.countable ? dom.qty(coin.quantity) : '');
      dom.setNumber(figures.children[1], coin.priced ? dom.usd(coin.valueUsd) : 'not priced');
      dom.setAttr(figures.children[1], 'data-unpriced', coin.priced ? null : 'true');
      dom.setText(figures.children[2], coin.priced ? dom.pct(coin.share || 0) : '');
      markChanged(figures.children[1], coin.priced ? dom.usd(coin.valueUsd) : 'not priced');

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

    /* The total is the head of the panel, so it is on screen whether or not
       anybody has the holdings open. */
    setLead(refs.money, dom.usd(wallet.totalUsd || 0));
    setSummary(refs.money, moneySummary(coins, wallet));

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

  /* The coins, counted, plus anything the panel could not price. An unpriced
     row is named in the summary rather than left for somebody to spot in the
     list, because it is the one thing on this panel that makes the total wrong. */
  function moneySummary(coins, wallet) {
    if (!coins.length) return 'Nothing held';
    var unpriced = [];
    for (var i = 0; i < coins.length; i += 1) {
      if (!coins[i].priced) unpriced.push(coins[i].symbol);
    }
    var parts = [coins.length === 1 ? '1 coin' : coins.length + ' coins'];
    var places = 0;
    for (var j = 0; j < coins.length; j += 1) places += coins[j].places.length;
    if (places > coins.length) parts.push(places + ' places');
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
    for (var i = 0; i < 4; i += 1) {
      var line = dom.el('div', 'holding-place');
      var bar = dom.el('div', 'skel grow');
      bar.style.height = '14px';
      line.appendChild(bar);
      refs.moneyList.appendChild(line);
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
      setSummary(refs.earning, 'Nothing is earning');
      setLead(refs.earning, '');
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'Nothing is earning'));
      empty.appendChild(dom.el('p', '', 'Ask your assistant to put some of your dollars to work.'));
      refs.earningBody.appendChild(empty);
      return;
    }

    var apy = rateOn(y);
    setLead(refs.earning, typeof y.totalValueUsd === 'number' ? dom.usd(y.totalValueUsd)
      : (typeof y.totalPrincipalUsd === 'number' ? dom.usd(y.totalPrincipalUsd) : ''));
    setSummary(refs.earning, apy === null ? 'Supplied and earning' : 'Earning ' + dom.pct(apy, 2));

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
      refs.limitsBody.appendChild(block);
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
      refs.limitsBody.appendChild(list);
    }

    if (gas.length) {
      var gasRow = dom.el('div', 'between limit-line');
      gasRow.appendChild(dom.el('span', 'body', gas.length === 1 ? 'Gas kept back' : 'Gas kept back on each chain'));
      var amounts = gas.map(function (g) { return chainName(g.chain) + ' ' + g.amount; }).join(', ');
      gasRow.appendChild(dom.el('span', 'meta mono', amounts));
      refs.limitsBody.appendChild(gasRow);
    }

    /* One sentence at the bottom, rather than an Edit button on every rule that
       only ever opened a toast saying the same thing. Seven buttons that cannot
       do what they offer is worse than no button: it teaches a person that the
       controls on this screen are decoration. */
    refs.limitsBody.appendChild(dom.el('p', 'meta',
      'Ask your assistant to change any of these. A limit change files a request you have to click.'));

    /* The destination allowlist existed in the policy engine with no way to see
       it. This is where it lives now. */
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    var wrap = dom.el('div', 'stack-2');
    if (!allow.length) {
      wrap.appendChild(dom.el('p', 'label', 'Money can only go to your own wallets and these venues'));
      wrap.appendChild(dom.el('p', 'meta', 'No list is set, so a destination is checked against your limits alone.'));
      refs.limitsBody.appendChild(wrap);
      return;
    }

    /* The allowlist folds inside the folded panel, and that is not one fold too
       many. Five addresses of forty characters were the tallest thing on this
       screen and the least often read: an address is checked character by
       character on the day somebody has a reason to, and is noise on every
       other day. The venues keep their names on the outside because a name is
       read at a glance and is the half of this list that answers a question. */
    var venues = [];
    var addresses = [];
    for (var a = 0; a < allow.length; a += 1) {
      if (VENUE_NAMES[allow[a]]) venues.push(VENUE_NAMES[allow[a]]);
      else addresses.push(allow[a]);
    }

    var head = dom.el('button', 'allow-head');
    head.type = 'button';
    var headText = addresses.length === 1 ? '1 wallet of yours' : addresses.length + ' wallets of yours';
    if (venues.length) headText += ', ' + venues.join(', ');
    head.appendChild(dom.el('span', 'body grow', 'Money can only go to ' + headText));
    head.appendChild(dom.el('span', 'panel-caret'));
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
    });
    dom.setAttr(head, 'aria-expanded', 'false');
    if (addresses.length) wrap.appendChild(box);
    refs.limitsBody.appendChild(wrap);

    setSummary(refs.limits, limitsSummary(state));
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

  window.PhosphorPro = { boot: boot };
})();
