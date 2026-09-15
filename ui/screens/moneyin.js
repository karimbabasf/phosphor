/* Money in: which networks money can arrive on, one row each, and the way to
   the deposit card that shows the address for one of them.

   The address itself is not drawn here. It is drawn once, on the deposit card,
   after three checks (the wallet is open, the QR decodes back to the same
   bytes, the clipboard reads back what was written), and a second copy of it
   on this fold would be a copy without those checks. This fold names the
   network in the words an exchange uses and hands over. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var loading = null;

  /* Never cached across opens: the report carries `verified`, which flips when
     the wallet opens, and a fold that remembered the locked answer would say
     "unverified" over an address the enclave has since confirmed. */
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

  function render(host) {
    dom.clear(host);
    var pending = dom.el('div', 'stack');
    for (var i = 0; i < 3; i += 1) {
      var skel = dom.el('div', 'skel');
      skel.style.height = '56px';
      pending.appendChild(skel);
    }
    host.appendChild(pending);

    load().then(function (data) {
      dom.clear(host);
      if (!data || !Array.isArray(data.networks) || !data.networks.length) {
        var empty = dom.el('div', 'empty');
        empty.appendChild(dom.el('p', 'empty-title', 'No addresses yet'));
        empty.appendChild(dom.el('p', '', data && data.reason
          ? data.reason.charAt(0).toUpperCase() + data.reason.slice(1) + '.'
          : 'This app has no wallet on this computer yet. Make one and your addresses appear here.'));
        host.appendChild(empty);
        return;
      }

      var lead = dom.el('p', 'body dim');
      dom.setText(lead, 'Pick the network you are sending on. The card that opens shows the address, checks it, and watches for the money to land.');
      host.appendChild(lead);

      var list = dom.el('div', 'stack-2');
      for (var i = 0; i < data.networks.length; i += 1) {
        list.appendChild(networkRow(data.networks[i]));
      }
      host.appendChild(list);

      var caution = dom.el('div', 'banner');
      caution.dataset.tone = 'warn';
      caution.appendChild(dom.el('span', '', 'Money sent on the wrong network is gone. This is not something anyone can undo.'));
      host.appendChild(caution);

      /* The words that are the only way back. On a password wallet they are
         behind the password, here, every time. On an enclave wallet they are
         behind Touch ID on the Vault tab, which also proves the backup. */
      var state = store.get() || {};
      var vault = state.vault || {};
      host.appendChild(vault.custody === 'secure-enclave' ? vaultPointer() : keysBlock());
    });
  }

  /* One network, one button. The asset the card opens on is the one an exchange
     is most likely to send: USDC where the network credits it, else the first
     thing it does credit. The card lets the person switch. */
  function networkRow(network) {
    var row = dom.el('div', 'network-row');
    var left = dom.el('div', 'stack-2 grow');
    left.appendChild(dom.el('p', 'title-sm', window.PhosphorDeposit.networkWords(network.id)));
    var accepts = Array.isArray(network.accepts) ? network.accepts : [];
    var symbols = accepts.map(function (a) { return a.symbol; });
    if (network.unavailable) {
      left.appendChild(dom.el('p', 'meta', 'Not available right now: ' + network.unavailable));
    } else if (symbols.length) {
      left.appendChild(dom.el('p', 'meta', 'Credits ' + symbols.join(', ') + '.'));
    } else {
      left.appendChild(dom.el('p', 'meta', 'Credits nothing right now.'));
    }
    row.appendChild(left);

    var show = dom.el('button', 'btn btn-ghost');
    show.type = 'button';
    show.appendChild(dom.el('span', 'btn-label', 'Show address'));
    show.disabled = !!network.unavailable || !network.address || !symbols.length;
    row.appendChild(show);

    dom.on(show, 'click', function () {
      window.PhosphorDeposit.open({ chain: network.id, symbol: window.PhosphorDeposit.defaultSymbol(accepts) });
    });
    return row;
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
