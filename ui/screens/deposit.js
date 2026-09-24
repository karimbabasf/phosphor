/* The deposit card: the dialog that holds the three steps of money in when a
   screen hands over a network, which today is the Vault tab's Addresses card
   (and the chat's deposit card, until it draws the address itself).

   What it draws is ui/screens/netpick.js, the same component the Money in
   fold runs in place, opened at the address step for the network the caller
   named, or at the token list when the acknowledgement has not been given on
   this Mac yet. The three checks (the wallet is open, the QR reads back as the
   same bytes, the clipboard reads back what was written) live there and run
   wherever an address is drawn.

   It never opens on its own. The assistant's `deposit` tool used to open it
   over the conversation with no click, while the thread drew a second card
   for the same watch: two surfaces for one answer, one of them covering the
   chat (hunt-b 18). A watch the agent starts is the chat's to show.

   The address never comes from the watch. The watch says which network is
   being watched; the address is fetched, and where the watch carries one too
   the two have to agree.

   The watch outlives the card, so closing it stops nothing, and the watch
   ends on its own. Money that lands after the card was put away is still
   said once, as a toast, and the first landed deposit on a wallet that is not
   backed up raises the backup card. Both of those live here, with the
   dialog. */
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
  var promptedFor = null;

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
    if (!deposit || deposit.phase !== 'credited') return;
    if (isOpen() && current && current.startedAt === deposit.startedAt) return;
    if (toastedFor === deposit.startedAt) return;
    toastedFor = deposit.startedAt;
    if (window.PhosphorToast) window.PhosphorToast.show(landedWords(deposit), 'up');
  }

  /* The same words the watcher line ends on, so a deposit reads the same in
     the toast as on the card: what arrived, and where it is now. */
  function landedWords(deposit) {
    var symbol = deposit.symbol || '';
    var what = typeof deposit.amount === 'number' && deposit.amount > 0 ? dom.qty(deposit.amount) + (symbol ? ' ' + symbol : '') : (symbol || 'Your deposit');
    return what + ' is in your balance';
  }

  function networkWords(chain) {
    return pick().words(chain);
  }

  function defaultSymbol(accepts) {
    return pick().defaultSymbol(accepts);
  }

  /* ---------- the watch ---------- */

  /* One place the window starts a watch. The backend answers with the watch
     and also broadcasts it; the card that asked keeps the answer. */
  function startWatch(chain, symbol, address) {
    return api.depositShow(chain, symbol, address || null)
      .then(function (answer) {
        if (!answer || answer.ok === false || !answer.deposit) {
          throw new Error((answer && answer.error) || 'The deposit card could not open.');
        }
        if (isOpen()) current = answer.deposit;
        return answer.deposit;
      });
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

  /* The stream spoke. A frame never opens the card: the card shows a watch a
     person asked for, and the picker inside it follows the store's `deposit`
     slice on its own (netpick.js followWatch). A frame for the watch on
     screen only keeps `current` up to date for the toast and the backup card. */
  function onFrame(deposit) {
    if (!deposit || !isOpen() || !current) return;
    if (deposit.startedAt && deposit.startedAt === current.startedAt) current = deposit;
  }

  function show(deposit) {
    current = deposit;
    build();
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.openDialog === 'function') motion.openDialog(dialog);
    else if (!dialog.open) dialog.showModal();
    fill();
    /* The card opens on its title, not on Close: the loudest thing on a card
       the person just asked for should be what it says. */
    if (refs.title && typeof refs.title.focus === 'function') refs.title.focus({ preventScroll: true });
  }

  /* The card and its scrim go out together before the dialog closes
     (ui/design/motion.js). */
  function close() {
    if (!dialog || !dialog.open) return;
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.closeDialog === 'function') motion.closeDialog(dialog);
    else dialog.close();
  }

  function isOpen() {
    return !!(dialog && dialog.open);
  }

  /* ---------- the card ---------- */

  function build() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'confirm deposit-dialog';
      dialog.setAttribute('data-motion', 'dialog');
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

    /* The card's title is the step's own ("Send on Solana only."), with the
       network's mark, so the network is named once and the picker inside
       keeps only its way back (deposit.css). */
    var head = dom.el('div', 'deposit-head');
    refs.title = dom.el('h2', 'deposit-title');
    refs.title.setAttribute('tabindex', '-1');
    refs.titleMark = dom.el('span', 'deposit-title-mark');
    refs.titleText = dom.el('span', 'deposit-title-text', 'Add money');
    refs.title.appendChild(refs.titleMark);
    refs.title.appendChild(refs.titleText);
    head.appendChild(refs.title);
    var closeBtn = dom.el('button', 'btn btn-quiet btn-sm');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') closeBtn.appendChild(icons.svg('close', 'deposit-close-icon'));
    closeBtn.appendChild(dom.el('span', 'sr-only', 'Close'));
    dom.on(closeBtn, 'click', close);
    head.appendChild(closeBtn);
    card.appendChild(head);
    dialog.setAttribute('aria-labelledby', 'deposit-title');
    refs.title.id = 'deposit-title';

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
      onDismiss: close,
      onStage: title
    });
  }

  /* The title follows the step the picker is on. */
  function title(stage, network) {
    if (!refs.titleText) return;
    var netpick = pick();
    var name = network && netpick ? netpick.name(network) : '';
    var words = 'Add money';
    if (stage === 'tokens' && name) words = 'What you can send on ' + name;
    else if (stage === 'address' && name) words = 'Send on ' + name + ' only.';
    dom.setText(refs.titleText, words);
    dom.clear(refs.titleMark);
    var n = network && netpick && typeof netpick.networkOf === 'function' ? netpick.networkOf(network) : null;
    var marks = window.PhosphorMarks;
    if (stage !== 'network' && n && marks && typeof marks.logo === 'function') refs.titleMark.appendChild(marks.logo(n.mark, 22));
  }

  /* ---------- the backup card ---------- */

  /* The first landed deposit on a wallet whose phrase has not been typed back
     is the moment there is something to lose. Once per watch, never again for
     the same one, and where the person is: inside this card while it is open,
     on the dock when it is not. */
  function maybeBackupPrompt(deposit) {
    if (!deposit || deposit.phase !== 'credited') return;
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
    /* The frame's notice (#notice, shell.js) says "not backed up" at the foot of the window for
       as long as it is true; the same line in the thread would say it twice, and two nudges for
       one thing is the anxiety this app is built against (lead, 2026-09-23). */
    if (typeof document.getElementById === 'function' && document.getElementById('notice')) return;
    booted = true;
    showBackupCard();
  }

  function showBackupCard() {
    if (window.PhosphorDecision && typeof window.PhosphorDecision.showCard === 'function') {
      window.PhosphorDecision.showCard(buildBackupLine, { quiet: true });
    }
  }

  /* In the thread the reminder is one quiet line in the balances panel's own words, with the
     way to do it and an X that puts it away until the next start. The panel's foot says the
     same thing, so this never shouts over it, and green stays the waiting move's and its
     Approve's. */
  function buildBackupLine(host, done) {
    dom.clear(host);
    var line = dom.el('div', 'chat-sheet-line');
    line.appendChild(dom.el('span', 'chat-sheet-words', 'Your recovery phrase is not backed up yet.'));
    var go = dom.el('button', 'btn btn-quiet btn-sm chat-sheet-go');
    go.type = 'button';
    go.appendChild(dom.el('span', 'btn-label', 'Back it up'));
    line.appendChild(go);
    var away = dom.el('button', 'dock-close');
    away.type = 'button';
    away.setAttribute('aria-label', 'Not now');
    away.title = 'Not now';
    var icons = window.PhosphorIcons;
    away.appendChild(icons && typeof icons.svg === 'function' ? icons.svg('close') : dom.el('span', 'sr-only', 'Not now'));
    line.appendChild(away);
    host.appendChild(line);
    dom.on(away, 'click', function () { done(); });
    dom.on(go, 'click', function () {
      done();
      if (window.PhosphorVault && typeof window.PhosphorVault.startReveal === 'function') {
        window.PhosphorVault.startReveal();
      }
    });
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
    var go = dom.el('button', 'btn');
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
