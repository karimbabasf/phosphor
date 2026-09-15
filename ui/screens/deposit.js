/* The deposit card: the one place in the window an address is drawn.

   It opens over any screen when the assistant's `deposit` tool asks, or when a
   row on the Vault tab or the Money in fold is clicked. Three checks run before
   the address is on screen, and any one failing draws nothing and says so:

     1. The wallet is open. `/api/intents-receive` says `verified` only once the
        enclave has opened the file in this session; before that the card has
        one button, which raises the Touch ID dialog.
     2. The QR is drawn and then read back from the pixels on the canvas, and
        the decoded string is compared to the address byte for byte.
     3. Copy writes the clipboard and reads it back before it says "Copied".

   The address never comes from the frame that opened the card. The frame says
   which watch is running; the address is fetched, and where the frame carries
   one too the two have to agree.

   Under the address the backend's watcher reports: watching, seen, landed. The
   watch outlives the card, so closing it stops nothing; only Stop does. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  /* The network in the words an exchange's withdraw screen uses. An address is
     only as safe as the network chosen on the other side, so the card says it
     the way that screen does. */
  var NETWORK_WORDS = {
    eth: 'Ethereum (ERC-20)',
    base: 'Base',
    arb: 'Arbitrum One',
    sol: 'Solana (SPL)',
    near: 'NEAR Protocol'
  };

  /* Four modules of quiet zone, which is what a reader needs to find the edge,
     and no fewer than three pixels a module: the decoder here reads the same
     pixels a phone will. */
  var QUIET = 4;
  var QR_TARGET_PX = 176;
  var MIN_SCALE = 3;

  var dialog = null;
  var refs = {};
  var current = null;
  var seenStart = null;
  var promptedFor = null;
  var tick = 0;

  function boot() {
    store.select('deposit', function (deposit) {
      renderWatcher(deposit);
      sayLanded(deposit);
      maybeBackupPrompt(deposit);
    });
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
    return NETWORK_WORDS[chain] || String(chain || '');
  }

  /* The asset an exchange most often sends. USDC where the network credits it,
     else the first thing it does credit. */
  function defaultSymbol(accepts) {
    var list = Array.isArray(accepts) ? accepts : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].symbol).toUpperCase() === 'USDC') return 'USDC';
    }
    return list.length && list[0] ? String(list[0].symbol) : '';
  }

  /* ---------- opening ---------- */

  /* The window asked: a row was clicked. The backend starts the watch and
     answers with it; the frame that follows carries the same startedAt and is
     ignored as already seen. */
  function open(options) {
    var opts = options || {};
    if (!opts.chain || !opts.symbol) return Promise.resolve(null);
    return api.depositShow(opts.chain, opts.symbol, opts.address || null)
      .then(function (answer) {
        if (!answer || answer.ok === false || !answer.deposit) {
          window.PhosphorToast.show((answer && answer.error) || 'The deposit card could not open.', 'down');
          return null;
        }
        show(answer.deposit);
        return answer.deposit;
      })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
        return null;
      });
  }

  /* The stream spoke. A watch this card has not seen begins on `watching` with a
     new startedAt, and that is the one frame that opens it. Every other frame
     is a change to a watch already on screen, or to one the person closed. */
  function onFrame(deposit) {
    if (!deposit || deposit.phase !== 'watching') return;
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
    stopTick();
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
    dom.clear(dialog);
    refs = {};

    var card = dom.el('div', 'confirm-card deposit-card');
    dialog.appendChild(card);

    var head = dom.el('div', 'between deposit-head');
    refs.title = dom.el('h2', 'title');
    head.appendChild(refs.title);
    var closeBtn = dom.el('button', 'btn btn-quiet btn-sm');
    closeBtn.type = 'button';
    closeBtn.appendChild(dom.el('span', 'btn-label', 'Close'));
    dom.on(closeBtn, 'click', close);
    head.appendChild(closeBtn);
    card.appendChild(head);

    refs.lead = dom.el('p', 'body dim');
    card.appendChild(refs.lead);

    refs.networks = dom.el('div', 'hstack-2 wrap deposit-assets');
    refs.networks.hidden = true;
    card.appendChild(refs.networks);

    refs.assets = dom.el('div', 'hstack-2 wrap deposit-assets');
    refs.assets.hidden = true;
    card.appendChild(refs.assets);

    refs.body = dom.el('div', 'stack deposit-body');
    card.appendChild(refs.body);

    refs.warning = dom.el('div', 'banner');
    refs.warning.dataset.tone = 'warn';
    refs.warning.hidden = true;
    refs.warningText = dom.el('span');
    refs.warning.appendChild(refs.warningText);
    card.appendChild(refs.warning);

    refs.note = dom.el('p', 'meta');
    refs.note.hidden = true;
    card.appendChild(refs.note);

    refs.watch = dom.el('div', 'deposit-watch');
    refs.watch.setAttribute('role', 'status');
    refs.watch.hidden = true;
    refs.watch.appendChild(dom.el('span', 'dot'));
    refs.watchText = dom.el('span', 'body deposit-watch-text');
    refs.watch.appendChild(refs.watchText);
    refs.stop = dom.el('button', 'btn btn-quiet btn-sm');
    refs.stop.type = 'button';
    refs.stop.appendChild(dom.el('span', 'btn-label', 'Stop watching'));
    dom.on(refs.stop, 'click', function () {
      window.PhosphorShell.setPending(refs.stop, true, 'Stopping');
      api.depositStop()
        .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(refs.stop, false); });
    });
    refs.watch.appendChild(refs.stop);
    card.appendChild(refs.watch);

    refs.backup = dom.el('div', 'deposit-backup');
    refs.backup.hidden = true;
    card.appendChild(refs.backup);
  }

  function skeleton(host) {
    dom.clear(host);
    var skel = dom.el('div', 'skel');
    skel.style.height = '120px';
    host.appendChild(skel);
  }

  /* Fetch, check, draw. */
  function fill() {
    var deposit = current;
    var words = networkWords(deposit.chain);
    dom.setText(refs.title, 'Deposit ' + deposit.symbol + ' on ' + words);
    dom.setText(refs.lead, 'On the sending side, choose the network "' + words + '".');
    skeleton(refs.body);
    /* The store may already hold a later phase of this watch; if it holds an
       older watch, the one that opened the card is the truth. */
    var live = store.get() ? store.get().deposit : null;
    renderWatcher(live && live.startedAt === deposit.startedAt ? live : deposit);

    api.intentsReceive()
      .then(function (result) {
        if (current !== deposit) return;
        draw(result.data || null);
      })
      .catch(function (err) {
        if (current !== deposit) return;
        refuse('The addresses could not be read. ' + net.readable(err));
      });
  }

  function draw(report) {
    var deposit = current;
    var networks = report && Array.isArray(report.networks) ? report.networks : [];
    var network = null;
    for (var i = 0; i < networks.length; i += 1) {
      if (networks[i] && networks[i].id === deposit.chain) network = networks[i];
    }

    if (report && report.tampered) {
      return refuse('The wallet file on this Mac has been edited, so no address in it can be trusted.');
    }
    if (!network) {
      return refuse('This wallet has no deposit address on ' + networkWords(deposit.chain) + (report && report.reason ? ': ' + report.reason : '.'));
    }

    /* The warning line is the report's own, word for word. */
    if (network.warning) {
      dom.setText(refs.warningText, network.warning);
      refs.warning.hidden = false;
    }
    if (report.note) {
      dom.setText(refs.note, report.note);
      refs.note.hidden = false;
    }
    renderNetworks(networks, network);
    renderAssets(network);

    var accepted = tokenOf(network, deposit.symbol);
    if (!accepted) {
      return refuse(deposit.symbol + ' is not credited on ' + networkWords(deposit.chain) + '. Sending it there loses it.');
    }
    var floor = accepted.minDepositHuman || '';
    var minimum = floor ? ' Minimum ' + floor + ' ' + accepted.symbol + '.' : '';
    dom.setText(refs.lead, 'On the sending side, choose the network "' + networkWords(deposit.chain) + '".' + minimum);

    if (network.unavailable) {
      return refuse('No deposit address on ' + networkWords(deposit.chain) + ' right now: ' + network.unavailable);
    }
    if (typeof network.address !== 'string' || !network.address.length) {
      return refuse('No deposit address on ' + networkWords(deposit.chain) + ' right now.');
    }

    /* Check 1: the wallet is open, so this address was derived from the keys and
       not read off an unauthenticated header. */
    if (report.verified !== true) {
      return askToOpen();
    }

    /* The frame that opened the card may carry an address of its own. If it
       does, it has to be this one. */
    if (typeof deposit.address === 'string' && deposit.address.length && !sameBytes(deposit.address, network.address)) {
      return refuse('The address the watcher holds is not the one this wallet reports. Nothing is shown.');
    }

    drawAddress(network);
  }

  function tokenOf(network, symbol) {
    var accepts = Array.isArray(network.accepts) ? network.accepts : [];
    for (var i = 0; i < accepts.length; i += 1) {
      if (accepts[i] && String(accepts[i].symbol).toUpperCase() === String(symbol).toUpperCase()) return accepts[i];
    }
    return null;
  }

  /* The three EVM networks share one wallet address and nothing else: each has
     its own bridge address and its own list of what it credits. A card opened
     from the EVM row lands on Ethereum and offers the other two here, in the
     exchange's words, so the network is chosen on this side before it is
     chosen on the sending side. */
  var EVM = ['eth', 'base', 'arb'];

  function renderNetworks(networks, network) {
    dom.clear(refs.networks);
    if (EVM.indexOf(network.id) < 0) {
      refs.networks.hidden = true;
      return;
    }
    var siblings = networks.filter(function (n) { return n && EVM.indexOf(n.id) >= 0; });
    if (siblings.length < 2) {
      refs.networks.hidden = true;
      return;
    }
    refs.networks.hidden = false;
    siblings.forEach(function (n) {
      var chip = dom.el('button', 'chip');
      chip.type = 'button';
      var here = n.id === network.id;
      chip.setAttribute('aria-pressed', here ? 'true' : 'false');
      if (here) chip.dataset.tone = 'ink';
      chip.appendChild(dom.el('span', '', networkWords(n.id)));
      chip.disabled = !here && (!!n.unavailable || !n.address);
      dom.on(chip, 'click', function () {
        if (here) return;
        var symbol = tokenOf(n, current.symbol) ? current.symbol : defaultSymbol(n.accepts);
        open({ chain: n.id, symbol: symbol, address: n.address });
      });
      refs.networks.appendChild(chip);
    });
  }

  /* The assets this network credits, as chips. The current one is pressed; any
     other starts a fresh watch for that asset, because the minimum and the
     watcher both follow the asset. */
  function renderAssets(network) {
    dom.clear(refs.assets);
    var accepts = Array.isArray(network.accepts) ? network.accepts : [];
    if (accepts.length < 2) {
      refs.assets.hidden = true;
      return;
    }
    refs.assets.hidden = false;
    accepts.forEach(function (token) {
      var chip = dom.el('button', 'chip');
      chip.type = 'button';
      var here = String(token.symbol).toUpperCase() === String(current.symbol).toUpperCase();
      chip.setAttribute('aria-pressed', here ? 'true' : 'false');
      if (here) chip.dataset.tone = 'ink';
      chip.appendChild(dom.el('span', '', token.symbol));
      dom.on(chip, 'click', function () {
        if (here) return;
        open({ chain: network.id, symbol: token.symbol, address: network.address });
      });
      refs.assets.appendChild(chip);
    });
  }

  /* Nothing drawn, and the reason in the address's place. */
  function refuse(why) {
    dom.clear(refs.body);
    var banner = dom.el('div', 'banner');
    banner.dataset.tone = 'down';
    banner.appendChild(dom.el('span', '', why));
    refs.body.appendChild(banner);
    refs.body.dataset.state = 'refused';
  }

  /* Check 1 failed: one button, the system dialog, then a fresh fetch. On a
     password wallet the lock screen is the way in and the card steps aside. */
  function askToOpen() {
    dom.clear(refs.body);
    refs.body.dataset.state = 'unverified';
    var state = store.get() || {};
    var vault = state.vault || {};
    var enclave = vault.custody === 'secure-enclave';

    refs.body.appendChild(dom.el('p', 'body', enclave
      ? 'The address is shown only once this Mac has opened the wallet, so it comes from your keys and not from a file anything could edit.'
      : 'The address is shown only once the wallet is unlocked, so it comes from your keys and not from a file anything could edit.'));

    var actions = dom.el('div', 'screen-actions');
    var button = dom.el('button', 'btn btn-primary');
    button.type = 'button';
    button.appendChild(dom.el('span', 'btn-label', enclave ? 'Touch ID to show the address' : 'Unlock to show the address'));
    actions.appendChild(button);
    refs.body.appendChild(actions);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    refs.body.appendChild(error);

    dom.on(button, 'click', function () {
      if (!enclave) {
        close();
        if (window.PhosphorLock) window.PhosphorLock.focus();
        return;
      }
      error.hidden = true;
      window.PhosphorShell.setPending(button, true, 'Waiting for Touch ID');
      api.vaultUnlock('address')
        .then(function (answer) {
          if (answer && answer.ok === false) {
            if (answer.code !== 'user_cancel') {
              dom.setText(error, answer.error || 'That did not work.');
              error.hidden = false;
            }
            return;
          }
          window.PhosphorShell.refresh({});
          fill();
        })
        .catch(function (err) {
          dom.setText(error, net.readable(err));
          error.hidden = false;
        })
        .finally(function () {
          window.PhosphorShell.setPending(button, false);
        });
    });
  }

  /* Checks 2 and 3, then the address. The canvas is drawn into a detached
     block, read back, and only appended once the read-back agrees, so a person
     never sees a code that did not pass. */
  function drawAddress(network) {
    var address = network.address;
    dom.clear(refs.body);

    var qr = dom.el('div', 'qr deposit-qr');
    var canvas = dom.el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR code of the deposit address');
    qr.appendChild(canvas);

    var check = drawChecked(canvas, address);
    if (!check.ok) {
      refuse('Nothing is shown: ' + check.why + ' Close this and open it again. If it happens twice, do not send money until it is fixed.');
      return;
    }

    refs.body.dataset.state = 'shown';
    refs.body.appendChild(qr);
    refs.body.appendChild(addressBlock(address));

    if (network.memo) {
      var memo = dom.el('div', 'facts');
      var row = dom.el('div', 'fact');
      row.appendChild(dom.el('span', 'label', 'Memo, required'));
      row.appendChild(dom.el('span', 'body mono', network.memo));
      memo.appendChild(row);
      refs.body.appendChild(memo);
    }

    var tools = dom.el('div', 'hstack-2 wrap');
    var copy = dom.el('button', 'btn btn-ghost');
    copy.type = 'button';
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    var said = dom.el('span', 'meta deposit-copied');
    said.setAttribute('role', 'status');
    tools.appendChild(copy);
    tools.appendChild(said);
    refs.body.appendChild(tools);

    dom.on(copy, 'click', function () {
      copy.disabled = true;
      copyChecked(address, function (sentence) { dom.setText(said, sentence); })
        .finally(function () { copy.disabled = false; });
    });
  }

  /* Groups of four. The first four and the last four are the ones a person
     checks against the sending screen, so they are the ones set large, and they
     are always exactly four: a length that does not divide leaves its remainder
     in the group before the last, never in the ends. The whole string is there
     for a screen reader in one piece. */
  function addressBlock(address) {
    var block = dom.el('div', 'deposit-address mono');
    var whole = dom.el('span', 'sr-only', address);
    block.appendChild(whole);
    var parts = chunks(address);
    var shown = dom.el('span', 'deposit-chunks');
    shown.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < parts.length; i += 1) {
      var end = i === 0 || i === parts.length - 1;
      shown.appendChild(dom.el('span', end ? 'addr-end' : 'addr-mid', parts[i]));
    }
    block.appendChild(shown);
    return block;
  }

  function chunks(address) {
    var text = String(address);
    if (text.length <= 8) return text.length > 4 ? [text.slice(0, 4), text.slice(4)] : [text];
    var out = [text.slice(0, 4)];
    var middle = text.slice(4, -4);
    for (var i = 0; i < middle.length; i += 4) out.push(middle.slice(i, i + 4));
    out.push(text.slice(-4));
    return out;
  }

  /* Byte for byte. Two strings that print the same and differ in one code
     unit are two different addresses. */
  function sameBytes(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
    }
    return true;
  }

  function tail(address) {
    return String(address).slice(-4);
  }

  /* Dark modules on a light quiet zone, which is the way round the QR standard
     specifies and the one every scanner reads. Then check 2: the pixels are
     read back off the same canvas and decoded, and the string has to be the
     address. Anything short of that is a refusal with a reason. */
  function drawChecked(canvas, address) {
    if (typeof window.qrcode !== 'function') return { ok: false, why: 'The QR encoder did not load.' };
    if (typeof window.jsQR !== 'function') return { ok: false, why: 'The QR checker did not load.' };

    var code;
    try {
      code = window.qrcode(0, 'M');
      code.addData(address);
      code.make();
    } catch (err) {
      return { ok: false, why: 'The address could not be encoded.' };
    }

    var count = code.getModuleCount();
    var total = count + QUIET * 2;
    var scale = Math.max(MIN_SCALE, Math.floor(QR_TARGET_PX / total));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = total * scale;

    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, why: 'This window cannot draw a QR code.' };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (!code.isDark(row, col)) continue;
        ctx.fillRect((col + QUIET) * scale, (row + QUIET) * scale, scale, scale);
      }
    }

    var image;
    try {
      image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return { ok: false, why: 'The drawn code could not be read back.' };
    }
    var decoded = null;
    try {
      decoded = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    } catch (err) {
      decoded = null;
    }
    if (!decoded || typeof decoded.data !== 'string') return { ok: false, why: 'The QR code did not read back at all.' };
    if (!sameBytes(decoded.data, address)) return { ok: false, why: 'The QR code read back as a different address.' };
    return { ok: true };
  }

  /* Check 3. Write, read back, and say what was found. A clipboard that cannot
     be read back is said to be that, with the last four characters to check by
     hand, rather than reported as copied. */
  function copyChecked(address, say) {
    var clip = navigator.clipboard;
    if (!clip || typeof clip.writeText !== 'function') {
      say('This window cannot reach the clipboard. Read the address from the screen.');
      return Promise.resolve(false);
    }
    var unread = 'Copied, but the clipboard could not be read back. Check it ends in ...' + tail(address) + ' before you send.';
    return clip.writeText(address)
      .then(function () {
        if (typeof clip.readText !== 'function') {
          say(unread);
          return false;
        }
        return clip.readText().then(function (back) {
          if (sameBytes(back, address)) {
            say('Copied, ends in ...' + tail(address));
            return true;
          }
          say('The clipboard does not hold the address: something else is in it. Copy again, or read it from the screen.');
          return false;
        }, function () {
          say(unread);
          return false;
        });
      })
      .catch(function () {
        say('The copy did not work. Read the address from the screen.');
        return false;
      });
  }

  /* ---------- the watcher ---------- */

  function renderWatcher(deposit) {
    if (!refs.watch || !current) return;
    if (!deposit || deposit.startedAt !== current.startedAt) {
      refs.watch.hidden = true;
      stopTick();
      return;
    }
    refs.watch.hidden = false;
    refs.watch.dataset.phase = deposit.phase;
    var symbol = deposit.symbol || current.symbol;
    var text = '';
    if (deposit.phase === 'watching') {
      text = 'Watching for your deposit, ' + elapsed(deposit.startedAt);
      startTick();
    } else if (deposit.phase === 'seen') {
      text = 'Seen on ' + networkWords(deposit.chain) + ': '
        + (typeof deposit.amount === 'number' ? dom.qty(deposit.amount) + ' ' + symbol : 'a deposit') + ', confirming';
      stopTick();
    } else if (deposit.phase === 'landed') {
      text = landedWords(Object.assign({}, deposit, { symbol: symbol }));
      stopTick();
    } else {
      text = 'Stopped watching.';
      stopTick();
    }
    dom.setText(refs.watchText, text);
    dom.setHidden(refs.stop, deposit.phase !== 'watching' && deposit.phase !== 'seen');
  }

  function elapsed(startedAt) {
    var then = new Date(startedAt).getTime();
    if (!isFinite(then)) return '0:00';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function startTick() {
    if (tick) return;
    tick = window.setInterval(function () {
      var state = store.get() || {};
      renderWatcher(state.deposit || null);
    }, 1000);
  }

  function stopTick() {
    if (!tick) return;
    window.clearInterval(tick);
    tick = 0;
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
    if (window.PhosphorDecision && typeof window.PhosphorDecision.showCard === 'function') {
      window.PhosphorDecision.showCard(function (host, done) {
        dom.clear(host);
        buildBackup(host, done);
      });
    }
  }

  function buildBackup(host, done) {
    dom.clear(host);
    host.appendChild(dom.el('h2', 'title', 'You have money in. Back up now.'));
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
    networkWords: networkWords,
    defaultSymbol: defaultSymbol,
    chunks: chunks,
    drawChecked: drawChecked,
    copyChecked: copyChecked,
    sameBytes: sameBytes
  };
})();
