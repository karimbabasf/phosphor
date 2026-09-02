/* Locked, and the migration that gets a plaintext key file out of the way.

   Reads continue behind the lock in the dimmed shell, so the person still sees
   their balance while the app is shut. Nothing is refused while locked: a write
   the assistant asks for is authored, checked and queued, and it waits. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var refs = {};
  var mode = null;

  function boot() {
    refs.host = document.getElementById('screen-lock');
    if (!refs.host) return;
    store.select('lock', render);
    render(store.get() ? store.get().lock : null);
  }

  function render(lock) {
    var state = (lock && lock.state) || 'unlocked';
    if (state === 'unlocked') {
      dom.setHidden(refs.host, true);
      dom.setAttr(document.body, 'data-locked', null);
      mode = null;
      return;
    }
    if (state === 'no_wallet') {
      dom.setHidden(refs.host, true);
      window.PhosphorFirstRun.open();
      return;
    }
    if (mode === state) return;
    mode = state;
    dom.setAttr(document.body, 'data-locked', 'true');
    dom.setHidden(refs.host, false);
    if (state === 'needs_migration') buildMigrate();
    else buildLock();
  }

  /* No field of its own. The window has exactly one, it is already behind
     everything, and the shell drives it to `locked` the moment the lock state
     arrives. A second field here would paint an opaque ground over the dimmed
     shell, and the point of dimming rather than hiding is that a person can
     still see their balance without unlocking. */
  function shell() {
    dom.clear(refs.host);
    var card = dom.el('div', 'screen-card');
    refs.host.appendChild(card);
    return card;
  }

  function buildLock() {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'Locked'));
    card.appendChild(dom.el('p', 'body dim', 'Your password unlocks this app on this computer. Nobody can reset it.'));

    /* A real form, not a loose input: it is what lets a password manager offer
       to fill and to save, and it gives Enter to submit without a key handler. */
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
    var unlock = dom.el('button', 'btn btn-primary btn-lg');
    unlock.type = 'submit';
    unlock.appendChild(dom.el('span', 'btn-label', 'Unlock'));
    actions.appendChild(unlock);
    form.appendChild(actions);
    card.appendChild(form);

    card.appendChild(dom.el('p', 'meta', 'Your money is still here and still being read. Nothing moves while this app is locked.'));

    var submit = function () {
      var password = input.value;
      if (!password) return;
      error.hidden = true;
      window.PhosphorShell.setPending(unlock, true, 'Unlocking');
      api.unlock(password)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, reason(answer.error, answer.retryInSec));
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
        })
        .finally(function () {
          window.PhosphorShell.setPending(unlock, false);
        });
    };

    dom.on(form, 'submit', function (event) {
      event.preventDefault();
      submit();
    });
    input.focus();
  }

  function reason(code, retryInSec) {
    if (code === 'wrong_password') return 'That password is wrong.';
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
            fail(error, reason(answer.error));
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

  /* Put the cursor in the password field. The queued-request card hands over to
     the lock this way rather than drawing a second password box of its own. */
  function focus() {
    if (!refs.host || refs.host.hidden) return;
    var input = refs.host.querySelector('input[type="password"]');
    if (input) input.focus();
  }

  window.PhosphorLock = { boot: boot, focus: focus };
})();
