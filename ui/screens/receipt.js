/* The receipt card, and the unknown-outcome card that is the same card in the
   one state a person cannot act on alone.

   Hex lives here and nowhere else. Every other surface in the window says what
   moved in words; this is where a person goes when they want the hash.

   Three ways in. `open(receipt)` is the popover: a native dialog over the whole
   window, closed by Esc, the backdrop or its own close control. `card(receipt)`
   is the same card built to sit inline in the assistant thread at full width,
   as a message from the app. And the `receipt:open` event on the window bus
   opens the popover for whoever emits it (an Activity row, a Done fill), so
   the surfaces that hold receipts never need to know how the card is drawn.

   What the card reads off a receipt (src/http/receipts.ts): kind, status, at,
   amount and symbol (what left), received (what arrived), feesUsd, valueUsd,
   venue, fromChain and toChain, wallet, txids [{chain, hash, url, explorer}],
   and preflight, the checks the app ran before it signed, drawn folded under
   the card by ui/screens/checks.js when the row carries them.
   A fill mapped to this shape by the trade screen adds `side` ('buy'|'sell')
   and `closed` (true when the fill closed a position) so the kind word can say
   Bought, Sold or Trade closed. */
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
    near: 'NEAR',
    intents: 'NEAR Intents',
    hyperliquid: 'Hyperliquid'
  };

  function chainName(id) {
    return CHAIN_NAMES[id] || String(id || '');
  }

  /* The venue as a person names it. The draft carries the rail's own identifier. */
  var VENUE_NAMES = {
    'intents.near': 'NEAR Intents',
    'intents-native': 'NEAR Intents',
    'intents-relay': 'NEAR Intents',
    oneclick: 'NEAR Intents',
    hyperliquid: 'Hyperliquid',
    'uniswap-v3': 'Uniswap v3'
  };

  function venueName(id) {
    if (!id) return '';
    if (Object.prototype.hasOwnProperty.call(VENUE_NAMES, id)) return VENUE_NAMES[id];
    var word = String(id);
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /* Every kind the record can hold (src/transactions.ts ACTIONS, plus the trade
     shapes the Done list maps into this card) as one word and one icon. The retired
     rails stay: the rows they wrote are still on disk and still open. */
  var KINDS = {
    swap: { word: 'Swap', icon: 'swap' },
    consolidate: { word: 'Moved', icon: 'swap' },
    intents_deposit: { word: 'Deposit', icon: 'deposit' },
    hl_deposit: { word: 'Deposit', icon: 'deposit' },
    yield_deposit: { word: 'Deposit', icon: 'deposit' },
    lp_add: { word: 'Liquidity added', icon: 'deposit' },
    intents_withdraw: { word: 'Withdrawal', icon: 'withdraw' },
    intents_send: { word: 'Sent', icon: 'withdraw' },
    intents_pay: { word: 'Paid', icon: 'withdraw' },
    hl_withdraw: { word: 'Withdrawal', icon: 'withdraw' },
    yield_withdraw: { word: 'Withdrawal', icon: 'withdraw' },
    lp_remove: { word: 'Liquidity removed', icon: 'withdraw' },
    transfer: { word: 'Sent', icon: 'withdraw' },
    policy_change: { word: 'Rule changed', icon: 'lock' },
    mandate_arm: { word: 'Bot armed', icon: 'armed' },
    bot: { word: 'Bot armed', icon: 'armed' }
  };

  function kindOf(receipt) {
    var kind = String(receipt.kind || '');
    if (kind === 'trade' || kind === 'fill') {
      if (receipt.closed === true) return { word: 'Trade closed', icon: 'done' };
      var side = String(receipt.side || '').toLowerCase();
      return side === 'sell' || side === 'short'
        ? { word: 'Sold', icon: 'short' }
        : { word: 'Bought', icon: 'long' };
    }
    return KINDS[kind] || { word: 'Receipt', icon: 'done' };
  }

  function kindWord(receipt) {
    return kindOf(receipt).word;
  }

  /* The outcome as a chip. Executed is done; failed is the venue saying no after the
     fact, which is not the same as a refusal at the gate, so each keeps its own word.
     Not confirmed is a move the app cannot say went through or did not: it carries a
     hash, so money moved or may have, and the venue has not said which. */
  var STATUS = {
    executed: { word: 'Done', tone: 'up', icon: 'done' },
    done: { word: 'Done', tone: 'up', icon: 'done' },
    failed: { word: 'Failed', tone: 'down', icon: 'refused' },
    refused: { word: 'Refused', tone: 'down', icon: 'refused' },
    needs_reconciliation: { word: 'Not confirmed', tone: 'warn', icon: 'waiting' },
    pending: { word: 'Waiting', tone: 'warn', icon: 'waiting' },
    pending_unlock: { word: 'Waiting', tone: 'warn', icon: 'waiting' },
    awaiting_touch: { word: 'Waiting', tone: 'warn', icon: 'waiting' },
    waiting: { word: 'Waiting', tone: 'warn', icon: 'waiting' }
  };

  function statusOf(receipt) {
    return STATUS[String(receipt.status || '')] || STATUS.done;
  }

  /* The three things a row that is not done can be. A failed row with no hash moved
     nothing. A failed row with a hash is a move the venue rejected after the money went:
     refunded when 1Click said so, and otherwise no more confirmed than an unknown one,
     which is why "did not go through" is never said over a hash. */
  function hashCount(receipt) {
    return Array.isArray(receipt.txids) ? receipt.txids.filter(function (tx) { return tx && tx.hash; }).length : 0;
  }

  function nothingLeft(receipt) {
    return receipt.status === 'failed' && hashCount(receipt) === 0;
  }

  function unconfirmed(receipt) {
    if (receipt.status === 'needs_reconciliation') return true;
    return receipt.status === 'failed' && hashCount(receipt) > 0 && !receipt.refunded;
  }

  function refundedLine(receipt) {
    var symbol = receipt.symbol ? ' ' + String(receipt.symbol) : '';
    return 'Refunded ' + String(receipt.refunded) + symbol;
  }

  function icon(name, className) {
    return window.PhosphorIcons.svg(name, className);
  }

  function logo(symbol, size) {
    return marks.logo(symbol, size);
  }

  /* ---------- the card ---------- */

  /* The first six and the last four: enough to match against a wallet or an
     explorer by eye, and the whole id is one hover or one Copy away. */
  function shortHash(hash) {
    var text = String(hash || '');
    if (text.length <= 14) return text;
    return text.slice(0, 6) + '...' + text.slice(-4);
  }

  function shortAddress(address) {
    var text = String(address || '');
    if (text.length <= 16) return text;
    return text.slice(0, 6) + '...' + text.slice(-4);
  }

  /* https alone was the whole check here, so any https host the server named
     became a link the desktop shell handed to the browser. The one list writes
     the href now (core/links.js), and says whether it wrote one. */
  function setHref(anchor, url) {
    var links = window.PhosphorLinks;
    return !!links && typeof links.setHref === 'function' && links.setHref(anchor, url);
  }

  function whenText(iso) {
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function copyToClipboard(text, label) {
    if (!(navigator.clipboard && navigator.clipboard.writeText)) return;
    navigator.clipboard.writeText(text).then(function () {
      dom.setText(label, 'Copied');
      window.setTimeout(function () { dom.setText(label, 'Copy'); }, 1500);
    }).catch(function () { /* the hash is on screen to read */ });
  }

  function leg(dir, amount, symbol, muted) {
    var node = dom.el('span', 'receipt-leg');
    node.dataset.dir = dir;
    node.appendChild(logo(symbol, 32));
    node.appendChild(dom.el('span', 'receipt-amount mono' + (muted ? ' dim' : ''), amount));
    return node;
  }

  /* The from and to line. What left is signed minus, what arrived is signed plus and
     green, and the swap icon between them is in the accent. A move that moved nothing
     shows its amount unsigned and quiet and nothing arrives. A move the app cannot
     confirm shows the amount unsigned but not quiet, since that is the money in
     question, and nothing arriving. A move with no recorded arrival names where the
     money went instead of inventing a number. */
  function legs(receipt) {
    var wrap = dom.el('div', 'receipt-legs');
    var done = receipt.status === 'executed';
    var nothing = nothingLeft(receipt);
    var symbol = receipt.symbol ? String(receipt.symbol) : '';
    var left = typeof receipt.amount === 'number';
    if (left) {
      wrap.appendChild(leg('out', (done ? '-' : '') + dom.qty(receipt.amount) + (symbol ? ' ' + symbol : ''), symbol, nothing));
    }
    var got = receipt.received;
    var arrived = done && got && typeof got.amount === 'number' && got.symbol;
    if (arrived) {
      wrap.appendChild(icon('swap', 'receipt-arrow'));
      wrap.appendChild(leg('in', '+' + dom.qty(got.amount) + ' ' + String(got.symbol), String(got.symbol), false));
    } else if (done && left && receipt.toChain && receipt.toChain !== receipt.fromChain) {
      wrap.appendChild(icon('swap', 'receipt-arrow'));
      wrap.appendChild(dom.el('span', 'receipt-leg receipt-leg-place', 'to ' + chainName(receipt.toChain)));
    }
    return wrap;
  }

  function cell(host, label, value, mono, full) {
    if (value === '' || value === null || value === undefined) return;
    var item = dom.el('div', 'receipt-cell');
    item.appendChild(dom.el('dt', 'label', label));
    var dd = dom.el('dd', mono ? 'mono' : '', value);
    if (full) dd.title = full;
    item.appendChild(dd);
    host.appendChild(item);
  }

  /* Four facts under the line. Fee says "none yet" rather than a zero while the gas
     is still being read back, because a fee of zero is a different fact. The chain
     cell names one place, or both when the money changed place. */
  function grid(receipt) {
    var list = dom.el('dl', 'receipt-grid');
    cell(list, 'Value', typeof receipt.valueUsd === 'number' ? dom.usd(receipt.valueUsd) : '', true);
    cell(list, 'Fee', typeof receipt.feesUsd === 'number' ? dom.fee(receipt.feesUsd) : 'none yet', typeof receipt.feesUsd === 'number');
    /* A move between two places names the route, because that is what the person checks
       ("Base to NEAR Intents"); a move inside one place names the venue that did it. */
    var venue = venueName(receipt.venue);
    var from = receipt.fromChain ? chainName(receipt.fromChain) : '';
    var to = receipt.toChain ? chainName(receipt.toChain) : '';
    if (from && to && from !== to) cell(list, 'Chain', from + ' to ' + to, false);
    else if (venue) cell(list, 'Venue', venue, false);
    else if (from || to) cell(list, 'Chain', from || to, false);
    var onVenue = receipt.fromChain === 'intents' || receipt.fromChain === 'hyperliquid';
    if (receipt.wallet) cell(list, onVenue ? 'Account' : 'Wallet', shortAddress(receipt.wallet), true, String(receipt.wallet));
    else if (receipt.account) cell(list, 'Account', shortAddress(receipt.account), true, String(receipt.account));
    return list;
  }

  function hashRow(tx) {
    var row = dom.el('div', 'receipt-tx');
    var code = dom.el('code', 'receipt-tx-hash mono', shortHash(tx.hash));
    code.title = String(tx.hash);
    row.appendChild(code);
    if (tx.chain) row.appendChild(dom.el('span', 'receipt-tx-place meta', chainName(tx.chain)));
    var copy = dom.el('button', 'btn btn-quiet btn-sm receipt-copy');
    copy.type = 'button';
    copy.appendChild(icon('copy'));
    var label = dom.el('span', 'btn-label', 'Copy');
    copy.appendChild(label);
    row.appendChild(copy);
    dom.on(copy, 'click', function () { copyToClipboard(String(tx.hash), label); });
    return row;
  }

  /* One link out, to the explorer of the first hash that has one. Only a url the
     server built (src/transactions.ts) and only https: nothing in a receipt is typed
     by a person, but this is the one place the window hands the system browser a
     string, so it is checked here as well. target=_blank is what the desktop shell
     routes to the browser; a plain navigation would replace the app. */
  function viewButton(txids) {
    for (var i = 0; i < txids.length; i += 1) {
      var tx = txids[i];
      var link = dom.el('a', 'btn btn-primary receipt-view');
      if (!setHref(link, tx.url)) continue;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(dom.el('span', 'btn-label', 'View on ' + (tx.explorer || explorerNameOf(tx.url))));
      link.appendChild(icon('external'));
      return link;
    }
    return null;
  }

  /* The server names the explorer on every txid it serves (src/explorers.ts). A
     fill mapped on the client carries the url alone, so the names are here for
     that one case. Which hosts are linkable at all is core/net.js's list; this
     one only says what to call them. */
  var EXPLORER_HOSTS = [
    ['basescan.org', 'Basescan'],
    ['arbiscan.io', 'Arbiscan'],
    ['etherscan.io', 'Etherscan'],
    ['solscan.io', 'Solscan'],
    ['nearblocks.io', 'Nearblocks'],
    ['explorer.near-intents.org', 'NEAR Intents explorer'],
    ['app.hyperliquid.xyz', 'Hyperliquid explorer']
  ];

  function explorerNameOf(url) {
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (err) { return 'explorer'; }
    for (var i = 0; i < EXPLORER_HOSTS.length; i += 1) {
      var suffix = EXPLORER_HOSTS[i][0];
      if (host === suffix || host.slice(-suffix.length - 1) === '.' + suffix) return EXPLORER_HOSTS[i][1];
    }
    return 'explorer';
  }

  /* The card. `opts.inline` drops the close control and marks the card for the
     thread; `opts.onClose` is what the close control and a reconcile that settles
     the row call. */
  function build(receipt, opts) {
    var options = opts || {};
    var kind = kindOf(receipt);
    var status = statusOf(receipt);
    var unknown = receipt.status === 'needs_reconciliation';

    var card = dom.el('article', 'receipt-card');
    card.dataset.kind = String(receipt.kind || '');
    card.dataset.status = String(receipt.status || '');
    if (options.inline) card.dataset.inline = 'true';
    card.setAttribute('aria-label', kind.word + ', ' + status.word);

    var head = dom.el('header', 'receipt-head');
    var title = dom.el('span', 'receipt-kind');
    title.appendChild(icon(kind.icon, 'icon-20'));
    title.appendChild(dom.el('span', '', kind.word));
    head.appendChild(title);
    var chip = dom.el('span', 'chip receipt-status');
    chip.dataset.tone = status.tone;
    chip.appendChild(icon(status.icon));
    chip.appendChild(dom.el('span', '', status.word));
    head.appendChild(chip);
    if (receipt.at) {
      var time = dom.el('time', 'receipt-time', dom.ago(receipt.at));
      time.dateTime = String(receipt.at);
      time.title = whenText(receipt.at);
      head.appendChild(time);
    }
    if (!options.inline) {
      var close = dom.el('button', 'receipt-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.appendChild(icon('close'));
      head.appendChild(close);
      dom.on(close, 'click', function () { if (options.onClose) options.onClose(); });
    }
    card.appendChild(head);

    /* The note leads with what the app knows and then hands over to the rail's own sentence,
       verbatim: that line names the handle, what was refunded and where the input sits, and
       it is the one thing on the card written by the code that did the work. */
    if (unconfirmed(receipt)) {
      var warn = dom.el('p', 'receipt-note');
      warn.dataset.tone = 'warn';
      dom.setText(warn, 'Not confirmed. Still checking whether this went through. Check again for the latest.'
        + (receipt.summary ? ' ' + String(receipt.summary) : ''));
      card.appendChild(warn);
    } else if (receipt.status === 'failed' && receipt.refunded) {
      var back = dom.el('p', 'receipt-note');
      back.dataset.tone = 'warn';
      dom.setText(back, refundedLine(receipt) + '.' + (receipt.summary ? ' ' + String(receipt.summary) : ''));
      card.appendChild(back);
    }
    if (receipt.handle && receipt.status !== 'executed') {
      var handle = dom.el('p', 'receipt-handle mono');
      handle.title = String(receipt.handle);
      dom.setText(handle, 'Handle ' + String(receipt.handle));
      card.appendChild(handle);
    }

    card.appendChild(legs(receipt));
    card.appendChild(grid(receipt));

    var txids = Array.isArray(receipt.txids) ? receipt.txids.filter(function (tx) { return tx && tx.hash; }) : [];
    var view = viewButton(txids);
    if (txids.length || unknown) {
      var foot = dom.el('footer', 'receipt-foot');
      for (var i = 0; i < txids.length; i += 1) foot.appendChild(hashRow(txids[i]));
      var error = dom.el('p', 'receipt-error body down');
      error.hidden = true;
      var actions = dom.el('div', 'receipt-actions');
      if (unknown) actions.appendChild(recheckButton(receipt, error, options.onClose));
      if (view) actions.appendChild(view);
      if (actions.children.length) {
        foot.appendChild(error);
        foot.appendChild(actions);
      }
      card.appendChild(foot);
    }

    /* The checks, folded, under everything else: a person who wants to see
       what the app read before it signed opens them; nobody else is shown a
       wall of numbers. */
    var checks = window.PhosphorChecks;
    if (receipt.preflight && checks && typeof checks.fold === 'function') {
      checks.fold(card, receipt.preflight, { open: options.checksOpen === true });
    }
    return card;
  }

  /* Still unreadable is an answer, and the card stays open on it: closing would look
     like it had been settled. */
  function recheckButton(receipt, error, onClose) {
    var recheck = dom.el('button', 'btn btn-ghost');
    recheck.type = 'button';
    var face = dom.el('span', 'btn-face');
    face.appendChild(icon('retry'));
    face.appendChild(dom.el('span', 'btn-label', 'Check it again'));
    recheck.appendChild(face);
    dom.setAttr(recheck, 'data-pending-label', 'Checking');
    dom.on(recheck, 'click', function () {
      window.PhosphorShell.setPending(recheck, true);
      api.reconcile(receipt.id)
        .then(function (answer) {
          var status = answer && answer.status;
          if (status === 'needs_reconciliation') {
            var said = answer && typeof answer.detail === 'string' && answer.detail.trim();
            dom.setText(error, said ? 'Checked again just now: ' + said : 'Still checking whether this went through. Check again for the latest.');
            error.hidden = false;
            return;
          }
          window.PhosphorToast.show('Checked. It is ' + readableStatus(status, receipt) + '.'
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
    return recheck;
  }

  function card(receipt) {
    return build(receipt, { inline: true });
  }

  /* ---------- the popover ---------- */

  var current = null;

  /* Moment 3: the card scales 0.96 to 1 with its opacity over 220 ms; the backdrop
     fades in the stylesheet. Reduced motion keeps the fade and drops the scale. The
     guard is for the unit harness, which has no vendored file, the same as lock.js. */
  function enter(node) {
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    var reduced = window.PhosphorMotion.reduced();
    var frames = reduced ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [0.96, 1] };
    Motion.animate(node, frames, { duration: 0.22, ease: [0.22, 1, 0.36, 1] });
  }

  function open(receipt, opts) {
    if (!receipt) return null;
    if (current) close();
    var dialog = document.createElement('dialog');
    dialog.className = 'receipt-dialog';
    dialog.dataset.source = (opts && opts.source) || '';
    var node = build(receipt, { onClose: close });
    node.tabIndex = -1;
    node.setAttribute('autofocus', '');
    dialog.appendChild(node);
    /* A click on the dialog box itself is a click on the backdrop: the card is the
       box's only child and fills it, so anything outside the card lands here. */
    dom.on(dialog, 'click', function (event) { if (event.target === dialog) close(); });
    dom.on(dialog, 'cancel', function (event) { event.preventDefault(); close(); });
    dom.on(dialog, 'close', function () {
      if (current === dialog) current = null;
      dialog.remove();
    });
    document.body.appendChild(dialog);
    current = dialog;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    enter(node);
    return dialog;
  }

  function close() {
    var dialog = current;
    if (!dialog) return;
    current = null;
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.remove();
  }

  function isOpen() {
    return current !== null;
  }

  var events = window.PhosphorEvents;
  if (events && typeof events.on === 'function') {
    events.on('receipt:open', function (payload) {
      if (payload && payload.receipt) open(payload.receipt, { source: payload.source });
    });
  }

  /* "nothing left your wallet" is said only over a row with no hash: a check that answers
     failed on a row that carries one is the venue saying no after the money went. */
  function readableStatus(status, receipt) {
    if (status === 'executed') return 'done';
    if (status === 'failed') return hashCount(receipt || {}) === 0 ? 'not done, and nothing left your wallet' : 'not done';
    if (status === 'needs_reconciliation') return 'still not confirmed';
    return 'no longer waiting';
  }

  /* ---------- the Activity row ---------- */

  /* An Activity row, drawn as a transaction (the .tx grammar in components.css),
     the way a statement line reads: the mark of the coin that left, the sentence,
     and under it when and what it cost; on the right what left, signed, and under
     it what arrived, in green. Karim, 2026-09-14: "I want these to look like
     actual transactions." The first cut put the arrival and the fee together on
     one dim line under the amount, and he read the rows as squished and
     unformatted: three facts in 12 px mono in the same grey. Now each side of
     the row carries two facts of the same kind (words left, money right), and
     the arrival is the one green thing on the line. The coin comes from the
     receipt's own fields, never parsed out of the sentence.

     At the left, the marks (2026-09-15): a swap shows the pair, the coin that
     left, a small swap arrow, the coin that arrived; a move shows the one coin
     it moved; a trade or a bot row shows its kind icon, because no single coin
     is the point of it. The slot is one fixed width so every sentence in a list
     starts on the same line. The five children and their order are the row's
     contract with the tests. */
  function row(receipt) {
    var node = dom.el('button', 'tx receipt-row');
    node.type = 'button';
    node.appendChild(dom.el('span', 'tx-logos'));
    node.appendChild(dom.el('span', 'tx-title', ''));
    node.appendChild(dom.el('span', 'tx-when', ''));
    node.appendChild(dom.el('span', 'tx-amount', ''));
    node.appendChild(dom.el('span', 'tx-sub', ''));
    return node;
  }

  /* What the left slot shows for a receipt, as one key so an update that changes
     nothing redraws nothing. */
  function marksKey(receipt) {
    var kind = String(receipt.kind || '');
    var symbol = receipt.symbol ? String(receipt.symbol) : '';
    var got = receipt.received && receipt.received.symbol ? String(receipt.received.symbol) : '';
    if (kind === 'trade' || kind === 'fill' || kind === 'bot' || kind === 'mandate_arm' || kind === 'policy_change') {
      return 'icon:' + kindOf(receipt).icon;
    }
    if (kind === 'swap' && symbol && got && got !== symbol) return 'pair:' + symbol + '>' + got;
    return symbol ? 'logo:' + symbol : 'icon:' + kindOf(receipt).icon;
  }

  function paintMarks(slot, key) {
    dom.clear(slot);
    var at = key.indexOf(':');
    var shape = key.slice(0, at);
    var rest = key.slice(at + 1);
    if (shape === 'pair') {
      var coins = rest.split('>');
      slot.appendChild(logo(coins[0], 24));
      slot.appendChild(icon('swap', 'tx-logos-arrow'));
      slot.appendChild(logo(coins[1], 24));
    } else if (shape === 'logo') {
      slot.appendChild(logo(rest, 24));
    } else {
      var disc = dom.el('span', 'tx-mark');
      disc.appendChild(icon(rest));
      slot.appendChild(disc);
    }
    dom.setAttr(slot, 'data-shape', shape);
  }

  function updateRow(node, receipt) {
    var slot = node.children[0];
    var title = node.children[1];
    var when = node.children[2];
    var amount = node.children[3];
    var sub = node.children[4];

    var symbol = receipt.symbol ? String(receipt.symbol) : '';
    var key = marksKey(receipt);
    if (slot.dataset.marks !== key) {
      slot.dataset.marks = key;
      paintMarks(slot, key);
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
       through, or that it is not confirmed, before it says when. "Did not go through" is
       said only over a row with no hash. */
    var done = receipt.status === 'executed';
    var nothing = nothingLeft(receipt);
    var note = dom.ago(receipt.at);
    if (unconfirmed(receipt)) note = 'Not confirmed';
    else if (receipt.status === 'failed' && receipt.refunded) note = refundedLine(receipt);
    else if (nothing) note = 'Did not go through';
    if (typeof receipt.feesUsd === 'number' && receipt.feesUsd > 0) note += ', ' + dom.fee(receipt.feesUsd) + ' in fees';
    dom.setText(when, note);
    dom.setAttr(when, 'class', done ? 'tx-when' : 'tx-when warn');

    /* Money that left is signed. A move that moved nothing shows its amount unsigned and
       quiet rather than a minus that was never taken; one the app cannot confirm shows it
       unsigned and plain, because that is the money in question. */
    var left = typeof receipt.amount === 'number';
    dom.setText(amount, left
      ? (done ? '-' : '') + dom.qty(receipt.amount) + (symbol ? ' ' + symbol : '')
      : '');
    /* A swap or a move between the person's own pockets changes what the money is, not
       how much of it there is, so what left reads in the text tone. Red is for money that
       left the wallet altogether. */
    var gone = receipt.kind === 'transfer' || receipt.kind === 'consolidate' || receipt.kind === 'send';
    dom.setAttr(amount, 'data-dir', left && done && gone ? 'out' : null);
    dom.setAttr(amount, 'class', left && nothing ? 'tx-amount dim' : 'tx-amount');

    /* What arrived, when the rail recorded it: the second leg of the statement line,
       signed plus and green. Only on a row that went through: nothing else shares this
       line, and nothing is green on a row the app cannot confirm. */
    var got = receipt.received;
    var arrived = done && got && typeof got.amount === 'number' && got.symbol;
    dom.setText(sub, arrived ? '+' + dom.qty(got.amount) + ' ' + String(got.symbol) : '');
    dom.setAttr(sub, 'data-dir', arrived ? 'in' : null);
  }

  window.PhosphorReceipt = {
    row: row,
    updateRow: updateRow,
    chainName: chainName,
    venueName: venueName,
    kindWord: kindWord,
    card: card,
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
