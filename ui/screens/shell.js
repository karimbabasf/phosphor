/* Phosphor shell: the top bar, the stage, and the one place the app decides
   what the window is showing.

   One document, one stream, one stage. The conversation is mounted once here
   and stays on screen in every mode; the world beside it swaps views with a
   crossfade rather than a navigation, so switching modes never reloads and
   never flashes. On Basic the conversation takes the window and the world is
   the balances panel on the right. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;
  var store = window.PhosphorState;

  var VIEWS = ['basic', 'pro', 'trade', 'vault'];

  /* The switch has three words and the window four views: Trade is part of
     Pro, reached from Pro's trading card or by a chart the assistant opens,
     and while it is up the switch says Pro. */
  var TAB_OF = { basic: 'basic', pro: 'pro', trade: 'pro', vault: 'vault' };

  /* A view that needs a script the window did not fetch at boot asks for it
     here, the first time it opens (ui/core/lazy.js). The agent picker on the
     Vault tab lives in the first run's script. */
  var NEEDS = { trade: 'trade', vault: 'firstrun' };

  var refs = {};
  var currentView = 'basic';
  var connection = 'live';
  var offlineText = '';

  function boot() {
    refs.page = document.getElementById('page');
    refs.topbar = document.getElementById('topbar');
    refs.stage = document.getElementById('stage');
    refs.conversation = document.getElementById('conversation');
    refs.conversationBody = document.getElementById('conversation-body');
    refs.views = document.getElementById('views');
    refs.tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    refs.tabsIndicator = document.getElementById('tabs-indicator');
    refs.brake = document.getElementById('btn-freeze');
    refs.brakePanel = document.getElementById('brake-panel');
    refs.layoutButton = document.getElementById('btn-layout');
    refs.layoutPop = document.getElementById('bar-layout');
    refs.layoutRows = document.getElementById('bar-layout-rows');
    refs.notice = document.getElementById('notice');

    mountConversation();
    wireTabs();
    wireBrake();
    wireLayout();
    wireRestore();
    wireNotice();
    wireStream();

    window.PhosphorShell.setView(readInitialView(), { silent: true });
    refresh({ first: true });
    if (typeof window.splitBoot === 'function') window.splitBoot();
    endBoot();
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

  /* The mark traces on as the page opens (ui/design/mark.css, keyed on
     html[data-boot], which the document is served with). It is taken away
     once the trace has run, so nothing replays it for the rest of the
     session; with motion reduced there is nothing to wait for. */
  function endBoot() {
    var root = document.documentElement;
    if (!root || !root.hasAttribute('data-boot')) return;
    window.setTimeout(function () {
      root.removeAttribute('data-boot');
    }, window.PhosphorMotion.reduced() ? 0 : 900);
  }

  /* ---------- the conversation ---------- */

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
     because the primary control on a trading surface is the thing that stops it.

     So: roving tabindex. Only the selected tab is in the tab order, and the arrows move
     between them, which is what the ARIA tabs pattern asks for anyway. */
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
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeIndicator);
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

    if (NEEDS[name] && window.PhosphorLazy) window.PhosphorLazy.load(NEEDS[name]);

    for (var i = 0; i < VIEWS.length; i += 1) {
      var node = document.getElementById('view-' + VIEWS[i]);
      if (node) dom.setAttr(node, 'data-active', VIEWS[i] === name ? 'true' : null);
    }
    for (var j = 0; j < refs.tabs.length; j += 1) {
      var tab = refs.tabs[j];
      var selected = tab.dataset.tab === TAB_OF[name];
      dom.setAttr(tab, 'aria-selected', selected ? 'true' : 'false');
      // The roving half of the tabs pattern. See wireTabs for why this is a brake question.
      tab.tabIndex = selected ? 0 : -1;
    }
    dom.setAttr(document.body, 'data-view', name);
    placeIndicator();
    renderLayout();

    /* Nothing animates on a keyboard-initiated action, and a swap the server
       asked for is not something the person triggered either. */
    if (changed && !opts.silent && opts.fromClick && !window.PhosphorMotion.reduced()) {
      refs.views.dataset.swapping = 'true';
      window.setTimeout(function () { delete refs.views.dataset.swapping; }, 220);
    }

    if (changed) {
      /* The world is the one scroller and the views share it, so a screen
         opens at its top rather than wherever the last one was scrolled to. */
      if (refs.views) refs.views.scrollTop = 0;
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
    events.onConnection(function (next) {
      connection = next;
      var down = next === 'offline' || next === 'reconnecting' || next === 'stale';
      if (down) startHealthPoll(next);
      else stopHealthPoll();
      renderNotice();
    });

    events.on('state', function () { refresh({}); });
    events.on('reattach', function () { refresh({}); });
    /* One proposal moved. The object rides in /api/state, never on the frame
       (src/http/sse.ts), so the frame is only the push and this is the read it
       asks for. */
    events.on('proposal', function () { refresh({}); });
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

  function isDown() {
    return connection === 'offline' || connection === 'reconnecting' || connection === 'stale';
  }

  /* The health poll. It runs ONLY while the stream is down: a window with a live
     stream is already being told everything, and a poll beside it would be a
     second, slower answer to a question already settled. Ten seconds is slow
     enough to be free and fast enough that a person who restarts the backend
     sees the line clear before they reach for the reload.

     What it buys is the difference between "the app is not answering" and "the
     app is answering and something in it is broken", which is `lastError`. */
  var healthTimer = 0;

  function startHealthPoll(next) {
    sayOffline(next, null);
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

  function sayOffline(next, lastError) {
    offlineText = next === 'reconnecting'
      ? 'Reconnecting to the app.'
      : 'The app stopped answering. What you see is the last thing it said.';
    if (lastError) offlineText += ' It last reported: ' + lastError;
    renderNotice();
  }

  function refresh(options) {
    var opts = options || {};
    return api.state(opts.first ? { busy: 'state', label: 'Checking your money' } : {})
      .then(function (result) {
        if (!result.fresh && store.loaded()) return;
        store.put(result.data);
      })
      .catch(function (err) {
        console.error('[shell] state', err);
      });
  }

  /* ---------- the notice ----------

     One line, and only while something needs the person, most urgent first:
     the app is not answering, nothing can move (a freeze, or rules that cannot
     be read), or a wallet exists that has not been proven backed up, which is
     one bad disk away from gone. Words and a way through; no dot, no colour. */
  function noticeOf(state) {
    if (isDown()) return { icon: 'link-off', text: offlineText };
    var basic = state.basic || {};
    if (basic.warning) {
      if (frozenIn(state)) return { icon: 'freeze', text: basic.warning, act: 'Unfreeze', run: openBrake };
      return { icon: 'warning', text: basic.warning };
    }
    var vault = state.vault || {};
    if (vault.custody && vault.backedUp === false) {
      return { icon: 'lock', text: 'Your recovery phrase is not backed up yet.', act: 'Back it up', run: openBackup };
    }
    return null;
  }

  var noticeRun = null;

  function wireNotice() {
    if (!refs.notice) return;
    refs.noticeIcon = refs.notice.querySelector('[data-role="notice-icon"]');
    refs.noticeText = refs.notice.querySelector('[data-role="notice-text"]');
    refs.noticeAct = refs.notice.querySelector('[data-role="notice-act"]');
    if (refs.noticeAct) {
      dom.on(refs.noticeAct, 'click', function () {
        if (noticeRun) noticeRun();
      });
    }
  }

  function renderNotice() {
    if (!refs.notice) return;
    var say = noticeOf(store.get() || {});
    dom.setHidden(refs.notice, !say);
    if (!say) {
      noticeRun = null;
      return;
    }
    if (refs.noticeIcon) dom.setAttr(refs.noticeIcon, 'href', '#i-' + say.icon);
    dom.setText(refs.noticeText, say.text);
    dom.setText(refs.noticeAct, say.act || '');
    dom.setHidden(refs.noticeAct, !say.act);
    noticeRun = say.run || null;
  }

  /* The way through from "not backed up": the Vault tab, where Reveal and
     Prove are. */
  function openBackup() {
    setView('vault', { fromClick: true });
    if (window.PhosphorVault && typeof window.PhosphorVault.focusRecovery === 'function') {
      window.PhosphorVault.focusRecovery();
    }
  }

  /* ---------- the brake ----------

     One glyph at the end of the bar, neutral at rest. Its confirm step is a
     small panel under it, never a dialog over the window, and the one red in
     the window is that panel's Freeze button. Frozen, the glyph says so in a
     word, and the same panel is the way back. */
  var BRAKE_WORDS = {
    off: {
      title: 'Freeze everything?',
      body: 'This cancels every working order and disarms every rule. It does not close a position: nothing in this app can do that.',
      keep: 'Cancel',
      go: 'Freeze everything',
      pending: 'Freezing'
    },
    on: {
      title: 'Everything is frozen.',
      body: 'The assistant cannot move any money until you unfreeze.',
      keep: 'Keep frozen',
      go: 'Unfreeze',
      pending: 'Unfreezing'
    }
  };

  function frozenIn(state) {
    return !!(state.policy && state.policy.killSwitch);
  }

  function wireBrake() {
    if (!refs.brake || !refs.brakePanel) return;
    refs.brakeWord = refs.brake.querySelector('[data-role="brake-word"]');
    refs.brakeTitle = document.getElementById('brake-title');
    refs.brakeBody = document.getElementById('brake-body');
    refs.brakeKeep = refs.brakePanel.querySelector('[data-role="brake-keep"]');
    refs.brakeGo = refs.brakePanel.querySelector('[data-role="brake-go"]');
    var wrap = refs.brake.parentNode;

    dom.on(refs.brake, 'click', function () {
      if (refs.brakePanel.hidden) openBrake();
      else closeBrake(true);
    });
    dom.on(refs.brakeKeep, 'click', function () { closeBrake(true); });
    dom.on(refs.brakeGo, 'click', function () {
      doFreeze(!frozenIn(store.get() || {}));
    });
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || refs.brakePanel.hidden) return;
      event.preventDefault();
      closeBrake(true);
    });
    dom.on(document, 'click', function (event) {
      if (refs.brakePanel.hidden) return;
      for (var at = event.target; at; at = at.parentNode) {
        if (at === wrap || at === refs.noticeAct) return;
      }
      closeBrake(false);
    });
    renderBrake();
  }

  function renderBrake() {
    if (!refs.brake) return;
    var frozen = frozenIn(store.get() || {});
    var words = BRAKE_WORDS[frozen ? 'on' : 'off'];
    dom.setAttr(refs.brake, 'data-frozen', frozen ? 'true' : null);
    dom.setAttr(refs.brake, 'aria-label', frozen ? 'Everything is frozen' : 'Freeze everything');
    dom.setAttr(refs.brake, 'title', frozen ? 'Everything is frozen' : 'Freeze everything');
    if (refs.brakeWord) dom.setHidden(refs.brakeWord, !frozen);
    if (!refs.brakeGo) return;
    dom.setText(refs.brakeTitle, words.title);
    dom.setText(refs.brakeBody, words.body);
    dom.setText(refs.brakeKeep.querySelector('.btn-label'), words.keep);
    dom.setText(refs.brakeGo.querySelector('.btn-label'), words.go);
    dom.setAttr(refs.brakeGo, 'data-pending-label', words.pending);
    refs.brakeGo.className = frozen ? 'btn btn-sm' : 'btn btn-danger btn-sm';
  }

  /* The harmless answer takes the focus, so Enter on an open panel cancels. */
  function openBrake() {
    if (!refs.brakePanel) return;
    renderBrake();
    dom.setHidden(refs.brakePanel, false);
    dom.setAttr(refs.brake, 'aria-expanded', 'true');
    if (refs.brakeKeep && refs.brakeKeep.focus) refs.brakeKeep.focus();
  }

  function closeBrake(returnFocus) {
    if (!refs.brakePanel || refs.brakePanel.hidden) return;
    dom.setHidden(refs.brakePanel, true);
    dom.setAttr(refs.brake, 'aria-expanded', 'false');
    if (returnFocus && refs.brake.focus) refs.brake.focus();
  }

  function doFreeze(on) {
    setPending(refs.brakeGo, true);
    api.kill(on)
      .then(function () { return refresh({}); })
      .then(function () { closeBrake(true); })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () { setPending(refs.brakeGo, false); });
  }

  /* ---------- Layout ----------

     Every pane the mode that is up can hide, as a check row: on means on
     screen. It is on the bar while Pro or Trade is up, the modes with panes
     to arrange; Basic and the Vault have none (layout.css hides it there). The
     state is ui/split.js's; this menu only mirrors it, and it re-reads it each
     time it opens, each time a pane changes and each time the view changes, so
     an eye-off press in a header and a press here never disagree. */

  /* The assistant column's way back: a small tab on the world's left edge,
     drawn only while the column is hidden (trade.css keys it off the stage's
     data-pane attribute). */
  function wireRestore() {
    var split = window.PhosphorSplit;
    if (!refs.stage || !split || typeof split.paneRestore !== 'function') return;
    var back = split.paneRestore('conversation');
    if (back) refs.stage.appendChild(back);
  }

  function wireLayout() {
    if (!refs.layoutButton || !refs.layoutPop || !refs.layoutRows) return;
    var wrap = refs.layoutButton.parentNode;
    var button = refs.layoutButton;
    var pop = refs.layoutPop;

    function open() {
      renderLayout();
      dom.setAttr(pop, 'data-open', 'true');
      dom.setAttr(button, 'aria-expanded', 'true');
      var first = refs.layoutRows.children[0];
      if (first && first.focus) first.focus();
    }
    function close() {
      dom.setAttr(pop, 'data-open', null);
      dom.setAttr(button, 'aria-expanded', 'false');
      if (button.focus) button.focus();
    }
    dom.on(button, 'click', function () {
      if (pop.dataset.open === 'true') close();
      else open();
    });
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape' || pop.dataset.open !== 'true') return;
      event.preventDefault();
      close();
    });
    dom.on(document, 'click', function (event) {
      if (pop.dataset.open !== 'true') return;
      for (var at = event.target; at; at = at.parentNode) {
        if (at === wrap) return;
      }
      close();
    });
    window.addEventListener('phosphor:pane', renderLayout);
    renderLayout();
  }

  function renderLayout() {
    if (!refs.layoutRows || !window.PhosphorSplit) return;
    dom.reconcile(refs.layoutRows, window.PhosphorSplit.panes(currentView), function (pane) {
      return pane.name;
    }, function (pane) {
      var row = dom.el('button', 'check-row layers-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitemcheckbox');
      row.dataset.pane = pane.name;
      row.appendChild(dom.el('i', 'check layers-check'));
      row.appendChild(dom.el('span', '', pane.label));
      dom.on(row, 'click', onPaneRow);
      return row;
    }, function (row, pane) {
      dom.setAttr(row, 'aria-checked', pane.hidden ? 'false' : 'true');
    });
  }

  function onPaneRow(event) {
    var row = event.currentTarget;
    var on = row.getAttribute('aria-checked') !== 'true';
    dom.setAttr(row, 'aria-checked', on ? 'true' : 'false');
    window.PhosphorSplit.setPane(row.dataset.pane, on);
  }

  /* A pending button swaps its label for the progress verb and stops accepting
     the press. Every wait in this window goes through here.

     `disabled` is the half that was missing, and it mattered most on Unlock.
     That request does not answer until every proposal queued behind the lock has
     been sent, which is a rail apiece and can be a minute, so the window looked
     frozen and the natural thing to do was press it again. */
  function setPending(button, pending) {
    if (!button) return;
    if (pending) {
      var label = button.getAttribute('data-pending-label') || 'Working';
      var slot = button.querySelector('.btn-pending');
      if (!slot) {
        slot = dom.el('span', 'btn-pending');
        slot.appendChild(dom.el('span', 'spinner'));
        slot.appendChild(dom.el('span', 'btn-pending-label', label));
        button.appendChild(slot);
      }
      /* The brake waits under two verbs, Freezing and Unfreezing, on one button. */
      dom.setText(slot.querySelector('.btn-pending-label'), label);
      button.dataset.pending = 'true';
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      return;
    }
    delete button.dataset.pending;
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }

  function render() {
    renderBrake();
    renderNotice();
  }

  window.PhosphorShell = {
    boot: boot,
    setView: setView,
    view: view,
    refresh: refresh,
    setPending: setPending,
    isPinned: isPinned
  };

  store.subscribe(render);
})();
