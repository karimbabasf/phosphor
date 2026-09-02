/* Phosphor event stream. One EventSource for the whole window.

   The old build opened one per page and said nothing when it dropped, so a
   backend that died left the numbers on screen looking live. This one carries
   a connection state the shell paints. */
(function () {
  'use strict';

  var listeners = {};
  var connectionListeners = [];
  var source = null;
  var connection = 'connecting';
  var seenOpen = false;
  var retryAt = 0;

  /* The server sends a state frame every fifteen seconds whether or not anything
     moved, so silence is information. A killed backend does not always give the
     browser an error: the socket can sit open-but-dead and EventSource stays
     quiet, which looks exactly like a stream with nothing to report. Waiting for
     two heartbeats and then saying so is the difference between a window that
     knows the app is gone and one showing numbers from ten minutes ago.

     Silence also means this socket is not delivering, whatever the browser
     thinks of it, so the stream is torn down and reopened rather than waited on.
     Without that a backend that comes back finds a window still holding a dead
     EventSource, and the banner never clears.

     This does not decide the app is down. It moves the connection to `stale`,
     which is what starts the health poll, and the poll finds out. */
  var HEARTBEAT_MS = 15000;
  var SILENCE_MS = HEARTBEAT_MS * 2;
  var lastFrameAt = 0;
  var watchdog = 0;

  function heard() {
    lastFrameAt = Date.now();
    if (connection === 'stale') setConnection('live');
  }

  function watch() {
    if (watchdog) return;
    watchdog = window.setInterval(function () {
      if (source === null) return;
      if (connection !== 'live') return;
      if (Date.now() - lastFrameAt < SILENCE_MS) return;
      setConnection('stale');
      /* Replace the socket. onopen sets the connection back to live and, having
         seen one open already, emits reattach so the window refetches what it
         missed. */
      source.close();
      source = null;
      lastFrameAt = Date.now();
      start();
    }, 5000);
  }

  function on(type, handler) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
    return function () {
      var list = listeners[type];
      if (!list) return;
      var at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    };
  }

  function emit(type, payload) {
    var list = listeners[type];
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](payload);
      } catch (err) {
        console.error('[events] ' + type, err);
      }
    }
  }

  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    for (var i = 0; i < connectionListeners.length; i += 1) {
      try {
        connectionListeners[i](next);
      } catch (err) {
        console.error('[events] connection', err);
      }
    }
  }

  function onConnection(fn) {
    connectionListeners.push(fn);
    fn(connection);
    return function () {
      var at = connectionListeners.indexOf(fn);
      if (at >= 0) connectionListeners.splice(at, 1);
    };
  }

  function start() {
    if (source) return;
    setConnection(seenOpen ? 'reconnecting' : 'connecting');
    source = new EventSource('/api/events');

    source.onopen = function () {
      var wasDown = seenOpen && connection !== 'live';
      seenOpen = true;
      lastFrameAt = Date.now();
      setConnection('live');
      watch();
      if (wasDown) emit('reattach', null);
    };

    source.onmessage = function (event) {
      heard();
      var frame = null;
      try {
        frame = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      emit(frame.type, frame);
      emit('*', frame);
    };

    source.onerror = function () {
      setConnection('offline');
      if (source) {
        source.close();
        source = null;
      }
      /* The browser's own retry is invisible and unbounded. This one backs off
         to 8 s so a dead backend does not hammer the loopback, and the shell
         can say the stream is down while it waits. */
      var wait = Math.min(8000, Math.max(1000, (Date.now() - retryAt) > 20000 ? 1000 : 3000));
      retryAt = Date.now();
      window.setTimeout(start, wait);
    };
  }

  function state() {
    return connection;
  }

  window.PhosphorEvents = {
    start: start,
    on: on,
    onConnection: onConnection,
    state: state
  };
})();
