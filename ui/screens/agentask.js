/* The card that asks about an agent started outside Phosphor.

   An agent the app did not start (in a terminal, in another app) takes its
   seat with agent.secret, which any program running as this user can read.
   So until the person allows it here, every move it asks for waits for their
   click (src/agents.ts, src/web-read.ts OUTSIDE_REASON). This card is where
   they allow it: who is asking, in its own words, what it can do now and
   after an Allow, and two answers.

   It sits in the conversation, under the roster it is about, in the slot
   ui/screens/agent.js keeps there (.agent-asks), and takes its place in the
   column's flow: the thread moves down for it, and nothing is covered, not
   the conversation, not the balances, not the freeze panel. It takes nothing
   from the person: focus stays where it was, so a key pressed in the composer
   never answers it, and its buttons hold for a beat after it lands, so a
   click already on its way cannot either. One card at a time, oldest first,
   and it says how many more wait. The name is the agent's own word, drawn as
   text in quotes and never with a brand's mark: a mark would vouch for a name
   nobody checked. Ask each time keeps every move it asks for waiting, and the
   agent's roster row keeps a Change that brings this card back (reopen). */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var api = window.PhosphorApi;
  var net = window.PhosphorNet;

  // A card that lands under a pointer holds its answers this long (decision.js does the same).
  var ARM_MS = 600;
  // The slot opens and closes on the window's own numbers (ui/design/motion.js morph and leave).
  var OPEN_MS = 240;
  var CLOSE_MS = 200;
  var EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
  var EXIT_EASE = 'cubic-bezier(0.4, 0, 0.6, 1)';
  // What a screen reader hears when an agent asks: the card never takes the focus to say it.
  var ASKS = 'An agent started outside Phosphor asks to be allowed.';

  var slot = null;
  var host = null;
  var refs = null;
  var live = null;
  var showing = null;
  var answered = {};
  var reopened = {};
  var armed = 0;
  var sizing = null;

  function own(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function boot() {
    if (!store || typeof store.select !== 'function') return;
    store.select('agents', function () { render(); });
    store.select('policy', function () { if (showing) paint(showing); });
    render();
  }

  /* The agents waiting on the person: started outside, able to be allowed (its proxy holds a
     key of its own), not allowed, and not answered here. One put off with Ask each time waits
     no more, unless the person asked about it again from its roster row, and then it goes
     first: the person asked for it. Otherwise oldest first. */
  function waiting(state) {
    var agents = state && state.agents ? state.agents : null;
    var members = agents && Array.isArray(agents.members) ? agents.members : [];
    var first = [];
    var rest = [];
    for (var i = 0; i < members.length; i += 1) {
      var m = members[i];
      if (!m || m.origin !== 'outside' || m.askable !== true || m.allowed === true) continue;
      var id = String(m.session);
      if (own(answered, id)) continue;
      if (own(reopened, id)) first.push(m);
      else if (m.later !== true) rest.push(m);
    }
    return first.concat(rest);
  }

  function asking(state) {
    var list = waiting(state);
    return list.length ? list[0] : null;
  }

  function limitWords(state) {
    var policy = state && state.policy ? state.policy : null;
    var out = policy && policy.outbound ? policy.outbound : null;
    var ask = out && typeof out.humanClickAboveUsd === 'number' ? out.humanClickAboveUsd : null;
    // An Allow changes what it asks for next, never a move already waiting (src/agents.ts allow).
    var after = ' Moves it already asked for still wait for your OK.';
    if (ask === null || !isFinite(ask) || ask <= 0) return 'Small moves run without asking you, the same as from Phosphor\'s own chat.' + after;
    return 'Moves up to ' + dom.usd(ask, ask % 1 === 0 ? 0 : 2) + ' run without asking you, the same as from Phosphor\'s own chat.' + after;
  }

  function slotOf() {
    return typeof document.querySelector === 'function' ? document.querySelector('.agent-asks') : null;
  }

  function build(into) {
    slot = into;
    host = dom.el('section', 'agent-ask');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'false');
    host.setAttribute('aria-labelledby', 'agent-ask-title');
    host.setAttribute('aria-describedby', 'agent-ask-now');
    host.setAttribute('data-motion', 'pop');
    host.hidden = true;

    var head = dom.el('div', 'agent-ask-head');
    // The icon set's link, which the window draws for any agent it did not start (marks.js).
    var glyph = dom.el('span', 'agent-ask-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') glyph.appendChild(icons.svg('link'));
    var who = dom.el('div', 'agent-ask-who');
    var title = dom.el('h2', 'agent-ask-title', 'Allow this agent?');
    title.id = 'agent-ask-title';
    var name = dom.el('p', 'agent-ask-name');
    var more = dom.el('p', 'agent-ask-more');
    more.hidden = true;
    who.appendChild(title);
    who.appendChild(name);
    who.appendChild(more);
    head.appendChild(glyph);
    head.appendChild(who);

    var facts = dom.el('dl', 'agent-ask-facts');
    var nowRow = dom.el('div', 'agent-ask-fact');
    nowRow.appendChild(dom.el('dt', '', 'Until you allow it'));
    var now = dom.el('dd', '', 'It can read your wallet. Every move it asks for waits for your OK.');
    now.id = 'agent-ask-now';
    nowRow.appendChild(now);
    var thenRow = dom.el('div', 'agent-ask-fact');
    thenRow.appendChild(dom.el('dt', '', 'If you allow it'));
    var then = dom.el('dd', '');
    thenRow.appendChild(then);
    facts.appendChild(nowRow);
    facts.appendChild(thenRow);

    var note = dom.el('p', 'agent-ask-note', 'Allow only an agent you started yourself. Phosphor can\'t see what it reads elsewhere.');
    var error = dom.el('p', 'agent-ask-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    var actions = dom.el('div', 'agent-ask-actions');
    // The harmless answer, named for what it does: every move this agent asks for waits.
    var later = dom.el('button', 'btn btn-quiet');
    later.type = 'button';
    later.appendChild(dom.el('span', 'btn-label', 'Ask each time'));
    dom.setAttr(later, 'data-pending-label', 'Ask each time');
    var allow = dom.el('button', 'btn btn-primary');
    allow.type = 'button';
    allow.appendChild(dom.el('span', 'btn-label', 'Allow'));
    dom.setAttr(allow, 'data-pending-label', 'Allowing');
    actions.appendChild(later);
    actions.appendChild(allow);

    host.appendChild(head);
    host.appendChild(facts);
    host.appendChild(note);
    host.appendChild(error);
    host.appendChild(actions);
    slot.appendChild(host);

    /* The card never takes the focus, so a polite line outside it says that an agent asks. */
    live = dom.el('p', 'sr-only agent-ask-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);

    dom.on(later, 'click', function () { answer(false, later); });
    dom.on(allow, 'click', function () { answer(true, allow); });
    // Escape inside the card is Ask each time: the harmless answer, never Allow.
    dom.on(host, 'keydown', function (event) {
      if (event && event.key === 'Escape') answer(false, later);
    });

    refs = { name: name, more: more, then: then, error: error, later: later, allow: allow };
  }

  function paint(member) {
    var state = store.get() || {};
    var called = String(member.client || member.label || 'an agent');
    var at = dom.clock(member.since);
    dom.setText(refs.name, '"' + called + '", started outside Phosphor' + (at ? ' at ' + at : ''));
    dom.setText(refs.then, limitWords(state));
    var others = waiting(state).filter(function (m) { return String(m.session) !== String(member.session); }).length;
    dom.setText(refs.more, others === 1 ? '1 more agent is waiting' : others + ' more agents are waiting');
    dom.setHidden(refs.more, others === 0);
  }

  function arm() {
    var mine = (armed += 1);
    refs.allow.disabled = true;
    refs.later.disabled = true;
    window.setTimeout(function () {
      if (!showing || mine !== armed) return;
      refs.allow.disabled = false;
      refs.later.disabled = false;
    }, ARM_MS);
  }

  /* Said again for every agent that asks: emptied first, so the same sentence is news again. */
  function announce() {
    dom.setText(live, '');
    window.setTimeout(function () {
      if (showing) dom.setText(live, ASKS);
    }, 80);
  }

  function moves() {
    var motion = window.PhosphorMotion;
    var still = !motion || typeof motion.reduced !== 'function' || motion.reduced();
    return !still && !!slot && typeof slot.animate === 'function';
  }

  /* The slot opens and closes under the card, its height and the column's gap after it together,
     so the thread slides rather than jumps. The card's own pop is ui/design/motion.css's. */
  function size(opening, done) {
    var finish = typeof done === 'function' ? done : function () {};
    if (sizing) {
      sizing.cancel();
      sizing = null;
      slot.style.overflow = '';
    }
    if (!moves()) {
      finish();
      return;
    }
    var parent = slot.parentNode;
    var gap = parent && typeof window.getComputedStyle === 'function' ? parseFloat(window.getComputedStyle(parent).rowGap) || 0 : 0;
    var full = { height: slot.getBoundingClientRect().height + 'px', marginBottom: '0px' };
    var none = { height: '0px', marginBottom: -gap + 'px' };
    slot.style.overflow = 'hidden';
    var anim = slot.animate(opening ? [none, full] : [full, none], {
      duration: opening ? OPEN_MS : CLOSE_MS,
      easing: opening ? EASE : EXIT_EASE,
      fill: opening ? 'none' : 'forwards'
    });
    sizing = anim;
    anim.finished.then(function () {
      if (sizing !== anim) return;
      sizing = null;
      slot.style.overflow = '';
      finish();
      anim.cancel();
    }, function () { /* cancelled: the next open or close owns the slot */ });
  }

  /* One agent answered and the next one waiting takes the card: it goes out on its pop and comes
     back with the next name, so an answer never looks like it did nothing. A swap already on its
     way paints whoever is asking when it lands. */
  function swap() {
    var motion = window.PhosphorMotion;
    if (!moves() || typeof motion.leave !== 'function' || typeof motion.enter !== 'function') {
      paint(showing);
      return;
    }
    motion.leave(host, function () {
      if (!showing) return;
      motion.morph(slot, function () { paint(showing); });
      motion.enter(host);
    });
  }

  function show(member) {
    if (!host) {
      var into = slotOf();
      // No conversation to sit in yet: nothing floats, and every move it asks for keeps waiting.
      if (!into) return;
      build(into);
    }
    var fresh = !showing || String(showing.session) !== String(member.session);
    var shown = !host.hidden;
    showing = member;
    if (!fresh) {
      paint(member);
      return;
    }
    say('');
    arm();
    announce();
    if (shown) {
      swap();
      return;
    }
    paint(member);
    dom.setHidden(slot, false);
    host.hidden = false;
    size(true);
  }

  function hide() {
    showing = null;
    if (!host || host.hidden) return;
    host.hidden = true;
    size(false, function () {
      if (host.hidden) dom.setHidden(slot, true);
    });
  }

  function render() {
    var next = asking(store.get() || {});
    if (next) show(next);
    else hide();
  }

  function say(text) {
    if (!refs) return;
    dom.setText(refs.error, text);
    dom.setHidden(refs.error, !text);
  }

  function setPending(button, on) {
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(button, on);
  }

  /* One round trip. The card goes the moment the answer lands, and the next state frame says
     the same; a failure keeps it up with the reason under the facts. */
  function answer(allow, pressed) {
    var member = showing;
    if (!member || !refs || pressed.disabled) return;
    refs.allow.disabled = true;
    refs.later.disabled = true;
    say('');
    setPending(pressed, true);
    api.agentAnswer(member.session, allow)
      .then(function () {
        answered[String(member.session)] = true;
        delete reopened[String(member.session)];
        setPending(pressed, false);
        render();
      })
      .catch(function (err) {
        setPending(pressed, false);
        refs.allow.disabled = false;
        refs.later.disabled = false;
        say(net && typeof net.readable === 'function' ? net.readable(err, true) : 'That did not go through. Try again.');
      });
  }

  /* Its roster row's Change (ui/screens/agent.js): the person asks about an agent they put off,
     and this card asks again, whole, with its warning, its beat and both answers. */
  function reopen(session) {
    var id = String(session);
    delete answered[id];
    reopened[id] = true;
    render();
  }

  window.PhosphorAgentAsk = { boot: boot, asking: asking, reopen: reopen };
})();
