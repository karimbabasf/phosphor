/* Basic: the balances panel beside the conversation.

   One job: say where the money is, calmly, and let a person add more. The total
   in the mono face, what that figure is in words under it, one row per coin,
   and one way to add money. Every sentence arrives from the server
   (src/view/basic.ts); this file places them and moves the numbers.

   A row whose figure moved rolls to the new one and lights once, the way
   phosphor does: the light arrives fast and decays slow. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var marks = window.PhosphorMarks;

  /* How long a row's light takes to arrive (--dur-glow-in in tokens.css).
     Taking the attribute away hands the row to the stylesheet's slow decay
     (--dur-glow-out). */
  var GLOW_IN_MS = 120;

  /* NEAR's own mark is the app's green, and green in this window means the
     mark, the live move and Approve. Its row wears a neutral light instead. */
  var NEUTRAL = '#D5D8DD';
  var NEUTRAL_COINS = { NEAR: true, WNEAR: true };

  var refs = {};
  var mounted = false;
  var filled = false;
  var steps = null;

  function boot() {
    var host = document.getElementById('view-basic');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
  }

  function build(host) {
    var panel = dom.el('section', 'bal');
    panel.dataset.surface = 'holdings';
    panel.setAttribute('aria-label', 'Your balance');

    var head = dom.el('div', 'bal-head');
    var total = dom.el('p', 'bal-total mono tick');
    var totalSkel = dom.el('span', 'skel bal-total-skel');
    var caption = dom.el('p', 'bal-caption');
    head.appendChild(total);
    head.appendChild(totalSkel);
    head.appendChild(caption);
    panel.appendChild(head);

    var list = dom.el('div', 'bal-list');
    var rows = dom.el('ul', 'bal-rows');
    rows.setAttribute('aria-label', 'What you hold');
    for (var i = 0; i < 3; i += 1) rows.appendChild(skeletonRow());
    var small = dom.el('p', 'bal-small');
    small.hidden = true;
    var empty = dom.el('p', 'bal-empty');
    empty.hidden = true;
    var add = dom.el('button', 'bal-add');
    add.type = 'button';
    add.appendChild(window.PhosphorIcons.svg('deposit'));
    add.appendChild(dom.el('span', '', 'Add money'));
    list.appendChild(rows);
    list.appendChild(small);
    list.appendChild(empty);
    list.appendChild(add);
    panel.appendChild(list);

    /* The deposit steps (ui/screens/moneyin.js) run here, in the panel, rather
       than in a dialog over the window: nothing covers the conversation, and
       the total stays in view to watch the money land. */
    var flow = dom.el('div', 'bal-flow');
    flow.hidden = true;
    var flowHead = dom.el('div', 'bal-flow-head');
    var title = dom.el('h2', 'bal-flow-title', 'Add money');
    title.setAttribute('tabindex', '-1');
    var done = dom.el('button', 'btn btn-quiet btn-sm bal-done');
    done.type = 'button';
    done.appendChild(dom.el('span', 'btn-label', 'Done'));
    flowHead.appendChild(title);
    flowHead.appendChild(done);
    var flowBody = dom.el('div', 'bal-flow-body');
    flow.appendChild(flowHead);
    flow.appendChild(flowBody);
    panel.appendChild(flow);

    host.appendChild(panel);

    refs = {
      total: total,
      totalSkel: totalSkel,
      caption: caption,
      list: list,
      rows: rows,
      small: small,
      empty: empty,
      add: add,
      flow: flow,
      title: title,
      flowBody: flowBody
    };

    dom.on(add, 'click', openSteps);
    dom.on(done, 'click', closeSteps);
  }

  function skeletonRow() {
    var row = dom.el('li', 'bal-row bal-row-skel');
    row.setAttribute('aria-hidden', 'true');
    row.appendChild(dom.el('span', 'skel bal-coin-skel'));
    row.appendChild(dom.el('span', 'skel grow'));
    return row;
  }

  /* ---------- adding money ---------- */

  function openSteps() {
    if (steps) return;
    if (window.PhosphorLazy) window.PhosphorLazy.load('qr');
    dom.setHidden(refs.list, true);
    dom.setHidden(refs.flow, false);
    steps = window.PhosphorMoneyIn.render(refs.flowBody, { context: 'basic' }) || {};
    if (refs.title.focus) refs.title.focus();
  }

  function closeSteps() {
    if (steps && typeof steps.destroy === 'function') steps.destroy();
    steps = null;
    dom.clear(refs.flowBody);
    dom.setHidden(refs.flow, true);
    dom.setHidden(refs.list, false);
    if (refs.add.focus) refs.add.focus();
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted || !store.loaded()) return;
    var basic = (store.get() || {}).basic || {};

    if (refs.totalSkel.parentNode) refs.totalSkel.parentNode.removeChild(refs.totalSkel);
    dom.setNumber(refs.total, basic.totalLine || '');
    dom.setHidden(refs.total, !basic.totalLine);
    dom.setText(refs.caption, basic.caption || '');
    dom.setAttr(refs.caption, 'data-alone', basic.totalLine ? null : 'true');

    var holdings = Array.isArray(basic.holdings) ? basic.holdings : [];
    dom.reconcile(refs.rows, holdings, keyOf, createRow, fillRow);
    filled = true;

    dom.setText(refs.small, basic.smallLine || '');
    dom.setHidden(refs.small, !basic.smallLine);
    dom.setText(refs.empty, basic.emptyLine || '');
    dom.setHidden(refs.empty, !basic.emptyLine);
  }

  function keyOf(holding) {
    return holding.symbol;
  }

  function createRow(holding) {
    var row = dom.el('li', 'bal-row');
    var mark = dom.el('span', 'bal-coin');
    mark.setAttribute('aria-hidden', 'true');
    marks.paint(mark, holding.symbol);
    if (NEUTRAL_COINS[String(holding.symbol).toUpperCase()]) mark.style.setProperty('--coin', NEUTRAL);
    var who = dom.el('span', 'bal-who');
    who.appendChild(dom.el('span', 'bal-sym'));
    who.appendChild(dom.el('span', 'bal-amt mono tick'));
    row.appendChild(mark);
    row.appendChild(who);
    row.appendChild(dom.el('span', 'bal-usd mono tick'));
    /* A coin that arrives after the panel has drawn once is a row that moved:
       it lights like one. The first fill of all is not a change. */
    if (filled) row.__shown = '';
    return row;
  }

  function fillRow(row, holding) {
    var who = row.children[1];
    var usd = row.children[2];
    var priced = holding.valueLine !== null && holding.valueLine !== undefined;
    dom.setText(who.children[0], holding.symbol);
    dom.setNumber(who.children[1], holding.quantityLine);
    if (!priced) {
      dom.setText(usd, 'price unavailable');
    } else if (usd.getAttribute('data-unpriced') === 'true') {
      dom.setText(usd, holding.valueLine);
    } else {
      dom.setNumber(usd, holding.valueLine);
    }
    dom.setAttr(usd, 'data-unpriced', priced ? null : 'true');
    row.setAttribute('aria-label', [holding.name || holding.symbol, holding.quantityLine,
      priced ? holding.valueLine : 'price unavailable'].join(', '));
    light(row, holding);
  }

  function light(row, holding) {
    var shown = holding.quantityLine + '|' + (holding.valueLine || '');
    var had = row.__shown;
    row.__shown = shown;
    if (had === undefined || had === shown) return;
    row.dataset.lit = 'true';
    if (row.__litTimer) window.clearTimeout(row.__litTimer);
    row.__litTimer = window.setTimeout(function () {
      delete row.dataset.lit;
      row.__litTimer = 0;
    }, GLOW_IN_MS);
  }

  window.PhosphorBasic = { boot: boot };
})();
