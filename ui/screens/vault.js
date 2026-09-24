/* The Vault: who drives, what keeps the money safe, and the wallet itself.

   The conversation stays on the left, where it is on every mode, and the
   Vault is the wide right side Pro has (ui/design/pro.css), so switching
   between the two moves nothing. Three sections:

     Your assistant   one tile per agent with its state on this Mac and one
                      action, Use (the list is ui/screens/firstrun.js's
                      PhosphorAgentPick, loaded with it)
     Safety           freeze, the lock timer, the recovery phrase and your
                      limits, beside the assistant when the Vault is wide
     Your wallet      the keys, restore, the addresses, forget

   Every row is a tile: its name and one line on the left, its value or its
   one action on the right, and anything it opens (a confirm, a flow) grows
   in place under the words, never a dialog. The only red on the page is the
   confirm step of Freeze.

   Everything here reads off the state's `vault` and `policy` slices and the
   two address routes; nothing here draws a key. The one secret that ever
   reaches this screen is the recovery phrase, shown once behind a fresh Touch
   ID or the password, held in this file's memory until Done, and wiped the
   moment the window locks or the person leaves the tab.

   Karim, 2026-09-15: "I hate how the vault has to be so scrollable, make it
   wider, make the info easier to read." So the assistant and safety sit side
   by side, the limits are one tile, and the token list under the network
   menu stays folded until a network is picked. */
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
  var ASK_CHOICES = [25, 100, 500, 1000];
  var PROVE_COUNT = 3;

  /* What the freeze does, from the code that runs it (src/main.ts setKill and
     src/runner/host.ts stopAll): every open position on the trading account is
     closed at the market price, every plan stops, and every write is refused
     until it is turned off. The bar's panel (ui/screens/shell.js) says the same
     thing, so the two ways to the same switch never disagree. */
  var FREEZE = {
    off: {
      line: 'Stops every move at once.',
      ask: 'This closes your open trading positions at the market price and stops every plan. Nothing can move your money until you unfreeze.',
      open: 'Freeze everything',
      keep: 'Cancel',
      go: 'Freeze everything',
      pending: 'Freezing'
    },
    on: {
      line: 'Everything is frozen. The assistant cannot move any money until you unfreeze.',
      ask: 'Your assistant can ask to move money again the moment you unfreeze. Positions the freeze closed stay closed.',
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
  var tokensOpen = false;
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
        closeForget(false);
      }
    });
    /* Escape puts away whatever is open in a row, wherever the focus is: a
       click on the tile's own words leaves the focus on the page, not in the
       step. Anything else that took the key first (the bar's freeze panel, a
       menu) has already said so. */
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || event.defaultPrevented || !visible) return;
      if (refs.freezeConfirm && !refs.freezeConfirm.hidden) {
        event.preventDefault();
        closeFreeze(true);
      } else if (refs.forgetStep && !refs.forgetStep.hidden) {
        event.preventDefault();
        closeForget(true);
      } else if (refs.askEdit && !refs.askEdit.hidden) {
        event.preventDefault();
        closeAsk(true);
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

  /* A row is a tile: its name and one line on the left, its value or its
     action on the right, and anything it opens under both. */
  function row(title, surface) {
    var node = dom.el('div', 'vault-row');
    if (surface) node.dataset.surface = surface;
    var main = dom.el('div', 'vault-row-main');
    var head = dom.el('div', 'vault-row-head');
    var name = dom.el('h3', 'vault-row-title', title);
    head.appendChild(name);
    main.appendChild(head);
    node.appendChild(main);
    var act = dom.el('div', 'vault-row-act');
    node.appendChild(act);
    var body = dom.el('div', 'vault-row-body');
    node.appendChild(body);
    return { node: node, main: main, head: head, title: name, act: act, body: body };
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

  function icon(name, className) {
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') return icons.svg(name, className);
    return null;
  }

  /* The freeze glyph is the bar's own symbol (ui/index.html #i-freeze), drawn
     on the icon set's grid; nothing is drawn where there is no svg to build. */
  function freezeGlyph(className) {
    if (typeof document.createElementNS !== 'function') return null;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-freeze');
    svg.appendChild(use);
    return svg;
  }

  function append(parent, child) {
    if (child) parent.appendChild(child);
    return child;
  }

  /* An error inside a row: the warning glyph and the sentence, so it never
     reads as the row's own line. */
  function problem() {
    var node = dom.el('p', 'vault-error');
    node.setAttribute('role', 'alert');
    append(node, icon('warning', 'vault-error-icon'));
    node.appendChild(dom.el('span', 'vault-error-text'));
    node.hidden = true;
    return node;
  }

  function say(node, words) {
    var slot = node.querySelector('.vault-error-text') || node;
    dom.setText(slot, words || '');
    dom.setHidden(node, !words);
  }

  function build(host) {
    var page = dom.el('div', 'vault');
    var top = dom.el('div', 'vault-top');

    /* Your assistant */
    var agent = section('Your assistant', 'agent');
    refs.agentAgain = button('Check again', 'btn-quiet btn-sm', 'Checking');
    agent.head.appendChild(refs.agentAgain);
    dom.on(refs.agentAgain, 'click', function () {
      if (agents && typeof agents.scan === 'function') agents.scan(true, refs.agentAgain);
    });
    refs.agentLead = text('vault-lead');
    agent.body.appendChild(refs.agentLead);
    refs.agentHost = dom.el('div', 'vault-agents');
    agent.body.appendChild(refs.agentHost);
    refs.agentWait = text('vault-text dim', 'Checking which assistants are on this Mac.');
    refs.agentHost.appendChild(refs.agentWait);
    renderAgentLead(null);
    top.appendChild(agent.node);

    /* Safety */
    var safety = section('Safety', 'safety');
    buildFreeze(safety.body);
    buildLock(safety.body);
    buildBackup(safety.body);
    buildLimits(safety.body);
    top.appendChild(safety.node);
    page.appendChild(top);

    /* Your wallet */
    var wallet = section('Your wallet', 'wallet');
    wallet.body.className += ' vault-grid';
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
      agents = Pick.render(refs.agentHost, {
        context: 'vault',
        again: false,
        onState: function (s) { renderAgentLead(s ? s.agent : null); }
      });
    });
  }

  /* The line under the title names the one in use, so the section answers
     "who drives" before a row is read. */
  function renderAgentLead(id) {
    if (!refs.agentLead) return;
    var Pick = window.PhosphorAgentPick;
    var list = Pick && Array.isArray(Pick.AGENTS) ? Pick.AGENTS : [];
    var name = '';
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) name = list[i].name;
    }
    var reach = 'It sees your balances and addresses, never your keys or your phrase.';
    dom.setText(refs.agentLead, name && id !== 'mcp' && id !== 'desktop'
      ? name + ' is your assistant. ' + reach
      : (id === 'mcp' ? 'An agent of your own is your assistant. ' + reach : 'Pick the one you already use. ' + reach));
  }

  /* ---------- safety: freeze ---------- */

  function buildFreeze(host) {
    var r = row('Freeze', 'freeze');
    refs.freezeGlyph = append(r.head, freezeGlyph('vault-row-glyph'));
    if (refs.freezeGlyph) r.head.insertBefore(refs.freezeGlyph, r.title);
    refs.freezeLine = text();
    r.main.appendChild(refs.freezeLine);
    refs.freezeOpen = button(FREEZE.off.open, 'btn-ghost btn-sm vault-freeze-open');
    var glyph = freezeGlyph();
    if (glyph) refs.freezeOpen.insertBefore(glyph, refs.freezeOpen.firstChild);
    r.act.appendChild(refs.freezeOpen);

    /* The confirm step, under the words, never a dialog. Cancel is focused,
       so Enter on an open step does the harmless thing. */
    var confirm = dom.el('div', 'vault-confirm');
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-label', 'Freeze everything');
    confirm.hidden = true;
    refs.freezeAsk = text('vault-confirm-text');
    confirm.appendChild(refs.freezeAsk);
    var actions = dom.el('div', 'vault-actions');
    refs.freezeKeep = button(FREEZE.off.keep, 'btn-quiet btn-sm');
    refs.freezeGo = button(FREEZE.off.go, 'btn-danger btn-sm', FREEZE.off.pending);
    actions.appendChild(refs.freezeKeep);
    actions.appendChild(refs.freezeGo);
    confirm.appendChild(actions);
    refs.freezeError = problem();
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
    dom.setAttr(refs.freezeRow, 'data-frozen', frozen ? 'true' : null);
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
      say(refs.freezeError, '');
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
      .catch(function (err) { say(refs.freezeError, net.readable(err)); })
      .finally(function () { window.PhosphorShell.setPending(refs.freezeGo, false); });
  }

  /* ---------- safety: the lock ---------- */

  function buildLock(host) {
    var r = row('Locks after', 'window');
    r.main.appendChild(text('vault-text', 'The window locks after this long without you and hides everything until you open it.'));
    refs.lockNow = button('Lock now', 'btn-quiet btn-sm', 'Locking');
    /* The glyph and the word share one face: a button that can wait stacks its
       children in one cell (components.css), so a glyph beside the label
       would sit on top of it. */
    var glyph = icon('lock');
    if (glyph) {
      var face = dom.el('span', 'btn-face');
      var word = refs.lockNow.firstChild;
      refs.lockNow.insertBefore(face, word);
      face.appendChild(glyph);
      face.appendChild(word);
    }
    r.act.appendChild(refs.lockNow);
    dom.on(refs.lockNow, 'click', lockNow);

    /* Three choices as one segmented control in a well, the current one on a
       raised thumb. A radio group: one stop in the tab order, the arrows walk
       it and choose. */
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
      dom.on(c, 'keydown', function (event) { walkIdle(event, choice.minutes); });
      refs.idleChoices[choice.minutes] = c;
      refs.idle.appendChild(c);
    });
    r.body.appendChild(refs.idle);
    host.appendChild(r.node);
  }

  function walkIdle(event, minutes) {
    var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!keys[event.key]) return;
    event.preventDefault();
    var at = 0;
    for (var i = 0; i < IDLE_CHOICES.length; i += 1) {
      if (IDLE_CHOICES[i].minutes === minutes) at = i;
    }
    var next = IDLE_CHOICES[(at + keys[event.key] + IDLE_CHOICES.length) % IDLE_CHOICES.length];
    var cell = refs.idleChoices[next.minutes];
    if (cell && cell.focus) cell.focus();
    setIdle(next.minutes, cell);
  }

  function renderIdle(vault, lock) {
    var minutes = typeof vault.idleMinutes === 'number' ? vault.idleMinutes : null;
    var any = false;
    IDLE_CHOICES.forEach(function (choice) {
      if (minutes === choice.minutes) any = true;
    });
    IDLE_CHOICES.forEach(function (choice, i) {
      var cell = refs.idleChoices[choice.minutes];
      var on = minutes === choice.minutes;
      dom.setAttr(cell, 'aria-checked', on ? 'true' : 'false');
      /* Roving: the chosen cell is the group's one tab stop, the first when
         none is chosen. */
      cell.tabIndex = on || (!any && i === 0) ? 0 : -1;
    });
    dom.setHidden(refs.lockNow, !(lock && lock.state === 'unlocked'));
  }

  function setIdle(minutes, node) {
    var vault = (store.get() || {}).vault || {};
    if (vault.idleMinutes === minutes) return;
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

  /* ---------- safety: the recovery phrase ----------

     The backup is the phrase's own row: its state, and the one way through
     from "not backed up", which is the same for both kinds of wallet. The
     words are shown here, in place, behind a fresh Touch ID or the password
     typed into the row itself, then three of them are typed back and the app
     checks them against the phrase it holds. Nothing about the phrase ever
     goes into the conversation. */
  function buildBackup(host) {
    var r = row('Recovery phrase', 'backup');
    refs.backupRow = r.node;
    refs.backupState = dom.el('p', 'vault-text vault-backup-line');
    refs.backupMark = append(refs.backupState, icon('shield', 'vault-backup-mark'));
    refs.backupLine = dom.el('span', 'vault-backup-words');
    refs.backupState.appendChild(refs.backupLine);
    r.main.appendChild(refs.backupState);
    refs.backupGo = button('Back it up', 'btn-sm', 'Waiting for Touch ID');
    r.act.appendChild(refs.backupGo);
    dom.on(refs.backupGo, 'click', startReveal);
    refs.phraseFlow = dom.el('div', 'vault-flow');
    refs.phraseFlow.hidden = true;
    r.body.appendChild(refs.phraseFlow);
    host.appendChild(r.node);
  }

  function renderBackup(vault) {
    var has = !!vault.custody;
    var backed = vault.backedUp === true;
    var noWords = vault.hasMnemonic === false;
    var when = dateWords(vault.backedUpAt);
    var words = !has
      ? 'There is nothing to back up until a wallet exists.'
      : noWords
        ? 'This wallet was brought in as a key, so it has no phrase. Its key file is its backup.'
        : backed
          ? 'Backed up. You proved your copy' + (when ? ' on ' + when : '') + '.'
          : 'Not backed up yet. It is the only way back to this wallet if this Mac is lost.';
    dom.setText(refs.backupLine, words);
    dom.setAttr(refs.backupState, 'data-backed', has && backed && !noWords ? 'true' : null);
    if (refs.backupMark) dom.setAttr(refs.backupMark, 'data-hidden', has && backed && !noWords ? null : 'true');
    var enclave = vault.custody === 'secure-enclave';
    dom.setText(refs.backupGo.querySelector('.btn-label'), backed ? 'Show my words' : 'Back it up');
    dom.setAttr(refs.backupGo, 'data-pending-label', enclave ? 'Waiting for Touch ID' : 'Opening');
    refs.backupGo.className = backed ? 'btn btn-ghost btn-sm' : 'btn btn-sm';
    dom.setHidden(refs.backupGo, !has || noWords || !!phrase || !refs.phraseFlow.hidden);
  }

  function wipePhrase() {
    phrase = null;
    if (!refs.phraseFlow) return;
    if (!refs.phraseFlow.hidden || refs.phraseFlow.childNodes.length) {
      shrink(refs.backupRow, refs.phraseFlow, function () {
        dom.clear(refs.phraseFlow);
        refs.phraseFlow.hidden = true;
        delete refs.phraseFlow.dataset.step;
        render();
      }, refs.backupGo);
    }
    if (refs.backupGo) refs.backupGo.disabled = false;
  }

  /* The way in, from this row, the notice, the deposit card's reminder and
     the first money landing: Touch ID for an enclave wallet, the password
     typed here for a password wallet. */
  function startReveal() {
    if (!mounted) return;
    if (window.PhosphorShell.view && window.PhosphorShell.view() !== 'vault') window.PhosphorShell.setView('vault', { fromClick: true });
    var state = store.get() || {};
    var vault = state.vault || {};
    if (!vault.custody || vault.hasMnemonic === false) return;
    bringIntoView(refs.backupRow);
    if (vault.custody === 'secure-enclave') revealWithTouch();
    else askPassword('words');
  }

  function revealWithTouch() {
    phrase = null;
    refs.backupGo.disabled = true;
    window.PhosphorShell.setPending(refs.backupGo, true);
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
        window.PhosphorShell.setPending(refs.backupGo, false);
        refs.backupGo.disabled = false;
        render();
      });
  }

  /* A password wallet's way to its words: the password, typed into the row
     at the moment of the reveal and held nowhere. A control that shows a key
     on one click because a password was typed ten minutes ago is a key an
     unattended window hands out. */
  function askPassword(purpose) {
    var flow = refs.phraseFlow;
    grow(refs.backupRow, function () {
      dom.clear(flow);
      flow.hidden = false;
      flow.dataset.step = 'password';
      render();
      var form = dom.el('form', 'vault-form');
      form.appendChild(text('vault-sub', purpose === 'words'
        ? 'Type your password to see your recovery phrase. It shows here once and is not saved anywhere.'
        : 'Type your password.'));
      var field = dom.el('div', 'field');
      field.appendChild(dom.el('label', 'label', 'Password'));
      var input = dom.el('input', 'input');
      input.type = 'password';
      input.name = 'password';
      input.autocomplete = 'current-password';
      field.appendChild(input);
      form.appendChild(field);
      var error = problem();
      form.appendChild(error);
      var tools = dom.el('div', 'vault-actions');
      var go = dom.el('button', 'btn btn-sm');
      go.type = 'submit';
      go.appendChild(dom.el('span', 'btn-label', 'Show my words'));
      dom.setAttr(go, 'data-pending-label', 'Checking');
      var cancel = button('Cancel', 'btn-quiet btn-sm');
      tools.appendChild(go);
      tools.appendChild(cancel);
      form.appendChild(tools);
      flow.appendChild(form);

      dom.on(cancel, 'click', wipePhrase);
      dom.on(form, 'submit', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        var password = input.value;
        if (!password) {
          say(error, 'Type your password first.');
          return;
        }
        say(error, '');
        window.PhosphorShell.setPending(go, true);
        api.revealStart(password, 'mnemonic')
          .then(function (answer) {
            if (answer && answer.ok === false) throw Object.assign(new Error(answer.error || 'That did not work.'), { code: answer.code });
            return api.revealFetch(answer.nonce);
          })
          .then(function (material) {
            input.value = '';
            var words = material && Array.isArray(material.mnemonic) ? material.mnemonic : [];
            if (!words.length) throw new Error('No phrase came back.');
            phrase = { words: words.slice(), paths: null };
            showWords();
          })
          .catch(function (err) {
            input.value = '';
            say(error, err && err.code === 'wrong_password' ? 'That password is wrong.' : net.readable(err));
            if (input.focus) input.focus();
          })
          .finally(function () { window.PhosphorShell.setPending(go, false); });
      });
      if (input.focus) input.focus();
    }, flow);
  }

  /* A reveal that failed says so where the words would have been. */
  function flowProblem(words) {
    var flow = refs.phraseFlow;
    grow(refs.backupRow, function () {
      dom.clear(flow);
      flow.hidden = false;
      flow.dataset.step = 'problem';
      var error = problem();
      flow.appendChild(error);
      say(error, words);
      var close = button('Close', 'btn-quiet btn-sm');
      dom.on(close, 'click', wipePhrase);
      var tools = dom.el('div', 'vault-actions');
      tools.appendChild(close);
      flow.appendChild(tools);
      render();
    }, flow);
  }

  function showWords(note) {
    if (!phrase) return;
    grow(refs.backupRow, function () { drawWords(note); }, refs.phraseFlow);
  }

  function drawWords(note) {
    var flow = refs.phraseFlow;
    dom.clear(flow);
    flow.hidden = false;
    flow.dataset.step = 'words';
    render();

    var warn = dom.el('p', 'vault-warn');
    append(warn, icon('lock', 'icon-16'));
    warn.appendChild(dom.el('span', '', 'On this screen only. Anyone who reads these words can take your money.'));
    flow.appendChild(warn);

    if (note) {
      var again = problem();
      flow.appendChild(again);
      say(again, note);
    }

    var grid = dom.el('ol', 'words vault-words');
    for (var i = 0; i < phrase.words.length; i += 1) {
      var item = dom.el('li', 'word');
      item.appendChild(dom.el('span', 'meta num', String(i + 1)));
      item.appendChild(dom.el('span', 'body word-text', phrase.words[i]));
      grid.appendChild(item);
    }
    flow.appendChild(grid);

    /* For checking the words in another wallet, a developer's line. */
    if (phrase.paths && phrase.paths.evm) {
      var path = text('vault-sub', 'Derivation path, for checking in another wallet: EVM ' + phrase.paths.evm + '.');
      path.setAttribute('data-dev-only', '');
      flow.appendChild(path);
    }

    var tools = dom.el('div', 'vault-actions');
    var wrote = button('I wrote them down', 'btn-sm');
    var print = button('Print', 'btn-ghost btn-sm');
    var done = button('Done', 'btn-quiet btn-sm');
    tools.appendChild(wrote);
    tools.appendChild(print);
    tools.appendChild(done);
    flow.appendChild(tools);

    dom.on(print, 'click', function () { printPhrase(phrase ? phrase.words : []); });
    dom.on(wrote, 'click', showProve);
    dom.on(done, 'click', wipePhrase);
    if (wrote.focus) wrote.focus();
  }

  /* A sheet with nothing on it but the numbered words. The stylesheet hides
     the rest of the window while it prints and the sheet is removed after.
     The first run prints through the same function. */
  function printPhrase(words) {
    if (!words || !words.length) return;
    var sheet = dom.el('div', 'print-sheet');
    sheet.appendChild(dom.el('h1', '', 'Phosphor recovery phrase'));
    sheet.appendChild(dom.el('p', '', 'Anyone who has these words has the money. Keep this sheet somewhere that is not near your computer.'));
    var list = dom.el('ol', '');
    for (var i = 0; i < words.length; i += 1) list.appendChild(dom.el('li', '', words[i]));
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
     "not backed up"; a miss says so and reveals nothing about which word. Two
     misses show the words again. */
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
    grow(refs.backupRow, drawProve, refs.phraseFlow);
  }

  function drawProve() {
    var flow = refs.phraseFlow;
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

    var error = problem();
    flow.appendChild(error);

    var tools = dom.el('div', 'vault-actions');
    var prove = button('Prove it', 'btn-sm', 'Checking');
    var back = button('Show the words again', 'btn-quiet btn-sm');
    tools.appendChild(prove);
    tools.appendChild(back);
    flow.appendChild(tools);

    var misses = 0;
    dom.on(back, 'click', function () { showWords(); });
    dom.on(prove, 'click', function () {
      var words = [];
      for (var i = 0; i < inputs.length; i += 1) {
        var value = inputs[i].value.trim().toLowerCase();
        if (!value) {
          say(error, 'Type all three words.');
          return;
        }
        words.push({ index: Number(inputs[i].dataset.index), word: value });
      }
      say(error, '');
      window.PhosphorShell.setPending(prove, true);
      api.vaultBackupProven(words)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            if (answer.code === 'wrong_words') {
              misses += 1;
              if (misses >= 2) {
                showWords('Two tries did not match. Check your copy, then try again.');
                return;
              }
              say(error, 'Those words do not match. Look at your copy again.');
              return;
            }
            say(error, answer.error || 'That did not work.');
            return;
          }
          wipePhrase();
          window.PhosphorToast.show('Backed up. Your copy of the phrase is right.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) { say(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(prove, false); });
    });
    if (inputs[0] && inputs[0].focus) inputs[0].focus();
  }

  /* ---------- safety: your limits ---------- */

  /* Allowlist entries that are the app's own services rather than addresses.
     The policy stores the id it checks against; the window names what each
     one is for. */
  var SERVICE_NAMES = {
    'oneclick:1click.chaindefuser.com': 'your swaps',
    'intents.near': 'your swaps',
    'hyperliquid-perps': 'your trading account'
  };

  function ruleLine(key) {
    var item = dom.el('li', 'vault-rule');
    item.dataset.rule = key;
    var top = dom.el('div', 'vault-rule-top');
    top.appendChild(dom.el('span', 'vault-rule-label'));
    top.appendChild(dom.el('span', 'vault-rule-value num'));
    item.appendChild(top);
    item.appendChild(dom.el('p', 'vault-rule-note'));
    return item;
  }

  function paintRule(node, line) {
    var top = node.querySelector('.vault-rule-top');
    dom.setText(node.querySelector('.vault-rule-label'), line.label);
    dom.setText(node.querySelector('.vault-rule-value'), line.value);
    dom.setHidden(top, !line.label && !line.value);
    dom.setText(node.querySelector('.vault-rule-note'), line.note);
    dom.setAttr(node, 'data-sentence', line.label ? null : 'true');
  }

  function buildLimits(host) {
    var r = row('Limits', 'rules');
    refs.limitsRow = r.node;

    /* The ask line is the one a person can change here, so its editor opens
       right under it; the rest of the rules follow in the same list. */
    var list = dom.el('ul', 'vault-rules');
    refs.askRule = ruleLine('ask');
    refs.askChange = button('Change', 'btn-quiet btn-sm vault-rule-change');
    refs.askChange.setAttribute('aria-label', 'Change when it asks you');
    refs.askRule.querySelector('.vault-rule-top').appendChild(refs.askChange);
    dom.on(refs.askChange, 'click', openAsk);
    list.appendChild(refs.askRule);
    r.body.appendChild(list);

    /* The ask line's own editor, in place: the field and the four amounts
       the first run offers. Saving is the person's own click, so a looser
       figure is as much theirs as a stricter one. */
    var edit = dom.el('form', 'vault-confirm vault-ask');
    edit.hidden = true;
    edit.appendChild(dom.el('p', 'vault-confirm-text', 'Anything above this waits for your click.'));
    var line = dom.el('div', 'vault-ask-line');
    var well = dom.el('label', 'vault-money');
    well.appendChild(dom.el('span', 'vault-money-sign', '$'));
    refs.askInput = dom.el('input', 'vault-money-input num');
    refs.askInput.type = 'text';
    refs.askInput.inputMode = 'decimal';
    refs.askInput.name = 'ask-above';
    refs.askInput.autocomplete = 'off';
    refs.askInput.setAttribute('aria-label', 'Ask above, in dollars');
    well.appendChild(refs.askInput);
    line.appendChild(well);
    refs.askChips = dom.el('div', 'vault-chips');
    refs.askChips.setAttribute('role', 'radiogroup');
    refs.askChips.setAttribute('aria-label', 'Common amounts');
    ASK_CHOICES.forEach(function (value) {
      var chip = dom.el('button', 'vault-chip num');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', 'false');
      chip.dataset.value = String(value);
      chip.appendChild(dom.el('span', '', usdShort(value)));
      dom.on(chip, 'click', function () {
        refs.askInput.value = String(value);
        markAsk();
      });
      refs.askChips.appendChild(chip);
    });
    line.appendChild(refs.askChips);
    edit.appendChild(line);
    refs.askError = problem();
    edit.appendChild(refs.askError);
    var tools = dom.el('div', 'vault-actions');
    refs.askSave = dom.el('button', 'btn btn-sm');
    refs.askSave.type = 'submit';
    refs.askSave.appendChild(dom.el('span', 'btn-label', 'Save'));
    dom.setAttr(refs.askSave, 'data-pending-label', 'Saving');
    var cancel = button('Cancel', 'btn-quiet btn-sm');
    tools.appendChild(refs.askSave);
    tools.appendChild(cancel);
    edit.appendChild(tools);
    r.body.appendChild(edit);
    refs.askEdit = edit;

    dom.on(refs.askInput, 'input', markAsk);
    dom.on(cancel, 'click', function () { closeAsk(true); });
    dom.on(edit, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeAsk(true);
    });
    dom.on(edit, 'submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      saveAsk();
    });
    refs.limits = dom.el('ul', 'vault-rules');
    r.body.appendChild(refs.limits);
    host.appendChild(r.node);
  }

  /* The chips follow the field: the one whose amount is typed is chosen. */
  function markAsk() {
    var typed = moneyOf(refs.askInput.value);
    var chips = refs.askChips.querySelectorAll('.vault-chip');
    for (var i = 0; i < chips.length; i += 1) {
      var on = typed !== null && Number(chips[i].dataset.value) === typed;
      dom.setAttr(chips[i], 'aria-checked', on ? 'true' : 'false');
    }
  }

  function moneyOf(value) {
    var n = Number(String(value || '').replace(/[$,\s]/g, ''));
    return String(value || '').trim() !== '' && isFinite(n) ? n : null;
  }

  function openAsk() {
    var policy = (store.get() || {}).policy || {};
    var now = policy.outbound && typeof policy.outbound.humanClickAboveUsd === 'number'
      ? policy.outbound.humanClickAboveUsd
      : (policy.approval && typeof policy.approval.thresholdUsd === 'number' ? policy.approval.thresholdUsd : null);
    refs.askInput.value = now === null ? '' : String(now);
    markAsk();
    grow(refs.limitsRow, function () {
      say(refs.askError, '');
      dom.setHidden(refs.askEdit, false);
      if (refs.askChange) dom.setHidden(refs.askChange, true);
      if (refs.askInput.focus) refs.askInput.focus();
    }, refs.askEdit);
  }

  function closeAsk(returnFocus) {
    if (!refs.askEdit || refs.askEdit.hidden) return;
    shrink(refs.limitsRow, refs.askEdit, function () {
      dom.setHidden(refs.askEdit, true);
      if (refs.askChange) {
        dom.setHidden(refs.askChange, false);
        if (returnFocus && refs.askChange.focus) refs.askChange.focus();
      }
    }, refs.askChange);
  }

  function saveAsk() {
    var value = moneyOf(refs.askInput.value);
    if (value === null || value <= 0) {
      say(refs.askError, 'Type a number of dollars above 0.');
      return;
    }
    if (!net || typeof net.postJson !== 'function') return;
    say(refs.askError, '');
    window.PhosphorShell.setPending(refs.askSave, true);
    net.postJson('/api/policy/threshold', { usd: value })
      .then(function (answer) {
        if (!answer || answer.ok !== true) throw new Error('not saved');
        return Promise.resolve(window.PhosphorShell.refresh({})).then(function () { closeAsk(true); });
      })
      .catch(function (err) {
        /* The route's refusals are written for a person, one sentence with
           the figures; anything else is the app not answering. */
        var own = err && (err.status === 400 || err.status === 409) && err.message;
        say(refs.askError, own ? err.message : 'Phosphor could not save that. Try again.');
      })
      .finally(function () { window.PhosphorShell.setPending(refs.askSave, false); });
  }

  /* What the app will do, in the order a person needs it: what it asks
     about, what it refuses, where money may go. Each figure is the policy's
     own field where there is one and the server's sentence (src/policy/
     render.ts) where there is not, so the Vault and the assistant never
     disagree about a number. A rule that is not set is not drawn. */
  function renderLimits(state) {
    var policy = state.policy || {};
    var rules = parseRules(state.sentences || policy.sentences || [], policy);
    var daily = state.dailyLimit;
    paintRule(refs.askRule, { label: 'Asks you above', value: rules.ask, note: 'Anything above this waits for your click.' });
    dom.setHidden(refs.askRule, !rules.ask);
    var lines = [];
    if (rules.perTx) lines.push({ key: 'once', label: 'Largest move', value: rules.perTx, note: 'Anything above this is refused.' });
    if (rules.perDay) {
      var note = 'Refuses more than this in any 24 hours.';
      if (daily && daily.capUsd > 0) {
        var spent = Number(daily.spentUsd) || 0;
        note = spent > 0 ? usdShort(spent) + ' of it used in the last 24 hours.' : 'None of it used in the last 24 hours.';
      }
      lines.push({ key: 'day', label: 'In any 24 hours', value: rules.perDay, note: note });
    }
    if (rules.auto) lines.push({ key: 'auto', label: 'Without asking', value: rules.auto, note: 'Moves made on their own stop at this in any 24 hours, then it asks you again.' });
    for (var o = 0; o < rules.other.length; o += 1) lines.push({ key: 'other:' + o, label: '', value: '', note: rules.other[o] });
    var pays = paysLine(policy);
    if (pays) lines.push({ key: 'pays', label: 'Pays only', value: '', note: pays });
    if (!lines.length && !rules.ask) lines.push({ key: 'none', label: '', value: '', note: 'No limits are set, so everything your assistant asks for waits for your click.' });

    dom.reconcile(refs.limits, lines, function (line) {
      return line.key;
    }, function (line) {
      return ruleLine(line.key);
    }, paintRule);
    dom.setHidden(refs.askChange, !refs.askEdit.hidden);
  }

  /* The destination allowlist, as what each entry is for and a count of the
     wallets. An address is noise on every day but the one somebody has a
     reason to check it, and the assistant can read it back then. */
  function paysLine(policy) {
    var allow = policy.outbound && Array.isArray(policy.outbound.destinationAllowlist)
      ? policy.outbound.destinationAllowlist
      : [];
    if (!allow.length) return '';
    var named = [];
    var wallets = 0;
    for (var a = 0; a < allow.length; a += 1) {
      var name = SERVICE_NAMES[allow[a]];
      if (!name) wallets += 1;
      else if (named.indexOf(name) === -1) named.push(name);
    }
    if (wallets) named.unshift(wallets === 1 ? '1 wallet of yours' : wallets + ' wallets of yours');
    var words = listWords(named);
    return words.charAt(0).toUpperCase() + words.slice(1) + '.';
  }

  /* What the sentences say, by shape. The kill switch is the Freeze row's, and
     a sentence with a shape this row does not know is kept whole. */
  function parseRules(sentences, policy) {
    var out = { ask: '', perTx: '', perDay: '', auto: '', other: [] };
    for (var i = 0; i < sentences.length; i += 1) {
      var line = String(sentences[i]).trim();
      var found;
      if (/allowed destinations/i.test(line)) continue;
      if ((found = /^ask me before anything above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.ask = found[1];
      else if ((found = /^refuse any single transaction above (\$[\d,]+(?:\.\d+)?)\.?$/i.exec(line))) out.perTx = found[1];
      else if ((found = /^refuse more than (\$[\d,]+(?:\.\d+)?) in any 24 hours\.?$/i.exec(line))) out.perDay = found[1];
      else if ((found = /^ask me once auto-approved moves pass (\$[\d,]+(?:\.\d+)?) in 24 hours\.?$/i.exec(line))) out.auto = found[1];
      else if (/^kill switch on/i.test(line)) continue;
      else if (line) out.other.push(line);
    }
    /* The typed policy outranks the sentence when both are there, so a number
       never comes from a regex when it can come from a field. */
    var outbound = policy && policy.outbound ? policy.outbound : {};
    var gate = policy && policy.approval;
    if (gate && typeof gate.thresholdUsd === 'number') out.ask = usdShort(gate.thresholdUsd);
    else if (typeof outbound.humanClickAboveUsd === 'number' && out.ask) out.ask = usdShort(outbound.humanClickAboveUsd);
    if (typeof outbound.maxPerTransactionUsd === 'number' && out.perTx) out.perTx = usdShort(outbound.maxPerTransactionUsd);
    if (typeof outbound.maxPerSessionUsd === 'number' && out.perDay) out.perDay = usdShort(outbound.maxPerSessionUsd);
    if (typeof outbound.autoApproveDailyUsd === 'number' && out.auto) out.auto = usdShort(outbound.autoApproveDailyUsd);
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
    refs.custodyValue = dom.el('span', 'vault-row-value');
    r.act.appendChild(refs.custodyValue);
    refs.custodyLine = text();
    refs.custodyMore = text('vault-sub');
    refs.custodyMore.hidden = true;
    refs.custodyReach = dom.el('p', 'vault-warn');
    append(refs.custodyReach, icon('warning', 'icon-16'));
    refs.custodyReachText = dom.el('span', '');
    refs.custodyReach.appendChild(refs.custodyReachText);
    refs.custodyReach.hidden = true;
    r.main.appendChild(refs.custodyLine);
    r.main.appendChild(refs.custodyMore);
    r.main.appendChild(refs.custodyReach);
    refs.migrate = button('Protect with Touch ID', 'btn-sm');
    refs.migrate.hidden = true;
    var tools = dom.el('div', 'vault-actions');
    tools.appendChild(refs.migrate);
    r.main.appendChild(tools);
    dom.on(refs.migrate, 'click', function () { openMigrate(false); });
    host.appendChild(r.node);
  }

  function renderCustody(vault) {
    var enclave = vault.enclave || {};
    var custody = vault.custody;

    if (custody === 'secure-enclave') {
      var made = dateWords(enclave.keyMadeAt);
      dom.setText(refs.custodyValue, 'Touch ID');
      dom.setText(refs.custodyLine, 'Behind the Secure Enclave on this Mac. Touch ID or your Mac login password opens it.' + (made ? ' Made on ' + made + '.' : ''));
      /* Which of the two bindings is live, in words. An unsigned copy of the
         app keeps the key where any process running as you can present it. */
      var device = enclave.binding === 'device';
      dom.setText(refs.custodyMore, device ? 'This copy of Phosphor is not signed, so other apps on this Mac could ask for the key. The signed Phosphor app keeps it to itself.' : '');
      dom.setHidden(refs.custodyMore, !device);
      var reach = enclave.attached === false
        ? 'Touch ID only works inside the Phosphor app. Open the app to use this wallet.'
        : (enclave.ready === false ? 'This Mac cannot check your Touch ID right now, so the wallet cannot be opened here.' : '');
      dom.setText(refs.custodyReachText, reach);
      dom.setHidden(refs.custodyReach, !reach);
      dom.setHidden(refs.migrate, true);
      return;
    }

    if (custody === 'software') {
      dom.setText(refs.custodyValue, 'Password');
      dom.setText(refs.custodyLine, 'Locked with your password on this Mac. Use a long one.');
      dom.setText(refs.custodyMore, softwareReason(vault));
      dom.setHidden(refs.custodyMore, false);
      dom.setHidden(refs.custodyReach, true);
      dom.setHidden(refs.migrate, enclave.ready !== true);
      return;
    }

    dom.setText(refs.custodyValue, '');
    dom.setText(refs.custodyLine, 'No wallet on this Mac yet. Make one and its keys appear here.');
    dom.setHidden(refs.custodyMore, true);
    dom.setHidden(refs.custodyReach, true);
    dom.setHidden(refs.migrate, true);
  }

  /* Why the keys are behind a password, in one sentence. */
  function softwareReason(vault) {
    var enclave = vault.enclave || {};
    var cap = enclave.capability || null;
    if (enclave.ready === true) return 'This Mac has Touch ID. Your keys can move behind it now.';
    if (enclave.attached === false) return 'Touch ID protection needs the Phosphor app.';
    if (cap && cap.secureEnclave === false) return 'This Mac has no Secure Enclave.';
    if (cap && cap.canAuthenticate === false) return 'This Mac cannot check who you are. Set up Touch ID or a login password, then come back.';
    return 'Touch ID is not available on this Mac right now.';
  }

  /* ---------- your wallet: restore, and the encrypted copy ---------- */

  function buildRecovery(host) {
    var r = row('Restore', 'recovery');
    refs.recoveryRow = r.node;
    refs.recoveryLine = text();
    r.main.appendChild(refs.recoveryLine);
    refs.restore = button('Restore from a phrase', 'btn-ghost btn-sm');
    /* A password wallet has a second copy of itself: the file, encrypted
       under the same password. */
    refs.exportPassword = button('Save an encrypted copy', 'btn-quiet btn-sm');
    var actions = dom.el('div', 'vault-actions');
    actions.appendChild(refs.restore);
    actions.appendChild(refs.exportPassword);
    r.main.appendChild(actions);
    dom.on(refs.restore, 'click', function () {
      var vault = (store.get() || {}).vault || {};
      if (vault.custody === 'software' && vault.backedUp !== true) startReveal();
      else startRestore();
    });
    dom.on(refs.exportPassword, 'click', startExport);
    refs.recoveryFlow = dom.el('div', 'vault-flow');
    refs.recoveryFlow.hidden = true;
    r.body.appendChild(refs.recoveryFlow);
    host.appendChild(r.node);
  }

  function renderRecovery(vault) {
    var has = !!vault.custody;
    var enclave = vault.custody === 'secure-enclave';
    var ready = !!(vault.enclave && vault.enclave.ready === true);
    /* Restoring makes the wallet behind the Secure Enclave, so a Mac without
       one cannot do it here. A password wallet that is not proven backed up
       would be lost if the phrase made a different one, so its way in is the
       backup first. */
    var canRestore = enclave || ready;
    var guarded = vault.custody === 'software' && vault.backedUp !== true;
    dom.setText(refs.recoveryLine, !has
      ? 'Your recovery phrase brings a wallet back on any Mac.'
      : canRestore
        ? 'Your recovery phrase brings this wallet back on any Mac. Restoring here replaces the wallet on this Mac, behind Touch ID.'
        : 'Your recovery phrase brings this wallet back on any Mac with Touch ID.');
    dom.setText(refs.restore.querySelector('.btn-label'), guarded ? 'Back up first' : 'Restore from a phrase');
    dom.setHidden(refs.restore, !canRestore || !refs.recoveryFlow.hidden);
    dom.setHidden(refs.exportPassword, !has || enclave || !refs.recoveryFlow.hidden);
  }

  function closeRecovery() {
    var flow = refs.recoveryFlow;
    if (!flow || flow.hidden) return;
    shrink(refs.recoveryRow, flow, function () {
      dom.clear(flow);
      flow.hidden = true;
      delete flow.dataset.step;
      render();
    }, refs.restore);
  }

  /* Restore. Replaces the wallet on this Mac with the one the phrase makes.
     The backend refuses while an enclave wallet here is not proven backed up
     and the phrase makes a different one, and asks for a Touch ID before it
     writes. The confirm is a second press in the same place, never a dialog. */
  function startRestore() {
    var flow = refs.recoveryFlow;
    grow(refs.recoveryRow, function () {
      dom.clear(flow);
      flow.hidden = false;
      flow.dataset.step = 'restore';
      render();
      drawRestore(flow);
    }, flow);
  }

  function drawRestore(flow) {
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

    var error = problem();
    flow.appendChild(error);

    var sure = text('vault-confirm-text');
    sure.hidden = true;
    flow.appendChild(sure);

    var tools = dom.el('div', 'vault-actions');
    var go = button('Restore', 'btn-sm', 'Waiting for Touch ID');
    var cancel = button('Cancel', 'btn-quiet btn-sm');
    tools.appendChild(go);
    tools.appendChild(cancel);
    flow.appendChild(tools);

    var asked = false;
    dom.on(cancel, 'click', function () {
      input.value = '';
      closeRecovery();
    });
    dom.on(go, 'click', function () {
      var words = wordsOf(input.value);
      if (words.length !== 12 && words.length !== 24) {
        say(error, 'That is ' + words.length + (words.length === 1 ? ' word' : ' words') + '. It should be 12 or 24.');
        return;
      }
      say(error, '');
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
            say(error, restoreProblem(answer.code, answer.error));
            return;
          }
          input.value = '';
          closeRecovery();
          window.PhosphorToast.show('Restored. This Mac now holds the wallet from your phrase.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) { say(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(go, false); });
    });
    dom.on(input, 'input', function () {
      asked = false;
      sure.hidden = true;
    });
    if (input.focus) input.focus();
  }

  function wordsOf(value) {
    var clean = String(value || '').trim().toLowerCase();
    return clean ? clean.split(/\s+/) : [];
  }

  function restoreProblem(code, error) {
    if (code === 'bad_phrase') return 'That phrase is not right. Check every word and the order they are in.';
    if (code === 'not_backed_up') return 'The wallet on this Mac is not proven backed up, so it cannot be replaced. Back up its phrase first.';
    if (code === 'user_cancel') return 'Touch ID was cancelled. Nothing changed.';
    if (code === 'enclave_unavailable') return 'Touch ID did not answer. Open the Phosphor app and try again.';
    return error || 'That did not work.';
  }

  /* The encrypted copy of a password wallet, written by the app under the
     password typed here. The file goes where the app puts it when the app
     knows (it answers with the path); an app that still needs a place asks
     for the full path of the file, once. */
  function startExport() {
    var flow = refs.recoveryFlow;
    grow(refs.recoveryRow, function () {
      dom.clear(flow);
      flow.hidden = false;
      flow.dataset.step = 'export';
      render();
      drawExport(flow);
    }, flow);
  }

  function drawExport(flow) {
    flow.appendChild(dom.el('p', 'vault-flow-title', 'Save an encrypted copy'));
    flow.appendChild(text('vault-sub', 'The copy is locked with your password, so it is only as safe as the password is.'));
    var form = dom.el('form', 'vault-form');
    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Password'));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.name = 'password';
    input.autocomplete = 'current-password';
    field.appendChild(input);
    form.appendChild(field);

    var where = dom.el('div', 'field');
    where.hidden = true;
    where.appendChild(dom.el('label', 'label', 'Where to save it, as a full path'));
    var target = dom.el('input', 'input addr');
    target.type = 'text';
    target.name = 'backup-path';
    target.autocomplete = 'off';
    target.spellcheck = false;
    target.placeholder = '/Users/you/Documents/' + backupName();
    where.appendChild(target);
    form.appendChild(where);

    var error = problem();
    form.appendChild(error);
    var tools = dom.el('div', 'vault-actions');
    var go = dom.el('button', 'btn btn-sm');
    go.type = 'submit';
    go.appendChild(dom.el('span', 'btn-label', 'Save it'));
    dom.setAttr(go, 'data-pending-label', 'Saving');
    var cancel = button('Cancel', 'btn-quiet btn-sm');
    tools.appendChild(go);
    tools.appendChild(cancel);
    form.appendChild(tools);
    flow.appendChild(form);

    dom.on(cancel, 'click', function () {
      input.value = '';
      closeRecovery();
    });
    dom.on(form, 'submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var password = input.value;
      var path = where.hidden ? '' : target.value.trim();
      if (!password) {
        say(error, 'Type your password first.');
        return;
      }
      if (!where.hidden && !path) {
        say(error, 'Type where to save it.');
        return;
      }
      say(error, '');
      window.PhosphorShell.setPending(go, true);
      api.walletExport(password, path || undefined)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            input.value = '';
            say(error, answer.code === 'wrong_password' ? 'That password is wrong.' : (answer.error || 'That did not work.'));
            return;
          }
          input.value = '';
          closeRecovery();
          var saved = answer && typeof answer.path === 'string' ? answer.path : path;
          window.PhosphorToast.show(saved ? 'Encrypted copy saved to ' + saved + '.' : 'Encrypted copy saved.');
        })
        .catch(function (err) {
          /* An app that cannot choose a place asks for one: the field shows,
             with the file named for today. */
          if (err && err.status === 400 && /path/i.test(String(err.message || '')) && where.hidden) {
            where.hidden = false;
            say(error, 'Say where to save the copy, as a full path.');
            if (target.focus) target.focus();
            return;
          }
          say(error, net.readable(err));
        })
        .finally(function () { window.PhosphorShell.setPending(go, false); });
    });
    if (input.focus) input.focus();
  }

  function backupName() {
    var now = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'Phosphor backup ' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '.json';
  }

  /* ---------- your wallet: the addresses ---------- */

  function buildAddresses(host) {
    var r = row('Addresses', 'addresses');
    r.node.className += ' vault-row-wide';
    refs.addressesRow = r.node;
    r.main.appendChild(text('vault-text', 'Pick the network you will send from. The address is checked before it shows.'));
    r.act.appendChild(networkSelect());
    refs.tokensToggle = button('Show tokens', 'btn-quiet btn-sm vault-fold');
    append(refs.tokensToggle, icon('chevron-down', 'vault-fold-icon'));
    refs.tokensToggle.setAttribute('aria-expanded', 'false');
    refs.tokensToggle.setAttribute('aria-controls', 'vault-tokens');
    var tools = dom.el('div', 'vault-actions');
    tools.appendChild(refs.tokensToggle);
    r.main.appendChild(tools);
    dom.on(refs.tokensToggle, 'click', function () { foldTokens(!tokensOpen); });

    refs.tokensFold = dom.el('div', 'vault-fold-body');
    refs.tokensFold.id = 'vault-tokens';
    refs.tokensFold.hidden = true;
    refs.tokensHost = dom.el('div', 'vault-tokens');
    refs.tokensFold.appendChild(refs.tokensHost);
    refs.keyRow = dom.el('div', 'vault-key');
    refs.keyRow.setAttribute('data-dev-only', '');
    refs.tokensFold.appendChild(refs.keyRow);
    r.body.appendChild(refs.tokensFold);
    host.appendChild(r.node);
  }

  /* The token list is folded behind the network menu: picking a network opens
     it for that network, and the row's own control opens and closes it. */
  function foldTokens(open) {
    tokensOpen = !!open;
    grow(refs.addressesRow, function () {
      dom.setHidden(refs.tokensFold, !tokensOpen);
      dom.setAttr(refs.tokensToggle, 'aria-expanded', tokensOpen ? 'true' : 'false');
      dom.setText(refs.tokensToggle.querySelector('.btn-label'), tokensOpen ? 'Hide tokens' : 'Show tokens');
      if (tokensOpen) {
        renderTokens();
        renderKey();
      }
    }, tokensOpen ? refs.tokensFold : null);
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
    node.appendChild(dom.el('span', 'logo-initial', String(symbol || '?').charAt(0)));
    return node;
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
    append(btn, icon('chevron-down', 'chev-icon'));

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

  /* A pick opens the list for that network, the same one again included. */
  function pickNetwork(id) {
    if (!id) return;
    closeMenu();
    var changed = id !== network;
    network = id;
    if (changed) renderSelect();
    if (!tokensOpen) foldTokens(true);
    else if (changed) {
      renderTokens();
      renderKey();
    }
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
      if (tokensOpen) {
        renderTokens();
        renderKey();
      }
    });
  }

  /* The tokens the bridge credits on the network in the menu, with the
     minimum for each, searchable; Show the address opens the deposit card. */
  function renderTokens() {
    if (!refs.tokensHost || !tokensOpen) return;
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
    var plain = dom.el('div', 'deposit-address addr vault-address');
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
     word, press. The app refuses it until the phrase is proven backed up, so
     until then the row's way through is the backup, and nothing about it is
     a loss or red. */
  function buildForget(host) {
    var r = row('Forget', 'danger');
    refs.forgetLine = text('vault-text', 'Removes this wallet from this Mac. Your recovery phrase brings it back, here or on any Mac.');
    r.main.appendChild(refs.forgetLine);
    refs.forgetOpen = button('Forget this wallet', 'btn-quiet btn-sm');
    r.act.appendChild(refs.forgetOpen);

    var step = dom.el('div', 'vault-confirm');
    step.setAttribute('role', 'group');
    step.setAttribute('aria-label', 'Forget this wallet');
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
    refs.forgetError = problem();
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
      if (!forgetAllowed(((store.get() || {}).vault) || {})) {
        startReveal();
        return;
      }
      grow(r.node, function () {
        dom.setHidden(step, false);
        dom.setHidden(refs.forgetOpen, true);
        if (refs.forgetInput.focus) refs.forgetInput.focus();
      }, step);
    });
    dom.on(keep, 'click', function () { closeForget(true); });
    dom.on(step, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeForget(true);
    });
    dom.on(refs.forgetInput, 'input', function () {
      refs.forget.disabled = refs.forgetInput.value.trim() !== 'FORGET';
    });
    dom.on(refs.forget, 'click', forgetWallet);
    refs.forgetRow = r.node;
    host.appendChild(r.node);
  }

  function forgetAllowed(vault) {
    return vault.backedUp === true || vault.foreign === true || vault.hasMnemonic === false;
  }

  function renderForget(vault) {
    dom.setHidden(refs.forgetRow, !vault.custody);
    var allowed = forgetAllowed(vault);
    dom.setText(refs.forgetOpen.querySelector('.btn-label'), allowed ? 'Forget this wallet' : 'Back up first');
    refs.forgetOpen.className = allowed ? 'btn btn-quiet btn-sm' : 'btn btn-ghost btn-sm';
    dom.setText(refs.forgetLine, allowed
      ? 'Removes this wallet from this Mac. Your recovery phrase brings it back, here or on any Mac.'
      : 'Removes this wallet from this Mac. The app allows it once your recovery phrase is backed up, so nothing is lost.');
  }

  function closeForget(returnFocus) {
    if (!refs.forgetStep || refs.forgetStep.hidden) return;
    refs.forgetInput.value = '';
    refs.forget.disabled = true;
    shrink(refs.forgetRow, refs.forgetStep, function () {
      say(refs.forgetError, '');
      dom.setHidden(refs.forgetStep, true);
      dom.setHidden(refs.forgetOpen, false);
      if (returnFocus && refs.forgetOpen.focus) refs.forgetOpen.focus();
    }, refs.forgetOpen);
  }

  function forgetWallet() {
    if (refs.forgetInput.value.trim() !== 'FORGET') return;
    say(refs.forgetError, '');
    window.PhosphorShell.setPending(refs.forget, true);
    api.vaultForget()
      .then(function (answer) {
        if (answer && answer.ok === false) {
          say(refs.forgetError, answer.code === 'not_backed_up'
            ? 'Refused: the phrase is not proven backed up. Back it up in Safety first.'
            : (answer.code === 'user_cancel' ? 'Touch ID was cancelled. Nothing changed.' : (answer.error || 'That did not work.')));
          return;
        }
        closeForget(true);
        window.PhosphorToast.show('This Mac has forgotten the wallet.');
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) { say(refs.forgetError, net.readable(err)); })
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
    renderForget(vault);
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
    card.appendChild(dom.el('h1', 'title', 'Protect your keys with Touch ID'));
    card.appendChild(dom.el('p', 'body dim', 'Type your password once. After this, Touch ID opens your wallet and the password is no longer needed.'));

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
    go.appendChild(dom.el('span', 'btn-label', 'Use Touch ID'));
    dom.setAttr(go, 'data-pending-label', 'Waiting for Touch ID');
    actions.appendChild(later);
    actions.appendChild(go);
    form.appendChild(actions);
    card.appendChild(form);
    card.appendChild(dom.el('p', 'meta', 'Nothing moves. Your wallet stays the same wallet, with the same addresses.'));

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
          window.PhosphorToast.show('Your keys are behind Touch ID. Touch ID opens the wallet from now on.');
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
    if (code === 'enclave_unavailable') return 'Touch ID did not answer. Open the Phosphor app and try again.';
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

  function bringIntoView(node) {
    if (!node || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ block: 'nearest', behavior: window.PhosphorMotion && window.PhosphorMotion.reduced() ? 'auto' : 'smooth' });
  }

  /* The notice's way in: the phrase's row, brought into view, its action
     under the cursor. */
  function focusRecovery() {
    if (!refs.backupRow) return;
    bringIntoView(refs.backupRow);
    if (refs.backupGo && !refs.backupGo.hidden && refs.backupGo.focus) refs.backupGo.focus();
  }

  window.PhosphorVault = {
    boot: boot,
    render: render,
    startReveal: startReveal,
    startRestore: startRestore,
    startExport: startExport,
    focusRecovery: focusRecovery,
    openMigrate: openMigrate,
    printPhrase: printPhrase,
    wipePhrase: wipePhrase
  };
})();
