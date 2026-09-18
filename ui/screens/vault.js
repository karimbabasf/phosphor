/* The Vault tab: who holds the key, where money arrives, and the phrase.

   Six panels on a two column grid when the world is wide enough (Custody and
   Recovery side by side, Addresses across both, then Agent, Window, Danger),
   one column when it is not. Everything here reads off the state's `vault`
   slice and the two address routes; nothing here draws a key. The one secret
   that ever reaches this screen is the recovery phrase, shown once behind a
   fresh Touch ID, held in this file's memory until Done, and wiped the moment
   the window locks or the person leaves the tab.

   Karim, 2026-09-15: "I hate how the vault has to be so scrollable, make it
   wider, make the info easier to read, and in the addresses section same
   thing, just make it a drop down of the networks and their supported tokens
   shown with a search." So the Addresses card is a network menu over the
   token list from ui/screens/netpick.js, and Show the address opens the
   deposit card. The wallet's own key address for that network is still here,
   behind the developer switch: it is the account id, not where to send.

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
  var report = null;
  var network = 'eth';
  var tokensView = null;
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

  /* A card wearing the same head as Pro's (pro.css .card): the title at the
     left, one line of state at the right, a hairline under both. */
  function panel(title, surface) {
    var node = dom.el('section', 'panel card');
    node.dataset.surface = surface;
    var head = dom.el('div', 'card-head');
    head.appendChild(dom.el('h2', 'card-title', title));
    var right = dom.el('div', 'card-head-right');
    head.appendChild(right);
    node.appendChild(head);
    var body = dom.el('div', 'card-body');
    node.appendChild(body);
    return { node: node, body: body, right: right };
  }

  function button(label, kind, pending) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(node, 'data-pending-label', pending);
    return node;
  }

  function chip(text, tone) {
    var node = dom.el('span', 'chip');
    if (tone) node.dataset.tone = tone;
    node.appendChild(dom.el('span', 'dot'));
    node.appendChild(dom.el('span', '', text));
    return node;
  }

  /* Two columns, the way Pro lays its deck: each column stacks its cards
     with nothing stretched and no hole, because a grid row is as tall as its
     tallest card and left a blank under the shorter one (Karim, 2026-09-16:
     "the blank space shouldn't even be there"). Under 980 px of world the
     columns dissolve (vault.css, display: contents) and the cards keep the
     reading order through `order`. */
  function build(host) {
    var col = dom.el('div', 'basic-col vault-col');
    var left = dom.el('div', 'vault-column');
    var right = dom.el('div', 'vault-column');
    col.appendChild(left);
    col.appendChild(right);
    var order = 0;
    function place(column, node) {
      order += 1;
      node.style.order = String(order);
      column.appendChild(node);
    }

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
    place(left, custody.node);

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
    refs.reveal = button('Reveal recovery phrase', 'btn-primary', 'Waiting for Touch ID');
    refs.restore = button('Restore from a phrase', 'btn-ghost');
    recoveryActions.appendChild(refs.reveal);
    recoveryActions.appendChild(refs.restore);
    /* A password wallet's two doors, the ones the Money in fold used to hold:
       the words behind the password, and an encrypted copy of the file. */
    refs.revealPassword = button('Show my recovery words', 'btn-ghost');
    refs.exportPassword = button('Save an encrypted backup', 'btn-ghost');
    recoveryActions.appendChild(refs.revealPassword);
    recoveryActions.appendChild(refs.exportPassword);
    recovery.body.appendChild(recoveryActions);
    dom.on(refs.revealPassword, 'click', function () { window.PhosphorMoneyIn.revealWithPassword(); });
    dom.on(refs.exportPassword, 'click', function () { window.PhosphorMoneyIn.exportWithPassword(); });
    refs.recoveryFlow = dom.el('div', 'stack vault-flow');
    refs.recoveryFlow.hidden = true;
    recovery.body.appendChild(refs.recoveryFlow);
    dom.on(refs.reveal, 'click', startReveal);
    dom.on(refs.restore, 'click', startRestore);
    place(right, recovery.node);

    /* Addresses: the network menu, the tokens it credits, and behind the
       developer switch the wallet's own key on that network. */
    var addr = panel('Addresses', 'addresses');
    addr.body.appendChild(dom.el('p', 'body dim', 'Pick the network you are sending on. Show the address opens the deposit card, which checks the address before it draws it.'));
    addr.body.appendChild(networkSelect());
    refs.tokensHost = dom.el('div', 'vault-tokens');
    addr.body.appendChild(refs.tokensHost);
    refs.keyRow = dom.el('div', 'vault-key');
    refs.keyRow.setAttribute('data-dev-only', '');
    addr.body.appendChild(refs.keyRow);
    place(left, addr.node);

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
    place(right, agent.node);

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
      dom.setAttr(c, 'data-pending-label', 'Saving');
      dom.on(c, 'click', function () { setIdle(minutes, c); });
      refs.idleChips[minutes] = c;
      refs.idleRow.appendChild(c);
    });
    win.body.appendChild(refs.idleRow);
    win.body.appendChild(dom.el('p', 'meta', 'Frost hides the window until you unlock it again. It never affects signing: every move still needs its own click.'));
    place(right, win.node);

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
    refs.forget = button('Forget this wallet', 'btn-danger', 'Waiting for Touch ID');
    refs.forget.disabled = true;
    dangerActions.appendChild(refs.forget);
    danger.body.appendChild(dangerActions);
    dom.on(refs.forgetInput, 'input', function () {
      refs.forget.disabled = refs.forgetInput.value.trim() !== 'FORGET';
    });
    dom.on(refs.forget, 'click', forgetWallet);
    place(left, danger.node);

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
    /* Reveal and Restore go through the enclave. A password wallet reveals
       its words behind the password, and can save an encrypted copy, here. */
    var enclave = vault.custody === 'secure-enclave';
    refs.reveal.hidden = !enclave || vault.hasMnemonic === false;
    refs.restore.hidden = !enclave;
    var password = has && !enclave;
    refs.revealPassword.hidden = !password || vault.hasMnemonic === false;
    refs.exportPassword.hidden = !password;
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
    window.PhosphorShell.setPending(node, true);
    api.vaultPrefs({ idleMinutes: minutes })
      .then(function (answer) {
        if (answer && answer.ok === false) throw new Error(answer.error || 'That did not work.');
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
      .finally(function () { window.PhosphorShell.setPending(node, false); });
  }

  /* ---------- addresses ---------- */

  /* Every network the bridge credits, in the component's own order and
     colours, so the menu and the tiles elsewhere are the same things: the
     six quick ones until the report has landed, all of them after. */
  function networks() {
    var pick = window.PhosphorNetPick;
    if (pick && typeof pick.allNetworks === 'function') return pick.allNetworks(report);
    return pick && Array.isArray(pick.NETWORKS) ? pick.NETWORKS : [
      { id: 'eth', name: 'Ethereum', mark: 'ETH' },
      { id: 'base', name: 'Base', mark: 'BASE' },
      { id: 'arb', name: 'Arbitrum', mark: 'ARB' },
      { id: 'sol', name: 'Solana', mark: 'SOL' },
      { id: 'near', name: 'NEAR', mark: 'NEAR' }
    ];
  }

  function networkOf(id) {
    var list = networks();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function logo(symbol, size) {
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') return marks.logo(symbol, size);
    var node = dom.el('span', 'logo');
    node.setAttribute('aria-hidden', 'true');
    node.appendChild(dom.el('span', 'logo-initial mono', String(symbol || '?').charAt(0)));
    return node;
  }

  function icon(name, className) {
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') return icons.svg(name, className);
    return dom.el('span', 'icon ' + (className || ''));
  }

  function within(node, root) {
    for (var at = node; at; at = at.parentNode) {
      if (at === root) return true;
    }
    return false;
  }

  /* The network menu: a button wearing the mark and the name, opening a
     listbox of the five, the same shape as the market menu on the Trade tab
     rather than a native select that draws OS chrome. Arrow keys open it and
     walk it, Enter picks, Escape and a click elsewhere close it. */
  var menuActive = 'eth';

  function networkSelect() {
    var wrap = dom.el('div', 'netsel-wrap');
    var button = dom.el('button', 'netsel');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'vault-networks');
    button.setAttribute('aria-label', 'Which network');
    refs.netselMark = dom.el('span', 'netsel-mark');
    button.appendChild(refs.netselMark);
    refs.netselLabel = dom.el('span', 'netsel-name');
    button.appendChild(refs.netselLabel);
    button.appendChild(icon('chevron-down', 'chev-icon'));

    var menu = dom.el('div', 'netsel-menu pop');
    menu.id = 'vault-networks';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Which network');
    menu.tabIndex = -1;

    wrap.appendChild(button);
    wrap.appendChild(menu);
    refs.netselButton = button;
    refs.netselMenu = menu;

    dom.on(button, 'click', function () {
      if (menu.dataset.open === 'true') closeMenu();
      else openMenu();
    });
    dom.on(button, 'keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu();
    });
    dom.on(menu, 'keydown', onMenuKey);
    dom.on(menu, 'click', function (event) {
      var option = optionOf(event.target);
      if (option) pickNetwork(option.dataset.network);
    });
    dom.on(document, 'click', function (event) {
      if (menu.dataset.open !== 'true') return;
      if (within(event.target, wrap)) return;
      closeMenu();
    });

    renderSelect();
    return wrap;
  }

  function optionOf(node) {
    for (var at = node; at; at = at.parentNode) {
      if (at.dataset && at.dataset.network) return at;
    }
    return null;
  }

  function renderSelect() {
    if (!refs.netselMenu) return;
    var current = networkOf(network) || networks()[0];
    dom.clear(refs.netselMark);
    refs.netselMark.appendChild(logo(current.mark, 20));
    dom.setText(refs.netselLabel, current.name);
    dom.clear(refs.netselMenu);
    networks().forEach(function (n) {
      var option = dom.el('div', 'netsel-option');
      option.setAttribute('role', 'option');
      option.dataset.network = n.id;
      option.setAttribute('aria-selected', n.id === network ? 'true' : 'false');
      if (n.id === menuActive) option.dataset.active = 'true';
      if (n.colour && option.style && typeof option.style.setProperty === 'function') option.style.setProperty('--net', n.colour);
      option.appendChild(logo(n.mark, 20));
      option.appendChild(dom.el('span', 'netsel-option-name', n.name));
      refs.netselMenu.appendChild(option);
    });
  }

  function openMenu() {
    var menu = refs.netselMenu;
    if (!menu) return;
    menuActive = network;
    renderSelect();
    menu.dataset.open = 'true';
    dom.setAttr(refs.netselButton, 'aria-expanded', 'true');
    if (menu.focus) menu.focus();
  }

  function closeMenu() {
    var menu = refs.netselMenu;
    if (!menu) return;
    delete menu.dataset.open;
    dom.setAttr(refs.netselButton, 'aria-expanded', 'false');
    if (refs.netselButton && refs.netselButton.focus) refs.netselButton.focus();
  }

  function onMenuKey(event) {
    var ids = networks().map(function (n) { return n.id; });
    var at = ids.indexOf(menuActive);
    if (event.key === 'Escape' || event.key === 'Tab') {
      closeMenu();
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pickNetwork(menuActive);
      return;
    }
    var next = at;
    if (event.key === 'ArrowDown') next = Math.min(ids.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    else return;
    event.preventDefault();
    menuActive = ids[next] || menuActive;
    renderSelect();
  }

  function pickNetwork(id) {
    if (!id) return;
    closeMenu();
    if (id === network) return;
    network = id;
    renderSelect();
    renderTokens();
    renderKey();
  }

  /* Both address routes, read together: the bridge report feeds the token
     list, the wallet's own key feeds the row behind the developer switch. */
  function loadAddresses() {
    if (!refs.tokensHost) return;
    var wallet = api.receive()
      .then(function (result) { addresses = result.data || null; })
      .catch(function () { addresses = null; });
    var bridge = api.intentsReceive()
      .then(function (result) { report = result && result.data ? result.data : null; })
      .catch(function () { report = null; });
    Promise.all([wallet, bridge]).then(function () {
      renderSelect();
      renderTokens();
      renderKey();
    });
  }

  /* The tokens the bridge credits on the network in the menu, with the
     minimum for each, searchable; Show the address opens the deposit card. */
  function renderTokens() {
    if (!refs.tokensHost) return;
    var pick = window.PhosphorNetPick;
    if (!pick || typeof pick.render !== 'function') return;
    tokensView = pick.render(refs.tokensHost, {
      context: 'vault',
      stage: 'tokens',
      network: network,
      report: report,
      onAddress: function (chain, symbol, row) {
        window.PhosphorDeposit.open({ chain: chain, symbol: symbol, address: row && row.address ? row.address : null });
      }
    });
  }

  /* The wallet's own key on that network: the EVM address, which is the
     account id on NEAR Intents and Hyperliquid, so it may be copied. On any
     other network the wallet has no key of its own, and the row says so. */
  function renderKey() {
    var host = refs.keyRow;
    if (!host) return;
    dom.clear(host);
    var chains = addresses && Array.isArray(addresses.chains) ? addresses.chains : [];
    var chain = null;
    for (var i = 0; i < chains.length; i += 1) {
      if (chains[i] && chains[i].id === network) chain = chains[i];
    }
    var n = networkOf(network) || { name: String(network) };
    host.appendChild(dom.el('p', 'label', 'Wallet key address on ' + n.name));
    var own = network === 'eth' || network === 'base' || network === 'arb';
    if (!own) {
      host.appendChild(dom.el('p', 'body dim', 'This wallet has no key of its own on ' + n.name + '. Money sent there arrives through the bridge address above.'));
      return;
    }
    if (!chain || !chain.address) {
      host.appendChild(dom.el('p', 'body dim', addresses && addresses.tampered
        ? 'The wallet file has been edited, so no address in it can be trusted.'
        : 'No wallet on this Mac yet.'));
      return;
    }
    var verified = addresses.verified === true;
    var head = dom.el('div', 'hstack-2 wrap');
    head.appendChild(chip(verified ? 'Verified' : 'Unverified', verified ? 'up' : 'warn'));
    head.appendChild(dom.el('span', 'meta', 'Your account id on NEAR Intents and Hyperliquid.'));
    host.appendChild(head);
    host.appendChild(chunked(chain.address));
    if (!verified) {
      host.appendChild(dom.el('p', 'meta', 'Read from the file, not from your keys. It is verified once this Mac opens the wallet.'));
    }
    if (verified) {
      var tools = dom.el('div', 'hstack-2 wrap');
      var said = dom.el('span', 'meta');
      said.setAttribute('role', 'status');
      var copy = button('Copy', 'btn-ghost btn-sm');
      tools.appendChild(copy);
      tools.appendChild(said);
      host.appendChild(tools);
      dom.on(copy, 'click', function () {
        copy.disabled = true;
        window.PhosphorDeposit.copyChecked(chain.address, function (sentence) { dom.setText(said, sentence); })
          .finally(function () { copy.disabled = false; });
      });
    }
  }

  /* The same block the address step draws, grouped for the kind of address
     the network in the menu has, so the two read as one thing. */
  function chunked(address) {
    var pick = window.PhosphorNetPick;
    var kind = pick && typeof pick.kindOf === 'function' ? (pick.kindOf(network) || 'evm')
      : (network === 'sol' ? 'sol' : (network === 'near' ? 'near' : 'evm'));
    if (pick && typeof pick.addressBlock === 'function') {
      var block = pick.addressBlock(address, kind);
      block.className = block.className + ' vault-address';
      return block;
    }
    var plain = dom.el('div', 'deposit-address mono vault-address');
    plain.appendChild(dom.el('span', 'sr-only', address));
    var shown = dom.el('span', 'deposit-chunks');
    shown.setAttribute('aria-hidden', 'true');
    var parts = window.PhosphorDeposit.chunks(address, kind);
    for (var i = 0; i < parts.length; i += 1) {
      var end = i === 0 || i === parts.length - 1;
      shown.appendChild(dom.el('span', end ? 'addr-end' : 'addr-mid', parts[i]));
    }
    plain.appendChild(shown);
    return plain;
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
    window.PhosphorShell.setPending(refs.reveal, true);
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
      flow.appendChild(dom.el('p', 'meta', 'Derivation path, for checking in another wallet: EVM ' + phrase.paths.evm + '.'));
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
    var prove = button('Prove it', 'btn-primary', 'Checking');
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
      window.PhosphorShell.setPending(prove, true);
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
    var go = button('Restore', 'btn-primary', 'Restoring');
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
        window.PhosphorShell.setPending(go, true);
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
      window.PhosphorShell.setPending(refs.forget, true);
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
    dom.setAttr(go, 'data-pending-label', 'Waiting for Touch ID');
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
      window.PhosphorShell.setPending(go, true);
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
