/* The deposit card: the dialog that holds the three steps of money in when
   they are asked for from somewhere other than the Money in fold.

   It opens over any screen when the assistant's `deposit` tool asks, or when
   the Vault tab's Addresses card or the assistant panel hands over a network.
   What it draws is ui/screens/netpick.js, the same component the Money in
   fold runs in place, opened at the address step for the network the caller
   named, or at the token list when the acknowledgement has not been given on
   this Mac yet. The three checks (the wallet is open, the QR reads back as the
   same bytes, the clipboard reads back what was written) live there now and
   run wherever an address is drawn.

   The address never comes from the frame that opened the card. The frame says
   which watch is running; the address is fetched, and where the frame carries
   one too the two have to agree.

   The watch outlives the card, so closing it stops nothing; only Stop does.
   Money that lands after the card was put away is still said once, as a
   toast, and the first landed deposit on a wallet that is not backed up
   raises the backup card. Both of those live here, with the dialog. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var dialog = null;
  var refs = {};
  var view = null;
  var current = null;
  var seenStart = null;
  var promptedFor = null;
  var absorbing = 0;

  function pick() {
    return window.PhosphorNetPick;
  }

  function boot() {
    store.select('deposit', function (deposit) {
      sayLanded(deposit);
      maybeBackupPrompt(deposit);
    });
    store.subscribe(maybeBootPrompt);
  }

  /* The watch outlives the card. Money that lands after the card was put away
     is still worth a line, once, wherever the person is. */
  var toastedFor = null;

  function sayLanded(deposit) {
    if (!deposit || deposit.phase !== 'landed') return;
    if (isOpen() && current && current.startedAt === deposit.startedAt) return;
    if (toastedFor === deposit.startedAt) return;
    toastedFor = deposit.startedAt;
    if (window.PhosphorToast) window.PhosphorToast.show(landedWords(deposit), 'up');
  }

  function landedWords(deposit) {
    var symbol = deposit.symbol || '';
    return 'Landed: ' + (typeof deposit.amount === 'number' ? dom.qty(deposit.amount) + ' ' + symbol : symbol)
      + (typeof deposit.ms === 'number' ? ' in ' + Math.max(1, Math.round(deposit.ms / 1000)) + ' s' : '');
  }

  function networkWords(chain) {
    return pick().words(chain);
  }

  function defaultSymbol(accepts) {
    return pick().defaultSymbol(accepts);
  }

  /* ---------- the watch ---------- */

  /* One place the window starts a watch. The backend answers with the watch
     and also broadcasts it, and the broadcast can land before the answer: any
     `watching` frame that arrives while a start is in flight is this one, so it
     is marked seen instead of opening a second card over the first. */
  function startWatch(chain, symbol, address) {
    absorbing += 1;
    return api.depositShow(chain, symbol, address || null)
      .then(function (answer) {
        if (!answer || answer.ok === false || !answer.deposit) {
          throw new Error((answer && answer.error) || 'The deposit card could not open.');
        }
        seenStart = answer.deposit.startedAt || seenStart;
        if (isOpen()) current = answer.deposit;
        return answer.deposit;
      })
      .finally(function () { absorbing -= 1; });
  }

  /* ---------- opening ---------- */

  /* The window asked: a network was handed over. The backend starts the
     watch and answers with it, and the card opens on it. */
  function open(options) {
    var opts = options || {};
    if (!opts.chain || !opts.symbol) return Promise.resolve(null);
    return startWatch(opts.chain, opts.symbol, opts.address || null)
      .then(function (deposit) {
        show(deposit);
        return deposit;
      })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
        return null;
      });
  }

  /* The stream spoke. A watch this card has not seen begins on `watching` with
     a new startedAt, and that is the one frame that opens it. Every other
     frame is a change to a watch already on screen, or to one the person
     closed, or the echo of a start this window made itself. */
  function onFrame(deposit) {
    if (!deposit || deposit.phase !== 'watching') return;
    if (absorbing > 0) {
      seenStart = deposit.startedAt || seenStart;
      return;
    }
    if (deposit.startedAt && deposit.startedAt === seenStart) return;
    show(deposit);
  }

  function show(deposit) {
    seenStart = deposit.startedAt || null;
    current = deposit;
    build();
    if (!dialog.open) dialog.showModal();
    fill();
  }

  function close() {
    if (dialog && dialog.open) dialog.close();
  }

  function isOpen() {
    return !!(dialog && dialog.open);
  }

  /* ---------- the card ---------- */

  function build() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'confirm deposit-dialog';
      dialog.setAttribute('aria-label', 'Deposit');
      document.body.appendChild(dialog);
      /* Escape and a click on the backdrop close the card. Neither stops the
         watch: a person who put the card away still wants to hear the money
         landed. */
      dom.on(dialog, 'cancel', function (event) {
        event.preventDefault();
        close();
      });
      dom.on(dialog, 'click', function (event) {
        if (event.target === dialog) close();
      });
    }
    if (view) {
      view.destroy();
      view = null;
    }
    dom.clear(dialog);
    refs = {};

    var card = dom.el('div', 'confirm-card deposit-card');
    dialog.appendChild(card);

    var head = dom.el('div', 'between deposit-head');
    refs.title = dom.el('h2', 'title', 'Deposit');
    head.appendChild(refs.title);
    var closeBtn = dom.el('button', 'btn btn-quiet btn-sm');
    closeBtn.type = 'button';
    closeBtn.appendChild(dom.el('span', 'btn-label', 'Close'));
    dom.on(closeBtn, 'click', close);
    head.appendChild(closeBtn);
    card.appendChild(head);

    refs.body = dom.el('div', 'deposit-host');
    card.appendChild(refs.body);

    refs.backup = dom.el('div', 'deposit-backup');
    refs.backup.hidden = true;
    card.appendChild(refs.backup);
  }

  /* The component, opened on the watch's network at the address step. With no
     acknowledgement on this Mac yet it opens on that network's token list and
     the address is one tick and one click away. */
  function fill() {
    var deposit = current;
    view = pick().render(refs.body, {
      context: 'card',
      stage: 'address',
      network: deposit.chain,
      symbol: deposit.symbol,
      deposit: deposit,
      onDismiss: close
    });
  }

  /* ---------- the backup card ---------- */

  /* The first landed deposit on a wallet whose phrase has not been typed back
     is the moment there is something to lose. Once per watch, never again for
     the same one, and where the person is: inside this card while it is open,
     on the dock when it is not. */
  function maybeBackupPrompt(deposit) {
    if (!deposit || deposit.phase !== 'landed') return;
    var state = store.get() || {};
    var vault = state.vault || {};
    if (vault.backedUp !== false) return;
    if (promptedFor === deposit.startedAt) return;
    promptedFor = deposit.startedAt;

    if (isOpen() && current && current.startedAt === deposit.startedAt && refs.backup) {
      refs.backup.hidden = false;
      buildBackup(refs.backup, close);
      return;
    }
    showBackupCard();
  }

  /* And once per app start, the moment the window knows there is money in
     and the phrase is not proven: the same card, with an X. Karim,
     2026-09-16: "as a user I want this to pop up every time i start the app,
     but I want to be able to x it out." The X puts it away until the next
     start; only typing the words back clears it for good. */
  var booted = false;

  function maybeBootPrompt() {
    if (booted) return;
    if (typeof store.loaded === 'function' && !store.loaded()) return;
    var state = store.get() || {};
    var vault = state.vault || {};
    if (vault.backedUp !== false) return;
    var basic = state.basic || {};
    var total = typeof basic.totalUsd === 'number' && isFinite(basic.totalUsd) ? basic.totalUsd : null;
    if (total === null || total < 0.01) return;
    /* A request waiting on the person outranks a reminder: the dock shows one
       thing, and the one that stops money moving is the one it shows. */
    var proposals = Array.isArray(state.proposals) ? state.proposals : [];
    for (var i = 0; i < proposals.length; i += 1) {
      var p = proposals[i];
      if (p && (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch')) return;
    }
    booted = true;
    showBackupCard();
  }

  function showBackupCard() {
    if (window.PhosphorDecision && typeof window.PhosphorDecision.showCard === 'function') {
      window.PhosphorDecision.showCard(function (host, done) {
        dom.clear(host);
        buildBackup(host, done);
      });
    }
  }

  function buildBackup(host, done) {
    dom.clear(host);
    var head = dom.el('div', 'dock-head');
    head.appendChild(dom.el('h2', 'title', 'You have money in. Back up now.'));
    var away = dom.el('button', 'dock-close');
    away.type = 'button';
    away.setAttribute('aria-label', 'Not now');
    away.title = 'Not now';
    var icons = window.PhosphorIcons;
    away.appendChild(icons && typeof icons.svg === 'function' ? icons.svg('close') : dom.el('span', 'sr-only', 'Not now'));
    dom.on(away, 'click', function () { done(); });
    head.appendChild(away);
    host.appendChild(head);
    host.appendChild(dom.el('p', 'body dim', 'Your recovery phrase is the only way back to this wallet. Reveal it once, write it down, and type three words back to prove it.'));
    var actions = dom.el('div', 'screen-actions');
    var go = dom.el('button', 'btn btn-primary');
    go.type = 'button';
    go.appendChild(dom.el('span', 'btn-label', 'Back up now'));
    actions.appendChild(go);
    host.appendChild(actions);
    dom.on(go, 'click', function () {
      done();
      if (window.PhosphorVault && typeof window.PhosphorVault.startReveal === 'function') {
        window.PhosphorVault.startReveal();
      }
    });
    go.focus();
  }

  window.PhosphorDeposit = {
    boot: boot,
    open: open,
    onFrame: onFrame,
    close: close,
    isOpen: isOpen,
    startWatch: startWatch,
    networkWords: networkWords,
    defaultSymbol: defaultSymbol,
    chunks: function (address, kind) { return pick().chunks(address, kind); },
    drawChecked: function (canvas, address) { return pick().drawChecked(canvas, address); },
    copyChecked: function (address, say) { return pick().copyChecked(address, say); },
    sameBytes: function (a, b) { return pick().sameBytes(a, b); }
  };
})();
