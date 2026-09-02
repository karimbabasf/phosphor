/* Phosphor network layer. One fetch path for the whole window.

   Three jobs: hold the ETag so an unchanged payload costs a 304 and no render,
   dedup calls already in flight so an SSE burst does not fan out into four
   identical reads, and give every wait a busy() contract so nothing over
   300 ms happens without a noun on the screen. */
(function () {
  'use strict';

  var READ_TIMEOUT_MS = 10000;
  var WRITE_TIMEOUT_MS = 30000;

  var etags = {};
  var cache = {};
  var inflight = {};
  var busyCounts = {};
  var busyListeners = [];

  /* The window token. The Tauri shell mints it, hands it to the backend in
     PHOSPHOR_WINDOW_TOKEN, and injects it into this webview before any script
     runs. It is never served over HTTP: GET /api/session is deleted, which is
     what stops any other process on this machine from reading it and approving.

     ?token= is a development hook and nothing else. A browser pointed at a bare
     `npm run app` has no shell to do the injecting, and the backend prints the
     token to stderr once for exactly that case. It is read before the injected
     value so a dev run can override, and it is the only path here that takes a
     token from a place a person could paste one. */
  var token = typeof window.__PHOSPHOR_TOKEN__ === 'string' ? window.__PHOSPHOR_TOKEN__ : '';
  var devToken = new URLSearchParams(window.location.search).get('token');
  if (devToken) token = devToken;

  function getToken() {
    return token;
  }

  /* Kept as a promise for the callers that were written against the fetch it
     used to do. There is nothing to wait for any more. */
  function ensureToken() {
    return Promise.resolve(token);
  }

  function setToken(value) {
    if (typeof value === 'string' && value.length) token = value;
  }

  /* ---------- busy ---------- */

  function busy(key, label) {
    var entry = busyCounts[key] || { count: 0, label: '' };
    entry.count += 1;
    entry.label = label || entry.label;
    busyCounts[key] = entry;
    emitBusy(key);
    var released = false;
    return function release() {
      if (released) return;
      released = true;
      var current = busyCounts[key];
      if (!current) return;
      current.count = Math.max(0, current.count - 1);
      emitBusy(key);
    };
  }

  function isBusy(key) {
    var entry = busyCounts[key];
    return !!(entry && entry.count > 0);
  }

  function busyLabel(key) {
    var entry = busyCounts[key];
    return entry && entry.count > 0 ? entry.label : '';
  }

  function emitBusy(key) {
    for (var i = 0; i < busyListeners.length; i += 1) {
      try {
        busyListeners[i](key, isBusy(key), busyLabel(key));
      } catch (err) {
        console.error('[net] busy listener', err);
      }
    }
  }

  function onBusy(fn) {
    busyListeners.push(fn);
    return function () {
      var at = busyListeners.indexOf(fn);
      if (at >= 0) busyListeners.splice(at, 1);
    };
  }

  /* ---------- read ---------- */

  function signal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var controller = new AbortController();
    window.setTimeout(function () { controller.abort(); }, ms);
    return controller.signal;
  }

  /* getJson resolves with { data, fresh }. `fresh` is false on a 304, so a
     renderer can skip the work rather than rebuild an identical list. */
  function getJson(path, options) {
    var opts = options || {};
    var key = path;
    if (inflight[key]) return inflight[key];

    var headers = { accept: 'application/json' };
    if (!opts.noCache && etags[key]) headers['if-none-match'] = etags[key];

    var release = opts.busy ? busy(opts.busy, opts.label || '') : null;

    var promise = fetch(path, { headers: headers, signal: signal(READ_TIMEOUT_MS) })
      .then(function (res) {
        if (res.status === 304) {
          return { data: cache[key], fresh: false, status: 304 };
        }
        if (!res.ok) {
          return res.text().then(function (text) {
            throw netError(res.status, text);
          });
        }
        var tag = res.headers.get('etag');
        return res.json().then(function (body) {
          if (tag) etags[key] = tag;
          cache[key] = body;
          return { data: body, fresh: true, status: res.status };
        });
      })
      .finally(function () {
        delete inflight[key];
        if (release) release();
      });

    inflight[key] = promise;
    return promise;
  }

  function netError(status, text) {
    var message = text;
    try {
      var parsed = JSON.parse(text);
      if (parsed && parsed.error) message = parsed.error;
    } catch (err) { /* the body was not JSON, so the text is the message */ }
    if (!message) message = 'The app answered ' + status + ' with no reason.';
    var error = new Error(message);
    error.status = status;
    return error;
  }

  /* ---------- write ---------- */

  function postJson(path, body, options) {
    var opts = options || {};
    var release = opts.busy ? busy(opts.busy, opts.label || '') : null;
    return ensureToken()
      .then(function (value) {
        var payload = Object.assign({}, body);
        if (opts.token !== false && !payload.token) payload.token = value;
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: signal(WRITE_TIMEOUT_MS)
        });
      })
      .then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw netError(res.status, text);
          if (!text) return {};
          try { return JSON.parse(text); } catch (err) { return {}; }
        });
      })
      .finally(function () { if (release) release(); });
  }

  /* A failure a person can act on. Never "request failed": name what happened,
     and where the caller knows it, whether anything left the wallet. */
  function readable(err, nothingLeft) {
    var message = (err && err.message) || String(err);
    if (err && err.name === 'TimeoutError') message = 'The app did not answer in time.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      message = 'The app is not answering. It may have stopped.';
    }
    if (nothingLeft) message += ' Nothing left your wallet.';
    return message;
  }

  function forget(path) {
    delete etags[path];
    delete cache[path];
  }

  window.PhosphorNet = {
    getJson: getJson,
    postJson: postJson,
    busy: busy,
    isBusy: isBusy,
    busyLabel: busyLabel,
    onBusy: onBusy,
    getToken: getToken,
    ensureToken: ensureToken,
    setToken: setToken,
    readable: readable,
    forget: forget
  };
})();
