/* Money in: where to send money, one address per chain, with a QR and the
   warning that matters.

   The app had no surface anywhere that showed a person where to send money,
   which is why a first run could not complete. The addresses come from the
   keystore header, so this works while the app is locked. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;

  var loaded = null;
  var loading = null;

  function load() {
    if (loaded) return Promise.resolve(loaded);
    if (loading) return loading;
    loading = api.receive().then(function (result) {
      loaded = result.data || null;
      loading = null;
      return loaded;
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
      skel.style.height = '72px';
      pending.appendChild(skel);
    }
    host.appendChild(pending);

    load().then(function (data) {
      dom.clear(host);
      if (!data || !Array.isArray(data.chains) || !data.chains.length) {
        var empty = dom.el('div', 'empty');
        empty.appendChild(dom.el('p', 'empty-title', 'No addresses yet'));
        empty.appendChild(dom.el('p', '', 'This app has no wallet on this computer yet. Make one and your addresses appear here.'));
        host.appendChild(empty);
        return;
      }

      var lead = dom.el('p', 'body dim');
      dom.setText(lead, 'Send money to the address on the chain you are sending from. If you are not sure, use the first one.');
      host.appendChild(lead);

      for (var i = 0; i < data.chains.length; i += 1) {
        host.appendChild(chainCard(data.chains[i]));
      }

      var caution = dom.el('div', 'banner');
      caution.dataset.tone = 'warn';
      caution.appendChild(dom.el('span', '', 'Money sent to the wrong chain is gone. This is not something anyone can undo.'));
      host.appendChild(caution);

      /* The keys live on this surface because this is the wallet surface: the
         addresses money arrives at, and the words that are the only way back to
         them. Both are behind the password, every time, with no session that
         remembers you just typed it. */
      host.appendChild(keysBlock());
    });
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

  function chainCard(chain) {
    var card = dom.el('div', 'receive-card');

    var left = dom.el('div', 'stack-2 grow');
    left.appendChild(dom.el('p', 'title-sm', chain.name));
    left.appendChild(dom.el('p', 'addr dim', chain.address));

    var actions = dom.el('div', 'hstack-2');
    var copy = dom.el('button', 'btn btn-ghost');
    copy.type = 'button';
    copy.appendChild(dom.el('span', 'btn-label', 'Copy address'));
    actions.appendChild(copy);
    left.appendChild(actions);

    if (chain.warning) {
      left.appendChild(dom.el('p', 'meta', chain.warning));
    }

    var qr = dom.el('div', 'qr');
    var canvas = dom.el('canvas');
    qr.appendChild(canvas);

    card.appendChild(left);
    card.appendChild(qr);

    drawQr(canvas, chain.address);

    dom.on(copy, 'click', function () {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(chain.address).then(function () {
        dom.setText(copy.querySelector('.btn-label'), 'Copied');
        window.setTimeout(function () {
          dom.setText(copy.querySelector('.btn-label'), 'Copy address');
        }, 1600);
      });
    });

    return card;
  }

  /* Dark modules on a light quiet zone, which is the way round the QR standard
     specifies. An inverted code reads fine on a modern phone and is rejected by
     plenty of older scanners, and the thing on the other side of this code is
     an address money is sent to: a code that some camera cannot read is worth
     more than a white tile is worth avoiding. The quiet zone is four modules,
     which is what a reader needs to find the code's edge. */
  function drawQr(canvas, text) {
    if (typeof window.qrcode !== 'function' || !text) {
      canvas.remove();
      return;
    }
    var code;
    try {
      code = window.qrcode(0, 'M');
      code.addData(String(text));
      code.make();
    } catch (err) {
      canvas.remove();
      return;
    }

    var count = code.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;
    var scale = Math.max(2, Math.floor(132 / total));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = total * scale;

    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (!code.isDark(row, col)) continue;
        ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }

  window.PhosphorMoneyIn = {
    render: render,
    load: load,
    drawQr: drawQr
  };
})();
