/* Money in: where to send money, one address per chain, with a QR and the
   warning that matters.

   The app had no surface anywhere that showed a person where to send money,
   which is why a first run could not complete. The addresses come from the
   keystore header, so this works while the app is locked. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;
  var fixtures = window.PhosphorFixtures;

  var loaded = null;
  var loading = null;

  function load() {
    if (loaded) return Promise.resolve(loaded);
    if (loading) return loading;
    if (fixtures.active) {
      loaded = fixtures.receive();
      return Promise.resolve(loaded);
    }
    loading = api.receive().then(function (result) {
      var data = result.data || {};
      loaded = data.missing ? null : data;
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

  /* Light modules on the window's own ground, so a QR does not punch a white
     rectangle into a dark app. The quiet zone is four modules, which is what
     a reader needs to find the code's edge. */
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
    var styles = getComputedStyle(document.documentElement);
    var ground = (styles.getPropertyValue('--bg-1') || '#0F1013').trim();
    var ink = (styles.getPropertyValue('--text') || '#EDEEF0').trim();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = ink;
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
