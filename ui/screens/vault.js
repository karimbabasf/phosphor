/* The Vault: who drives, what keeps the money safe, and the wallet itself.

   The conversation stays on the left, where it is on every mode, and the
   Vault is the wide right side Pro has (ui/design/pro.css), so switching
   between the two moves nothing. Three sections read top to bottom:

     Your assistant   one row per agent with its state on this Mac and one
                      action, Use (the list is ui/screens/firstrun.js's
                      PhosphorAgentPick, loaded with it)
     Safety           freeze, the lock timer, the backup and your limits:
                      the controls the bar no longer carries, each a row
     Your wallet      the keys, the recovery phrase, the addresses, forget

   Rows are ruled, not boxed, the way the balances panel rules its coins, and
   the only red on the page is the confirm step of Freeze.

   Everything here reads off the state's `vault` and `policy` slices and the
   two address routes; nothing here draws a key. The one secret that ever
   reaches this screen is the recovery phrase, shown once behind a fresh Touch
   ID, held in this file's memory until Done, and wiped the moment the window
   locks or the person leaves the tab.

   Karim, 2026-09-15: "I hate how the vault has to be so scrollable, make it
   wider, make the info easier to read, and in the addresses section same
   thing, just make it a drop down of the networks and their supported tokens
   shown with a search." So the Vault takes the wide side, the assistant and
   safety come first, and the Addresses row is a network menu over the token
   list from ui/screens/netpick.js. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var IDLE_CHOICES = [
    { minutes: 5, label: '5 min' },
    { minutes: 15, label: '15 min' },
    { minutes: 60, label: '1 hour' }
  ];
  var PROVE_COUNT = 3;

  /* The freeze's words are the bar's (ui/screens/shell.js), so the two ways to
     the same switch never disagree about what it does. */
  var FREEZE = {
    off: {
      line: 'Stops every move at once. Working orders are cancelled and every rule is disarmed.',
      ask: 'This cancels every working order and disarms every rule. It does not close a position: nothing in this app can do that.',
      open: 'Freeze everything',
      keep: 'Cancel',
      go: 'Freeze everything',
      pending: 'Freezing'
    },
    on: {
      line: 'Everything is frozen. The assistant cannot move any money until you unfreeze.',
      ask: 'Moves and rules start working again the moment you unfreeze.',
      open: 'Unfreeze',
      keep: 'Keep frozen',
      go: 'Unfreeze',
      pending: 'Unfreezing'
    }
  };

  var refs = {};
  var mounted = false;
  var visible = false;
  var lastVerifiedKey = null;
  var addresses = null;
  var report = null;
  var network = 'eth';
  var phrase = null;
  var migrateOffered = false;
  var agents = null;

  /* ---------- boot ---------- */

  function boot() {
    var host = document.getElementById('view-vault');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    store.select('lock', function () {
      /* A locked window is not a place for the phrase. */
      var state = store.get() || {};
      if (state.lock && state.lock.state !== 'unlocked') wipePhrase();
    });
    window.addEventListener('phosphor:view', function (event) {
      var view = event && event.detail ? event.detail.view : null;
      visible = view === 'vault';
      if (visible) {
        loadAddresses();
        mountAgents();
      } else {
        wipePhrase();
        closeFreeze(false);
      }
    });
    render();
  }

  /* ---------- the page ---------- */

  function section(title, surface) {
    var node = dom.el('section', 'vault-sec');
    node.dataset.surface = surface;
    var head = dom.el('div', 'vault-sec-head');
    head.appendChild(dom.el('h2', 'vault-title', title));
    node.appendChild(head);
    var body = dom.el('div', 'vault-sec-body');
    node.appendChild(body);
    return { node: node, head: head, body: body };
  }

  /* A row: its name on the left, what it says in the middle, its action on
     the right, and anything it opens (a confirm, a flow) under the words. */
  function row(title, surface) {
    var node = dom.el('div', 'vault-row');
    if (surface) node.dataset.surface = surface;
    node.appendChild(dom.el('h3', 'vault-row-title', title));
    var body = dom.el('div', 'vault-row-body');
    node.appendChild(body);
    var act = dom.el('div', 'vault-row-act');
    node.appendChild(act);
    return { node: node, body: body, act: act };
  }

  /* A step opening or closing inside a row (ui/design/motion.js): the row's
     height slides and the step fades in; on the way back the step fades out
     first and the row closes after it. Focus moves inside `change`, once the
     control it goes to is on screen. */
  function grow(rowNode, change, shown) {
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.morph === 'function' && rowNode) motion.morph(rowNode, change, { fade: shown });
    else change();
  }

  function shrink(rowNode, leaving, change, shown) {
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.swap === 'function' && rowNode) motion.swap(rowNode, leaving, change, { fade: shown });
    else change();
  }

  function button(label, kind, pending) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost btn-sm'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(node, 'data-pending-label', pending);
    return node;
  }

  function text(className, words) {
    return dom.el('p', className || 'vault-text', words || '');
  }

  function build(host) {
    var page = dom.el('div', 'vault');

    /* Your assistant */
    var agent = section('Your assistant', 'agent');
    refs.agentAgain = button('Check again', 'btn-quiet btn-sm', 'Checking');
    agent.head.appendChild(refs.agentAgain);
    dom.on(refs.agentAgain, 'click', function () {
      if (agents && typeof agents.scan === 'function') agents.scan(true, refs.agentAgain);
    });
    agent.body.appendChild(text('vault-lead', 'Pick the one you already use. It sees your balances and addresses, never your keys or your phrase.'));
    refs.agentHost = dom.el('div', 'vault-agents');
    agent.body.appendChild(refs.agentHost);
    refs.agentWait = text('vault-text dim', 'Checking which assistants are on this Mac.');
    refs.agentHost.appendChild(refs.agentWait);
    page.appendChild(agent.node);

    /* Safety */
    var safety = section('Safety', 'safety');
    buildFreeze(safety.body);
    buildLock(safety.body);
    buildBackup(safety.body);
    buildLimits(safety.body);
    page.appendChild(safety.node);

    /* Your wallet */
    var wallet = section('Your wallet', 'wallet');
    buildKeys(wallet.body);
    buildRecovery(wallet.body);
    buildAddresses(wallet.body);
    buildForget(wallet.body);
    page.appendChild(wallet.node);

    host.appendChild(page);
  }

  /* ---------- your assistant ---------- */

  /* The list lives with the first run's script, a late load. It is drawn the
     first time the Vault opens and asked to check again on every opening
     after that, so an agent installed or signed in since reads true. */
  function mountAgents() {
    if (agents && typeof agents.scan === 'function') {
      agents.scan(false);
      return;
    }
    var lazy = window.PhosphorLazy;
    var ready = lazy && typeof lazy.load === 'function' ? lazy.load('firstrun') : Promise.resolve(true);
    Promise.resolve(ready).then(function () {
      var Pick = window.PhosphorAgentPick;
      if (agents || !Pick || typeof Pick.render !== 'function' || !refs.agentHost) return;
      agents = Pick.render(refs.agentHost, { context: 'vault', again: false });
    });
  }

  /* ---------- safety: freeze ---------- */

  function buildFreeze(host) {
    var r = row('Freeze', 'freeze');
    refs.freezeLine = text();
    r.body.appendChild(refs.freezeLine);
    refs.freezeOpen = button(FREEZE.off.open, 'btn-ghost btn-sm');
    r.act.appendChild(refs.freezeOpen);

    /* The confirm step, under the words, never a dialog. Cancel is focused,
       so Enter on an open step does the harmless thing. */
    var confirm = dom.el('div', 'vault-confirm');
    confirm.setAttribute('role', 'group');
    confirm.hidden = true;
    refs.freezeAsk = text('vault-confirm-text');
    confirm.appendChild(refs.freezeAsk);
    var actions = dom.el('div', 'vault-actions');
    refs.freezeKeep = button(FREEZE.off.keep, 'btn-quiet btn-sm');
    refs.freezeGo = button(FREEZE.off.go, 'btn-danger btn-sm', FREEZE.off.pending);
    actions.appendChild(refs.freezeKeep);
    actions.appendChild(refs.freezeGo);
    confirm.appendChild(actions);
    refs.freezeError = text('vault-error');
    refs.freezeError.hidden = true;
    confirm.appendChild(refs.freezeError);
    r.body.appendChild(confirm);
    refs.freezeConfirm = confirm;
    refs.freezeRow = r.node;

    dom.on(refs.freezeOpen, 'click', function () {
      if (refs.freezeConfirm.hidden) openFreeze();
      else closeFreeze(true);
    });
    dom.on(refs.freezeKeep, 'click', function () { closeFreeze(true); });
    dom.on(refs.freezeGo, 'click', function () { doFreeze(!frozenIn(store.get() || {})); });
    dom.on(confirm, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeFreeze(true);
    });
    host.appendChild(r.node);
  }

  function frozenIn(state) {
    return !!(state.policy && state.policy.killSwitch);
  }

  function renderFreeze(state) {
    var frozen = frozenIn(state);
    var words = FREEZE[frozen ? 'on' : 'off'];
    dom.setText(refs.freezeLine, words.line);
    dom.setAttr(refs.freezeLine, 'data-frozen', frozen ? 'true' : null);
    dom.setText(refs.freezeOpen.querySelector('.btn-label'), words.open);
    dom.setAttr(refs.freezeOpen, 'aria-expanded', refs.freezeConfirm.hidden ? 'false' : 'true');
    dom.setText(refs.freezeAsk, words.ask);
    dom.setText(refs.freezeKeep.querySelector('.btn-label'), words.keep);
    dom.setText(refs.freezeGo.querySelector('.btn-label'), words.go);
    dom.setAttr(refs.freezeGo, 'data-pending-label', words.pending);
    /* Red is the freeze itself and nothing else: the way back is plain. */
    refs.freezeGo.className = frozen ? 'btn btn-sm' : 'btn btn-danger btn-sm';
  }

  function openFreeze() {
    renderFreeze(store.get() || {});
    grow(refs.freezeRow, function () {
      dom.setHidden(refs.freezeError, true);
      dom.setHidden(refs.freezeConfirm, false);
      dom.setHidden(refs.freezeOpen, true);
      if (refs.freezeKeep.focus) refs.freezeKeep.focus();
    }, refs.freezeConfirm);
  }

  function closeFreeze(returnFocus) {
    if (!refs.freezeConfirm || refs.freezeConfirm.hidden) return;
    shrink(refs.freezeRow, refs.freezeConfirm, function () {
      dom.setHidden(refs.freezeConfirm, true);
      dom.setHidden(refs.freezeOpen, false);
      if (returnFocus && refs.freezeOpen.focus) refs.freezeOpen.focus();
    }, refs.freezeOpen);
  }

  function doFreeze(on) {
    window.PhosphorShell.setPending(refs.freezeGo, true);
    api.kill(on)
      .then(function () { return window.PhosphorShell.refresh({}); })
      .then(function () { closeFreeze(true); })
      .catch(function (err) {
        dom.setText(refs.freezeError, net.readable(err));
        dom.setHidden(refs.freezeError, false);
      })
      .finally(function () { window.PhosphorShell.setPending(refs.freezeGo, false); });
  }

  /* ---------- safety: the lock ---------- */

  function buildLock(host) {
    var r = row('Lock', 'window');
    var line = dom.el('div', 'vault-lock-line');
    refs.idle = dom.el('div', 'vault-seg');
    refs.idle.setAttribute('role', 'radiogroup');
    refs.idle.setAttribute('aria-label', 'Lock the window after');
    refs.idleChoices = {};
    IDLE_CHOICES.forEach(function (choice) {
      var c = dom.el('button', 'vault-seg-cell');
      c.type = 'button';
      c.setAttribute('role', 'radio');
      c.setAttribute('aria-checked', 'false');
      c.appendChild(dom.el('span', 'btn-label', choice.label));
      dom.setAttr(c, 'data-pending-label', 'Saving');
      dom.on(c, 'click', function () { setIdle(choice.minutes, c); });
      refs.idleChoices[choice.minutes] = c;
      refs.idle.appendChild(c);
    });
    line.appendChild(refs.idle);
    r.body.appendChild(line);
    r.body.appendChild(text('vault-sub', 'The window locks after this long without you, and stays hidden until you open it again. Every move still needs its own click either way.'));
    refs.lockNow = button('Lock now', 'btn-quiet btn-sm', 'Locking');
    r.act.appendChild(refs.lockNow);
    dom.on(refs.lockNow, 'click', lockNow);
    host.appendChild(r.node);
  }

  function renderIdle(vault, lock) {
    var minutes = typeof vault.idleMinutes === 'number' ? vault.idleMinutes : null;
    IDLE_CHOICES.forEach(function (choice) {
      dom.setAttr(refs.idleChoices[choice.minutes], 'aria-checked', minutes === choice.minutes ? 'true' : 'false');
    });
    dom.setHidden(refs.lockNow, !(lock && lock.state === 'unlocked'));
  }

  function setIdle(minutes, node) {
    window.PhosphorShell.setPending(node, true);
    api.vaultPrefs({ idleMinutes: minutes })
      .then(function (answer) {
        if (answer && answer.ok === false) throw new Error(answer.error || 'That did not work.');
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err)); })
      .finally(function () { window.PhosphorShell.setPending(node, false); });
  }

  function lockNow() {
    window.PhosphorShell.setPending(refs.lockNow, true);
    api.lock()
      .then(function () { return window.PhosphorShell.refresh({}); })
      .catch(function (err) { window.PhosphorToast.show(net.readable(err)); })
      .finally(function () { window.PhosphorShell.setPending(refs.lockNow, false); });
  }

  /* ---------- safety: the backup ---------- */

  function buildBackup(host) {
    var r = row('Backup', 'backup');
    refs.backupLine = text();
    r.body.appendChild(refs.backupLine);
    refs.backupGo = button('Back it up', 'btn-sm');
    r.act.appendChild(refs.backupGo);
    dom.on(refs.backupGo, 'click', backUp);
    host.appendChild(r.node);
  }

  function renderBackup(vault) {
    var has = !!vault.custody;
    var backed = vault.backedUp === true;
    var when = dateWords(vault.backedUpAt);
    var words = !has
      ? 'There is nothing to back up until a wallet exists.'
      : backed
        ? 'Backed up. You proved your copy of the phrase' + (when ? ' on ' + when : '') + '.'
        : 'Not backed up yet. The recovery phrase is the only way back to this wallet if this Mac is lost.';
    dom.setText(refs.backupLine, words);
    dom.setHidden(refs.backupGo, !has || backed);
  }

  /* The way through from "not backed up": the phrase's own reveal, whichever
     kind of wallet this is, with the row it happens in brought into view. */
  function backUp() {
    var vault = (store.get() || {}).vault || {};
    focusRecovery();
    if (vault.custody === 'secure-enclave') startReveal();
    else if (window.PhosphorMoneyIn && typeof window.PhosphorMoneyIn.revealWithPassword === 'function') window.PhosphorMoneyIn.revealWithPassword();
  }

  /* ---------- safety: your limits ---------- */

  /* Allowlist entries that are venues rather than addresses. The policy stores
     the id it checks against; the window shows the name a person knows. */
  var VENUE_NAMES = {
    'oneclick:1click.chaindefuser.com': '1Click',
    'intents.near': 'NEAR Intents',
    'hyperliquid-perps': 'Hyperliquid'
  };

  function buildLimits(host) {
    var r = row('Limits', 'rules');
    refs.limits = dom.el('ul', 'vault-rules');
    r.body.appendChild(refs.limits);
    r.body.appendChild(text('vault-sub', 'Ask your assistant to change a limit. Every change waits for your click.'));
    host.appendChild(r.node);
  }

  /* What the app will do, as sentences in the order a person needs them:
     what it asks about, what it refuses, where money may go. Each figure is
     the server's own (src/policy/render.ts), the typed field when there is
     one, so the Vault and the assistant never disagree about a number. A
     rule that is not set is not drawn. */
  function renderLimits(state) {
    var policy = state.policy || {};
    var rules = parseRules(state.sentences || policy.sentences || [], policy);
    var daily = state.dailyLimit;
    var lines = [];
    if (rules.ask) lines.push({ key: 'ask', text: 'Asks you before anything above ' + rules.ask + '.' });
    if (rules.perTx) lines.push({ key: 'once', text: 'Refuses any single move above ' + rules.perTx + '.' });
    if (rules.perDay) {
      var used = '';
      if (daily && daily.capUsd > 0) {
        var spent = Number(daily.spentUsd) || 0;
        used = spent > 0 ? ' ' + usdShort(spent) + ' of it used in the last 24 hours.' : ' Nothing of it used in the last 24 hours.';
      }
      lines.push({ key: 'day', text: 'Refuses more than ' + rules.perDay + ' in any 24 hours.' + used });
    }
    for (var o = 0; o < rules.other.length; o += 1) lines.push({ key: 'other:' + o, text: rules.other[o] });
    var pays = paysLine(policy);
    if (pays) lines.push({ key: 'pays', text: pays });
    if (!lines.length) lines.push({ key: 'none', text: 'No limits are set, so everything your assistant asks for waits for your click.' });

    dom.reconcile(refs.limits, lines, function (line) {
      return line.key;
    }, function () {
      return dom.el('li', 'vault-rule');
    }, function (node, line) {
      dom.setText(node, line.text);
    });
  }

  /* The destination allowlist, as the venues it names and a count of the
     wallets. An address is noise on every day but the one somebody has a
     reason to check it, and the assistant can read it back then. */
  function paysLine(policy) {
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    if (!allow.length) return '';
    var venues = [];
    var wallets = 0;
    for (var a = 0; a < allow.length; a += 1) {
      if (VENUE_NAMES[allow[a]]) venues.push(VENUE_NAMES[allow[a]]);
      else wallets += 1;
    }
    if (wallets) venues.unshift(wallets === 1 ? '1 wallet of yours' : wallets + ' wallets of yours');
    return 'Pays only ' + listWords(venues) + '.';
  }

  /* What the sentences say, by shape. The kill switch is the Freeze row's, and
     a sentence with a shape this row does not know is kept whole. */
  function parseRules(sentences, policy) {
    var out = { ask: '', perTx: '', perDay: '', other: [] };
    for (var i = 0; i < sentences.length; i += 1) {
      var line = String(sentences[i]).trim();
      var found;
      if (/allowed destinations/i.test(line)) continue;
      if ((found = /^ask me before anything above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.ask = found[1];
      else if ((found = /^refuse any single transaction above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.perTx = found[1];
      else if ((found = /^refuse more than (\$[\d,]+(?:\.\d+)?) in any 24 hours\.?$/i.exec(line))) out.perDay = found[1];
      else if (/^kill switch on/i.test(line)) continue;
      else if (line) out.other.push(line);
    }
    /* The typed policy outranks the sentence when both are there, so a number
       never comes from a regex when it can come from a field. */
    var gate = policy && policy.approval;
    if (gate && typeof gate.thresholdUsd === 'number') out.ask = usdShort(gate.thresholdUsd);
    return out;
  }

  function listWords(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* Whole dollars when the figure is whole, cents when it is not. */
  function usdShort(value) {
    var n = Number(value) || 0;
    return dom.usd(n, Math.round(n * 100) % 100 === 0 ? 0 : 2);
  }

  /* ---------- your wallet: the keys ---------- */

  function buildKeys(host) {
    var r = row('Keys', 'custody');
    refs.custodyLine = text();
    refs.custodyMore = text('vault-sub');
    refs.custodyMore.hidden = true;
    refs.custodyReach = text('vault-warn');
    refs.custodyReach.hidden = true;
    r.body.appendChild(refs.custodyLine);
    r.body.appendChild(refs.custodyMore);
    r.body.appendChild(refs.custodyReach);
    refs.migrate = button('Move behind the Secure Enclave', 'btn-sm');
    refs.migrate.hidden = true;
    r.act.appendChild(refs.migrate);
    dom.on(refs.migrate, 'click', function () { openMigrate(false); });
    host.appendChild(r.node);
  }

  function renderCustody(vault) {
    var enclave = vault.enclave || {};
    var custody = vault.custody;

    if (custody === 'secure-enclave') {
      var made = dateWords(enclave.keyMadeAt);
      dom.setText(refs.custodyLine, 'Behind the Secure Enclave on this Mac. Touch ID or your Mac login password opens it.' + (made ? ' Made on ' + made + '.' : ''));
      /* Which of the two bindings is live, in words. An ad-hoc build keeps the
         key as a blob on disk that any process running as you can present. */
      var device = enclave.binding === 'device';
      dom.setText(refs.custodyMore, device ? 'Any process on this Mac can ask for it; a Developer ID build binds the key to Phosphor.' : '');
      dom.setHidden(refs.custodyMore, !device);
      var reach = enclave.attached === false
        ? 'The Secure Enclave is out of reach: Phosphor is running without its desktop shell. Nothing can open this wallet until it is back.'
        : (enclave.ready === false ? 'This Mac cannot authenticate you right now, so the wallet cannot be opened here.' : '');
      dom.setText(refs.custodyReach, reach);
      dom.setHidden(refs.custodyReach, !reach);
      dom.setHidden(refs.migrate, true);
      return;
    }

    if (custody === 'software') {
      dom.setText(refs.custodyLine, 'Locked with your password, on this disk. Anything that learns the password, or reads this disk and guesses it, has them.');
      dom.setText(refs.custodyMore, softwareReason(vault));
      dom.setHidden(refs.custodyMore, false);
      dom.setHidden(refs.custodyReach, true);
      dom.setHidden(refs.migrate, enclave.ready !== true);
      return;
    }

    dom.setText(refs.custodyLine, 'No wallet on this Mac yet. Make one and its keys appear here.');
    dom.setHidden(refs.custodyMore, true);
    dom.setHidden(refs.custodyReach, true);
    dom.setHidden(refs.migrate, true);
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

  /* ---------- your wallet: the recovery phrase ---------- */

  function buildRecovery(host) {
    var r = row('Recovery phrase', 'recovery');
    refs.recoveryRow = r.node;
    refs.recoveryLine = text();
    r.body.appendChild(refs.recoveryLine);
    refs.reveal = button('Reveal', 'btn-sm', 'Waiting for Touch ID');
    refs.restore = button('Restore from a phrase', 'btn-quiet btn-sm');
    /* A password wallet's two doors: the words behind the password, and an
       encrypted copy of the file. */
    refs.revealPassword = button('Show my words', 'btn-sm');
    refs.exportPassword = button('Save an encrypted backup', 'btn-quiet btn-sm');
    /* Two actions each way, so they sit under the words rather than beside
       them, where they would squeeze the sentence into a column. */
    var actions = dom.el('div', 'vault-actions');
    actions.appendChild(refs.reveal);
    actions.appendChild(refs.revealPassword);
    actions.appendChild(refs.restore);
    actions.appendChild(refs.exportPassword);
    r.body.appendChild(actions);
    dom.on(refs.reveal, 'click', startReveal);
    dom.on(refs.restore, 'click', startRestore);
    dom.on(refs.revealPassword, 'click', function () { window.PhosphorMoneyIn.revealWithPassword(); });
    dom.on(refs.exportPassword, 'click', function () { window.PhosphorMoneyIn.exportWithPassword(); });
    refs.recoveryFlow = dom.el('div', 'vault-flow');
    refs.recoveryFlow.hidden = true;
    r.body.appendChild(refs.recoveryFlow);
    host.appendChild(r.node);
  }

  function renderRecovery(vault) {
    var has = !!vault.custody;
    var enclave = vault.custody === 'secure-enclave';
    var noWords = vault.hasMnemonic === false;
    dom.setText(refs.recoveryLine, !has
      ? 'Made with the wallet.'
      : noWords
        ? 'This wallet was brought in as a key, so it has no phrase. Its key file is its backup.'
        : 'The words that bring this wallet back on any Mac. Nobody from Phosphor will ever ask you for them.');
    dom.setHidden(refs.reveal, !enclave || noWords);
    dom.setHidden(refs.restore, !enclave);
    var password = has && !enclave;
    dom.setHidden(refs.revealPassword, !password || noWords);
    dom.setHidden(refs.exportPassword, !password);
  }

  function wipePhrase() {
    phrase = null;
    if (!refs.recoveryFlow) return;
    grow(refs.recoveryRow, function () {
      dom.clear(refs.recoveryFlow);
      refs.recoveryFlow.hidden = true;
      delete refs.recoveryFlow.dataset.step;
    });
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
          if (answer.code !== 'user_cancel') flowProblem(answer.error || 'That did not work.');
          return;
        }
        if (!answer || !Array.isArray(answer.words) || !answer.words.length) {
          flowProblem('No phrase came back.');
          return;
        }
        phrase = { words: answer.words.slice(), paths: answer.paths || null };
        showWords();
      })
      .catch(function (err) { flowProblem(net.readable(err)); })
      .finally(function () {
        window.PhosphorShell.setPending(refs.reveal, false);
        refs.reveal.disabled = !!phrase;
      });
  }

  /* A reveal that failed says so where the words would have been. */
  function flowProblem(words) {
    var flow = refs.recoveryFlow;
    grow(refs.recoveryRow, function () {
      dom.clear(flow);
      flow.hidden = false;
      flow.dataset.step = 'problem';
      flow.appendChild(text('vault-error', words));
    }, flow);
  }

  function showWords() {
    if (!phrase) return;
    grow(refs.recoveryRow, drawWords, refs.recoveryFlow);
  }

  function drawWords() {
    var flow = refs.recoveryFlow;
    dom.clear(flow);
    flow.hidden = false;
    flow.dataset.step = 'words';

    var warn = dom.el('p', 'vault-warn');
    if (window.PhosphorIcons) warn.appendChild(window.PhosphorIcons.svg('lock', 'icon-16'));
    warn.appendChild(dom.el('span', '', 'On this screen only. Anyone who reads these words can take your money.'));
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
      flow.appendChild(text('vault-sub', 'Derivation path, for checking in another wallet: EVM ' + phrase.paths.evm + '.'));
    }

    var tools = dom.el('div', 'vault-actions');
    var print = button('Print', 'btn-ghost btn-sm');
    var wrote = button('I wrote them down', 'btn-sm');
    var done = button('Done', 'btn-quiet btn-sm');
    tools.appendChild(wrote);
    tools.appendChild(print);
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
    grow(refs.recoveryRow, drawProve, refs.recoveryFlow);
  }

  function drawProve() {
    var flow = refs.recoveryFlow;
    dom.clear(flow);
    flow.hidden = false;
    flow.dataset.step = 'prove';

    flow.appendChild(dom.el('p', 'vault-flow-title', 'Prove it'));
    flow.appendChild(text('vault-sub', 'Type three of your words back, by their number, from the copy you made.'));

    var fields = dom.el('div', 'vault-fields');
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
      fields.appendChild(field);
      inputs.push(input);
    });
    flow.appendChild(fields);

    var error = text('vault-error');
    error.hidden = true;
    flow.appendChild(error);

    var tools = dom.el('div', 'vault-actions');
    var prove = button('Prove it', 'btn-sm', 'Checking');
    var back = button('Show the words again', 'btn-quiet btn-sm');
    tools.appendChild(prove);
    tools.appendChild(back);
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
     phrase makes a different one, and asks for a Touch ID before it writes.
     The confirm is a second step in the same place, never a dialog. */
  function startRestore() {
    wipePhrase();
    var flow = refs.recoveryFlow;
    flow.hidden = false;
    flow.dataset.step = 'restore';

    flow.appendChild(dom.el('p', 'vault-flow-title', 'Restore from a phrase'));
    flow.appendChild(text('vault-sub', 'The wallet that phrase makes replaces the one on this Mac. Money stays where it is; only this Mac changes which wallet it holds. 12 or 24 words.'));

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

    var error = text('vault-error');
    error.hidden = true;
    flow.appendChild(error);

    var sure = text('vault-text');
    sure.hidden = true;
    flow.appendChild(sure);

    var tools = dom.el('div', 'vault-actions');
    var go = button('Restore', 'btn-sm', 'Restoring');
    var cancel = button('Cancel', 'btn-quiet btn-sm');
    tools.appendChild(go);
    tools.appendChild(cancel);
    flow.appendChild(tools);

    var asked = false;
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
      if (!asked) {
        asked = true;
        dom.setText(sure, 'This Mac will hold the wallet the phrase makes instead of the one it holds now. Nothing moves. Press Restore again to go ahead.');
        sure.hidden = false;
        return;
      }
      window.PhosphorShell.setPending(go, true);
      api.vaultRestore(words.join(' '))
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
    dom.on(input, 'input', function () {
      asked = false;
      sure.hidden = true;
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

  /* ---------- your wallet: the addresses ---------- */

  function buildAddresses(host) {
    var r = row('Addresses', 'addresses');
    r.node.className += ' vault-row-wide';
    r.body.appendChild(text('vault-sub', 'Pick the network you are sending from. Show the address opens the deposit card, which checks the address before it draws it.'));
    r.body.appendChild(networkSelect());
    refs.tokensHost = dom.el('div', 'vault-tokens');
    r.body.appendChild(refs.tokensHost);
    refs.keyRow = dom.el('div', 'vault-key');
    refs.keyRow.setAttribute('data-dev-only', '');
    r.body.appendChild(refs.keyRow);
    host.appendChild(r.node);
  }

  /* Every network the bridge credits, in the component's own order, so the
     menu and the tiles elsewhere are the same things: the quick ones until
     the report has landed, all of them after. */
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
     listbox of the networks, the same shape as the market menu on Pro rather
     than a native select that draws OS chrome. Arrow keys open it and walk
     it, Enter picks, Escape and a click elsewhere close it. */
  var menuActive = 'eth';

  function networkSelect() {
    var wrap = dom.el('div', 'netsel-wrap');
    var btn = dom.el('button', 'netsel');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'vault-networks');
    btn.setAttribute('aria-label', 'Which network');
    refs.netselMark = dom.el('span', 'netsel-mark');
    btn.appendChild(refs.netselMark);
    refs.netselLabel = dom.el('span', 'netsel-name');
    btn.appendChild(refs.netselLabel);
    btn.appendChild(icon('chevron-down', 'chev-icon'));

    var menu = dom.el('div', 'netsel-menu pop');
    menu.id = 'vault-networks';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Which network');
    menu.tabIndex = -1;

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    refs.netselButton = btn;
    refs.netselMenu = menu;

    dom.on(btn, 'click', function () {
      if (menu.dataset.open === 'true') closeMenu();
      else openMenu();
    });
    dom.on(btn, 'keydown', function (event) {
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
      /* The focus goes back to the button unless the click gave it to something else. */
      var active = document.activeElement;
      closeMenu(!active || active === document.body || within(active, wrap));
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

  function closeMenu(returnFocus) {
    var menu = refs.netselMenu;
    if (!menu) return;
    delete menu.dataset.open;
    dom.setAttr(refs.netselButton, 'aria-expanded', 'false');
    if (returnFocus !== false && refs.netselButton && refs.netselButton.focus) refs.netselButton.focus();
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
    pick.render(refs.tokensHost, {
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
      host.appendChild(text('vault-sub', 'This wallet has no key of its own on ' + n.name + '. Money sent there arrives through the bridge address above.'));
      return;
    }
    if (!chain || !chain.address) {
      host.appendChild(text('vault-sub', addresses && addresses.tampered
        ? 'The wallet file has been edited, so no address in it can be trusted.'
        : 'No wallet on this Mac yet.'));
      return;
    }
    var verified = addresses.verified === true;
    host.appendChild(text('vault-sub', verified
      ? 'Verified. Your account id on NEAR Intents and Hyperliquid.'
      : 'Not verified yet. Read from the file, not from your keys; it is verified once this Mac opens the wallet.'));
    host.appendChild(chunked(chain.address));
    if (verified) {
      var tools = dom.el('div', 'vault-actions');
      var said = dom.el('span', 'vault-sub');
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

  /* ---------- your wallet: forget ---------- */

  /* Forget is two deliberate acts and a Touch ID: open the step, type the
     word, press. It is refused until the phrase is proven backed up, so
     nothing about it is a loss, and nothing about it is red. */
  function buildForget(host) {
    var r = row('Forget', 'danger');
    r.body.appendChild(text('vault-text', 'Forget this wallet on this Mac. The file is shredded; your recovery phrase brings it back, here or on any Mac. Refused until the phrase is proven backed up.'));
    refs.forgetOpen = button('Forget this wallet', 'btn-quiet btn-sm');
    r.act.appendChild(refs.forgetOpen);

    var step = dom.el('div', 'vault-confirm');
    step.hidden = true;
    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Type FORGET to confirm'));
    refs.forgetInput = dom.el('input', 'input');
    refs.forgetInput.type = 'text';
    refs.forgetInput.name = 'forget';
    refs.forgetInput.autocomplete = 'off';
    refs.forgetInput.spellcheck = false;
    refs.forgetInput.setAttribute('autocapitalize', 'characters');
    field.appendChild(refs.forgetInput);
    step.appendChild(field);
    refs.forgetError = text('vault-error');
    refs.forgetError.hidden = true;
    step.appendChild(refs.forgetError);
    var actions = dom.el('div', 'vault-actions');
    refs.forget = button('Forget it', 'btn-sm', 'Waiting for Touch ID');
    refs.forget.disabled = true;
    var keep = button('Cancel', 'btn-quiet btn-sm');
    actions.appendChild(refs.forget);
    actions.appendChild(keep);
    step.appendChild(actions);
    r.body.appendChild(step);
    refs.forgetStep = step;

    dom.on(refs.forgetOpen, 'click', function () {
      grow(r.node, function () {
        dom.setHidden(step, false);
        dom.setHidden(refs.forgetOpen, true);
        refs.forgetInput.focus();
      }, step);
    });
    dom.on(keep, 'click', closeForget);
    dom.on(refs.forgetInput, 'input', function () {
      refs.forget.disabled = refs.forgetInput.value.trim() !== 'FORGET';
    });
    dom.on(refs.forget, 'click', forgetWallet);
    refs.forgetRow = r.node;
    host.appendChild(r.node);
  }

  function closeForget() {
    refs.forgetInput.value = '';
    refs.forget.disabled = true;
    shrink(refs.forgetRow, refs.forgetStep, function () {
      dom.setHidden(refs.forgetError, true);
      dom.setHidden(refs.forgetStep, true);
      dom.setHidden(refs.forgetOpen, false);
      if (refs.forgetOpen.focus) refs.forgetOpen.focus();
    }, refs.forgetOpen);
  }

  function forgetWallet() {
    if (refs.forgetInput.value.trim() !== 'FORGET') return;
    refs.forgetError.hidden = true;
    window.PhosphorShell.setPending(refs.forget, true);
    api.vaultForget()
      .then(function (answer) {
        if (answer && answer.ok === false) {
          dom.setText(refs.forgetError, answer.code === 'not_backed_up'
            ? 'Refused: the phrase is not proven backed up. Reveal it and type three words back first.'
            : (answer.code === 'user_cancel' ? 'Touch ID was cancelled. Nothing changed.' : (answer.error || 'That did not work.')));
          refs.forgetError.hidden = false;
          return;
        }
        closeForget();
        window.PhosphorToast.show('This Mac has forgotten the wallet.');
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) {
        dom.setText(refs.forgetError, net.readable(err));
        refs.forgetError.hidden = false;
      })
      .finally(function () { window.PhosphorShell.setPending(refs.forget, false); });
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted) return;
    var state = store.get() || {};
    var vault = state.vault || {};
    renderFreeze(state);
    renderIdle(vault, state.lock);
    renderBackup(vault);
    renderLimits(state);
    renderCustody(vault);
    renderRecovery(vault);
    dom.setHidden(refs.forgetRow, !vault.custody);
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

  /* ---------- migration ---------- */

  /* Once at boot, for a password wallet on a Mac whose enclave is ready and
     whose window is open. Dismissable, and the Keys row keeps the button. */
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

    var error = dom.el('p', 'body');
    error.hidden = true;
    form.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var later = button(atBoot ? 'Not now' : 'Cancel', 'btn-ghost');
    var go = dom.el('button', 'btn btn-lg');
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
    var pageNode = document.getElementById('page');
    if (!pageNode) return;
    if ('inert' in pageNode) pageNode.inert = on;
    dom.setAttr(pageNode, 'aria-hidden', on ? 'true' : null);
  }

  /* ---------- from outside ---------- */

  function focusRecovery() {
    if (!refs.recoveryRow) return;
    if (typeof refs.recoveryRow.scrollIntoView === 'function') {
      refs.recoveryRow.scrollIntoView({ block: 'center', behavior: window.PhosphorMotion && window.PhosphorMotion.reduced() ? 'auto' : 'smooth' });
    }
    if (refs.reveal && !refs.reveal.hidden) refs.reveal.focus();
    else if (refs.revealPassword && !refs.revealPassword.hidden) refs.revealPassword.focus();
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
