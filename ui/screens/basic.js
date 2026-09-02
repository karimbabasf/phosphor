/* Basic: one 720 px column, for a person who has never held a wallet.

   The one job is to answer "is my money OK" and get one safe yes or no out of
   them. No prices, no donut, no chains, no hex, no percentages under an hour.
   The sentences come from the server (src/view/basic.ts), which is why the
   window and the assistant cannot disagree about what just happened. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var refs = {};
  var mounted = false;

  function boot() {
    var host = document.getElementById('view-basic');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    window.PhosphorActivity.onChange(function () {
      if (refs.activityBody) window.PhosphorActivity.render(refs.activityBody, { limit: 8 });
    });
  }

  function build(host) {
    var col = dom.el('div', 'basic-col');

    /* The hero. One number, one sentence of what just happened, one sentence of
       what protects the money. The pattern sits behind it. */
    /* The hero has no field of its own. A second canvas at a second cell size
       drew a rectangle you could see the edges of, which is worse than the
       quieter field it was buying. The one page field runs behind it and a
       scrim holds it down so the balance wins. */
    var hero = dom.el('section', 'hero');
    var inner = dom.el('div', 'hero-inner');
    var total = dom.el('p', 'balance tick');
    total.dataset.role = 'total';
    var headline = dom.el('p', 'body');
    headline.dataset.role = 'headline';
    var places = dom.el('p', 'meta');
    places.dataset.role = 'places';
    var footer = dom.el('p', 'meta');
    footer.dataset.role = 'footer';
    inner.appendChild(dom.el('p', 'label', 'Your money'));
    inner.appendChild(total);
    inner.appendChild(headline);
    inner.appendChild(places);
    inner.appendChild(footer);
    hero.appendChild(inner);
    col.appendChild(hero);

    var warning = dom.el('div', 'banner');
    warning.dataset.tone = 'warn';
    warning.setAttribute('role', 'alert');
    warning.hidden = true;
    var warnText = dom.el('span');
    warnText.dataset.role = 'warning';
    warning.appendChild(warnText);
    col.appendChild(warning);

    /* What you own. Rows, no chains, no donut. */
    var own = panel('What you own');
    var ownBody = dom.el('div', 'panel-body-flush');
    own.node.appendChild(ownBody);
    var smallNote = dom.el('p', 'meta panel-body');
    smallNote.hidden = true;
    own.node.appendChild(smallNote);
    col.appendChild(own.node);

    /* Earning. */
    var earning = panel('Earning');
    var earningBody = dom.el('div', 'panel-body stack');
    earning.node.appendChild(earningBody);
    earning.node.hidden = true;
    col.appendChild(earning.node);

    /* Your assistant. */
    var assistant = panel('Your assistant', { bare: true });
    var assistantBody = dom.el('div', 'panel-body agent-panel');
    assistant.node.appendChild(assistantBody);
    assistant.head.hidden = true;
    col.appendChild(assistant.node);

    /* Folds: Money in, then Activity. */
    var moneyIn = fold('Money in', 'Where to send money');
    col.appendChild(moneyIn.node);

    var activity = fold('Activity', 'What happened, newest first');
    col.appendChild(activity.node);

    /* Freeze everything, at the bottom, where a brake belongs. */
    var stop = dom.el('div', 'basic-stop');
    var stopBtn = dom.el('button', 'btn btn-danger btn-lg btn-block');
    stopBtn.appendChild(dom.el('span', 'btn-label', 'Freeze everything'));
    stop.appendChild(stopBtn);
    stop.appendChild(dom.el('p', 'meta', 'This cancels every working order and disarms every rule. It does not sell anything.'));
    col.appendChild(stop);

    host.appendChild(col);

    refs = {
      total: total,
      headline: headline,
      places: places,
      footer: footer,
      warning: warning,
      warnText: warnText,
      ownPanel: own.node,
      ownBody: ownBody,
      smallNote: smallNote,
      earningPanel: earning.node,
      earningBody: earningBody,
      assistantBody: assistantBody,
      moneyIn: moneyIn,
      activity: activity,
      activityBody: activity.body,
      stopBtn: stopBtn,
      field: null
    };

    window.PhosphorAgent.mount(assistantBody, { compact: true });

    dom.on(stopBtn, 'click', function () {
      window.PhosphorConfirm.ask({
        title: 'Freeze everything',
        body: 'This cancels every working order and disarms every rule. Nothing gets sold and nothing gets closed.',
        confirm: 'Freeze everything',
        tone: 'down'
      }).then(function (yes) {
        if (!yes) return;
        window.PhosphorShell.setPending(stopBtn, true, 'Freezing');
        api.kill(true)
          .then(function () { return window.PhosphorShell.refresh({}); })
          .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
          .finally(function () { window.PhosphorShell.setPending(stopBtn, false); });
      });
    });

    moneyIn.onOpen(function () {
      window.PhosphorMoneyIn.render(moneyIn.body);
    });
    activity.onOpen(function () {
      window.PhosphorActivity.load();
      window.PhosphorActivity.render(activity.body, { limit: 8 });
    });
  }

  function panel(title, options) {
    var opts = options || {};
    var node = dom.el('section', 'panel');
    var head = dom.el('div', 'panel-head');
    head.appendChild(dom.el('h2', 'title-sm', title));
    node.appendChild(head);
    if (opts.bare) node.classList.add('panel-bare');
    return { node: node, head: head };
  }

  function fold(title, note) {
    var node = dom.el('section', 'fold');
    var head = dom.el('button', 'fold-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    var left = dom.el('div', 'stack-2');
    left.appendChild(dom.el('span', 'title-sm', title));
    left.appendChild(dom.el('span', 'meta', note));
    head.appendChild(left);
    head.appendChild(dom.el('span', 'fold-mark', '›'));
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

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    var basic = state.basic || {};

    dom.setNumber(refs.total, basic.totalLine || '');
    dom.setText(refs.headline, basic.headline || '');
    dom.setText(refs.places, basic.placesLine || '');
    dom.setText(refs.footer, basic.footer || '');

    dom.setText(refs.warnText, basic.warning || '');
    dom.setHidden(refs.warning, !basic.warning);

    /* Dust is not an answer to "is my money OK". A row worth under a dollar is
       counted rather than listed, so the list is the things a person would
       actually name if you asked them what they had. */
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
      renderOwnSkeleton();
    } else if (!holdings.length) {
      dom.clear(refs.ownBody);
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'Nothing here yet'));
      empty.appendChild(dom.el('p', '', 'Open Money in and send something to one of your addresses.'));
      refs.ownBody.appendChild(empty);
    } else {
      dom.reconcile(refs.ownBody, holdings, function (row) {
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
      });
    }

    var earning = basic.earning;
    dom.setHidden(refs.earningPanel, !earning);
    if (earning) renderEarning(earning);

    if (refs.activity.node.dataset.open === 'true') {
      window.PhosphorActivity.render(refs.activityBody, { limit: 8 });
    }
  }

  function renderOwnSkeleton() {
    if (refs.ownBody.dataset.skeleton === 'true') return;
    refs.ownBody.dataset.skeleton = 'true';
    dom.clear(refs.ownBody);
    for (var i = 0; i < 3; i += 1) {
      var row = dom.el('div', 'row');
      var left = dom.el('div', 'skel grow');
      left.style.height = '16px';
      var right = dom.el('div', 'skel');
      right.style.height = '16px';
      right.style.width = '84px';
      row.appendChild(left);
      row.appendChild(right);
      refs.ownBody.appendChild(row);
    }
  }

  function renderEarning(earning) {
    dom.clear(refs.earningBody);
    var line = dom.el('p', 'body');
    dom.setText(line, earning.line || earning.summary || '');
    refs.earningBody.appendChild(line);
    if (earning.madeLine) {
      refs.earningBody.appendChild(dom.el('p', 'meta', earning.madeLine));
    }
    var withdraw = dom.el('button', 'btn');
    withdraw.appendChild(dom.el('span', 'btn-label', 'Bring it back'));
    refs.earningBody.appendChild(withdraw);
    dom.on(withdraw, 'click', function () {
      window.PhosphorShell.setPending(withdraw, true, 'Bringing it back');
      api.yieldWithdraw({})
        .then(function () { return window.PhosphorShell.refresh({}); })
        .catch(function (err) { window.PhosphorToast.show(net.readable(err, true), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(withdraw, false); });
    });
  }

  window.PhosphorBasic = { boot: boot };
})();
