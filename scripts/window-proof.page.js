/* The browser half of scripts/window-proof.ts: two clocks, installed into the
   trade page by the proof and read back through page.evaluate.

   __railSample(): resolves with the milliseconds from the next trade SSE frame
   to the first DOM change on the rail. The frame is timed by a listener on the
   window's own event stream; the change by a MutationObserver on the rail.

   __drawSample(i): posts one chart_draw through the agent door from inside the
   page and resolves with the milliseconds from before the fetch to the
   animation frame after the engine applied a payload carrying a newer revision,
   which is the frame that puts the new object on the glass. applyChart is a
   global function of ui/chart/chart.js, so it is wrapped in place and put back.

   Plain script, no build: the proof evaluates it into the page. */
(function () {
  'use strict';

  var rail = document.querySelector('.trade-rail');
  var frameAt = 0;
  var waiting = null;

  window.PhosphorEvents.on('trade', function () {
    frameAt = performance.now();
  });

  var observer = new MutationObserver(function () {
    if (!waiting || frameAt === 0) return;
    var ms = performance.now() - frameAt;
    var done = waiting;
    waiting = null;
    frameAt = 0;
    done(ms);
  });
  if (rail) observer.observe(rail, { subtree: true, childList: true, characterData: true, attributes: true });

  window.__railSample = function () {
    return new Promise(function (resolve, reject) {
      waiting = resolve;
      setTimeout(function () {
        if (waiting !== resolve) return;
        waiting = null;
        reject(new Error('no rail update within 5 s'));
      }, 5000);
    });
  };

  window.__drawSample = function (i) {
    return new Promise(function (resolve, reject) {
      var before = window.CHART.rev;
      var orig = window.applyChart;
      var t0 = performance.now();
      var timer = setTimeout(function () {
        window.applyChart = orig;
        reject(new Error('no repaint within 5 s'));
      }, 5000);
      window.applyChart = function (payload) {
        var out = orig.apply(this, arguments);
        if (payload && typeof payload.rev === 'number' && payload.rev > before) {
          /* chartInvalidate inside applyChart queued the scene on the next
             animation frame; this callback runs in that same frame, after it. */
          requestAnimationFrame(function () {
            clearTimeout(timer);
            window.applyChart = orig;
            resolve(performance.now() - t0);
          });
        }
        return out;
      };
      var last = window.CHART.candles[window.CHART.candles.length - 1];
      var price = last.c * (1 + (i + 1) * 0.001);
      fetch('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'view',
          tool: 'chart_draw',
          session: 'window-proof-page',
          client: 'window-proof',
          args: { levels: [{ px: Number(price.toPrecision(6)), label: 'probe ' + i }] }
        })
      }).catch(reject);
    });
  };
})();
