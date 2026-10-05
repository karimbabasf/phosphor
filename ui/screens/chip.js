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

   ONE BUTTON. Karim, 2026-10-05, after setting up a second Mac: the move was
   "a little complicated". So the row says what the move gives in two lines
   and offers one button, Secure my vault. The press opens the steps the move
   still needs, one at a time and in order: the wallet to Touch ID, the
   backup, the paper key, the move. A step already done never shows. Phosphor
   pays NEAR's fee for every vault move, so no step asks for NEAR.

   THE PAPER KEY. Its words come from the backend once (POST
   /api/vault/chip/phrase), are drawn in this row only, and are held in this
   file's memory, never the store, a log or a frame, until the paper is
   checked, the window locks or the tab is left. Hide words takes them off the
   screen and keeps them, so the paper being written stays the one checked.
   There is no Print and no Copy: a printer and a clipboard both keep a copy.
   The check is three words at random places, typed from the paper with
   pasting off and compared here, a slip named by its number and never by the
   word; then the 24 this row holds go back (phrase-proven), and the backend
   holds the paper's key until the move signs with it. All 24 are typed only
   where this row no longer holds them: after a lock, the tab left or a
   restart, and for the old paper of a restore.

   ONE NAME FOR EACH THING, the one the docs, the refusals and the Touch ID
   sentences use: your vault, your allowance, your paper key, this Mac's Touch
   ID key, and the wallet's own backup by the name its row gives it. Nothing a
   person reads says chip, enclave, marker, nonce or keychain; the one part
   underneath that has to be shown, the NEAR door, is said with what it does. */
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
  // The words of the paper the check asks for, at random places.
  var CHECK = 3;
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

  /* The paper key while it is on screen or being checked: here only. */
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
  // Secure my vault was pressed on this visit to the tab, and the steps it counts.
  var started = false;
  var plan = null;
  // Why the words are back on screen after two misses, said once above them.
  var againNote = null;

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
    // Once the allowance exists (after the move), its size plus 10 percent in dollars. While a
    // move is under way the sweep also keeps what it will spend (src/vault/allowance.ts sweepPlan).
    var a = slice && slice.allowance && typeof slice.allowance.sizeUsd === 'number' && slice.allowance.sizeUsd > 0 ? slice.allowance : null;
    var cap = a && kit ? ', ' + kit.usdShort(Math.floor(a.sizeUsd * 110 + 1e-6) / 100) + ' now' : '';
    return [
      'Your paper key is the only key that opens your vault away from this Mac.',
      'Your ' + backupName(vault) + ' also controls your allowance (its size plus 10 percent' + cap + ', more while a move is under way) and your Hyperliquid account, so keep both like cash.'
    ];
  }

  // An address or a key as the Touch ID dialogs shorten it: eight and eight, an address in lower case.
  function short(id) {
    var s = String(id || '');
    if (/^0x/i.test(s)) s = s.toLowerCase();
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

  /* Which of the row's five faces: the offer, the restore, a move under way,
     a vault that moved, or a check in progress. A move that failed, or one a
     restart cut short (the state still says moving, with no run in this
     process), goes back to its steps: the paper typed again, then Try again.
     A restore is told by its run, or by a vault whose own key is already off
     it. Checking is a vault this Mac moved whose note on disk went missing:
     one calm line while NEAR is asked, never the offer to move it again. */
  function screenOf(run) {
    if (!slice) return 'none';
    if (underWay(run)) return 'run';
    if (slice.state === 'checking') return 'checking';
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
    refs.secure = button('Secure my vault', 'btn-sm');
    refs.secure.hidden = true;
    dom.on(refs.secure, 'click', secure);
    r.act.appendChild(refs.secure);
    refs.line = kit.text();
    r.main.appendChild(refs.line);
    refs.sub = kit.text('vault-sub');
    refs.sub.hidden = true;
    r.main.appendChild(refs.sub);
    var block = warnLine();
    refs.block = block.line;
    refs.blockText = block.words;
    refs.block.hidden = true;
    r.main.appendChild(refs.block);
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

  // The trading key's row, last in the section: after the allowance and the old fee account.
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
      offer: 'Your money stays in your vault. Your assistant spends from a small allowance, and anything bigger needs your Touch ID.',
      restore: 'Your vault answers to a Touch ID key this Mac does not have.',
      run: run && run.kind === 'restore' ? 'Your vault is coming to this Mac\'s Touch ID key.' : 'Your vault is moving to this Mac\'s Touch ID key.',
      moved: screen === 'moved' ? whoOpens(vault) : '',
      checking: 'Checking which keys open your vault, with NEAR. This takes a moment.'
    };
    dom.setText(refs.line, lines[screen] || '');
    dom.setText(refs.value, screen === 'moved' ? 'Touch ID' : '');
    paintCard(screen);

    var open = showsSteps(screen);
    var key = screen === 'offer' || screen === 'restore' ? screen + ':' + (open ? stepNow(screen) + ':' + bodyKey(screen) : 'card') : screen;
    if (screen === 'run') key += ':' + (run ? run.id : '');
    if (key !== drawn) {
      var first = drawn === '';
      // A step after a step keeps its card: only the words change, and they rise in (vault.css).
      var fade = refs.stepBody && open ? null : refs.flow;
      drawn = key;
      var redraw = function () { drawFlow(screen); };
      if (first) redraw();
      else kit.grow(refs.row, redraw, fade);
      return;
    }
    update(screen);
  }

  /* ---------- the offer and the restore: one step at a time ----------

     The offer is the row's two lines and Secure my vault. The press opens the
     steps the move still needs, in this order, one at a time; the password
     card opens with the press when it is the first. A restore has no press:
     it is the only way on, so its steps show at once, in its own order. */
  var STEPS = {
    offer: ['touch', 'backup', 'paper', 'move'],
    restore: ['touch', 'backup', 'paper', 'old']
  };

  function done(step) {
    var vault = current.vault || {};
    var needs = Array.isArray(slice.needs) ? slice.needs : [];
    if (step === 'touch') return !(needs.indexOf('touch_id') >= 0 && vault.custody === 'software');
    if (step === 'backup') return needs.indexOf('backup') < 0;
    if (step === 'paper') return slice.paper === 'proven';
    return false;
  }

  // The step on screen: the first one not done yet.
  function stepNow(screen) {
    var steps = STEPS[screen];
    for (var i = 0; i < steps.length; i += 1) if (!done(steps[i])) return steps[i];
    return steps[steps.length - 1];
  }

  /* The steps show once Secure my vault is pressed, and with no press for a
     restore, for a move a restart cut short, and for one that failed or was
     refused, so the reason is read where it happened. */
  function isOpen(screen) {
    if (screen === 'restore') return true;
    var run = runOf();
    return started || !!paper || !!refused || slice.state === 'moving' || (!!run && run.status === 'failed');
  }

  function showsSteps(screen) {
    return (screen === 'offer' || screen === 'restore') && isOpen(screen) && !blocked();
  }

  /* The steps this visit counts: the ones still needed when they opened, and
     any that came back since (a paper a restart voided). Done ones never
     show, so "2 of 3" counts only what the person is asked to do. */
  function counted(screen) {
    var need = STEPS[screen].filter(function (step) { return !done(step); });
    if (!plan || plan.screen !== screen) plan = { screen: screen, steps: need };
    else plan.steps = STEPS[screen].filter(function (step) { return plan.steps.indexOf(step) >= 0 || need.indexOf(step) >= 0; });
    return plan.steps;
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

  /* Where the paper step is: on screen here, hidden, its three words asked
     for, typed whole where this row no longer holds it (a lock, the tab
     left, a restart), void, or none. */
  function paperStage() {
    if (paper && stage === 'words') return 'words';
    if (paper && stage === 'hidden') return 'hidden';
    if (paper && stage === 'confirm') return 'confirm';
    if (slice.paper === 'shown' || slice.paper === 'retype') return 'typeback';
    if (slice.paper === 'void') return 'void';
    return 'none';
  }

  // Why no step can start yet, with nothing on this row that gets past it.
  function blocked() {
    var vault = current.vault || {};
    var needs = Array.isArray(slice.needs) ? slice.needs : [];
    if (needs.indexOf('open') >= 0) return 'Open your wallet to go on.';
    if (needs.indexOf('touch_id') >= 0 && vault.custody !== 'software') return 'Touch ID only works inside the Phosphor app. Open the app to move your vault.';
    return '';
  }

  /* The row's own lines on the offer and the restore: what the restore asks
     you to have with you, why nothing can start yet, and the one button while
     no step is open. */
  function paintCard(screen) {
    var steps = screen === 'offer' || screen === 'restore';
    var why = steps ? blocked() : '';
    dom.setText(refs.sub, screen === 'restore' ? 'Have your old paper key with you before you start.' : '');
    dom.setHidden(refs.sub, screen !== 'restore');
    dom.setText(refs.blockText, why);
    dom.setHidden(refs.block, !why);
    dom.setHidden(refs.secure, screen !== 'offer' || !!why || isOpen(screen));
  }

  // The one button: the steps open, and the first one still needed runs from the press.
  function secure() {
    if (!mounted || !slice || started) return;
    started = true;
    plan = null;
    paint();
    if (!showsSteps('offer')) return;
    if (stepNow('offer') === 'touch') {
      kit.openMigrate(false);
      return;
    }
    var first = refs.stepBody && refs.stepBody.querySelector('button');
    if (first && first.focus) first.focus({ preventScroll: true });
  }

  function drawFlow(screen) {
    var flow = refs.flow;
    dom.clear(flow);
    refs.stepTitle = null;
    refs.stepCount = null;
    refs.stepBody = null;
    refs.facts = null;
    refs.runSteps = null;
    refs.go = null;
    refs.fix = null;
    refs.goError = null;
    refs.oldInputs = null;
    flow.dataset.screen = screen;
    if (showsSteps(screen)) drawStep(flow, screen);
    else if (screen === 'run') drawRun(flow);
    else if (screen === 'moved') drawMoved(flow);
    // The offer before its press, and the check, are the row's lines alone: no empty card under them.
    dom.setHidden(flow, !flow.childNodes.length);
    update(screen);
  }

  function update(screen) {
    if (showsSteps(screen)) paintStep(screen);
    else if (screen === 'run') paintRun();
    else if (screen === 'moved') paintMoved();
  }

  function titleOf(step, screen) {
    if (step === 'touch') return 'Turn on Touch ID';
    if (step === 'backup') return 'Back up your ' + backupName(current.vault || {});
    if (step === 'move') return 'Move your vault';
    if (step === 'old') return 'Type your old paper key';
    var at = paperStage();
    if (at === 'confirm') return 'Check three words';
    if (at === 'typeback') return slice.paper === 'retype' ? 'Type your paper key again' : 'Type your paper key';
    return screen === 'restore' ? 'Write a new paper key' : 'Write your paper key';
  }

  /* One step on the card: its name, where it sits among the steps still
     needed ("2 of 3", only when there is more than one), and its body. */
  function drawStep(flow, screen) {
    var now = stepNow(screen);
    var head = dom.el('div', 'vault-move-head');
    refs.stepTitle = dom.el('p', 'vault-flow-title');
    head.appendChild(refs.stepTitle);
    refs.stepCount = dom.el('span', 'vault-move-count num');
    head.appendChild(refs.stepCount);
    flow.appendChild(head);
    var body = dom.el('div', 'vault-move-body');
    body.dataset.step = now;
    flow.appendChild(body);
    refs.stepBody = body;
    if (now === 'touch') drawTouchStep(body);
    else if (now === 'backup') drawBackupStep(body);
    else if (now === 'paper') drawPaperStep(body, screen);
    else if (now === 'move') drawMoveStep(body);
    else drawOldStep(body);
  }

  function paintStep(screen) {
    if (!refs.stepTitle) return;
    var now = stepNow(screen);
    var steps = counted(screen);
    var at = steps.indexOf(now);
    var shown = steps.length > 1 && at >= 0;
    dom.setText(refs.stepTitle, titleOf(now, screen));
    dom.setText(refs.stepCount, shown ? (at + 1) + ' of ' + steps.length : '');
    dom.setHidden(refs.stepCount, !shown);
    paintOpen(now);
  }

  /* The open step's lines follow the state while what the person typed
     stays. */
  function paintOpen(now) {
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

  /* ---------- step: the wallet to Touch ID ---------- */

  // The password card the Keys row opens (ui/screens/vault.js openMigrate): the move needs Touch ID.
  function drawTouchStep(body) {
    body.appendChild(kit.text('vault-text', 'Your wallet still opens with a password. Type it once, and Touch ID opens it from now on.'));
    var tools = dom.el('div', 'vault-actions');
    var go = button('Protect with Touch ID', 'btn-sm');
    dom.on(go, 'click', function () { kit.openMigrate(false); });
    tools.appendChild(go);
    body.appendChild(tools);
  }

  /* ---------- step: the backup ----------

     The backup row's own reveal, started from here (its Touch ID, its words
     or key, its proof); once it is proven the row brings this one back into
     view (backedUp below). */
  function drawBackupStep(body) {
    body.appendChild(kit.text('vault-text', 'After the move it still opens your allowance and Hyperliquid.'));
    var tools = dom.el('div', 'vault-actions');
    var go = button('Back it up', 'btn-sm');
    dom.on(go, 'click', function () { kit.startReveal(); });
    tools.appendChild(go);
    body.appendChild(tools);
  }

  /* ---------- step: the paper key ---------- */

  function drawPaperStep(body, screen) {
    var at = paperStage();
    if (at === 'words') drawWords(body);
    else if (at === 'hidden') drawHidden(body);
    else if (at === 'confirm') drawConfirm(body);
    else if (at === 'typeback') drawTypeBack(body, screen);
    else drawPaperOffer(body, screen, at === 'void');
  }

  function drawPaperOffer(body, screen, isVoid) {
    var vault = current.vault || {};
    if (isVoid) {
      var gone = kit.problem();
      body.appendChild(gone);
      kit.say(gone, 'The paper key shown earlier opens nothing. Destroy it, then write a new one.');
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
        paper = { words: words.slice(), screen: screen, ask: pickPlaces() };
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
  function drawWords(body) {
    var vault = current.vault || {};
    var again = againNote;
    againNote = null;
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
    body.appendChild(kit.text('vault-sub', 'Check each word as you write it.'));
    var tools = dom.el('div', 'vault-actions');
    var wrote = button('I wrote it down', 'btn-sm');
    var hide = button('Hide words', 'btn-quiet btn-sm');
    tools.appendChild(wrote);
    tools.appendChild(hide);
    body.appendChild(tools);
    dom.on(wrote, 'click', function () {
      stage = 'confirm';
      paint();
    });
    dom.on(hide, 'click', function () {
      stage = 'hidden';
      paint();
    });
    // The step opens at its warning, so the lock line and both plain sentences are read first.
    if (wrote.focus) wrote.focus({ preventScroll: true });
    kit.bringIntoView(warn);
  }

  // Hide words: off the screen, still this paper, until it is checked, a lock or the tab left.
  function drawHidden(body) {
    body.appendChild(kit.text('vault-text', 'Your paper key is hidden. Show it again to finish writing it down.'));
    var tools = dom.el('div', 'vault-actions');
    var again = button('Show the words again', 'btn-sm');
    var wrote = button('I wrote it down', 'btn-quiet btn-sm');
    tools.appendChild(again);
    tools.appendChild(wrote);
    body.appendChild(tools);
    dom.on(again, 'click', function () {
      stage = 'words';
      paint();
    });
    dom.on(wrote, 'click', function () {
      stage = 'confirm';
      paint();
    });
    if (again.focus) again.focus();
  }

  /* Fields a word is typed into from the paper: no paste and no drop, since
     either is a copy of the screen and the check is of the paper; the line
     under them says why. */
  function wordField(at, name) {
    var field = dom.el('label', 'vault-paper-field');
    field.appendChild(dom.el('span', 'meta num', String(at + 1)));
    var input = dom.el('input', 'input vault-paper-input');
    input.type = 'text';
    input.name = name + '-' + (at + 1);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', 'Word ' + (at + 1));
    field.appendChild(input);
    return { field: field, input: input };
  }

  function typingOnly(inputs, hint) {
    inputs.forEach(function (input) {
      dom.on(input, 'paste', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        dom.setText(hint, 'Type each word from your paper. Pasting is off here, so the check is of your paper.');
        hint.hidden = false;
      });
      dom.on(input, 'drop', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
    });
  }

  /* All 24 words from the paper, one to a field, where this row no longer
     holds them. A space or Enter goes on to the next field, so the words can
     be typed in one run. */
  function paperFields(body, name) {
    var grid = dom.el('div', 'vault-paper-fields');
    var inputs = [];
    for (var i = 0; i < PAPER; i += 1) {
      var made = wordField(i, name);
      grid.appendChild(made.field);
      inputs.push(made.input);
    }
    body.appendChild(grid);
    var hint = kit.text('vault-sub');
    hint.hidden = true;
    body.appendChild(hint);
    typingOnly(inputs, hint);
    inputs.forEach(function (input, i) {
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

  // Three places of the 24, drawn when the paper is shown and kept through a miss.
  function pickPlaces() {
    var out = [];
    var c = window.crypto;
    while (out.length < CHECK) {
      var at;
      if (c && typeof c.getRandomValues === 'function') {
        var one = new Uint32Array(1);
        c.getRandomValues(one);
        at = one[0] % PAPER;
      } else at = Math.floor(Math.random() * PAPER);
      if (out.indexOf(at) < 0) out.push(at);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  /* The check: three words of the paper, by their number. Compared here with
     the words this row still holds, so a slip is named by its number and
     never by the word, and nothing is sent until all three match; then the
     24 go to the backend, which checks them against the paper it showed and
     holds its key for the move. */
  function drawConfirm(body) {
    body.appendChild(kit.text('vault-sub', 'Type these words from your paper.'));
    var grid = dom.el('div', 'vault-paper-fields vault-paper-check');
    var inputs = paper.ask.map(function (at) {
      var made = wordField(at, 'check');
      grid.appendChild(made.field);
      return made.input;
    });
    body.appendChild(grid);
    var hint = kit.text('vault-sub');
    hint.hidden = true;
    body.appendChild(hint);
    typingOnly(inputs, hint);
    refs.paperError = kit.problem();
    body.appendChild(refs.paperError);
    var tools = dom.el('div', 'vault-actions');
    var check = button('Check', 'btn-sm', 'Checking');
    var again = button('Show the words again', 'btn-quiet btn-sm');
    tools.appendChild(check);
    tools.appendChild(again);
    body.appendChild(tools);
    dom.on(again, 'click', function () {
      clearFields(inputs);
      stage = 'words';
      paint();
    });
    dom.on(check, 'click', function () { confirmPaper(inputs, check); });
    inputs.forEach(function (input, i) {
      dom.on(input, 'input', function () { kit.say(refs.paperError, ''); });
      dom.on(input, 'keydown', function (event) {
        if (!event || event.key !== 'Enter') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (i < inputs.length - 1) {
          if (inputs[i + 1].focus) inputs[i + 1].focus();
        } else confirmPaper(inputs, check);
      });
    });
    if (inputs[0] && inputs[0].focus) inputs[0].focus();
  }

  // The numbers of the words that do not match, said as a person would.
  function slipLine(slips) {
    if (slips.length === 1) return 'Word ' + slips[0] + ' does not match your paper key. Check it on your paper, then try again.';
    return 'Words ' + slips.slice(0, -1).join(', ') + ' and ' + slips[slips.length - 1] + ' do not match your paper key. Check them on your paper, then try again.';
  }

  function confirmPaper(inputs, check) {
    if (!paper || check.disabled) return;
    var typed = valuesOf(inputs).map(function (w) { return String(w || '').trim().toLowerCase(); });
    if (typed.some(function (w) { return !w; })) {
      kit.say(refs.paperError, 'Type all three words.');
      return;
    }
    var slips = [];
    paper.ask.forEach(function (at, k) { if (typed[k] !== paper.words[at]) slips.push(at + 1); });
    if (slips.length) {
      misses += 1;
      if (misses >= 2) {
        clearFields(inputs);
        misses = 0;
        showWordsAgain('Two tries did not match. Check your paper word by word, then try again.');
        return;
      }
      kit.say(refs.paperError, slipLine(slips));
      return;
    }
    kit.say(refs.paperError, '');
    setPending(check, true);
    net.postJson('/api/vault/chip/phrase-proven', { words: paper.words.slice() })
      .then(function (answer) {
        if (answer && answer.ok === true) {
          clearFields(inputs);
          paper = null;
          stage = null;
          misses = 0;
          return refresh();
        }
        kit.say(refs.paperError, said(answer));
        return null;
      })
      .catch(function (err) { kit.say(refs.paperError, net.readable(err)); })
      .finally(function () { setPending(check, false); });
  }

  /* The paper typed whole: after a restart against the paper checked before
     it, or after a lock or the tab left against the paper still waiting. */
  function drawTypeBack(body, screen) {
    var retype = slice.paper === 'retype';
    body.appendChild(kit.text('vault-sub', retype
      ? 'Phosphor forgets a checked paper key after 30 minutes, a lock or a restart, so type the paper you wrote for this move again, all 24 words.'
      : 'The words left this screen before you checked them. Type all 24 from your paper, or show a new paper key.'));
    var inputs = paperFields(body, 'paper');
    refs.paperError = kit.problem();
    body.appendChild(refs.paperError);
    var tools = dom.el('div', 'vault-actions');
    var check = button('Check my paper', 'btn-sm', 'Checking');
    tools.appendChild(check);
    var fresh = button('Show a new paper key', 'btn-quiet btn-sm', 'Opening');
    dom.on(fresh, 'click', function () { showPaper(fresh, screen); });
    tools.appendChild(fresh);
    body.appendChild(tools);
    dom.on(check, 'click', function () { provePaper(inputs, check); });
    dom.on(inputs[inputs.length - 1], 'keydown', function (event) {
      if (!event || event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      provePaper(inputs, check);
    });
    if (inputs[0] && inputs[0].focus) inputs[0].focus();
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
          return refresh();
        }
        kit.say(refs.paperError, said(answer, 'Those words do not match your paper key. Check each word against your paper.'));
        return null;
      })
      .catch(function (err) { kit.say(refs.paperError, net.readable(err)); })
      .finally(function () { setPending(check, false); });
  }

  // Two misses: the words come back on screen, with why.
  function showWordsAgain(why) {
    if (!paper) return;
    stage = 'words';
    againNote = why;
    paint();
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
    refs.fix = button('Back it up', 'btn-ghost btn-sm');
    refs.fix.hidden = true;
    dom.on(refs.fix, 'click', fixIt);
    tools.appendChild(refs.fix);
    body.appendChild(tools);
  }

  function drawMoveStep(body) {
    body.appendChild(kit.text('vault-text', 'Two Touch IDs move it, in one call to NEAR that lands whole or not at all. Phosphor pays NEAR\'s fee for every vault move, as it does for swaps.'));
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
    drawSays(body, [['If this Mac asks for your wallet\'s key first, Touch ID reads', SAYS.restore], ['Then Touch ID reads', SAYS.chip]]);
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
     again: the backup, or a new paper for a paper that is gone. */
  function fixOf() {
    var run = runOf();
    var code = refused ? refused.code : (run && run.status === 'failed' ? run.reason : null);
    if (code === 'not_backed_up') return { label: 'Back it up', go: 'backup' };
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
    if (fix.go === 'backup') {
      kit.startReveal();
      return;
    }
    refused = null;
    setPending(refs.fix, true);
    net.postJson('/api/vault/chip/phrase', {})
      .then(function (answer) {
        if (answer && answer.ok === true && Array.isArray(answer.words) && answer.words.length === PAPER) {
          paper = { words: answer.words.slice(), screen: slice.state === 'broken' ? 'restore' : 'offer', ask: pickPlaces() };
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

  /* The row's first line once the vault moved: the worst fact NEAR read about
     who opens it, and nothing NEAR has not read since the move. */
  function whoOpens(vault) {
    var name = backupName(vault);
    if (slice.chipOnChain === false) return 'This Mac\'s Touch ID key no longer opens your vault.';
    if (Array.isArray(slice.otherKeys) && slice.otherKeys.length) return 'Your vault also answers to a key Phosphor did not add.';
    if (slice.oldOnChain === true) return 'Your ' + name + ' still opens your vault.';
    if (slice.predecessorAuth === true) return 'Your ' + name + ' can reach your vault again, through the NEAR door.';
    if (slice.recoveryOnChain === false) return 'Only this Mac\'s Touch ID key opens your vault. It has no paper key.';
    if (unreadFacts()) return 'Your vault moved to this Mac\'s Touch ID key and your paper key.';
    return 'This Mac\'s Touch ID key and your paper key open your vault, and nothing else does.';
  }

  // A fact about who opens the vault that NEAR has not answered since the vault moved.
  function unreadFacts() {
    return [slice.chipOnChain, slice.recoveryOnChain, slice.oldOnChain, slice.predecessorAuth].some(function (f) { return typeof f !== 'boolean'; }) ||
      !Array.isArray(slice.otherKeys);
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
    refs.doneSub = kit.text('vault-sub');
    flow.appendChild(refs.doneSub);
    refs.doneTools = dom.el('div', 'vault-actions');
    var topUp = button('Top up', 'btn-ghost btn-sm');
    dom.on(topUp, 'click', function () {
      var allowance = window.PhosphorAllowance;
      if (allowance && typeof allowance.topUp === 'function') allowance.topUp();
    });
    refs.doneTools.appendChild(topUp);
    flow.appendChild(refs.doneTools);
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
    refs.reading = kit.text('vault-sub', 'Phosphor is reading your vault from NEAR to confirm who opens it.');
    refs.reading.setAttribute('role', 'status');
    flow.appendChild(refs.reading);
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
    // The move puts nothing in the allowance: until a top-up, every move the assistant asks for asks a Touch ID.
    var a = slice.allowance;
    var empty = !!a && typeof a.sizeUsd === 'number' && a.sizeUsd > 0 && typeof a.balanceUsd === 'number' && a.balanceUsd < 0.005;
    dom.setText(refs.doneSub, empty
      ? 'From now on every move out of your vault asks for a Touch ID that names it. Your allowance starts empty: top it up so your assistant can spend up to ' + kit.usdShort(a.sizeUsd) + ' with no Touch ID.'
      : 'From now on every move out of your vault asks for a Touch ID that names it. Your assistant spends from your allowance.');
    dom.setHidden(refs.doneTools, !(justDone && empty));
    dom.setHidden(refs.pins, !(justDone && pins));
    if (justDone && pins) {
      paintFact(refs.pinVault, 'Your vault', short(pins.vault), null, null);
      paintFact(refs.pinAllowance, 'Your allowance', pins.allowance ? short(pins.allowance) : 'Not read yet', null, 'This Mac\'s Touch ID key signs only for these two.');
    }
    if (justDone && !refs.doneLine.dataset.popped) {
      refs.doneLine.dataset.popped = 'true';
      // Move my vault sat at the foot of the last step: the tick pops where the person can see it.
      kit.bringIntoView(refs.doneLine);
      kit.pop(refs.doneLine);
    }

    // A fact NEAR has not answered since the move is never a yes or a no (src/vault/rekey.ts chipSlice).
    var checking = 'Checking...';
    var chipOn = slice.chipOnChain;
    var paperOn = slice.recoveryOnChain;
    var oldOn = slice.oldOnChain;
    var door = slice.predecessorAuth;
    paintFact(refs.facts.chip, 'This Mac\'s Touch ID key', chipOn === true ? 'Opens it' : (chipOn === false ? 'Not on your vault' : checking), chipOn === false ? 'warn' : null,
      chipOn === false ? 'NEAR reads it off your vault, so this Mac cannot move your vault\'s money.' : null);
    paintFact(refs.facts.paper, 'Your paper key', paperOn === true ? 'Opens it' : (paperOn === false ? 'Not on your vault' : checking), paperOn === false ? 'warn' : null,
      paperOn === false ? 'Your vault reads no paper key. Move your money to a fresh wallet while this Mac still opens your vault.' : null);
    paintFact(refs.facts.old, 'Your ' + name, oldOn === false ? 'No longer opens it' : (oldOn === true ? 'Still opens it' : checking), oldOn === true ? 'warn' : null,
      'It still opens your allowance and Hyperliquid.');
    paintFact(refs.facts.door, 'The NEAR door', door === false ? 'Shut' : (door === true ? 'Open' : checking), door === true ? 'warn' : null,
      door === true
        ? 'A way for your ' + name + ' to act for your vault through NEAR. NEAR Intents\' admins opened it again.'
        : 'A back way in for your ' + name + ', through NEAR. The move shut it, and Phosphor checks it each time it reads your vault.');
    dom.setHidden(refs.reading, !unreadFacts());
    dom.setText(refs.doorOpenText, 'NEAR Intents\' admins opened the NEAR door again, so your ' + name + ' can reach your vault. Keep it like cash. If anyone else may have it, send your money to a wallet only you control.');
    dom.setHidden(refs.doorOpen, door !== true);
    var others = Array.isArray(slice.otherKeys) ? slice.otherKeys : [];
    dom.setText(refs.othersText, others.length
      ? 'Your vault also holds ' + (others.length === 1 ? 'a key' : others.length + ' keys') + ' Phosphor did not add: ' + others.map(short).join(', ') + '. It can move your vault\'s money. Send what your vault and allowance hold to a wallet whose key was made fresh, then stop using this one.'
      : '');
    dom.setHidden(refs.others, !others.length);
    var truth = plainTruth(vault);
    dom.setText(refs.truth.childNodes[0], truth[0]);
    // With no paper key on the vault, the paper is no key at all.
    dom.setHidden(refs.truth.childNodes[0], paperOn === false);
    dom.setText(refs.truth.childNodes[1], truth[1]);
  }

  /* ---------- from the Restore row ---------- */

  function startRestore() {
    if (!mounted || !refs.row) return;
    kit.bringIntoView(refs.row);
    var focus = refs.flow.querySelector('input') || refs.flow.querySelector('button');
    if (focus && focus.focus) focus.focus();
  }

  /* The backup the steps sent the person to is proven (ui/screens/vault.js
     proven): this row comes back into view with the next step, in place of
     the backup's row. False when no step is open here. */
  function backedUp() {
    if (!mounted || !slice || !showsSteps(screenOf(runOf()))) return false;
    kit.bringIntoView(refs.row);
    return true;
  }

  /* The paper key leaves the window: the words, the fields, and the step goes
     back to where it rests. The moment a move landed rests too: back on the
     tab, the row says who opens the vault, and an offer is its one button
     again. */
  function wipe() {
    var had = !!paper || stage !== null || justDone || started;
    paper = null;
    stage = null;
    misses = 0;
    justDone = false;
    started = false;
    plan = null;
    againNote = null;
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
    backedUp: backedUp,
    plainTruth: plainTruth
  };
})();
