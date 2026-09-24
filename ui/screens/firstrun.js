/* First run: one card on the field, as many screens as the custody needs.

   This is the largest gap the product had. Before it, setting Phosphor up meant
   running a terminal command that printed addresses and then hand-editing a
   config file.

   Every flow opens on the same welcome: the mark, the name, one line about
   where the money sits, and Get started. Karim, 2026-09-15: "a completely
   black screen on the background, and then professional welcoming first,
   animated of course". Behind it nothing of the app shows: the page is hidden
   outright and the site's hairline field drifts on the ink instead.

   Three flows share the card. With the Secure Enclave ready it is the welcome
   and three screens: Create wallet, the addresses, the assistant. The phrase is
   not shown here; backup is prompted later and proven in the Vault tab. A
   wallet file another Mac made opens on Restore instead of Create. Without an
   enclave the software screens run after the welcome, on one of two paths: a
   new wallet (its words, then three of them typed back and checked by the
   app) or one brought in with its phrase.

   The terms of use are the first step after the welcome for a person with no
   wallet yet, so the product's own moment is the first thing anyone sees
   (ui/screens/terms.js keeps its card for a newer version over a wallet that
   already exists). Steps are named, never numbered, and the progress counts
   them in four phases a person can hold in their head. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var FLOWS = {
    create: ['welcome', 'choose', 'password', 'words', 'prove', 'addresses', 'money', 'connect', 'threshold', 'done'],
    import: ['welcome', 'choose', 'password', 'import', 'addresses', 'money', 'connect', 'threshold', 'done'],
    enclave: ['welcome', 'create', 'addresses', 'connect'],
    foreign: ['welcome', 'foreign', 'addresses', 'connect']
  };

  /* What the progress names. The welcome and the terms come before any of
     it and are not counted. */
  var PHASES = [
    { name: 'Wallet', steps: ['choose', 'password', 'import', 'create', 'foreign'] },
    { name: 'Backup', steps: ['words', 'prove'] },
    { name: 'Money', steps: ['addresses', 'money'] },
    { name: 'Assistant', steps: ['connect', 'threshold', 'done'] }
  ];
  var UNCOUNTED = ['welcome', 'terms'];
  var PROVE_COUNT = 3;
  var ASK_CHOICES = [25, 100, 500, 1000];

  var STEPS = FLOWS.create;
  var EASE = [0.16, 1, 0.3, 1];

  var host = null;
  /* The card is two things: `shell` is the box, and `card` the body inside it
     that every screen draws into and that a step change swaps out. */
  var shell = null;
  var card = null;
  var progress = null;
  var ghost = null;
  var fieldCanvas = null;
  var runs = { field: null, welcome: null, body: null, ghost: null };
  var stepHandle = null;
  var step = 0;
  var welcomed = false;
  /* `agent` is what the assistant step learned: which agent was picked, the app's check of it,
     whether it is on the door, and whether the app started it. The done screen reads its
     sentence off this rather than asserting a connection nobody made. `moneyIn` is whether the
     money step saw the balance land. */
  var draft = { path: 'create', password: '', mnemonic: [], threshold: 100, addresses: null, agent: null, moneyIn: false, backedUp: false, wordsNote: '' };
  var open_ = false;

  function boot() {
    host = document.getElementById('screen-firstrun');
  }

  function stateNow() {
    return store && typeof store.get === 'function' ? (store.get() || {}) : {};
  }

  /* Which flow, read off the vault slice, the path picked on the choose step
     and whether the terms still wait. */
  function flowOf() {
    var state = stateNow();
    var vault = state.vault || {};
    var base = vault.foreign === true
      ? FLOWS.foreign
      : (vault.enclave && vault.enclave.ready === true ? FLOWS.enclave : (draft.path === 'import' ? FLOWS.import : FLOWS.create));
    var steps = base.slice();
    var terms = window.PhosphorTerms;
    if (terms && typeof terms.required === 'function' && typeof terms.content === 'function' && terms.required(state)) steps.splice(1, 0, 'terms');
    return steps;
  }

  /* The flow again, keeping the person on the step they are on, or on the one
     that took its place (the terms step, once accepted, is gone). */
  function reflow() {
    var name = STEPS[step];
    STEPS = flowOf();
    var at = STEPS.indexOf(name);
    step = at >= 0 ? at : Math.max(0, Math.min(step, STEPS.length - 1));
  }

  function open() {
    if (!host || open_) return;
    open_ = true;
    draft.path = 'create';
    draft.backedUp = false;
    draft.wordsNote = '';
    STEPS = flowOf();
    dom.setAttr(document.body, 'data-locked', 'true');
    /* The page is not frosted behind this card, it is not painted at all
       (lock.css): a person who has no wallet yet has nothing to see through. */
    dom.setAttr(document.body, 'data-firstrun', 'true');
    setPageInert(true);
    dom.setHidden(host, false);
    dom.clear(host);
    shell = dom.el('div', 'screen-card firstrun-card');
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'firstrun-title');
    shell.setAttribute('tabindex', '-1');
    host.appendChild(shell);
    mountField();
    progress = null;
    ghost = null;
    card = dom.el('div', 'screen-body');
    shell.appendChild(card);
    step = 0;
    welcomed = false;
    draw();
  }

  function close() {
    stopRuns();
    dropGhost();
    cleanupStep();
    unmountField();
    draft.mnemonic = [];
    draft.password = '';
    open_ = false;
    dom.setHidden(host, true);
    dom.setAttr(document.body, 'data-locked', null);
    dom.setAttr(document.body, 'data-firstrun', null);
    setPageInert(false);
    window.PhosphorShell.refresh({});
  }

  /* Same pair as lock.js: the page behind this card is hidden by the
     stylesheet and taken off the keyboard and the accessibility tree here. */
  function setPageInert(on) {
    var page = document.getElementById('page');
    if (!page) return;
    if ('inert' in page) page.inert = on;
    dom.setAttr(page, 'aria-hidden', on ? 'true' : null);
  }

  /* ---------- the field ---------- */

  /* The site's hairline field, on a canvas under the card. It fades up over
     600 ms when the screen opens, then the welcome arrives on top of it. */
  function mountField() {
    var Field = window.PhosphorField;
    if (!Field || typeof Field.mount !== 'function') return;
    fieldCanvas = document.createElement('canvas');
    fieldCanvas.id = 'field';
    fieldCanvas.className = 'field-layer';
    fieldCanvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(fieldCanvas, shell);
    Field.mount(fieldCanvas, { clear: shell, fps: 30 });
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    runs.field = Motion.animate(fieldCanvas, { opacity: [0, 1] }, { duration: reduced() ? 0.3 : 0.6, ease: EASE });
    var run = runs.field;
    whenDone(run, function () {
      if (runs.field === run) runs.field = null;
      if (fieldCanvas) fieldCanvas.style.opacity = '';
    });
  }

  function unmountField() {
    var Field = window.PhosphorField;
    if (Field && typeof Field.unmount === 'function') Field.unmount();
    if (fieldCanvas && fieldCanvas.parentNode) fieldCanvas.parentNode.removeChild(fieldCanvas);
    fieldCanvas = null;
  }

  function refitField() {
    var Field = window.PhosphorField;
    if (fieldCanvas && Field && typeof Field.refit === 'function') Field.refit();
  }

  /* ---------- steps ---------- */

  /* To a step by its name, or by its place in the flow. */
  function go(target) {
    var at = typeof target === 'string' ? STEPS.indexOf(target) : target;
    if (at < 0) return;
    step = Math.max(0, Math.min(STEPS.length - 1, at));
    swap();
  }

  /* The step after this one, or Home when there is none. The enclave flow ends
     on the assistant screen; the software flow has its own Done. */
  function next() {
    if (step + 1 >= STEPS.length) {
      finish();
      return;
    }
    go(step + 1);
  }

  function finish() {
    close();
    window.PhosphorShell.setView('basic', { fromClick: true });
  }

  /* THE STEP CHANGE. The body that is leaving lifts and fades over 150 ms while
     the next one, already drawn, fades up over 300 ms. The leaving body is
     taken out of the flow first, so the card takes its new height at once and
     only the paint crosses. A click that lands mid-way throws the leaving body
     away and starts again from the body that is up, so nothing stacks and no
     body is ever left hidden. Without motion.dev the swap is a plain replace. */
  function swap() {
    dropGhost();
    var old = card;
    var box = old && typeof old.offsetTop === 'number'
      ? { top: old.offsetTop, left: old.offsetLeft, width: old.offsetWidth }
      : null;
    var fresh = dom.el('div', 'screen-body');
    card = fresh;
    if (old && old.parentNode === shell) shell.insertBefore(fresh, old);
    else shell.appendChild(fresh);
    /* The leaving title hands the dialog's label to the next one. */
    var oldTitle = old ? old.querySelector('h1') : null;
    if (oldTitle) oldTitle.id = '';
    draw();
    if (!old) return;
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function' || !box) {
      detach(old);
      return;
    }
    if (runs.body) stopRun(runs.body);
    if (runs.welcome) stopRun(runs.welcome);
    runs.body = null;
    runs.welcome = null;

    ghost = old;
    ghost.className += ' screen-body-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.top = box.top + 'px';
    ghost.style.left = box.left + 'px';
    ghost.style.width = box.width + 'px';
    dom.setAttr(shell, 'data-swapping', 'true');
    var still = reduced();
    var out = Motion.animate(ghost, still ? { opacity: 0 } : { opacity: 0, y: -8 }, { duration: 0.15, ease: EASE });
    runs.ghost = out;
    whenDone(out, function () {
      if (ghost === old) dropGhost();
    });

    fresh.style.opacity = '0';
    var run = Motion.animate(fresh, still ? { opacity: [0, 1] } : { opacity: [0, 1], y: [8, 0] }, { duration: 0.3, delay: 0.1, ease: EASE });
    runs.body = run;
    whenDone(run, function () {
      if (runs.body === run) runs.body = null;
      if (card === fresh) clearInline(fresh);
    });
  }

  function dropGhost() {
    if (runs.ghost) {
      stopRun(runs.ghost);
      runs.ghost = null;
    }
    if (ghost) {
      detach(ghost);
      ghost = null;
    }
    if (shell) dom.setAttr(shell, 'data-swapping', null);
  }

  function stopRuns() {
    var keys = ['field', 'welcome', 'body', 'ghost'];
    for (var i = 0; i < keys.length; i += 1) {
      if (runs[keys[i]]) stopRun(runs[keys[i]]);
      runs[keys[i]] = null;
    }
  }

  function stopRun(run) {
    if (run && typeof run.stop === 'function') run.stop();
  }

  function whenDone(run, fn) {
    var finished = run && run.finished ? run.finished : run;
    Promise.resolve(finished).then(fn, fn);
  }

  /* motion.dev writes the final values inline as it finishes. They are taken
     back off so the stylesheet alone says how a body at rest looks. */
  function clearInline(node) {
    if (!node || !node.style) return;
    node.style.opacity = '';
    node.style.transform = '';
    node.style.filter = '';
  }

  function detach(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function reduced() {
    return !!(window.PhosphorMotion && typeof window.PhosphorMotion.reduced === 'function' && window.PhosphorMotion.reduced());
  }

  /* A step that mounted something with a life of its own (the address picker)
     takes it down before the next step draws. */
  function cleanupStep() {
    if (stepHandle && typeof stepHandle.destroy === 'function') stepHandle.destroy();
    stepHandle = null;
  }

  function draw() {
    cleanupStep();
    dom.clear(card);
    var name = STEPS[step];
    card.className = name === 'welcome' ? 'screen-body firstrun-welcome' : (name === 'done' ? 'screen-body firstrun-done' : 'screen-body');
    card.dataset.step = name;
    drawProgress();
    if (name === 'welcome') screenWelcome();
    else if (name === 'terms') screenTerms();
    else if (name === 'create') screenCreate();
    else if (name === 'foreign') screenForeign();
    else if (name === 'choose') screenChoose();
    else if (name === 'password') screenPassword();
    else if (name === 'words') screenWords();
    else if (name === 'prove') screenProve();
    else if (name === 'import') screenImport();
    else if (name === 'addresses') screenAddresses();
    else if (name === 'money') screenMoney();
    else if (name === 'connect') screenConnect();
    else if (name === 'threshold') screenThreshold();
    else if (name === 'done') screenDone();
    var title = card.querySelector('h1');
    if (title) title.id = 'firstrun-title';
    refitField();
    /* The first field or button takes the cursor. The developer switch is an
       input too, and it is never the thing to land on. The welcome is the
       exception: the card itself takes it, so the one button arrives without
       a focus ring drawn on it before anyone has touched a key, and Tab still
       reaches it first. The choose step lands on the path that is picked. */
    if (name === 'welcome') {
      if (shell && typeof shell.focus === 'function') shell.focus();
      return;
    }
    var focusable = (name === 'choose' && card.querySelector('.choice[data-chosen]')) || card.querySelector('input.input, textarea.input, button');
    if (focusable) focusable.focus();
  }

  /* The progress: the phases the flow has (Wallet, Backup, Money, Assistant),
     each named over a thin bar that fills as its steps are passed, the phase
     the person is in in the text tone. The count in words is for a screen
     reader. The welcome and the terms come before it: no bar, not counted.
     The bars are kept between steps, so a fill slides rather than jumps. */
  function drawProgress() {
    var name = STEPS[step];
    var counted = STEPS.filter(function (s) { return UNCOUNTED.indexOf(s) === -1; });
    var at = counted.indexOf(name);
    if (at < 0 || !counted.length) {
      if (progress) detach(progress);
      progress = null;
      return;
    }
    var phases = PHASES.map(function (phase) {
      return { name: phase.name, steps: counted.filter(function (s) { return phase.steps.indexOf(s) !== -1; }) };
    }).filter(function (phase) { return phase.steps.length > 0; });
    var shape = phases.map(function (phase) { return phase.name + phase.steps.length; }).join(',');
    if (!progress || progress.dataset.shape !== shape) {
      if (progress) detach(progress);
      progress = dom.el('div', 'screen-progress');
      progress.dataset.shape = shape;
      progress.appendChild(dom.el('span', 'sr-only'));
      phases.forEach(function (phase) {
        var item = dom.el('span', 'screen-phase');
        item.setAttribute('aria-hidden', 'true');
        item.dataset.phase = phase.name;
        item.appendChild(dom.el('span', 'screen-phase-name', phase.name));
        var bar = dom.el('span', 'screen-phase-bar');
        bar.appendChild(dom.el('span', 'screen-phase-fill'));
        item.appendChild(bar);
        progress.appendChild(item);
      });
      shell.insertBefore(progress, shell.firstChild);
    }
    dom.setText(progress.querySelector('.sr-only'), 'Step ' + (at + 1) + ' of ' + counted.length);
    var items = progress.querySelectorAll('.screen-phase');
    for (var i = 0; i < phases.length && i < items.length; i += 1) {
      var own = phases[i].steps;
      var passed = own.filter(function (s) { return counted.indexOf(s) <= at; }).length;
      var here = own.indexOf(name) !== -1;
      dom.setAttr(items[i], 'data-current', here ? 'true' : null);
      dom.setAttr(items[i], 'data-done', !here && passed === own.length ? 'true' : null);
      var fill = items[i].querySelector('.screen-phase-fill');
      if (fill && fill.style) fill.style.transform = 'scaleX(' + (passed / own.length) + ')';
    }
  }

  function actions(primaryLabel, onPrimary, options) {
    var opts = options || {};
    var row = dom.el('div', 'screen-actions');
    if (opts.back !== false && step > 0) {
      var back = dom.el('button', 'btn btn-ghost');
      back.appendChild(dom.el('span', 'btn-label', 'Back'));
      row.appendChild(back);
      dom.on(back, 'click', function () { go(step - 1); });
    }
    if (opts.skip) {
      var skip = dom.el('button', 'btn btn-quiet');
      skip.appendChild(dom.el('span', 'btn-label', opts.skip));
      row.appendChild(skip);
      dom.on(skip, 'click', function () { next(); });
    }
    /* `quiet` draws the primary as a ghost: a step that is waiting on the world
       (money landing) has no action to press yet, and the caller turns it
       primary the moment there is one. */
    var primary = dom.el('button', opts.quiet ? 'btn btn-ghost btn-lg' : 'btn btn-primary btn-lg');
    primary.appendChild(dom.el('span', 'btn-label', primaryLabel));
    /* The word the step waits under, reserved here so the box is already wide
       enough for it: "Waiting for Touch ID" on a Create button used to run
       straight through the border. */
    if (opts.pending) dom.setAttr(primary, 'data-pending-label', opts.pending);
    if (opts.disabled) primary.disabled = true;
    row.appendChild(primary);
    dom.on(primary, 'click', function () { onPrimary(primary); });
    card.appendChild(row);
    return primary;
  }

  /* The mark above the name, in the window's own light: the one screen that
     introduces the product opens on the thing it is recognised by. */
  function markBlock(state) {
    var mark = dom.el('div', 'firstrun-mark');
    mark.setAttribute('aria-hidden', 'true');
    var markSvg = state ? dom.mark(null, state) : dom.mark();
    if (markSvg) mark.appendChild(markSvg);
    card.appendChild(mark);
    return mark;
  }

  /* 0. THE WELCOME, and the one authored moment on this surface. The field is
     already fading up; the mark, the name, the line and the button arrive
     after it, one behind the other, each lifting 12 px and clearing from a
     6 px blur over 400 ms. The whole thing is done inside 1.2 s and plays once
     per open: Back to this screen finds it already there. Reduced motion shows
     everything at once, opacity only. */
  function screenWelcome() {
    var mark = markBlock();
    var title = dom.el('h1', 'firstrun-welcome-title', 'Welcome to Phosphor');
    card.appendChild(title);
    var line = dom.el('p', 'firstrun-welcome-line', 'Your money stays on this Mac, under a key only you hold. Your assistant does the work. You decide what needs your click.');
    card.appendChild(line);
    var primary = actions('Get started', function () { go(1); }, { back: false });
    if (welcomed) return;
    welcomed = true;
    enter([mark, title, line, primary.parentNode]);
  }

  function enter(nodes) {
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    var items = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].style) items.push(nodes[i]);
    }
    if (!items.length) return;
    for (var j = 0; j < items.length; j += 1) items[j].style.opacity = '0';
    var still = reduced();
    var run = Motion.animate(
      items,
      still ? { opacity: [0, 1] } : { opacity: [0, 1], y: [12, 0], filter: ['blur(6px)', 'blur(0px)'] },
      still
        ? { duration: 0.3, ease: EASE }
        : { duration: 0.4, ease: EASE, delay: typeof Motion.stagger === 'function' ? Motion.stagger(0.09, { startDelay: 0.45 }) : 0.45 }
    );
    runs.welcome = run;
    whenDone(run, function () {
      if (runs.welcome === run) runs.welcome = null;
      for (var k = 0; k < items.length; k += 1) clearInline(items[k]);
    });
  }

  /* WHERE THE WALLET LIVES. Three lines a person can check against what they
     see: on this Mac, behind this lock, out of the assistant's reach. Karim,
     2026-09-15: "where the wallet is held, safety proof if that makes sense,
     so they feel comfortable, in simple english". The developer switch under
     them opens the same facts in their technical form; the words there are
     the ones src/keystore and src/driver.ts use. */
  function whereBlock(kind) {
    var block = dom.el('div', 'firstrun-where');
    var facts = dom.el('ul', 'firstrun-facts');
    facts.appendChild(fact(icon('mac'), 'Made and kept on this Mac.', 'Nothing is uploaded, and there is no account to make.'));
    if (kind === 'enclave') {
      facts.appendChild(fact(icon('lock'), 'Locked by this Mac\'s Secure Enclave.', 'Touch ID opens it, and the key never leaves the chip.'));
    } else {
      facts.appendChild(fact(icon('lock'), 'Locked by your password.', 'Nobody can reset it, not us, not your assistant. Your recovery phrase brings the wallet back.'));
    }
    facts.appendChild(fact(icon('hide'), 'Your assistant never sees the key.', 'It asks, the app checks your limits, and anything above them waits for your click.'));
    block.appendChild(facts);

    var dev = window.PhosphorDev;
    if (dev && typeof dev.control === 'function') block.appendChild(dev.control('Show the technical details'));

    var details = dom.el('ul', 'firstrun-dev');
    details.setAttribute('data-dev-only', '');
    details.appendChild(devLine(['File: ', ['~/.phosphor/'], ['keys.enc.json'], ', mode ', ['0600'], '.']));
    details.appendChild(devLine(['Envelope: ', ['AES-256-GCM'], ' twice. A data key wraps the payload; the password KDF (', ['scrypt'], ') or the Secure Enclave wraps the data key. The header is AAD.']));
    details.appendChild(devLine(['Secure Enclave wrap: a ', ['P-256'], ' key made in the enclave through CryptoKit, not exportable. The data key is wrapped to its public half.']));
    details.appendChild(devLine(['Boundary: the assistant talks to this app over MCP. Signing happens here, and the driver is locked to ', ['mcp__phosphor__*'], ' tools.']));
    block.appendChild(details);
    card.appendChild(block);
    return block;
  }

  function fact(iconNode, lead, rest) {
    var item = dom.el('li', 'firstrun-fact');
    var slot = dom.el('span', 'firstrun-fact-icon');
    slot.setAttribute('aria-hidden', 'true');
    if (iconNode) slot.appendChild(iconNode);
    item.appendChild(slot);
    var text = dom.el('p', 'firstrun-fact-text');
    text.appendChild(dom.el('span', 'firstrun-fact-lead', lead));
    text.appendChild(dom.el('span', '', ' ' + rest));
    item.appendChild(text);
    return item;
  }

  /* A line of prose with the names in the mono face: each part is a string,
     or a one-item array for a path or an algorithm. */
  function devLine(parts) {
    var item = dom.el('li', 'firstrun-dev-line');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (Array.isArray(part)) item.appendChild(dom.el('code', 'mono', part[0]));
      else item.appendChild(dom.el('span', '', part));
    }
    return item;
  }

  /* One icon from the drawn set, or nothing where the set is not loaded. */
  function icon(name, className) {
    var icons = window.PhosphorIcons;
    return icons && typeof icons.svg === 'function' ? icons.svg(name, className) : null;
  }

  /* The enclave first run, whole. One click makes the wallet and one Touch ID
     proves this Mac can open it before the screen says so. No phrase here: the
     words are revealed later, behind Touch ID, once there is something to lose. */
  function screenCreate() {
    card.appendChild(dom.el('h1', 'title', 'Create your wallet'));
    card.appendChild(dom.el('p', 'body dim', 'One click makes it. One Touch ID proves this Mac can open it.'));
    whereBlock('enclave');

    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);

    actions('Create wallet', function (button) {
      error.hidden = true;
      window.PhosphorShell.setPending(button, true);
      api.vaultCreate()
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, vaultProblem(answer.code || answer.error));
            return;
          }
          draft.addresses = answer.addresses || null;
          next();
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { back: false, pending: 'Waiting for Touch ID' });
    card.appendChild(dom.el('p', 'meta', 'One Touch ID confirms it. Nothing to write down yet.'));
  }

  /* A version 2 file another Mac made. Its key lives in that Mac's Secure
     Enclave and nothing here can ask it, so the only way in is the phrase. */
  function screenForeign() {
    card.appendChild(dom.el('h1', 'title', 'Made on another Mac'));
    card.appendChild(dom.el('p', 'body dim', 'The wallet file on this Mac was made by a different Mac, so this one cannot open it. Type your recovery phrase to bring the wallet here.'));

    var f = phraseField('Recovery phrase, 12 or 24 words');
    card.appendChild(f.node);
    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);

    actions('Restore', function (button) {
      var words = wordsOf(f.input.value);
      if (words.length !== 12 && words.length !== 24) {
        return fail(error, 'That is ' + words.length + (words.length === 1 ? ' word' : ' words') + '. It should be 12 or 24.');
      }
      error.hidden = true;
      window.PhosphorShell.setPending(button, true);
      api.vaultRestore(words.join(' '))
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, vaultProblem(answer.code || answer.error));
            return;
          }
          f.input.value = '';
          draft.addresses = answer.addresses || null;
          next();
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { back: false, pending: 'Restoring' });
  }

  /* THE TERMS, the first step for a person with no wallet yet. The words are
     the terms card's own (ui/screens/terms.js), so the two never disagree;
     accepting is one write, and the step leaves when the app says accepted. */
  function screenTerms() {
    var terms = window.PhosphorTerms;
    card.appendChild(dom.el('h1', 'title', 'Before you start'));
    var note = terms && typeof terms.content === 'function' ? terms.content(card) : null;
    actions('Accept and continue', function (button) {
      if (!terms || typeof terms.accept !== 'function') return;
      window.PhosphorShell.setPending(button, true);
      if (note) dom.setText(note, 'Saving your answer.');
      terms.accept().then(function (answer) {
        window.PhosphorShell.setPending(button, false);
        if (!answer || answer.ok !== true) {
          if (note) dom.setText(note, answer && answer.reason ? answer.reason : 'The app did not record the answer. Try again.');
          return;
        }
        /* Accepted: the step leaves the flow, and the one after it takes
           its place. */
        reflow();
        swap();
      });
    }, { pending: 'Saving' });
  }

  /* 1. Two paths, as one choice: the tile picked is raised, with a tick. */
  function screenChoose() {
    card.appendChild(dom.el('h1', 'title', 'Create or bring a wallet'));
    var options = dom.el('div', 'firstrun-choices');
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', 'Which wallet');
    options.appendChild(choice('Make a new wallet', 'A new wallet starts empty. You add money in a minute.', 'create'));
    options.appendChild(choice('I already have one', 'Bring it in with its recovery phrase, 12 or 24 words.', 'import'));
    card.appendChild(options);
    actions('Continue', function () { go('password'); });
  }

  function choice(title, note, value) {
    var button = dom.el('button', 'choice');
    button.type = 'button';
    button.dataset.value = value;
    button.setAttribute('role', 'radio');
    markChoice(button, draft.path === value);
    var words = dom.el('span', 'choice-text');
    words.appendChild(dom.el('span', 'title-sm', title));
    words.appendChild(dom.el('span', 'meta', note));
    button.appendChild(words);
    var tick = dom.el('span', 'choice-tick');
    tick.setAttribute('aria-hidden', 'true');
    var glyph = icon('done', 'icon-20');
    if (glyph) tick.appendChild(glyph);
    button.appendChild(tick);
    dom.on(button, 'click', function () {
      draft.path = value;
      var all = card.querySelectorAll('.choice');
      for (var i = 0; i < all.length; i += 1) markChoice(all[i], all[i].dataset.value === value);
      reflow();
      drawProgress();
    });
    return button;
  }

  function markChoice(button, on) {
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    dom.setAttr(button, 'data-chosen', on ? 'true' : null);
  }

  /* 2. The software wallet is made here, so this is also where the person
     reads where it will live. No line under the title: the second fact under
     the fields says what the password does, and the card has to fit a 700 px
     window with the technical list open. On the import path the wallet is
     made on the next step, from the phrase. */
  function screenPassword() {
    card.appendChild(dom.el('h1', 'title', 'Set a password'));

    var one = field('Password', 'new-password');
    var two = field('Password again', 'new-password');
    card.appendChild(one.node);
    card.appendChild(two.node);

    var strength = dom.el('p', 'meta');
    strength.hidden = true;
    card.appendChild(strength);
    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);

    whereBlock('software');

    dom.on(one.input, 'input', function () {
      var words = strengthWords(one.input.value);
      dom.setText(strength, words);
      strength.hidden = words === '';
    });

    actions('Continue', function (button) {
      if (one.input.value.length < 8) return fail(error, 'Use at least eight characters.');
      if (one.input.value !== two.input.value) return fail(error, 'The two passwords do not match.');
      error.hidden = true;
      draft.password = one.input.value;
      if (draft.path === 'import') return go('import');
      /* The wallet is made once. A person back on this step after its words
         were shown goes on to them again, never through a second create. */
      if (draft.mnemonic.length) return go('words');

      window.PhosphorShell.setPending(button, true);
      api.walletCreate(draft.password)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, walletProblem(answer.code || answer.error));
            return;
          }
          /* The words come back exactly once, on this response, and are never
             served again. They live in this page's memory until the flow ends
             and nowhere else. */
          draft.mnemonic = Array.isArray(answer.mnemonic) ? answer.mnemonic : [];
          draft.addresses = answer.addresses || null;
          go('words');
        })
        .catch(function (err) { fail(error, err && err.status === 409 ? walletProblem('exists') : net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { pending: 'Making it' });
  }

  /* 3. The words, once. Print and no Copy: a clipboard is a place other
     processes read. The wallet exists from here on, so there is no Back to
     the screens before it. */
  function screenWords() {
    card.appendChild(dom.el('h1', 'title', 'Save your recovery words'));
    card.appendChild(dom.el('p', 'body dim', 'These ' + (draft.mnemonic.length === 24 ? 'twenty-four' : 'twelve') + ' words are the only way back to this wallet. Anyone who has them has your money.'));
    if (draft.wordsNote) {
      var again = dom.el('p', 'firstrun-note');
      var glyph = icon('warning', 'firstrun-note-icon');
      if (glyph) again.appendChild(glyph);
      again.appendChild(dom.el('span', '', draft.wordsNote));
      card.appendChild(again);
      draft.wordsNote = '';
    }

    var grid = dom.el('ol', 'words');
    for (var i = 0; i < draft.mnemonic.length; i += 1) {
      var item = dom.el('li', 'word');
      item.appendChild(dom.el('span', 'meta num', String(i + 1)));
      item.appendChild(dom.el('span', 'body word-text', draft.mnemonic[i]));
      grid.appendChild(item);
    }
    card.appendChild(grid);

    var tools = dom.el('div', 'hstack-2');
    var print = dom.el('button', 'btn btn-ghost btn-sm');
    print.type = 'button';
    print.appendChild(dom.el('span', 'btn-label', 'Print'));
    tools.appendChild(print);
    card.appendChild(tools);
    dom.on(print, 'click', function () { printPhrase(draft.mnemonic); });

    /* The deposit step's own drawn tick (ui/design/deposit.css), so one flow
       has one kind of checkbox. The input is real, so the keyboard and a
       screen reader treat it as one. */
    var check = dom.el('label', 'ack-row firstrun-ack');
    var box = dom.el('input', 'ack-input');
    box.type = 'checkbox';
    box.name = 'saved-words';
    check.appendChild(box);
    var drawn = dom.el('span', 'ack-box');
    drawn.setAttribute('aria-hidden', 'true');
    var tick = icon('done', 'ack-check');
    if (tick) drawn.appendChild(tick);
    check.appendChild(drawn);
    check.appendChild(dom.el('span', 'ack-text', 'I have saved these somewhere that is not this computer.'));
    card.appendChild(check);

    var primary = actions('Continue', function () { go('prove'); }, { disabled: true, back: false });
    dom.on(box, 'change', function () {
      primary.disabled = !box.checked;
      dom.setAttr(check, 'data-checked', box.checked ? 'true' : null);
    });
  }

  /* A sheet with nothing on it but the numbered words, printed and taken
     away again: the Vault's own sheet when it is loaded. */
  function printPhrase(words) {
    var vault = window.PhosphorVault;
    if (vault && typeof vault.printPhrase === 'function') {
      vault.printPhrase(words);
      return;
    }
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

  /* Three positions, never the same three. */
  function pickPositions(count, total) {
    var out = [];
    while (out.length < count && out.length < total) {
      var at = Math.floor(Math.random() * total);
      if (out.indexOf(at) === -1) out.push(at);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  /* 4. Prove it: three words typed back and checked by the app against the
     phrase it holds, the check that marks the wallet backed up. A miss says
     so; two misses show the words again with a line that says why. */
  function screenProve() {
    card.appendChild(dom.el('h1', 'title', 'Prove it'));
    card.appendChild(dom.el('p', 'body dim', 'Type three of your words back, by their number.'));

    var picks = pickPositions(PROVE_COUNT, draft.mnemonic.length);
    var inputs = [];
    var fields = dom.el('div', 'firstrun-fields');
    for (var i = 0; i < picks.length; i += 1) {
      var f = field('Word ' + (picks[i] + 1), 'off');
      f.input.type = 'text';
      f.input.spellcheck = false;
      f.input.setAttribute('autocapitalize', 'off');
      f.input.dataset.index = String(picks[i]);
      fields.appendChild(f.node);
      inputs.push(f.input);
    }
    card.appendChild(fields);

    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);
    var tries = 0;

    actions('Continue', function (button) {
      var words = [];
      for (var i = 0; i < inputs.length; i += 1) {
        var value = inputs[i].value.trim().toLowerCase();
        if (!value) return fail(error, 'Type all three words.');
        words.push({ index: Number(inputs[i].dataset.index), word: value });
      }
      error.hidden = true;
      window.PhosphorShell.setPending(button, true);
      api.vaultBackupProven(words)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            if (answer.code !== 'wrong_words') return fail(error, answer.error || 'That did not work.');
            tries += 1;
            if (tries >= 2) {
              draft.wordsNote = 'Two tries did not match. Check your copy, then try again.';
              go('words');
              return;
            }
            return fail(error, 'Those words do not match. Look at your copy again.');
          }
          draft.backedUp = true;
          next();
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { pending: 'Checking' });
  }

  /* The import path's own step: the phrase, 12 or 24 words, in a box that
     wraps, with every helper that would remember or correct it off. */
  function screenImport() {
    card.appendChild(dom.el('h1', 'title', 'Bring your wallet in'));
    card.appendChild(dom.el('p', 'body dim', 'Type your recovery phrase, 12 or 24 words, with a space between each.'));
    var f = phraseField('Recovery phrase');
    card.appendChild(f.node);
    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);

    actions('Continue', function (button) {
      var words = wordsOf(f.input.value);
      if (words.length !== 12 && words.length !== 24) {
        return fail(error, 'That is ' + words.length + (words.length === 1 ? ' word' : ' words') + '. It should be 12 or 24.');
      }
      error.hidden = true;
      window.PhosphorShell.setPending(button, true);
      api.walletImport({ password: draft.password, mnemonic: words.join(' ') })
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, walletProblem(answer.code || answer.error));
            return;
          }
          f.input.value = '';
          draft.addresses = answer.addresses || null;
          go('addresses');
        })
        .catch(function (err) { fail(error, err && err.status === 409 ? walletProblem('exists') : net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { pending: 'Bringing it in' });
  }

  /* 5. The address picker when the window has one, the plain address list
     when it does not. The wallet exists by now: no Back into making it. */
  function screenAddresses() {
    card.appendChild(dom.el('h1', 'title', 'Your addresses'));
    var body = dom.el('div', 'stack');
    card.appendChild(body);
    var pick = window.PhosphorNetPick;
    stepHandle = pick && typeof pick.render === 'function'
      ? pick.render(body, { context: 'firstrun' })
      : window.PhosphorMoneyIn.render(body);
    actions('Continue', function () { next(); }, { back: false });
  }

  /* 6. The money step is the deposit watch, live, not a spinner: the same line
     the picker draws (netpick.js watcherLine) off the same `deposit` frame, and
     the total off the `wallet` slice, both redrawn on every change while the
     step is up. Continue stays quiet until the money is in the balance, then
     turns primary; "Do this later" stays. Karim, 2026-09-16: "if the only user
     feedback is a timer, it is freaky, especially if it looks like it hasn't
     landed till you skip that step and actually go to the dashboard." */
  function screenMoney() {
    card.appendChild(dom.el('h1', 'title', 'Add money'));
    var value = dom.el('p', 'balance mono');
    card.appendChild(value);
    var lead = dom.el('p', 'body dim');
    card.appendChild(lead);
    var pick = window.PhosphorNetPick;
    var line = pick && typeof pick.watcherLine === 'function' ? pick.watcherLine(card, { stop: false }) : null;
    var idle = dom.el('p', 'meta money-idle');
    dom.setText(idle, 'No address has been shown yet. Go back to pick a network, or do this later.');
    idle.hidden = true;
    card.appendChild(idle);
    var primary = actions('Continue', function () { go('connect'); }, {
      skip: 'Do this later',
      quiet: true
    });
    card.appendChild(dom.el('p', 'meta', 'You can do this later. Your assistant cannot do anything useful until you do.'));

    function paint() {
      var state = store.get() || {};
      var total = (state.wallet && state.wallet.totalUsd) || 0;
      var deposit = state.deposit && typeof state.deposit.phase === 'string' ? state.deposit : null;
      var landed = total > 0 || !!(deposit && deposit.phase === 'credited');
      dom.setText(value, dom.usd(total));
      draft.moneyIn = landed;
      dom.setText(lead, landed ? 'Your money is here.' : 'Send anything to one of your addresses and it will appear here.');
      if (line) line.render(deposit);
      dom.setHidden(idle, landed || !!deposit);
      primary.className = landed ? 'btn btn-primary btn-lg' : 'btn btn-ghost btn-lg';
    }

    var offDeposit = store.select('deposit', paint);
    var offWallet = store.select('wallet', paint);
    paint();
    stepHandle = {
      destroy: function () {
        offDeposit();
        offWallet();
        if (line) line.destroy();
      }
    };
  }

  /* 7. THE AGENT PICKER. One row per agent, the list component below draws
     them with their states and its own Check again; this step owns the title
     and the one action row under it, which follows the list's state: Start
     and the agent's name for one the app can run itself, Continue otherwise.
     Before a ready pick the primary is quiet and "Do this later" stays, so
     nobody is stuck here without an agent (Karim's rule: no dead end). */
  function screenConnect() {
    card.appendChild(dom.el('h1', 'title', 'Your assistant'));
    var body = dom.el('div', 'stack');
    card.appendChild(body);
    var Pick = window.PhosphorAgentPick;
    var row = null;
    var started = false;

    function replaceActions(label, onPrimary, options) {
      if (row && row.parentNode) row.parentNode.removeChild(row);
      var primary = actions(label, onPrimary, options);
      row = primary.parentNode;
      return primary;
    }

    function paintActions(state) {
      var check = state && state.check ? state.check : null;
      draft.agent = state ? { agent: state.agent, check: check, connected: !!state.connected, started: started } : null;
      /* Nothing picked, or an agent that is not ready yet: the list says what
         it needs and carries its own Check again, so the step's way on stays
         quiet and never a dead end. */
      if (!check || check.state === 'not_installed' || check.state === 'installed_not_logged_in') {
        replaceActions('Continue', function () { next(); }, { skip: 'Do this later', quiet: true });
        return;
      }
      if (check.inApp && check.state === 'installed_and_logged_in' && !started && !state.connected) {
        replaceActions('Start your agent', function (button) {
          window.PhosphorShell.setPending(button, true);
          api.driver({ action: 'start', chat: '' })
            .then(function (answer) {
              if (answer && answer.ok === false) throw new Error('refused');
              started = true;
              if (draft.agent) draft.agent.started = true;
              state.handle.say(check.name + ' is ready.', 'ready');
              paintActions(state);
            })
            .catch(function () {
              state.handle.say(check.name + ' could not start. Try again, or start it in your terminal.', 'warn');
            })
            .finally(function () { window.PhosphorShell.setPending(button, false); });
        }, { skip: 'Do this later', pending: 'Starting' });
        return;
      }
      replaceActions('Continue', function () { next(); }, { skip: 'Do this later' });
    }

    if (Pick && typeof Pick.render === 'function') {
      stepHandle = Pick.render(body, {
        context: 'firstrun',
        onState: paintActions
      });
    }
    paintActions(null);
  }

  /* 8. The threshold lands in policy.json the moment Continue is pressed, by
     the person's own click, through the route that runs it past the policy's
     rules (known failure 6: it used to be kept in `draft` and sent nowhere).
     A refusal is the route's one sentence with the figures in it, shown over
     the same Continue. */
  function screenThreshold() {
    card.appendChild(dom.el('h1', 'title', 'When should it ask you?'));

    /* The figure in a money field pressed into the card, the four common
       amounts beside it as one choice that follows what is typed. */
    var line = dom.el('div', 'threshold-line');
    var well = dom.el('label', 'threshold-money');
    well.appendChild(dom.el('span', 'threshold-sign', '$'));
    var input = dom.el('input', 'input threshold-input num');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.name = 'ask-above';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Ask me above, in dollars');
    input.value = String(draft.threshold);
    well.appendChild(input);
    line.appendChild(well);

    var presets = dom.el('div', 'threshold-chips');
    presets.setAttribute('role', 'radiogroup');
    presets.setAttribute('aria-label', 'Common amounts');
    ASK_CHOICES.forEach(function (value) {
      var chip = dom.el('button', 'chip threshold-chip num');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.dataset.value = String(value);
      chip.appendChild(dom.el('span', '', dom.usd(value, 0)));
      presets.appendChild(chip);
      dom.on(chip, 'click', function () {
        input.value = String(value);
        paint();
      });
    });
    line.appendChild(presets);
    card.appendChild(line);

    var explain = dom.el('p', 'body dim');
    card.appendChild(explain);
    card.appendChild(dom.el('p', 'meta', 'You can change this any time in the Vault.'));
    var error = dom.el('p', 'body firstrun-error');
    error.hidden = true;
    card.appendChild(error);

    /* What the figure means, in the policy's own numbers: above it every move
       waits for a click; under it moves run on their own until they add up
       to the policy's daily amount for moves made without asking. */
    function paint() {
      var typed = Number(String(input.value).replace(/[$,\s]/g, ''));
      var ok = String(input.value).trim() !== '' && isFinite(typed) && typed > 0;
      var chips = presets.querySelectorAll('.threshold-chip');
      for (var i = 0; i < chips.length; i += 1) {
        chips[i].setAttribute('aria-checked', ok && Number(chips[i].dataset.value) === typed ? 'true' : 'false');
      }
      var outbound = (stateNow().policy || {}).outbound || {};
      var figure = ok ? dom.usd(typed, Math.round(typed * 100) % 100 === 0 ? 0 : 2) : 'this';
      var auto = typeof outbound.autoApproveDailyUsd === 'number'
        ? ' Under it your assistant can act on its own, up to ' + dom.usd(outbound.autoApproveDailyUsd, 0) + ' in any 24 hours, then it asks again.'
        : '';
      dom.setText(explain, 'Anything above ' + figure + ' waits for your click.' + auto);
    }
    dom.on(input, 'input', paint);
    paint();

    actions('Continue', function (button) {
      var value = Number(String(input.value).replace(/[$,\s]/g, ''));
      if (!isFinite(value) || value <= 0) return fail(error, 'Type a number of dollars above 0.');
      error.hidden = true;
      window.PhosphorShell.setPending(button, true);
      net.postJson('/api/policy/threshold', { usd: value })
        .then(function (answer) {
          if (!answer || answer.ok !== true) throw new Error('not saved');
          draft.threshold = value;
          go('done');
        })
        .catch(function (err) {
          /* The route's refusals are written for this screen, one sentence
             with the figures; anything else is the app not answering. */
          var own = err && (err.status === 400 || err.status === 409) && err.message;
          fail(error, own ? err.message : 'Phosphor could not save that. Try again.');
        })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    }, { pending: 'Saving' });
  }

  /* 9. PHOSPHOR IS READY. The mark flashes once, and three facts each read off
     what the steps before actually saw: the wallet and whether money landed,
     the figure the assistant asks above, and what the assistant step found.
     "Your assistant is connected" used to be printed whatever was picked,
     including a chat app that cannot drive. */
  function screenDone() {
    markBlock('done');
    card.appendChild(dom.el('h1', 'title firstrun-done-title', 'Phosphor is ready'));
    var facts = dom.el('ul', 'firstrun-facts firstrun-done-facts');
    var vault = stateNow().vault || {};
    var backed = draft.backedUp || vault.backedUp === true;
    var money = draft.moneyIn ? 'Your money is here.' : 'Add money any time from the Basic tab.';
    facts.appendChild(fact(icon(backed ? 'shield' : 'lock'), backed ? 'Your wallet is made and backed up.' : 'Your wallet is on this Mac.', backed ? money : money + ' The Vault asks you to prove its recovery phrase once.'));
    facts.appendChild(fact(icon('done'), 'Anything above ' + dom.usd(draft.threshold, Math.round(draft.threshold * 100) % 100 === 0 ? 0 : 2) + ' waits for your click.', 'You can change it any time in the Vault.'));
    var agent = doneAgentLines(draft.agent);
    facts.appendChild(fact(icon('link'), agent.lead, agent.rest));
    card.appendChild(facts);
    actions('Open Phosphor', function () {
      close();
      window.PhosphorShell.setView('basic', { fromClick: true });
    }, { back: false });
  }

  /* The assistant's fact: who it is, and the one thing to do next. */
  function doneAgentLines(agent) {
    var check = agent && agent.check ? agent.check : null;
    var connected = !!(check && (agent.connected || agent.started));
    if (!check) return { lead: 'No assistant yet.', rest: 'Pick one in the Vault tab when you are ready.' };
    return {
      lead: connected ? 'Your assistant is connected.' : (check.name && check.agent !== 'mcp' && check.agent !== 'desktop' ? 'Your assistant is ' + check.name + '.' : 'Your assistant.'),
      rest: connected ? 'Talk to it in the chat on the left.' : doneAgentSentence(agent)
    };
  }

  /* The assistant half of the done screen, one sentence per case the picker can leave behind. An
     agent the chat runs itself starts from the chat's own button, never a terminal. */
  function doneAgentSentence(agent) {
    var check = agent && agent.check ? agent.check : null;
    if (!check) return 'Pick your assistant in the Vault tab when you are ready.';
    if (agent.connected || agent.started) return 'Your assistant is connected.';
    if (check.agent === 'desktop') return 'Install Claude Code or Codex, then pick it in the Vault tab.';
    if (check.agent === 'mcp') return 'Paste the line from the Vault tab into your agent and it will appear.';
    if (check.state === 'installed_and_logged_in' && check.inApp) return 'Press Start your agent in the chat to start ' + check.name + '.';
    if (check.state === 'installed_and_logged_in') return 'Start ' + check.name + ' in your terminal and it will appear.';
    if (check.state === 'installed_not_logged_in' && check.inApp) return 'Sign in to ' + check.name + ', then press Start your agent in the chat.';
    if (check.state === 'installed_not_logged_in') return 'Sign in to ' + check.name + ', then start it in your terminal.';
    return 'Install ' + check.name + ', then pick it in the Vault tab.';
  }

  /* ---------- helpers ---------- */

  function walletProblem(code) {
    if (code === 'wrong_password') return 'That password did not work.';
    if (code === 'exists') return 'There is already a wallet on this computer.';
    if (code === 'no_wallet') return 'There is no wallet on this computer.';
    return 'That did not work.';
  }

  /* The vault routes' refusals, in the words of the screen that asked. */
  function vaultProblem(code) {
    if (code === 'user_cancel') return 'Touch ID was cancelled. Nothing was changed.';
    if (code === 'enclave_unavailable') return 'Touch ID did not answer. Open the Phosphor app and try again.';
    if (code === 'bad_phrase') return 'That phrase is not right. Check every word and the order they are in.';
    if (code === 'not_backed_up') return 'The wallet already on this Mac is not backed up yet, so it cannot be replaced.';
    if (code === 'garbled') return 'The Secure Enclave answered the wrong thing. Try again.';
    return walletProblem(code);
  }

  /* A phrase is typed into a box that wraps, with every helper that would
     remember or correct it switched off. */
  function phraseField(label) {
    var node = dom.el('div', 'field');
    node.appendChild(dom.el('label', 'label', label));
    var input = dom.el('textarea', 'input phrase-input');
    input.name = 'phrase';
    input.rows = 3;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    node.appendChild(input);
    return { node: node, input: input };
  }

  function wordsOf(text) {
    var clean = String(text || '').trim().toLowerCase();
    return clean ? clean.split(/\s+/) : [];
  }

  /* A password input carries a name and an autocomplete hint so a password
     manager can offer to save it. The card is not a form because the flow's
     Continue moves between screens rather than submitting one. */
  function field(label, autocomplete) {
    var node = dom.el('div', 'field');
    node.appendChild(dom.el('label', 'label', label));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.name = autocomplete === 'off' ? 'word' : 'password';
    input.autocomplete = autocomplete;
    node.appendChild(input);
    return { node: node, input: input };
  }

  /* A problem on a step: the warning glyph and the sentence, a step heavier
     than the step's own words, never red. */
  function fail(node, message) {
    dom.clear(node);
    var glyph = icon('warning', 'firstrun-error-icon');
    if (glyph) node.appendChild(glyph);
    node.appendChild(dom.el('span', '', message));
    node.hidden = false;
  }

  /* A strength line in words, not a bar. A bar tells a person a colour; a
     sentence tells them what to do about it. */
  function strengthWords(value) {
    var text = String(value || '');
    if (!text) return '';
    if (text.length < 8) return 'Too short. Use at least eight characters.';
    var classes = 0;
    if (/[a-z]/.test(text)) classes += 1;
    if (/[A-Z]/.test(text)) classes += 1;
    if (/[0-9]/.test(text)) classes += 1;
    if (/[^A-Za-z0-9]/.test(text)) classes += 1;
    if (text.length >= 16) return 'Long enough that length alone protects it.';
    if (classes >= 3) return 'Good. A mix this varied is hard to guess.';
    if (classes === 2) return 'Fine. A few more characters would be better.';
    return 'Weak. Add another kind of character, or make it longer.';
  }

  window.PhosphorFirstRun = {
    boot: boot,
    open: open,
    close: close,
    strengthWords: strengthWords
  };
})();

