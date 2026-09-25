/* The quit sheet, and the way out after it.

   Cmd+Q, Quit Phosphor and closing the window do not quit at once: the shell
   asks this page first (src-tauri/src/main.rs, request_quit), by calling
   window.__phosphorQuit(), and then reads window.__phosphorQuitState() until
   it says quit. The page never calls the shell; this window has no bridge to
   it. A page that does not answer is quit anyway, so nothing here can trap
   anyone, and a second Cmd+Q while the sheet is up quits at once.

   What the sheet says comes whole from GET /api/quit (src/http/quit.ts): one
   line per thing quitting would interrupt, in the app's words, printed as
   they come. Quit is never disabled. When a move is on its way, "Quit when it
   lands" waits for it and then quits by itself, and it can be cancelled.

   Past the yes the card stays up and becomes Shutting down, and stays until
   the process ends: three steps, each landing when the thing it names has
   happened, and the mark's light going out a slab at a time as they do. The
   shell tells this page each step it takes, through
   window.__phosphorQuitStep(word), and waits for closed before it exits. See
   go(). */
(function () {
  'use strict';

  var dom = window.PhosphorDom;

  // What the shell reads: idle (no sheet), asking (the sheet is up, or the
  // card is still checking what is on its way), quit (the shell may stop the
  // app), closed (the finished card is drawn; the shell may end the process).
  var phase = 'idle';
  var dialog = null;
  var card = null;
  var landTimer = 0;
  var leaving = false;
  var SHOW_WITHOUT_ANSWER_MS = 600;
  var LAND_POLL_MS = 1500;
  /* The least time between two steps landing, so each is seen to land, and
     the finished card's hold before it goes. The shell waits for this page's
     closed, not for a clock of its own; its QUIT_CLOSE_CAP is only for a page
     that stops answering, and the slowest healthy card (about a second and a
     half, when every step lands before the card has arrived) sits well
     inside it. tests/unit/quit-ui.test.ts measures both. */
  var BEAT_MS = 180;
  var HOLD_MS = 320;
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
      if (phase !== 'asking' || leaving || (drawn && report === null)) return;
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
    // A second Escape can close a modal whatever its cancel handler says. Past the yes nothing
    // here closes it, so a close then is that, and the Shutting down card comes straight back.
    dom.on(dialog, 'close', function () {
      if (leaving && !dialog.open) dialog.showModal();
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

  /* ---------- Shutting down ----------

     A step lands only on the thing it names, and nothing here lands on a
     timer. The moves: the backend's own report of what is on its way, read
     again at the yes; a read that does not come back is Not checked, and an
     older answer (the sheet's, or one from a cancelled sheet hours ago) never
     stands in for it. The wallet: the backend's own lock, which it takes only
     when nothing is being sent, or the backend having stopped, since the
     unlocked key lived only in that process. The backend (the step called
     Phosphor): Backend::kill returning. A step with no answer stays where it
     is until the window goes.

     The shell's words: locked, sending (a move is being sent, so the lock is
     left to the stop), stopping, stopped. */
  var STEPS = ['moves', 'lock', 'stop'];
  var STEP_ICON = { moves: 'send', lock: 'lock', stop: 'stop' };
  var facts = null;
  var view = null;
  var rows = null;
  var mark = null;
  var arrived = false;
  var resting = 0;
  var finishing = false;

  function target(f) {
    var moves = f.report === undefined ? 'active' : f.report === null ? 'unknown' : 'done';
    var lock = f.locked || f.stopped ? 'done' : f.stopping || f.sending ? 'held' : f.handed ? 'active' : 'wait';
    var stop = f.stopped ? 'done' : f.stopping || f.sending ? 'active' : 'wait';
    return { moves: moves, lock: lock, stop: stop };
  }

  function lands(state) {
    return state === 'done' || state === 'unknown';
  }

  // What a step says in a state, in the sheet's own words.
  function says(step, state, f) {
    if (step === 'moves') {
      var count = f.report ? f.report.count : 0;
      if (state === 'unknown') return { name: 'Moves on their way', word: 'Not checked', note: 'Anything already sent still finishes.' };
      if (state !== 'done') return { name: 'Moves on their way', word: 'Checking', note: '' };
      if (count === 0) return { name: 'Nothing on its way', word: 'Checked', note: '' };
      return {
        name: count === 1 ? '1 move on its way' : count + ' moves on their way',
        word: 'Noted',
        note: count === 1 ? 'It finishes without Phosphor.' : 'They finish without Phosphor.'
      };
    }
    if (step === 'lock') {
      if (state === 'done') return { name: 'Wallet', word: 'Locked', note: '' };
      if (state === 'held') return { name: 'Wallet', word: 'Waiting', note: 'It locks as Phosphor stops.' };
      return { name: 'Wallet', word: state === 'active' ? 'Locking' : '', note: '' };
    }
    if (state === 'done') return { name: 'Phosphor', word: 'Stopped', note: '' };
    if (state === 'active') return { name: 'Phosphor', word: 'Stopping', note: f.sending ? 'A move is being sent. It finishes first.' : '' };
    return { name: 'Phosphor', word: '', note: '' };
  }

  /* THE WAY OUT. The card the person answered stays where it is and becomes
     Shutting down: the sheet goes out and the steps come in on the card's own
     change of height (motion.js swap), under the mark and the title. The
     backend's report is read once more first, and only once it is in (or
     SHOW_WITHOUT_ANSWER_MS has passed) does the phase say quit, so the shell
     starts stopping things with the moves already counted. */
  function go() {
    if (phase !== 'asking' || leaving) return;
    leaving = true;
    stopLanding();
    facts = { report: undefined, handed: false, locked: false, sending: false, stopping: false, stopped: false };
    view = { moves: 'active', lock: 'wait', stop: 'wait' };
    dom.setAttr(document.body, 'data-quitting', 'true');
    if (dialog) dom.setAttr(dialog, 'aria-busy', 'true');

    var arrive = function () {
      arrived = true;
      advance();
    };
    var motion = window.PhosphorMotion;
    if (card && motion && typeof motion.swap === 'function') {
      var opts = {};
      var out = Array.prototype.slice.call(card.children);
      Promise.resolve(motion.swap(card, out, function () { opts.fade = shutdown(); }, opts)).then(arrive, arrive);
    } else {
      if (card) shutdown();
      arrive();
    }

    var handed = false;
    var hand = function (report) {
      if (handed) return;
      handed = true;
      facts.report = report ? { count: Array.isArray(report.moving) ? report.moving.length : 0 } : null;
      facts.handed = true;
      phase = 'quit';
      advance();
    };
    var late = window.setTimeout(function () { hand(null); }, SHOW_WITHOUT_ANSWER_MS);
    read().then(function (report) {
      window.clearTimeout(late);
      hand(report);
    });
  }

  // The card's new face, drawn into the card the sheet was on. Returns what fades in.
  function shutdown() {
    dom.clear(card);
    dom.setAttr(card, 'data-state', 'closing');
    var head = dom.el('div', 'quit-head');
    mark = dom.mark('quit-mark', 'working');
    if (mark) {
      mark.setAttribute('data-dark', '0');
      head.appendChild(mark);
    }
    var title = dom.el('h2', 'title', 'Shutting down');
    title.id = 'quit-title';
    head.appendChild(title);
    card.appendChild(head);

    var list = dom.el('ol', 'quit-steps');
    list.setAttribute('aria-live', 'polite');
    rows = {};
    for (var i = 0; i < STEPS.length; i += 1) {
      var name = STEPS[i];
      var row = dom.el('li', 'quit-step');
      row.setAttribute('data-step', name);
      var glyph = dom.el('span', 'quit-step-glyph');
      glyph.setAttribute('aria-hidden', 'true');
      var text = dom.el('span', 'quit-step-text');
      var label = dom.el('span', 'quit-step-name');
      var note = dom.el('span', 'quit-step-note');
      text.appendChild(label);
      text.appendChild(note);
      var word = dom.el('span', 'quit-step-word');
      row.appendChild(glyph);
      row.appendChild(text);
      row.appendChild(word);
      list.appendChild(row);
      rows[name] = { row: row, glyph: glyph, name: label, note: note, word: word, kind: '' };
      paint(name, true);
    }
    card.appendChild(list);
    // The buttons that held the focus are gone; the card keeps it inside the dialog.
    card.tabIndex = -1;
    if (typeof card.focus === 'function') card.focus();
    return [head, list];
  }

  function glyphOf(state) {
    if (state === 'done') return 'done';
    if (state === 'active') return 'spin';
    return 'icon';
  }

  // `built` is the first paint, which the card's own fade already brings in.
  function paint(name, built) {
    var refs = rows[name];
    var state = view[name];
    var text = says(name, state, facts);
    refs.row.setAttribute('data-state', state);
    var kind = glyphOf(state);
    if (refs.kind !== kind) {
      refs.kind = kind;
      dom.clear(refs.glyph);
      refs.glyph.appendChild(glyph(kind, STEP_ICON[name]));
    }
    change(refs.name, text.name, built);
    change(refs.word, text.word, built);
    dom.setText(refs.note, text.note);
    dom.setHidden(refs.note, text.note === '');
  }

  function glyph(kind, icon) {
    var icons = window.PhosphorIcons;
    var draw = function (name) {
      return icons && typeof icons.svg === 'function' ? icons.svg(name) : dom.el('span', 'icon');
    };
    if (kind === 'spin') return dom.el('span', 'spinner');
    if (kind === 'done') {
      var disc = dom.el('span', 'quit-step-done');
      disc.appendChild(draw('check'));
      return disc;
    }
    return draw(icon);
  }

  /* A word or a name that changes fades in, the way the move card's stage
     word does: two names for one animation, alternated, since a changed
     animation-name is what restarts it. */
  function change(node, text, built) {
    if (node.textContent === text) return;
    dom.setText(node, text);
    if (!built) node.setAttribute('data-fade', node.getAttribute('data-fade') === 'a' ? 'b' : 'a');
  }

  /* One pass toward what the facts say. A step that has not landed changes
     at once (a spinner starts, a row waits); a landing waits out the beat
     after the one before it, and the rows under it wait with it, so the steps
     land in order, one at a time. */
  function advance() {
    if (!facts || !rows || !arrived || finishing) return;
    var want = target(facts);
    for (var i = 0; i < STEPS.length; i += 1) {
      var name = STEPS[i];
      if (view[name] === want[name]) continue;
      if (lands(want[name])) {
        if (resting) break;
        rest();
      }
      view[name] = want[name];
      paint(name);
    }
    var landed = STEPS.filter(function (step) { return lands(view[step]); }).length;
    darken(landed);
    if (landed === STEPS.length && !resting) finish();
  }

  function rest() {
    resting = window.setTimeout(function () {
      resting = 0;
      advance();
    }, BEAT_MS);
  }

  // One slab of the mark goes out per step landed, front to back, and the last with the close.
  function darken(count) {
    if (mark) mark.setAttribute('data-dark', String(count));
  }

  /* Everything has landed and been seen: the last light goes out, the card
     is held for a read, and then it goes the way every dialog goes, the
     scrim staying, and only then does the phase say closed. */
  function finish() {
    finishing = true;
    darken(STEPS.length + 1);
    if (dialog) dom.setAttr(dialog, 'aria-busy', null);
    window.setTimeout(function () {
      var done = function () {
        if (card) card.style.visibility = 'hidden';
        phase = 'closed';
      };
      var motion = window.PhosphorMotion;
      if (card && motion && typeof motion.leave === 'function') motion.leave(card, done);
      else done();
    }, HOLD_MS);
  }

  function stepped(word) {
    if (!facts) return phase;
    if (word === 'locked') facts.locked = true;
    else if (word === 'sending') facts.sending = true;
    else if (word === 'stopping') facts.stopping = true;
    else if (word === 'stopped') facts.stopped = true;
    else return phase;
    advance();
    return phase;
  }

  window.__phosphorQuit = ask;
  window.__phosphorQuitState = function () { return phase; };
  window.__phosphorQuitStep = stepped;
})();
