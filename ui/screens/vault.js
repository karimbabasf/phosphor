/* The Vault tab: who holds the key, where money arrives, and the phrase.

   Six panels, top to bottom: Custody, Addresses, Recovery, Agent, Window,
   Danger. Everything here reads off the state's `vault` slice and the two
   address routes; nothing here draws a key. The one secret that ever reaches
   this screen is the recovery phrase, shown once behind a fresh Touch ID, held
   in this file's memory until Done, and wiped the moment the window locks or
   the person leaves the tab.

   The migration card lives here too: the boot-time offer to move a password
   wallet behind the Secure Enclave, and the same form behind the Custody
   panel's button. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var IDLE_CHOICES = [5, 15, 60];
  var PROVE_COUNT = 3;

  var refs = {};
  var mounted = false;
  var visible = false;
  var lastVerifiedKey = null;
  var addresses = null;
  var phrase = null;
  var migrateOffered = false;

  /* ---------- boot ---------- */

  function boot() {
    var host = document.getElementById('view-vault');
    if (!host) return;
    build(host);
    mounted = true;
    store.select('vault', render);
    store.select('lock', function () {
      render();
      /* A locked window is not a place for the phrase. */
      var state = store.get() || {};
      if (state.lock && state.lock.state !== 'unlocked') wipePhrase();
    });
    store.select('policy', renderAgent);
    window.addEventListener('phosphor:view', function (event) {
      var view = event && event.detail ? event.detail.view : null;
      visible = view === 'vault';
      if (visible) loadAddresses();
      else wipePhrase();
    });
    render();
  }

  /* ---------- the column ---------- */

  function panel(title, surface) {
    var node = dom.el('section', 'panel');
    node.dataset.surface = surface;
    var head = dom.el('div', 'panel-head');
    var heading = dom.el('div', 'panel-heading');
    heading.appendChild(dom.el('span', 'title-sm', title));
    head.appendChild(heading);
    var right = dom.el('div', 'panel-head-right');
    head.appendChild(right);
    node.appendChild(head);
    var body = dom.el('div', 'panel-body stack');
    node.appendChild(body);
    return { node: node, body: body, right: right };
  }

  function button(label, kind) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    return node;
  }

  function chip(text, tone) {
    var node = dom.el('span', 'chip');
    if (tone) node.dataset.tone = tone;
    node.appendChild(dom.el('span', 'dot'));
    node.appendChild(dom.el('span', '', text));
    return node;
  }

  function build(host) {
    var col = dom.el('div', 'basic-col vault-col');

    /* Custody */
    var custody = panel('Custody', 'custody');
    refs.custodyChip = chip('', null);
    custody.right.appendChild(refs.custodyChip);
    refs.custodyTitle = dom.el('p', 'body strong');
    refs.custodyMade = dom.el('p', 'meta');
    refs.custodyOpens = dom.el('p', 'body dim');
    refs.custodyBinding = dom.el('p', 'meta warn');
    refs.custodyBinding.hidden = true;
    refs.custodyReason = dom.el('p', 'body dim');
    refs.custodyReason.hidden = true;
    refs.custodyReach = dom.el('div', 'banner');
    refs.custodyReach.dataset.tone = 'warn';
    refs.custodyReach.hidden = true;
    refs.custodyReachText = dom.el('span');
    refs.custodyReach.appendChild(refs.custodyReachText);
    var custodyActions = dom.el('div', 'hstack-2 wrap');
    refs.migrate = button('Move behind the Secure Enclave', 'btn-primary');
    refs.migrate.hidden = true;
    custodyActions.appendChild(refs.migrate);
    custody.body.appendChild(refs.custodyTitle);
    custody.body.appendChild(refs.custodyMade);
    custody.body.appendChild(refs.custodyOpens);
    custody.body.appendChild(refs.custodyBinding);
    custody.body.appendChild(refs.custodyReason);
    custody.body.appendChild(refs.custodyReach);
    custody.body.appendChild(custodyActions);
    dom.on(refs.migrate, 'click', function () { openMigrate(false); });
    col.appendChild(custody.node);

    /* Addresses */
    var addr = panel('Addresses', 'addresses');
    refs.addressList = dom.el('div', 'stack-2 vault-addresses');
    addr.body.appendChild(refs.addressList);
    refs.addressNote = dom.el('p', 'meta');
    dom.setText(refs.addressNote, 'Show QR opens the deposit card: the address to send money to on that network, checked before it is drawn.');
    addr.body.appendChild(refs.addressNote);
    col.appendChild(addr.node);

    /* Recovery */
    var recovery = panel('Recovery', 'recovery');
    refs.recoveryPanel = recovery.node;
    refs.backupChip = chip('', null);
    recovery.right.appendChild(refs.backupChip);
    refs.backupLine = dom.el('p', 'body');
    recovery.body.appendChild(refs.backupLine);
    refs.recoveryHelp = dom.el('p', 'meta');
    recovery.body.appendChild(refs.recoveryHelp);
    var recoveryActions = dom.el('div', 'hstack-2 wrap');
    refs.reveal = button('Reveal recovery phrase', 'btn-primary');
    refs.restore = button('Restore from a phrase', 'btn-ghost');
    recoveryActions.appendChild(refs.reveal);
    recoveryActions.appendChild(refs.restore);
    recovery.body.appendChild(recoveryActions);
    refs.recoveryFlow = dom.el('div', 'stack vault-flow');
    refs.recoveryFlow.hidden = true;
    recovery.body.appendChild(refs.recoveryFlow);
    dom.on(refs.reveal, 'click', startReveal);
    dom.on(refs.restore, 'click', startRestore);
    col.appendChild(recovery.node);

    /* Agent */
    var agent = panel('Agent', 'agent');
    var facts = dom.el('div', 'facts');
    facts.appendChild(fact('It can see', 'your addresses, your balances, and every request it has made.'));
    facts.appendChild(fact('It cannot see', 'your keys or your recovery phrase. Neither ever leaves this window.'));
    agent.body.appendChild(facts);
    refs.agentLine = dom.el('p', 'body dim');
    agent.body.appendChild(refs.agentLine);
    var agentActions = dom.el('div', 'hstack-2');
    var rules = button('Your rules', 'btn-quiet');
    agentActions.appendChild(rules);
    agent.body.appendChild(agentActions);
    dom.on(rules, 'click', function () {
      window.PhosphorShell.setView('basic', { fromClick: true });
    });
    col.appendChild(agent.node);

    /* Window */
    var win = panel('Window', 'window');
    win.body.appendChild(dom.el('p', 'body', 'Frost the window after'));
    refs.idleRow = dom.el('div', 'hstack-2 wrap');
    refs.idleChips = {};
    IDLE_CHOICES.forEach(function (minutes) {
      var c = dom.el('button', 'chip');
      c.type = 'button';
      c.setAttribute('aria-pressed', 'false');
      c.appendChild(dom.el('span', '', minutes + ' minutes'));
      dom.on(c, 'click', function () { setIdle(minutes, c); });
      refs.idleChips[minutes] = c;
      refs.idleRow.appendChild(c);
    });
    win.body.appendChild(refs.idleRow);
    win.body.appendChild(dom.el('p', 'meta', 'Frost hides the window until you unlock it again. It never affects signing: every move still needs its own click.'));
    col.appendChild(win.node);

    /* Danger */
    var danger = panel('Danger', 'danger');
    danger.body.appendChild(dom.el('p', 'body dim', 'Forget this wallet on this Mac. The file is shredded. Your recovery phrase brings the wallet back, here or on any Mac, so this is refused until the phrase is proven backed up.'));
    var forgetField = dom.el('div', 'field');
    forgetField.appendChild(dom.el('label', 'label', 'Type FORGET to confirm'));
    refs.forgetInput = dom.el('input', 'input');
    refs.forgetInput.type = 'text';
    refs.forgetInput.name = 'forget';
    refs.forgetInput.autocomplete = 'off';
    refs.forgetInput.spellcheck = false;
    refs.forgetInput.setAttribute('autocapitalize', 'characters');
    forgetField.appendChild(refs.forgetInput);
    danger.body.appendChild(forgetField);
    refs.forgetError = dom.el('p', 'body down');
    refs.forgetError.hidden = true;
    danger.body.appendChild(refs.forgetError);
    var dangerActions = dom.el('div', 'hstack-2');
    refs.forget = button('Forget this wallet', 'btn-danger');
    refs.forget.disabled = true;
    dangerActions.appendChild(refs.forget);
    danger.body.appendChild(dangerActions);
    dom.on(refs.forgetInput, 'input', function () {
      refs.forget.disabled = refs.forgetInput.value.trim() !== 'FORGET';
    });
    dom.on(refs.forget, 'click', forgetWallet);
    col.appendChild(danger.node);

    host.appendChild(col);
  }

  function fact(label, value) {
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body', value));
    return row;
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    var vault = state.vault || {};
    renderCustody(vault);
    renderRecovery(vault);
    renderAgent(state.policy);
    renderIdle(vault);
    var verifiedKey = (vault.state || '') + ':' + (vault.custody || '');
    if (visible && verifiedKey !== lastVerifiedKey) loadAddresses();
    lastVerifiedKey = verifiedKey;
    offerMigration(state);
  }

  function dateWords(iso) {
    if (!iso) return '';
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderCustody(vault) {
    var enclave = vault.enclave || {};
    var custody = vault.custody;

    if (custody === 'secure-enclave') {
      setChip(refs.custodyChip, 'Secure Enclave', 'up');
      dom.setText(refs.custodyTitle, 'Secure Enclave on this Mac');
      var made = dateWords(enclave.keyMadeAt);
      dom.setText(refs.custodyMade, made ? 'Key made ' + made + '.' : '');
      refs.custodyMade.hidden = !made;
      dom.setText(refs.custodyOpens, 'Opens with Touch ID, or your Mac login password.');
      refs.custodyOpens.hidden = false;
      /* Which of the two bindings is live, in words. An ad-hoc build keeps the
         key as a blob on disk that any process running as you can present. */
      var device = enclave.binding === 'device';
      dom.setText(refs.custodyBinding, device ? 'Any process on this Mac can ask; a Developer ID build binds the key to Phosphor.' : '');
      refs.custodyBinding.hidden = !device;
      refs.custodyReason.hidden = true;
      refs.migrate.hidden = true;
      var reach = enclave.attached === false
        ? 'The Secure Enclave is out of reach: Phosphor is running without its desktop shell. Nothing can open this wallet until it is back.'
        : (enclave.ready === false ? 'This Mac cannot authenticate you right now, so the wallet cannot be opened here.' : '');
      dom.setText(refs.custodyReachText, reach);
      refs.custodyReach.hidden = !reach;
      return;
    }

    if (custody === 'software') {
      setChip(refs.custodyChip, 'Software', 'warn');
      dom.setText(refs.custodyTitle, 'Software, on this disk');
      refs.custodyMade.hidden = true;
      dom.setText(refs.custodyOpens, 'Your keys are locked with your password and scrypt. Anything that learns the password, or reads this disk and guesses it, has them.');
      refs.custodyOpens.hidden = false;
      refs.custodyBinding.hidden = true;
      dom.setText(refs.custodyReason, softwareReason(vault));
      refs.custodyReason.hidden = false;
      refs.custodyReach.hidden = true;
      refs.migrate.hidden = enclave.ready !== true;
      return;
    }

    setChip(refs.custodyChip, 'No wallet', null);
    dom.setText(refs.custodyTitle, 'No wallet on this Mac');
    refs.custodyMade.hidden = true;
    dom.setText(refs.custodyOpens, 'Make one and it appears here.');
    refs.custodyOpens.hidden = false;
    refs.custodyBinding.hidden = true;
    refs.custodyReason.hidden = true;
    refs.custodyReach.hidden = true;
    refs.migrate.hidden = true;
  }

  /* Why the keys are in software, in one sentence. */
  function softwareReason(vault) {
    var enclave = vault.enclave || {};
    var cap = enclave.capability || null;
    if (enclave.ready === true) return 'This Mac has a Secure Enclave. Your keys can move behind it now.';
    if (enclave.attached === false) return 'Phosphor is running without its desktop shell, so the Secure Enclave is out of reach.';
    if (cap && cap.secureEnclave === false) return 'This Mac has no Secure Enclave.';
    if (cap && cap.canAuthenticate === false) return 'This Mac cannot authenticate you. Set up Touch ID or a login password, then come back.';
    return 'The Secure Enclave is not available on this Mac right now.';
  }

  function setChip(node, text, tone) {
    if (!node) return;
    var span = node.childNodes && node.childNodes[1];
    dom.setText(span, text);
    dom.setAttr(node, 'data-tone', tone);
  }

  function renderRecovery(vault) {
    var has = !!vault.custody;
    var backed = vault.backedUp === true;
    if (!has) {
      setChip(refs.backupChip, 'No wallet', null);
      dom.setText(refs.backupLine, 'There is nothing to back up yet.');
      dom.setText(refs.recoveryHelp, '');
    } else if (backed) {
      setChip(refs.backupChip, 'Backed up', 'up');
      var when = dateWords(vault.backedUpAt);
      dom.setText(refs.backupLine, 'Backed up: yes' + (when ? ', proven on ' + when : '') + '.');
      dom.setText(refs.recoveryHelp, 'You typed three of the words back, so the copy you keep is known to be right.');
    } else {
      setChip(refs.backupChip, 'Not backed up', 'warn');
      dom.setText(refs.backupLine, 'Backed up: no.');
      dom.setText(refs.recoveryHelp, 'Reveal the phrase, write it down somewhere that is not this Mac, then type three words back. Only that clears this.');
    }
    /* Reveal and Restore go through the enclave. A password wallet reveals its
       words behind the password on the Money in fold, as it always has. */
    var enclave = vault.custody === 'secure-enclave';
    refs.reveal.hidden = !enclave || vault.hasMnemonic === false;
    refs.restore.hidden = !enclave;
    refs.reveal.className = 'btn ' + (backed ? 'btn-ghost' : 'btn-primary');
    refs.forget.hidden = !has;
  }

  function renderAgent(policy) {
    if (!refs.agentLine) return;
    var outbound = policy && policy.outbound ? policy.outbound : {};
    var threshold = typeof outbound.humanClickAboveUsd === 'number' ? outbound.humanClickAboveUsd : null;
    dom.setText(refs.agentLine, threshold === null
      ? 'Every move it asks for goes through your rules first.'
      : 'Moves under ' + dom.usd(threshold, 0) + ' run without a click while the vault is open. Above that, nothing happens until you click.');
  }

  function renderIdle(vault) {
    var minutes = typeof vault.idleMinutes === 'number' ? vault.idleMinutes : null;
    IDLE_CHOICES.forEach(function (choice) {
      var c = refs.idleChips[choice];
      var on = minutes === choice;
      dom.setAttr(c, 'aria-pressed', on ? 'true' : 'false');
      dom.setAttr(c, 'data-tone', on ? 'ink' : null);
    });
  }

  function setIdle(minutes, node) {
    window.PhosphorShell.setPending(node, true, 'Saving');
    api.vaultPrefs({ idleMinutes: minutes })
      .then(function (answer) {
        if (answer && answer.ok === false) throw new Error(answer.error || 'That did not work.');
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
      .finally(function () { window.PhosphorShell.setPending(node, false); });
  }

  /* ---------- addresses ---------- */

  /* Only the EVM address is copyable. It is the account id on NEAR Intents and Hyperliquid, so
     money sent to it on an EVM chain can be moved in by a proposal. The wallet's own Solana and
     NEAR addresses exist (the keys are derived) but no rail moves money out of them, so a copied
     one would strand a deposit; they are shown, badged, and pointed at Show QR, which opens the
     bridge address for that network. */
  var ROWS = [
    { id: 'eth', label: 'EVM', note: 'your account id on NEAR Intents and Hyperliquid', copy: true },
    { id: 'sol', label: 'Solana', note: 'not a deposit address; use Show QR', copy: false },
    { id: 'near', label: 'NEAR', note: 'not a deposit address; use Show QR', copy: false }
  ];

  function loadAddresses() {
    if (!refs.addressList) return;
    api.receive()
      .then(function (result) {
        addresses = result.data || null;
        renderAddresses();
      })
      .catch(function () {
        addresses = null;
        renderAddresses();
      });
  }

  function renderAddresses() {
    var host = refs.addressList;
    dom.clear(host);
    var chains = addresses && Array.isArray(addresses.chains) ? addresses.chains : [];
    if (!chains.length) {
      var empty = dom.el('div', 'empty');
      empty.appendChild(dom.el('p', 'empty-title', 'No addresses yet'));
      empty.appendChild(dom.el('p', '', addresses && addresses.tampered
        ? 'The wallet file has been edited, so no address in it can be trusted.'
        : 'Make a wallet and your addresses appear here.'));
      host.appendChild(empty);
      return;
    }
    var verified = addresses.verified === true;
    ROWS.forEach(function (spec) {
      var chain = null;
      for (var i = 0; i < chains.length; i += 1) {
        if (chains[i] && chains[i].id === spec.id) chain = chains[i];
      }
      if (!chain || !chain.address) return;
      host.appendChild(addressRow(spec, chain, verified));
    });
  }

  function addressRow(spec, chain, verified) {
    var row = dom.el('div', 'vault-row');
    row.dataset.chain = spec.id;

    var main = dom.el('div', 'stack-2 grow');
    var head = dom.el('div', 'hstack-2 wrap');
    head.appendChild(dom.el('span', 'title-sm', spec.label));
    if (spec.note) head.appendChild(dom.el('span', 'meta', spec.note));
    head.appendChild(chip(verified ? 'Verified' : 'Unverified', verified ? 'up' : 'warn'));
    main.appendChild(head);
    main.appendChild(chunked(chain.address));
    if (!verified) {
      main.appendChild(dom.el('p', 'meta', 'Read from the file, not from your keys. It is verified once this Mac opens the wallet.'));
    }
    row.appendChild(main);

    var tools = dom.el('div', 'hstack-2 vault-row-tools');
    var said = dom.el('span', 'meta');
    said.setAttribute('role', 'status');
    var qr = button('Show QR', 'btn-ghost btn-sm');
    if (spec.copy) {
      var copy = button('Copy', 'btn-ghost btn-sm');
      tools.appendChild(copy);
      dom.on(copy, 'click', function () {
        copy.disabled = true;
        window.PhosphorDeposit.copyChecked(chain.address, function (sentence) { dom.setText(said, sentence); })
          .finally(function () { copy.disabled = false; });
      });
    }
    tools.appendChild(qr);
    tools.appendChild(said);
    row.appendChild(tools);

    dom.on(qr, 'click', function () {
      openDeposit(spec.id);
    });
    return row;
  }

  /* Groups of four, the ends in the stronger weight, the same shape the
     deposit card draws so the two read as one thing. */
  function chunked(address) {
    var block = dom.el('div', 'deposit-address mono vault-address');
    block.appendChild(dom.el('span', 'sr-only', address));
    var shown = dom.el('span', 'deposit-chunks');
    shown.setAttribute('aria-hidden', 'true');
    var parts = window.PhosphorDeposit.chunks(address);
    for (var i = 0; i < parts.length; i += 1) {
      var end = i === 0 || i === parts.length - 1;
      shown.appendChild(dom.el('span', end ? 'addr-end' : 'addr-mid', parts[i]));
    }
    block.appendChild(shown);
    return block;
  }

  /* The deposit card for a chain. The asset and the bridge address for it come
     off the receive report, so the card opens on the asset an exchange is most
     likely to send and carries the address the watcher should hold. */
  function openDeposit(chain) {
    api.intentsReceive()
      .then(function (result) {
        var report = result.data || {};
        var networks = Array.isArray(report.networks) ? report.networks : [];
        var network = null;
        for (var i = 0; i < networks.length; i += 1) {
          if (networks[i] && networks[i].id === chain) network = networks[i];
        }
        var symbol = network ? window.PhosphorDeposit.defaultSymbol(network.accepts) : '';
        if (!network || !symbol) {
          window.PhosphorToast.show('No deposit address on ' + window.PhosphorDeposit.networkWords(chain) + ' right now.', 'down');
          return;
        }
        return window.PhosphorDeposit.open({ chain: chain, symbol: symbol, address: network.address || null });
      })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); });
  }

  /* ---------- the phrase ---------- */

  function wipePhrase() {
    phrase = null;
    if (!refs.recoveryFlow) return;
    dom.clear(refs.recoveryFlow);
    refs.recoveryFlow.hidden = true;
    if (refs.reveal) refs.reveal.disabled = false;
    if (refs.restore) refs.restore.disabled = false;
  }

  /* Reveal. A fresh Touch ID every time, the words once, Print and no Copy:
     a clipboard is a place other processes read. */
  function startReveal() {
    if (!mounted) return;
    if (window.PhosphorShell.view() !== 'vault') window.PhosphorShell.setView('vault', { fromClick: true });
    wipePhrase();
    var state = store.get() || {};
    var vault = state.vault || {};
    if (vault.custody !== 'secure-enclave') return;
    refs.reveal.disabled = true;
    window.PhosphorShell.setPending(refs.reveal, true, 'Waiting for Touch ID');
    api.vaultReveal()
      .then(function (answer) {
        if (answer && answer.ok === false) {
          if (answer.code !== 'user_cancel') window.PhosphorToast.show(answer.error || 'That did not work.', 'down');
          return;
        }
        if (!answer || !Array.isArray(answer.words) || !answer.words.length) {
          window.PhosphorToast.show('No phrase came back.', 'down');
          return;
        }
        phrase = { words: answer.words.slice(), paths: answer.paths || null };
        showWords();
      })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
      .finally(function () {
        window.PhosphorShell.setPending(refs.reveal, false);
        refs.reveal.disabled = !!phrase;
      });
  }

  function showWords() {
    if (!phrase) return;
    var flow = refs.recoveryFlow;
    dom.clear(flow);
    flow.hidden = false;
    flow.dataset.step = 'words';

    flow.appendChild(dom.el('p', 'label', 'On this screen only'));
    var warn = dom.el('div', 'banner');
    warn.dataset.tone = 'down';
    warn.appendChild(dom.el('span', '', 'Anyone who reads these words can take your money. Nobody from this app will ever ask you for them.'));
    flow.appendChild(warn);

    var grid = dom.el('ol', 'words words-24');
    for (var i = 0; i < phrase.words.length; i += 1) {
      var item = dom.el('li', 'word');
      item.appendChild(dom.el('span', 'meta mono', String(i + 1)));
      item.appendChild(dom.el('span', 'body mono', phrase.words[i]));
      grid.appendChild(item);
    }
    flow.appendChild(grid);

    if (phrase.paths) {
      flow.appendChild(dom.el('p', 'meta', 'Derivation paths, for checking in another wallet: EVM ' + phrase.paths.evm
        + ', Solana ' + phrase.paths.solana + ', NEAR ' + phrase.paths.near + '.'));
    }

    var tools = dom.el('div', 'screen-actions wrap');
    var print = button('Print', 'btn-ghost');
    var wrote = button('I wrote them down', 'btn-primary');
    var done = button('Done', 'btn-quiet');
    tools.appendChild(print);
    tools.appendChild(wrote);
    tools.appendChild(done);
    flow.appendChild(tools);

    dom.on(print, 'click', printWords);
    dom.on(wrote, 'click', showProve);
    dom.on(done, 'click', wipePhrase);
    wrote.focus();
  }

  /* A sheet with nothing on it but the numbered words. The stylesheet hides
     the rest of the window while it prints and the sheet is removed after. */
  function printWords() {
    if (!phrase) return;
    var sheet = dom.el('div', 'print-sheet');
    sheet.appendChild(dom.el('h1', '', 'Phosphor recovery phrase'));
    sheet.appendChild(dom.el('p', '', 'Anyone who has these words has the money. Keep this sheet somewhere that is not near your computer.'));
    var list = dom.el('ol', '');
    for (var i = 0; i < phrase.words.length; i += 1) list.appendChild(dom.el('li', '', phrase.words[i]));
    sheet.appendChild(list);
    document.body.appendChild(sheet);
    try {
      window.print();
    } finally {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    }
  }

  /* Prove. Three positions picked here, never the same three, typed back and
     checked by the backend against the phrase it holds. Only a match clears
     "not backed up"; a miss says so and reveals nothing about which word. */
  function pickPositions(count, total) {
    var out = [];
    while (out.length < count && out.length < total) {
      var at = Math.floor(Math.random() * total);
      if (out.indexOf(at) === -1) out.push(at);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function showProve() {
    if (!phrase) return;
    var flow = refs.recoveryFlow;
    dom.clear(flow);
    flow.hidden = false;
    flow.dataset.step = 'prove';

    flow.appendChild(dom.el('p', 'title-sm', 'Prove it'));
    flow.appendChild(dom.el('p', 'body dim', 'Type three of your words back, by their number, from the copy you made.'));

    var positions = pickPositions(PROVE_COUNT, phrase.words.length);
    var inputs = [];
    positions.forEach(function (at) {
      var field = dom.el('div', 'field');
      field.appendChild(dom.el('label', 'label', 'Word ' + (at + 1)));
      var input = dom.el('input', 'input');
      input.type = 'text';
      input.name = 'word-' + (at + 1);
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      input.dataset.index = String(at);
      field.appendChild(input);
      flow.appendChild(field);
      inputs.push(input);
    });

    var error = dom.el('p', 'body down');
    error.hidden = true;
    flow.appendChild(error);

    var tools = dom.el('div', 'screen-actions wrap');
    var back = button('Show the words again', 'btn-ghost');
    var prove = button('Prove it', 'btn-primary');
    tools.appendChild(back);
    tools.appendChild(prove);
    flow.appendChild(tools);

    dom.on(back, 'click', showWords);
    dom.on(prove, 'click', function () {
      var words = [];
      for (var i = 0; i < inputs.length; i += 1) {
        var value = inputs[i].value.trim().toLowerCase();
        if (!value) {
          dom.setText(error, 'Type all three words.');
          error.hidden = false;
          return;
        }
        words.push({ index: Number(inputs[i].dataset.index), word: value });
      }
      error.hidden = true;
      window.PhosphorShell.setPending(prove, true, 'Checking');
      api.vaultBackupProven(words)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            dom.setText(error, answer.code === 'wrong_words'
              ? 'Those words do not match. Look at your copy again.'
              : (answer.error || 'That did not work.'));
            error.hidden = false;
            return;
          }
          wipePhrase();
          window.PhosphorToast.show('Backed up. Your copy of the phrase is right.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) {
          dom.setText(error, net.readable(err));
          error.hidden = false;
        })
        .finally(function () { window.PhosphorShell.setPending(prove, false); });
    });
    if (inputs[0]) inputs[0].focus();
  }

  /* Restore. Replaces the wallet on this Mac with the one the phrase makes.
     The backend refuses while the wallet here is not proven backed up and the
     phrase makes a different one, and asks for a Touch ID before it writes. */
  function startRestore() {
    wipePhrase();
    var flow = refs.recoveryFlow;
    flow.hidden = false;
    flow.dataset.step = 'restore';

    flow.appendChild(dom.el('p', 'title-sm', 'Restore from a phrase'));
    flow.appendChild(dom.el('p', 'body dim', 'The wallet that phrase makes replaces the one on this Mac. Money stays where it is on chain; only this Mac changes which wallet it holds. 12 or 24 words.'));

    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Recovery phrase'));
    var input = dom.el('textarea', 'input phrase-input');
    input.name = 'phrase';
    input.rows = 3;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    field.appendChild(input);
    flow.appendChild(field);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    flow.appendChild(error);

    var tools = dom.el('div', 'screen-actions wrap');
    var cancel = button('Cancel', 'btn-ghost');
    var go = button('Restore', 'btn-primary');
    tools.appendChild(cancel);
    tools.appendChild(go);
    flow.appendChild(tools);

    dom.on(cancel, 'click', wipePhrase);
    dom.on(go, 'click', function () {
      var clean = input.value.trim().toLowerCase();
      var words = clean ? clean.split(/\s+/) : [];
      if (words.length !== 12 && words.length !== 24) {
        dom.setText(error, 'That is ' + words.length + (words.length === 1 ? ' word' : ' words') + '. It should be 12 or 24.');
        error.hidden = false;
        return;
      }
      error.hidden = true;
      window.PhosphorConfirm.ask({
        title: 'Replace the wallet on this Mac',
        body: 'This Mac will hold the wallet the phrase makes instead of the one it holds now. Nothing moves on chain.',
        confirm: 'Restore',
        tone: 'down'
      }).then(function (yes) {
        if (!yes) return;
        window.PhosphorShell.setPending(go, true, 'Restoring');
        return api.vaultRestore(words.join(' '))
          .then(function (answer) {
            if (answer && answer.ok === false) {
              dom.setText(error, restoreProblem(answer.code, answer.error));
              error.hidden = false;
              return;
            }
            input.value = '';
            wipePhrase();
            window.PhosphorToast.show('Restored. This Mac now holds the wallet from your phrase.');
            return window.PhosphorShell.refresh({});
          })
          .catch(function (err) {
            dom.setText(error, net.readable(err));
            error.hidden = false;
          })
          .finally(function () { window.PhosphorShell.setPending(go, false); });
      });
    });
    input.focus();
  }

  function restoreProblem(code, error) {
    if (code === 'bad_phrase') return 'That phrase is not right. Check every word and the order they are in.';
    if (code === 'not_backed_up') return 'The wallet on this Mac is not proven backed up, so it cannot be replaced. Reveal and prove its phrase first.';
    if (code === 'user_cancel') return 'Touch ID was cancelled. Nothing changed.';
    if (code === 'enclave_unavailable') return 'The Secure Enclave did not answer. Phosphor may be running outside its desktop shell.';
    return error || 'That did not work.';
  }

  /* ---------- forget ---------- */

  function forgetWallet() {
    if (refs.forgetInput.value.trim() !== 'FORGET') return;
    refs.forgetError.hidden = true;
    window.PhosphorConfirm.ask({
      title: 'Forget this wallet on this Mac',
      body: 'The wallet file is shredded. Your recovery phrase is the only way back to it, here or on any other Mac.',
      confirm: 'Forget it',
      tone: 'down'
    }).then(function (yes) {
      if (!yes) return;
      window.PhosphorShell.setPending(refs.forget, true, 'Waiting for Touch ID');
      return api.vaultForget()
        .then(function (answer) {
          if (answer && answer.ok === false) {
            dom.setText(refs.forgetError, answer.code === 'not_backed_up'
              ? 'Refused: the phrase is not proven backed up. Reveal it and type three words back first.'
              : (answer.code === 'user_cancel' ? 'Touch ID was cancelled. Nothing changed.' : (answer.error || 'That did not work.')));
            refs.forgetError.hidden = false;
            return;
          }
          refs.forgetInput.value = '';
          refs.forget.disabled = true;
          window.PhosphorToast.show('This Mac has forgotten the wallet.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) {
          dom.setText(refs.forgetError, net.readable(err));
          refs.forgetError.hidden = false;
        })
        .finally(function () { window.PhosphorShell.setPending(refs.forget, false); });
    });
  }

  /* ---------- migration ---------- */

  /* Once at boot, for a password wallet on a Mac whose enclave is ready and
     whose window is open. Dismissable, and the Custody panel keeps the button. */
  function offerMigration(state) {
    if (migrateOffered) return;
    var vault = state.vault || {};
    var lock = state.lock || {};
    if (vault.custody !== 'software') return;
    if (!vault.enclave || vault.enclave.ready !== true) return;
    if (lock.state !== 'unlocked') return;
    migrateOffered = true;
    openMigrate(true);
  }

  function openMigrate(atBoot) {
    var host = document.getElementById('screen-migrate');
    if (!host) return;
    migrateOffered = true;
    dom.clear(host);
    dom.setHidden(host, false);
    dom.setAttr(document.body, 'data-locked', 'true');
    setPageInert(true);

    var card = dom.el('div', 'screen-card');
    host.appendChild(card);
    card.appendChild(dom.el('h1', 'title', 'Move your keys behind the Secure Enclave'));
    card.appendChild(dom.el('p', 'body dim', 'Type your password once. Your keys are wrapped to a key this Mac made in its Secure Enclave, one Touch ID proves the round trip, and only then is the file replaced. No step can leave the wallet openable by neither.'));

    var form = dom.el('form', 'stack');
    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Password'));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.name = 'password';
    input.autocomplete = 'current-password';
    field.appendChild(input);
    form.appendChild(field);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    form.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var later = button(atBoot ? 'Not now' : 'Cancel', 'btn-ghost');
    var go = dom.el('button', 'btn btn-primary btn-lg');
    go.type = 'submit';
    go.appendChild(dom.el('span', 'btn-label', 'Move my keys'));
    actions.appendChild(later);
    actions.appendChild(go);
    form.appendChild(actions);
    card.appendChild(form);
    card.appendChild(dom.el('p', 'meta', 'After this, Touch ID opens the wallet and the password is no longer needed.'));

    function closeMigrate() {
      input.value = '';
      dom.clear(host);
      dom.setHidden(host, true);
      dom.setAttr(document.body, 'data-locked', null);
      setPageInert(false);
    }

    dom.on(later, 'click', closeMigrate);
    dom.on(form, 'submit', function (event) {
      event.preventDefault();
      if (!input.value) return;
      error.hidden = true;
      window.PhosphorShell.setPending(go, true, 'Waiting for Touch ID');
      api.vaultMigrate(input.value)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            dom.setText(error, migrateProblem(answer.code, answer.error));
            error.hidden = false;
            if (answer.code === 'wrong_password') {
              input.value = '';
              input.focus();
            }
            return;
          }
          closeMigrate();
          window.PhosphorToast.show('Your keys are behind the Secure Enclave. Touch ID opens the wallet from now on.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) {
          dom.setText(error, net.readable(err));
          error.hidden = false;
        })
        .finally(function () { window.PhosphorShell.setPending(go, false); });
    });
    input.focus();
  }

  function migrateProblem(code, error) {
    if (code === 'wrong_password') return 'That password is wrong.';
    if (code === 'user_cancel') return 'Touch ID was cancelled. Your keys are where they were.';
    if (code === 'enclave_unavailable') return 'The Secure Enclave did not answer. Phosphor may be running outside its desktop shell.';
    return error || 'That did not work.';
  }

  /* The same pair lock.js uses: the page behind the card is frosted by the
     stylesheet and taken off the keyboard here. */
  function setPageInert(on) {
    var page = document.getElementById('page');
    if (!page) return;
    if ('inert' in page) page.inert = on;
    dom.setAttr(page, 'aria-hidden', on ? 'true' : null);
  }

  /* ---------- from outside ---------- */

  function focusRecovery() {
    if (!refs.recoveryPanel) return;
    if (typeof refs.recoveryPanel.scrollIntoView === 'function') {
      refs.recoveryPanel.scrollIntoView({ block: 'start', behavior: window.PhosphorMotion && window.PhosphorMotion.reduced() ? 'auto' : 'smooth' });
    }
    if (refs.reveal && !refs.reveal.hidden) refs.reveal.focus();
  }

  window.PhosphorVault = {
    boot: boot,
    render: render,
    startReveal: startReveal,
    startRestore: startRestore,
    focusRecovery: focusRecovery,
    openMigrate: openMigrate,
    wipePhrase: wipePhrase
  };
})();
