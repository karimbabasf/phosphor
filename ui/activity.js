/* The idle beacon. The ONLY thing that pushes the auto-lock out.
 *
 * The lock's timer lives in the backend (src/keystore/session.ts) and is fed by nothing except
 * POST /api/activity. That is the design rather than an implementation detail: if any request
 * refreshed it, an assistant reading balances every two seconds would hold a funded wallet open
 * all night, which is the exact failure the lock exists for.
 *
 * So this listens for a PERSON: pointer movement, a key, a scroll, a touch. It posts at most
 * once every thirty seconds, because the server only needs to know somebody was here in the
 * last while and a beacon per mousemove would be a few thousand requests an hour.
 *
 * It stops while the window is hidden. A window behind another window is not a person at it,
 * and treating a background tab as presence would be the same hole with a different source. */
(function () {
  'use strict';

  var EVERY_MS = 30000;
  var lastSent = 0;
  var pending = false;

  function send(getToken) {
    var token = getToken();
    if (!token) return;
    lastSent = Date.now();
    fetch('/api/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token }),
    }).catch(function () {
      /* The app is down or restarting. The lock is the server's business either way, and a
         failed beacon must never put an error in front of somebody who only moved the mouse. */
    });
  }

  function start(getToken) {
    if (pending) return;
    pending = true;

    function nudge() {
      if (document.hidden) return;
      if (Date.now() - lastSent < EVERY_MS) return;
      send(getToken);
    }

    var events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (var i = 0; i < events.length; i++) {
      window.addEventListener(events[i], nudge, { passive: true });
    }
    // Coming back to the window is presence, and it is the moment a person most wants the
    // countdown to have been reset before they reach for something.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) send(getToken);
    });
    send(getToken);
  }

  window.PhosphorActivity = { start: start };
})();
