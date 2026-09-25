/* The quit sheet.

   Cmd+Q, Quit Phosphor and closing the window do not quit at once: the shell
   asks this page first (src-tauri/src/main.rs, request_quit), by calling
   window.__phosphorQuit(), and then reads window.__phosphorQuitState() until
   it says quit. The page never calls the shell; this window has no bridge to
   it. A page that does not answer is quit anyway, so nothing here can trap
   anyone, and a second Cmd+Q while the sheet is up quits at once.

   What the sheet says comes whole from GET /api/quit (src/http/quit.ts): one
   line per thing quitting would interrupt, in the app's words, printed as
   they come. Quit is never disabled. When a move is on its way, "Quit when it
   lands" waits for it and then quits by itself, and it can be cancelled. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;

  // What the shell reads: idle (no sheet), asking (the sheet is up, or the
  // window is on its way out), quit (the exit is drawn; go).
  var phase = 'idle';
  var dialog = null;
  var card = null;
  var landTimer = 0;
  var leaving = false;
  var SHOW_WITHOUT_ANSWER_MS = 600;
  var LAND_POLL_MS = 1500;
  var LEAVE_MS = 320;
  var EXIT_EASE = 'cubic-bezier(0.4, 0, 0.6, 1)';
  var ICON = { entry: 'warning', moving: 'send', held: 'waiting', plan: 'armed', agent: 'waiting', yours: 'waiting', venue: 'shield', incoming: 'deposit' };

  function read() {
    var api = window.PhosphorApi;
    if (!api || typeof api.quit !== 'function') return Promise.resolve(null);
    return api.quit().then(function (answer) {
      var report = answer && answer.data;
      return report && Array.isArray(report.lines) ? report : null;
    }, function () { return null; });
  }

  function ask() {
    if (phase !== 'idle') return phase;
    phase = 'asking';
    var drawn = false;
    var draw = function (report) {
      if (phase !== 'asking' || (drawn && report === null)) return;
      drawn = true;
      open(report);
    };
    var late = window.setTimeout(function () { draw(null); }, SHOW_WITHOUT_ANSWER_MS);
    read().then(function (report) {
      window.clearTimeout(late);
      draw(report);
    });
    return phase;
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'confirm quit';
    dialog.setAttribute('data-motion', 'dialog');
    dialog.setAttribute('aria-labelledby', 'quit-title');
    card = dom.el('div', 'confirm-card quit-card');
    dialog.appendChild(card);
    document.body.appendChild(dialog);
    dom.on(dialog, 'cancel', function (event) {
      event.preventDefault();
      cancel();
    });
    dom.on(dialog, 'click', function (event) {
      if (event.target === dialog) cancel();
    });
  }

  function open(report) {
    if (!dialog) build();
    fill(report);
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.openDialog === 'function') motion.openDialog(dialog);
    else if (!dialog.open) dialog.showModal();
    var first = card.querySelector('[data-role="default"]');
    if (first) first.focus();
  }

  function fill(report) {
    dom.clear(card);
    var title = dom.el('h2', 'title', 'Quit Phosphor?');
    title.id = 'quit-title';
    card.appendChild(title);

    var lines = report ? report.lines : [];
    if (report === null) {
      card.appendChild(dom.el('p', 'body dim', 'Phosphor could not check what is running. Anything already sent still finishes.'));
    } else if (lines.length === 0) {
      card.appendChild(dom.el('p', 'body dim', 'Nothing is running. Your money stays where it is.'));
    } else {
      var list = dom.el('ul', 'firstrun-facts quit-facts');
      for (var i = 0; i < lines.length; i += 1) list.appendChild(line(lines[i]));
      card.appendChild(list);
    }

    var moving = !!(report && report.moving && report.moving.length > 0);
    var wait = dom.el('p', 'quit-wait', 'Waiting for it to land. Phosphor quits by itself.');
    wait.setAttribute('role', 'status');
    wait.hidden = true;
    card.appendChild(wait);

    var actions = dom.el('div', 'screen-actions quit-actions');
    actions.appendChild(button(moving ? 'btn btn-quiet' : 'btn btn-ghost', 'Cancel', cancel));
    if (moving) {
      actions.appendChild(button('btn btn-ghost', 'Quit now', go));
      var land = button('btn btn-primary', 'Quit when it lands', function () { landing(land, wait); });
      land.setAttribute('data-pending-label', 'Waiting');
      land.setAttribute('data-role', 'default');
      actions.appendChild(land);
    } else {
      var quit = button('btn btn-primary', 'Quit', go);
      quit.setAttribute('data-role', 'default');
      actions.appendChild(quit);
    }
    card.appendChild(actions);
  }

  function line(item) {
    var row = dom.el('li', 'firstrun-fact quit-fact');
    if (item.tone) row.setAttribute('data-tone', item.tone);
    var slot = dom.el('span', 'firstrun-fact-icon');
    slot.setAttribute('aria-hidden', 'true');
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function' && ICON[item.kind]) slot.appendChild(icons.svg(ICON[item.kind]));
    row.appendChild(slot);
    var text = dom.el('p', 'firstrun-fact-text');
    text.appendChild(dom.el('span', 'firstrun-fact-lead', String(item.lead || '')));
    text.appendChild(dom.el('span', '', ' ' + String(item.rest || '')));
    row.appendChild(text);
    return row;
  }

  function button(className, label, onClick) {
    var node = dom.el('button', className);
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    dom.on(node, 'click', onClick);
    return node;
  }

  function landing(land, wait) {
    if (landTimer) return;
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(land, true);
    wait.hidden = false;
    var check = function () {
      landTimer = window.setTimeout(function () {
        read().then(function (report) {
          if (!landTimer || phase !== 'asking') return;
          if (report === null || report.moving.length === 0) go();
          else check();
        });
      }, LAND_POLL_MS);
    };
    check();
  }

  function stopLanding() {
    if (landTimer) window.clearTimeout(landTimer);
    landTimer = 0;
  }

  function cancel() {
    if (phase !== 'asking' || leaving) return;
    stopLanding();
    close();
    phase = 'idle';
  }

  function close() {
    var motion = window.PhosphorMotion;
    if (!dialog) return;
    if (motion && typeof motion.closeDialog === 'function') motion.closeDialog(dialog);
    else if (dialog.open) dialog.close();
  }

  function reduced() {
    var motion = window.PhosphorMotion;
    return !!(motion && typeof motion.reduced === 'function' && motion.reduced());
  }

  /* The way out: the sheet goes the way every dialog goes, and the window's
     content dims and settles back behind it onto the bare ground, where the
     window stays until the app has closed. Under reduced motion it is gone at
     once. The shell quits on the next read of the phase. */
  function go() {
    if (phase !== 'asking' || leaving) return;
    leaving = true;
    stopLanding();
    close();
    var layers = Array.prototype.filter.call(document.querySelectorAll('body > #page, body > .screen'), function (node) {
      return !node.hidden && typeof node.animate === 'function';
    });
    var done = function () { phase = 'quit'; };
    if (reduced() || layers.length === 0) {
      for (var i = 0; i < layers.length; i += 1) layers[i].style.opacity = '0';
      done();
      return;
    }
    var runs = layers.map(function (node) {
      return node.animate(
        [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'scale(0.985)', filter: 'blur(6px)' }],
        { duration: LEAVE_MS, easing: EXIT_EASE, fill: 'forwards' }
      ).finished;
    });
    Promise.all(runs).then(done, done);
  }

  window.__phosphorQuit = ask;
  window.__phosphorQuitState = function () { return phase; };
})();
