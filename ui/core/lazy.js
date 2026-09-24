/* Phosphor's late loads: the scripts a window needs only once a screen that
   uses them opens. The QR libraries draw a deposit address, the chart engine
   and the trade screen are Trade, and the first run is for a wallet that does
   not exist yet (it also carries the agent picker the Vault tab borrows).
   Together they were over half of the script a window fetched at boot, and a
   window that never opens any of them now never fetches them.

   load(name) fetches a bundle's files once, runs them in order, and resolves
   when they have run. It always resolves, true or false: a file that fails to
   load leaves the screen that wanted it to say so in its own words, as it did
   when the file was missing at boot.

   Two screens are called by name before they are loaded (app.js boots every
   screen, lock.js opens the first run), so each gets a stand-in here that
   loads the real one and hands the call over. The real script replaces the
   stand-in when it runs. */
(function () {
  'use strict';

  var BUNDLES = {
    qr: ['./vendor/qrcode.js', './vendor/jsqr.js'],
    trade: ['./screens/trade.js', './chart/chart.js', './chart/labels.js', './chart/mini.js', './chart/trade-overlay.js'],
    firstrun: ['./screens/firstrun.js']
  };

  /* What runs once a bundle is in. The trade screen builds itself and starts
     its chart if Trade is already on screen; the chart has missed the theme,
     which was applied before it existed. */
  var AFTER = {
    trade: function () {
      window.PhosphorTrade.boot();
      if (window.PhosphorTheme && typeof window.PhosphorTheme.repaint === 'function') window.PhosphorTheme.repaint();
    },
    firstrun: function () {
      window.PhosphorFirstRun.boot();
    }
  };

  var loading = {};

  function script(src) {
    return new Promise(function (resolve) {
      var node = document.createElement('script');
      node.src = src;
      /* Scripts added by a script run as soon as each arrives unless told
         otherwise; the chart files read each other's globals, so they keep
         their order. */
      node.async = false;
      node.onload = function () { resolve(true); };
      node.onerror = function () {
        console.error('[lazy] ' + src + ' did not load');
        resolve(false);
      };
      document.head.appendChild(node);
    });
  }

  function load(name) {
    if (loading[name]) return loading[name];
    var files = BUNDLES[name];
    if (!files) return Promise.resolve(false);
    loading[name] = Promise.all(files.map(script)).then(function (results) {
      var ok = results.every(Boolean);
      if (ok && AFTER[name]) {
        try {
          AFTER[name]();
        } catch (err) {
          console.error('[lazy] ' + name, err);
        }
      }
      return ok;
    });
    return loading[name];
  }

  function loaded(name) {
    return !!loading[name];
  }

  /* app.js boots Trade with every other screen. Trade boots when it loads. */
  if (!window.PhosphorTrade) {
    window.PhosphorTrade = { boot: function () {} };
  }

  /* The first run opens the moment the state says there is no wallet, before
     its script has arrived. The stand-in takes the page off the screen the way
     the real card does (lock.css paints nothing behind a first run), so the
     empty window never shows through for the moment the load takes. */
  if (!window.PhosphorFirstRun) {
    window.PhosphorFirstRun = {
      boot: function () {},
      open: function () {
        document.body.setAttribute('data-locked', 'true');
        document.body.setAttribute('data-firstrun', 'true');
        var host = document.getElementById('screen-firstrun');
        if (host) host.hidden = false;
        load('firstrun').then(function (ok) {
          if (ok) window.PhosphorFirstRun.open();
        });
      },
      close: function () {},
      strengthWords: function () {
        load('firstrun');
        return '';
      }
    };
  }

  window.PhosphorLazy = { load: load, loaded: loaded };
})();
