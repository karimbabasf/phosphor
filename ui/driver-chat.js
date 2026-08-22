/* driver-chat.js: the agent panel, shared by the pro, trade and basic windows.
 *
 * ONE job: let a person start an agent, talk to it, and stop it, without leaving the app.
 * It is deliberately not a terminal emulator and not a log viewer. The log is the record and
 * it lives behind its own button; this is the conversation, and the two were previously the
 * same rectangle.
 *
 * FOUR PHASES, and the root carries the current one in data-phase so the two stylesheets can
 * dress each of them in their own language without this file knowing which screen it is on:
 *
 *   idle      no agent. The globe turns, and the whole layer is one button that starts one.
 *   booting   the intro card prints while the child process comes up. No input box yet: there
 *             is nothing on the other end of it to read what gets typed.
 *   live      the transcript and the prompt box. This is the phase the panel exists for.
 *   closing   the stop was confirmed. The panel is taken apart on screen and comes back idle.
 *
 * THE SAME GLOBE, TWICE, ANSWERING TWO QUESTIONS. ui/agent-globe.js draws both of them.
 * The big one fills the idle phase and says NO AGENT IS RUNNING HERE, which is why the whole
 * layer around it is the button that starts one. The badge is forty pixels in the corner of a
 * booting or live panel and says THIS PANEL'S DRIVER IS UP, plus how hard it is working, and
 * it says it without a word: quick and bright while the agent writes, slow and dim while it
 * waits. There is no third setting. A stopped agent is not a dull badge, it is the big globe.
 * They are never on screen together and exactly one of them is ever turning; setGlobes below
 * is the only function allowed to touch either.
 *
 * NEITHER OF THEM IS THE SEAT LIGHT. #agent-orb in the pro and trade status bar is a filled
 * ball, and it is lit whenever ANY agent holds the MCP seat, including one running in a
 * terminal this window never started (ui/presence.js). Both globes here are wireframe, both
 * sit inside the panel, and both know about exactly one process: the driver this panel owns.
 *
 * THE RULE THAT DOES NOT BEND. Every string this file puts on screen is agent-authored or
 * human-authored text, and it reaches the DOM through textContent, never innerHTML. That is
 * the same rule app.js states in its own header and it matters more here than anywhere else:
 * this is the one surface whose entire content is written by a language model that reads
 * token names and web-shaped text. A single innerHTML in this file would turn the panel into
 * a script-injection surface inside a window that holds an approval button.
 *
 * WHAT IS NOT HERE. No approval. The panel cannot approve, refuse, or arm anything, and it
 * never renders a control that does. When the agent proposes, the approval surface appears
 * where it has always appeared, and a person clicks it there. The conversation and the
 * consent are separate on purpose: an approval button inside a scrolling transcript authored
 * by the thing being approved is precisely the design this whole app exists to argue against.
 *
 * TWO STOPS, AND THEY ARE NOT THE SAME CONTROL. "STOP AGENT" ends the session: the process
 * goes, the conversation goes, and none of it can be got back from this window, so it asks
 * first and the second press is not the one under the cursor. "STOP" ends the ANSWER: the
 * turn in flight is cancelled and everything else stays. It asks nothing and costs one press,
 * because the thing it competes with is waiting, and a cheap stop that costs two presses is
 * one nobody uses. A human should never have to reach for the destructive one to get the
 * cheap one. */

'use strict';

