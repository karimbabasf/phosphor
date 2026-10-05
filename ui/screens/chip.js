/* Your vault: the move to this Mac's Touch ID key, its restore on a new Mac,
   and the trading key that lets plans trade once the vault has moved.

   The vault is the account every deposit lands in. Before the move the
   wallet's own key opens it, and that key sits in Phosphor's memory while the
   wallet is open. The move (src/vault/rekey.ts, src/http/chip.ts) leaves the
   vault two keys and no other: this Mac's Touch ID key, which signs one named
   move per Touch ID, and a paper key of 24 words the person writes by hand.
   After it the assistant spends from the allowance (ui/screens/allowance.js)
   and anything bigger asks for a Touch ID. The rows are the Vault's own
   (ui/screens/vault.js hands its pieces over as `kit`).

   THE PAPER KEY. Its words come from the backend once (POST
   /api/vault/chip/phrase), are drawn in this row only, and are held in this
   file's memory, never the store, a log or a frame, until they are typed back
   whole, the window locks, the tab is left or the person hides them. There is
   no Print and no Copy: a printer and a clipboard both keep a copy. They are
   typed back by hand, one word to a field, with pasting off, so what is
   proven is the paper and not a copy of the screen.

   ONE NAME FOR EACH THING, the one the docs, the refusals and the Touch ID
   sentences use: your vault, your allowance, the gas account, your paper key,
   this Mac's Touch ID key, and the wallet's own backup by the name its row
   gives it. Nothing a person reads says chip, enclave, marker, nonce or
   keychain; the one part underneath that has to be shown, the NEAR door, is
   said with what it does. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;

  /* The Touch ID sentences of a move, as the app and the vault service write
     them (src/vault/reason.ts MOVE_VAULT_REASON and RESTORE_VAULT_REASON,
     src-tauri/se-helper/IntentGrammar.swift). The window names each one before
     it is asked, so a dialog that reads anything else reads as a Cancel. */
  var SAYS = {
    move: 'Move your vault to this Mac\'s Touch ID key and your paper key',
    restore: 'Restore your vault to this Mac\'s Touch ID key from your paper key',
    chip: 'confirm this Mac\'s Touch ID key for your vault'
  };

  var PAPER = 24;
  // A move this process runs, from its first frame to its last (src/vault/rekey.ts RunStatus).
  var ACTIVE = ['creating', 'touch_old', 'touch_chip', 'simulating', 'submitting', 'checking'];
  var ORDER = ACTIVE.concat(['done', 'failed']);
  // A trading key this close to its end is said so, while there is time to allow the next.
  var SOON_MS = 14 * 24 * 60 * 60 * 1000;

  var kit = null;
  var refs = {};
  var mounted = false;
  var slice = null;
  var current = {};

  /* The paper key while it is on screen or being typed back: here only. */
  var paper = null;
  var stage = null;
  var misses = 0;
  var drawn = '';
  var asking = false;
  var refused = null;
  var live = null;
  var watched = null;
  var justDone = false;
  var trading = null;
  var tradingAsked = false;
  var tradingDone = null;

  function button(label, kind, pending) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost btn-sm'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(node, 'data-pending-label', pending);
    return node;
  }

  function label(node, words) {
    dom.setText(node.querySelector('.btn-label'), words);
  }

  function setPending(node, on) {
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(node, on);
    else node.disabled = !!on;
  }

  function refresh() {
    var shell = window.PhosphorShell;
    return shell && typeof shell.refresh === 'function' ? Promise.resolve(shell.refresh({})) : Promise.resolve();
  }

  /* ---------- words ---------- */

  // The wallet's own backup, by the name its row in Safety gives it.
  function backupName(vault) {
    return vault && vault.hasMnemonic === false ? 'private key' : 'recovery phrase';
  }

  /* What the paper and the backup are, said plainly on the paper key's screen
     and under a vault that moved (PHASE2-PLAN.md U12; docs/getting-started.md
     carries the same two). */
  function plainTruth(vault) {
    return [
      'Your paper key is the only key that opens your vault away from this Mac.',
      'Your ' + backupName(vault) + ' also controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so keep both like cash.'
    ];
  }

  // An address or a key as the Touch ID dialogs shorten it: eight and eight.
  function short(id) {
    var s = String(id || '');
    var prefix = s.indexOf('0x') === 0 ? '0x' : s.slice(0, s.indexOf(':') + 1);
    var body = s.slice(prefix.length);
    return body.length > 20 ? prefix + body.slice(0, 8) + '...' + body.slice(-8) : s;
  }

  function vaultAddress() {
    var lock = current.lock || {};
    var pins = slice && slice.pins;
    if (pins && typeof pins.vault === 'string') return pins.vault;
    return lock.addresses && typeof lock.addresses.evm === 'string' ? lock.addresses.evm : '';
  }

  function said(answer, fallback) {
    return kit.refusalWords(answer, fallback);
  }

  /* ---------- the run ----------

     A move reports in `chip` frames (its status, and its reason said in
     words) and in the state's `vault.chip.run`. The frame is the newer of
     the two while the move runs; the state is the record once it ends. */
  function runOf() {
    var run = slice && slice.run ? slice.run : null;
    if (!live) return run;
    var same = !!run && live.run === run.id;
    /* One move runs at a time, so a frame for another run is newer only while
       it runs and the state's has ended; a frame from a run that ended is
       never newer than the state's. */
    var newer = same ? ORDER.indexOf(live.status) > ORDER.indexOf(run.status) : (!run || (underWay(live) && !underWay(run)));
    if (!newer) return run;
    return { id: live.run, kind: same ? run.kind : (live.kind || 'migrate'), status: live.status, reason: live.reason || null, said: live.said || null };
  }

  function underWay(run) {
    return !!run && ACTIVE.indexOf(run.status) >= 0;
  }

  /* Which of the row's four faces: the offer, the restore, a move under way,
     or a vault that moved. A move that failed, or one a restart cut short
     (the state still says moving, with no run in this process), goes back to
     its steps: the paper typed again, then Try again. A restore is told by
     its run, or by a vault whose own key is already off it. */
  function screenOf(run) {
    if (!slice) return 'none';
    if (underWay(run)) return 'run';
    // A move's last frame can beat the state that says so: done is done.
    if (slice.state === 'done' || (run && run.status === 'done')) return 'moved';
    if (slice.state === 'broken') return 'restore';
    if (run && run.kind === 'restore') return 'restore';
    if (slice.state === 'moving' && slice.oldOnChain === false) return 'restore';
    return 'offer';
  }

  /* ---------- the page ---------- */

  function mount(host, pieces) {
    if (mounted) return;
    kit = pieces;
    mounted = true;

    var r = kit.row('Vault key', 'chip');
    r.node.className += ' vault-row-wide';
    r.node.setAttribute('data-reveal', 'vault-key');
    refs.row = r.node;
    refs.value = dom.el('span', 'vault-row-value');
    r.act.appendChild(refs.value);
    refs.line = kit.text();
    r.main.appendChild(refs.line);
    refs.flow = dom.el('div', 'vault-flow vault-move');
    r.body.appendChild(refs.flow);
    host.appendChild(r.node);

    var events = window.PhosphorEvents;
    if (events && typeof events.on === 'function') {
      events.on('chip', function (frame) {
        if (!frame || typeof frame.run !== 'string' || typeof frame.status !== 'string') return;
        var kind = live && live.run === frame.run ? live.kind : null;
        live = { run: frame.run, kind: kind, status: frame.status, reason: typeof frame.reason === 'string' ? frame.reason : null, said: typeof frame.said === 'string' ? frame.said : null };
        paint();
      });
      events.on('reattach', function () { readTrading(); });
    }
  }

  // The trading key's row, last in the section: after the allowance and the gas account.
  function mountTrading(host) {
    if (!mounted || refs.trading) return;
    buildTrading(host);
  }

  function render(state, chipSlice) {
    if (!mounted) return;
    current = state || {};
    var was = slice;
    slice = chipSlice || null;
    if (!slice) {
      if (paper) wipe();
      dom.setHidden(refs.row, true);
      if (refs.trading) dom.setHidden(refs.trading, true);
      return;
    }
    dom.setHidden(refs.row, false);
    if (!was || was.state !== slice.state) readTrading();
    paint();
    paintTrading();
  }

  /* ---------- the vault key row ---------- */

  function paint() {
    if (!mounted || !slice) return;
    var vault = current.vault || {};
    var run = runOf();
    if (underWay(run)) watched = run.id;
    if (watched && (slice.state === 'done' || (run && run.id === watched && run.status === 'done'))) {
      justDone = true;
      watched = null;
    }
    if (run && run.status === 'failed' && watched === run.id) watched = null;
    var screen = screenOf(run);

    var lines = {
      offer: 'Your ' + backupName(vault) + ' opens your vault today.',
      restore: 'Your vault answers to a Touch ID key this Mac does not have.',
      run: run && run.kind === 'restore' ? 'Your vault is coming to this Mac\'s Touch ID key.' : 'Your vault is moving to this Mac\'s Touch ID key.',
      moved: 'This Mac\'s Touch ID key and your paper key open your vault, and nothing else does.'
    };
    dom.setText(refs.line, lines[screen] || '');
    dom.setText(refs.value, screen === 'moved' ? 'Touch ID' : '');

    var key = screen === 'offer' || screen === 'restore' ? screen + ':' + stepNow(screen) + ':' + bodyKey(screen) : screen;
    if (screen === 'run') key += ':' + (run ? run.id : '');
    if (key !== drawn) {
      var first = drawn === '';
      drawn = key;
      var redraw = function () { drawFlow(screen); };
      if (first) redraw();
      else kit.grow(refs.row, redraw, refs.flow);
      return;
    }
    update(screen);
  }

  function stepsOf(screen) {
    return screen === 'restore' ? ['backup', 'gas', 'paper', 'old'] : ['backup', 'gas', 'paper', 'move'];
  }

  function done(step) {
    var needs = Array.isArray(slice.needs) ? slice.needs : [];
    if (step === 'backup') return needs.indexOf('backup') < 0;
    if (step === 'gas') return needs.indexOf('gas') < 0;
    if (step === 'paper') return slice.paper === 'proven';
    return false;
  }

  // The step the stepper is on: the first one not done yet.
  function stepNow(screen) {
    var steps = stepsOf(screen);
    for (var i = 0; i < steps.length; i += 1) if (!done(steps[i])) return steps[i];
    return steps[steps.length - 1];
  }

  /* What the open step's body depends on: a new key redraws it, anything else
     repaints it in place, so the words typed into the fields survive every
     state frame that does not change the step. */
  function bodyKey(screen) {
    var now = stepNow(screen);
    if (now === 'paper') return paperStage() + (paper ? ':held' : '');
    if (now === 'move' || now === 'old') return 'go';
    return 'ask';
  }

  // Where the paper step is: on screen here, waiting to be typed back, typed again after a restart, void, or none.
  function paperStage() {
    if (paper && stage === 'words') return 'words';
    if (paper && stage === 'typeback') return 'typeback';
    if (slice.paper === 'shown' || slice.paper === 'retype') return 'typeback';
    if (slice.paper === 'void') return 'void';
    return 'none';
  }

  function blocked() {
    var vault = current.vault || {};
    var needs = Array.isArray(slice.needs) ? slice.needs : [];
    if (needs.indexOf('open') >= 0) return 'Open your wallet to go on.';
    if (needs.indexOf('touch_id') >= 0) {
      if (vault.custody === 'software') return 'software';
      return 'Touch ID only works inside the Phosphor app. Open the app to move your vault.';
    }
    return '';
  }

  function drawFlow(screen) {
    var flow = refs.flow;
    dom.clear(flow);
    refs.steps = null;
    refs.facts = null;
    refs.runSteps = null;
    refs.go = null;
    refs.fix = null;
    refs.goError = null;
    refs.oldInputs = null;
    refs.gasNote = null;
    flow.dataset.screen = screen;
    if (screen === 'offer' || screen === 'restore') drawStepper(flow, screen);
    else if (screen === 'run') drawRun(flow);
    else if (screen === 'moved') drawMoved(flow);
    update(screen);
  }

  function update(screen) {
    if (screen === 'offer' || screen === 'restore') paintSteps(screen);
    else if (screen === 'run') paintRun();
    else if (screen === 'moved') paintMoved();
  }

  /* ---------- the offer and the restore: four steps ---------- */

  var STEP_TITLES = {
    backup: function (vault) { return 'Back up your ' + backupName(vault); },
    gas: function () { return 'Add NEAR to the gas account'; },
    paper: function (vault, screen) { return screen === 'restore' ? 'Write a new paper key' : 'Write your paper key'; },
    move: function () { return 'Move your vault'; },
    old: function () { return 'Type your old paper key'; }
  };

  function drawStepper(flow, screen) {
    var vault = current.vault || {};
    flow.appendChild(dom.el('p', 'vault-flow-title', screen === 'restore' ? 'Restore your vault on this Mac' : 'Move your vault to Touch ID'));
    flow.appendChild(kit.text('vault-text', screen === 'restore'
      ? 'Your paper key brings your vault here. Write a new paper key first, then type the old one: the restore adds the new paper and retires the old one.'
      : 'After the move only this Mac\'s Touch ID key and a paper key you write by hand open your vault. Your assistant spends from a small allowance, and anything more asks for your Touch ID.'));
    refs.block = dom.el('p', 'vault-warn');
    kit.append(refs.block, kit.icon('warning', 'icon-16'));
    refs.blockText = dom.el('span', '');
    refs.block.appendChild(refs.blockText);
    flow.appendChild(refs.block);
    refs.blockTools = dom.el('div', 'vault-actions');
    var protect = button('Protect with Touch ID', 'btn-sm');
    dom.on(protect, 'click', function () { kit.openMigrate(false); });
    refs.blockTools.appendChild(protect);
    flow.appendChild(refs.blockTools);

    var list = dom.el('ol', 'vault-steps');
    refs.steps = {};
    stepsOf(screen).forEach(function (step, i) {
      var item = dom.el('li', 'vault-step');
      item.dataset.step = step;
      var disc = dom.el('span', 'vault-step-disc num');
      disc.setAttribute('aria-hidden', 'true');
      disc.appendChild(dom.el('span', 'vault-step-number', String(i + 1)));
      kit.append(disc, kit.icon('check', 'vault-step-check'));
      item.appendChild(disc);
      var words = dom.el('div', 'vault-step-words');
      var title = dom.el('p', 'vault-step-title', STEP_TITLES[step](vault, screen));
      var note = dom.el('p', 'vault-step-note');
      words.appendChild(title);
      words.appendChild(note);
      var body = dom.el('div', 'vault-step-body');
      words.appendChild(body);
      item.appendChild(words);
      list.appendChild(item);
      refs.steps[step] = { item: item, title: title, note: note, body: body };
    });
    flow.appendChild(list);

    var now = stepNow(screen);
    var open = refs.steps[now].body;
    if (now === 'backup') drawBackupStep(open);
    else if (now === 'gas') drawGasStep(open, screen);
    else if (now === 'paper') drawPaperStep(open, screen);
    else if (now === 'move') drawMoveStep(open);
    else if (now === 'old') drawOldStep(open);
  }

  function paintSteps(screen) {
    if (!refs.steps) return;
    var vault = current.vault || {};
    var why = blocked();
    dom.setText(refs.blockText, why === 'software' ? 'Your wallet opens with a password. Move it behind Touch ID first; your vault moves after that.' : why);
    dom.setHidden(refs.block, !why);
    dom.setHidden(refs.blockTools, why !== 'software');
    var now = stepNow(screen);
    var passed = true;
    stepsOf(screen).forEach(function (step) {
      var s = refs.steps[step];
      var isDone = passed && done(step);
      var state = isDone ? 'done' : (passed ? 'now' : 'next');
      if (!isDone) passed = false;
      s.item.dataset.state = why && state === 'now' ? 'next' : state;
      dom.setText(s.title, STEP_TITLES[step](vault, screen));
      var note = noteFor(step, state);
      dom.setText(s.note, note);
      dom.setHidden(s.note, !note);
      dom.setHidden(s.body, step !== now || !!why);
    });
    paintOpen(now);
  }

  function noteFor(step, state) {
    if (state !== 'done') return '';
    if (step === 'backup') return 'Backed up.';
    if (step === 'gas') return slice.gas && slice.gas.near ? slice.gas.near + ' NEAR, enough for the move.' : 'Ready.';
    if (step === 'paper') return 'Typed back whole.';
    return '';
  }

  /* The open step's lines follow the state while what the person typed
     stays. */
  function paintOpen(now) {
    if (now === 'gas' && refs.gasNote) {
      var gas = slice.gas;
      dom.setText(refs.gasNote, !gas
        ? 'Phosphor reads the gas account once the wallet has been open, and again every minute.'
        : gas.near === null
          ? 'Phosphor could not read the gas account just now. It reads it again in a minute.'
          : 'It holds ' + gas.near + ' NEAR, and the move needs more.');
    }
    if ((now === 'move' || now === 'old') && refs.goError) {
      var run = runOf();
      if (refused) kit.sayRefusal(refs.goError, refused, refused.said);
      else if (run && run.status === 'failed') {
        var answer = { ok: false, code: run.reason, error: run.said || '' };
        kit.sayRefusal(refs.goError, answer, said(answer));
      } else kit.say(refs.goError, '');
      paintFix();
    }
  }

  /* ---------- step: the backup ---------- */

  function drawBackupStep(body) {
    var vault = current.vault || {};
    body.appendChild(kit.text('vault-text', 'After the move your ' + backupName(vault) + ' still opens your allowance, the gas account and Hyperliquid, so prove your copy first.'));
    var tools = dom.el('div', 'vault-actions');
    var go = button('Back it up first', 'btn-sm');
    dom.on(go, 'click', function () { kit.focusRecovery(); });
    tools.appendChild(go);
    body.appendChild(tools);
  }

  /* ---------- step: the gas account ---------- */

  function drawGasStep(body, screen) {
    body.appendChild(kit.text('vault-text', screen === 'restore'
      ? 'The gas account pays NEAR\'s small fee for every move of your vault, this one included. It came back with your wallet, often with NEAR still in it; if not, add 0.1 to 1 NEAR: one click on its card, then one Touch ID.'
      : 'The gas account pays NEAR\'s small fee for every move of your vault, this one included. Add 0.1 to 1 NEAR from your vault: one click on its card, then one Touch ID.'));
    refs.gasNote = kit.text('vault-sub');
    body.appendChild(refs.gasNote);
    var tools = dom.el('div', 'vault-actions');
    var go = button('Add NEAR', 'btn-sm');
    dom.on(go, 'click', function () {
      var allowance = window.PhosphorAllowance;
      if (allowance && typeof allowance.openGas === 'function') allowance.openGas();
    });
    tools.appendChild(go);
    body.appendChild(tools);
  }

  /* ---------- step: the paper key ---------- */

  function drawPaperStep(body, screen) {
    var at = paperStage();
    if (at === 'words') drawWords(body);
    else if (at === 'typeback') drawTypeBack(body, screen);
    else drawPaperOffer(body, screen, at === 'void');
  }

  function drawPaperOffer(body, screen, isVoid) {
    var vault = current.vault || {};
    if (isVoid) {
      var gone = kit.problem();
      body.appendChild(gone);
      kit.say(gone, 'The paper key shown before Phosphor restarted opens nothing. Destroy it, then write a new one.');
    }
    body.appendChild(kit.text('vault-text', screen === 'restore'
      ? '24 words you write by hand. The restore puts this new paper on your vault and takes the old one off.'
      : '24 words you write by hand. With this Mac, they are the only key to your vault.'));
    body.appendChild(kit.text('vault-sub', 'Have a pen and paper ready, and a place for the paper apart from your ' + backupName(vault) + '.'));
    refs.paperError = kit.problem();
    body.appendChild(refs.paperError);
    var tools = dom.el('div', 'vault-actions');
    var go = button(isVoid ? 'Show a new paper key' : 'Show my paper key', 'btn-sm', 'Opening');
    dom.on(go, 'click', function () { showPaper(go, screen); });
    tools.appendChild(go);
    body.appendChild(tools);
  }

  function showPaper(go, screen) {
    if (refs.paperError) kit.say(refs.paperError, '');
    setPending(go, true);
    net.postJson('/api/vault/chip/phrase', {})
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          if (refs.paperError) kit.say(refs.paperError, said(answer));
          return null;
        }
        var words = Array.isArray(answer.words) ? answer.words : [];
        var good = words.length === PAPER && words.every(function (w) { return typeof w === 'string' && /^[a-z]+$/.test(w); });
        if (!good) {
          if (refs.paperError) kit.say(refs.paperError, 'No paper key came back. Try again.');
          return null;
        }
        paper = { words: words.slice(), screen: screen };
        stage = 'words';
        misses = 0;
        refused = null;
        paint();
        return refresh();
      })
      .catch(function (err) { if (refs.paperError) kit.say(refs.paperError, net.readable(err)); })
      .finally(function () { setPending(go, false); });
  }

  /* The words, once: numbered as the paper will number them, with the
     vault's address to write under them. Nothing here offers to print or
     copy them, and the grid takes no selection. */
  function drawWords(body, again) {
    var vault = current.vault || {};
    var warn = dom.el('p', 'vault-warn');
    kit.append(warn, kit.icon('lock', 'icon-16'));
    warn.appendChild(dom.el('span', '', 'On this screen only. Anyone who reads these words can open your vault.'));
    body.appendChild(warn);
    var truth = plainTruth(vault);
    var plain = dom.el('div', 'vault-plain');
    plain.appendChild(kit.text('vault-text vault-truth', truth[0]));
    plain.appendChild(kit.text('vault-text vault-truth', truth[1]));
    body.appendChild(plain);
    if (again) {
      var note = kit.problem();
      body.appendChild(note);
      kit.say(note, again);
    }
    var grid = dom.el('ol', 'words vault-words vault-paper');
    grid.setAttribute('aria-label', 'Your paper key, in 24 words');
    for (var i = 0; i < paper.words.length; i += 1) {
      var item = dom.el('li', 'word');
      item.appendChild(dom.el('span', 'meta num', String(i + 1)));
      item.appendChild(dom.el('span', 'body word-text', paper.words[i]));
      grid.appendChild(item);
    }
    body.appendChild(grid);
    var address = vaultAddress();
    if (address) {
      var where = dom.el('div', 'vault-paper-address');
      where.appendChild(dom.el('p', 'vault-sub', 'Under the words, write your vault\'s address:'));
      where.appendChild(dom.el('p', 'vault-mono', address));
      body.appendChild(where);
    }
    body.appendChild(kit.text('vault-sub', 'By hand, on paper: a printer, a screenshot or a copy keeps one more key to your vault.'));
    var tools = dom.el('div', 'vault-actions');
    var wrote = button('I wrote it down', 'btn-sm');
    var hide = button('Hide words', 'btn-quiet btn-sm');
    tools.appendChild(wrote);
    tools.appendChild(hide);
    body.appendChild(tools);
    dom.on(wrote, 'click', function () {
      stage = 'typeback';
      paint();
    });
    dom.on(hide, 'click', wipe);
    if (wrote.focus) wrote.focus();
  }

  /* All 24 words typed back from the paper, one to a field. A space or Enter
     goes on to the next field, so the words can be typed in one run. */
  function paperFields(body, name) {
    var grid = dom.el('div', 'vault-paper-fields');
    var inputs = [];
    for (var i = 0; i < PAPER; i += 1) {
      var field = dom.el('label', 'vault-paper-field');
      field.appendChild(dom.el('span', 'meta num', String(i + 1)));
      var input = dom.el('input', 'input vault-paper-input');
      input.type = 'text';
      input.name = name + '-' + (i + 1);
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('aria-label', 'Word ' + (i + 1));
      field.appendChild(input);
      grid.appendChild(field);
      inputs.push(input);
    }
    body.appendChild(grid);
    var hint = kit.text('vault-sub');
    hint.hidden = true;
    body.appendChild(hint);
    inputs.forEach(function (input, i) {
      dom.on(input, 'paste', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        dom.setText(hint, 'Type each word from your paper. Pasting is off here, so the check is of your paper.');
        hint.hidden = false;
      });
      dom.on(input, 'drop', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
      dom.on(input, 'input', function () {
        var value = String(input.value || '');
        if (!/\s/.test(value)) return;
        var parts = value.split(/\s+/).filter(Boolean);
        input.value = parts.length ? parts[0] : '';
        for (var k = 1; k < parts.length && i + k < inputs.length; k += 1) inputs[i + k].value = parts[k];
        var land = inputs[Math.min(inputs.length - 1, i + Math.max(1, parts.length))];
        if (land && land.focus) land.focus();
      });
      dom.on(input, 'keydown', function (event) {
        if (!event) return;
        if (event.key === 'Enter' && i < inputs.length - 1) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (inputs[i + 1].focus) inputs[i + 1].focus();
        } else if (event.key === 'Backspace' && !input.value && i > 0) {
          if (inputs[i - 1].focus) inputs[i - 1].focus();
        }
      });
    });
    return inputs;
  }

  function valuesOf(inputs) {
    return inputs.map(function (input) { return input.value; });
  }

  function clearFields(inputs) {
    for (var i = 0; i < inputs.length; i += 1) inputs[i].value = '';
  }

  function drawTypeBack(body, screen) {
    var retype = !paper && slice.paper === 'retype';
    body.appendChild(dom.el('p', 'vault-flow-title', 'Type your paper key back'));
    body.appendChild(kit.text('vault-sub', retype
      ? 'Phosphor restarted or locked, so type the paper you wrote for this move again, all 24 words.'
      : 'All 24 words, from your paper, in order. It proves the paper is right before your vault depends on it.'));
    var inputs = paperFields(body, 'paper');
    refs.paperError = kit.problem();
    body.appendChild(refs.paperError);
    var tools = dom.el('div', 'vault-actions');
    var check = button('Check my paper', 'btn-sm', 'Checking');
    tools.appendChild(check);
    if (paper) {
      var again = button('Show the words again', 'btn-quiet btn-sm');
      dom.on(again, 'click', function () {
        clearFields(inputs);
        stage = 'words';
        paint();
      });
      tools.appendChild(again);
    } else {
      var fresh = button('Show a new paper key', 'btn-quiet btn-sm', 'Opening');
      dom.on(fresh, 'click', function () { showPaper(fresh, screen); });
      tools.appendChild(fresh);
    }
    body.appendChild(tools);
    dom.on(check, 'click', function () { provePaper(inputs, check); });
    dom.on(inputs[inputs.length - 1], 'keydown', function (event) {
      if (!event || event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      provePaper(inputs, check);
    });
    if (inputs[0] && inputs[0].focus) inputs[0].focus();
  }

  // The first word typed that differs from the paper key on screen a moment ago, by its number, or 0.
  function firstSlip(words) {
    if (!paper) return 0;
    for (var i = 0; i < PAPER; i += 1) if (words[i] !== paper.words[i]) return i + 1;
    return 0;
  }

  function provePaper(inputs, check) {
    var read = window.PhosphorCustody.readPaper(valuesOf(inputs));
    if (read.problem) {
      kit.say(refs.paperError, read.problem);
      return;
    }
    kit.say(refs.paperError, '');
    setPending(check, true);
    net.postJson('/api/vault/chip/phrase-proven', { words: read.words })
      .then(function (answer) {
        if (answer && answer.ok === true) {
          clearFields(inputs);
          paper = null;
          stage = null;
          misses = 0;
          return refresh();
        }
        var code = answer && answer.code;
        if (code === 'wrong_words' || code === 'bad_paper') {
          misses += 1;
          if (paper && misses >= 2) {
            clearFields(inputs);
            misses = 0;
            showWordsAgain('Two tries did not match. Check your paper word by word, then type it again.');
            return null;
          }
          var slip = firstSlip(read.words);
          kit.say(refs.paperError, slip
            ? 'Word ' + slip + ' does not match the paper key Phosphor showed you. Check it on your paper, then try again.'
            : said(answer, 'Those words do not match your paper key. Check each word against your paper.'));
          return null;
        }
        kit.say(refs.paperError, said(answer));
        return null;
      })
      .catch(function (err) { kit.say(refs.paperError, net.readable(err)); })
      .finally(function () { setPending(check, false); });
  }

  // Two misses: the words come back on screen, with why.
  function showWordsAgain(why) {
    if (!refs.steps || !refs.steps.paper || !paper) return;
    stage = 'words';
    var body = refs.steps.paper.body;
    kit.grow(refs.row, function () {
      dom.clear(body);
      drawWords(body, why);
      drawn = (slice.state === 'broken' ? 'restore' : 'offer') + ':paper:' + bodyKey(slice.state === 'broken' ? 'restore' : 'offer');
    }, body);
  }

  /* ---------- step: the move ---------- */

  function drawSays(body, lines) {
    var list = dom.el('div', 'vault-says');
    lines.forEach(function (line) {
      var item = dom.el('div', 'vault-said-line');
      item.appendChild(dom.el('p', 'vault-said-label', line[0]));
      item.appendChild(dom.el('p', 'vault-said', line[1]));
      list.appendChild(item);
    });
    body.appendChild(list);
  }

  function goTools(body, words) {
    refs.goError = kit.problem();
    body.appendChild(refs.goError);
    var tools = dom.el('div', 'vault-actions');
    refs.go = button(words, 'btn-sm', 'Starting');
    tools.appendChild(refs.go);
    refs.fix = button('Add NEAR', 'btn-ghost btn-sm');
    refs.fix.hidden = true;
    dom.on(refs.fix, 'click', fixIt);
    tools.appendChild(refs.fix);
    body.appendChild(tools);
  }

  function drawMoveStep(body) {
    body.appendChild(kit.text('vault-text', 'Two Touch IDs move it, in one call to NEAR that lands whole or not at all.'));
    drawSays(body, [['The first reads', SAYS.move], ['The second reads', SAYS.chip]]);
    body.appendChild(kit.text('vault-sub', 'Cancel any Touch ID that reads anything else. While the move runs, your assistant\'s moves wait.'));
    goTools(body, 'Move my vault');
    dom.on(refs.go, 'click', function () { start('migrate', null); });
  }

  /* The restore's last step: the old paper's 24 words, then one Touch ID
     (two when this Mac must first read the wallet's own key). */
  function drawOldStep(body) {
    body.appendChild(kit.text('vault-text', 'The 24 words of the paper you wrote when your vault moved. They never leave this Mac, and the restore retires that paper.'));
    refs.oldInputs = paperFields(body, 'old-paper');
    drawSays(body, [['Touch ID reads', SAYS.chip], ['If it asks once more first', SAYS.restore]]);
    goTools(body, 'Restore my vault');
    dom.on(refs.go, 'click', function () {
      var read = window.PhosphorCustody.readPaper(valuesOf(refs.oldInputs));
      if (read.problem) {
        refused = null;
        kit.say(refs.goError, read.problem);
        return;
      }
      start('restore', read.words);
    });
  }

  /* After a refusal or a failed move, the action that helps sits beside Try
     again: NEAR for an empty gas account, the backup, a new paper for a paper
     that is gone. */
  function fixOf() {
    var run = runOf();
    var code = refused ? refused.code : (run && run.status === 'failed' ? run.reason : null);
    if (code === 'gas_low' || code === 'gas_unfunded') return { label: 'Add NEAR', go: 'gas' };
    if (code === 'not_backed_up') return { label: 'Back it up first', go: 'backup' };
    if (code === 'phrase_gone' || code === 'wrong_paper') return { label: 'Show a new paper key', go: 'paper' };
    return null;
  }

  function paintFix() {
    if (!refs.fix || !refs.go) return;
    var fix = fixOf();
    if (fix) label(refs.fix, fix.label);
    dom.setHidden(refs.fix, !fix);
    var run = runOf();
    var failed = !!refused || (!!run && run.status === 'failed');
    label(refs.go, failed ? 'Try again' : (refs.oldInputs ? 'Restore my vault' : 'Move my vault'));
  }

  function fixIt() {
    var fix = fixOf();
    if (!fix) return;
    if (fix.go === 'gas') {
      if (window.PhosphorAllowance) window.PhosphorAllowance.openGas();
      return;
    }
    if (fix.go === 'backup') {
      kit.focusRecovery();
      return;
    }
    refused = null;
    setPending(refs.fix, true);
    net.postJson('/api/vault/chip/phrase', {})
      .then(function (answer) {
        if (answer && answer.ok === true && Array.isArray(answer.words) && answer.words.length === PAPER) {
          paper = { words: answer.words.slice(), screen: slice.state === 'broken' ? 'restore' : 'offer' };
          stage = 'words';
        } else if (refs.goError) kit.say(refs.goError, said(answer));
        return refresh();
      })
      .catch(function (err) { if (refs.goError) kit.say(refs.goError, net.readable(err)); })
      .finally(function () {
        if (refs.fix) setPending(refs.fix, false);
        paint();
      });
  }

  function start(kind, oldWords) {
    if (asking || !refs.go) return;
    asking = true;
    refused = null;
    kit.say(refs.goError, '');
    var go = refs.go;
    setPending(go, true);
    var route = kind === 'restore' ? '/api/vault/chip/restore' : '/api/vault/chip/move';
    net.postJson(route, kind === 'restore' ? { words: oldWords } : {})
      .then(function (answer) {
        if (refs.oldInputs) clearFields(refs.oldInputs);
        if (answer && answer.ok === true && typeof answer.run === 'string') {
          live = { run: answer.run, kind: kind, status: 'creating', reason: null, said: null };
          watched = answer.run;
          return refresh();
        }
        refused = { ok: false, code: answer && answer.code, error: answer && answer.error, said: said(answer) };
        // The paper the move needs is gone (a lock, its half hour): its step comes back.
        if (refused.code === 'paper_needed') refused = null;
        return refresh();
      })
      .catch(function (err) {
        refused = { ok: false, code: 'unanswered', error: '', said: net.readable(err) };
      })
      .finally(function () {
        asking = false;
        setPending(go, false);
        paint();
      });
  }

  /* ---------- a move under way ---------- */

  var RUN_STEPS = {
    migrate: [
      { status: 'creating', words: 'Making this Mac\'s Touch ID key' },
      { status: 'touch_old', words: 'The first Touch ID', says: SAYS.move },
      { status: 'touch_chip', words: 'The second Touch ID', says: SAYS.chip },
      { status: 'simulating', words: 'NEAR checks the move, then Phosphor sends it' },
      { status: 'checking', words: 'Reading your vault until NEAR confirms it' }
    ],
    restore: [
      { status: 'creating', words: 'Making this Mac\'s Touch ID key' },
      { status: 'touch_old', words: 'Touch ID reads your wallet\'s own key', says: SAYS.restore, optional: true },
      { status: 'touch_chip', words: 'Touch ID', says: SAYS.chip },
      { status: 'simulating', words: 'NEAR checks the restore, then Phosphor sends it' },
      { status: 'checking', words: 'Reading your vault until NEAR confirms it' }
    ]
  };

  var seenOld = {};

  function drawRun(flow) {
    var run = runOf();
    var kind = run && run.kind === 'restore' ? 'restore' : 'migrate';
    flow.appendChild(dom.el('p', 'vault-flow-title', kind === 'restore' ? 'Restoring your vault' : 'Moving your vault'));
    var list = dom.el('ol', 'vault-run');
    refs.runSteps = [];
    RUN_STEPS[kind].forEach(function (step) {
      var item = dom.el('li', 'vault-run-step');
      item.dataset.status = step.status;
      var mark = dom.el('span', 'vault-run-mark num');
      mark.setAttribute('aria-hidden', 'true');
      var number = dom.el('span', 'vault-run-number');
      mark.appendChild(number);
      mark.appendChild(dom.el('span', 'spinner'));
      kit.append(mark, kit.icon('check', 'vault-run-check'));
      item.appendChild(mark);
      var words = dom.el('div', 'vault-run-words');
      words.appendChild(dom.el('p', 'vault-run-title', step.words));
      if (step.says) words.appendChild(dom.el('p', 'vault-said', step.says));
      item.appendChild(words);
      list.appendChild(item);
      refs.runSteps.push({ step: step, item: item, number: number });
    });
    flow.appendChild(list);
    refs.runNote = kit.text('vault-sub');
    refs.runNote.setAttribute('role', 'status');
    flow.appendChild(refs.runNote);
  }

  function paintRun() {
    var run = runOf();
    if (!refs.runSteps || !run) return;
    var at = ORDER.indexOf(run.status === 'submitting' ? 'simulating' : run.status);
    if (run.status === 'touch_old') seenOld[run.id] = true;
    var shown = 0;
    refs.runSteps.forEach(function (entry) {
      var index = ORDER.indexOf(entry.step.status);
      var state = index < at ? 'done' : (index === at ? 'now' : 'next');
      entry.item.dataset.state = state;
      // A restore asks this Touch ID only when this Mac must read the wallet's own key first.
      var hide = !!entry.step.optional && !seenOld[run.id] && state !== 'now';
      dom.setHidden(entry.item, hide);
      if (!hide) shown += 1;
      dom.setText(entry.number, String(shown));
    });
    var touch = run.status === 'touch_old' || run.status === 'touch_chip';
    dom.setText(refs.runNote, touch
      ? 'Touch ID is asking now. Approve it only if it reads the sentence above.'
      : run.status === 'checking'
        ? 'Sent. Phosphor reads your vault every 15 seconds until NEAR confirms it, also after a restart. Your assistant\'s moves wait until then.'
        : 'Keep Phosphor open. Your assistant\'s moves wait until this is done.');
  }

  /* ---------- a vault that moved ---------- */

  function fact(key) {
    var item = dom.el('li', 'vault-rule');
    item.dataset.fact = key;
    var top = dom.el('div', 'vault-rule-top');
    top.appendChild(dom.el('span', 'vault-rule-label'));
    top.appendChild(dom.el('span', 'vault-rule-value'));
    item.appendChild(top);
    item.appendChild(dom.el('p', 'vault-rule-note'));
    return item;
  }

  function paintFact(node, words, value, tone, note) {
    dom.setText(node.querySelector('.vault-rule-label'), words);
    var slot = node.querySelector('.vault-rule-value');
    dom.setText(slot, value);
    dom.setAttr(slot, 'data-tone', tone || null);
    var under = node.querySelector('.vault-rule-note');
    dom.setText(under, note || '');
    dom.setHidden(under, !note);
  }

  function warnLine() {
    var line = dom.el('p', 'vault-warn');
    kit.append(line, kit.icon('warning', 'icon-16'));
    var words = dom.el('span', '');
    line.appendChild(words);
    return { line: line, words: words };
  }

  function drawMoved(flow) {
    refs.doneLine = dom.el('p', 'vault-text vault-backup-line');
    refs.doneLine.setAttribute('data-backed', 'true');
    refs.doneLine.setAttribute('role', 'status');
    kit.append(refs.doneLine, kit.icon('shield', 'vault-backup-mark'));
    refs.doneLine.appendChild(dom.el('span', 'vault-backup-words', 'Your vault is on this Mac\'s Touch ID key.'));
    flow.appendChild(refs.doneLine);
    refs.doneSub = kit.text('vault-sub', 'From now on every move out of your vault asks for a Touch ID that names it. Your assistant spends from your allowance.');
    flow.appendChild(refs.doneSub);
    refs.pins = dom.el('ul', 'vault-rules vault-pins');
    refs.pinVault = fact('pin-vault');
    refs.pinAllowance = fact('pin-allowance');
    refs.pins.appendChild(refs.pinVault);
    refs.pins.appendChild(refs.pinAllowance);
    flow.appendChild(refs.pins);

    flow.appendChild(dom.el('p', 'vault-flow-title', 'Who opens your vault'));
    var list = dom.el('ul', 'vault-rules vault-facts');
    refs.facts = { chip: fact('chip'), paper: fact('paper'), old: fact('old'), door: fact('door') };
    list.appendChild(refs.facts.chip);
    list.appendChild(refs.facts.paper);
    list.appendChild(refs.facts.old);
    list.appendChild(refs.facts.door);
    flow.appendChild(list);
    var door = warnLine();
    refs.doorOpen = door.line;
    refs.doorOpenText = door.words;
    flow.appendChild(door.line);
    var others = warnLine();
    refs.others = others.line;
    refs.othersText = others.words;
    flow.appendChild(others.line);
    refs.truth = dom.el('div', 'vault-plain');
    refs.truth.appendChild(kit.text('vault-sub vault-truth'));
    refs.truth.appendChild(kit.text('vault-sub vault-truth'));
    flow.appendChild(refs.truth);
  }

  function paintMoved() {
    if (!refs.facts) return;
    var vault = current.vault || {};
    var name = backupName(vault);
    var pins = slice.pins;
    dom.setHidden(refs.doneLine, !justDone);
    dom.setHidden(refs.doneSub, !justDone);
    dom.setHidden(refs.pins, !(justDone && pins));
    if (justDone && pins) {
      paintFact(refs.pinVault, 'Your vault', short(pins.vault), null, null);
      paintFact(refs.pinAllowance, 'Your allowance', pins.allowance ? short(pins.allowance) : 'Not read yet', null, 'This Mac\'s Touch ID key signs only for these two.');
    }
    if (justDone && !refs.doneLine.dataset.popped) {
      refs.doneLine.dataset.popped = 'true';
      kit.pop(refs.doneLine);
    }

    var unread = 'Not read yet';
    var paperOn = slice.recoveryOnChain;
    var oldOn = slice.oldOnChain;
    var door = slice.predecessorAuth;
    paintFact(refs.facts.chip, 'This Mac\'s Touch ID key', 'Opens it', null, null);
    paintFact(refs.facts.paper, 'Your paper key', paperOn === true ? 'Opens it' : (paperOn === false ? 'Not on your vault' : unread), paperOn === false ? 'warn' : null,
      paperOn === false ? 'Your vault reads no paper key. Move your money to a fresh wallet while this Mac still opens your vault.' : null);
    paintFact(refs.facts.old, 'Your ' + name, oldOn === false ? 'No longer opens it' : (oldOn === true ? 'Still opens it' : unread), oldOn === true ? 'warn' : null,
      'It still opens your allowance, the gas account and Hyperliquid.');
    paintFact(refs.facts.door, 'The NEAR door', door === false ? 'Shut' : (door === true ? 'Open' : unread), door === true ? 'warn' : null,
      'A way for your ' + name + ' to act for your vault through NEAR. The move shut it. NEAR Intents\' admins can open it again for any account, and this line reads it from NEAR.');
    dom.setText(refs.doorOpenText, 'NEAR Intents\' admins opened the NEAR door again, so your ' + name + ' can reach your vault through it. Keep it like cash, and move your money to a fresh wallet if anyone else may have it.');
    dom.setHidden(refs.doorOpen, door !== true);
    var others = Array.isArray(slice.otherKeys) ? slice.otherKeys : [];
    dom.setText(refs.othersText, others.length
      ? 'Your vault also holds ' + (others.length === 1 ? 'a key' : others.length + ' keys') + ' Phosphor did not add: ' + others.map(short).join(', ') + '. It can move your vault\'s money. Send what your vault and allowance hold to a wallet whose key was made fresh, then stop using this one.'
      : '');
    dom.setHidden(refs.others, !others.length);
    var truth = plainTruth(vault);
    dom.setText(refs.truth.childNodes[0], truth[0]);
    dom.setText(refs.truth.childNodes[1], truth[1]);
  }

  /* ---------- from the Restore row ---------- */

  function startRestore() {
    if (!mounted || !refs.row) return;
    kit.bringIntoView(refs.row);
    var focus = refs.flow.querySelector('input') || refs.flow.querySelector('button');
    if (focus && focus.focus) focus.focus();
  }

  /* The paper key leaves the window: the words, the fields, and the step goes
     back to where it rests. The moment a move landed rests too: back on the
     tab, the row says who opens the vault. */
  function wipe() {
    var had = !!paper || stage !== null || justDone;
    paper = null;
    stage = null;
    misses = 0;
    justDone = false;
    if (refs.flow) {
      var fields = refs.flow.querySelectorAll('.vault-paper-input');
      for (var i = 0; i < fields.length; i += 1) fields[i].value = '';
    }
    if (had && mounted && slice) paint();
  }

  /* ---------- the trading key ----------

     Once the vault has moved, the trading key comes from the wallet's own
     key at every open and is written nowhere (src/hl/agent-key.ts). One
     Touch ID approves it on Hyperliquid for 90 days, and the dialog names
     it. A key near its end is said so: with none, Freeze cannot close a
     position. */
  function buildTrading(host) {
    var r = kit.row('Trading key', 'trading');
    refs.trading = r.node;
    refs.tradingValue = dom.el('span', 'vault-row-value');
    r.act.appendChild(refs.tradingValue);
    refs.tradingLine = kit.text();
    r.main.appendChild(refs.tradingLine);
    var warn = warnLine();
    refs.tradingWarn = warn.line;
    refs.tradingWarnText = warn.words;
    refs.tradingWarn.hidden = true;
    r.main.appendChild(refs.tradingWarn);
    refs.tradingSays = kit.text('vault-sub');
    r.main.appendChild(refs.tradingSays);
    refs.tradingDone = dom.el('p', 'vault-text vault-backup-line');
    refs.tradingDone.setAttribute('data-backed', 'true');
    refs.tradingDone.setAttribute('role', 'status');
    kit.append(refs.tradingDone, kit.icon('shield', 'vault-backup-mark'));
    refs.tradingDoneText = dom.el('span', 'vault-backup-words');
    refs.tradingDone.appendChild(refs.tradingDoneText);
    refs.tradingDone.hidden = true;
    r.main.appendChild(refs.tradingDone);
    refs.tradingError = kit.problem();
    r.main.appendChild(refs.tradingError);
    refs.tradingVenue = kit.text('vault-sub');
    refs.tradingVenue.hidden = true;
    r.main.appendChild(refs.tradingVenue);
    var tools = dom.el('div', 'vault-actions');
    refs.tradingGo = button('Allow trading on Hyperliquid', 'btn-ghost btn-sm', 'Waiting for Touch ID');
    refs.tradingLock = button('Lock now', 'btn-quiet btn-sm', 'Locking');
    refs.tradingLock.hidden = true;
    tools.appendChild(refs.tradingGo);
    tools.appendChild(refs.tradingLock);
    r.main.appendChild(tools);
    dom.on(refs.tradingGo, 'click', allowTrading);
    dom.on(refs.tradingLock, 'click', lockForKey);
    refs.trading.hidden = true;
    host.appendChild(r.node);
  }

  function readTrading() {
    if (!net || typeof net.getJson !== 'function' || !slice || slice.state !== 'done') return;
    net.getJson('/api/vault/trading-key', { noCache: true })
      .then(function (answer) {
        trading = answer && answer.data && typeof answer.data === 'object' ? answer.data : null;
        paintTrading();
      })
      .catch(function () {
        trading = null;
        paintTrading();
      });
  }

  function paintTrading() {
    if (!refs.trading) return;
    var on = !!slice && slice.state === 'done' && !!trading && trading.moved === true;
    dom.setHidden(refs.trading, !on);
    if (!on) return;
    var key = trading.key && typeof trading.key === 'object' ? trading.key : null;
    var days = typeof trading.days === 'number' ? trading.days : 90;
    var now = Date.now();
    var until = key && typeof key.validUntil === 'number' ? key.validUntil : null;
    var when = until !== null ? kit.dateWords(new Date(until).toISOString()) : '';
    var ended = !!key && (key.expired === true || (until !== null && until <= now));
    var soon = !!key && !ended && until !== null && until - now < SOON_MS;
    dom.setText(refs.tradingValue, key ? (ended ? 'Ended' : 'Until ' + when) : '');
    dom.setText(refs.tradingLine, key
      ? short(key.address) + (ended ? ' traded for your plans until ' : ' trades for your plans until ') + when + '.'
      : 'Your plans trade on Hyperliquid with a trading key. One Touch ID lets a new one trade for ' + days + ' days.');
    dom.setText(refs.tradingWarnText, ended
      ? 'Your trading key has ended. Allow a new one so your plans can trade and Freeze can close your positions.'
      : (soon ? 'It stops on ' + when + '. Allow a new one before then: without a trading key, Freeze cannot close your positions.' : ''));
    dom.setHidden(refs.tradingWarn, !(ended || soon));
    var next = typeof trading.next === 'string' && trading.next ? trading.next : null;
    dom.setText(refs.tradingSays, next
      ? 'Its Touch ID reads: Let ' + short(next) + ' trade on your Hyperliquid account for ' + (days === 1 ? '1 day' : days + ' days') + '.'
      : '');
    dom.setHidden(refs.tradingSays, !next || !!tradingDone);
    refs.tradingGo.className = 'btn ' + (key && !ended && !soon ? 'btn-quiet btn-sm' : 'btn-ghost btn-sm');
    dom.setHidden(refs.tradingDone, !tradingDone);
    if (tradingDone) dom.setText(refs.tradingDoneText, tradingDone);
  }

  function allowTrading() {
    if (tradingAsked) return;
    tradingAsked = true;
    tradingDone = null;
    kit.say(refs.tradingError, '');
    dom.setHidden(refs.tradingVenue, true);
    dom.setHidden(refs.tradingLock, true);
    setPending(refs.tradingGo, true);
    net.postJson('/api/vault/trading-key/allow', {}, { touch: true })
      .then(function (answer) {
        if (answer && answer.ok === true) {
          var until = typeof answer.validUntil === 'number' ? kit.dateWords(new Date(answer.validUntil).toISOString()) : '';
          tradingDone = short(answer.address) + ' can trade on your Hyperliquid account' + (until ? ' until ' + until : '') + '.';
          paintTrading();
          kit.pop(refs.tradingDone);
          readTrading();
          return refresh();
        }
        kit.sayRefusal(refs.tradingError, answer, said(answer, 'Touch ID did not finish, so nothing was signed. Try again.'));
        // The venue's own words, as text and never markup, under the sentence.
        if (answer && answer.code === 'refused' && typeof answer.venue === 'string' && answer.venue.trim()) {
          dom.setText(refs.tradingVenue, 'Hyperliquid said: ' + answer.venue.trim().slice(0, 200));
          dom.setHidden(refs.tradingVenue, false);
        }
        dom.setHidden(refs.tradingLock, !(answer && answer.code === 'reopen'));
        return null;
      })
      .catch(function (err) { kit.say(refs.tradingError, net.readable(err)); })
      .finally(function () {
        tradingAsked = false;
        setPending(refs.tradingGo, false);
        paintTrading();
      });
  }

  // A second trading key in one open needs the wallet locked and opened again (the `reopen` refusal).
  function lockForKey() {
    var api = window.PhosphorApi;
    if (!api || typeof api.lock !== 'function') return;
    setPending(refs.tradingLock, true);
    api.lock()
      .then(function () { return refresh(); })
      .catch(function (err) { kit.say(refs.tradingError, net.readable(err)); })
      .finally(function () {
        setPending(refs.tradingLock, false);
        dom.setHidden(refs.tradingLock, true);
      });
  }

  window.PhosphorChip = {
    SAYS: SAYS,
    mount: mount,
    mountTrading: mountTrading,
    render: render,
    wipe: wipe,
    startRestore: startRestore,
    plainTruth: plainTruth
  };
})();
