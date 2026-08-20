/* deck-views.js — the three records that live behind the deck bar, rendered once.
 *
 * WHY THIS FILE. The pro deck and the trading deck both open LOG, POLICY and HISTORY, and
 * they are the same three records read from the same three endpoints. Written twice they
 * would drift, and the way they drift is that one of them quietly starts showing less: a
 * column dropped here, a line truncated there. Written once, "nothing is shortened" is a
 * property of one file that can be checked.
 *
 * It carries its own formatters rather than borrowing a page's. ui/app.js and ui/trade.js
 * both define usd() and they do not agree: the custody page prints `n/a` for a number it
 * cannot compute, the trading page prints `--` for a number the venue did not send, and
 * both are right on their own screen. These records are the custody ledger's, so the
 * conventions below are that page's, on both pages.
 *
 * Every string reaches the DOM through textContent. Log messages, policy sentences and the
 * app's own transaction notes carry agent-authored text verbatim by design, so no line in
 * this file ever assigns markup: text nodes only, everywhere, without exception. This is a
 * security property of the app, not a house style. */

'use strict';

var PhosphorViews = (function () {
  /* A second agent turned away is a refusal like any other, and the log is where a refusal
     is supposed to be visible. */
  var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1, agent_rejected: 1 };

  /* ---------- formatters ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* A gas fee is often a fraction of a cent, and "$0.00" in a column headed GAS reads as
     free. The precision follows the magnitude. */
  function usdSmall(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    if (v !== 0 && Math.abs(v) < 0.01) return '$' + v.toFixed(4);
    return usd(v);
  }

  function amount(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    // Dust is still held, and printing 0.00000085 ETH as "0" is a lie. Four places is right
    // for everything a person counts in; below that the number becomes its own scale.
    if (v !== 0 && Math.abs(v) < 0.0001) {
      var fixed = v.toFixed(8);
      return Number(fixed) === 0 ? v.toPrecision(2) : fixed;
    }
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  function pct(share) {
    var v = Number(share);
    if (!isFinite(v)) return 'n/a';
    return (v * 100).toFixed(2) + '%';
  }

  function padEnd(s, n) {
    var out = String(s);
    while (out.length < n) out += ' ';
    return out;
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toTimeString().slice(0, 8);
  }

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error(url + ' returned ' + res.status);
      return res.json();
    });
  }

  /* ---------- LOG ----------

     One line of the audit trail. It is the renderer the pro deck's log panel used, moved
     rather than rewritten: same classes, same hanging indent, same red on a refusal. What
     changed is the room it draws into. In a quarter of the screen a message ran off the
     right edge; in the overlay it wraps under its own column and all of it is readable. */

  function logLine(event) {
    var line = el('div', REFUSAL_TYPES[event.type] ? 'logline refusal' : 'logline');
    line.appendChild(el('span', 'ts', '[' + clock(event.ts) + '] '));
    line.appendChild(el('span', 'type', padEnd(event.type, 25)));
    line.appendChild(el('span', 'msg', event.msg));
    return line;
  }

  /* ---------- POLICY ----------

     The whole policy, which is more than the sentences. The pro deck keeps a panel of the
     sentences because four lines of English is the right amount of policy to have on screen
     at all times, and a person checks it before they click. What no panel showed is the
     numbers those sentences were rendered from, the destination allowlist in full addresses,
     and the composition limits: what you want once you have stopped glancing and started
     checking. The trading deck never had even the sentences, only the word in the status
     bar, so on that page this is the whole of it. */

  function policyLine(box, label, value) {
    var line = el('div', 'ovl-line');
    line.appendChild(el('span', 'k', label));
    line.appendChild(document.createTextNode(value));
    box.appendChild(line);
  }

  function policy(box, s) {
    // Two different facts. "Unreadable" is a refusal state the app is in; "not read yet" is
    // a browser that has not had its first answer. Printing the first for the second would
    // put ALL WRITES REFUSED on screen every time a window opens.
    if (!s) {
      box.appendChild(el('p', 'ovl-note', 'The policy has not been read yet.'));
      return;
    }
    if (!s.policy) {
      box.appendChild(el('p', 'ovl-note', 'The policy file is unreadable. Every write is refused until it can be read.'));
      return;
    }
    var p = s.policy;

    box.appendChild(el('p', 'ovl-sec', 'IN FORCE'));
    var lines = s.sentences || [];
    if (!lines.length) box.appendChild(el('div', 'rule faint', 'no rules authored'));
    for (var i = 0; i < lines.length; i++) {
      var rule = el('div', lines[i].indexOf('KILL SWITCH ON') === 0 ? 'rule red' : 'rule');
      rule.appendChild(el('span', 'prompt', '$ '));
      rule.appendChild(document.createTextNode(lines[i]));
      box.appendChild(rule);
    }

    box.appendChild(el('p', 'ovl-sec', 'MOVING MONEY OUT'));
    var out = p.outbound || {};
    policyLine(box, 'per transaction', usd(out.maxPerTransactionUsd));
    policyLine(box, 'per session', usd(out.maxPerSessionUsd) + '  (rolling 24 hours)');
    policyLine(box, 'human click above', usd(out.humanClickAboveUsd));
    policyLine(box, 'simulate first', out.simulateBeforeSign ? 'yes, every write' : 'no');
    policyLine(box, 'kill switch', p.killSwitch ? 'ON: every write refused' : 'off');

    box.appendChild(el('p', 'ovl-sec', 'WHERE MONEY MAY GO'));
    var allow = out.destinationAllowlist || [];
    // An empty allowlist is not a gap in the data: the engine treats the app's own wallets
    // as allowed without ever listing them.
    if (!allow.length) policyLine(box, 'allowlist', 'empty: only the wallets this app owns');
    for (var a = 0; a < allow.length; a++) policyLine(box, a === 0 ? 'allowlist' : '', String(allow[a]));

    box.appendChild(el('p', 'ovl-sec', 'WHAT MAY BE HELD'));
    var comp = p.composition || {};
    var shares = comp.maxIssuerShare || {};
    var issuers = Object.keys(shares);
    for (var k = 0; k < issuers.length; k++) {
      policyLine(box, issuers[k] === 'default' ? 'any one issuer' : issuers[k], pct(shares[issuers[k]]));
    }
    policyLine(box, 'freezable', pct(comp.maxFreezableShare));
    var gas = comp.minNativeGasUsd || {};
    var chains = Object.keys(gas);
    for (var g = 0; g < chains.length; g++) policyLine(box, 'gas floor ' + chains[g], usd(gas[chains[g]]));
    var forbidden = comp.forbiddenIssuers || [];
    for (var f = 0; f < forbidden.length; f++) policyLine(box, f === 0 ? 'never held' : '', String(forbidden[f]));
    if (!forbidden.length) policyLine(box, 'never held', 'nothing named');

    box.appendChild(el('p', 'ovl-sec', 'FILE'));
    policyLine(box, 'version', String(p.version));
    policyLine(box, 'network', s.network ? String(s.network) : 'unknown');
  }

  /* ---------- HISTORY ----------

     The history of what this app actually did with the money: one row per executed proposal,
     newest first. Everything in it is derived by the server from the proposal store and the
     hashes the rails produced (src/transactions.ts); this file formats and never computes,
     which is why a value here can be checked against the audit log line for the same id.

     Interactive means three things, and no more than three: the filters narrow the list, a
     row expands in place to its full detail, and every address and hash is a link to the
     explorer that owns it.

     WHERE IT DRAWS. It was a tab inside the pro deck's wallet panel. Eight nowrap columns
     and a per-row expansion never fitted half a deck column, so the table divided its width
     instead of taking it and the detail was the first thing off the screen. Nothing about
     the rows below changed; the box they draw into did.

     The state outside VIEW survives a close: the entries already read, which filter is on,
     and which rows are open. Shutting an overlay is not the same act as collapsing a row
     you opened, and re-opening should not make you find your place again. */

  var TX = { entries: [], gasPending: 0 };
  var TX_FILTER = 'all';
  var TX_OPEN = {};
  var TX_LOADED = false;
  /* The elements an open overlay owns, plus how to report a failed read. Null when shut,
     and every renderer below returns on null rather than writing into a detached box. */
  var VIEW = null;

  var TX_FILTERS = [
    { key: 'all', label: 'ALL' },
    { key: 'swap', label: 'SWAPS' },
    { key: 'deposit', label: 'DEPOSITS' },
    { key: 'withdraw', label: 'WITHDRAWALS' },
    { key: 'transfer', label: 'TRANSFERS' }
  ];

  var TX_COLUMNS = [
    { cls: 'c-time', label: 'TIME' },
    { cls: 'c-action', label: 'ACTION' },
    { cls: 'c-move', label: 'MOVEMENT' },
    { cls: 'c-num c-value', label: 'VALUE' },
    { cls: 'c-addr c-from', label: 'FROM' },
    { cls: 'c-addr', label: 'TO' },
    { cls: 'c-num c-gas', label: 'GAS' },
    { cls: 'c-tx', label: 'TX' }
  ];

  /* Addresses are shown short in the table and never short in the detail: a truncated
     address is fine to point at and not enough to check. */
  function shortAddress(address) {
    var a = String(address);
    if (a.length <= 13) return a;
    return a.slice(0, 6) + '…' + a.slice(-4);
  }

  function txTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toTimeString().slice(0, 5) : (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* What this move cost in gas, added up over its own transactions. Three outcomes, and
     they are three different sentences: a figure, still reading, or nobody can tell us.
     A move that only ever signed an intent burned no gas at all, which is a fourth. */
  function gasOf(entry) {
    var totalUsd = 0;
    var seen = false;
    var pending = false;
    var unknown = false;
    for (var i = 0; i < entry.hashes.length; i++) {
      var tx = entry.hashes[i];
      if (tx.kind !== 'chain') continue;
      if (tx.gas === null) {
        if (tx.gasPending) pending = true;
        else unknown = true;
        continue;
      }
      seen = true;
      if (tx.gas.feeUsd !== null) totalUsd += tx.gas.feeUsd;
    }
    return { usd: seen ? totalUsd : null, pending: pending, unknown: unknown, onChain: seen || pending || unknown };
  }

  /* A link, or plain text when the chain has no explorer we can name. Never a dead <a>:
     a link that goes nowhere is worse than a value that does not pretend to be one. */
  function explorerLink(text, url, cls) {
    if (!url) return el('span', cls, text);
    var a = el('a', cls ? 'link ' + cls : 'link', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = url;
    return a;
  }

  function partyCell(party, cls) {
    var td = el('td', cls ? 'addr ' + cls : 'addr');
    if (!party) {
      td.appendChild(el('span', 'faint', '--'));
      return td;
    }
    var node = explorerLink(shortAddress(party.address), party.url, party.self ? 'self' : '');
    node.title = party.address + (party.self ? ' (our own wallet)' : '');
    td.appendChild(node);
    return td;
  }

  function movementOf(entry) {
    if (!entry.sent) return entry.note || '--';
    var sent = amount(entry.sent.amount) + ' ' + entry.sent.symbol;
    if (!entry.received) return sent;
    return sent + ' → ' + amount(entry.received.amount) + ' ' + entry.received.symbol;
  }

  function copyButton(text) {
    var btn = el('button', 'copy', '[copy]');
    btn.type = 'button';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = '[copied]';
        setTimeout(function () {
          btn.textContent = '[copy]';
        }, 1200);
      }, function () {
        btn.textContent = '[no]';
      });
    });
    return btn;
  }

  function detailLine(label, node) {
    var line = el('div', 'txd-line');
    line.appendChild(el('span', 'txd-k', padEnd(label, 14)));
    line.appendChild(node);
    return line;
  }

  /* The expansion. Everything the row had to leave out: full addresses, every hash with
     the gas it actually burned, the venue's own fee, and the verdict that let it through. */
  function txDetail(entry) {
    var box = el('div', 'txd');

    if (entry.detail) box.appendChild(el('div', 'txd-detail', entry.detail));

    var parties = [entry.from, entry.to, entry.counterparty];
    var labels = ['from', 'to', 'via'];
    for (var p = 0; p < parties.length; p++) {
      if (!parties[p]) continue;
      var wrap = el('span', 'txd-addr');
      wrap.appendChild(explorerLink(parties[p].address, parties[p].url, parties[p].self ? 'self' : ''));
      if (parties[p].self) wrap.appendChild(el('span', 'faint', '  our own wallet'));
      wrap.appendChild(copyButton(parties[p].address));
      box.appendChild(detailLine(labels[p] + ' (' + parties[p].place + ')', wrap));
    }

    for (var h = 0; h < entry.hashes.length; h++) {
      var tx = entry.hashes[h];
      var line = el('span', 'txd-hash');
      line.appendChild(explorerLink(tx.hash, tx.url, ''));
      line.appendChild(copyButton(tx.hash));
      box.appendChild(detailLine(tx.kind === 'intent' ? 'intent' : 'tx ' + tx.place, line));
      if (tx.gas) {
        var g = el('span', 'txd-gas');
        g.appendChild(document.createTextNode(
          Number(tx.gas.gasUsed).toLocaleString('en-US') + ' gas × ' +
          (Number(tx.gas.gasPriceWei) / 1e9).toFixed(4) + ' gwei = ' +
          tx.gas.feeNative.toFixed(8) + ' ' + tx.gas.feeSymbol +
          (tx.gas.feeUsd === null ? '' : '  (' + usdSmall(tx.gas.feeUsd) + ')')
        ));
        if (tx.gas.status === 'reverted') g.appendChild(el('span', 'red', '  REVERTED'));
        box.appendChild(detailLine('gas', g));
      } else if (tx.kind === 'intent') {
        // Not a gap in the data: an intent is signed, not broadcast, so there is no gas of
        // ours to report and the fee that WAS paid is the solver's, below.
        box.appendChild(detailLine('gas', el('span', 'faint', 'none: signed as an intent, settled by a solver')));
      } else if (!tx.gasPending) {
        box.appendChild(detailLine('gas', el('span', 'faint', 'unknown: no chain this app can reach has this hash')));
      }
    }

    if (entry.venueFeeUsd !== null) {
      box.appendChild(detailLine('venue fee', el('span', null, usd(entry.venueFeeUsd) + '  (quoted at approval)')));
    }
    if (entry.decidedBy) {
      var decided = entry.decidedBy === 'human' ? 'a human clicked approve'
        : entry.decidedBy === 'policy' ? 'the policy engine, under the click threshold'
          : 'auto-approved: the approval gate was disabled';
      box.appendChild(detailLine('decided by', el('span', null, decided)));
    }
    for (var r = 0; r < entry.reasons.length; r++) {
      box.appendChild(detailLine(r === 0 ? 'why' : '', el('span', 'dim', entry.reasons[r])));
    }
    box.appendChild(detailLine('proposal', el('span', 'faint', entry.id)));
    return box;
  }

  function txRow(entry) {
    var tr = document.createElement('tr');
    tr.className = 'txrow' + (entry.status === 'failed' ? ' failed' : '');
    tr.dataset.id = entry.id;
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-expanded', TX_OPEN[entry.id] ? 'true' : 'false');

    tr.appendChild(el('td', 'time', txTime(entry.ts)));

    var action = el('td', 'action');
    action.appendChild(el('span', 'caret', TX_OPEN[entry.id] ? '▾ ' : '▸ '));
    action.appendChild(document.createTextNode(entry.action));
    if (entry.status === 'failed') action.appendChild(el('span', 'red', ' FAILED'));
    if (entry.status === 'executing') action.appendChild(el('span', 'hi', ' RUNNING'));
    tr.appendChild(action);

    var move = el('td', 'move');
    move.appendChild(document.createTextNode(movementOf(entry)));
    // The route, and only the route. The venue is one line down in the detail.
    var route = entry.place === entry.toPlace ? entry.place : entry.place + '→' + entry.toPlace;
    move.appendChild(el('span', 'faint', '  ' + route));
    move.title = movementOf(entry) + '  ' + route + (entry.venue ? ' via ' + entry.venue : '');
    tr.appendChild(move);

    tr.appendChild(el('td', 'num', usd(entry.valueUsd)));
    tr.appendChild(partyCell(entry.from, 'from'));
    tr.appendChild(partyCell(entry.to));

    var gas = gasOf(entry);
    var gasCell = el('td', 'num gas');
    if (gas.usd !== null) gasCell.appendChild(document.createTextNode(usdSmall(gas.usd)));
    else if (gas.pending) gasCell.appendChild(el('span', 'faint', 'reading'));
    else if (gas.unknown) gasCell.appendChild(el('span', 'faint', 'unknown'));
    else gasCell.appendChild(el('span', 'faint', 'no gas'));
    tr.appendChild(gasCell);

    var txCell = el('td', 'txh');
    if (!entry.hashes.length) txCell.appendChild(el('span', 'faint', '--'));
    else {
      txCell.appendChild(explorerLink(shortAddress(entry.hashes[0].hash), entry.hashes[0].url, ''));
      if (entry.hashes.length > 1) txCell.appendChild(el('span', 'faint', ' +' + (entry.hashes.length - 1)));
    }
    tr.appendChild(txCell);
    return tr;
  }

  function txMatches(entry) {
    if (TX_FILTER === 'all') return true;
    if (TX_FILTER === 'transfer') return entry.action === 'transfer' || entry.action === 'consolidate';
    return entry.action === TX_FILTER;
  }

  /* One full-width cell, for the two things that are not a row: the wait before the first
     answer, and an empty result. */
  function spanRow(text) {
    var tr = document.createElement('tr');
    var cell = el('td', 'faint', text);
    cell.colSpan = TX_COLUMNS.length;
    tr.appendChild(cell);
    return tr;
  }

  function renderTransactions() {
    if (!VIEW) return;
    var tbody = VIEW.rows;
    tbody.textContent = '';
    var shown = 0;
    for (var i = 0; i < TX.entries.length; i++) {
      var entry = TX.entries[i];
      if (!txMatches(entry)) continue;
      shown++;
      tbody.appendChild(txRow(entry));
      if (TX_OPEN[entry.id]) {
        var open = document.createElement('tr');
        open.className = 'txopen';
        var cell = document.createElement('td');
        cell.colSpan = TX_COLUMNS.length;
        cell.appendChild(txDetail(entry));
        open.appendChild(cell);
        tbody.appendChild(open);
      }
    }

    if (!shown) {
      // Three different facts, and three different sentences. "Nothing yet" before the first
      // answer has come back is a claim about the account that cannot be made.
      tbody.appendChild(spanRow(
        !TX_LOADED ? 'reading the history...'
          : TX.entries.length ? 'nothing under this filter'
            : 'no transactions yet: nothing has been executed from this app'
      ));
    }

    var meta = VIEW.meta;
    meta.textContent = '';
    meta.appendChild(document.createTextNode(shown + (shown === 1 ? ' transaction' : ' transactions')));
    // Said out loud rather than left as a blank cell: a fee that has not been read yet and
    // a fee of zero are different facts.
    if (TX.gasPending > 0) meta.appendChild(el('span', 'faint', '   reading gas for ' + TX.gasPending + '...'));
  }

  function renderTxFilters() {
    if (!VIEW) return;
    var box = VIEW.filters;
    box.textContent = '';
    for (var i = 0; i < TX_FILTERS.length; i++) {
      (function (filter) {
        var btn = el('button', 'tf' + (TX_FILTER === filter.key ? ' on' : ''), filter.label);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          TX_FILTER = filter.key;
          renderTxFilters();
          renderTransactions();
        });
        box.appendChild(btn);
      })(TX_FILTERS[i]);
    }
  }

  /* Called on open, and again whenever the server says a receipt landed. A no-op with the
     overlay shut: nobody is looking, and opening it reads afresh anyway. */
  function refreshTransactions() {
    if (!VIEW) return Promise.resolve();
    var onError = VIEW.onError;
    return getJson('/api/transactions').then(function (payload) {
      TX = { entries: payload.entries || [], gasPending: payload.gasPending || 0 };
      TX_LOADED = true;
      renderTransactions();
    }, function (err) {
      if (onError) onError('cannot read the transaction history: ' + (err.message || String(err)));
    });
  }

  /* Attached once, to the tbody this open built. The rows underneath are rebuilt on every
     filter change and every refresh, and carry no listeners of their own. */
  function wireTxRows(tbody) {
    function toggle(tr) {
      if (!tr || !tr.dataset.id) return;
      var id = tr.dataset.id;
      if (TX_OPEN[id]) delete TX_OPEN[id];
      else TX_OPEN[id] = true;
      renderTransactions();
    }
    tbody.addEventListener('click', function (ev) {
      // A click on a link is a click on the link, not on the row behind it.
      if (ev.target.closest('a') || ev.target.closest('button')) return;
      toggle(ev.target.closest ? ev.target.closest('tr.txrow') : null);
    });
    tbody.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var tr = ev.target.closest ? ev.target.closest('tr.txrow') : null;
      if (!tr) return;
      ev.preventDefault();
      toggle(tr);
    });
  }

  /* The header is authored here rather than in a page's HTML, for the same reason the table
     left the panel: it belongs to the view that draws it, and a <thead> sitting in a page
     for a table that is not on screen is markup nobody can find. */
  function transactions(box, onError) {
    var bar = el('p', 'txbar');
    var filters = el('span', 'tfs');
    var meta = el('span', 'meta faint', '--');
    bar.appendChild(filters);
    bar.appendChild(meta);

    var grid = el('div', 'txgrid');
    var table = el('table', 'grid tx');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    for (var i = 0; i < TX_COLUMNS.length; i++) {
      headRow.appendChild(el('th', TX_COLUMNS[i].cls, TX_COLUMNS[i].label));
    }
    head.appendChild(headRow);
    var rows = document.createElement('tbody');
    table.appendChild(head);
    table.appendChild(rows);
    grid.appendChild(table);

    box.appendChild(bar);
    box.appendChild(grid);

    VIEW = { rows: rows, meta: meta, filters: filters, onError: onError || null };
    wireTxRows(rows);
    renderTxFilters();
    // Whatever the last read produced is on screen before the network is touched: a history
    // that has already answered draws at once on the second open, and the read below
    // replaces it when it lands.
    renderTransactions();
    refreshTransactions();
  }

  function transactionsClosed() {
    VIEW = null;
  }

  return {
    logLine: logLine,
    policy: policy,
    transactions: transactions,
    transactionsClosed: transactionsClosed,
    transactionsRefresh: refreshTransactions
  };
})();