var PhosphorChat = (function () {
  var TRANSCRIPT_MAX = 400;
  /* How close to the bottom still counts as reading the newest line. One row of slack, so a
     panel that is a pixel off the end from a fractional scroll is still pinned. */
  var PIN_SLACK = 44;
  var INTRO_STEP_MS = 130; // between intro lines; the whole print is under a second

  var mounts = [];
  var token = '';

  /* THE OPEN CONVERSATIONS, and why this file now holds a list rather than a state.
   *
   * A mount is a PANEL: the pro window, the trade window and the basic screen each register
   * one, and all three have always shown the same conversation. A chat is a CONVERSATION: its
   * own agent process, its own transcript, its own place on the roster in src/agents.ts. Those
   * were the same thing until 2026-08-21 and they are not the same thing any more.
   *
   * So the panel gained a tab strip and one plus. The mounts still all show whichever chat is
   * in front, which is the property that keeps the three windows agreeing with each other; the
   * strip is how a person changes which one that is.
   *
   * The transcripts are cached here as well as on the server, and the reason is the switch. A
   * person clicking a tab is not waiting for a round trip, and a refetch on every click would
   * make the cheapest control in the panel the slowest. The server stays the truth: refresh()
   * takes it whole whenever the SET of chats changes, and push() only ever appends. */
  /* Seeded with ONE conversation that has no id yet, which is exactly what the server answers
     with when nothing is running (see driverPayload in src/server.ts). It is what keeps a panel
     usable before the first refresh lands, and it is the same shape the single-seat window
     always had: one chat, no process behind it, and the globe as the way to start one. The empty
     id is what a POST carries until a real chat exists, and the server reads it as "the first
     one" rather than as a name it does not know. */
  var chats = [{ id: '', label: 'AGENT 1', state: 'off', transcript: [], unread: false }];
  var activeId = '';
  /* Overwritten by the first refresh. It is the server that decides how many agents may run,
     because it is the server that pays for them and holds the roster they join. */
  var maxChats = 4;

  function chatOf(id) {
    for (var i = 0; i < chats.length; i++) if (chats[i].id === id) return chats[i];
    return null;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Fetched on demand rather than only at boot. The token arrives from a second request, and
     a person who presses start in the moment between the page painting and that request
     landing would otherwise get a 403 for doing nothing wrong. */
  function withToken() {
    if (token) return Promise.resolve(token);
    return fetch('/api/session')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        token = json.token || '';
        return token;
      });
  }

  /* Every request names the conversation it is for, and the server refuses a name it does not
     know rather than falling back to the first chat. A sentence typed into one agent arriving
     at a different one is the failure this parameter exists to prevent, and it is the kind that
     is only noticed after the wrong agent has acted on it. */
  function api(body) {
    return withToken()
      .then(function (current) {
        return fetch('/api/driver', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ token: current, chat: activeId }, body)),
        });
      })
      .then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error(json && json.error ? json.error : 'request failed');
          return json;
        });
      });
  }

  /* WHAT THE AGENT IS DOING, IN WORDS. One phrase per tool, and this table is the whole of
     it: no template, no argument interpolation, no sentence built at runtime.

     The transcript used to print the tool id, which meant a person watching their own money
     being worked on read `chart_set_view` and `propose_intents_withdraw`. Those are the names
     of functions. The line beside them says "ran", so a phrase completes it: "ran changing
     the chart".

     TWO RULES THE PHRASES KEEP.
     - Present tense and no numbers. The row is one line in a moving transcript, not a
       receipt; what actually happened is in the panel the tool changed and in the LOG.
     - A propose_* tool ASKS. It moves nothing, and its phrase may never suggest it did: the
       thing it produced is a pending proposal sitting in the gate waiting for a human. The
       pairs below are deliberately one word apart for that reason ("asking to swap" against
       "swapping"), because that word is the entire difference between them.

     An id with no entry falls through to the id itself with the server prefix stripped, which
     is what every line looked like before. A new tool prints its own name until somebody
     writes it a phrase; it does not print nothing, and it does not get a guessed one. */
  var TOOL_PHRASES = {
    /* reading */
    balances: 'reading your balances',
    wallet: 'reading your wallet',
    composition: 'checking what you hold',
    candles: 'reading prices',
    policy_show: 'reading the policy',
    proposal_status: 'checking the approval',
    market_search: 'looking up a market',
    /* The one tool that leaves this machine, and the line says so. A person watching their
       wallet app reach the internet is entitled to see that happen in words. */
    research: 'reading the news',
    indicator_catalog: 'checking the indicators',
    mandate_catalog: 'checking the mandates',
    skill: 'reading its instructions',
    trade_read: 'reading the account',
    /* the chart */
    chart_read: 'reading the chart',
    chart_measure: 'measuring the chart',
    chart_scan: 'scanning the timeframes',
    chart_set_view: 'changing the chart',
    chart_add_indicator: 'adding an indicator',
    chart_level: 'drawing a level',
    chart_mark: 'marking the chart',
    chart_trendline: 'drawing a trendline',
    chart_batch: 'redrawing the chart',
    /* the trading window */
    trade_focus: 'focusing a market',
    trade_highlight: 'highlighting the chart',
    trade_overlay: 'drawing on the chart',
    trade_note: 'leaving a note',
    trade_batch: 'redrawing the account',
    /* asking. None of these moves anything: each one puts a proposal in the gate. */
    propose_consolidate: 'asking to consolidate',
    propose_swap: 'asking to swap',
    propose_intents_deposit: 'asking to deposit',
    propose_intents_withdraw: 'asking to withdraw',
    propose_mandate: 'asking to arm a mandate',
    /* doing, once a human has said yes */
    consolidate: 'consolidating',
    swap: 'swapping',
    intents_deposit: 'depositing',
    intents_withdraw: 'withdrawing',
    mandate_arm: 'arming a mandate',
    /* the window itself */
    switch: 'switching the screen',
    watch: 'changing the coins you watch',
    start: 'starting up',
  };

  /* A tool call is the honest unit of "what the agent actually did", so it is rendered as its
     own line rather than folded into prose. The name is stripped of the mcp__phosphor__
     prefix because a person reading this does not need to be told, forty times, which server
     it came from: they are looking at that server. */
  function toolLabel(name) {
    var id = String(name || 'tool').replace(/^mcp__phosphor__/, '');
    var phrase = TOOL_PHRASES[id];
    /* typeof, not truthiness: the tool id arrives from a language model, and a lookup on a
       plain object hands back Object.prototype's own members for ids like `constructor` or
       `toString`. A function stringified into the transcript is not a phrase. */
    return typeof phrase === 'string' ? phrase : id;
  }

  /* This panel is not a markdown renderer and is never going to be one: rendering
     model-authored markup is how a transcript becomes a place where links and images can be
     drawn, in a window that holds an approval button. But the model writes markdown anyway,
     so a screen built for somebody non-technical was printing `**off**` and a stray fence
     line as if they were words.

     So the MARKERS are taken off and the TEXT is kept, as text. Nothing here produces a node,
     an attribute or a URL: the result still goes to the DOM through textContent like every
     other string in this file. Deliberately small, and deliberately not a parser. */
  function plain(text) {
    return String(text === undefined || text === null ? '' : text)
      // A fence on its own line, with or without a language after it.
      .replace(/^[ \t]*```[^\n]*\n?/gm, '')
      // Bold and italic, both spellings. The inner text is kept exactly as written.
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      // Inline code. Backticks only, never a span: see above.
      .replace(/`([^`\n]+)`/g, '$1')
      // A fence that was alone on its line leaves the blank line it stood on.
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  /* THE FIGURES ARE THE POINT, so the figures are lit.
     An agent answer here is not prose with numbers in it, it is numbers with prose holding
     them together: "ETH-USD on the 15 minute with EMA(21) drawn. Last 2293.5, EMA at 2272.58
     and rising, price 0.92% above it." Rendered flat, a person has to read the sentence to
     find the three things they actually wanted, every time. Lit, they can take the figure at
     a glance and read the sentence only if it surprises them. That is what a terminal is FOR,
     and this app had been throwing it away on the one surface where a model does the talking.

     Four kinds, and no more: money, percentages, bare numbers, and instrument names. Anything
     cleverer starts guessing, and a highlight on the wrong word is worse than none.

     STILL textContent, every piece. This builds element nodes and sets their text; no string
     on this path is ever parsed as markup, which is the rule the whole file is written to. */
  var FIGURE = /(\$[\d,]+(?:\.\d+)?|[+-]?\d[\d,]*\.?\d*%|\b[A-Z]{2,6}-[A-Z]{2,6}\b|\b[A-Z]{2,5}\b(?=\s|[.,)]|$)|\b\d[\d,]*(?:\.\d+)?\b)/g;

  function litText(cls, body) {
    var node = el('span', cls);
    var last = 0;
    var m;
    FIGURE.lastIndex = 0;
    while ((m = FIGURE.exec(body)) !== null) {
      /* A zero-length match would spin here forever. It cannot happen with this pattern and
         the guard costs one line, which is the right price for a loop in a render path. */
      if (m.index === FIGURE.lastIndex) { FIGURE.lastIndex += 1; continue; }
      if (m.index > last) node.appendChild(document.createTextNode(body.slice(last, m.index)));
      node.appendChild(el('b', 'chat-fig', m[0]));
      last = m.index + m[0].length;
    }
    if (last < body.length) node.appendChild(document.createTextNode(body.slice(last)));
    return node;
  }

  function renderEvent(list, event) {
    var row = null;
    if (event.kind === 'said') {
      row = el('div', 'chat-row chat-said');
      row.appendChild(el('span', 'chat-who', 'you'));
      row.appendChild(el('span', 'chat-text', event.text));
    } else if (event.kind === 'text') {
      var body = plain(event.text);
      if (body === '') return; /* a turn that was nothing but a fence is not a message */
      row = el('div', 'chat-row chat-agent');
      row.appendChild(el('span', 'chat-who', 'agent'));
      row.appendChild(litText('chat-text', body));
    } else if (event.kind === 'tool') {
      /* A tool call is a thing happening, not a thing said, so it is drawn as a mark and a
         phrase rather than as another line of conversation. The mark is what makes a run of
         them read as a list of work: four dim rows with a column of blocks down the left is
         a machine doing things, and four dim rows without it is a paragraph nobody reads. */
      row = el('div', 'chat-row chat-tool');
      row.appendChild(el('span', 'chat-who', '\u25AA'));
      row.appendChild(el('span', 'chat-text', toolLabel(event.name)));
    } else if (event.kind === 'tool_result') {
      return; /* The result is visible in the app's own state. A second line saying it
                 returned is noise in a transcript a person is reading to follow a
                 conversation. */
    } else if (event.kind === 'error') {
      row = el('div', 'chat-row chat-error');
      row.appendChild(el('span', 'chat-who', 'stopped'));
      row.appendChild(el('span', 'chat-text', event.message));
    } else if (event.kind === 'boot') {
      row = el('div', 'chat-row chat-boot');
      row.appendChild(el('span', 'chat-who', ''));
      row.appendChild(el('span', 'chat-text', event.text));
    } else if (event.kind === 'status') {
      /* A state with nothing to add is already on screen: the bar prints the state word, and
         while the intro is running a second line saying "starting" lands in the middle of it.
         A state that carries a detail is different, because the detail is the only place that
         sentence is ever shown (a lockdown that failed, tools still attaching). */
      if (!event.detail) return;
      row = el('div', 'chat-row chat-status');
      row.appendChild(el('span', 'chat-who', ''));
      row.appendChild(el('span', 'chat-text', event.detail || event.state));
    } else {
      return;
    }
    list.appendChild(row);
    while (list.childElementCount > TRANSCRIPT_MAX) list.removeChild(list.firstChild);
    return row;
  }

  /* ---------- scrolling ----------
     A chat that does not follow its own newest line is a chat nobody can use while the agent
     works. It follows by default and keeps following, and the ONLY thing that detaches it is
     the reader deliberately scrolling up: yanking the view back down while somebody is
     reading three messages up is the other way this panel becomes unusable. When it is
     detached there is a button that says so and puts it back, so "it is stuck up there" is
     never a state a person has to solve by hand. */

  function atBottom(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight < PIN_SLACK;
  }

  function toBottom(mount) {
    mount.pinned = true;
    mount.list.scrollTop = mount.list.scrollHeight;
    mount.jump.hidden = true;
  }

  function follow(mount) {
    if (mount.pinned) {
      mount.list.scrollTop = mount.list.scrollHeight;
      mount.jump.hidden = true;
    } else {
      mount.jump.hidden = false;
    }
  }

  /* ---------- the intro ----------
     A boot print, not a loading spinner. Every fact in it is a true statement about the agent
     being started, checked against operator/driver.settings.json and against assertSurface in
     src/driver.ts: the timing is cosmetic, the content is not.

     ONE CARD, NOT FOUR LINES. Printed as rows it was four lonely sentences floating over the
     box you type in, and there is no width to write four sentences for: ui/split.js lets a
     person drag this panel from 240 pixels to half the window and back, continuously. So the
     print is one object with a header, a bar that fills as the link is made, and the facts as
     a definition list. Each fact is its own flex row that wraps, so the value sits beside its
     label when there is room and drops under it when there is not, and THAT WRAP IS THE WHOLE
     RESPONSIVE STORY. No media query and no container query is any use here: a drag does not
     stop at the breakpoints, and a card that changed shape at one would snap in the middle of
     the gesture. The frame is drawn in CSS borders for the same reason: box-drawing characters
     hold a rectangle at exactly one column count and break at every other.

     THE PLAIN ARRAY STILL PRINTS, and it is not a legacy path. A panel that can only render a
     card is a panel nobody can drive with a line of text, and both the test harness and anyone
     poking at this from a console hand it three strings.

     IT IS ALLOWED TO FINISH. The driver reports ready on the child's spawn event, which lands
     in a few tens of milliseconds, so cutting the print off at ready meant one line of it was
     ever seen. Ready arriving mid-print is remembered instead, and the last step hands over.
     Four steps at 130ms is half a second, which is a beat and not a wait, and nothing is held
     back by it: the box a person types into opens the moment the print ends, and the child has
     been up the whole time. */

  /* Two shapes in, one shape out. The card is what the three windows mount; a plain array is
     the fallback above. Anything else, including an empty card, falls back to one true line. */
  function normalizeIntro(intro) {
    if (typeof intro === 'string') return { lines: [intro] };
    if (Array.isArray(intro)) return { lines: intro.slice() };
    if (intro && intro.facts && intro.facts.length) {
      return { mark: intro.mark || '', title: intro.title || '', facts: intro.facts.slice() };
    }
    return { lines: ['starting a local agent'] };
  }

  /* The card, built once and revealed a fact at a time. Every string here goes in through
     el()'s textContent like every other string in this file: the card is a shape, not a
     document, and nothing it renders came from the agent. */
  function introCard(spec) {
    var card = el('div', 'chat-intro');

    var head = el('div', 'chat-intro-head');
    head.appendChild(el('span', 'chat-intro-mark', spec.mark));
    // The elastic piece. It is a border in CSS, so it fills whatever is left at any width.
    head.appendChild(el('span', 'chat-intro-rule'));
    head.appendChild(el('span', 'chat-intro-title', spec.title));
    card.appendChild(head);

    var track = el('div', 'chat-intro-track');
    var fill = el('span', 'chat-intro-fill');
    /* Clipped from the right rather than sized, because a width animation is a layout
       animation and this one runs while rows are landing next to it. */
    fill.style.clipPath = 'inset(0 100% 0 0)';
    track.appendChild(fill);
    card.appendChild(track);

    var facts = el('dl', 'chat-intro-facts');
    var rows = [];
    for (var i = 0; i < spec.facts.length; i++) {
      var row = el('div', 'chat-intro-fact');
      row.appendChild(el('dt', 'chat-intro-label', spec.facts[i].label));
      row.appendChild(el('dd', 'chat-intro-value', spec.facts[i].value));
      facts.appendChild(row);
      rows.push(row);
    }
    card.appendChild(facts);

    return { node: card, fill: fill, rows: rows };
  }

  /* One thunk per beat, so the timer below does not care which shape it is printing. The card
     lands on the first beat and a fact on each one after it, which is the same four beats the
     four lines used to take. */
  function introSteps(mount) {
    var spec = mount.intro;
    var steps = [];
    var i;
    if (spec.lines) {
      for (i = 0; i < spec.lines.length; i++) {
        steps.push((function (line) {
          return function () { renderEvent(mount.list, { kind: 'boot', text: line }); };
        })(spec.lines[i]));
      }
      return steps;
    }
    var card = introCard(spec);
    steps.push(function () { mount.list.appendChild(card.node); });
    for (i = 0; i < card.rows.length; i++) {
      steps.push((function (row, done) {
        return function () {
          row.setAttribute('data-in', '1');
          card.fill.style.clipPath = 'inset(0 ' + (100 - Math.round((done / card.rows.length) * 100)) + '% 0 0)';
        };
      })(card.rows[i], i + 1));
    }
    return steps;
  }

  function printIntro(mount) {
    stopIntro(mount);
    var steps = introSteps(mount);
    var i = 0;
    function step() {
      if (mount.phase !== 'booting') {
        mount.introTimer = 0;
        return;
      }
      if (i >= steps.length) {
        mount.introTimer = 0;
        if (mount.liveWhenPrinted) goLive(mount);
        return;
      }
      steps[i]();
      follow(mount);
      i += 1;
      mount.introTimer = setTimeout(step, INTRO_STEP_MS);
    }
    step();
  }

  function stopIntro(mount) {
    if (mount.introTimer) clearTimeout(mount.introTimer);
    mount.introTimer = 0;
  }

  /* The one door from booting into live, so the intro's last line and a status event reach it
     the same way. Focus lands in the box here and nowhere else: the whole point of the globe
     having been pressed is that a person wants to say something. */
  function goLive(mount) {
    mount.liveWhenPrinted = false;
    setPhase(mount, 'live');
    toBottom(mount);
    try { mount.input.focus(); } catch (err) {}
  }

  /* ---------- the two globes ----------

     WHAT THE BADGE SAYS, PER DRIVER STATE. It is a status light, so it says everything with
     two numbers: how fast it turns and how loud it is. `thinking` is the one it exists for,
     and it is the only state that is unmistakably ALIVE at a glance from across a desk.
     `gain` multiplies whatever the surface asked for at mount, so the calm screen's louder
     globe stays the louder one in every state.

     THREE STATES AND NO FOURTH, AND THE MISSING ONE IS DELIBERATE. The badge used to carry a
     dull, still setting for `stopped`, `off` and `failed`, and nobody could ever have seen it:
     all three send the panel to idle, where the badge is hidden and the big globe is the whole
     answer. So the badge is a light for a running driver and nothing else. "No agent" is said
     once, by a globe that fills the panel and asks to be pressed, and a second quieter version
     of the same sentence in the corner is worse than one answer: a reader who finds both has
     to work out which of them is current.
     These three are also exactly the states that can outlive a setGlobes call while the panel
     is lit, because setState sends every other one to idle before it returns. */
  var BADGE_DRIVE = {
    thinking: { rate: 2.4, gain: 1.5 },
    starting: { rate: 1.7, gain: 1 },
    ready: { rate: 0.5, gain: 0.8 },
  };

  /* EXACTLY ONE GLOBE TURNS, and this is the only function that starts or stops either. The
     idle globe is the whole panel; the badge is forty pixels of the live one. They are never
     on screen together, and two rAF loops on one panel is a battery bill nobody can see.
     It is written as stop-the-other-first-then-start-the-one rather than as a check afterwards
     because the two are woken by different events (a phase change and a driver state change),
     and an invariant that depends on the order those arrive in is not an invariant. */
  function setGlobes(mount) {
    var idle = mount.phase === 'idle';
    var lit = mount.phase === 'booting' || mount.phase === 'live';
    mount.badge.hidden = !lit;

    if (idle) {
      mount.badgeOrb.stop();
      mount.orb.start();
      return;
    }
    mount.orb.stop();
    if (!lit) {
      mount.badgeOrb.stop();
      return;
    }
    /* A state with no setting means a driver that is gone, which under a lit panel is the one
       tick between that news arriving and setState landing the panel on the globe. Nothing is
       drawn for it: the badge is already on its way off the screen, and a frame held in a
       corner about to be hidden is a frame nobody sees.
       typeof, not truthiness, for the reason toolLabel gives above: the state is a string off
       the wire, and a lookup on a plain object hands back Object.prototype's own members for
       one named `constructor`. */
    var drive = BADGE_DRIVE[mount.driverState];
    if (!drive || typeof drive.rate !== 'number') {
      mount.badgeOrb.stop();
      return;
    }
    mount.badgeOrb.tune(drive);
    mount.badgeOrb.start();
  }

  /* ---------- phases ---------- */

  /* NO PHASE MAY STRAND. Karim, 2026-08-20: "once i stop the agent it doesnt quit it and show
     the globe like I wanted, it simply just removes the text input bar."
     That is this panel with no way out of a transient phase, and both of them had the same
     hole. `closing` hands the return to the globe to an animation callback, so a veil that
     never fires its action leaves the form hidden, the globe hidden and a dead transcript on
     screen, which is exactly the description. `booting` waits for a status that arrives over
     the event stream, so a stream that dropped between the press and the answer leaves the
     intro printed and nothing else, which looks the same.
     Neither is worth diagnosing while a person is standing in front of it. Each transient
     phase now carries its own deadline, and when it passes the panel lands on the globe: the
     one state anybody can act from. The veil still owns the landing when it works, and this
     only ever fires when it did not.
     closing is comfortably past the fall's own run (520ms cover, then the mode change).
     booting is long because it is waiting on a process to spawn, and a false alarm there
     would take a working session off the screen. */
  var LAND_MS = { closing: 1400, booting: 30000 };
  var LAND_REASON = {
    closing: '',
    booting: 'the agent did not come up',
  };

  function setPhase(mount, next) {
    if (mount.phase === next) return;
    mount.phase = next;
    mount.root.setAttribute('data-phase', next);

    /* Armed on the way in and cleared on the way out, so a phase that ends normally never
       leaves a timer behind to fire at the next one. idle() re-enters this function, which is
       what clears the timer that called it. */
    if (mount.landTimer) {
      clearTimeout(mount.landTimer);
      mount.landTimer = 0;
    }
    if (LAND_MS[next]) {
      mount.landTimer = setTimeout(function () {
        mount.landTimer = 0;
        if (mount.phase !== next) return;
        mount.reason = mount.reason || LAND_REASON[next];
        idle(mount);
      }, LAND_MS[next]);
    }

    var live = next === 'live';
    mount.form.hidden = !live;
    mount.bar.hidden = !live;
    mount.globe.hidden = next !== 'idle';
    mount.list.hidden = next === 'idle';
    if (next !== 'live') closeConfirm(mount);
    if (next !== 'booting') {
      stopIntro(mount);
      // Nothing queued behind an intro that is no longer running.
      if (next !== 'live') mount.liveWhenPrinted = false;
    }

    if (next === 'idle') mount.jump.hidden = true;
    setGlobes(mount);
  }

  function setState(mount, next, detail) {
    mount.root.setAttribute('data-driver-state', next);
    /* Read by setGlobes, and set before anything below can change the phase, so the badge is
       never a state behind the word beside it. */
    mount.driverState = next;
    setGlobes(mount);
    mount.status.textContent =
      next === 'thinking' ? 'working' : next === 'starting' ? 'connecting' : detail ? detail : next;
    // There is an answer to stop only while one is being written.
    mount.halt.disabled = next !== 'thinking';

    if (next === 'starting') {
      if (mount.phase !== 'booting') {
        setPhase(mount, 'booting');
        printIntro(mount);
      }
      return;
    }
    if (next === 'ready' || next === 'thinking') {
      if (mount.phase === 'booting') {
        // Still printing: the last line will open the box. Otherwise open it now.
        if (mount.introTimer) mount.liveWhenPrinted = true;
        else goLive(mount);
        return;
      }
      setPhase(mount, 'live');
      return;
    }
    if (next === 'failed') {
      mount.liveWhenPrinted = false;
      mount.reason = detail || 'the agent stopped';
      if (mount.phase !== 'closing') idle(mount);
      return;
    }
    // off and stopped
    if (mount.phase !== 'closing') idle(mount);
  }

  /* Back to the globe. The transcript is cleared with it: a dead conversation left on screen
     under a "start" control reads as a live one, and the record of what the agent did is in
     the audit log behind the LOG button, which is where anyone should read it. */
  function idle(mount) {
    setPhase(mount, 'idle');
    mount.list.textContent = '';
    mount.sub.textContent = mount.reason || mount.idleNote;
    mount.pinned = true;
  }

  /* ---------- stopping ----------
     Two presses. The confirm is a real control rather than window.confirm, because a native
     dialog is the easiest thing on any of these screens to dismiss by reflex, and what is
     behind this one is a conversation that cannot be got back. */

  /* THE QUESTION LIVES INSIDE THE THING THIS USED TO HIDE. Karim, twice, 2026-08-20: "when i
     click stop agent this is what happens, it doesnt terminate the agent, it jsut removes the
     text box and there is nothing I can do."
     This hid `form`, and the ONE BOX refactor earlier the same day had moved the bar inside the
     form to give the composer a single border. So confirm sits at form > bar > confirm, and
     hiding the form hid the question, both answers, and every way back. The agent kept running
     because YES was never clickable, so the stop was never sent: the audit log has no stopped
     line at all for those attempts, which is what proves the press never reached the server
     rather than failing there.
     It hides the INPUT now. That was the whole intent: a text box invited to be typed in while
     a destructive question is standing is the thing worth taking away, and the question is not.
     The cheap stop and SEND go with it, because neither has anything to do while the panel is
     asking whether to end the session.

     Every test drove `chat-confirm-yes` by firing a click straight at the node, and a click
     fired at a node inside a hidden parent still runs its handler, so the suite could not see
     this. The test added beside them walks the ancestors instead. */
  function openConfirm(mount) {
    mount.confirm.hidden = false;
    mount.stopBtn.hidden = true;
    mount.input.hidden = true;
    mount.send.hidden = true;
    mount.halt.hidden = true;
    try { mount.no.focus(); } catch (err) {}
  }

  function closeConfirm(mount) {
    mount.confirm.hidden = true;
    mount.stopBtn.hidden = false;
    mount.input.hidden = false;
    mount.send.hidden = false;
    mount.halt.hidden = false;
  }

  /* Stop this answer, keep the conversation. One press, no question, and not awaited: the
     turn is either already being cancelled or there was nothing to cancel, and either way the
     line that says so comes back down the event stream as a status with a detail, which the
     transcript already knows how to print. Disabled on the way out so the press reads as
     having landed before the server has said anything. */
  function haltTurn(mount) {
    if (mount.halt.disabled) return;
    mount.halt.disabled = true;
    api({ action: 'interrupt' }).catch(function () {});
  }

  /* The teardown, on screen. Pro and trade fall apart into the character rain that already
     carries every other change on those surfaces; basic dissolves, because an ASCII waterfall
     on the calm screen is the terminal leaking into the one place that may never look like
     one. Both run the same swap: cover, change underneath, reveal. */
  function closeWithVeil(mount) {
    setPhase(mount, 'closing');
    var apply = function () {
      mount.reason = '';
      idle(mount);
    };
    if (mount.veil === 'rain' && window.PHOSPHOR_RAIN) {
      window.PHOSPHOR_RAIN.swap(apply, mount.stage);
      return;
    }
    /* The fade is CSS: data-phase='closing' is what the stylesheet transitions on, and the
       timer is the one thing script has to own. It is deliberately a little shorter than the
       rain, because a dissolve that lasts as long as a waterfall reads as a stall. */
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      apply();
    };
    setTimeout(finish, 260);
  }

  /* ---------- mount ---------- */

  function mount(root, opts) {
    if (!root) return null;
    var options = opts || {};
    root.textContent = '';
    root.classList.add('chat');

    /* The stage: everything that swaps between the globe and the transcript, and the box the
       rain is drawn inside. It is the positioned ancestor those two layers stack in. */
    var stage = el('div', 'chat-stage');

    var globe = el('button', 'chat-globe');
    globe.type = 'button';
    var canvas = el('canvas', 'chat-globe-canvas');
    canvas.setAttribute('aria-hidden', 'true');
    var label = el('span', 'chat-globe-label', options.startLabel || 'START THE AGENT');
    var sub = el('span', 'chat-globe-sub', options.idleNote || 'no agent is running');
    globe.appendChild(canvas);
    globe.appendChild(label);
    globe.appendChild(sub);

    var list = el('div', 'chat-list');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-label', options.listLabel || 'conversation with the agent');
    list.hidden = true;

    var jump = el('button', 'chat-jump', options.jumpLabel || 'JUMP TO LATEST');
    jump.type = 'button';
    jump.hidden = true;

    /* THE LINK LIGHT. Karim, 2026-08-20: "a warden globe that glows and is animated when
       working and dull when stopped." The same globe the idle phase fills the panel with, in
       the corner of the live one, so the panel has one motif used twice rather than two
       pictures that nearly agree.
       It is not a control and it never becomes one: no listener, aria-hidden because the state
       it carries is already spoken by the state word in the bar, and pointer-events off in
       both stylesheets so a click meant for the transcript underneath still lands there. */
    var badge = el('span', 'chat-badge');
    badge.setAttribute('aria-hidden', 'true');
    var badgeCanvas = el('canvas', 'chat-badge-canvas');
    badge.appendChild(badgeCanvas);
    badge.hidden = true;

    stage.appendChild(globe);
    stage.appendChild(list);
    stage.appendChild(jump);
    stage.appendChild(badge);

    var status = el('span', 'chat-state', 'off');
    status.setAttribute('role', 'status');

    /* The cheap stop. Disabled between turns rather than hidden, and the stylesheets fade it
       to nothing: a control that appears out of nowhere moves the one beside it, and the one
       beside it is the destructive one. */
    var halt = el('button', 'chat-btn chat-halt', options.haltLabel || 'STOP');
    halt.type = 'button';
    halt.disabled = true;

    var stopBtn = el('button', 'chat-btn chat-stop', options.stopLabel || 'STOP AGENT');
    stopBtn.type = 'button';

    var confirm = el('span', 'chat-confirm');
    confirm.hidden = true;
    var question = el('span', 'chat-confirm-q', options.stopQuestion || 'Stop the agent?');
    var yes = el('button', 'chat-btn chat-confirm-yes', options.stopYes || 'YES, STOP');
    yes.type = 'button';
    var no = el('button', 'chat-btn chat-confirm-no', options.stopNo || 'Cancel');
    no.type = 'button';
    confirm.appendChild(question);
    confirm.appendChild(yes);
    confirm.appendChild(no);

    /* ONE BOX. Karim, 2026-08-20: "the text box is weird."
       It was three things stacked loose at the foot of a tall column: a state word floating on
       its own line, a STOP AGENT button beside it with nothing to sit on, and an input under
       both. Three baselines, no edge, and the one control a person is meant to use without
       being told to was the least visible of them.
       Now the state and both stops are the bottom row INSIDE the field's own border, which is
       how every composer a person already uses is built. It also fixes a real problem rather
       than only a look: the box has one focus ring, so tabbing into it lands somewhere, and
       the destructive control sits at the far end of a row rather than floating next to text. */
    var bar = el('div', 'chat-bar');
    bar.appendChild(status);
    bar.appendChild(halt);
    bar.appendChild(stopBtn);
    bar.appendChild(confirm);
    bar.hidden = true;

    var form = el('form', 'chat-form');
    var input = el('input', 'chat-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = options.placeholder || 'tell the agent what to do';
    input.setAttribute('aria-label', options.inputLabel || 'message to the agent');
    var send = el('button', 'chat-btn chat-send', options.sendLabel || 'SEND');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(bar);
    bar.appendChild(send);
    form.hidden = true;

    /* THE STRIP, and the plus at the end of it.
     *
     * Karim, 2026-08-21: "on the ui I want to spin up multiple agents, meaning somewhere should
     * be a plus sign that allows me to begin a new chat in parallel."
     *
     * TABS RATHER THAN STACKED PANELS, and the column is what decides it. The agent lives in a
     * resizable column beside the chart, and splitting it into four rectangles would give each
     * conversation a few lines of height, which is not a conversation. One rectangle showing one
     * chat at a time is the honest use of the space; the strip is how the others stay reachable.
     *
     * A tab that is not in front still receives everything its agent says: push() writes it into
     * that chat's transcript and marks the tab, so nothing is lost by looking away. The mark is
     * the only motion in this strip. Switching tabs is not animated at all, because it is a
     * control a person uses tens of times an hour and an animation on it reads as lag. */
    var tabs = el('div', 'chat-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', options.tabsLabel || 'open agents');

    var plus = el('button', 'chat-plus', '+');
    plus.type = 'button';
    plus.title = options.plusLabel || 'open another agent';
    plus.setAttribute('aria-label', options.plusLabel || 'open another agent');

    root.appendChild(tabs);
    root.appendChild(stage);
    root.appendChild(form);

    var record = {
      root: root,
      tabs: tabs,
      plus: plus,
      stage: stage,
      globe: globe,
      sub: sub,
      list: list,
      jump: jump,
      badge: badge,
      bar: bar,
      form: form,
      input: input,
      status: status,
      halt: halt,
      send: send,
      stopBtn: stopBtn,
      confirm: confirm,
      yes: yes,
      no: no,
      phase: 'idle',
      driverState: 'off',
      pinned: true,
      introTimer: 0,
      landTimer: 0,
      liveWhenPrinted: false,
      reason: '',
      idleNote: options.idleNote || 'no agent is running',
      intro: normalizeIntro(options.intro),
      veil: options.veil === 'fade' ? 'fade' : 'rain',
      /* The gain the surface asked for, forwarded. The calm screen's blue is a low-chroma
         token and lands dimmer than the terminal's green at the same alpha, which is what
         ui/app.js is compensating for when it hands this panel a number. */
      orb: window.PhosphorGlobe
        ? PhosphorGlobe.create(canvas, { colorVar: options.colorVar || '--green', gain: options.gain })
        : null,
      /* minRadius 0 because the floor in agent-globe.js is there to stop the panel-filling
         globe shrinking to a dot, and this one IS a dot. */
      badgeOrb: window.PhosphorGlobe
        ? PhosphorGlobe.create(badgeCanvas, { colorVar: options.colorVar || '--green', gain: options.gain, minRadius: 0 })
        : null,
    };
    /* A browser with no 2d context still gets a working panel: the globes are the only thing
       that goes, and the button around the idle one is what actually starts the agent. */
    var deadGlobe = function () {
      return {
        start: function () {}, stop: function () {}, tune: function () {},
        running: function () { return false; },
      };
    };
    if (!record.orb) record.orb = deadGlobe();
    if (!record.badgeOrb) record.badgeOrb = deadGlobe();

    root.setAttribute('data-phase', 'idle');
    root.setAttribute('data-driver-state', 'off');
    setGlobes(record);

    /* Delegated, because renderTabs() rebuilds the tab buttons on every change and listeners
       bound to the old ones would go with them. The plus is a permanent child of this mount and
       keeps its own listener below. */
    tabs.addEventListener('click', function (ev) {
      var node = ev.target;
      if (!node || !node.getAttribute) return;
      var id = node.getAttribute('data-chat');
      if (id === null) return;
      selectChat(id);
    });

    plus.addEventListener('click', function () {
      if (plus.disabled) return;
      /* Disabled for the round trip rather than after it. Two presses land two agents, and the
         second one is a process a person did not mean to pay for. */
      plus.disabled = true;
      api({ action: 'open' })
        .then(function (json) {
          activeId = json.id || activeId;
          return refresh();
        })
        .catch(function (err) {
          /* Printed into the conversation in front rather than thrown away. The refusal that
             matters here is the ceiling, and a person who pressed plus and saw nothing happen
             would press it again. */
          renderEvent(record.list, { kind: 'error', message: err.message });
          follow(record);
        })
        .then(function () {
          // renderTabs owns whether the plus is available, so this hands it back correctly
          // whether the open succeeded or was refused.
          renderTabs();
        });
    });

    globe.addEventListener('click', function () {
      if (record.phase !== 'idle') return;
      record.reason = '';
      setPhase(record, 'booting');
      printIntro(record);
      api({ action: 'start' }).catch(function (err) {
        record.liveWhenPrinted = false;
        stopIntro(record);
        record.reason = err.message;
        idle(record);
      });
    });

    halt.addEventListener('click', function () {
      haltTurn(record);
    });
    /* Escape in the prompt box does the same thing, because it is what every chat on this
       machine does and a person will try it before they look for a button. Scoped to the box
       and stopped there ONLY when it actually interrupted, so an Escape with nothing to stop
       still reaches whatever else on the page was listening for it. */
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || record.halt.disabled) return;
      ev.stopPropagation();
      haltTurn(record);
    });

    stopBtn.addEventListener('click', function () {
      openConfirm(record);
    });
    no.addEventListener('click', function () {
      closeConfirm(record);
    });
    yes.addEventListener('click', function () {
      closeConfirm(record);
      closeWithVeil(record);
      /* Fired and not awaited. The veil is already running and the panel is already going
         back to idle; a stop that fails on the wire leaves a process this window can no
         longer see, which is what the audit log and the seat indicator are for. */
      api({ action: 'stop' }).catch(function () {});
    });
    /* Escape cancels, and only while the question is up. Scoped to the bar rather than the
       document, so it can never reach past this panel into the approval question. */
    bar.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !record.confirm.hidden) {
        ev.stopPropagation();
        closeConfirm(record);
      }
    });

    list.addEventListener('scroll', function () {
      record.pinned = atBottom(record.list);
      if (record.pinned) record.jump.hidden = true;
    });
    jump.addEventListener('click', function () {
      toBottom(record);
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      /* Cleared before the request resolves, and never restored on failure. A person who
         typed a sentence and pressed enter has moved on; handing the sentence back to them
         half a second later, in a box they may already be typing in again, is worse than
         losing it. The failure is reported in the transcript instead, where it can be read. */
      input.value = '';
      toBottom(record);
      api({ action: 'prompt', text: text }).catch(function (err) {
        renderEvent(record.list, { kind: 'error', message: err.message });
        follow(record);
      });
    });

    mounts.push(record);
    // Drawn now rather than at the first refresh, so a panel has its strip and its plus from the
    // moment it exists. A window whose network never answers still gets both.
    renderTabs();
    return record;
  }

  /* The strip, redrawn whole. It is a handful of buttons and rebuilding them is cheaper than
     working out which one changed, and it keeps one function responsible for every attribute a
     stylesheet reads off a tab. */
  function renderTabs() {
    for (var i = 0; i < mounts.length; i++) {
      var record = mounts[i];
      record.tabs.textContent = '';
      for (var j = 0; j < chats.length; j++) {
        var chat = chats[j];
        var tab = el('button', 'chat-tab', chat.label);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('data-chat', chat.id);
        // The agent's own state, so a tab can say "this one is working" without a word.
        tab.setAttribute('data-state', chat.state || 'off');
        tab.setAttribute('aria-selected', chat.id === activeId ? 'true' : 'false');
        if (chat.id === activeId) tab.setAttribute('data-on', 'true');
        else if (chat.unread) tab.setAttribute('data-unread', 'true');
        record.tabs.appendChild(tab);
      }
      /* Re-appended after the clear, because it is a child of the strip and the strip was just
         emptied. Disabled at the ceiling: a plus that refuses after the press teaches nothing,
         and the number is the server's. */
      record.plus.disabled = chats.length >= maxChats;
      record.tabs.appendChild(record.plus);
      /* The count, for a stylesheet that wants to dress a strip of one differently. The tab is
         drawn even when it is the only one: a lone plus with nothing beside it does not say what
         it would be adding, and the row it saves is one line. */
      record.tabs.setAttribute('data-count', String(chats.length));
    }
  }

  /* Put one conversation into one panel: its transcript, its phase and its state word.
     This is what load() always did per mount, lifted out because switching tabs is the same
     operation as arriving on the page. The three cases are unchanged and are the reason it is
     not simply "print the transcript": a chat with nothing running is the globe, a chat that
     came up and has not spoken yet is the intro print, and anything else is the conversation. */
  function showChat(record, chat) {
    record.list.textContent = '';
    record.reason = '';
    if (!chat) {
      setState(record, 'off');
      return;
    }
    var running = chat.state === 'ready' || chat.state === 'thinking' || chat.state === 'starting';
    var entries = chat.transcript || [];
    if (!running) {
      setState(record, chat.state || 'off');
      return;
    }
    /* Nothing has been said and nothing has been run. Status and error rows do not count,
       because neither is a conversation. */
    var untouched = true;
    for (var k = 0; k < entries.length; k++) {
      if (entries[k].kind !== 'status' && entries[k].kind !== 'error') untouched = false;
    }
    if (untouched) {
      setPhase(record, 'booting');
      printIntro(record);
      // Queues the handover behind the last intro line, exactly as a live start does.
      setState(record, chat.state);
      return;
    }
    setPhase(record, chat.state === 'starting' ? 'booting' : 'live');
    for (var j = 0; j < entries.length; j++) renderEvent(record.list, entries[j]);
    setState(record, chat.state);
    toBottom(record);
  }

  function selectChat(id) {
    if (id === activeId) return;
    var chat = chatOf(id);
    if (!chat) {
      // A tab for a chat this window no longer knows about: the set changed somewhere else.
      refresh();
      return;
    }
    activeId = id;
    chat.unread = false;
    renderTabs();
    for (var i = 0; i < mounts.length; i++) showChat(mounts[i], chat);
  }

  /* One driver event, tagged with the conversation it came from.
     A tab that is not in front still gets everything: the event goes into that chat's cached
     transcript and the tab is marked, so looking away costs nothing and coming back shows the
     whole thing. Only the chat in front reaches the panels. */
  function push(chatId, event) {
    /* Called with one argument by anything that predates the tab strip. It means the
       conversation in front, which is what a single-seat window always meant. */
    if (event === undefined) {
      event = chatId;
      chatId = activeId;
    }
    var chat = chatOf(typeof chatId === 'string' ? chatId : '');
    if (!chat) {
      // An event from a chat this window has never heard of: another window opened one. The
      // set of chats is the server's, so take it again rather than inventing a tab.
      refresh();
      return;
    }

    chat.transcript.push(event);
    if (chat.transcript.length > TRANSCRIPT_MAX) chat.transcript.shift();
    if (event.kind === 'status') chat.state = event.state;

    if (chat.id !== activeId) {
      // Status is the agent breathing, not the agent talking. Marking a tab for it would leave
      // every tab marked all the time, which is the same as marking none of them.
      if (event.kind !== 'status') chat.unread = true;
      renderTabs();
      return;
    }

    if (event.kind === 'status') renderTabs();
    for (var i = 0; i < mounts.length; i++) {
      var record = mounts[i];
      if (event.kind === 'status') setState(record, event.state, event.detail);
      if (record.phase === 'idle' || record.phase === 'closing') continue;
      if (event.kind === 'said') record.pinned = true;
      renderEvent(record.list, event);
      follow(record);
    }
  }

  /* The whole set of open conversations, taken from the server.
     Called when the SET changes (opening, closing, an event from a chat this window does not
     know) and never on an ordinary message, which push() handles without a round trip. Unread
     marks are local and survive it: they are a fact about this window, not about the server. */
  function refresh() {
    return fetch('/api/driver')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        /* The flat shape is the fallback and not dead code: it is what an older server answers
           with, and it is what keeps this panel working against one. A window that got neither a
           list nor a state is left with the seeded chat above rather than with nothing. */
        var incoming = json.chats || [{ id: '', label: 'AGENT 1', state: json.state || 'off', transcript: json.transcript || [] }];
        if (typeof json.max === 'number') maxChats = json.max;
        var next = [];
        for (var i = 0; i < incoming.length; i++) {
          var was = chatOf(incoming[i].id);
          next.push({
            id: incoming[i].id,
            label: incoming[i].label,
            state: incoming[i].state || 'off',
            transcript: incoming[i].transcript || [],
            unread: was ? was.unread : false,
          });
        }
        chats = next.length > 0 ? next : [{ id: '', label: 'AGENT 1', state: 'off', transcript: [], unread: false }];
        if (!chatOf(activeId)) activeId = chats[0].id;
        var chat = chatOf(activeId);
        if (chat) chat.unread = false;
        renderTabs();
        for (var m = 0; m < mounts.length; m++) showChat(mounts[m], chat);
      })
      .catch(function () {});
  }

  /* Called once per page, after every mount has registered. A window that reloaded mid
     conversation comes back to the conversation rather than to the globe, which is the only
     reason the transcripts live on the server at all.

     WITH NO AGENT THE ANSWER IS THE GLOBE, and that is the ordinary case now: autostart is off
     by default (see src/main.ts), so the app opens with nothing running and the press is the
     user's. The server answers with one chat that has no id in that case, which is what keeps
     serving this window from spawning a process nobody asked for. */
  function load() {
    fetch('/api/session')
      .then(function (r) { return r.json(); })
      .then(function (json) { token = json.token || ''; })
      .catch(function () {});
    refresh();
  }

  return { mount: mount, push: push, load: load };
})();
