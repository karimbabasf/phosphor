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
  /* The unlock moment in flight, so a lock that lands mid-release can stop it. */
  var releasing = null;
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
    var lock = whole.lock || {};
    var vault = whole.vault || {};
    var state = lock.state || 'unlocked';
    if (state === 'unlocked') {
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
      dom.setHidden(refs.host, true);
      mode = null;
      window.PhosphorFirstRun.open();
      return;
    }
    var custody = vault.custody === 'secure-enclave' ? 'enclave' : 'software';
    var key = state + ':' + custody;
    if (mode === key) return;
    mode = key;
    dom.setAttr(document.body, 'data-locked', 'true');
    setPageInert(true);
    dom.setHidden(refs.host, false);
    if (state === 'needs_migration') buildMigrate();
    else if (custody === 'enclave') buildTouch();
    else buildLock();
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
    brand.appendChild(dom.el('span', 'brand-word', 'Phosphor'));
    card.appendChild(brand);
    card.appendChild(dom.el('h1', 'lock-title', 'Phosphor is locked'));
    refs.host.appendChild(card);
    return card;
  }

  function finePrint(card, text) {
    card.appendChild(dom.el('p', 'lock-fine', text));
  }

  /* The migration card. No field of its own: the window has exactly one, it
     is already behind everything, and the shell drives it to `locked` the
     moment the lock state arrives. A second field here would paint an opaque
     ground over the frosted shell. */
  function shell() {
    dom.clear(refs.host);
    var card = dom.el('div', 'screen-card');
    refs.host.appendChild(card);
    return card;
  }

  function buildLock() {
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

    var error = dom.el('p', 'lock-error down');
    error.hidden = true;
    form.appendChild(error);

    var unlock = dom.el('button', 'btn btn-primary lock-unlock');
    unlock.type = 'submit';
    var label = dom.el('span', 'btn-label');
    append(label, icon('unlock', 'icon-20'));
    label.appendChild(dom.el('span', '', 'Unlock'));
    append(label, icon('chevron-right', 'lock-arrow'));
    unlock.appendChild(label);
    form.appendChild(unlock);
    card.appendChild(form);

    finePrint(card, 'Your password unlocks Phosphor on this Mac and cannot be reset. Your funds stay where they are: nothing moves while the app is locked.');

    /* One unlock in flight at a time. The disabled button covers the click; this
       covers Enter in the password field, which submits the form without going
       anywhere near the button. Unlocking sends every proposal that was queued
       behind the lock, so this wait can run to a minute and pressing again is the
       obvious thing to do. The route holds its own single in-flight promise, so
       a second request would be answered rather than acted on; this is what keeps
       one from being made at all. */
    var inFlight = false;

    var submit = function () {
      var password = input.value;
      if (!password || inFlight) return;
      error.hidden = true;
      inFlight = true;
      window.PhosphorShell.setPending(unlock, true, 'Unlocking');
      api.unlock(password)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, reason(answer.code || answer.error, answer.retryInSec));
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
        });
    };

    dom.on(form, 'submit', function (event) {
      event.preventDefault();
      submit();
    });
    input.focus();
  }

  /* The enclave wallet. No field: the key that opens this file lives in the
     Secure Enclave and the only way to ask it is the system's own dialog, which
     the button raises. The window draws nothing that looks like that dialog. */
  function buildTouch() {
    var card = lockCard();

    var error = dom.el('p', 'lock-error down');
    error.hidden = true;

    var actions = dom.el('div', 'lock-form');
    var unlock = dom.el('button', 'btn btn-primary lock-unlock');
    unlock.type = 'button';
    var label = dom.el('span', 'btn-label');
    append(label, icon('unlock', 'icon-20'));
    label.appendChild(dom.el('span', '', 'Unlock with Touch ID'));
    unlock.appendChild(label);
    actions.appendChild(unlock);
    actions.appendChild(error);
    card.appendChild(actions);
    finePrint(card, 'Touch ID unlocks Phosphor on this Mac. Your Mac login password works too. Your funds stay where they are: nothing moves while the app is locked.');

    /* One dialog at a time. The request answers when the person has touched the
       sensor or cancelled, which can be most of the 150 s the backend allows, so
       the button is dead and says why for the whole wait. */
    var inFlight = false;
    dom.on(unlock, 'click', function () {
      if (inFlight) return;
      inFlight = true;
      error.hidden = true;
      window.PhosphorShell.setPending(unlock, true, 'Waiting for Touch ID');
      api.vaultUnlock()
        .then(function (answer) {
          if (answer && answer.ok === false) {
            /* A cancel is not an error. The button simply comes back. */
            if (answer.code !== 'user_cancel') fail(error, reason(answer.code || answer.error, answer.retryInSec));
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

  /* The custody routes answer { ok, error, code }: `error` is already a sentence a
     person can read, and `code` is what a screen branches on. This table exists
     because the window can say it better in context than a route can. */
  function reason(code, retryInSec) {
    if (code === 'wrong_password') return 'Wrong password. Try again.';
    if (code === 'enclave_unavailable') return 'The Secure Enclave did not answer. Phosphor may be running outside its desktop shell.';
    if (code === 'foreign') return 'This wallet was made on another Mac. Restore it from your recovery phrase.';
    if (code === 'garbled') return 'The Secure Enclave answered the wrong thing. Try again.';
    if (code === 'locked_out') {
      var wait = typeof retryInSec === 'number' && retryInSec > 0
        ? 'Wait ' + retryInSec + (retryInSec === 1 ? ' second' : ' seconds')
        : 'Wait a moment';
      return 'Too many tries. ' + wait + ' and try again.';
    }
    if (code === 'no_wallet') return 'There is no wallet on this computer yet.';
    if (code === 'damaged') return 'The key file on this computer cannot be read. Your recovery words will bring the wallet back.';
    return 'That did not work.';
  }

  function fail(node, message) {
    dom.setText(node, message);
    node.hidden = false;
  }

  /* Migration. Verify before destroying: the envelope is written, read back and
     checked against the address it should derive, and only then is the
     plaintext overwritten. */
  function buildMigrate() {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'Your keys are not encrypted'));
    card.appendChild(dom.el('p', 'body dim', 'This app found a key file on this computer that anything running as you can read. Set a password and it gets encrypted, then the readable copy is destroyed.'));

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

    var error = dom.el('p', 'body down');
    error.hidden = true;
    form.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var go = dom.el('button', 'btn btn-primary btn-lg');
    go.type = 'submit';
    go.appendChild(dom.el('span', 'btn-label', 'Encrypt now'));
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
      window.PhosphorShell.setPending(go, true, 'Encrypting your keys');
      api.walletMigrate(first.value)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, reason(answer.code || answer.error));
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

  window.PhosphorLock = { boot: boot, focus: focus };
})();
