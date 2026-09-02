/* Phosphor shell: the top bar, the three views, and the one place the app
   decides what the window is showing.

   The old build had two documents and two event streams. This one has a single
   document, a single stream, and a view swap that is a crossfade rather than a
   navigation, so switching modes never reloads and never flashes. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;
  var store = window.PhosphorState;
  var fixtures = window.PhosphorFixtures;

  var VIEWS = ['basic', 'pro', 'trade'];

  var refs = {};
  var field = null;
  var currentView = 'basic';
  var patternState = 'idle';

  function boot() {
    refs.page = document.getElementById('page');
    refs.views = document.getElementById('views');
    refs.tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    refs.lockChip = document.getElementById('chip-lock');
    refs.agentChip = document.getElementById('chip-agent');
    refs.feedChip = document.getElementById('chip-feed');
    refs.freeze = document.getElementById('btn-freeze');
    refs.offline = document.getElementById('offline-bar');
    refs.fieldHost = document.getElementById('field');

    mountField();
    wireTabs();
    wireFreeze();
    wireStream();

    window.PhosphorShell.setView(readInitialView(), { silent: true });
    refresh({ first: true });
  }

  /* ?view= pins the window to one mode and the server's own value is ignored.
     It exists so a screenshot run lands on the same screen every time; without
     the pin the state frame arrives a moment later and moves it. */
  var pinned = null;

  function readInitialView() {
    var params = new URLSearchParams(window.location.search);
    var wanted = params.get('view');
    if (VIEWS.indexOf(wanted) >= 0) {
      pinned = wanted;
      return wanted;
    }
    return 'basic';
  }

  function isPinned() {
    return pinned !== null;
  }

  /* ---------- the pattern field ---------- */

  function mountField() {
    if (!refs.fieldHost || !window.PhosphorPattern) return;
    field = window.PhosphorPattern.mount(refs.fieldHost, { cellPx: 42, state: 'idle' });
    window.patternTheme = function () {
      if (field) field.refreshColors();
    };

    var refit = dom.debounce(function () {
      if (field) field.resize();
    }, 140);
    window.addEventListener('resize', refit);
    window.addEventListener('phosphor:view', refit);

    /* The field is as tall as the document, and the document changes height
       when a fold opens or a table fills. One observer on the page beats
       remembering to call resize from every renderer that can grow it. */
    if (typeof ResizeObserver === 'function' && refs.page) {
      new ResizeObserver(refit).observe(refs.page);
    }
  }

  /* The field is the app's pulse, so exactly one thing decides its intensity
     and it reads the whole window rather than any one panel. Order matters:
     a locked wallet outranks a pending ask, which outranks a working agent. */
  function updateField() {
    var state = store.get() || {};
    var lock = state.lock || {};
    var pending = Array.isArray(state.proposals)
      ? state.proposals.filter(function (p) { return p && p.status === 'pending'; })
      : [];
    var next = 'idle';
    if (lock.state === 'locked' || lock.state === 'no_wallet' || lock.state === 'needs_migration') {
      next = 'locked';
    } else if (pending.length > 0) {
      next = 'waiting';
    } else if (window.PhosphorAgent && window.PhosphorAgent.isWorking()) {
      next = 'working';
    }
    if (next === patternState) return;
    patternState = next;
    if (field) field.setState(next);
  }

  /* ---------- views ---------- */

  function wireTabs() {
    for (var i = 0; i < refs.tabs.length; i += 1) {
      dom.on(refs.tabs[i], 'click', function (event) {
        setView(event.currentTarget.dataset.tab, { fromClick: true });
      });
    }
  }

  function setView(name, options) {
    var opts = options || {};
    if (VIEWS.indexOf(name) < 0) return;
    var changed = name !== currentView;
    currentView = name;

    for (var i = 0; i < VIEWS.length; i += 1) {
      var node = document.getElementById('view-' + VIEWS[i]);
      if (node) dom.setAttr(node, 'data-active', VIEWS[i] === name ? 'true' : null);
    }
    for (var j = 0; j < refs.tabs.length; j += 1) {
      var tab = refs.tabs[j];
      dom.setAttr(tab, 'aria-selected', tab.dataset.tab === name ? 'true' : 'false');
    }
    dom.setAttr(document.body, 'data-view', name);
    dom.setHidden(refs.feedChip, name !== 'trade');
    /* Basic carries this button at the foot of its own column, with the
       sentence that says what it does. A second copy in the top bar is the
       same action twice on one screen. */
    dom.setHidden(refs.freeze, name === 'basic');

    /* Nothing animates on a keyboard-initiated action, and a swap the server
       asked for is not something the person triggered either. */
    if (changed && !opts.silent && opts.fromClick && !window.PhosphorMotion.reduced()) {
      refs.views.dataset.swapping = 'true';
      window.setTimeout(function () { delete refs.views.dataset.swapping; }, 220);
    }

    if (changed) {
      /* Canvases mounted in a hidden view have no size to fit to, so every
         local field and the chart are told to re-measure once their view is on
         screen. Without this an agent panel that was built in the background
         paints into a 1 by 1 canvas forever. */
      window.dispatchEvent(new CustomEvent('phosphor:view', { detail: { view: name } }));
    }
  }

  function view() {
    return currentView;
  }

  /* ---------- the stream ---------- */

  function wireStream() {
    events.onConnection(function (connection) {
      var offline = connection === 'offline' || connection === 'reconnecting';
      dom.setHidden(refs.offline, !offline);
      if (refs.offline) {
        dom.setText(
          refs.offline.querySelector('[data-role="offline-text"]'),
          connection === 'offline'
            ? 'The app stopped answering. What you see here is the last thing it said.'
            : 'Reconnecting to the app.'
        );
      }
      if (refs.feedChip) {
        dom.setAttr(refs.feedChip, 'data-tone', connection === 'live' ? 'up' : 'warn');
        dom.setText(refs.feedChip.querySelector('[data-role="feed-text"]'),
          connection === 'live' ? 'Live' : 'Offline');
      }
    });

    events.on('state', function () { refresh({}); });
    events.on('reattach', function () { refresh({}); });
    events.on('lock', function (frame) {
      var state = store.get() || {};
      if (frame && frame.state) {
        store.put(Object.assign({}, state, { lock: { state: frame.state, idleLocksInSec: null } }));
      }
    });
    events.start();
  }

  function refresh(options) {
    var opts = options || {};
    return api.state(opts.first ? { busy: 'state', label: 'Checking your money' } : {})
      .then(function (result) {
        if (!result.fresh && store.loaded()) return;
        var payload = result.data;
        if (fixtures.active) payload = fixtures.applyToState(payload);
        api.learn(payload);
        store.put(payload);
      })
      .catch(function (err) {
        console.error('[shell] state', err);
      });
  }

  /* ---------- the status cluster ---------- */

  function renderStatus() {
    var state = store.get() || {};
    var lock = state.lock || { state: 'unlocked', idleLocksInSec: null };

    if (refs.lockChip) {
      var locked = lock.state !== 'unlocked';
      var word = 'Unlocked';
      if (lock.state === 'locked') word = 'Locked';
      else if (lock.state === 'no_wallet') word = 'No wallet';
      else if (lock.state === 'needs_migration') word = 'Keys not encrypted';
      else if (typeof lock.idleLocksInSec === 'number' && lock.idleLocksInSec > 0) {
        word = 'Locks in ' + Math.max(1, Math.round(lock.idleLocksInSec / 60)) + ' min';
      }
      dom.setText(refs.lockChip.querySelector('[data-role="lock-text"]'), word);
      dom.setAttr(refs.lockChip, 'data-tone', locked ? 'warn' : null);
    }

    if (refs.freeze) {
      var frozen = !!(state.policy && state.policy.killSwitch);
      dom.setText(refs.freeze.querySelector('.btn-label'),
        frozen ? 'Everything is frozen' : 'Freeze everything');
      dom.setAttr(refs.freeze, 'data-frozen', frozen ? 'true' : null);
    }

    updateField();
  }

  function wireFreeze() {
    if (!refs.freeze) return;
    dom.on(refs.freeze, 'click', function () {
      var state = store.get() || {};
      var frozen = !!(state.policy && state.policy.killSwitch);
      if (!frozen) {
        window.PhosphorConfirm.ask({
          title: 'Freeze everything',
          body: 'This cancels every working order and disarms every rule. It does not close a position: nothing in this app can do that.',
          confirm: 'Freeze everything',
          tone: 'down'
        }).then(function (yes) {
          if (yes) doFreeze(true);
        });
        return;
      }
      doFreeze(false);
    });
  }

  function doFreeze(on) {
    setPending(refs.freeze, true, on ? 'Freezing' : 'Unfreezing');
    api.kill(on)
      .then(function () { return refresh({}); })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () { setPending(refs.freeze, false); });
  }

  /* A pending button keeps its width, swaps its label for the progress verb and
     stops accepting the press. Every wait in this window goes through here. */
  function setPending(button, pending, label) {
    if (!button) return;
    if (pending) {
      var box = button.getBoundingClientRect();
      if (box.width) button.style.minWidth = Math.ceil(box.width) + 'px';
      var slot = button.querySelector('.btn-pending');
      if (!slot) {
        slot = dom.el('span', 'btn-pending');
        slot.appendChild(dom.el('span', 'spinner'));
        slot.appendChild(dom.el('span', 'btn-pending-label'));
        button.appendChild(slot);
      }
      dom.setText(slot.querySelector('.btn-pending-label'), label || 'Working');
      button.dataset.pending = 'true';
      button.setAttribute('aria-busy', 'true');
      return;
    }
    delete button.dataset.pending;
    button.removeAttribute('aria-busy');
    button.style.minWidth = '';
  }

  window.PhosphorShell = {
    boot: boot,
    setView: setView,
    view: view,
    refresh: refresh,
    renderStatus: renderStatus,
    setPending: setPending,
    updateField: updateField,
    isPinned: isPinned
  };

  store.subscribe(renderStatus);
})();
