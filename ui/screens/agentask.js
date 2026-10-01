/* The card that asks about an agent started outside Phosphor.

   An agent the app did not start (in a terminal, in another app) takes its
   seat with agent.secret, which any program running as this user can read.
   So until the person allows it here, every move it asks for waits for their
   click (src/agents.ts, src/web-read.ts OUTSIDE_REASON). This card is where
   they allow it: who is asking, in its own words, what it can do now and
   after an Allow, and two answers.

   It floats under the top bar on the right, where the freeze panel opens, so
   it never covers the conversation. It takes nothing from the person: focus
   stays where it was, so a key pressed in the composer never answers it, and
   its buttons hold for a beat after it lands, so a click already on its way
   cannot either. One card at a time, oldest first. The name is the agent's
   own word, drawn as text in quotes and never with a brand's mark: a mark
   would vouch for a name nobody checked. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var api = window.PhosphorApi;
  var net = window.PhosphorNet;

  // A card that lands under a pointer holds its answers this long (decision.js does the same).
  var ARM_MS = 600;

  var host = null;
  var refs = null;
  var showing = null;
  var answered = {};

  function boot() {
    if (!store || typeof store.select !== 'function') return;
    store.select('agents', function () { render(); });
    store.select('policy', function () { if (showing) paint(showing); });
    render();
  }

  /* The oldest agent that is waiting on the person: started outside, able to be allowed (its
     proxy holds a key of its own), not allowed and not put off. */
  function asking(state) {
    var agents = state && state.agents ? state.agents : null;
    var members = agents && Array.isArray(agents.members) ? agents.members : [];
    for (var i = 0; i < members.length; i += 1) {
      var m = members[i];
      if (!m || m.origin !== 'outside' || m.askable !== true || m.allowed === true || m.later === true) continue;
      if (Object.prototype.hasOwnProperty.call(answered, String(m.session))) continue;
      return m;
    }
    return null;
  }

  function limitWords(state) {
    var policy = state && state.policy ? state.policy : null;
    var out = policy && policy.outbound ? policy.outbound : null;
    var ask = out && typeof out.humanClickAboveUsd === 'number' ? out.humanClickAboveUsd : null;
    if (ask === null || !isFinite(ask) || ask <= 0) return 'Small moves run without asking you, like your own assistant\'s.';
    return 'Moves up to ' + dom.usd(ask, ask % 1 === 0 ? 0 : 2) + ' run without asking you, like your own assistant\'s.';
  }

  function build() {
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
    who.appendChild(title);
    who.appendChild(name);
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
    var later = dom.el('button', 'btn btn-quiet');
    later.type = 'button';
    later.appendChild(dom.el('span', 'btn-label', 'Not now'));
    dom.setAttr(later, 'data-pending-label', 'Not now');
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
    document.body.appendChild(host);

    dom.on(later, 'click', function () { answer(false, later); });
    dom.on(allow, 'click', function () { answer(true, allow); });
    // Escape inside the card is Not now: the harmless answer, never Allow.
    dom.on(host, 'keydown', function (event) {
      if (event && event.key === 'Escape') answer(false, later);
    });

    refs = { name: name, then: then, error: error, later: later, allow: allow };
  }

  function paint(member) {
    var state = store.get() || {};
    var called = String(member.client || member.label || 'an agent');
    var at = dom.clock(member.since);
    dom.setText(refs.name, '"' + called + '", started outside Phosphor' + (at ? ' at ' + at : ''));
    dom.setText(refs.then, limitWords(state));
  }

  function arm() {
    refs.allow.disabled = true;
    refs.later.disabled = true;
    window.setTimeout(function () {
      if (!showing) return;
      refs.allow.disabled = false;
      refs.later.disabled = false;
    }, ARM_MS);
  }

  function show(member) {
    if (!host) build();
    var fresh = !showing || showing.session !== member.session;
    showing = member;
    paint(member);
    if (!fresh) return;
    say('');
    arm();
    host.hidden = false;
  }

  function hide() {
    showing = null;
    if (!host || host.hidden) return;
    host.hidden = true;
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

  window.PhosphorAgentAsk = { boot: boot, asking: asking };
})();