/* The agent list, one component for two hosts: the first run's assistant
   step above and the Vault (ui/screens/vault.js).

   One tile per agent in the catalog's order (src/agents-catalog.ts): its
   mark, its name, one status line under it, and one action. The status is
   read off the app's own check of this Mac, never guessed and never the
   network's words, and says what a person needs to know: installed, signed
   in, and where it runs.

     Signed in, runs in the chat        the chat on the left runs it
     Signed in, runs in your terminal   it runs outside this window
     Connected                          one of those, on the door right now
     Installed, not signed in           "How to sign in" opens the line to run
     Not installed                      "How to install" opens the line to run
     Connects from outside              any other agent: one line to paste

   A chat app (Claude Desktop) cannot drive Phosphor, so it has no tile: one
   line under the list says so. The one action is Use, which writes the pick,
   checks the agent and registers Phosphor in its config where it can, in one
   round trip, and the list names the agent while it checks. The chat's Start
   then names the agent picked (it hears a `phosphor:agent` event). The agent
   in use says so where its Use would be, with the app's own sentence about
   it under its name. No dots and no colour: the words and the mark carry
   every state. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var COPIED_MS = 1500;

  /* The six entries in the catalog's order. Each row draws the agent's own
     logo (marks.js agent()). The sentences never live here. */
  var AGENTS = [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
    { id: 'hermes', name: 'Hermes' },
    { id: 'grok', name: 'Grok' },
    { id: 'mcp', name: 'Another agent' },
    { id: 'desktop', name: 'Claude Desktop or a chat app' }
  ];

  /* The tiles: every entry but the chat app, which cannot drive Phosphor and
     is said under the list instead. */
  var TILES = AGENTS.filter(function (entry) { return entry.id !== 'desktop'; });

  /* The words this file owns: the state names, and what the list says while
     the app is checking or did not answer. Every sentence about a particular
     agent arrives from the app. */
  var STATE_WORDS = {
    ready: 'Signed in, runs in the chat',
    terminal: 'Signed in, runs in your terminal',
    connected: 'Connected',
    signin: 'Installed, not signed in',
    install: 'Not installed',
    outside: 'Connects from outside',
    cannot: 'Cannot drive Phosphor',
    checking: 'Checking'
  };

  /* The fold that holds the line to run, by the state that needs it. */
  var HOW = {
    signin: { label: 'How to sign in', lead: 'Sign in: ' },
    install: { label: 'How to install', lead: 'Install: ' }
  };

  var COPY = {
    checking: 'Checking on this Mac.',
    noAnswer: 'Phosphor could not check right now. Try again.',
    outside: 'Paste one line into it and it joins this window.',
    cannot: 'Chat apps like Claude Desktop cannot drive Phosphor yet.',
    inUse: 'Your assistant',
    registrationFailed: ' is on this Mac, but Phosphor could not add itself to it. Paste this line into your terminal:',
    runIt: 'Run this in Terminal, then press Check again.',
    onDoor: ' is connected.'
  };

  function canAsk() {
    return !!(api && typeof api.driver === 'function');
  }

  function entryOf(id) {
    for (var i = 0; i < AGENTS.length; i += 1) if (AGENTS[i].id === id) return AGENTS[i];
    return null;
  }

  /* Whether a client of this agent is on the door, read off the roster the
     state carries. Client names are the agents' own words ("claude-code"),
     matched on the vendor's word; another agent is any client at all. */
  function onDoor(id, state) {
    var agents = state && state.agents ? state.agents : null;
    var members = agents && Array.isArray(agents.members) ? agents.members : [];
    if (id === 'desktop' || !members.length) return false;
    if (id === 'mcp') return true;
    for (var i = 0; i < members.length; i += 1) {
      var client = String(members[i].client || members[i].label || '').toLowerCase();
      if (client.indexOf(id) >= 0) return true;
    }
    return false;
  }

  /* The command a check's Details carry after "Install: " or "Sign in: ",
     which src/agents-catalog.ts writes from the catalog's own fields. */
  function commandIn(check, lead) {
    var lines = check && Array.isArray(check.details) ? check.details : [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = String(lines[i]);
      if (line.indexOf(lead) === 0) return line.slice(lead.length).trim();
    }
    return '';
  }

  /* One agent's state from what the app knows about it. `check` is the app's
     answer for a CLI agent (null while it is out); the two entries the app
     cannot probe have a fixed state. */
  function stateOf(id, check, connected) {
    if (id === 'mcp') return connected ? 'connected' : 'outside';
    if (id === 'desktop') return 'cannot';
    if (!check) return 'checking';
    if (check.state === 'not_installed') return 'install';
    if (check.state === 'installed_not_logged_in') return 'signin';
    if (check.state === 'installed_and_logged_in') {
      if (check.inApp) return 'ready';
      return connected ? 'connected' : 'terminal';
    }
    return 'checking';
  }

  /* The agent's own mark, in the box a coin's logo takes. Without marks.js
     (a screen drawn on its own) it is the name's first letter. */
  function agentMark(entry) {
    var marks = window.PhosphorMarks;
    var mark = marks && typeof marks.agent === 'function'
      ? marks.agent(entry.id, null, entry.name)
      : dom.el('span', 'logo', entry.name.charAt(0));
    mark.className += ' agentrow-mark';
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }

  function render(host, options) {
    var opts = options || {};
    if (host.__agentpick && typeof host.__agentpick.destroy === 'function') host.__agentpick.destroy();
    var root = dom.el('div', 'agentpick');
    root.dataset.context = opts.context || 'firstrun';
    dom.clear(host);
    host.appendChild(root);

    var state = {
      agent: opts.picked || null,
      checks: {},
      check: null,
      command: null,
      registered: false,
      registrationFailed: false,
      connected: false,
      busy: false,
      /* Which request is the latest. A click that lands while an earlier
         answer is still out wins: the earlier answer is dropped whole, so a
         row never paints a state for an agent the person has moved off. */
      seq: 0,
      alive: true,
      unsubscribe: null,
      copiedTimer: 0,
      handle: null
    };

    var list = dom.el('ul', 'agentlist');
    list.setAttribute('aria-label', 'Assistants');
    var rows = {};
    TILES.forEach(function (entry) {
      var row = buildRow(entry);
      rows[entry.id] = row;
      list.appendChild(row.node);
    });
    root.appendChild(list);

    /* The one sentence for the list as a whole: a check under way, an answer
       that did not come, a pick the app refused. */
    var status = dom.el('p', 'agentpick-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    root.appendChild(status);

    /* What cannot be picked at all, said once under the list rather than as a
       tile whose only content is no. */
    root.appendChild(dom.el('p', 'agentpick-note', COPY.cannot));

    /* Check again, for a host that has no place of its own for it. The first
       run has one in its action row, and the Vault puts one by its title. */
    var again = null;
    if (opts.again !== false) {
      var foot = dom.el('div', 'agentpick-foot');
      again = dom.el('button', 'btn btn-quiet btn-sm agentpick-again');
      again.type = 'button';
      again.appendChild(dom.el('span', 'btn-label', 'Check again'));
      dom.setAttr(again, 'data-pending-label', 'Checking');
      foot.appendChild(again);
      root.appendChild(foot);
      dom.on(again, 'click', function () { scan(true, again); });
    }

    function buildRow(entry) {
      var node = dom.el('li', 'agentrow');
      node.dataset.agent = entry.id;
      node.appendChild(agentMark(entry));

      var text = dom.el('div', 'agentrow-text');
      var name = dom.el('p', 'agentrow-name', entry.name);
      var said = dom.el('p', 'agentrow-state');
      var line = dom.el('p', 'agentrow-line');
      line.hidden = true;
      /* The line to run sits behind a fold: a shell command is the ask for
         a developer, and a person who is not one reads the status and the
         name of the step first. */
      var how = dom.el('button', 'btn btn-quiet btn-sm agentrow-how');
      how.type = 'button';
      how.hidden = true;
      how.setAttribute('aria-expanded', 'false');
      how.appendChild(dom.el('span', 'btn-label', ''));
      if (window.PhosphorIcons) how.appendChild(window.PhosphorIcons.svg('chevron-down', 'agentrow-how-icon'));
      var cmd = dom.el('div', 'agentrow-cmd');
      cmd.hidden = true;
      var cmdNote = dom.el('p', 'agentrow-cmd-note', COPY.runIt);
      cmdNote.hidden = true;
      var code = dom.el('code', 'agentrow-code');
      var copy = dom.el('button', 'btn btn-quiet btn-sm agentrow-copy');
      copy.type = 'button';
      copy.appendChild(window.PhosphorIcons ? window.PhosphorIcons.svg('copy') : dom.el('span'));
      copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
      cmd.appendChild(cmdNote);
      var codeLine = dom.el('div', 'agentrow-code-line');
      codeLine.appendChild(code);
      codeLine.appendChild(copy);
      cmd.appendChild(codeLine);
      text.appendChild(name);
      text.appendChild(said);
      text.appendChild(line);
      text.appendChild(how);
      text.appendChild(cmd);
      node.appendChild(text);

      var act = dom.el('div', 'agentrow-act');
      var use = dom.el('button', 'btn btn-ghost btn-sm agentrow-use');
      use.type = 'button';
      use.appendChild(dom.el('span', 'btn-label', 'Use'));
      dom.setAttr(use, 'data-pending-label', 'Checking');
      use.setAttribute('aria-label', 'Use ' + entry.name);
      var current = dom.el('span', 'agentrow-current');
      if (window.PhosphorIcons) current.appendChild(window.PhosphorIcons.svg('done', 'icon-14'));
      current.appendChild(dom.el('span', '', COPY.inUse));
      current.hidden = true;
      act.appendChild(use);
      act.appendChild(current);
      node.appendChild(act);

      var row = { node: node, said: said, line: line, how: how, cmd: cmd, cmdNote: cmdNote, code: code, use: use, current: current, open: false };
      dom.on(use, 'click', function () { pick(entry.id, use); });
      dom.on(copy, 'click', function () { copyLine(code.textContent, copy); });
      dom.on(how, 'click', function () {
        row.open = !row.open;
        var motion = window.PhosphorMotion;
        var change = function () { paint(); };
        if (motion && typeof motion.morph === 'function') motion.morph(node, change, { fade: row.open ? cmd : null });
        else change();
      });
      return row;
    }

    function copyLine(text, button) {
      if (!text || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
      navigator.clipboard.writeText(text).then(function () {
        var label = button.querySelector('.btn-label');
        dom.setText(label, 'Copied');
        clearTimeout(state.copiedTimer);
        state.copiedTimer = setTimeout(function () {
          if (state.alive) dom.setText(label, 'Copy');
        }, COPIED_MS);
      });
    }

    function say(text, tone) {
      dom.setText(status, text || '');
      dom.setAttr(status, 'data-tone', tone === 'warn' ? 'warn' : null);
      dom.setHidden(status, !text);
    }

    /* Every row, from what the app last said about each agent. */
    function paint() {
      var whole = store && typeof store.get === 'function' ? (store.get() || {}) : {};
      TILES.forEach(function (entry) {
        var row = rows[entry.id];
        var check = state.checks[entry.id] || null;
        var picked = state.agent === entry.id;
        var connected = onDoor(entry.id, whole) && (entry.id !== 'mcp' || picked);
        var kind = stateOf(entry.id, check, connected);
        row.node.dataset.state = kind;
        dom.setAttr(row.node, 'aria-current', picked ? 'true' : null);
        dom.setText(row.said, STATE_WORDS[kind]);

        /* The line under the status is the app's own sentence, for the agent
           in use (its next step) and for another agent (how it joins). */
        var line = '';
        if (kind === 'outside') line = COPY.outside;
        else if (picked && check && check.sentence && kind !== 'ready' && kind !== 'connected') line = check.sentence;

        /* The line to run, behind its fold: how to sign in or install. */
        var how = HOW[kind] || null;
        var command = how ? commandIn(check, how.lead) : '';
        var folded = !!command;

        /* The agent in use keeps what the last pick said about it: a
           registration that failed changes its next step to the line to
           paste, and another agent's next step is the line itself. Both are
           the one thing left to do, so they are open. */
        if (picked && state.registrationFailed && state.command) {
          line = entry.name + COPY.registrationFailed;
          command = state.command;
          folded = false;
        } else if (picked && entry.id === 'mcp' && state.command) {
          command = state.command;
          folded = false;
        }

        dom.setText(row.line, line);
        dom.setHidden(row.line, !line);
        dom.setHidden(row.how, !folded);
        if (how) dom.setText(row.how.querySelector('.btn-label'), how.label);
        dom.setAttr(row.how, 'aria-expanded', folded && row.open ? 'true' : 'false');
        dom.setText(row.code, command);
        dom.setHidden(row.cmdNote, !folded);
        dom.setHidden(row.cmd, !command || (folded && !row.open));

        /* Use where a pick can do something: every state but one the app knows
           is missing. A row still being checked can be used; the pick checks
           it on the way. */
        var usable = kind !== 'install' && kind !== 'cannot';
        dom.setHidden(row.use, picked || !usable);
        row.use.disabled = state.busy;
        dom.setHidden(row.current, !picked);
      });
    }

    function tell() {
      if (typeof opts.onState === 'function') {
        opts.onState({ agent: state.agent, check: state.check, command: state.command, registered: state.registered, connected: state.connected, handle: state.handle });
      }
    }

    function setBusy(on) {
      state.busy = on;
      paint();
    }

    /* The roster moved: a client arrived or left. */
    function paintDoor() {
      var whole = store && typeof store.get === 'function' ? (store.get() || {}) : {};
      var connected = !!state.agent && onDoor(state.agent, whole);
      var changed = connected !== state.connected;
      state.connected = connected;
      paint();
      if (changed && state.check && !state.busy) tell();
    }

    /* Use: the choice is written, the agent checked and registered, in one
       round trip. The row turns current only when the app took the pick; a
       refusal leaves the pick where it was and says why. */
    function pick(id, button) {
      if (!state.alive || !canAsk()) return Promise.resolve();
      state.seq += 1;
      var seq = state.seq;
      var entry = entryOf(id);
      say(entry ? 'Checking ' + entry.name + ' on this Mac.' : COPY.checking, null);
      if (button && window.PhosphorShell) window.PhosphorShell.setPending(button, true);
      setBusy(true);
      return api.driver({ action: 'agent-pick', agent: id })
        .then(function (answer) {
          if (!state.alive || seq !== state.seq) return;
          if (answer && answer.ok === false) {
            state.agent = answer.picked || state.agent;
            say(answer.sentence || COPY.noAnswer, 'warn');
            return;
          }
          /* The app stores a pick only for an agent it found on this Mac, and
             says which one it holds: a pick of an agent that is not here keeps
             the one before, and the list says why in the app's sentence. */
          var took = !answer || answer.picked === undefined || answer.picked === id;
          if (took) state.agent = id;
          else state.agent = answer.picked || null;
          take(answer);
          say(took || !state.check ? '' : state.check.sentence, null);
          if (!took) return;
          if (typeof opts.onPick === 'function') opts.onPick({ agent: id, check: state.check, command: state.command });
          /* The chat's Start names the agent picked. */
          if (typeof window.CustomEvent === 'function') {
            window.dispatchEvent(new window.CustomEvent('phosphor:agent', { detail: { agent: id } }));
          }
        })
        .catch(function () {
          if (!state.alive || seq !== state.seq) return;
          say(COPY.noAnswer, 'warn');
        })
        .finally(function () {
          if (button && window.PhosphorShell) window.PhosphorShell.setPending(button, false);
          if (!state.alive || seq !== state.seq) return;
          setBusy(false);
          tell();
        });
    }

    /* What one answer about the picked agent carries. */
    function take(answer) {
      var check = answer && answer.check ? answer.check : null;
      state.check = check;
      if (check && check.agent) state.checks[check.agent] = check;
      state.command = answer && typeof answer.command === 'string' ? answer.command : null;
      state.registered = !!(answer && answer.registered);
      state.registrationFailed = !!(answer && answer.registrationFailed);
      var whole = store && typeof store.get === 'function' ? (store.get() || {}) : {};
      state.connected = !!state.agent && onDoor(state.agent, whole);
    }

    /* Check the picked agent again: the same check, no write. */
    function check() {
      if (!state.alive || !state.agent || !canAsk()) return Promise.resolve();
      state.seq += 1;
      var seq = state.seq;
      var id = state.agent;
      setBusy(true);
      return api.driver({ action: 'agent-check', agent: id })
        .then(function (answer) {
          if (!state.alive || seq !== state.seq) return;
          take(answer);
        })
        .catch(function () {
          if (!state.alive || seq !== state.seq) return;
          say(COPY.noAnswer, 'warn');
        })
        .finally(function () {
          if (!state.alive || seq !== state.seq) return;
          setBusy(false);
          tell();
        });
    }

    /* Every agent the app can probe, checked on this Mac, with the pick the
       app holds. The two it cannot probe keep their fixed state. */
    function scan(pressed, button) {
      if (!canAsk()) return Promise.resolve();
      if (button && window.PhosphorShell) window.PhosphorShell.setPending(button, true);
      say(pressed ? COPY.checking : '', null);
      return api.driver({ action: 'agent-scan' })
        .then(function (answer) {
          if (!state.alive || !answer || !Array.isArray(answer.agents)) return;
          answer.agents.forEach(function (item) {
            if (item && entryOf(item.agent)) state.checks[item.agent] = item;
          });
          if (answer.picked && (!state.agent || !opts.picked)) state.agent = answer.picked;
          if (state.agent && state.checks[state.agent]) state.check = state.checks[state.agent];
          var whole = store && typeof store.get === 'function' ? (store.get() || {}) : {};
          state.connected = !!state.agent && onDoor(state.agent, whole);
          say('', null);
          paint();
          tell();
        })
        .catch(function () {
          if (state.alive) say(COPY.noAnswer, 'warn');
        })
        .finally(function () {
          if (button && window.PhosphorShell) window.PhosphorShell.setPending(button, false);
        });
    }

    function destroy() {
      state.alive = false;
      if (state.unsubscribe) state.unsubscribe();
      state.unsubscribe = null;
      clearTimeout(state.copiedTimer);
      if (root.parentNode === host) host.removeChild(root);
      if (host.__agentpick === state.handle) host.__agentpick = null;
    }

    state.handle = {
      destroy: destroy,
      check: check,
      pick: pick,
      say: say,
      scan: scan,
      agent: function () { return state.agent; }
    };
    host.__agentpick = state.handle;

    paint();
    if (store && typeof store.select === 'function') state.unsubscribe = store.select('agents', paintDoor);
    scan(false);
    return state.handle;
  }

  window.PhosphorAgentPick = {
    render: render,
    AGENTS: AGENTS,
    onDoor: onDoor,
    stateOf: stateOf
  };
})();
