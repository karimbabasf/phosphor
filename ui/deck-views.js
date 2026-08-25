/* deck-views.js: the records that live behind the deck bar, rendered once.
 *
 * WHY THIS FILE. The pro deck and the trading deck both open LOG, POLICY, HISTORY and GAS,
 * and they are the same records read from the same endpoints. Written twice they would
 * drift, and the way they drift is that one of them quietly starts showing less: a column
 * dropped here, a line truncated there. Written once, "nothing is shortened" is a property
 * of one file that can be checked.
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

  /* ---------- GAS ----------

     What this app has spent moving money, and where it went. Every movement burns gas
     somewhere, src/transactions.ts has carried the per-transaction figure since the history
     shipped, and until 2026-08-20 nothing added it up: the HISTORY table prints a fee per
     row, so a person asking "what has this cost me" was summing twelve rows in their head.

     ONE QUESTION IN THREE PARTS: what was spent, which kinds of action spent it, on which
     chain. Two rings and a total. byAction groups the MOVEMENT and byChain groups the
     RECEIPT, so a cross-chain move counts once in the first and twice in the second. The
     server does that split (spec 2.4) and this file only prints what it returns.

     THE TABLE IS THE AUTHORITY AND THE RING IS THE SHAPE OF IT. A canvas draws pixels, so
     it assigns no markup and the law at the top of this file survives it, but a canvas is
     also unreadable to anything that is not an eye. So every number on a ring is beside it
     as text, the canvas carries an aria-label naming its largest slices, and the table below
     carries all of them including the ones too thin to label.

     AND IT PRINTS WHAT IT COULD NOT COUNT. Four remainders (a receipt still being read, a
     hash no chain we can reach knows, a move signed as an intent, a fee with no price) and
     one loss, reverted, which is the only figure here that bought nothing. An aggregate that
     drops those quietly reports a smaller number than the truth and calls it the truth. A
     remainder that is zero prints nothing: "0 pending" is chrome. */

  /* '7d' is the endpoint's own default and the one a person wants first. A day is too short
     to hold a swap and the deposit that followed it, and 'all' on a machine that has been
     running for months is a number with no shape to read. */
  var GAS_WINDOW = '7d';
  var GAS = null;
  var GAS_LOADED = false;
  /* The elements an open overlay owns, null when shut, exactly as VIEW is above. */
  var GVIEW = null;
  var GAS_FRAME = 0;
  /* The ring sweeps once per open. A refresh under an open overlay redraws and does not
     move: a person reading a number does not want it counting up again underneath them. */
  var GAS_SWEPT = false;

  var GAS_WINDOWS = [
    { key: '24h', label: '24H' },
    { key: '7d', label: '7D' },
    { key: '30d', label: '30D' },
    { key: 'all', label: 'ALL' }
  ];

  var GAS_COLUMNS = [
    { cls: 'c-slice', label: 'SLICE' },
    { cls: 'c-num c-gasusd', label: 'GAS' },
    { cls: 'c-num c-share', label: 'SHARE' },
    { cls: 'c-num c-units', label: 'UNITS' },
    { cls: 'c-num c-txn', label: 'TX' }
  ];

  /* THE PALETTE IS THE APP'S OWN LADDER, READ OFF THE ELEMENT ABOUT TO BE PAINTED, never a
     table of hexes in here. Two reasons, and the second is the load-bearing one:

     the law at the top of ui/style.css is one hue and hierarchy by brightness and opacity,
     so a ring drawn in five steps of phosphor is the ring this surface is entitled to; and
     this file is shared by two decks and must depend on neither, so it cannot reach for the
     wallet donut's ten hues in ui/app.js, which ui/trade.js never loads.

     Resolved from the canvas rather than from :root, for the reason ui/agent-globe.js states
     at its own readRgb(): custom properties inherit, so the element that is going to be
     painted is always the right place to ask, and a screen whose tokens hang off an
     attribute higher up still answers correctly.

     Past the fifth slice the ladder runs out and the tail is derived rather than invented:
     opacity steps of --green, each one a fixed fraction of the last, starting from the alpha
     the faintest token already carries. Two neighbours down there are close, which is why
     every slice is trimmed by a hairline of ground at its edges: the ring stays countable
     even where the ink stops separating, and the table names them either way. */
  var GAS_RAMP = ['--green-hi', '--green', '--green-dim', '--green-faint', '--green-ghost'];
  var GAS_TAIL_STEP = 0.7;
  var GAS_TAIL_FLOOR = 0.05;
  /* Matches .gasring in ui/style.css, and it is a fallback rather than a duplicate: see
     fitRing() for the one frame in which the box measures zero. */
  var GAS_RING_PX = 150;
  /* The same hole the wallet donut has (DONUT_INNER in ui/app.js). Two rings in one app
     that are not the same object read as a mistake. */
  var GAS_INNER = 0.58;
  var GAS_SWEEP_MS = 300;
  /* Under two percent the label overlaps its neighbour's, and a ring crowded with
     overlapping text is less legible than a ring with none. It is in the table. */
  var GAS_LABEL_MIN = 0.02;
  var GAS_RING_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  var GAS_TOTAL_FONT = '600 15px ui-monospace, SFMono-Regular, Menlo, monospace';
  var TWO_PI = Math.PI * 2;

  function reducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) {
      return false;
    }
  }

  function raf(fn) {
    if (window.requestAnimationFrame) return window.requestAnimationFrame(fn);
    return window.setTimeout(function () {
      fn(Date.now());
    }, 16);
  }

  function cancelGasFrame() {
    if (!GAS_FRAME) return;
    if (window.cancelAnimationFrame) window.cancelAnimationFrame(GAS_FRAME);
    else window.clearTimeout(GAS_FRAME);
    GAS_FRAME = 0;
  }

  function rgbParts(raw) {
    var text = String(raw === null || raw === undefined ? '' : raw).trim();
    var hex = text.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    var fn = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    return null;
  }

  function alphaOf(raw) {
    var fn = String(raw === null || raw === undefined ? '' : raw)
      .match(/^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)\s*\)$/i);
    return fn ? Number(fn[1]) : 1;
  }

  function gasPalette(node) {
    var style = null;
    try {
      style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    } catch (err) {
      style = null;
    }
    function token(name) {
      if (!style || !style.getPropertyValue) return '';
      var value = style.getPropertyValue(name);
      return value ? String(value).trim() : '';
    }
    var ramp = [];
    for (var i = 0; i < GAS_RAMP.length; i++) {
      var step = token(GAS_RAMP[i]);
      if (step) ramp.push(step);
    }
    /* The inherited text colour is the last resort rather than a hex: it is the same green
       by definition, because ui/style.css sets body { color: var(--green) }. */
    return {
      ramp: ramp,
      base: rgbParts(token('--green') || (style ? style.color : '')),
      bg: token('--bg'),
      hi: token('--green-hi'),
      dim: token('--green-dim'),
      faint: token('--green-faint'),
      ghost: token('--green-ghost')
    };
  }

  function sliceInk(pal, index) {
    if (index < pal.ramp.length) return pal.ramp[index];
    var last = pal.ramp.length ? pal.ramp[pal.ramp.length - 1] : '';
    if (!pal.base) return last;
    var start = alphaOf(last);
    var alpha = Math.max(GAS_TAIL_FLOOR, start * Math.pow(GAS_TAIL_STEP, index - pal.ramp.length + 1));
    return 'rgba(' + pal.base[0] + ', ' + pal.base[1] + ', ' + pal.base[2] + ', ' + alpha.toFixed(3) + ')';
  }

  /* Ink for a label sitting ON a slice. The two brightest steps are near solid, so text on
     them is the ground colour; everything below is faint enough to take bright text. One
     rule, no second palette. */
  function labelInk(pal, index) {
    if (index < 2 && pal.bg) return pal.bg;
    return pal.hi || pal.ramp[0] || '';
  }

  /* Gas units are a decimal string end to end (spec 2.4): the sum over a long history goes
     past 2^53, so Number() would round it before it was ever printed. Grouped by hand for
     the same reason, and anything that is not a plain integer is passed through untouched
     rather than mangled. */
  function groupDigits(value) {
    var text = String(value === null || value === undefined ? '' : value);
    if (!/^\d+$/.test(text)) return text;
    var out = '';
    var seen = 0;
    for (var i = text.length - 1; i >= 0; i--) {
      out = text.charAt(i) + out;
      seen++;
      if (seen % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
  }

  function hasGas(units) {
    return /[1-9]/.test(String(units === null || units === undefined ? '' : units));
  }

  /* Basis points, and the precision follows the magnitude for the same reason usdSmall's
     does: "0 bp" in a line about what the gas cost reads as free. */
  function bps(value) {
    var v = Number(value);
    if (!isFinite(v)) return 'n/a';
    return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  }

  function gasWindowLabel() {
    if (GAS_WINDOW === '24h') return 'the last 24 hours';
    if (GAS_WINDOW === '7d') return 'the last 7 days';
    if (GAS_WINDOW === '30d') return 'the last 30 days';
    return 'all time';
  }

  function gasStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toTimeString().slice(0, 5);
  }

  function gasRange() {
    if (!GAS) return '';
    return GAS.fromTs ? 'since ' + gasStamp(GAS.fromTs) : 'all time';
  }

  /* The backing store follows the CSS box times DPR, the way ui/chart.js sizes its own,
     capped at 2 for the reason ui/agent-globe.js states: a third device pixel on a hairline
     buys nothing and costs the whole surface again.

     THE FALLBACK IS NOT DECORATION. A <dialog> is display:none until showModal(), and
     PhosphorOverlay calls build() before it opens, so a measure taken in the frame the view
     is built returns a zero box and the ring would be drawn one pixel wide. Every draw is a
     frame late for that reason (see startGasDraw) and this is the belt for the braces.

     clientWidth, NOT getBoundingClientRect. The panel this canvas sits in opens from
     transform: scale(0.95), and a bounding rect is the VISUAL box, so a ring measured during
     the 200ms open transition came back 159.6px for a 168px element, took a backing store
     5 percent small, and was then stretched into the box it actually had: soft type in the
     hole of the ring on a retina panel, which is the exact defect DPR handling is for. The
     layout box ignores the ancestor's transform. Found in a headless render, 2026-08-20.
     ui/chart.js and the wallet donut in ui/app.js both measure this way. */
  function fitRing(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(canvas.clientWidth || GAS_RING_PX);
    var h = Math.round(canvas.clientHeight || GAS_RING_PX);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function sliceTotal(slices) {
    var total = 0;
    for (var i = 0; i < slices.length; i++) {
      var v = Number(slices[i].feeUsd);
      if (isFinite(v)) total += v;
    }
    return total;
  }

  /* What the canvas says out loud. The largest three, because a label that reads out
     nineteen slices is one nobody listens to, and it says where the rest are. */
  function ringLabel(kind, slices, total) {
    var head = 'Gas by ' + kind + ', ' + gasWindowLabel() + '. ';
    if (!GAS_LOADED) return head + 'Not read yet.';
    var parts = [];
    for (var i = 0; i < slices.length && parts.length < 3; i++) {
      if (!(Number(slices[i].share) > 0)) continue;
      parts.push(slices[i].label + ' ' + pct(slices[i].share));
    }
    if (!parts.length) return head + 'Nothing burned gas in this window.';
    return head + usdSmall(total) + ' in total. Largest: ' + parts.join(', ')
      + '. The table beside this ring holds every slice.';
  }

  function drawEmptyRing(ctx, pal, cx, cy, outer) {
    if (pal.ghost) ctx.strokeStyle = pal.ghost;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, TWO_PI);
    ctx.stroke();
    if (pal.faint) ctx.fillStyle = pal.faint;
    ctx.fillText(GAS_LOADED ? 'no gas' : 'reading', cx, cy);
  }

  /* The hole in the middle holds the number a person came for, and under it the window it
     is of, because a total with no window is a claim about all of history. */
  function drawRingCentre(ctx, pal, cx, cy, total) {
    ctx.font = GAS_TOTAL_FONT;
    if (pal.hi) ctx.fillStyle = pal.hi;
    ctx.fillText(usdSmall(total), cx, cy - 7);
    ctx.font = GAS_RING_FONT;
    if (pal.dim) ctx.fillStyle = pal.dim;
    ctx.fillText(GAS_WINDOW, cx, cy + 9);
  }

  function paintRing(unit, slices, progress) {
    var box = fitRing(unit.canvas);
    if (!box) return;
    var ctx = box.ctx;
    var pal = gasPalette(unit.canvas);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.font = GAS_RING_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    var cx = box.w / 2;
    var cy = box.h / 2;
    var outer = Math.min(box.w, box.h) / 2 - 4;
    if (outer <= 6) return;
    var inner = outer * GAS_INNER;
    var total = sliceTotal(slices);

    if (!slices.length || !(total > 0)) {
      drawEmptyRing(ctx, pal, cx, cy, outer);
      ctx.textAlign = 'left';
      return;
    }

    // A gap of about 1.5px at the outer edge, as an angle, so two neighbouring steps of one
    // hue never merge into a single unreadable band. Same figure the wallet donut uses.
    var gap = 1.5 / outer;
    var limit = TWO_PI * progress;
    var start = -Math.PI / 2;
    var acc = 0;
    for (var i = 0; i < slices.length; i++) {
      var share = total > 0 ? (Number(slices[i].feeUsd) || 0) / total : 0;
      var sweep = share * TWO_PI;
      var from = acc;
      var to = Math.min(acc + sweep, limit);
      acc += sweep;
      if (to <= from) break;
      var trim = to - from > gap * 3 ? gap : 0;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, start + from + trim / 2, start + to - trim / 2);
      ctx.arc(cx, cy, inner, start + to - trim / 2, start + from + trim / 2, true);
      ctx.closePath();
      var ink = sliceInk(pal, i);
      if (ink) ctx.fillStyle = ink;
      ctx.fill();
    }

    /* Labels after the sweep has landed, never during it: text sliding out from under a
       growing arc is the kind of motion this app's law rations away. */
    var mid = (outer + inner) / 2;
    var band = outer - inner;
    if (progress >= 1 && band >= 14) {
      acc = 0;
      for (var j = 0; j < slices.length; j++) {
        var part = total > 0 ? (Number(slices[j].feeUsd) || 0) / total : 0;
        var arc = part * TWO_PI;
        var at = start + acc + arc / 2;
        acc += arc;
        if (part < GAS_LABEL_MIN) continue;
        var text = String(slices[j].label);
        var width = ctx.measureText ? ctx.measureText(text).width : text.length * 7;
        /* Two gates, not one. Under two percent is the rule, and wider than its own arc is
           the same defect arriving on a ring of four slices instead of forty: a label that
           runs past its slice is pointing at the wrong number. */
        if (width > arc * mid) continue;
        var lab = labelInk(pal, j);
        if (lab) ctx.fillStyle = lab;
        /* The text runs ALONG the ring rather than across it. The band here is about 34px
           and every label in this report is longer than the four characters that fits
           horizontally, so a straight label would be gated out of existence by the width
           test above and the ring would never carry one. */
        ctx.save();
        ctx.translate(cx + Math.cos(at) * mid, cy + Math.sin(at) * mid);
        // Upside down on the lower half otherwise, which is unreadable rather than stylish.
        ctx.rotate(at + Math.PI / 2 + (Math.sin(at) > 0 ? Math.PI : 0));
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }

    drawRingCentre(ctx, pal, cx, cy, total);
    ctx.textAlign = 'left';
  }

  function paintGas(progress) {
    if (!GVIEW) return;
    paintRing(GVIEW.action, GAS ? GAS.byAction || [] : [], progress);
    paintRing(GVIEW.chain, GAS ? GAS.byChain || [] : [], progress);
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* One frame late, always, for the reason fitRing states: the dialog has no box until
     showModal() has run, which is after build(). The sweep is the only motion this view
     has, it runs once per open, and prefers-reduced-motion gets the final state in that
     same deferred frame rather than a shorter animation. */
  function startGasDraw() {
    if (!GVIEW) return;
    cancelGasFrame();
    if (GAS_SWEPT || reducedMotion()) {
      GAS_FRAME = raf(function () {
        GAS_FRAME = 0;
        GAS_SWEPT = true;
        paintGas(1);
      });
      return;
    }
    var began = null;
    GAS_FRAME = raf(function step(now) {
      if (!GVIEW) return;
      var stamp = typeof now === 'number' ? now : 0;
      if (began === null) began = stamp;
      var t = GAS_SWEEP_MS > 0 ? Math.min(1, (stamp - began) / GAS_SWEEP_MS) : 1;
      paintGas(easeOut(t));
      if (t < 1) {
        GAS_FRAME = raf(step);
        return;
      }
      GAS_FRAME = 0;
      GAS_SWEPT = true;
    });
  }

  function gasSpanRow(text) {
    var tr = document.createElement('tr');
    var cell = el('td', 'faint', text);
    cell.colSpan = GAS_COLUMNS.length;
    tr.appendChild(cell);
    return tr;
  }

  function renderGasLegend(unit, slices) {
    var tbody = unit.rows;
    tbody.textContent = '';
    if (!slices.length) {
      tbody.appendChild(gasSpanRow(!GAS_LOADED ? 'reading...' : 'nothing burned gas in this window'));
      return;
    }
    var pal = gasPalette(unit.canvas);
    for (var i = 0; i < slices.length; i++) {
      var slice = slices[i];
      var tr = document.createElement('tr');

      var name = el('td', 'slice');
      var chip = el('span', 'chip');
      chip.style.background = sliceInk(pal, i);
      chip.setAttribute('aria-hidden', 'true');
      name.appendChild(chip);
      name.appendChild(document.createTextNode(slice.label));
      name.title = slice.label + ': ' + slice.moveCount
        + (slice.moveCount === 1 ? ' movement' : ' movements');
      tr.appendChild(name);

      // A slice exists because it burned gas, so no dollars means no price was available,
      // not that it was free. Printing $0.00 here would be the second thing.
      var money = el('td', 'num');
      if (Number(slice.feeUsd) > 0) money.appendChild(document.createTextNode(usdSmall(slice.feeUsd)));
      else money.appendChild(el('span', 'faint', 'unpriced'));
      tr.appendChild(money);

      tr.appendChild(el('td', 'num', pct(slice.share)));

      // Gas units past ten digits do not fit the column. Truncated in the cell and whole in
      // its title, the way the history table treats an address.
      var units = el('td', 'num', groupDigits(slice.gasUsed));
      units.title = groupDigits(slice.gasUsed) + ' gas units';
      tr.appendChild(units);
      tr.appendChild(el('td', 'num', String(slice.txCount)));
      tbody.appendChild(tr);
    }
  }

  function gasNote(box, text, cls) {
    box.appendChild(el('div', cls ? 'gasnote ' + cls : 'gasnote', text));
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function renderGasNotes() {
    var box = GVIEW.notes;
    box.textContent = '';
    if (!GAS) {
      gasNote(box, 'reading the gas report...', 'faint');
      return;
    }
    var said = 0;

    if (hasGas(GAS.totalGasUsed)) {
      gasNote(box, groupDigits(GAS.totalGasUsed) + ' gas units, over '
        + plural(GAS.txCount, 'transaction', 'transactions') + '.');
      said++;
    }

    if (GAS.gasBps !== null && GAS.gasBps !== undefined) {
      gasNote(box, 'gas cost ' + bps(GAS.gasBps) + ' bp of the ' + usd(GAS.movedUsd) + ' this app moved.');
      said++;
    } else if (GAS.totalUsd > 0) {
      // Not a missing number: nothing settled in this window, so there is no denominator.
      gasNote(box, 'nothing moved in this window, so there is nothing to weigh the gas against.');
      said++;
    }

    if (GAS.venueFeeUsd > 0) {
      gasNote(box, 'venue fees ' + usd(GAS.venueFeeUsd)
        + ', quoted at approval. Not gas, and not in the total above.');
      said++;
    }

    // The one figure here that bought nothing, and the only red on this surface.
    if (GAS.reverted && GAS.reverted.txCount > 0) {
      gasNote(box, 'REVERTED: ' + usdSmall(GAS.reverted.feeUsd) + ' burned on '
        + plural(GAS.reverted.txCount, 'transaction that moved', 'transactions that moved')
        + ' nothing.', 'red');
      said++;
    }

    if (GAS.pending && GAS.pending.moveCount > 0) {
      gasNote(box, 'still reading: ' + plural(GAS.pending.moveCount, 'movement whose receipt has', 'movements whose receipts have')
        + ' not landed. That gas is not in this total.');
      said++;
    }
    if (GAS.unknown && GAS.unknown.moveCount > 0) {
      gasNote(box, 'unknown: no chain this app can reach has a receipt for '
        + plural(GAS.unknown.moveCount, 'movement', 'movements') + '. That gas is not in this total.');
      said++;
    }
    if (GAS.intentOnly && GAS.intentOnly.moveCount > 0) {
      gasNote(box, plural(GAS.intentOnly.moveCount, 'movement was', 'movements were')
        + ' signed as an intent: no gas of ours, settled by a solver.');
      said++;
    }
    if (GAS.unpriced && GAS.unpriced.txCount > 0) {
      gasNote(box, 'unpriced: ' + plural(GAS.unpriced.txCount, 'transaction', 'transactions')
        + ' burned ' + groupDigits(GAS.unpriced.gasUsed)
        + ' gas units with no price to convert. The units are counted, the dollars are not.');
      said++;
    }

    if (!said) gasNote(box, 'nothing has burned gas in this window.', 'faint');
  }

  function renderGasMeta() {
    var meta = GVIEW.meta;
    meta.textContent = '';
    if (!GAS) {
      meta.appendChild(document.createTextNode('reading the gas report...'));
      return;
    }
    meta.appendChild(document.createTextNode(
      plural(GAS.moveCount, 'movement', 'movements') + ', '
      + plural(GAS.txCount, 'transaction', 'transactions') + '   ' + gasRange()
    ));
  }

  function renderGas() {
    if (!GVIEW) return;
    var byAction = GAS ? GAS.byAction || [] : [];
    var byChain = GAS ? GAS.byChain || [] : [];
    var total = GAS ? GAS.totalUsd : 0;
    renderGasMeta();
    renderGasLegend(GVIEW.action, byAction);
    renderGasLegend(GVIEW.chain, byChain);
    GVIEW.action.canvas.setAttribute('aria-label', ringLabel('action', byAction, total));
    GVIEW.chain.canvas.setAttribute('aria-label', ringLabel('chain', byChain, total));
    renderGasNotes();
    startGasDraw();
  }

  function renderGasWindows() {
    if (!GVIEW) return;
    var box = GVIEW.windows;
    box.textContent = '';
    for (var i = 0; i < GAS_WINDOWS.length; i++) {
      (function (win) {
        var btn = el('button', 'tf' + (GAS_WINDOW === win.key ? ' on' : ''), win.label);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          if (GAS_WINDOW === win.key) return;
          GAS_WINDOW = win.key;
          /* The old window's numbers may not sit under the new button for the length of a
             fetch: that is a wrong number stated confidently, which is the defect this whole
             view exists to argue against. And the ring redraws rather than sweeping again. */
          GAS = null;
          GAS_LOADED = false;
          GAS_SWEPT = true;
          renderGasWindows();
          renderGas();
          refreshGas();
        });
        box.appendChild(btn);
      })(GAS_WINDOWS[i]);
    }
  }

  /* Called on open, and again whenever the server says a receipt landed. A no-op with the
     overlay shut, exactly as refreshTransactions is: nobody is looking, and opening it reads
     afresh anyway. */
  function refreshGas() {
    if (!GVIEW) return Promise.resolve();
    var onError = GVIEW.onError;
    var asked = GAS_WINDOW;
    return getJson('/api/gas?window=' + encodeURIComponent(asked)).then(function (report) {
      // A slow answer to a window nobody is looking at any more would draw the wrong ring
      // under the right button. The history view never needed this guard; this one asks a
      // question that can change while the answer is in flight.
      if (!GVIEW || asked !== GAS_WINDOW) return;
      GAS = report;
      GAS_LOADED = true;
      renderGas();
    }, function (err) {
      if (onError) onError('cannot read the gas report: ' + (err.message || String(err)));
    });
  }

  function gasUnit(kind, title) {
    var wrap = el('div', 'gasunit');
    wrap.appendChild(el('p', 'gasunit-h', title));

    var body = el('div', 'gasunit-body');
    var canvas = el('canvas', 'gasring');
    /* An image with a name, not a decoration: the ring IS the shape of the numbers, so it
       is announced, and what it announces is rewritten on every render. */
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Gas by ' + kind + '. Not read yet.');

    var legend = el('div', 'gaslegend');
    var table = el('table', 'grid gastable');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    for (var i = 0; i < GAS_COLUMNS.length; i++) {
      headRow.appendChild(el('th', GAS_COLUMNS[i].cls, GAS_COLUMNS[i].label));
    }
    head.appendChild(headRow);
    var rows = document.createElement('tbody');
    table.appendChild(head);
    table.appendChild(rows);
    legend.appendChild(table);

    body.appendChild(canvas);
    body.appendChild(legend);
    wrap.appendChild(body);
    return { wrap: wrap, canvas: canvas, rows: rows, kind: kind };
  }

  function gas(box, onError) {
    var bar = el('p', 'gasbar');
    var windows = el('span', 'tfs');
    var meta = el('span', 'meta faint', '--');
    bar.appendChild(windows);
    bar.appendChild(meta);

    var rings = el('div', 'gasrings');
    var action = gasUnit('action', 'BY ACTION');
    var chain = gasUnit('chain', 'BY CHAIN');
    rings.appendChild(action.wrap);
    rings.appendChild(chain.wrap);

    var notes = el('div', 'gasnotes');

    box.appendChild(bar);
    box.appendChild(rings);
    box.appendChild(notes);

    GVIEW = { action: action, chain: chain, meta: meta, windows: windows, notes: notes, onError: onError || null };
    GAS_SWEPT = false;
    renderGasWindows();
    // Whatever the last read produced is on screen before the network is touched, the same
    // way the history opens, and the read below replaces it when it lands.
    renderGas();
    refreshGas();
  }

  function gasClosed() {
    // The frame first: a sweep still running would paint into a canvas nobody can see, and
    // on a fast close it would paint into one that has been thrown away.
    cancelGasFrame();
    GVIEW = null;
    GAS_SWEPT = false;
  }

  return {
    logLine: logLine,
    policy: policy,
    transactions: transactions,
    transactionsClosed: transactionsClosed,
    transactionsRefresh: refreshTransactions,
    gas: gas,
    gasClosed: gasClosed,
    gasRefresh: refreshGas
  };
})();
