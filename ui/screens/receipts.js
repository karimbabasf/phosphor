/* Activity: what happened, newest first, each row a receipt.

   It reads /api/receipts when the backend has it and falls back to
   /api/transactions until then, so the panel says something true either way
   rather than sitting empty behind a route that does not exist.

   The global is PhosphorReceipts rather than PhosphorActivity because
   ui/activity.js is the custody idle beacon and got there first. Two different
   things called activity is how one of them silently stops running. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;
  var fixtures = window.PhosphorFixtures;

  var receipts = [];
  var listeners = [];
  var state = 'idle';

  function get() {
    return receipts;
  }

  function onChange(fn) {
    listeners.push(fn);
    fn(receipts, state);
    return function () {
      var at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    };
  }

  function emit() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](receipts, state);
      } catch (err) {
        console.error('[activity]', err);
      }
    }
  }

  function load() {
    if (fixtures.active) {
      receipts = fixtures.receipts().receipts;
      state = 'ready';
      emit();
      return Promise.resolve(receipts);
    }
    state = receipts.length ? 'refreshing' : 'loading';
    emit();
    return api.receipts(25)
      .then(function (result) {
        var data = result.data || {};
        if (!data.missing && Array.isArray(data.receipts)) {
          receipts = data.receipts;
          state = 'ready';
          emit();
          return receipts;
        }
        return fallback();
      })
      .catch(function () {
        return fallback();
      });
  }

  /* Until /api/receipts lands, the transaction history carries the same
     events. It has no balance before and after and no per-row fee, so those
     lines are left off rather than guessed at. */
  function fallback() {
    return api.transactions()
      .then(function (result) {
        var data = result.data || {};
        var rows = Array.isArray(data.transactions) ? data.transactions : (Array.isArray(data.rows) ? data.rows : []);
        receipts = rows.map(function (tx, i) {
          return {
            id: tx.id || ('tx_' + i),
            kind: tx.kind || 'action',
            at: tx.at || tx.decidedAt || tx.createdAt,
            summary: tx.summary || tx.detail || String(tx.kind || 'Something moved'),
            fromChain: tx.chain || tx.fromChain,
            toChain: tx.toChain || tx.chain,
            amount: typeof tx.amount === 'number' ? tx.amount : undefined,
            symbol: tx.symbol,
            feesUsd: typeof tx.feeUsd === 'number' ? tx.feeUsd : undefined,
            txids: (tx.txids || []).map(function (hash) {
              return typeof hash === 'string'
                ? { chain: tx.chain, hash: hash, url: null }
                : hash;
            }),
            status: tx.status === 'executed' || tx.ok ? 'executed' : (tx.status || 'failed')
          };
        });
        state = 'ready';
        emit();
        return receipts;
      })
      .catch(function () {
        state = 'error';
        emit();
        return receipts;
      });
  }

  /* Render a list into a host. Keyed, so a refresh does not throw away the row
     the person is hovering. */
  function render(host, options) {
    var opts = options || {};
    if (state === 'loading') {
      dom.clear(host);
      for (var i = 0; i < 3; i += 1) {
        var skel = dom.el('div', 'row');
        var bar = dom.el('div', 'skel grow');
        bar.style.height = '18px';
        skel.appendChild(bar);
        host.appendChild(skel);
      }
      return;
    }

    if (!receipts.length) {
      dom.clear(host);
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'Nothing has happened yet'));
      empty.appendChild(dom.el('p', '', state === 'error'
        ? 'The app could not read what happened.'
        : 'When your assistant moves money, every action lands here as a receipt.'));
      host.appendChild(empty);
      return;
    }

    var shown = opts.limit ? receipts.slice(0, opts.limit) : receipts;

    dom.reconcile(host, shown, function (receipt) {
      return receipt.id;
    }, function () {
      return window.PhosphorReceipt.row();
    }, function (node, receipt) {
      window.PhosphorReceipt.updateRow(node, receipt);
      if (node.__wired) return;
      node.__wired = true;
      dom.on(node, 'click', function () {
        var current = null;
        for (var i = 0; i < receipts.length; i += 1) {
          if (receipts[i].id === node.dataset.key) current = receipts[i];
        }
        if (current) window.PhosphorDecision.showReceipt(current);
      });
    });
  }

  /* The fee total for the window, so the Activity panel answers "what did this
     cost me" without a modal. */
  function feeTotal() {
    var total = 0;
    for (var i = 0; i < receipts.length; i += 1) {
      if (typeof receipts[i].feesUsd === 'number') total += receipts[i].feesUsd;
    }
    return total;
  }

  window.PhosphorReceipts = {
    load: load,
    render: render,
    get: get,
    onChange: onChange,
    feeTotal: feeTotal
  };
})();
