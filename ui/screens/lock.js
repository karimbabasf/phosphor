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

  function shell() {
    dom.clear(refs.host);
    var field = dom.el('div', 'pattern-local');
    refs.host.appendChild(field);
    if (window.PhosphorPattern) {
      window.PhosphorPattern.mount(field, { cells: 13, state: 'locked', seed: 3 });
    }
    var card = dom.el('div', 'screen-card');
    refs.host.appendChild(card);
    return card;
  }

  function buildLock() {
    var card = shell();
    card.appendChild(dom.el('h1', 'title', 'Locked'));
    card.appendChild(dom.el('p', 'body dim', 'Your password unlocks this app on this computer. Nobody can reset it.'));

    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Password'));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    field.appendChild(input);
    card.appendChild(field);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    card.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var unlock = dom.el('button', 'btn btn-primary btn-lg');
    unlock.appendChild(dom.el('span', 'btn-label', 'Unlock'));
    actions.appendChild(unlock);
    card.appendChild(actions);

    card.appendChild(dom.el('p', 'meta', 'Your money is still here and still being read. Nothing moves while this app is locked.'));

    var submit = function () {
      var password = input.value;
      if (!password) return;
      error.hidden = true;
      window.PhosphorShell.setPending(unlock, true, 'Unlocking');
      api.unlock(password)
        .then(function (answer) {
          if (answer && answer.missing) {
            fail(error, 'This app cannot unlock yet. The unlock route is not built on this branch.');
            return;
          }
          if (answer && answer.ok === false) {
            fail(error, reason(answer.error));
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

    dom.on(unlock, 'click', submit);
    dom.on(input, 'keydown', function (event) {
      if (event.key === 'Enter') submit();
    });
    input.focus();
  }

  function reason(code) {
    if (code === 'wrong_password') return 'That password is wrong.';
    if (code === 'locked_out') return 'Too many tries. Wait thirty seconds and try again.';
    if (code === 'no_wallet') return 'There is no wallet on this computer yet.';
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

    var one = dom.el('div', 'field');
    one.appendChild(dom.el('label', 'label', 'Password'));
    var first = dom.el('input', 'input');
    first.type = 'password';
    first.autocomplete = 'new-password';
    one.appendChild(first);
    card.appendChild(one);

    var two = dom.el('div', 'field');
    two.appendChild(dom.el('label', 'label', 'Password again'));
    var second = dom.el('input', 'input');
    second.type = 'password';
    second.autocomplete = 'new-password';
    two.appendChild(second);
    card.appendChild(two);

    var strength = dom.el('p', 'meta');
    card.appendChild(strength);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    card.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var go = dom.el('button', 'btn btn-primary btn-lg');
    go.appendChild(dom.el('span', 'btn-label', 'Encrypt now'));
    actions.appendChild(go);
    card.appendChild(actions);

    dom.on(first, 'input', function () {
      dom.setText(strength, window.PhosphorFirstRun.strengthWords(first.value));
    });

    dom.on(go, 'click', function () {
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
          if (answer && answer.missing) {
            fail(error, 'This app cannot encrypt yet. The migration route is not built on this branch.');
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

  window.PhosphorLock = { boot: boot };
})();
