/* Activity: what happened, newest first, each row a receipt.

   It reads /api/receipts, which is the one place that knows what a move cost
   and what the balance was on each side of it.

   The global is PhosphorReceipts rather than PhosphorActivity because
   ui/activity.js is the custody idle beacon and got there first. Two different
   things called activity is how one of them silently stops running. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;

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
    state = receipts.length ? 'refreshing' : 'loading';
    emit();
    return api.receipts(25)
      .then(function (result) {
        var data = result.data || {};
        receipts = Array.isArray(data.receipts) ? data.receipts : [];
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
