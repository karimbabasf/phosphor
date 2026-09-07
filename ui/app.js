/* Phosphor boot. The last script in the document, and the only one that runs
   anything: every file before it defines a namespace and waits. */
(function () {
  'use strict';

  function boot() {
    var store = window.PhosphorState;

    /* ui/chart/chart.js reads a bare `TOKEN` for its own writes and
       ui/chart/trade-overlay.js reads `window.TRADE`. Both globals used to be
       set by the old app.js. They are set here rather than inside the engine so
       its rendering core is carried over unedited. */
    window.PhosphorNet.ensureToken().then(function (token) {
      window.TOKEN = token;
    });

    /* The theme follows the server on every state frame. It is applied before
       anything paints so a themed window never flashes the default palette. */
    store.select('theme', function (theme) {
      window.PhosphorTheme.apply(theme);
    });

    /* The server owns which view is on screen, because the assistant can move
       it with `switch` and a chart tool called while pro is up moves it to
       trade. The window follows rather than arguing. */
    store.select('view', function (view) {
      if (view && !window.PhosphorShell.isPinned()) window.PhosphorShell.setView(view, {});
    });

    /* The idle beacon, which is the only thing that pushes the auto-lock out.
       It is fed by a person moving or typing, never by a request: an assistant
       reading balances every two seconds must not hold a funded wallet open. */
    if (window.PhosphorActivity) {
      window.PhosphorActivity.start(window.PhosphorNet.getToken);
    }

    window.PhosphorDecision.boot();
    window.PhosphorBasic.boot();
    window.PhosphorPro.boot();
    window.PhosphorTrade.boot();
    window.PhosphorFirstRun.boot();
    window.PhosphorLock.boot();
    window.PhosphorShell.boot();
    window.PhosphorAgent.start();
    if (window.PhosphorTrace) window.PhosphorTrace.start();

    var fixtures = window.PhosphorFixtures;
    if (fixtures.active) {
      var card = fixtures.openCard();
      if (card) {
        window.setTimeout(function () {
          window.PhosphorDecision.showReceipt(card);
        }, 120);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
