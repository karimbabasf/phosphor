/* The receipt card, and the unknown-outcome card that is the same card in the
   one state a person cannot act on alone.

   Hex lives here and nowhere else. Every other surface in the window says what
   moved in words; this is where a person goes when they want the hash. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;

  var CHAIN_NAMES = {
    eth: 'Ethereum',
    base: 'Base',
    arb: 'Arbitrum',
    sol: 'Solana',
    near: 'NEAR'
  };

  function chainName(id) {
    return CHAIN_NAMES[id] || String(id || '');
  }

  function fill(host, receipt, onClose) {
    dom.clear(host);
    var unknown = receipt.status === 'needs_reconciliation';
    var failed = receipt.status === 'failed';

    host.appendChild(dom.el('p', 'label', unknown ? 'We cannot tell what happened' : (failed ? 'This did not go through' : 'Receipt')));
    host.appendChild(dom.el('h2', 'title', receipt.summary || 'Something moved'));

    if (unknown) {
      var warn = dom.el('div', 'banner');
      warn.dataset.tone = 'warn';
      warn.appendChild(dom.el('span', '', 'We sent this and we cannot read what happened to it. Do not send it again. Check it again below, or open it in a block explorer.'));
      host.appendChild(warn);
    }

    var facts = dom.el('div', 'facts');
    addFact(facts, 'What moved', amountLine(receipt));
    if (receipt.fromChain && receipt.toChain && receipt.fromChain !== receipt.toChain) {
      addFact(facts, 'From', chainName(receipt.fromChain));
      addFact(facts, 'To', chainName(receipt.toChain));
    } else if (receipt.fromChain) {
      addFact(facts, 'On', chainName(receipt.fromChain));
    }
    if (typeof receipt.feesUsd === 'number') {
      addFact(facts, 'Fees', dom.fee(receipt.feesUsd));
    }
    if (receipt.at) addFact(facts, 'When', dom.ago(receipt.at));
    if (typeof receipt.balanceBefore === 'number' && typeof receipt.balanceAfter === 'number') {
      addFact(facts, 'Your money before', dom.usd(receipt.balanceBefore));
      addFact(facts, 'Your money after', dom.usd(receipt.balanceAfter));
    }
    host.appendChild(facts);

    var txids = Array.isArray(receipt.txids) ? receipt.txids : [];
    if (txids.length) {
      var wrap = dom.el('div', 'stack-2');
      wrap.appendChild(dom.el('p', 'label', txids.length === 1 ? 'Transaction' : 'Transactions'));
      for (var i = 0; i < txids.length; i += 1) {
        wrap.appendChild(txRow(txids[i]));
      }
      host.appendChild(wrap);
    }

    var error = dom.el('p', 'body down');
    error.hidden = true;
    host.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    if (unknown) {
      var recheck = dom.el('button', 'btn btn-primary');
      recheck.appendChild(dom.el('span', 'btn-label', 'Check it again'));
      actions.appendChild(recheck);
      dom.on(recheck, 'click', function () {
        window.PhosphorShell.setPending(recheck, true, 'Checking');
        api.reconcile(receipt.id)
          .then(function (answer) {
            var status = answer && answer.status;
            /* Still unreadable is an answer, and the card stays open on it:
               closing would look like it had been settled. */
            if (status === 'needs_reconciliation') {
              dom.setText(error, 'Still no answer from the chain. Nothing has changed. Do not send it again.');
              error.hidden = false;
              return;
            }
            window.PhosphorToast.show('Checked. It is ' + readableStatus(status) + '.'
              + (answer && answer.detail ? ' ' + answer.detail : ''));
            if (onClose) onClose();
          })
          .catch(function (err) {
            dom.setText(error, net.readable(err));
            error.hidden = false;
          })
          .finally(function () {
            window.PhosphorShell.setPending(recheck, false);
          });
      });
    }
    var done = dom.el('button', 'btn btn-ghost');
    done.appendChild(dom.el('span', 'btn-label', 'Close'));
    actions.appendChild(done);
    host.appendChild(actions);
    dom.on(done, 'click', function () { if (onClose) onClose(); });
  }

  function readableStatus(status) {
    if (status === 'executed') return 'done';
    if (status === 'failed') return 'not done, and nothing left your wallet';
    if (status === 'needs_reconciliation') return 'still unreadable';
    return 'no longer waiting';
  }

  function amountLine(receipt) {
    if (typeof receipt.amount !== 'number') return '';
    return dom.qty(receipt.amount) + ' ' + (receipt.symbol || '');
  }

  function txRow(tx) {
    var row = dom.el('div', 'tx-row');
    var top = dom.el('div', 'between');
    top.appendChild(dom.el('span', 'meta', chainName(tx.chain)));
    var copy = dom.el('button', 'btn btn-quiet');
    copy.type = 'button';
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    top.appendChild(copy);
    row.appendChild(top);
    row.appendChild(dom.el('p', 'hash addr', tx.hash));
    if (tx.url) {
      var link = dom.el('a', 'meta', 'Open in a block explorer');
      link.href = tx.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      row.appendChild(link);
    }
    dom.on(copy, 'click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tx.hash).then(function () {
          dom.setText(copy.querySelector('.btn-label'), 'Copied');
          window.setTimeout(function () {
            dom.setText(copy.querySelector('.btn-label'), 'Copy');
          }, 1600);
        });
      }
    });
    return row;
  }

  function addFact(host, label, value) {
    if (value === '' || value === null || value === undefined) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body mono', value));
    host.appendChild(row);
  }

  /* An Activity row. Newest first, one row per executed action, and the fee is
     on the row rather than behind a modal. */
  function row(receipt) {
    var node = dom.el('button', 'row row-hover receipt-row');
    node.type = 'button';
    var main = dom.el('div', 'row-main stack-2');
    main.appendChild(dom.el('span', 'body', ''));
    main.appendChild(dom.el('span', 'meta', ''));
    var side = dom.el('div', 'row-side stack-2');
    side.appendChild(dom.el('span', 'body mono', ''));
    side.appendChild(dom.el('span', 'meta mono', ''));
    node.appendChild(main);
    node.appendChild(side);
    return node;
  }

  function updateRow(node, receipt) {
    var main = node.children[0];
    var side = node.children[1];
    dom.setText(main.children[0], receipt.summary || 'Something moved');
    var note = dom.ago(receipt.at);
    if (receipt.status === 'needs_reconciliation') note = 'We cannot tell what happened';
    else if (receipt.status === 'failed') note = 'Did not go through';
    dom.setText(main.children[1], note);
    dom.setAttr(main.children[1], 'class', receipt.status === 'executed' ? 'meta' : 'meta warn');
    dom.setText(side.children[0], typeof receipt.amount === 'number'
      ? dom.qty(receipt.amount) + ' ' + (receipt.symbol || '')
      : '');
    dom.setText(side.children[1], typeof receipt.feesUsd === 'number'
      ? dom.fee(receipt.feesUsd) + ' fees'
      : '');
  }

  window.PhosphorReceipt = {
    fill: fill,
    row: row,
    updateRow: updateRow,
    chainName: chainName
  };
})();
