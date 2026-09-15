/* Money in: the three steps of a deposit, run in place, and the way to the
   recovery phrase under them.

   The steps are ui/screens/netpick.js: the network, what it credits, the
   address. This fold used to be five cards that each said "Credits USDC,
   USDT, ..." and a button that opened the deposit card; the steps run here
   now, in the fold, so a person picks a network and reads the address without
   a dialog opening over the screen. The same component draws the wizard's
   addresses step: basic.js and firstrun.js both call render(host). */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var loading = null;

  /* The report, for anything that wants it whole. The steps read it through
     the same route and the backend keeps it for a minute, so this is cheap. */
  function load() {
    if (loading) return loading;
    loading = api.intentsReceive().then(function (result) {
      loading = null;
      return result.data || null;
    }).catch(function () {
      loading = null;
      return null;
    });
    return loading;
  }

  function render(host, options) {
    var opts = options || {};
    dom.clear(host);
    var steps = dom.el('div', 'moneyin-steps');
    host.appendChild(steps);
    window.PhosphorNetPick.render(steps, { context: opts.context || 'basic' });

    /* The words that are the only way back. On a password wallet they are
       behind the password, here, every time. On an enclave wallet they are
       behind Touch ID on the Vault tab, which also proves the backup. */
    var state = store.get() || {};
    var vault = state.vault || {};
    host.appendChild(vault.custody === 'secure-enclave' ? vaultPointer() : keysBlock());
  }

  function vaultPointer() {
    var wrap = dom.el('section', 'keys-block');
    wrap.appendChild(dom.el('p', 'title-sm', 'Your recovery phrase'));
    wrap.appendChild(dom.el('p', 'meta', 'It lives behind Touch ID on the Vault tab, where you can reveal it, prove you saved it, or restore from it.'));
    var row = dom.el('div', 'hstack-2');
    var go = dom.el('button', 'btn btn-ghost');
    go.type = 'button';
    go.appendChild(dom.el('span', 'btn-label', 'Open the Vault tab'));
    row.appendChild(go);
    wrap.appendChild(row);
    dom.on(go, 'click', function () {
      window.PhosphorShell.setView('vault', { fromClick: true });
    });
    return wrap;
  }

  /* ---------- your keys ---------- */

  function keysBlock() {
    var wrap = dom.el('section', 'keys-block');
    wrap.appendChild(dom.el('p', 'title-sm', 'Your keys'));
    wrap.appendChild(dom.el('p', 'meta', 'Your recovery words are the only way back to this wallet. Anyone who has them has your money.'));

    var row = dom.el('div', 'hstack-2 wrap');
    var words = dom.el('button', 'btn btn-ghost');
    words.type = 'button';
    words.appendChild(dom.el('span', 'btn-label', 'Show my recovery words'));
    var backup = dom.el('button', 'btn btn-ghost');
    backup.type = 'button';
    backup.appendChild(dom.el('span', 'btn-label', 'Save an encrypted backup'));
    row.appendChild(words);
    row.appendChild(backup);
    wrap.appendChild(row);

    dom.on(words, 'click', function () { askPassword('mnemonic'); });
    dom.on(backup, 'click', function () { askExport(); });
    return wrap;
  }

  /* The password is asked for at the moment of the reveal and held nowhere.
     A control that reveals a key on one click, because you typed a password ten
     minutes ago, is a key an unattended window hands out. */
  function askPassword(what) {
    window.PhosphorPassword.ask({
      title: what === 'keys' ? 'Show your private keys' : 'Show your recovery words',
      body: 'Type your password. The words are shown once and are not saved anywhere by this app.',
      confirm: 'Show them'
    }).then(function (password) {
      if (!password) return;
      return api.revealStart(password, what).then(function (answer) {
        if (answer && answer.ok === false) throw new Error(revealProblem(answer.code || answer.error));
        return api.revealFetch(answer.nonce);
      }).then(function (material) {
        showMaterial(what, material);
      });
    }).catch(function (err) {
      window.PhosphorToast.show(net.readable(err), 'down');
    });
  }

  function revealProblem(code) {
    if (code === 'wrong_password') return 'That password is wrong.';
    if (code === 'no_mnemonic') return 'This wallet was brought in as raw keys, so it has no recovery words.';
    if (code === 'no_wallet') return 'There is no wallet on this computer.';
    return 'That did not work.';
  }

  function showMaterial(what, material) {
    window.PhosphorDecision.showCard(function (host, close) {
      dom.clear(host);
      host.appendChild(dom.el('p', 'label', 'On this screen only'));
      host.appendChild(dom.el('h2', 'title', what === 'keys' ? 'Your private keys' : 'Your recovery words'));

      var warn = dom.el('div', 'banner');
      warn.dataset.tone = 'down';
      warn.appendChild(dom.el('span', '', 'Anyone who reads these can take your money. Nobody from this app will ever ask you for them.'));
      host.appendChild(warn);

      if (what === 'mnemonic' && Array.isArray(material.mnemonic)) {
        var grid = dom.el('ol', 'words');
        for (var i = 0; i < material.mnemonic.length; i += 1) {
          var item = dom.el('li', 'word');
          item.appendChild(dom.el('span', 'meta mono', String(i + 1)));
          item.appendChild(dom.el('span', 'body mono', material.mnemonic[i]));
          grid.appendChild(item);
        }
        host.appendChild(grid);
      } else if (material.keys) {
        var list = dom.el('div', 'stack-2');
        ['evm', 'solana', 'near'].forEach(function (rail) {
          if (!material.keys[rail]) return;
          list.appendChild(dom.el('p', 'label', rail === 'evm' ? 'Ethereum, Base and Arbitrum' : (rail === 'solana' ? 'Solana' : 'NEAR')));
          list.appendChild(dom.el('p', 'addr', material.keys[rail]));
        });
        host.appendChild(list);
      }

      var actions = dom.el('div', 'screen-actions');
      var done = dom.el('button', 'btn btn-primary');
      done.appendChild(dom.el('span', 'btn-label', 'Done'));
      actions.appendChild(done);
      host.appendChild(actions);
      dom.on(done, 'click', close);
    });
  }

  function askExport() {
    window.PhosphorPassword.ask({
      title: 'Save an encrypted backup',
      body: 'Type your password. The file is encrypted with it, so the copy is only as safe as the password is.',
      confirm: 'Save it',
      extra: { label: 'Where to save it', placeholder: '/Users/you/phosphor-backup.json' }
    }).then(function (password, where) {
      if (!password) return;
      var target = window.PhosphorPassword.extraValue();
      if (!target) throw new Error('Say where to save it.');
      return api.walletExport(password, target).then(function (answer) {
        if (answer && answer.ok === false) throw new Error(revealProblem(answer.code || answer.error));
        window.PhosphorToast.show('Backup written to ' + target + '.');
      });
    }).catch(function (err) {
      window.PhosphorToast.show(net.readable(err), 'down');
    });
  }

  window.PhosphorMoneyIn = {
    render: render,
    load: load
  };
})();
