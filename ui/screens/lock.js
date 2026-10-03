/* Locked, and the migration that gets a plaintext key file out of the way.

   Reads continue behind the lock, but the shell is frosted and inert while it
   holds: nothing on it can be read, selected or reached until the password is
   in. Nothing is refused while locked: a write the assistant asks for is
   authored, checked and queued, and it waits. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var refs = {};
  var mode = null;
  /* The unlock moment in flight, so a lock that lands mid-release can stop it,
     and the lock's own arrival, so an unlock that lands mid-arrival can. */
  var releasing = null;
  var arriving = null;
  /* The countdown after too many tries, so a new card or an unlock stops it. */
  var waitTimer = 0;
  var EASE = [0.22, 1, 0.36, 1];

  function boot() {
    refs.host = document.getElementById('screen-lock');
    if (!refs.host) return;
    /* Two slices decide what this screen is: the lock says whether it is up,
       the vault says whether it asks for a password or a finger. */
    store.select('lock', function () { render(); });
    store.select('vault', function () { render(); });
    render();
  }

  function render() {
    var whole = store.get() || {};
    /* The terms come first. While they are not accepted the terms card is what
       the window shows, and this screen stays down whatever the lock says;
       the card calls back here when it goes. */
    /* The first run carries the terms as its own step for a person with no
       wallet, so only then does the lock go on while they wait. */
    var terms = window.PhosphorTerms;
    if (terms && typeof terms.required === 'function' && terms.required(whole)
        && !(typeof terms.firstRunOwns === 'function' && terms.firstRunOwns(whole))) {
      stopWait();
      dom.setHidden(refs.host, true);
      mode = null;
      return;
    }
    var lock = whole.lock || {};
    var vault = whole.vault || {};
    var state = lock.state || 'unlocked';
    if (state === 'unlocked') {
      stopWait();
      /* A second unlocked frame while the release plays changes nothing: the
         moment finishes on its own and hides the screen when it is done. */
      if (releasing) {
        mode = null;
        return;
      }
      if (mode !== null && !refs.host.hidden) release();
      else {
        dom.setHidden(refs.host, true);
        dom.setAttr(document.body, 'data-locked', null);
        setPageInert(false);
      }
      mode = null;
      return;
    }
    stopRelease();
    clearRelease({ page: document.getElementById('page'), card: null });
    /* No wallet, or a wallet file this Mac cannot open because another Mac made
       it: both are the first run's job. It reads `vault.foreign` itself and opens
       on the Restore screen for the second case. */
    if (state === 'no_wallet' || vault.foreign === true) {
      stopWait();
      dom.setHidden(refs.host, true);
      mode = null;
      window.PhosphorFirstRun.open();
      return;
    }
    var custody = vault.custody === 'secure-enclave' ? 'enclave' : 'software';
    var ready = !!(vault.enclave && vault.enclave.ready === true);
    /* A readable key file on a Mac that keeps a Phosphor-only wallet has a card
       of its own, which takes over when the service says so after the first frame. */
    var held = state === 'needs_migration' && !!(vault.enclave && vault.enclave.phosphorOnlyHere === true);
    var key = state + ':' + custody + ':' + (ready ? 'touch' : 'none') + (held ? ':held' : '');
    if (mode === key) {
      why(lock, vault);
      return;
    }
    var fresh = mode === null || refs.host.hidden;
    mode = key;
    stopWait();
    dom.setAttr(document.body, 'data-locked', 'true');
    setPageInert(true);
    dom.setHidden(refs.host, false);
    if (held) buildHeld();
    else if (state === 'needs_migration') buildMigrate();
    else if (custody === 'enclave') buildTouch();
    else buildLock(ready);
    why(lock, vault);
    if (fresh) arrive();
  }

  /* THE LOCK ARRIVING: the unlock moment played the other way, a little
     faster. The page behind goes out of focus (blur 0 to 24 px, opacity to
     half) over 350 ms while the scrim fades up and the card grows in from
     0.97. The stylesheet holds the same resting values, so taking the inline
     ones off at the end moves nothing. Reduced motion keeps the fades. */
  function arrive() {
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    var page = document.getElementById('page');
    var host = refs.host;
    var card = host.querySelector('.lock-card') || host.querySelector('.screen-card');
    var reduced = !!(window.PhosphorMotion && window.PhosphorMotion.reduced());
    var runs = [];
    if (page) {
      runs.push(Motion.animate(page, reduced
        ? { opacity: [1, 0.5] }
        : { filter: ['blur(0px)', 'blur(24px)'], opacity: [1, 0.5] },
      { duration: 0.35, ease: EASE }));
    }
    runs.push(Motion.animate(host, { opacity: [0, 1] }, { duration: 0.35, ease: EASE }));
    if (card) {
      runs.push(Motion.animate(card, reduced
        ? { opacity: [0, 1] }
        : { opacity: [0, 1], transform: ['scale(0.97)', 'scale(1)'] },
      { duration: 0.35, delay: 0.06, ease: EASE }));
    }
    var run = { runs: runs, page: page, card: card };
    arriving = run;
    var settle = function () {
      if (arriving !== run) return;
      arriving = null;
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(function () { clearRelease(run); });
      else clearRelease(run);
    };
    Promise.all(runs.map(function (r) { return r && r.finished ? r.finished : r; })).then(settle, settle);
  }

  function stopArrive() {
    var run = arriving;
    if (!run) return;
    arriving = null;
    for (var i = 0; i < run.runs.length; i += 1) {
      var r = run.runs[i];
      if (r && typeof r.stop === 'function') r.stop();
    }
    clearRelease(run);
  }

  function stopWait() {
    if (waitTimer) window.clearInterval(waitTimer);
    waitTimer = 0;
  }

  /* The blurred page is also an inert one: the stylesheet takes the pointer
     and the selection, this takes the keyboard and the accessibility tree, so
     a balance nobody can see is not a balance a Tab press or a screen reader
     can still reach. Both halves are undone on unlock. */
  function setPageInert(on) {
    var page = document.getElementById('page');
    if (!page) return;
    if ('inert' in page) page.inert = on;
    dom.setAttr(page, 'aria-hidden', on ? 'true' : null);
  }

  /* THE UNLOCK MOMENT. The page behind comes back into focus over 700 ms: its
     blur goes from 24 px to none, its opacity from half to whole, and it settles
     from 1.015 to 1, while the scrim fades over the same 700 ms and the card
     shrinks to 0.97 and fades in half that time. The page is made reachable at
     the start, not the end: nothing should wait on a fade. Reduced motion keeps
     the fades and skips the blur and the scale. Without motion.dev (the unit
     harness) the screen simply goes. */
  function release() {
    stopArrive();
    var page = document.getElementById('page');
    var host = refs.host;
    var card = host.querySelector('.lock-card') || host.querySelector('.screen-card');
    dom.setAttr(document.body, 'data-locked', null);
    setPageInert(false);
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') {
      dom.setHidden(host, true);
      return;
    }
    var reduced = !!(window.PhosphorMotion && window.PhosphorMotion.reduced());
    var runs = [];
    if (page) {
      runs.push(Motion.animate(page, reduced
        ? { opacity: [0.5, 1] }
        : { filter: ['blur(24px)', 'blur(0px)'], opacity: [0.5, 1], transform: ['scale(1.015)', 'scale(1)'] },
      { duration: 0.7, ease: EASE }));
    }
    host.style.pointerEvents = 'none';
    runs.push(Motion.animate(host, { opacity: [1, 0] }, { duration: 0.7, ease: EASE }));
    if (card) {
      runs.push(Motion.animate(card, reduced
        ? { opacity: [1, 0] }
        : { opacity: [1, 0], transform: ['scale(1)', 'scale(0.97)'] },
      { duration: 0.35, ease: EASE }));
    }
    var run = { runs: runs, page: page, card: card };
    releasing = run;
    var settle = function () {
      if (releasing !== run) return;
      releasing = null;
      dom.setHidden(host, true);
      /* motion.dev writes the final values inline as it finishes, after its
         promise settles, so the sweep waits a frame or the scrim keeps an
         opacity of nought into the next lock. */
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(function () { clearRelease(run); });
      else clearRelease(run);
    };
    Promise.all(runs.map(function (r) { return r && r.finished ? r.finished : r; })).then(settle, settle);
  }

  /* Every inline value the moment writes, taken back off, so the next lock
     starts from the stylesheet alone. */
  function clearRelease(run) {
    refs.host.style.pointerEvents = '';
    refs.host.style.opacity = '';
    if (run.page) {
      run.page.style.filter = '';
      run.page.style.opacity = '';
      run.page.style.transform = '';
    }
    if (run.card) {
      run.card.style.opacity = '';
      run.card.style.transform = '';
    }
  }

  /* A lock that arrives while the release is still playing: stop it where it
     is and hand the screen back whole. */
  function stopRelease() {
    var run = releasing;
    if (!run) return;
    releasing = null;
    for (var i = 0; i < run.runs.length; i += 1) {
      var r = run.runs[i];
      if (r && typeof r.stop === 'function') r.stop();
    }
    clearRelease(run);
  }

  /* One icon from the drawn set, or nothing where the set is not loaded. */
  function icon(name, className) {
    var icons = window.PhosphorIcons;
    return icons && typeof icons.svg === 'function' ? icons.svg(name, className) : null;
  }

  function append(parent, child) {
    if (child) parent.appendChild(child);
    return child;
  }

  /* A wrong password shakes the field once, 300 ms side to side, then the
     line under it says what happened. No shake under reduced motion. */
  function shake(node) {
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    if (window.PhosphorMotion && window.PhosphorMotion.reduced()) return;
    Motion.animate(node, { x: [0, -7, 7, -5, 5, -2, 0] }, { duration: 0.3, ease: 'easeOut' });
  }

  /* The lock card, shared by the password and the Touch ID screens: the brand
     row, the title, then whatever the custody needs, then the fine print. */
  function lockCard() {
    dom.clear(refs.host);
    var card = dom.el('div', 'lock-card');
    var brand = dom.el('div', 'brand lock-brand');
    append(brand, dom.mark('brand-mark'));
        card.appendChild(brand);
    /* The title and, under it, why it locked and what waits: the block is
       filled by why(), in place, so a new frame never rebuilds the field. */
    var head = dom.el('div', 'lock-head');
    head.appendChild(dom.el('h1', 'lock-title', 'Phosphor is locked'));
    refs.why = dom.el('div', 'lock-why');
    refs.why.setAttribute('aria-live', 'polite');
    head.appendChild(refs.why);
    card.appendChild(head);
    refs.host.appendChild(card);
    return card;
  }

  /* Why the wallet locked, from the fixed codes on the lock slice. A lock the
     person asked for, the app's start and a code this file does not know all
     say nothing. */
  function reasonLine(code, vault) {
    if (code === 'screen') return 'Locked when your screen locked.';
    if (code === 'switch') return 'Locked when this Mac switched users.';
    if (code === 'sleep') return 'Locked while this Mac was asleep.';
    if (code !== 'idle') return '';
    var minutes = vault && vault.idleMinutes;
    if (minutes === 60) return 'Locked after a quiet hour.';
    if (typeof minutes === 'number' && minutes > 1) return 'Locked after ' + minutes + ' quiet minutes.';
    return 'Locked after a quiet while.';
  }

  /* A count only: what the moves are and how much stays behind the lock. */
  function waitingLine(count) {
    if (typeof count !== 'number' || count < 1) return '';
    return count === 1 ? '1 move is waiting for your OK.' : count + ' moves are waiting for your OK.';
  }

  function why(lock, vault) {
    var block = refs.why;
    if (!block) return;
    var lines = [reasonLine(lock.reason, vault), waitingLine(lock.waiting)].filter(Boolean);
    var shown = Array.prototype.map.call(block.childNodes, function (n) { return n.textContent; });
    if (shown.join('\n') === lines.join('\n')) return;
    dom.clear(block);
    for (var i = 0; i < lines.length; i += 1) block.appendChild(dom.el('p', 'lock-why-line', lines[i]));
    block.hidden = lines.length === 0;
  }

  function finePrint(card, text) {
    var node = dom.el('p', 'lock-fine', text);
    card.appendChild(node);
    return node;
  }

  /* The migration card. No field of its own: the window has exactly one, it
     is already behind everything, and the shell drives it to `locked` the
     moment the lock state arrives. A second field here would paint an opaque
     ground over the frosted shell. */
  function shell() {
    dom.clear(refs.host);
    refs.why = null;
    var card = dom.el('div', 'screen-card');
    refs.host.appendChild(card);
    return card;
  }

  function buildLock(canRestore) {
    var card = lockCard();

    /* A real form, not a loose input: it is what lets a password manager offer
       to fill and to save, and it gives Enter to submit without a key handler. */
    var form = dom.el('form', 'lock-form');
    var field = dom.el('div', 'lock-field');
    append(field, icon('lock', 'lock-field-icon icon-20'));
    var input = dom.el('input', 'lock-input');
    input.type = 'password';
    input.name = 'password';
    input.autocomplete = 'current-password';
    input.setAttribute('autofocus', '');
    input.setAttribute('aria-label', 'Password');
    input.placeholder = 'Password';
    field.appendChild(input);

    /* Show or hide what was typed. A button, not a link, and it hands focus
       straight back to the field so the toggle never breaks the typing. */
    var eye = dom.el('button', 'lock-eye');
    eye.type = 'button';
    eye.setAttribute('aria-label', 'Show password');
    eye.setAttribute('aria-pressed', 'false');
    append(eye, icon('show', 'icon-20'));
    field.appendChild(eye);
    dom.on(eye, 'click', function () {
      var shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      eye.setAttribute('aria-pressed', shown ? 'false' : 'true');
      eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      dom.clear(eye);
      append(eye, icon(shown ? 'show' : 'hide', 'icon-20'));
      input.focus();
    });
    form.appendChild(field);

    var error = dom.el('p', 'lock-error');
    error.hidden = true;
    form.appendChild(error);

    var unlock = dom.el('button', 'btn btn-primary lock-unlock');
    unlock.type = 'submit';
    var label = dom.el('span', 'btn-label');
    append(label, icon('unlock', 'icon-20'));
    label.appendChild(dom.el('span', '', 'Unlock'));
    append(label, icon('chevron-right', 'lock-arrow'));
    unlock.appendChild(label);
    dom.setAttr(unlock, 'data-pending-label', 'Unlocking');
    form.appendChild(unlock);
    card.appendChild(form);

    var fine = finePrint(card, 'Your password opens Phosphor on this Mac. Nothing new is sent while Phosphor is locked, except by a plan you armed; orders already on the exchange still run.');

    /* A forgotten password is not the end of the wallet: the recovery phrase
       brings it back. Restoring puts it behind Touch ID, so the way is offered
       where this Mac has Touch ID to put it behind. While it is open the card
       stops saying what the password does, to a person who forgot it. */
    if (canRestore) {
      var keyOnly = keyWallet();
      restoreWay(card, [form, fine], {
        label: keyOnly ? 'Forgot your password? Restore from your private key' : 'Forgot your password? Restore from your recovery phrase',
        intro: keyOnly
          ? 'Type your private key, 64 characters. This Mac then holds that wallet behind Touch ID, and the password is no longer needed.'
          : 'Type your recovery phrase, 12 or 24 words. This Mac then holds that wallet behind Touch ID, and the password is no longer needed.',
        back: 'Use my password',
        focus: function () { var field = form.querySelector('input'); if (field) field.focus(); }
      });
    }

    /* One unlock in flight at a time. The disabled button covers the click; this
       covers Enter in the password field, which submits the form without going
       anywhere near the button. Unlocking sends every proposal that was queued
       behind the lock, so this wait can run to a minute and pressing again is the
       obvious thing to do. The route holds its own single in-flight promise, so
       a second request would be answered rather than acted on; this is what keeps
       one from being made at all. */
    var inFlight = false;

    /* Too many tries: the seconds count down in place, the button waits in its
       outline face until they run out, and the line goes at nought. */
    var waiting = false;
    function holdFor(seconds) {
      stopWait();
      var left = Math.max(1, Math.ceil(seconds));
      waiting = true;
      unlock.disabled = true;
      dom.setAttr(unlock, 'data-waiting', 'true');
      var tick = function () {
        if (left <= 0) {
          stopWait();
          waiting = false;
          unlock.disabled = false;
          dom.setAttr(unlock, 'data-waiting', null);
          error.hidden = true;
          input.focus();
          return;
        }
        fail(error, 'Too many tries. Try again in ' + left + (left === 1 ? ' second.' : ' seconds.'));
        left -= 1;
      };
      tick();
      waitTimer = window.setInterval(tick, 1000);
    }

    var submit = function () {
      var password = input.value;
      if (!password || inFlight || waiting) return;
      error.hidden = true;
      inFlight = true;
      window.PhosphorShell.setPending(unlock, true);
      api.unlock(password)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            if (answer.code === 'locked_out' && typeof answer.retryInSec === 'number' && answer.retryInSec > 0) {
              holdFor(answer.retryInSec);
            } else {
              fail(error, reason(answer, 'That did not finish, so nothing changed. Try again.'));
            }
            shake(field);
            /* The field is cleared on a refusal and kept on a success, because
               a wrong password is retyped and a right one is finished with. */
            input.value = '';
            input.focus();
            return;
          }
          input.value = '';
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) {
          fail(error, net.readable(err));
          shake(field);
        })
        .finally(function () {
          inFlight = false;
          window.PhosphorShell.setPending(unlock, false);
          if (waiting) unlock.disabled = true;
        });
    };

    dom.on(form, 'submit', function (event) {
      event.preventDefault();
      submit();
    });
    input.focus();
  }

  /* THE WAY BACK FROM THE BACKUP, in the card itself: a quiet button under
     the card's words opens the restore step in its place, the phrase or the
     key typed, and a second press that says what it replaces. The app writes
     the wallet from it behind Touch ID and opens it, and the lock goes on its
     own when the state says so. It is the password card's Forgot your
     password, and the Touch ID card's answer to a wallet file this Mac will
     not open (refusedHere): a person told their backup brings the wallet back
     is given the way to use it, not a button that is refused again.
     `hide` are the card's own parts the step takes the place of; `opts.into`
     is where the way sits, when that is not the card's foot (the Touch ID
     card puts it straight under the line that names it). `opts.either`
     takes a phrase or a key, told apart by what was typed (ui/core/custody.js),
     where the card cannot know which backup the person has. */
  function restoreWay(card, hide, opts) {
    var either = opts.either === true;
    var keyOnly = !either && keyWallet();
    var way = dom.el('button', 'lock-forgot');
    way.type = 'button';
    way.appendChild(dom.el('span', '', opts.label));
    (opts.into || card).appendChild(way);

    var step = dom.el('div', 'lock-restore');
    step.hidden = true;
    step.appendChild(dom.el('p', 'lock-restore-text', opts.intro));
    var input = dom.el('textarea', 'input phrase-input lock-phrase');
    input.name = either ? 'backup' : keyOnly ? 'key' : 'phrase';
    input.rows = keyOnly ? 2 : 3;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', either ? 'Recovery phrase or private key' : keyOnly ? 'Private key' : 'Recovery phrase');
    step.appendChild(input);
    var error = dom.el('p', 'lock-error');
    error.hidden = true;
    step.appendChild(error);
    var sure = dom.el('p', 'lock-restore-sure');
    sure.hidden = true;
    step.appendChild(sure);
    var tools = dom.el('div', 'lock-restore-actions');
    var go = dom.el('button', 'btn btn-sm');
    go.type = 'button';
    go.appendChild(dom.el('span', 'btn-label', 'Restore'));
    dom.setAttr(go, 'data-pending-label', 'Waiting for Touch ID');
    var back = dom.el('button', 'btn btn-quiet btn-sm');
    back.type = 'button';
    back.appendChild(dom.el('span', 'btn-label', opts.back));
    tools.appendChild(go);
    tools.appendChild(back);
    step.appendChild(tools);
    // A cancel is said under the buttons it answers, in the quiet tone.
    var said = dom.el('p', 'lock-error lock-restore-note');
    said.hidden = true;
    step.appendChild(said);
    card.appendChild(step);

    var asked = false;
    function disarm() {
      asked = false;
      sure.hidden = true;
    }

    function toggle(open) {
      var change = function () {
        dom.setHidden(step, !open);
        for (var i = 0; i < hide.length; i += 1) dom.setHidden(hide[i], open);
        dom.setHidden(way, open);
        if (open) input.focus();
        else {
          input.value = '';
          disarm();
          error.hidden = true;
          said.hidden = true;
          if (typeof opts.focus === 'function') opts.focus();
        }
      };
      var motion = window.PhosphorMotion;
      if (motion && typeof motion.morph === 'function') motion.morph(card, change, { fade: open ? step : hide });
      else change();
    }

    dom.on(way, 'click', function () { toggle(true); });
    dom.on(back, 'click', function () { toggle(false); });
    dom.on(input, 'input', function () {
      disarm();
      said.hidden = true;
    });
    dom.on(go, 'click', function () {
      var sent;
      var custody = window.PhosphorCustody;
      if (keyOnly || (either && custody.isKey(input.value))) {
        var key = custody.readKey(input.value);
        if (key.problem) {
          fail(error, key.problem);
          return;
        }
        sent = function () { return api.vaultRestoreKey('0x' + key.hex); };
      } else {
        var clean = input.value.trim().toLowerCase();
        var words = clean ? clean.split(/\s+/) : [];
        if (words.length !== 12 && words.length !== 24) {
          fail(error, 'That is ' + words.length + (words.length === 1 ? ' word' : ' words') + (either
            ? '. A recovery phrase is 12 or 24, and a private key is 64 characters.'
            : '. It should be 12 or 24.'));
          return;
        }
        sent = function () { return api.vaultRestore(words.join(' ')); };
      }
      error.hidden = true;
      said.hidden = true;
      if (!asked) {
        asked = true;
        dom.setText(sure, either
          ? 'This puts the wallet your backup opens on this Mac, behind Touch ID, in place of the key file found here. Press Restore again to go ahead.'
          : keyOnly
            ? 'This replaces the wallet on this Mac with the one your key opens. If the key is for a different wallet, the one here now cannot be opened again. Press Restore again to go ahead.'
            : 'This replaces the wallet on this Mac with the one your phrase makes. If the phrase is for a different wallet, the one here now cannot be opened again. Press Restore again to go ahead.');
        sure.hidden = false;
        return;
      }
      window.PhosphorShell.setPending(go, true);
      sent()
        .then(function (answer) {
          if (answer && answer.ok === false) {
            // Every refusal is the end of this press: the next one asks again.
            disarm();
            if (answer.code === 'user_cancel') {
              note(said, custody.CANCELLED);
              return;
            }
            fail(error, answer.code === 'bad_phrase'
              ? 'That phrase is not right. Check every word and the order they are in.'
              : answer.code === 'bad_key'
                ? 'That key is not right. Check every character against your copy.'
                : reason(answer, 'That did not finish, so nothing changed. Try again.'));
            return;
          }
          input.value = '';
          var evm = answer && answer.addresses && typeof answer.addresses.evm === 'string' ? answer.addresses.evm : '';
          if (evm && window.PhosphorToast) window.PhosphorToast.show('Restored. This Mac now holds the wallet ' + (evm.length > 12 ? evm.slice(0, 6) + '...' + evm.slice(-4) : evm) + '.');
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(go, false); });
    });
    return way;
  }

  /* The enclave wallet. No field: the key that opens this file lives in the
     Secure Enclave and the only way to ask it is the system's own dialog, which
     the button raises. The window draws nothing that looks like that dialog. */
  function buildTouch() {
    var card = lockCard();

    var error = dom.el('p', 'lock-error');
    error.hidden = true;

    var actions = dom.el('div', 'lock-form');
    var unlock = dom.el('button', 'btn btn-primary lock-unlock');
    unlock.type = 'button';
    var label = dom.el('span', 'btn-label');
    append(label, icon('unlock', 'icon-20'));
    label.appendChild(dom.el('span', '', 'Unlock with Touch ID'));
    unlock.appendChild(label);
    dom.setAttr(unlock, 'data-pending-label', 'Waiting for Touch ID');
    actions.appendChild(unlock);
    actions.appendChild(error);
    card.appendChild(actions);
    var fine = finePrint(card, 'Touch ID opens Phosphor on this Mac, and your Mac login password works too. Nothing new is sent while Phosphor is locked, except by a plan you armed; orders already on the exchange still run.');

    /* A wallet file this Mac will not open is not one a second press opens:
       the line says so, and the way under it is the backup. Shown only then. */
    var keyOnly = keyWallet();
    var way = restoreWay(card, [actions, fine], {
      label: keyOnly ? 'Restore from your private key' : 'Restore from your recovery phrase',
      intro: keyOnly
        ? 'Type your private key, 64 characters. Phosphor opens your wallet from it here, behind Touch ID.'
        : 'Type your recovery phrase, 12 or 24 words. Phosphor opens your wallet from it here, behind Touch ID.',
      back: 'Back',
      into: actions,
      focus: function () { unlock.focus(); }
    });
    way.hidden = true;

    /* One dialog at a time. The request answers when the person has touched the
       sensor or cancelled, which can be most of the 150 s the backend allows, so
       the button is dead and says why for the whole wait. */
    var inFlight = false;
    dom.on(unlock, 'click', function () {
      if (inFlight) return;
      inFlight = true;
      error.hidden = true;
      window.PhosphorShell.setPending(unlock, true);
      api.vaultUnlock()
        .then(function (answer) {
          if (answer && answer.ok === false) {
            /* A cancel is not an error. The button simply comes back. */
            if (answer.code !== 'user_cancel') {
              fail(error, reason(answer, 'Touch ID did not finish, so nothing changed. Try again.'));
              way.hidden = !refusedHere(answer.code);
            }
            return;
          }
          return window.PhosphorShell.refresh({});
        })
        .catch(function (err) {
          fail(error, net.readable(err));
        })
        .finally(function () {
          inFlight = false;
          window.PhosphorShell.setPending(unlock, false);
        });
    });
    unlock.focus();
  }

  /* A wallet with no phrase comes back from its private key, so the lines that
     send a person to the backup name the one they have. */
  function keyWallet() {
    return (((store.get() || {}).vault) || {}).hasMnemonic === false;
  }

  /* The four answers that mean this Mac will not open the wallet file in
     place, however often Touch ID is asked: not the file Phosphor saved, an
     older wallet file on a Mac where any wallet is Phosphor-only (another
     wallet's counts too), or a file that cannot be read. The backup is the way back,
     and the backend lets a restore replace such a file without asking for
     one first (src/http/custody.ts openableHere, src/http/vault.ts damaged). */
  function refusedHere(code) {
    return code === 'pin_mismatch' || code === 'not_committed' || code === 'blob_refused' || code === 'damaged';
  }

  /* The custody routes answer { ok, error, code }: `error` is already a
     sentence a person can read (src/http/wallet.ts says every code once), and
     `code` is what a screen branches on. The lines here are the ones this card
     says better in place: the four above point at the restore under them.
     Anything else is the backend's sentence, never a code. */
  function reason(answer, fallback) {
    var code = answer && (answer.code || answer.error);
    var backup = keyWallet() ? 'private key' : 'recovery phrase';
    var restore = ' Restore your wallet from your ' + backup + ' to open it here.';
    if (code === 'wrong_password') return 'Wrong password. Try again.';
    if (code === 'enclave_unavailable') return 'Touch ID did not answer. Open the Phosphor app and try again.';
    if (code === 'foreign') return 'This wallet was made on another Mac. Restore it from your ' + backup + '.';
    if (code === 'locked_out') {
      var retryInSec = answer && answer.retryInSec;
      var wait = typeof retryInSec === 'number' && retryInSec > 0
        ? 'Wait ' + retryInSec + (retryInSec === 1 ? ' second' : ' seconds')
        : 'Wait a moment';
      return 'Too many tries. ' + wait + ' and try again.';
    }
    if (code === 'no_wallet') return 'There is no wallet on this Mac yet.';
    if (code === 'damaged') return 'The wallet file on this Mac cannot be read, and nothing moved.' + restore;
    if (code === 'blob_refused') return 'A wallet on this Mac is Phosphor-only, so Phosphor no longer opens this older wallet file here, and nothing moved.' + restore;
    if (code === 'pin_mismatch' || code === 'not_committed') {
      return 'This wallet file is not the one Phosphor saved on this Mac, so it stayed closed and nothing moved.' + restore;
    }
    var custody = window.PhosphorCustody;
    return custody ? custody.sentence(answer, fallback) : fallback;
  }

  /* A problem, in one line under the field: the warning glyph and the words,
     never a bar and never red, since nothing was lost. */
  function fail(node, message) {
    dom.clear(node);
    dom.setAttr(node, 'data-tone', null);
    append(node, icon('warning', 'lock-error-icon'));
    node.appendChild(dom.el('span', '', message));
    node.hidden = false;
  }

  /* A cancel the person chose: the same line in the quiet tone, no glyph. */
  function note(node, message) {
    dom.clear(node);
    dom.setAttr(node, 'data-tone', 'quiet');
    node.appendChild(dom.el('span', '', message));
    node.hidden = false;
  }

  /* A readable key file on a Mac that keeps a Phosphor-only wallet. Nothing
     pins such a file to the wallet Phosphor keeps, so a program running as the
     owner could have put its own wallet where the Phosphor-only file was:
     Phosphor neither opens it nor offers to encrypt it (reaudit1b RA1B-01).
     The backup brings back the person's wallet, whichever one this file is.
     `said` is the backend's sentence when Encrypt now was refused on a copy
     that cannot check (verify-ra1b VRA1B-01); it names both ways out itself. */
  function buildHeld(said) {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'This key file stayed closed'));
    var next = null;
    if (said) card.appendChild(dom.el('p', 'body dim', said));
    else {
      card.appendChild(dom.el('p', 'body dim', 'Phosphor already keeps a Phosphor-only wallet on this Mac, so it did not open the readable key file it found here, and nothing moved.'));
      next = dom.el('p', 'body dim', 'If this file is your wallet, restore it from your backup: your recovery phrase, or your private key if it has no phrase.');
      card.appendChild(next);
    }
    var way = restoreWay(card, next ? [next] : [], {
      either: true,
      label: 'Restore from your backup',
      intro: 'Type your recovery phrase, 12 or 24 words, or your private key, 64 characters. Phosphor opens your wallet from it here, behind Touch ID.',
      back: 'Back',
      focus: function () { way.focus(); }
    });
    way.focus();
  }

  /* Migration. Verify before destroying: the envelope is written, read back and
     checked against the address it should derive, and only then is the
     plaintext overwritten. */
  function buildMigrate() {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'Your keys are not encrypted'));
    card.appendChild(dom.el('p', 'body dim', 'This app found a key file on this Mac that anything running as you can read. Set a password and it gets encrypted, then the readable copy is destroyed.'));

    var form = dom.el('form', 'stack');
    var one = dom.el('div', 'field');
    one.appendChild(dom.el('label', 'label', 'Password'));
    var first = dom.el('input', 'input');
    first.type = 'password';
    first.name = 'password';
    first.autocomplete = 'new-password';
    one.appendChild(first);
    form.appendChild(one);

    var two = dom.el('div', 'field');
    two.appendChild(dom.el('label', 'label', 'Password again'));
    var second = dom.el('input', 'input');
    second.type = 'password';
    second.name = 'password-confirm';
    second.autocomplete = 'new-password';
    two.appendChild(second);
    form.appendChild(two);

    var strength = dom.el('p', 'meta');
    form.appendChild(strength);

    var error = dom.el('p', 'body lock-card-error');
    error.hidden = true;
    form.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var go = dom.el('button', 'btn btn-primary btn-lg');
    go.type = 'submit';
    go.appendChild(dom.el('span', 'btn-label', 'Encrypt now'));
    dom.setAttr(go, 'data-pending-label', 'Encrypting your keys');
    actions.appendChild(go);
    form.appendChild(actions);
    card.appendChild(form);

    dom.on(first, 'input', function () {
      dom.setText(strength, window.PhosphorFirstRun.strengthWords(first.value));
    });

    dom.on(form, 'submit', function (event) {
      event.preventDefault();
      if (first.value.length < 8) {
        fail(error, 'Use at least eight characters.');
        return;
      }
      if (first.value !== second.value) {
        fail(error, 'The two passwords do not match.');
        return;
      }
      error.hidden = true;
      window.PhosphorShell.setPending(go, true);
      api.walletMigrate(first.value)
        .then(function (answer) {
          // A copy that cannot check leaves the file closed for good: the closed card, with the backup.
          if (answer && answer.code === 'plaintext_unchecked') {
            buildHeld(reason(answer, 'This copy of Phosphor left this key file closed, and nothing changed.'));
            return;
          }
          if (answer && answer.ok === false) {
            fail(error, reason(answer, 'That did not finish, so nothing changed. Try again.'));
            return;
          }
          buildMigrateDone(answer);
        })
        .catch(function (err) {
          fail(error, net.readable(err));
        })
        .finally(function () {
          window.PhosphorShell.setPending(go, false);
        });
    });

    first.focus();
  }

  function buildMigrateDone(answer) {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'Your keys are encrypted'));
    var destroyed = (answer && Array.isArray(answer.destroyed)) ? answer.destroyed : [];
    if (destroyed.length) {
      card.appendChild(dom.el('p', 'body dim', destroyed.length === 1
        ? 'One readable copy was overwritten and deleted.'
        : destroyed.length + ' readable copies were overwritten and deleted.'));
    }

    /* The honest caveat. A snapshot on this disk can still hold the old file
       and nothing this app does can reach into one. */
    var banner = dom.el('div', 'banner');
    banner.dataset.tone = 'warn';
    banner.appendChild(dom.el('span', '', 'This Mac may keep an automatic snapshot of the old file. If that worries you, make a fresh wallet later and move your money to it.'));
    card.appendChild(banner);

    var actions = dom.el('div', 'screen-actions');
    var go = dom.el('button', 'btn btn-primary btn-lg');
    go.appendChild(dom.el('span', 'btn-label', 'Continue'));
    actions.appendChild(go);
    card.appendChild(actions);
    dom.on(go, 'click', function () {
      window.PhosphorShell.refresh({});
    });
    go.focus();
  }

  /* Put the cursor in the password field, or on the Touch ID button where there
     is no field. The queued-request card hands over to the lock this way rather
     than drawing a second way in of its own. */
  function focus() {
    if (!refs.host || refs.host.hidden) return;
    var target = refs.host.querySelector('input[type="password"]') || refs.host.querySelector('.btn-primary');
    if (target) target.focus();
  }

  window.PhosphorLock = { boot: boot, focus: focus, render: render };
})();
