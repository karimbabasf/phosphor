/* Phosphor shell: the top bar, the stage, and the one place the app decides
   what the window is showing.

   One document, one stream, one stage. The conversation column is mounted
   once here and stays on screen in every mode; the world beside it swaps
   views with a crossfade rather than a navigation, so switching modes never
   reloads and never flashes. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;
  var store = window.PhosphorState;
  var fixtures = window.PhosphorFixtures;

  var VIEWS = ['basic', 'pro', 'trade', 'vault'];

  var refs = {};
  var field = null;
  var currentView = 'basic';
  var patternState = 'idle';

  function boot() {
    refs.page = document.getElementById('page');
    refs.topbar = document.getElementById('topbar');
    refs.wordmark = document.getElementById('wordmark');
    refs.colourways = document.getElementById('colourways');
    refs.stage = document.getElementById('stage');
    refs.conversation = document.getElementById('conversation');
    refs.conversationBody = document.getElementById('conversation-body');
    refs.views = document.getElementById('views');
    refs.tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    refs.tabsIndicator = document.getElementById('tabs-indicator');
    refs.lockChip = document.getElementById('chip-lock');
    refs.waitingChip = document.getElementById('chip-waiting');
    refs.backupChip = document.getElementById('chip-backup');
    refs.feedChip = document.getElementById('chip-feed');
    refs.freeze = document.getElementById('btn-freeze');
    refs.offline = document.getElementById('offline-bar');
    refs.fieldHost = document.getElementById('field');

    mountField();
    mountConversation();
    wireTabs();
    wireColourways();
    wireFreeze();
    wireBackupChip();
    wireStream();

    window.PhosphorShell.setView(readInitialView(), { silent: true });
    refresh({ first: true });
    if (typeof window.splitBoot === 'function') window.splitBoot();
    bootSweep();
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

  /* ---------- the one page-load moment ---------- */

  /* A single beam sweeps the topbar's hairline. Once, after first paint, never
     again in the session, and not under reduced motion. */
  function bootSweep() {
    if (!refs.topbar || window.PhosphorMotion.reduced()) return;
    window.requestAnimationFrame(function () {
      dom.setAttr(refs.topbar, 'data-boot', 'true');
      window.setTimeout(function () {
        dom.setAttr(refs.topbar, 'data-boot', null);
      }, 700);
    });
  }

  /* ---------- the afterglow field ---------- */

  /* The field is the conversation column's ground, and the column's size:
     the living part of the window is where the assistant lives, and a canvas
     one column wide is most of the frame budget saved. */
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

    if (typeof ResizeObserver === 'function' && refs.conversation) {
      new ResizeObserver(refit).observe(refs.conversation);
    }
  }

  /* The field is the app's pulse, so exactly one thing decides its intensity
     and it reads the whole window rather than any one panel. Order matters:
     a locked wallet outranks a pending ask, which outranks a working agent. */
  function updateField() {
    var state = store.get() || {};
    var lock = state.lock || {};
    var pending = pendingOf(state);
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

  /* The same filter ui/screens/decision.js draws from. awaiting_touch counts: the
     click landed but the Touch ID dialog has not answered, so the person still
     owes the window something. */
  function pendingOf(state) {
    if (!Array.isArray(state.proposals)) return [];
    return state.proposals.filter(function (p) {
      return p && (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch');
    });
  }

  /* ---------- the colourway menu ----------

     The wordmark opens it. Three rows, one per colourway of the mark, each a
     radio: the checked one follows the server's theme, so a colourway an agent
     set through set_theme is shown checked here too, and the pick posts to the
     server rather than repainting locally, because the frame that comes back is
     what every other window and the next launch will show. Escape and a click
     anywhere else close it; the arrows move between the rows. */
  function wireColourways() {
    if (!refs.wordmark || !refs.colourways) return;
    var rows = Array.prototype.slice.call(refs.colourways.querySelectorAll('[data-profile]'));

    dom.on(refs.wordmark, 'click', function () {
      if (refs.colourways.dataset.open === 'true') closeColourways();
      else openColourways();
    });
    for (var i = 0; i < rows.length; i += 1) {
      dom.on(rows[i], 'click', onColourwayRow);
    }
    dom.on(refs.colourways, 'keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      var at = rows.indexOf(document.activeElement);
      var next = event.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
      rows[next].focus();
    });
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || refs.colourways.dataset.open !== 'true') return;
      event.preventDefault();
      closeColourways();
      refs.wordmark.focus();
    });
    dom.on(document, 'click', function (event) {
      if (refs.colourways.dataset.open !== 'true') return;
      if (within(event.target, refs.wordmark) || within(event.target, refs.colourways)) return;
      closeColourways();
    });

    store.select('theme', renderColourway);
  }

  function within(node, root) {
    for (var at = node; at; at = at.parentNode) {
      if (at === root) return true;
    }
    return false;
  }

  function openColourways() {
    refs.colourways.dataset.open = 'true';
    refs.wordmark.setAttribute('aria-expanded', 'true');
    var checked = refs.colourways.querySelector('[aria-checked="true"]');
    if (checked && typeof checked.focus === 'function') checked.focus();
  }

  function closeColourways() {
    refs.colourways.dataset.open = 'false';
    refs.wordmark.setAttribute('aria-expanded', 'false');
  }

  function onColourwayRow(event) {
    var row = event.currentTarget;
    var profile = row && row.dataset ? row.dataset.profile : null;
    if (!profile) return;
    closeColourways();
    refs.wordmark.focus();
    api.colourway(profile).catch(function (err) {
      window.PhosphorToast.show(net.readable(err), 'down');
    });
  }

  /* The checked row is whatever the server says the window is, never what was
     last clicked here. */
  function renderColourway(theme) {
    var current = theme && typeof theme.profile === 'string' ? theme.profile : 'green-on-black';
    if (!refs.colourways) return;
    var rows = refs.colourways.querySelectorAll('[data-profile]');
    for (var i = 0; i < rows.length; i += 1) {
      dom.setAttr(rows[i], 'aria-checked', rows[i].dataset.profile === current ? 'true' : 'false');
    }
  }

  /* ---------- the conversation column ---------- */

  /* Mounted once, here, and never inside a view: it is the constant. */
  function mountConversation() {
    if (!refs.conversationBody || !window.PhosphorAgent) return;
    window.PhosphorAgent.mount(refs.conversationBody, {
      composerHost: document.getElementById('composer-host')
    });
  }

  /* ---------- views ---------- */

  /* A tablist is ONE tab stop, and on this app that is a safety property rather than an
     accessibility nicety. ux/flow.md budgets the brake at two tab stops from a cold load,
     because the primary control on a trading surface is the thing that stops it. Three
     separately tabbable mode buttons pushed "Freeze everything" to the fourth stop.

     So: roving tabindex. Only the selected tab is in the tab order, and the arrows move
     between them, which is what the ARIA tabs pattern asks for anyway. Without the arrow
     half, tabindex -1 would make the other two modes unreachable from a keyboard, which
     would be a worse bug than the one being fixed. */
  function focusTab(index) {
    var count = refs.tabs.length;
    if (count === 0) return;
    var wrapped = ((index % count) + count) % count;
    var tab = refs.tabs[wrapped];
    setView(tab.dataset.tab, { fromClick: true });
    tab.focus();
  }

  function wireTabs() {
    for (var i = 0; i < refs.tabs.length; i += 1) {
      dom.on(refs.tabs[i], 'click', function (event) {
        setView(event.currentTarget.dataset.tab, { fromClick: true });
      });
      dom.on(refs.tabs[i], 'keydown', function (event) {
        var here = refs.tabs.indexOf(event.currentTarget);
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') focusTab(here + 1);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') focusTab(here - 1);
        else if (event.key === 'Home') focusTab(0);
        else if (event.key === 'End') focusTab(refs.tabs.length - 1);
        else return;
        event.preventDefault();
      });
    }
    window.addEventListener('resize', dom.debounce(placeIndicator, 100));
  }

  /* The segmented control's indicator slides to the selected word. Measured
     from the tab itself so a font swap or a width change cannot strand it. */
  function placeIndicator() {
    if (!refs.tabsIndicator) return;
    var selected = null;
    for (var i = 0; i < refs.tabs.length; i += 1) {
      if (refs.tabs[i].getAttribute('aria-selected') === 'true') selected = refs.tabs[i];
    }
    if (!selected) return;
    refs.tabsIndicator.style.setProperty('--tab-x', selected.offsetLeft + 'px');
    refs.tabsIndicator.style.setProperty('--tab-w', selected.offsetWidth + 'px');
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
      var selected = tab.dataset.tab === name;
      dom.setAttr(tab, 'aria-selected', selected ? 'true' : 'false');
      // The roving half of the tabs pattern. See wireTabs for why this is a brake question.
      tab.tabIndex = selected ? 0 : -1;
    }
    dom.setAttr(document.body, 'data-view', name);
    /* The stream chip is a different fact from the chart's feed line, and the
       trade screen already carries the feed line in its bar. Two live words in
       one eyeline read as one fact said twice, so the chip stays for the other
       screens and steps off this one. */
    dom.setHidden(refs.feedChip, name === 'trade');
    placeIndicator();

    /* Nothing animates on a keyboard-initiated action, and a swap the server
       asked for is not something the person triggered either. */
    if (changed && !opts.silent && opts.fromClick && !window.PhosphorMotion.reduced()) {
      refs.views.dataset.swapping = 'true';
      window.setTimeout(function () { delete refs.views.dataset.swapping; }, 220);
    }

    if (changed) {
      /* Canvases mounted in a hidden view have no size to fit to, so the chart
         is told to re-measure once its view is on screen. */
      window.dispatchEvent(new CustomEvent('phosphor:view', { detail: { view: name } }));
    }

    /* A person's switch is written to the server, so the state frame, the
       assistant's `start` and the line under every tool result say the screen
       they are on. A swap the server asked for is already its own record, so
       only the tab (click or arrow) posts. The window does not wait for the
       answer: it has switched, and a server that refuses learns it on the
       next tab. */
    if (changed && opts.fromClick && api && typeof api.view === 'function') {
      api.view(name).catch(function (err) {
        console.warn('[shell] the server did not take the view', err);
      });
    }
  }

  function view() {
    return currentView;
  }

  /* ---------- the stream ---------- */

  function wireStream() {
    events.onConnection(function (connection) {
      var offline = connection === 'offline' || connection === 'reconnecting' || connection === 'stale';
      dom.setHidden(refs.offline, !offline);
      if (offline) startHealthPoll(connection);
      else stopHealthPoll();
      /* Three words for the stream, each with its own dot: live, delayed
         (connecting, reconnecting, or a stream that has gone quiet and is
         being replaced), and offline, which is the app not answering at all.
         The bar under this one carries the sentence; this is the glance. */
      if (refs.feedChip) {
        var tone = connection === 'live' ? 'up' : (connection === 'offline' ? 'off' : 'warn');
        dom.setAttr(refs.feedChip, 'data-tone', tone);
        dom.setText(refs.feedChip.querySelector('[data-role="feed-text"]'),
          tone === 'up' ? 'Live' : (tone === 'off' ? 'Offline' : 'Delayed'));
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
    /* The deposit watcher speaks on every change. The frame is the `deposit`
       slice of the state, minus its type, so the card renders off the store the
       way everything else does; the card itself decides whether a frame opens
       it, because only it knows which watch it has already seen. */
    events.on('deposit', function (frame) {
      if (!frame || typeof frame.phase !== 'string') return;
      var state = store.get() || {};
      var deposit = Object.assign({}, frame);
      delete deposit.type;
      store.put(Object.assign({}, state, { deposit: deposit }));
      if (window.PhosphorDeposit) window.PhosphorDeposit.onFrame(deposit);
    });
    events.start();
  }

  /* The health poll. It runs ONLY while the stream is down: a window with a live
     stream is already being told everything, and a poll beside it would be a
     second, slower answer to a question already settled. Ten seconds is slow
     enough to be free and fast enough that a person who restarts the backend
     sees the banner clear before they reach for the reload.

     What it buys is the difference between "the app is not answering" and "the
     app is answering and something in it is broken", which is `lastError`. */
  var healthTimer = 0;

  function startHealthPoll(connection) {
    sayOffline(connection, null);
    if (healthTimer) return;
    healthTimer = window.setInterval(pollHealth, 10000);
    pollHealth();
  }

  function stopHealthPoll() {
    if (!healthTimer) return;
    window.clearInterval(healthTimer);
    healthTimer = 0;
  }

  function pollHealth() {
    api.health()
      .then(function (result) {
        var health = result.data || {};
        sayOffline('reconnecting', health.lastError || null);
      })
      .catch(function () {
        sayOffline('offline', null);
      });
  }

  function sayOffline(connection, lastError) {
    if (!refs.offline) return;
    var text = connection === 'reconnecting'
      ? 'Reconnecting to the app.'
      : 'The app stopped answering. What you see here is the last thing it said.';
    if (lastError) text += ' It last reported: ' + lastError;
    dom.setText(refs.offline.querySelector('[data-role="offline-text"]'), text);
  }

  function refresh(options) {
    var opts = options || {};
    return api.state(opts.first ? { busy: 'state', label: 'Checking your money' } : {})
      .then(function (result) {
        if (!result.fresh && store.loaded()) return;
        var payload = result.data;
        if (fixtures.active) payload = fixtures.applyToState(payload);
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

    if (refs.waitingChip) {
      var pending = pendingOf(state);
      dom.setHidden(refs.waitingChip, pending.length === 0);
      dom.setText(refs.waitingChip.querySelector('[data-role="waiting-text"]'),
        pending.length === 1 ? '1 waiting' : pending.length + ' waiting');
    }

    if (refs.freeze) {
      var frozen = !!(state.policy && state.policy.killSwitch);
      dom.setText(refs.freeze.querySelector('.btn-label'),
        frozen ? 'Everything is frozen' : 'Freeze everything');
      dom.setAttr(refs.freeze, 'data-frozen', frozen ? 'true' : null);
    }

    /* Quiet, and there until the phrase has been typed back: a wallet that
       exists and has not been proven backed up is one bad disk away from gone. */
    if (refs.backupChip) {
      var vault = state.vault || {};
      var exposed = !!vault.custody && vault.backedUp === false;
      dom.setHidden(refs.backupChip, !exposed);
    }

    updateField();
  }

  /* The badge is a way in, not just a word: it lands on the Vault tab, where
     Reveal and Prove are. */
  function wireBackupChip() {
    if (!refs.backupChip) return;
    dom.on(refs.backupChip, 'click', function () {
      setView('vault', { fromClick: true });
      if (window.PhosphorVault && typeof window.PhosphorVault.focusRecovery === 'function') {
        window.PhosphorVault.focusRecovery();
      }
    });
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
     stops accepting the press. Every wait in this window goes through here.

     `disabled` is the half that was missing, and it mattered most on Unlock.
     That request does not answer until every proposal queued behind the lock has
     been sent, which is a rail apiece and can be a minute, so the window looked
     frozen and the natural thing to do was press it again. The dataset flag and
     aria-busy said "working" to a screen reader and to the stylesheet and to
     nothing else: the button still took the click. */
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
      button.disabled = true;
      return;
    }
    delete button.dataset.pending;
    button.removeAttribute('aria-busy');
    button.disabled = false;
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
