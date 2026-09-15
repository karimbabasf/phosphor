/* The receipt card, and the unknown-outcome card that is the same card in the
   one state a person cannot act on alone.

   Hex lives here and nowhere else. Every other surface in the window says what
   moved in words; this is where a person goes when they want the hash. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var marks = window.PhosphorMarks;

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
    host.appendChild(dom.el('h2', 'title', receipt.headline || receipt.summary || 'Something moved'));

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

    /* The rail's own sentence, kept whole and kept here. It names the intent and the quote it
       was filed under, which is what to quote at a venue when something is disputed, so it is
       never summarised and never truncated. It is the row title that was wrong, not this. */
    if (receipt.summary && receipt.summary !== receipt.headline) {
      var said = dom.el('div', 'said stack-2');
      said.appendChild(dom.el('p', 'label', 'What the rail recorded'));
      said.appendChild(dom.el('p', 'meta said-body', receipt.summary));
      host.appendChild(said);
    }

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

  /* An Activity row, drawn as a transaction (the .tx grammar in components.css),
     the way a statement line reads: the mark of the coin that left, the sentence,
     and under it when and what it cost; on the right what left, signed, and under
     it what arrived, in green. Karim, 2026-09-14: "I want these to look like
     actual transactions." The first cut put the arrival and the fee together on
     one dim line under the amount, and he read the rows as squished and
     unformatted: three facts in 12 px mono in the same grey. Now each side of
     the row carries two facts of the same kind (words left, money right), and
     the arrival is the one green thing on the line. The coin comes from the
     receipt's own fields, never parsed out of the sentence. */
  function row(receipt) {
    var node = dom.el('button', 'tx receipt-row');
    node.type = 'button';
    node.appendChild(marks.disc(''));
    node.appendChild(dom.el('span', 'tx-title', ''));
    node.appendChild(dom.el('span', 'tx-when', ''));
    node.appendChild(dom.el('span', 'tx-amount', ''));
    node.appendChild(dom.el('span', 'tx-sub', ''));
    return node;
  }

  function updateRow(node, receipt) {
    var mark = node.children[0];
    var title = node.children[1];
    var when = node.children[2];
    var amount = node.children[3];
    var sub = node.children[4];

    var symbol = receipt.symbol ? String(receipt.symbol) : '';
    if (mark.dataset.symbol !== symbol) {
      mark.dataset.symbol = symbol;
      marks.paint(mark, symbol);
    }

    /* The headline, not the rail's sentence. `summary` carries an intent hash and a quote
       handle: six lines of it as a row title buried the fee and the time underneath, and ran
       under the amount column on the right. It is still on the opened receipt, which is where
       evidence belongs. The row clamps to two lines, so the whole sentence rides on the title. */
    var headline = receipt.headline || receipt.summary || 'Something moved';
    dom.setText(title, headline);
    dom.setAttr(title, 'title', headline);

    /* When, then what it cost, in the words the panel head already uses ("$0.44 in fees").
       An outcome that is not "done" takes the time's place: the row says it did not go
       through before it says when. */
    var failed = receipt.status === 'failed';
    var note = dom.ago(receipt.at);
    if (receipt.status === 'needs_reconciliation') note = 'We cannot tell what happened';
    else if (failed) note = 'Did not go through';
    if (typeof receipt.feesUsd === 'number' && receipt.feesUsd > 0) note += ', ' + dom.fee(receipt.feesUsd) + ' in fees';
    dom.setText(when, note);
    dom.setAttr(when, 'class', receipt.status === 'executed' ? 'tx-when' : 'tx-when warn');

    /* Money that left is signed. A move that did not go through left nothing, so its
       amount is unsigned and quiet rather than a minus that was never taken. */
    var left = typeof receipt.amount === 'number';
    dom.setText(amount, left
      ? (failed ? '' : '-') + dom.qty(receipt.amount) + (symbol ? ' ' + symbol : '')
      : '');
    /* A swap or a move between the person's own pockets changes what the money is, not
       how much of it there is, so what left reads in the text tone. Red is for money that
       left the wallet altogether. */
    var gone = receipt.kind === 'transfer' || receipt.kind === 'consolidate' || receipt.kind === 'send';
    dom.setAttr(amount, 'data-dir', left && !failed && gone ? 'out' : null);
    dom.setAttr(amount, 'class', left && failed ? 'tx-amount dim' : 'tx-amount');

    /* What arrived, when the rail recorded it: the second leg of the statement line,
       signed plus and green. Nothing else shares this line. */
    var got = receipt.received;
    var arrived = !failed && got && typeof got.amount === 'number' && got.symbol;
    dom.setText(sub, arrived ? '+' + dom.qty(got.amount) + ' ' + String(got.symbol) : '');
    dom.setAttr(sub, 'data-dir', arrived ? 'in' : null);
  }

  window.PhosphorReceipt = {
    fill: fill,
    row: row,
    updateRow: updateRow,
    chainName: chainName
  };
})();
