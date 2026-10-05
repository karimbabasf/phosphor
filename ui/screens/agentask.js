/* The card that asks about an agent started outside Phosphor.

   An agent the app did not start (in a terminal, in another app) takes its
   seat with agent.secret, which any program running as this user can read.
   So until the person allows it here, every move it asks for waits for their
   click (src/agents.ts, src/web-read.ts OUTSIDE_REASON). This card is where
   they allow it: which assistant wants to use Phosphor and when it connected,
   what it can do until an Allow and after one, and two answers.

   It sits in the conversation, under the roster it is about, in the slot
   ui/screens/agent.js keeps there (.agent-asks), and takes its place in the
   column's flow: the thread moves down for it, and nothing is covered, not
   the conversation, not the balances, not the freeze panel. It takes nothing
   from the person: focus stays where it was, so a key pressed in the composer
   never answers it, and its buttons hold for a beat after it lands, so a
   click already on its way cannot either. One card at a time, oldest first,
   and it says how many more wait. The name is the agent's own word. The few
   names agents' own MCP clients send (KNOWN) are said plainly, with the
   agent's logo; any other name is drawn as its own text beside the icon set's
   link, never in a title and never with a brand's mark. Either way the card
   says Phosphor can't check the name, so a logo helps the person know their
   own agent and vouches for nothing. Ask each time keeps every move it asks
   for waiting, and the agent's roster row keeps a Change that brings this
   card back (reopen). */
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
  /* The names agents' own MCP clients give in the handshake (clientInfo, src/mcp.ts), and the
     agent each one is, keyed by the catalog's id for its logo (ui/design/marks.js AGENT_LOGOS). */
  var KNOWN = {
    'claude-code': { mark: 'claude', name: 'Claude Code' },
    'claude-ai': { mark: 'desktop', name: 'Claude Desktop' },
    'codex-mcp-client': { mark: 'codex', name: 'Codex' }
  };
  // The proxy's own name, which stands until a client's lands and for a client that sends none.
  var NO_NAME = 'phosphor-mcp';
  var SOMEONE = 'An AI assistant on this Mac';

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

  /* What an Allow changes, with the person's own amount: its first sentence is the one to read.
     An Allow changes what it asks for next, never a move already waiting (src/agents.ts allow).
     At $0 the rules ask before every move whoever proposes it (src/policy/engine.ts), so then an
     Allow lets nothing run on its own, and the card says so. */
  function allowWords(state) {
    var policy = state && state.policy ? state.policy : null;
    var out = policy && policy.outbound ? policy.outbound : null;
    var ask = out && typeof out.humanClickAboveUsd === 'number' && isFinite(out.humanClickAboveUsd) ? out.humanClickAboveUsd : null;
    var rest = ' Phosphor\'s own chat works the same way. Moves it already asked for still wait for your OK.';
    if (ask === 0) return { key: 'Every move still waits for your OK.', rest: ' Your rules ask you before every move, from any agent.' };
    if (ask === null || ask < 0) return { key: 'Small moves run without asking you.', rest: rest };
    return { key: 'Moves up to ' + dom.usd(ask, ask % 1 === 0 ? 0 : 2) + ' run without asking you.', rest: rest };
  }

  /* Who is asking, as the card says it: a name it knows with that agent's logo; any other name
     as the agent's own word, beside the link; or no name at all. */
  function whoIs(member) {
    var said = String(member.client || member.label || '').trim();
    var key = said.toLowerCase();
    if (own(KNOWN, key)) return { mark: KNOWN[key].mark, name: KNOWN[key].name, said: '' };
    return { mark: 'mcp', name: '', said: key === NO_NAME ? '' : said };
  }

  function titleOf(who) {
    return (who.name || SOMEONE) + ' wants to use Phosphor';
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
    host.setAttribute('aria-describedby', 'agent-ask-line agent-ask-now');
    host.setAttribute('data-motion', 'pop');
    host.hidden = true;

    /* The head says what is happening in one line: the agent's logo or the link, then
       "Claude Code wants to use Phosphor", and under it what it is and when it connected. */
    var head = dom.el('div', 'agent-ask-head');
    var mark = dom.el('span', 'agent-ask-mark');
    mark.setAttribute('aria-hidden', 'true');
    var who = dom.el('div', 'agent-ask-who');
    var title = dom.el('h2', 'agent-ask-title');
    title.id = 'agent-ask-title';
    var line = dom.el('p', 'agent-ask-line');
    line.id = 'agent-ask-line';
    var lead = dom.el('span', '');
    var said = dom.el('span', 'agent-ask-said');
    var when = dom.el('span', '');
    line.appendChild(lead);
    line.appendChild(said);
    line.appendChild(when);
    who.appendChild(title);
    who.appendChild(line);
    head.appendChild(mark);
    head.appendChild(who);

    // What each answer means, label over its words; the sentence to read first is the brighter one.
    var body = dom.el('div', 'agent-ask-body');
    var facts = dom.el('dl', 'agent-ask-facts');
    var nowRow = dom.el('div', 'agent-ask-fact');
    nowRow.appendChild(dom.el('dt', '', 'Until you allow it'));
    var now = dom.el('dd', '');
    now.id = 'agent-ask-now';
    now.appendChild(dom.el('span', 'agent-ask-key', 'Every move it asks for waits for your OK.'));
    now.appendChild(dom.el('span', '', ' It can read your wallet.'));
    nowRow.appendChild(now);
    var thenRow = dom.el('div', 'agent-ask-fact');
    thenRow.appendChild(dom.el('dt', '', 'If you allow it'));
    var then = dom.el('dd', '');
    var thenKey = dom.el('span', 'agent-ask-key');
    var thenRest = dom.el('span', '');
    then.appendChild(thenKey);
    then.appendChild(thenRest);
    thenRow.appendChild(then);
    facts.appendChild(nowRow);
    facts.appendChild(thenRow);

    var note = dom.el('p', 'agent-ask-note', 'Only allow an agent you started yourself. Phosphor can\'t check its name or see what it reads elsewhere.');
    var error = dom.el('p', 'agent-ask-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    // How many more wait at the left, the answers at the right edge, as on a move card.
    var bar = dom.el('div', 'agent-ask-bar');
    var more = dom.el('p', 'agent-ask-more');
    more.hidden = true;
    var actions = dom.el('div', 'agent-ask-actions');
    // The harmless answer, named for what it does: every move this agent asks for waits.
    var later = dom.el('button', 'btn btn-ghost');
    later.type = 'button';
    later.appendChild(dom.el('span', 'btn-label', 'Ask each time'));
    dom.setAttr(later, 'data-pending-label', 'Ask each time');
    var allow = dom.el('button', 'btn btn-primary');
    allow.type = 'button';
    allow.appendChild(dom.el('span', 'btn-label', 'Allow'));
    dom.setAttr(allow, 'data-pending-label', 'Allowing');
    actions.appendChild(later);
    actions.appendChild(allow);
    bar.appendChild(more);
    bar.appendChild(actions);

    body.appendChild(facts);
    body.appendChild(note);
    body.appendChild(error);
    body.appendChild(bar);
    host.appendChild(head);
    host.appendChild(body);
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

    refs = { mark: mark, title: title, lead: lead, said: said, when: when, thenKey: thenKey, thenRest: thenRest, more: more, error: error, later: later, allow: allow };
  }

  /* The logo, drawn again only when the agent it shows changes: the proxy's own name stands for
     a beat before the client's lands (src/mcp.ts clientName), and then the card turns into it. */
  function paintMark(id) {
    if (refs.mark.__agent === id) return;
    dom.clear(refs.mark);
    var marks = window.PhosphorMarks;
    var icons = window.PhosphorIcons;
    if (id !== 'mcp' && marks && typeof marks.agent === 'function') {
      refs.mark.appendChild(marks.agent(id, 40));
    } else if (icons && typeof icons.svg === 'function') {
      refs.mark.appendChild(icons.svg('link'));
    }
    dom.setAttr(refs.mark, 'data-agent', id);
    refs.mark.__agent = id;
  }

  function paint(member) {
    var state = store.get() || {};
    var who = whoIs(member);
    var at = dom.clock(member.since);
    paintMark(who.mark);
    dom.setText(refs.title, titleOf(who));
    dom.setText(refs.lead, who.name ? SOMEONE : (who.said ? 'It calls itself ' : 'It gave no name'));
    dom.setText(refs.said, who.said);
    dom.setHidden(refs.said, !who.said);
    // No-break spaces: a narrow line breaks after the dot, never before it or inside "connected at 07:43".
    dom.setText(refs.when, at ? ' · connected at ' + at : '');
    var words = allowWords(state);
    dom.setText(refs.thenKey, words.key);
    dom.setText(refs.thenRest, words.rest);
    var others = waiting(state).filter(function (m) { return String(m.session) !== String(member.session); }).length;
    dom.setText(refs.more, others === 1 ? '1 more agent is waiting' : others + ' more agents are waiting');
    dom.setHidden(refs.more, others === 0);
  }

  /* The answers are held for a beat after the card lands, at full strength: a hollow key that
     filled in a moment later read as a flicker on a card that had only just arrived. */
  function arm() {
    var mine = (armed += 1);
    refs.allow.disabled = true;
    refs.later.disabled = true;
    dom.setAttr(host, 'data-arming', 'true');
    window.setTimeout(function () {
      if (!showing || mine !== armed) return;
      refs.allow.disabled = false;
      refs.later.disabled = false;
      dom.setAttr(host, 'data-arming', null);
    }, ARM_MS);
  }

  /* Said again for every agent that asks, in the card's own head line: emptied first, so the
     same sentence is news again. */
  function announce() {
    dom.setText(live, '');
    window.setTimeout(function () {
      if (showing) dom.setText(live, titleOf(whoIs(showing)) + '.');
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
