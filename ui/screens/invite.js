/* Invite codes in the window: the words, the claims and the Add money field.

   A code reaches the app in one of three places. The first run asks for it right after
   the terms (ui/screens/firstrun.js draws that step itself and claims on the addresses
   step); Add money has a "Have an invite code?" line under the network tiles for anyone
   who already has a wallet; and a code pasted into the chat is taken out of the box and
   put in that line (ui/screens/agent.js), because a code there would reach the agent,
   its model provider and the transcript.

   Every network call is ui/core/invite.js. This file keeps the claims a window asked
   for, and says how each one ended exactly once: on the surface that asked, while it is
   on screen, or as a toast once the person has moved on. A claim can take two minutes,
   so a first run that closes in the meantime holds its toast until Basic is up and never
   drops it. The code itself is never kept here: a claim is remembered by the id the app
   answers with. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;

  function api() {
    return window.PhosphorInviteApi;
  }

  function icon(name, className) {
    var icons = window.PhosphorIcons;
    return icons && typeof icons.svg === 'function' ? icons.svg(name, className) : null;
  }

  /* ---------- the words ---------- */

  var COPY = {
    title: 'Got an invite code?',
    lead: 'Paste it and $5 lands in your wallet once it\'s made.',
    label: 'Invite code',
    use: 'Use code',
    skip: 'Skip',
    question: 'Have an invite code?',
    chat: 'Invite codes never go to your assistant. Yours is waiting in Add money.'
  };

  /* "5.00" as "$5", "4.99" as "$4.99", nothing as nothing. */
  function dollars(amount) {
    var n = Number(amount);
    if (!amount || !isFinite(n) || n <= 0) return '';
    return dom.usd(n, Math.round(n * 100) % 100 === 0 ? 0 : 2);
  }

  /* One sentence per state, in the words of the place it is said. `where` is 'firstrun',
     'addmoney' or 'toast'. A figure the app did not send is never guessed. */
  function sentence(what, where, amount, asset) {
    var money = dollars(amount);
    var yours = money ? 'Your ' + money : 'Your invite money';
    switch (what) {
      case 'valid':
        return money ? 'Nice. ' + money + ' is waiting for you.' : 'Nice. Your invite money is waiting for you.';
      case 'typo':
        return 'That code has a typo. Check it and try again.';
      case 'empty':
        return 'This code was already used, or it has a typo.';
      case 'locked':
        return 'This code can\'t pay out right now. Ask whoever sent it for a new one.';
      case 'busy':
        return 'A code is already on its way to your wallet. Give it a minute.';
      case 'wallet-locked':
        return 'Open your wallet first, then add the code.';
      case 'running':
        return 'Adding ' + (money || 'your invite money') + ' to your wallet. This can take up to two minutes.';
      case 'landed':
        return money ? money + ' ' + (asset || 'USDC') + ' is in your wallet.' : 'Your invite money is in your wallet.';
      case 'failed':
        if (where === 'addmoney') return yours + ' didn\'t come through. Paste the code again to try once more.';
        return yours + ' didn\'t come through. Add the code again from Add money.';
      default:
        if (where === 'firstrun') return 'Couldn\'t check the code right now. You can add it later from Add money.';
        return 'Couldn\'t check the code right now. Try again in a moment.';
    }
  }

  /* A claim's own sentence. One the app refused before it ran keeps its reason when the
     reason is about the code (used, on hold, another one running); anything else, a
     dropped connection included, is that the money did not come through. */
  function claimSentence(entry, where) {
    var what = entry.status === 'asking' ? 'running' : entry.status;
    if (what === 'refused') what = ['empty', 'locked', 'busy'].indexOf(entry.reason) >= 0 ? entry.reason : 'failed';
    return sentence(what, where, entry.amount, entry.asset);
  }

  function claimTone(entry) {
    return toneOf(entry.status === 'refused' ? 'failed' : entry.status);
  }

  /* The one line under a field: a tick for good news, the warning glyph for a problem,
     a spinner while money moves. Never red: nothing here puts money at risk. */
  function say(node, tone, words) {
    dom.clear(node);
    if (!words) {
      node.hidden = true;
      dom.setAttr(node, 'data-tone', null);
      return;
    }
    var glyph = null;
    if (tone === 'wait') glyph = dom.el('span', 'spinner invite-said-spin');
    else glyph = icon(tone === 'good' ? 'done' : 'warning', 'invite-said-icon');
    if (glyph) {
      glyph.setAttribute('aria-hidden', 'true');
      node.appendChild(glyph);
    }
    node.appendChild(dom.el('span', 'invite-said-words', words));
    dom.setAttr(node, 'data-tone', tone);
    node.hidden = false;
  }

  function toneOf(status) {
    if (status === 'valid' || status === 'landed') return 'good';
    if (status === 'asking' || status === 'running') return 'wait';
    return 'warn';
  }

  /* The field a code is typed into: read one character at a time, so in the mono face
     (ui/design/invite.css), with every helper that would remember, correct or capitalise
     it switched off. */
  var seq = 0;

  function codeInput() {
    seq += 1;
    var input = dom.el('input', 'input invite-input');
    input.type = 'text';
    input.id = 'invite-code-' + seq;
    input.name = 'invite-code';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', COPY.label);
    return input;
  }

  /* ---------- the claims ---------- */

  /* Each claim this window knows: { id, status, reason, amount, asset, told, shows }.
     `status` is asking (the claim is posted), running, landed, failed, or refused (the
     app said no before it ran, `reason` says why). `shows` are the surfaces showing it in
     place; each answers whether it is on screen, and a claim whose end no surface showed
     is a toast. */
  var claims = {};
  var asking = [];
  /* An end heard for a claim id this window has not been answered with yet: the frame
     can beat the 202. */
  var early = {};
  /* Ends that came while the first run was up, said once Basic is. */
  var held = [];
  var lines = [];

  function firstRunUp() {
    return !!(document.body && typeof document.body.getAttribute === 'function'
      && document.body.getAttribute('data-firstrun') === 'true');
  }

  /* `meta` carries what the check said ({ amount, asset }), so the end is said with the
     figure in it even when the frame leaves it out. */
  function claim(code, meta) {
    var m = meta || {};
    var entry = { id: null, status: 'asking', reason: '', amount: m.amount || '', asset: m.asset || '', told: false, shows: [] };
    asking.push(entry);
    paintLines();
    var door = api();
    var answered = door && typeof door.claim === 'function'
      ? door.claim(code)
      : Promise.resolve({ ok: false, reason: 'offline' });
    answered.then(function (answer) {
      var at = asking.indexOf(entry);
      if (at >= 0) asking.splice(at, 1);
      if (!answer || answer.ok !== true) {
        entry.status = 'refused';
        entry.reason = answer && answer.reason ? answer.reason : 'offline';
        tell(entry);
        paintLines();
        return;
      }
      entry.id = answer.claim;
      /* A frame for this claim may have come first, as the start of a claim this window
         had not been told was its own. */
      var known = claims[entry.id];
      if (known && known !== entry) {
        if (!entry.amount) entry.amount = known.amount;
        if (!entry.asset) entry.asset = known.asset;
        entry.shows = entry.shows.concat(known.shows);
        entry.status = known.status;
        entry.told = known.told;
      } else {
        entry.status = 'running';
      }
      claims[entry.id] = entry;
      var first = early[entry.id];
      if (first) {
        delete early[entry.id];
        if (first.amount) entry.amount = first.amount;
        if (first.asset) entry.asset = first.asset;
        entry.status = first.status;
      }
      if (entry.status === 'running' || entry.told) update(entry);
      else tell(entry);
      paintLines();
    });
    return {
      watch: function (show) { return attach(entry, show); }
    };
  }

  function attach(entry, show) {
    entry.shows.push(show);
    var shown = show(entry.status, entry) !== false;
    /* Said in place now, so Basic does not say it again. */
    var at = held.indexOf(entry);
    if (shown && at >= 0) held.splice(at, 1);
    return function () {
      var i = entry.shows.indexOf(show);
      if (i >= 0) entry.shows.splice(i, 1);
    };
  }

  function update(entry) {
    var shows = entry.shows.slice();
    for (var i = 0; i < shows.length; i += 1) shows[i](entry.status, entry);
  }

  /* How a claim ended, said once. */
  function tell(entry) {
    if (entry.told) return;
    entry.told = true;
    var shown = false;
    var shows = entry.shows.slice();
    for (var i = 0; i < shows.length; i += 1) {
      if (shows[i](entry.status, entry) !== false) shown = true;
    }
    if (!shown) toast(entry);
  }

  function toast(entry) {
    if (firstRunUp()) {
      if (held.indexOf(entry) < 0) held.push(entry);
      return;
    }
    var toaster = window.PhosphorToast;
    if (!toaster || typeof toaster.show !== 'function') return;
    toaster.show(claimSentence(entry, 'toast'), entry.status === 'landed' ? 'up' : 'down');
  }

  /* The first run closed: what it could not say in place is said now, on Basic. */
  function firstRunClosed() {
    var list = held;
    held = [];
    for (var i = 0; i < list.length; i += 1) toast(list[i]);
  }

  /* The app reported a claim, on the stream or in the state. */
  function heard(outcome) {
    var entry = claims[outcome.claim];
    if (!entry) {
      if (outcome.status === 'running') {
        /* A claim this window did not ask for: a window opened while one runs. Its end is
           said all the same. One that is already over is history, and Activity shows it. */
        claims[outcome.claim] = { id: outcome.claim, status: 'running', reason: '', amount: outcome.amount, asset: outcome.asset, told: false, shows: [] };
        paintLines();
      } else {
        early[outcome.claim] = outcome;
      }
      return;
    }
    if (outcome.amount) entry.amount = outcome.amount;
    if (outcome.asset) entry.asset = outcome.asset;
    if (entry.told || outcome.status === 'running' || entry.status !== 'running') return;
    entry.status = outcome.status;
    tell(entry);
    paintLines();
  }

  /* A claim in flight right now, whoever asked for it. */
  function running() {
    if (asking.length) return asking[0];
    for (var id in claims) {
      if (Object.prototype.hasOwnProperty.call(claims, id) && claims[id].status === 'running') return claims[id];
    }
    return null;
  }

  function paintLines() {
    var list = lines.slice();
    for (var i = 0; i < list.length; i += 1) list[i].follow();
  }

  /* ---------- the Add money line ---------- */

  /* "Have an invite code?" opens the field in place, on the morph the agent list's folds
     use. A pasted code is checked at once and a typed one by Use code; a good one turns the
     key into "Add $5", and that click is what moves the money. While a claim runs the line
     is its status, so a second code cannot be started over it. `show(on)` is for a host that
     keeps the line to one step of its own (the network tiles). */
  function line(host, options) {
    var opts = options || {};
    var root = dom.el('div', 'invite-line');

    var toggle = dom.el('button', 'btn btn-quiet btn-sm invite-open');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.appendChild(dom.el('span', 'btn-label', COPY.question));
    var chevron = icon('chevron-down', 'invite-open-icon');
    if (chevron) toggle.appendChild(chevron);
    root.appendChild(toggle);

    var box = dom.el('div', 'invite-box');
    box.hidden = true;
    var input = codeInput();
    var label = dom.el('label', 'label', COPY.label);
    label.htmlFor = input.id;
    var row = dom.el('div', 'field-row invite-row');
    var use = dom.el('button', 'btn btn-primary invite-use');
    use.type = 'button';
    use.appendChild(dom.el('span', 'btn-label', COPY.use));
    dom.setAttr(use, 'data-pending-label', 'Checking');
    row.appendChild(input);
    row.appendChild(use);
    box.appendChild(label);
    box.appendChild(row);
    root.appendChild(box);

    var said = dom.el('p', 'invite-said');
    said.setAttribute('role', 'status');
    said.setAttribute('aria-live', 'polite');
    said.hidden = true;
    root.appendChild(said);
    host.appendChild(root);

    var state = {
      alive: true,
      open: false,
      shown: true,
      /* What the field's last check said: null, 'valid' or a refusal. */
      checked: null,
      amount: '',
      asset: '',
      asked: 0,
      /* The claim this line is showing, and how to stop showing it. */
      entry: null,
      detach: null
    };

    function visible() {
      if (!state.alive || !state.shown) return false;
      if (typeof root.getClientRects !== 'function') return true;
      return root.getClientRects().length > 0;
    }

    function setLabel(words, pending) {
      dom.setText(use.querySelector('.btn-label'), words);
      dom.setAttr(use, 'data-pending-label', pending);
    }

    function pending(on) {
      var shell = window.PhosphorShell;
      if (shell && typeof shell.setPending === 'function') shell.setPending(use, on);
      else use.disabled = !!on;
    }

    /* Everything on the line from its state: the toggle, the field, the key and the one
       sentence under them. */
    function paint() {
      var entry = state.entry;
      var moving = !!entry && (entry.status === 'asking' || entry.status === 'running');
      var ended = !!entry && !moving;
      dom.setHidden(toggle, moving);
      dom.setAttr(toggle, 'aria-expanded', state.open && !moving ? 'true' : 'false');
      dom.setHidden(box, !state.open || moving || (ended && entry.status === 'landed'));
      if (entry) {
        say(said, claimTone(entry), claimSentence(entry, 'addmoney'));
      } else if (state.checked) {
        say(said, toneOf(state.checked), sentence(state.checked, 'addmoney', state.amount, state.asset));
      } else {
        say(said, null, '');
      }
      var good = state.checked === 'valid';
      setLabel(good ? 'Add ' + (dollars(state.amount) || 'it') : COPY.use, good ? 'Adding' : 'Checking');
      if (use.dataset.pending !== 'true') use.disabled = !String(input.value).trim();
    }

    function setOpen(on) {
      if (state.open === on) return;
      /* A claim that has ended is let go of when the field opens for another code. */
      if (on && state.entry && state.entry.status !== 'asking' && state.entry.status !== 'running') stopShowing();
      var change = function () {
        state.open = on;
        if (!on) forget();
        paint();
      };
      var motion = window.PhosphorMotion;
      if (motion && typeof motion.morph === 'function') motion.morph(root, change, { fade: on ? box : null });
      else change();
      if (on && typeof input.focus === 'function') input.focus();
    }

    /* The field's contents and anything said about them go. A claim that has ended is
       let go of too; one still running stays on the line. */
    function forget() {
      state.asked += 1;
      input.value = '';
      state.checked = null;
      state.amount = '';
      state.asset = '';
      if (use.dataset.pending === 'true') pending(false);
      if (state.entry && state.entry.status !== 'asking' && state.entry.status !== 'running') stopShowing();
    }

    function stopShowing() {
      if (state.detach) state.detach();
      state.detach = null;
      state.entry = null;
    }

    function check() {
      var code = String(input.value).trim();
      var door = api();
      if (!code || !door) return;
      state.asked += 1;
      var mine = state.asked;
      if (state.entry) stopShowing();
      state.checked = null;
      paint();
      pending(true);
      door.check(code).then(function (answer) {
        if (!state.alive || mine !== state.asked) return;
        pending(false);
        state.checked = answer.ok ? 'valid' : answer.reason;
        state.amount = answer.ok ? answer.net : '';
        state.asset = answer.ok ? answer.asset : '';
        paint();
        if (!answer.ok && typeof input.focus === 'function') input.focus();
      });
    }

    /* The click that moves the money. The code leaves the field as it is asked for. */
    function add() {
      var code = String(input.value).trim();
      if (!code) return;
      var handle = claim(code, { amount: state.amount, asset: state.asset });
      input.value = '';
      state.checked = null;
      follow(handle);
    }

    /* Show a claim in place: one this line asked for (`handle`), or one already running
       that something else asked for. */
    function follow(handle) {
      if (!state.alive) return;
      if (!handle) {
        if (state.entry) return;
        var other = running();
        if (!other) return;
        handle = { watch: function (show) { return attach(other, show); } };
      }
      if (state.detach) state.detach();
      state.detach = handle.watch(function (status, entry) {
        if (!state.alive) return false;
        state.entry = entry;
        if (status === 'landed' || status === 'failed' || status === 'refused') state.open = status !== 'landed';
        paint();
        return visible();
      });
    }

    dom.on(toggle, 'click', function () { setOpen(!state.open); });
    dom.on(use, 'click', function () {
      if (state.checked === 'valid') add();
      else check();
    });
    dom.on(input, 'input', function () {
      /* An edit takes back what was said about the code before it. */
      state.asked += 1;
      if (use.dataset.pending === 'true') pending(false);
      state.checked = null;
      if (state.entry && state.entry.status !== 'asking' && state.entry.status !== 'running') stopShowing();
      paint();
    });
    dom.on(input, 'paste', function () {
      window.setTimeout(function () { if (state.alive && String(input.value).trim()) check(); }, 0);
    });
    dom.on(input, 'keydown', function (event) {
      if (!event || event.key !== 'Enter') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (!use.disabled) use.click();
    });

    var handle = {
      /* A code handed over from the chat: the field opens with it and checks it, as a
         paste would. Nothing moves until Add is pressed. */
      fill: function (code) {
        if (!state.alive || !code) return;
        if (!state.open) setOpen(true);
        input.value = String(code);
        check();
      },
      show: function (on) {
        state.shown = !!on;
        dom.setHidden(root, !on);
        if (!on && state.open) {
          state.open = false;
          forget();
          paint();
        }
      },
      follow: function () { follow(null); },
      destroy: function () {
        state.alive = false;
        state.asked += 1;
        input.value = '';
        if (state.detach) state.detach();
        state.detach = null;
        var at = lines.indexOf(handle);
        if (at >= 0) lines.splice(at, 1);
        if (root.parentNode === host) host.removeChild(root);
      }
    };
    lines.push(handle);
    paint();
    follow(null);
    if (opts.code) handle.fill(opts.code);
    return handle;
  }

  /* ---------- from the chat ---------- */

  /* A code taken out of the composer goes to Add money, on the tab the person is on when
     it has one (Basic's slab, Pro's flow), and on Basic otherwise. */
  function open(code) {
    if (!code) return false;
    var shell = window.PhosphorShell;
    var view = shell && typeof shell.view === 'function' ? shell.view() : 'basic';
    if (view !== 'basic' && view !== 'pro') {
      if (shell && typeof shell.setView === 'function') shell.setView('basic', { fromClick: true });
      view = 'basic';
    }
    var screen = view === 'pro' ? window.PhosphorPro : window.PhosphorBasic;
    if (!screen || typeof screen.addMoney !== 'function') return false;
    screen.addMoney({ invite: code });
    return true;
  }

  /* ---------- boot ---------- */

  var booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    var door = api();
    if (door && typeof door.onOutcome === 'function') door.onOutcome(heard);
  }

  window.PhosphorInvite = {
    boot: boot,
    COPY: COPY,
    sentence: sentence,
    claimSentence: claimSentence,
    claimTone: claimTone,
    dollars: dollars,
    say: say,
    toneOf: toneOf,
    codeInput: codeInput,
    check: function (code) {
      var door = api();
      return door ? door.check(code) : Promise.resolve({ ok: false, reason: 'offline' });
    },
    claim: claim,
    running: running,
    line: line,
    open: open,
    firstRunClosed: firstRunClosed
  };
})();
