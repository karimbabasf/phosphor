/* The conversation column. It is on screen in every mode, in the same place,
   and it is the product: what a person asked, what the assistant did to answer,
   and what it said back.

   Two properties keep it safe and neither is a tidiness preference. Nothing the
   assistant writes reaches the DOM as markup, and this file draws no control
   that decides anything. An approval is a physical click on the dock below,
   which is drawn from server state, so a transcript row cannot impersonate one.

   The column never calls the beam either. Every step row dispatches
   phosphor:step on window and ui/beam/trace.js decides what lights up, so the
   transcript keeps working in a window where the beam file is not there.

   The look lives in ui/design/agent.css. This file writes state as attributes
   and text, never as style. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;

  /* A tool call is the honest unit of "what the agent actually did", so it is
     rendered as its own row with a phrase rather than a tool id. The propose and
     do pairs below are deliberately one word apart ("asking to swap" against
     "swapping"), because that word is the entire difference between them. */
  var TOOL_PHRASES = {
    /* reading */
    balances: 'reading your balances',
    wallet: 'reading your wallet',
    composition: 'checking what you hold',
    policy_show: 'reading the policy',
    proposal_status: 'checking the approval',
    market_search: 'looking up a market',
    gas_report: 'checking gas',
    log_tail: 'reading the log',
    /* The one tool that leaves this machine, and the row says so in its own
       words beside the phrase. A person watching their wallet app reach the
       internet is entitled to see that happen. */
    research: 'reading the news',
    skill: 'reading its instructions',
    trade_read: 'reading the account',
    deposit: 'showing a deposit address',
    /* the chart */
    chart_read: 'reading the chart',
    chart_scan: 'scanning the timeframes',
    chart_snapshot: 'taking a picture of the chart',
    chart_draw: 'drawing on the chart',
    chart_layout: 'arranging the charts',
    chart_batch: 'redrawing the chart',
    /* the trading window */
    trade_focus: 'focusing a market',
    trade_highlight: 'highlighting the chart',
    trade_overlay: 'drawing on the chart',
    trade_plan: 'drawing a plan',
    trade_batch: 'redrawing the account',
    trade_clear: 'clearing the chart',
    /* The human's own profile: a note that they now understand a concept,
       so the next session does not explain it again. The concept rides on
       the row (ARG_FIELDS), so the row says what was noted. */
    profile_learned: 'noting for next time that you now understand',
    /* asking. None of these moves anything: each puts a request in the gate. */
    propose_consolidate: 'asking to consolidate',
    propose_swap: 'asking to swap',
    propose_intents_deposit: 'asking to deposit',
    propose_intents_withdraw: 'asking to withdraw',
    propose_intents_send: 'asking to send to another account',
    propose_trade: 'proposing a trade',
    propose_trade_change: 'proposing a change',
    propose_hl_deposit: 'asking to fund trading',
    propose_hl_withdraw: 'asking to bring collateral back',
    propose_policy_change: 'asking to change a rule',
    /* doing, once a human has said yes */
    consolidate: 'consolidating',
    swap: 'swapping',
    intents_deposit: 'depositing',
    intents_withdraw: 'withdrawing',
    intents_send: 'sending to another account',
    trade: 'opening a trade',
    trade_change: 'changing a trade',
    hl_deposit: 'funding trading',
    hl_withdraw: 'bringing collateral back',
    /* the helpers */
    agent_spawn: 'starting a helper',
    agent_roster: 'checking the helpers',
    agent_post: 'talking to the helpers',
    agent_board: 'talking to the helpers',
    agent_jobs: 'talking to the helpers',
    /* the window itself */
    switch: 'switching the screen',
    watch: 'changing the coins you watch',
    set_theme: 'recolouring the window',
    start: 'starting up'
  };

  /* The tools that reach past this machine. The step row names them, because a
     wallet app opening the internet is a fact a person is owed in words. */
  var LEAVES = { research: true };

  /* WHAT the call was about, not just what kind of call it was. The tool event
     already carries the arguments the model sent, and dropping them was the
     difference between "reading prices" and "reading prices, SOL-PERP 1h": one
     says a category of work is happening, the other proves the app is working
     on the thing that was asked for.

     Read through a fixed list of field names rather than by tool, so a tool
     added later says something without a second table to keep in step. Values
     come from a language model, so each one is cut to length and only strings,
     numbers and booleans are ever read: an object stringifies to nothing a
     person can use, and this row is not the place to find out. */
  var ARG_FIELDS = [
    'product', 'symbol', 'query', 'coins', 'mode', 'name', 'indicator',
    'chain', 'toChain', 'venue', 'label', 'text', 'sentence', 'what', 'source', 'id', 'concept'
  ];
  var ARG_MAX = 38;

  var TRANSCRIPT_CAP = 400;
  var TICK_MS = 100;
  var STICK_PX = 40;
  /* How long the column counts as still at the end after it asked the
     scroller to ease there. A smooth scroll is not at the bottom on the very
     next frame, and a row that lands during it must not read that as "the
     person scrolled up". A wheel turn ends the follow at once. */
  var FOLLOW_MS = 600;
  var JUMP_S = 0.32;
  /* Six lines, and the line's height is read off the box rather than written
     down here: the fallback is only for a computed style that says `normal`. */
  var COMPOSER_MAX_LINES = 6;
  var COMPOSER_LINE_FALLBACK_PX = 21;

  /* What the box says. It is only on screen while it can be used. */
  var PLACEHOLDER_ON = 'Ask, or tell it what to do';

  /* The three first moves on the empty card. Each is a question this window
     answers from what it already holds, in the words a person would use. */
  var SUGGESTIONS = ['What do I hold?', 'Is anything waiting on me?', 'Find a trade on BTC'];

  /* The card's sentences, in one place. The title says who is at the wheel and
     the line under it says the one next thing to do. */
  var COPY = {
    offTitle: 'Nobody is at the wheel.',
    offLine: 'Start your assistant, or connect one you already use.',
    comingTitle: 'Taking the wheel.',
    comingLine: 'Starting your assistant.',
    liveTitle: 'Your assistant is at the wheel.',
    liveLine: 'Tell it what to do. It picks up your wallet, the policy and the chart on your first message.',
    ownTitle: 'Your own agent is at the wheel.',
    ownLine: 'Talk to it from its own terminal. Its moves land in Activity.',
    connectTitle: 'Connect your own agent',
    connectLine: 'Any MCP client can drive Phosphor.',
    connectHint: 'Paste this into your terminal, then send a message from there.',
    waiting: 'Waiting for a connection...',
    connected: 'Connected',
    /* The one failure the window can only decide for itself: a start that
       never reported back. Every other reason arrives from the driver. */
    noAnswer: 'The assistant did not answer in time.',
    /* A failed start that named no reason. It should not happen, and when it
       does the person still gets a sentence rather than a blank line. */
    failedUnsaid: 'The assistant could not start.'
  };

  /* How long a start may sit at "Starting..." before the window says so. Ready
     arrives on the child's spawn event (src/driver.ts), a few hundred
     milliseconds after the click, so twenty seconds is not a start that is
     slow, it is one that has stopped reporting. The window only says it: the
     next frame from the driver still wins. */
  var START_TIMEOUT_MS = 20000;

  /* THE RECEIPT CARD. When a move this app made lands as a receipt
     (src/http/receipts.ts, read through ui/screens/receipts.js), the
     transcript shows the shared card (ui/screens/receipt.js,
     PhosphorReceipt.card) drawn from that receipt and never from the
     assistant's prose. Karim, 2026-09-14: "when trades happen I dont want to
     see this, I want to see a nice card, simple, no unnecessary info, and the
     intent id should be a clickable link". The card decides its own link,
     from the url the server built; this column only places it. */

  function icon(name, className) {
    return window.PhosphorIcons.svg(name, className);
  }

  /* typeof, not truthiness: the tool id arrives from a language model, and a
     lookup on a plain object hands back Object.prototype's own members for ids
     like `constructor`. A function stringified into a transcript is not a phrase. */
  function toolLabel(name) {
    var id = String(name || 'tool').replace(/^mcp__phosphor__/, '');
    var phrase = TOOL_PHRASES[id];
    return typeof phrase === 'string' ? phrase : id;
  }

  function leavesMachine(name) {
    return LEAVES[String(name || '').replace(/^mcp__phosphor__/, '')] === true;
  }

  /* One scalar, trimmed and bounded. An array of scalars reads as a list
     because that is what `coins` and the chart's clear lists are. */
  function argText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length && parts.length < 4; i += 1) {
        var one = argText(value[i]);
        if (one) parts.push(one);
      }
      return parts.join(' ');
    }
    return '';
  }

  /* The subject of the call in a few words. An amount leads when there is one,
     because the number is the thing a person looks for on a row that moves
     money, and it is followed by what the number counts. */
  function argsLabel(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    var parts = [];
    var amount = argText(input.amount);
    if (amount) parts.push(amount);
    for (var i = 0; i < ARG_FIELDS.length && parts.length < 3; i += 1) {
      var key = ARG_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      var text = argText(input[key]);
      if (!text) continue;
      if (parts.indexOf(text) !== -1) continue;
      parts.push(text);
    }
    var joined = parts.join(' ');
    if (joined.length > ARG_MAX) joined = joined.slice(0, ARG_MAX - 1).replace(/\s+\S*$/, '') + '...';
    return joined;
  }

  /* The scalar arguments of a call, kept beside the row for the trace: the
     screen a `switch` moved to is the one thing the beam has to know that the
     phrase does not say. Nothing nested is kept. */
  function scalarArgs(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    var out = null;
    for (var key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      var value = input[key];
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      if (!out) out = {};
      out[key] = value;
    }
    return out;
  }

  var mounts = [];
  var blocks = [];
  var seq = 0;
  var phase = 'idle';
  var connection = { command: '' };
  var roster = [];
  var openSteps = null;
  var ticker = 0;
  var announced = [];

  /* WHAT THE CENTRE SHOWS while there is no transcript: the card, or the
     connect sheet in its place. The sheet is the only thing that ever holds
     the mcp-add command, and it can only be opened while nobody is at the
     wheel. The moment somebody is (starting, ready, working) it closes, so a
     Ready card never carries a block meant for a terminal. That is the whole
     fix for the command that used to stay on screen after Start: the block
     was hidden by its own toggle and by nothing else. */
  var view = 'card';

  /* THE ONE THING THAT WENT WRONG, in words. Set from a failed start or an
     exit the person did not ask for, shown under the status line with a Retry,
     and cleared by the next start. `reason` is the driver's plain sentence;
     `detail` is its technical line, kept so the error frame that follows the
     same failure is not printed a second time as a row. */
  var failure = null;

  /* THE TURN, and why it is not a transcript row.

     The old build put a "thinking" row in the transcript, removed it the moment
     any frame arrived, and never brought it back. So the two longest silences
     in a turn were the two with nothing on screen: before the first tool call,
     and after the last one while the answer is being written. A person watching
     that has no way to tell a working agent from a dead one.

     This is one record that lives from the moment a prompt goes out until the
     turn ends. Three states, each one an event rather than a guess: `thinking`
     (sent, nothing back yet), `calling` (a tool is open) and `writing` (text
     has arrived and no tool is open). The seat light in the head shows it (the
     verb and the clock come from this record), and the turn bar under the
     transcript is clipped out of sight by the stylesheet and kept as the live
     region a screen reader hears. */
  var turn = null;

  /* WHICH CONVERSATION THIS COLUMN IS. The stream carries every chat's events
     and the app opens up to four, so an untagged reader printed another
     conversation's tool calls into this one and fired the beam for work this
     agent never did. The column adopts the first chat it hears from and
     ignores the rest. */
  var chatId = null;

  /* Five phases for the rest of the window, five words for the person. A
     stopped assistant is off: the word is the same whether the person turned
     it off or it left on its own, and the line under the status is what
     tells those two apart. Off with somebody else's agent attached over MCP
     is a sixth word, Connected: nobody of ours is at the wheel, but the seat
     is not empty. */
  var STATE_WORDS = {
    idle: 'Off',
    starting: 'Starting...',
    connected: 'Ready',
    working: 'Working',
    error: 'Could not start'
  };

  /* The state as the stylesheet reads it: one word per light. */
  var STATE_ATTR = {
    idle: 'off',
    starting: 'starting',
    connected: 'ready',
    working: 'working',
    error: 'error'
  };

  function stateAttr() {
    if (ownAttached()) return 'connected';
    return STATE_ATTR[phase] || 'off';
  }

  /* Somebody else's agent is at the wheel: the built-in one is off, not
     failed, and the roster names a client. */
  function ownAttached() {
    return phase === 'idle' && ownAgents().length > 0;
  }

  /* The newest call still open, which is the one the status line names. Read
     off the blocks rather than off the open steps block, because a receipt
     card closes that block while the call that produced it can still be
     running. */
  function liveStep() {
    for (var b = blocks.length - 1; b >= 0; b -= 1) {
      var block = blocks[b];
      if (block.type !== 'steps' || block.done) continue;
      var steps = block.steps;
      for (var i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].state === 'live') return steps[i];
      }
    }
    return null;
  }

  function sentence(text) {
    var value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  /* WHAT THE STATUS LINE SAYS. The state word, until the assistant is at
     work: then the open call's own words ("Reading the chart"), the turn's
     state between calls ("Thinking", "Writing the answer"), and a plain
     "Working" only when the column knows it is busy and nothing more, which
     is a window that opened onto a turn already under way. */
  function statusVerb() {
    if (ownAttached()) return COPY.connected;
    if (phase !== 'working') return STATE_WORDS[phase] || 'Off';
    var step = liveStep();
    if (step) return sentence(step.label);
    if (turn) return sentence(turnLine());
    return STATE_WORDS.working;
  }

  /* When the work being shown began: the turn, so the head's clock is how
     long the whole answer has taken (each step row already carries its own),
     else the open call, else nothing, because a clock with no start would
     have to invent one. */
  function statusStartedAt() {
    if (phase !== 'working') return 0;
    if (turn) return turn.startedAt;
    var step = liveStep();
    if (step) return step.startedAt;
    return 0;
  }

  function isWorking() {
    return phase === 'working';
  }

  function canTalk() {
    return phase === 'connected' || phase === 'working';
  }

  function canStart() {
    return phase === 'idle' || phase === 'error';
  }

  /* Somebody else's agent, attached over MCP while the built-in one is off.
     The roster lists the built-in child too once it has attached, so it is
     only read while this column knows nobody of its own is at the wheel. */
  function ownAgents() {
    return canStart() ? roster : [];
  }

  /* ---------- mount ---------- */

  function mount(host, options) {
    if (!host) return null;
    var opts = options || {};
    /* mark is what the transcript held at the last render, so the next one can
       tell an arrival from a redraw; unseen counts arrivals since the person
       was last at the end; followUntil is the clock the column is easing
       down on. */
    var node = { host: host, composerHost: opts.composerHost || null, refs: {}, live: [], mark: '', unseen: 0, followUntil: 0, lastTop: 0 };
    build(node);
    mounts.push(node);
    render(node, mounts.length === 1);
    return node;
  }

  function button(className, label, title) {
    var btn = dom.el('button', className);
    btn.type = 'button';
    if (title) btn.title = title;
    btn.appendChild(dom.el('span', 'btn-label', label));
    return btn;
  }

  function build(node) {
    var host = node.host;
    dom.clear(host);

    /* THE HEAD. The name, the seat light, and one control. */
    var head = dom.el('div', 'agent-head');
    var title = dom.el('div', 'agent-title');
    title.appendChild(dom.el('span', 'agent-name', 'Assistant'));
    /* THE SEAT LIGHT. One status line beside the name, in the shared grammar
       (components.css): a 6 px dot, the verb, and the seconds. The dot is
       still while nobody is working and breathes while a call is open; the
       verb is the state word until a tool runs, and then the tool's own
       words. The id is how the beam finds it: ui/beam/beam.js sets data-live
       on it while it holds a surface, and this file never writes that
       attribute. */
    var status = dom.el('div', 'status-line agent-status');
    status.id = 'agent-status';
    var dot = dom.el('span', 'status-dot');
    var ring = dom.el('span', 'status-ring');
    ring.setAttribute('aria-hidden', 'true');
    dot.appendChild(ring);
    var verb = dom.el('span', 'status-verb', 'Off');
    var elapsed = dom.el('span', 'status-elapsed');
    elapsed.hidden = true;
    status.appendChild(dot);
    status.appendChild(verb);
    status.appendChild(elapsed);
    title.appendChild(status);
    head.appendChild(title);

    /* One control at the right, and only one at a time: Turn off while
       somebody is at the wheel, Start when the card that offers it has
       scrolled away under a transcript. Stopping an answer is the composer's
       button, where the answer was sent from. */
    var controls = dom.el('div', 'agent-controls');
    var start = button('btn btn-primary btn-sm', 'Start your assistant');
    var stopAgent = button('btn btn-quiet btn-sm', 'Turn off', 'Turn your assistant off');
    controls.appendChild(start);
    controls.appendChild(stopAgent);
    /* The pane's own hide control (ui/split.js, drawn by trade.css), last in
       the cluster. The Layout menu on the bar brings the pane back, on every
       mode. Guarded until the trade branch lands the pane API. */
    var split = window.PhosphorSplit;
    if (split && typeof split.paneControl === 'function') {
      var hide = split.paneControl('conversation');
      if (hide) controls.appendChild(hide);
    }
    head.appendChild(controls);
    host.appendChild(head);

    /* WHAT WENT WRONG, under the status it belongs to: one sentence and a
       Retry, present only while there is a failure to name. It is the same
       line whether the card is on screen or a transcript is, so a person
       whose assistant died mid conversation reads the reason in the head
       rather than losing it under the last message. */
    var note = dom.el('div', 'agent-note');
    note.setAttribute('role', 'status');
    var noteText = dom.el('span', 'agent-note-text');
    var retry = button('chip agent-retry', 'Retry');
    note.appendChild(noteText);
    note.appendChild(retry);
    note.hidden = true;
    host.appendChild(note);

    /* Who else is holding the reins. A second client that can ask for money is
       not a detail, so it is named under the head rather than behind a fold. */
    var clients = dom.el('div', 'agent-clients');
    host.appendChild(clients);

    /* THE CENTRE: the card, or the connect sheet in its place. */
    var centre = dom.el('div', 'agent-centre');

    /* THE CARD, AND WHY IT HAS THREE ANSWERS.

       It used to be one card keyed on nothing but an empty transcript, so it
       said "Nobody is at the wheel" and offered a Start button for the whole
       time an agent was running and simply had not been spoken to yet. Starting
       one changed the chip and nothing else, because the biggest thing on the
       screen went on saying the opposite. Karim, 2026-09-08: "I need much
       better feedback when I click start an agent, right now nothing changes."

       The three states are the three true answers to "is anybody there": no,
       coming, and yes. The seat, the headline and the buttons all follow the
       phase, and the Start button is drawn only in the state where starting is
       a thing that can be done. */
    var empty = dom.el('div', 'agent-empty');
    var emptyInner = dom.el('div', 'agent-empty-inner');
    /* The seat is the mark: 40 px of the window's own light. Muted when
       nobody is there, waking while one comes up, lit with one soft glow
       once one is. It is the only thing in the panel that glows. */
    var emptySeat = dom.el('div', 'agent-seat');
    emptySeat.setAttribute('aria-hidden', 'true');
    var seatMark = dom.mark('agent-seat-mark');
    if (seatMark) emptySeat.appendChild(seatMark);
    emptyInner.appendChild(emptySeat);
    var emptyTitle = dom.el('p', 'agent-empty-title', COPY.offTitle);
    var emptyNote = dom.el('p', 'agent-empty-line', COPY.offLine);
    emptyInner.appendChild(emptyTitle);
    emptyInner.appendChild(emptyNote);
    var emptyActions = dom.el('div', 'agent-empty-actions');
    var startBig = button('btn btn-primary', 'Start your assistant');
    var connectBtn = button('btn btn-ghost', 'Connect your own');
    emptyActions.appendChild(startBig);
    emptyActions.appendChild(connectBtn);
    emptyInner.appendChild(emptyActions);

    /* THREE FIRST MOVES. A card that only says nobody is there is a dead end:
       the person has an assistant and no idea what to say to it. Each pill is
       a real question this window can answer, and pressing one asks it: on a
       live column at once, on a quiet one by starting the assistant first. */
    var rule = dom.el('hr', 'agent-rule');
    emptyInner.appendChild(rule);
    var suggest = dom.el('div', 'agent-suggest');
    for (var s = 0; s < SUGGESTIONS.length; s += 1) {
      var suggestion = dom.el('button', 'chip suggest', SUGGESTIONS[s]);
      suggestion.type = 'button';
      suggest.appendChild(suggestion);
      dom.on(suggestion, 'click', suggestClick(node, SUGGESTIONS[s]));
    }
    emptyInner.appendChild(suggest);
    empty.appendChild(emptyInner);
    centre.appendChild(empty);

    /* THE CONNECT SHEET. In the card's place, not over it: a title, one line,
       the command with its Copy inside, the hint, a status line that reads
       the roster, and the way back. */
    var sheet = dom.el('div', 'agent-connect');
    sheet.hidden = true;
    sheet.appendChild(dom.el('p', 'agent-connect-title', COPY.connectTitle));
    sheet.appendChild(dom.el('p', 'agent-connect-line', COPY.connectLine));
    var block = dom.el('div', 'connection-block');
    var line = dom.el('code', 'connection-line');
    var copy = button('chip connection-copy', 'Copy', 'Copy the command');
    block.appendChild(line);
    block.appendChild(copy);
    sheet.appendChild(block);
    sheet.appendChild(dom.el('p', 'agent-connect-hint', COPY.connectHint));
    var connectStatus = dom.el('div', 'status-line agent-connect-status');
    connectStatus.appendChild(dom.el('span', 'status-dot'));
    var connectVerb = dom.el('span', 'status-verb', COPY.waiting);
    connectStatus.appendChild(connectVerb);
    sheet.appendChild(connectStatus);
    var back = button('btn btn-ghost btn-sm agent-connect-back', 'Back');
    sheet.appendChild(back);
    centre.appendChild(sheet);
    host.appendChild(centre);

    /* THE SCROLLER, IN A FRAME THAT DOES NOT SCROLL. The transcript is the
       one thing in the column that moves, so the things drawn over it (the
       edge fades, the way back down) sit on the frame around it rather than
       inside it, and the scroller itself carries nothing but rows. */
    var wrap = dom.el('div', 'transcript-wrap');
    var list = dom.el('div', 'transcript');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    wrap.appendChild(list);
    /* No scrollbar (agent.css hides it): the transcript fades at the edge
       that has more behind it, the way every list in the window does. The
       fade is two gradients laid over the frame, never a mask on the scroller:
       a mask keeps WebKit scrolling on the main thread. cuts() says which
       edge has more behind it. */
    var fadeTop = dom.el('div', 'transcript-fade');
    fadeTop.setAttribute('data-edge', 'top');
    var fadeBottom = dom.el('div', 'transcript-fade');
    fadeBottom.setAttribute('data-edge', 'bottom');
    wrap.appendChild(fadeTop);
    wrap.appendChild(fadeBottom);
    /* THE WAY BACK DOWN. A person who scrolled up to read is left where they
       are when a row lands (Karim, 2026-09-16: "when i send a new message it
       doesnt auto scroll me all the way down or at least give me an arrow I
       can click if I have scrolled up to go straight down"), and this is the
       arrow: one round pill at the foot of the scroller, the count of what
       landed while they were away when it is more than one. It decides
       nothing: it scrolls. */
    var jump = button('jump-latest', 'Jump to latest', 'Jump to the latest message');
    jump.appendChild(icon('chevron-down', 'jump-glyph'));
    var jumpCount = dom.el('span', 'jump-count mono');
    jump.appendChild(jumpCount);
    wrap.appendChild(jump);
    host.appendChild(wrap);
    cuts(list, wrap);

    /* The turn bar is text and one dot: no control, nothing that decides
       anything. Heard and not seen (agent.css clips it): the seat light says
       the same words with the same clock. */
    var turnBar = dom.el('div', 'turn-bar');
    turnBar.setAttribute('role', 'status');
    turnBar.setAttribute('aria-live', 'polite');
    turnBar.appendChild(dom.el('span', 'turn-dot'));
    turnBar.appendChild(dom.el('span', 'turn-what'));
    turnBar.appendChild(dom.el('span', 'turn-time'));
    turnBar.hidden = true;

    /* THE COMPOSER. One pill on a raised ground, a hairline that turns ink
       on focus, the textarea bare inside it growing to six lines, and one
       round ink button at the right: the send arrow, which becomes a stop
       square while an answer is running. Enter sends. */
    var composer = dom.el('form', 'agent-composer');
    var field = dom.el('div', 'composer-field');
    var input = dom.el('textarea', 'input composer-input');
    input.rows = 1;
    input.placeholder = PLACEHOLDER_ON;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Message to your assistant');
    var send = dom.el('button', 'composer-send');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send');
    send.title = 'Send';
    send.appendChild(icon('send', 'composer-send-glyph'));
    send.appendChild(icon('stop', 'composer-stop-glyph'));
    field.appendChild(input);
    field.appendChild(send);
    composer.appendChild(field);
    var composerHost = node.composerHost || host;
    composerHost.appendChild(turnBar);
    composerHost.appendChild(composer);

    node.refs = {
      status: status,
      dot: dot,
      ring: ring,
      verb: verb,
      elapsed: elapsed,
      field: field,
      start: start,
      startBig: startBig,
      stopAgent: stopAgent,
      connect: connectBtn,
      note: note,
      noteText: noteText,
      retry: retry,
      empty: empty,
      emptyInner: emptyInner,
      sheet: sheet,
      list: list,
      listWrap: wrap,
      jump: jump,
      jumpCount: jumpCount,
      composer: composer,
      input: input,
      send: send,
      line: line,
      copy: copy,
      back: back,
      connectVerb: connectVerb,
      connectStatus: connectStatus,
      clients: clients,
      turnBar: turnBar,
      turnDot: turnBar.children[0],
      turnWhat: turnBar.children[1],
      turnTime: turnBar.children[2],
      emptySeat: emptySeat,
      emptyTitle: emptyTitle,
      emptyNote: emptyNote,
      emptyActions: emptyActions,
      rule: rule,
      suggest: suggest
    };

    dom.on(start, 'click', function () { doStart(node, start); });
    dom.on(startBig, 'click', function () { doStart(node, startBig); });
    dom.on(retry, 'click', function () { doStart(node, retry); });
    dom.on(stopAgent, 'click', function () { doStop('stop', node); });
    dom.on(copy, 'click', function () { copyLine(node); });
    dom.on(connectBtn, 'click', function () { setView('connect'); });
    dom.on(back, 'click', function () { setView('card'); });
    dom.on(jump, 'click', function () { jumpToEnd(node); });
    /* Reaching the end by hand puts the pill away. Going up ends the follow:
       the column's own easing only ever moves down, so a scroll that moved
       up is the person, and the hand wins. */
    dom.on(list, 'scroll', function () {
      if (list.scrollTop < node.lastTop) node.followUntil = 0;
      node.lastTop = list.scrollTop;
      if (node.unseen && atEnd(list)) {
        node.unseen = 0;
        paintJump(node);
      }
    }, { passive: true });

    /* Enter sends and Shift+Enter breaks the line, which is the shape every
       chat box has. Escape lets go of the box and keeps the draft: leaving is
       not the same as throwing away. Nothing animates on the keyboard path: a
       person who has just typed does not need the window to confirm that they
       pressed a key. */
    dom.on(input, 'keydown', function (event) {
      if (event.key === 'Escape') {
        if (typeof input.blur === 'function') input.blur();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submit(node);
    });
    /* The one button does two things and the form knows which: while an
       answer is running it is Stop, and a submit then is an interrupt. */
    dom.on(composer, 'submit', function (event) {
      event.preventDefault();
      if (phase === 'working') {
        doStop('interrupt', node);
        return;
      }
      submit(node);
    });
    /* The arrow arms on the same event the box grows on, because "there is
       something to send" is a fact about the text and not about the phase. */
    dom.on(input, 'input', function () {
      autogrow(input);
      arm(node);
    });
  }

  /* The send arrow is grey until the box holds a word. Read off the value,
     never off the phase, so a box that was typed into before the assistant
     came up is armed the moment it can be used. */
  function arm(node) {
    var text = String(node.refs.input.value || '').trim();
    dom.setAttr(node.refs.field, 'data-armed', text ? 'true' : null);
    /* Three states and the button is only pressable in two: Stop while an
       answer runs, Send while there are words. An empty box has nothing to
       send, so the arrow is out rather than dim. */
    node.refs.send.disabled = !canTalk() || (phase !== 'working' && !text);
  }

  function setView(next) {
    if (next === 'connect' && !canStart()) return;
    if (next === view) return;
    view = next;
    renderAll();
  }

  /* A SUGGESTION IS A QUESTION, SO PRESSING ONE ASKS IT.

     On a live column it goes straight out. On a column with nobody at the
     wheel it starts the assistant, through the same door the Start button
     uses, with the words waiting in the box, and sends them the moment the
     seat reports ready. A start that fails leaves the words where they are
     and lets the status line say what went wrong; nothing sends, and the
     next press is the person's. */
  var queued = null;

  function suggestClick(node, text) {
    return function () {
      var input = node.refs.input;
      input.value = text;
      autogrow(input);
      arm(node);
      if (canTalk()) {
        submit(node);
        return;
      }
      queued = { node: node, text: text };
      if (phase === 'starting') return;
      doStart(node, node.refs.startBig);
    };
  }

  /* The seat came up with a question waiting. Sent only if the box still
     holds the words that were queued: a box that says something else is a
     person who changed their mind while it was starting. */
  function sendQueued() {
    var waiting = queued;
    queued = null;
    if (!waiting || !canTalk()) return;
    if (String(waiting.node.refs.input.value || '').trim() !== waiting.text) return;
    submit(waiting.node);
  }

  /* Height from content, capped at six lines, and measured from zero so
     deleting a line gives the space back. No transition on it: the box has to
     be under the caret on the frame the character lands, not on the way there.

     scrollHeight counts the padding and not the border, and the box is
     border-box, so the border is added back or every growth step leaves a two
     pixel scrollbar behind. */
  function autogrow(input) {
    input.style.height = 'auto';
    var style = window.getComputedStyle(input);
    var line = parseFloat(style.lineHeight);
    if (!isFinite(line) || line <= 0) line = COMPOSER_LINE_FALLBACK_PX;
    var pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var border = input.offsetHeight - input.clientHeight;
    var content = input.scrollHeight;
    /* The cap is a whole number of lines, read from the box rather than
       guessed, so the sixth line is scrolled away rather than half drawn. */
    var cap = Math.round(COMPOSER_MAX_LINES * line + pad);
    input.style.height = Math.min(content, cap) + border + 'px';
    input.style.overflowY = content > cap ? 'auto' : 'hidden';
  }

  /* ---------- actions ---------- */

  /* THE ECHO AND THE EVENT ARE ONE MESSAGE, WHICH IS WHY THIS BOOKS A PLACE.

     The window used to draw the message the moment it was typed AND again when
     the server broadcast it back, so every prompt appeared twice. Waiting for
     the server instead would fix the count and cost a round trip before a
     person sees their own words, which is the wrong trade.

     So the local row goes in straight away as `pending` and the server's own
     `said` event adopts it rather than pushing a second one. The state is not
     decoration: it is the difference between a message this app has taken
     responsibility for and one still in the air. */
  function submit(node) {
    var text = node.refs.input.value.trim();
    if (!text || !canTalk()) return;
    node.refs.input.value = '';
    autogrow(node.refs.input);
    arm(node);
    /* Their own words always land in view, however far up they were reading. */
    jumpAll = true;
    var mine = said(text, 'pending');
    api.driver({ action: 'prompt', text: text, chat: '' }).catch(function (err) {
      mine.state = 'failed';
      endTurnBar();
      pushBlock({ type: 'error', text: net.readable(err) });
    });
  }

  function doStart(node, btn) {
    /* Starting over gives the app a new chat with a new id, so the column has
       to forget the one it was following or it filters out its own agent. */
    chatId = null;
    failure = null;
    setPhase('starting', 'starting');
    window.PhosphorShell.setPending(btn, true, 'Starting');
    api.driver({ action: 'start', chat: '' })
      .catch(function (err) {
        fail(net.readable(err), '');
      })
      .finally(function () {
        window.PhosphorShell.setPending(btn, false);
      });
  }

  /* Turn off quits the assistant: its process ends and its chat closes, so
     nothing is left running or waiting (Karim, 2026-09-16: "turn off should
     completely quit the assistant. meaning quit ... of course with
     confirmation first"). The confirmation is an in-app card on the dock,
     never a system dialog. Stopping an answer in progress is the composer's
     button and asks nothing. */
  function doStop(action, node) {
    if (action === 'stop') {
      confirmOff(node);
      return;
    }
    var btn = node.refs.send;
    window.PhosphorShell.setPending(btn, true, 'Stopping');
    api.driver({ action: action, chat: '' })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () {
        window.PhosphorShell.setPending(btn, false);
      });
  }

  function confirmOff(node) {
    var decision = window.PhosphorDecision;
    if (!decision || typeof decision.showCard !== 'function') return quitAssistant(node);
    decision.showCard(function (host, done) {
      dom.clear(host);
      host.appendChild(dom.el('h2', 'title', 'Turn off the assistant?'));
      host.appendChild(dom.el('p', 'body dim', 'Its transcript on this window is deleted. Your wallet, policy and open positions are untouched.'));
      var actions = dom.el('div', 'dock-actions');
      var keep = button('btn btn-ghost', 'Keep running');
      var off = button('btn btn-danger', 'Turn off');
      actions.appendChild(keep);
      actions.appendChild(off);
      host.appendChild(actions);
      dom.on(keep, 'click', function () { done(); });
      dom.on(off, 'click', function () {
        done();
        quitAssistant(node);
      });
      if (keep.focus) keep.focus();
    });
  }

  function quitAssistant(node) {
    var btn = node.refs.stopAgent;
    window.PhosphorShell.setPending(btn, true, 'Turning off');
    api.driver({ action: 'stop', chat: '' })
      .then(function () {
        /* Stopped is the process gone; closed is the chat gone with it, and
           its transcript on the server dies with the chat. */
        return api.driver({ action: 'close', chat: '' });
      })
      .then(function () {
        chatId = null;
        forget();
      })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () {
        window.PhosphorShell.setPending(btn, false);
      });
  }

  /* THE COLUMN AFTER A QUIT is the column before anybody started: no rows,
     the card with nobody at the wheel, the head reading Off. This is the
     quit's own step and never the stopped frame's, because a crash arrives
     as the same state with a reason, and that transcript has to stay on
     screen under the reason (Karim, 2026-09-16: turn off "should take me
     back to" the empty state). The receipts already seen stay seen, so a
     card that was posted once is not posted again by the next read. */
  function forget() {
    blocks.length = 0;
    openSteps = null;
    turn = null;
    failure = null;
    queued = null;
    view = 'card';
    for (var i = 0; i < mounts.length; i += 1) {
      mounts[i].unseen = 0;
      mounts[i].followUntil = 0;
    }
    setPhase('idle', 'stopped');
  }

  /* Paint which edges of a scroller have more behind them, for the fade
     the stylesheet draws there: on the frame around the scroller when there
     is one, so the scroller's own paint is never touched. */
  function cuts(scroller, frame) {
    var target = frame || scroller;
    function paint() {
      var top = scroller.scrollTop > 2;
      var bottom = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2;
      dom.setAttr(target, 'data-cut', top && bottom ? 'both' : (top ? 'top' : (bottom ? 'bottom' : null)));
    }
    dom.on(scroller, 'scroll', paint, { passive: true });
    if (window.ResizeObserver) new window.ResizeObserver(paint).observe(scroller);
    paint();
    return paint;
  }

  /* A start that did not happen, in the window's own words: the reason the
     driver gave, or the one the window found out for itself. */
  function fail(reason, detail) {
    failure = { reason: reason || COPY.failedUnsaid, detail: detail || '' };
    setPhase('error', 'failed');
  }

  function copyLine(node) {
    var value = node.refs.line.textContent;
    if (!value) return;
    var label = node.refs.copy.querySelector('.btn-label');
    var done = function () {
      dom.setText(label, 'Copied');
      window.setTimeout(function () {
        dom.setText(label, 'Copy');
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () { /* the line is on screen to read */ });
    }
  }

  /* ---------- the transcript model ---------- */

  /* Blocks carry their own key, so trimming the head of a capped transcript does
     not renumber every row under the reconciler and rebuild the column. */
  function pushBlock(block) {
    seq += 1;
    block.key = 'b' + seq;
    blocks.push(block);
    if (blocks.length > TRANSCRIPT_CAP) blocks.splice(0, blocks.length - TRANSCRIPT_CAP);
    renderAll();
    return block;
  }

  /* A note from the child's own stderr is kept, quietly, and it does not make
     a conversation: the card stays until somebody has actually said something. */
  function hasConversation() {
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].type !== 'note') return true;
    }
    return false;
  }

  function said(text, state) {
    openSteps = null;
    var block = pushBlock({ type: 'said', text: text, state: state || 'sent' });
    startTurnBar();
    return block;
  }

  /* The pending row this event is the receipt for, newest first. Matching on
     the text is enough and matching on more would be wrong: the server echoes
     the string it stored, and two identical prompts sent in a row are two rows
     that each want a receipt, so the newest unconfirmed one takes it. */
  function adoptPending(text) {
    for (var i = blocks.length - 1; i >= 0; i -= 1) {
      var block = blocks[i];
      if (block.type !== 'said') continue;
      if (block.state !== 'pending') continue;
      if (block.text !== text) continue;
      block.state = 'sent';
      return block;
    }
    return null;
  }

  /* ---------- the turn ---------- */

  function startTurnBar() {
    turn = { startedAt: Date.now(), state: 'thinking', label: '' };
    renderAll();
  }

  function endTurnBar() {
    turn = null;
    renderAll();
  }

  /* WHAT THE BAR SAYS, and what it deliberately does not. The step row
     already names the call and times it, so the bar carries what the
     transcript cannot, which is the state of the TURN: "still going, and for
     how long". */
  function turnLine() {
    if (!turn) return '';
    if (turn.state === 'writing') return 'writing the answer';
    if (turn.state === 'calling') return 'working';
    return 'thinking';
  }

  function stepsBlock() {
    if (openSteps && blocks.indexOf(openSteps) !== -1) return openSteps;
    openSteps = pushBlock({ type: 'steps', steps: [], folded: false, done: false });
    return openSteps;
  }

  function openStep(name, at, input) {
    var block = stepsBlock();
    seq += 1;
    var step = {
      id: 's' + seq,
      name: name,
      label: toolLabel(name),
      args: argsLabel(input),
      input: scalarArgs(input),
      leaves: leavesMachine(name),
      state: 'live',
      startedAt: at,
      endedAt: null,
      announce: true
    };
    block.steps.push(step);
    return step;
  }

  function closeStep(name, ok, at) {
    if (!openSteps) return null;
    var steps = openSteps.steps;
    for (var i = steps.length - 1; i >= 0; i -= 1) {
      var step = steps[i];
      if (step.state !== 'live') continue;
      if (step.name !== name) continue;
      step.state = ok === false ? 'error' : 'done';
      step.endedAt = at;
      step.announce = true;
      return step;
    }
    return null;
  }

  function elapsedOf(step, now) {
    var end = step.endedAt === null ? now : step.endedAt;
    return Math.max(0, end - step.startedAt);
  }

  /* One decimal up to a hundred seconds, whole seconds above it. A research call
     that ran for two minutes reads as a number rather than as a stopwatch. */
  function secondsText(ms) {
    var s = Math.max(0, ms) / 1000;
    return (s < 100 ? s.toFixed(1) : String(Math.round(s))) + ' s';
  }

  function anyError(block) {
    for (var i = 0; i < block.steps.length; i += 1) {
      if (block.steps[i].state === 'error') return true;
    }
    return false;
  }

  function foldLabel(block, now) {
    var steps = block.steps;
    if (!steps.length) return '';
    var first = steps[0].startedAt;
    var last = first;
    for (var i = 0; i < steps.length; i += 1) {
      var end = steps[i].endedAt === null ? now : steps[i].endedAt;
      if (end > last) last = end;
    }
    var count = steps.length === 1 ? '1 step' : steps.length + ' steps';
    return count + ', ' + secondsText(last - first);
  }

  /* What the folded turn did, by name: the phrases of its calls, once each. */
  function foldNames(block) {
    var cards = window.PhosphorCards;
    if (cards && typeof cards.foldNames === 'function') return cards.foldNames(block.steps);
    var out = [];
    for (var i = 0; i < block.steps.length; i += 1) {
      if (out.indexOf(block.steps[i].label) === -1) out.push(block.steps[i].label);
    }
    return out.join(', ');
  }

  /* ---------- state ---------- */

  /* HOW LONG "STARTING" HAS TO BE ON SCREEN, and this is not a fake progress bar.

     The driver reports ready on the child's `spawn` event rather than on its
     init event, deliberately (see the note in src/driver.ts), so the whole
     start is a couple of hundred milliseconds. The state is real and it is
     over before a person can see it: pressing Start flashed one frame of
     something and landed on the answer, which reads as nothing having
     happened at all.

     So the transition OUT of starting waits for a floor. Nothing is invented
     and nothing is measured that is not real: the app is not pretending to work
     for 450 ms, it is making a change that already happened legible to the eye
     that was watching for it. A failure waits the same beat, because a Start
     button that flickers into an error is worse than one that takes a moment
     and then says what went wrong. */
  var STARTING_FLOOR_MS = 450;
  var startingAt = 0;
  var floorTimer = 0;
  var startTimer = 0;

  function clearStartWatch() {
    if (!startTimer) return;
    window.clearTimeout(startTimer);
    startTimer = 0;
  }

  /* Armed whenever the column enters starting, from a click here or from a
     frame the app sent, and disarmed by the first thing that proves the start
     is alive: a phase change, or any event of the conversation. */
  function armStartWatch() {
    clearStartWatch();
    startTimer = window.setTimeout(function () {
      startTimer = 0;
      if (phase !== 'starting') return;
      fail(COPY.noAnswer, '');
    }, START_TIMEOUT_MS);
  }

  function setPhase(next, word) {
    if (next !== 'starting') clearStartWatch();
    if (floorTimer) {
      window.clearTimeout(floorTimer);
      floorTimer = 0;
    }
    if (phase === 'starting' && next !== 'starting') {
      var waited = Date.now() - startingAt;
      if (waited < STARTING_FLOOR_MS) {
        floorTimer = window.setTimeout(function () {
          floorTimer = 0;
          applyPhase(next, word);
        }, STARTING_FLOOR_MS - waited);
        return;
      }
    }
    if (next === 'starting' && phase !== 'starting') {
      startingAt = Date.now();
      armStartWatch();
    }
    applyPhase(next, word);
  }

  function applyPhase(next, word) {
    var changed = phase !== next;
    /* Coming up and then arriving is the one transition a person was watching,
       so it is the one that hands them the caret. Keyed on `starting` rather
       than on canTalk() so a window that loads with an agent already running
       does not take focus off whatever they were doing. */
    var arrived = phase === 'starting' && (next === 'connected' || next === 'working');
    var settled = phase === 'working' && next !== 'working';
    phase = next;
    /* The sheet belongs to nobody being at the wheel. Somebody arriving, or
       on the way, closes it. */
    if (!canStart()) view = 'card';
    renderAll();
    if (arrived) focusComposer();
    if (arrived) sendQueued();
    else if (next === 'error' || next === 'idle') queued = null;
    if (settled) settleRing();
    window.PhosphorShell.updateField();
    /* The world reads the assistant's state to write its own hero sentence, and
       polling a getter on every heartbeat frame is a read the event replaces. */
    if (changed) announcePhase();
  }

  function announcePhase() {
    if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('phosphor:agent-phase', { detail: { phase: phase } }));
  }

  /* THE SETTLE. When the work ends the seat light stops breathing, and one
     ring leaves it: a phosphor pixel that was lit and is decaying, half a
     second on the spring. It runs once per turn, on the frame the verb goes
     back to "Ready", and it is the Web Animations API rather than a class so
     nothing has to be cleaned up: the ring is transparent again the moment
     it is done. Under reduced motion the dot simply stops. */
  var RING_MS = 500;

  function settleRing() {
    var motion = window.PhosphorMotion;
    if (motion.reduced()) return;
    var ease = motion.spring();
    for (var i = 0; i < mounts.length; i += 1) {
      var ring = mounts[i].refs.ring;
      if (!ring || typeof ring.animate !== 'function') continue;
      ring.animate([
        { transform: 'scale(1)', opacity: 0.6 },
        { transform: 'scale(1.6)', opacity: 0 }
      ], { duration: RING_MS, easing: ease });
    }
  }

  function announceStep(step, dot) {
    if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('phosphor:step', {
      detail: { id: step.id, name: step.name, state: step.state, node: dot, input: step.input }
    }));
  }

  /* ---------- render ---------- */

  /* Set by the one render that must end at the bottom whatever the scroll
     position was: the person's own message going in. */
  var jumpAll = false;

  function renderAll() {
    for (var i = 0; i < mounts.length; i += 1) render(mounts[i], i === 0);
    jumpAll = false;
    flushSteps();
    tickerCheck();
  }

  /* The step event carries the row's own dot, so the beam has something to fly
     from. It goes out after the render that built the row and from the first
     mount only: one tool call is one flight however many columns are on screen. */
  function flushSteps() {
    for (var i = 0; i < announced.length; i += 1) {
      announceStep(announced[i].step, announced[i].dot);
    }
    announced.length = 0;
  }

  function render(node, primary) {
    var refs = node.refs;
    node.live = [];

    var now = Date.now();
    dom.setAttr(refs.status, 'data-state', stateAttr());
    dom.setText(refs.verb, statusVerb());
    var since = statusStartedAt();
    dom.setHidden(refs.elapsed, !since);
    if (since) dom.setText(refs.elapsed, secondsText(now - since));

    var empty = !hasConversation();
    var failed = failure !== null && canStart();

    /* The failure line and its Retry. While it is up it is the one way to
       start again, so the head's Start stays out of its way. */
    dom.setHidden(refs.note, !failed);
    dom.setText(refs.noteText, failed ? failure.reason : '');
    dom.setAttr(refs.note, 'title', failed && failure.detail ? failure.detail : null);
    dom.setAttr(refs.status, 'data-failed', failed ? 'true' : null);

    /* The card already asks once, in the middle of the column, and two Start
       buttons on one screen is the window asking twice. The head's copy takes
       over the moment there is a transcript to keep company. */
    dom.setHidden(refs.start, empty || failed || !canStart());
    dom.setHidden(refs.stopAgent, !canTalk());

    var sheet = view === 'connect' && empty && canStart();
    dom.setHidden(refs.sheet, !sheet);
    dom.setHidden(refs.empty, !empty || sheet);
    dom.setHidden(refs.listWrap, empty);
    if (empty && !sheet) renderEmpty(node);
    if (sheet) renderSheet(node);

    /* The composer is on screen only while the built-in assistant can take a
       message. Off, starting and failed all have the card saying what to do
       instead, and an attached client of the person's own is talked to from
       its own terminal, so a dead box under it was a question with no answer. */
    dom.setHidden(refs.composer, !canTalk());
    refs.input.disabled = !canTalk();
    refs.send.disabled = !canTalk();
    var stopping = phase === 'working';
    dom.setAttr(refs.field, 'data-mode', stopping ? 'stop' : null);
    dom.setAttr(refs.send, 'aria-label', stopping ? 'Stop this answer' : 'Send');
    refs.send.title = stopping ? 'Stop this answer' : 'Send';
    arm(node);

    dom.setHidden(refs.turnBar, !turn);
    if (turn) {
      dom.setText(refs.turnWhat, turnLine());
      dom.setText(refs.turnTime, secondsText(now - turn.startedAt));
      dom.setAttr(refs.turnBar, 'data-state', turn.state);
    }

    /* WHERE THE SCROLL GOES. Read before the rows change: at the end (or
       still easing there, or their own message going in) means the column
       follows the new row down, smoothly. Anywhere else means the person is
       reading, so nothing moves and the pill counts what they have not seen.
       A render that changed no content (a phase word, the roster) is not an
       arrival and scrolls nothing. */
    var stuck = jumpAll || node.followUntil > now || atEnd(refs.list);
    renderBlocks(node, primary);
    var mark = contentMark();
    var arrived = mark !== node.mark;
    node.mark = mark;
    if (stuck) {
      node.unseen = 0;
      if (arrived) scrollToEnd(node);
    } else if (arrived) {
      node.unseen += 1;
    }
    paintJump(node);

    /* No line means the backend cannot name one, so the offer goes away with it.
       A button that reveals an empty block is worse than no button. */
    dom.setText(refs.line, connection.command || '');
    dom.setHidden(refs.connect, !connection.command);

    /* Somebody else's agents, while the built-in one is off. */
    dom.reconcile(refs.clients, ownAgents(), function (client, i) {
      return client.name + ':' + i;
    }, function () {
      var row = dom.el('div', 'agent-client');
      row.appendChild(dom.el('span', 'dot'));
      row.appendChild(dom.el('span', 'agent-client-name'));
      row.appendChild(dom.el('span', 'agent-client-calls mono'));
      return row;
    }, function (row, client) {
      var kids = row.children;
      dom.setText(kids[1], client.name + ', ' + (client.role === 'analyst' ? 'read only' : 'can ask'));
      dom.setText(kids[2], String(client.calls || 0) + ' calls');
    });
  }

  /* ---------- the scroll ---------- */

  function atEnd(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
  }

  /* What the transcript holds, as one string that changes when a row lands or
     a reply grows and stays the same across a redraw of the same rows. seq
     moves for every block and every step, and the tail's length catches the
     text that joins a reply already on screen. */
  function contentMark() {
    var tail = blocks[blocks.length - 1];
    var grow = tail && tail.type === 'reply' ? tail.text.length : 0;
    return blocks.length + ':' + seq + ':' + grow;
  }

  /* The follow: the scroller eases to the end (the browser's own smooth
     scroll, which runs off the main thread) and the column counts as at the
     end until it gets there. Under reduced motion it lands at once. */
  function scrollToEnd(node) {
    var list = node.refs.list;
    var motion = window.PhosphorMotion;
    var smooth = !(motion && motion.reduced());
    var top = Math.max(0, list.scrollHeight - list.clientHeight);
    node.lastTop = list.scrollTop;
    node.followUntil = smooth ? Date.now() + FOLLOW_MS : 0;
    if (typeof list.scrollTo === 'function') list.scrollTo({ top: top, behavior: smooth ? 'smooth' : 'auto' });
    else list.scrollTop = top;
  }

  /* The pill's jump is authored rather than the browser's: one ease-out over
     a third of a second, driven by motion.dev, so a long transcript reads as
     a place the column went back to rather than a cut. */
  function jumpToEnd(node) {
    var list = node.refs.list;
    var motion = window.PhosphorMotion;
    var top = Math.max(0, list.scrollHeight - list.clientHeight);
    node.unseen = 0;
    paintJump(node);
    if (!motion || motion.reduced() || typeof motion.animate !== 'function') {
      list.scrollTop = top;
      return;
    }
    node.lastTop = list.scrollTop;
    node.followUntil = Date.now() + FOLLOW_MS;
    motion.animate(list.scrollTop, top, {
      duration: JUMP_S,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: function (value) { list.scrollTop = value; }
    });
  }

  function paintJump(node) {
    var refs = node.refs;
    dom.setAttr(refs.jump, 'data-on', node.unseen > 0 ? 'true' : null);
    dom.setText(refs.jumpCount, node.unseen > 1 ? String(node.unseen) : '');
  }

  /* No, coming, and yes. The seat carries the state as an attribute so the
     stylesheet draws the light, and the two buttons are present only in the one
     state where pressing them means anything. A failed start is the off card
     with the mark in the down tone: the reason and the Retry are in the head,
     so the card offers only the other way in. */
  function renderEmpty(node) {
    var refs = node.refs;
    var seat = canTalk() ? 'live'
      : (phase === 'starting' ? 'coming' : (phase === 'error' ? 'error' : 'off'));
    var own = ownAgents().length > 0;
    dom.setAttr(refs.emptySeat, 'data-seat', seat === 'off' && own ? 'own' : seat);

    if (seat === 'live') {
      dom.setText(refs.emptyTitle, COPY.liveTitle);
      dom.setText(refs.emptyNote, COPY.liveLine);
    } else if (seat === 'coming') {
      dom.setText(refs.emptyTitle, COPY.comingTitle);
      dom.setText(refs.emptyNote, COPY.comingLine);
    } else if (own) {
      dom.setText(refs.emptyTitle, COPY.ownTitle);
      dom.setText(refs.emptyNote, COPY.ownLine);
    } else {
      dom.setText(refs.emptyTitle, COPY.offTitle);
      dom.setText(refs.emptyNote, COPY.offLine);
    }

    /* Offering Start to somebody whose agent is already running is the window
       asking a question it knows the answer to, and it was the whole reason
       pressing the button looked like it did nothing. */
    dom.setHidden(refs.emptyActions, !canStart());
    dom.setHidden(refs.startBig, phase === 'error');
  }

  function renderSheet(node) {
    var refs = node.refs;
    var attached = ownAgents().length > 0;
    dom.setAttr(refs.connectStatus, 'data-state', attached ? 'connected' : 'waiting');
    dom.setText(refs.connectVerb, attached ? COPY.connected : COPY.waiting);
  }

  /* The caret lands in the box the moment the box can take a message. It is the
     smallest possible change and it is the one a person feels: the window is
     ready and the next move is theirs. Only on the transition, so it never
     steals focus from somewhere else mid-session. */
  function focusComposer() {
    for (var i = 0; i < mounts.length; i += 1) {
      var input = mounts[i].refs.input;
      if (!input || input.disabled || typeof input.focus !== 'function') continue;
      input.focus();
      return;
    }
  }

  /* The transcript renders as text only, never as markup, and never renders a
     control that decides anything. That is the property that keeps the trust
     boundary where it is: nothing an assistant writes can draw a button that
     moves money. */
  function renderBlocks(node, primary) {
    var now = Date.now();
    dom.reconcile(node.refs.list, blocks, function (block) {
      return block.key;
    }, function (block) {
      return createBlock(block);
    }, function (row, block) {
      updateBlock(node, row, block, now, primary);
    });
  }

  /* A card's own open state lives on the block, so a person who closed one
     finds it closed after every re-render, and a receipt that arrives closes
     the ones before it (ui/screens/cards.js draws the shell). */
  function foldOptions(block) {
    return {
      name: block.name,
      input: block.input,
      at: block.at,
      open: block.open !== false,
      onToggle: function (open) { block.open = open; }
    };
  }

  function createBlock(block) {
    var cards = window.PhosphorCards;
    /* The shared receipt card, as a message from the app, in a shell it can
       close from. Without the shell file it is the bare card it always was. */
    if (block.type === 'receipt') {
      var receipt = window.PhosphorReceipt.card(block.receipt);
      return cards && typeof cards.wrapReceipt === 'function' ? cards.wrapReceipt(block.receipt, receipt, foldOptions(block)) : receipt;
    }
    /* A tool's answer, drawn. The data came off the driver's tool_data event
       and never through the model's words. */
    if (block.type === 'card') {
      var host = dom.el('div', 'chat-card');
      if (cards && typeof cards.render === 'function') host.appendChild(cards.render(block.kind, block.data, foldOptions(block)));
      return host;
    }
    if (block.type === 'steps') {
      var wrap = dom.el('div', 'steps-block');
      var fold = dom.el('button', 'steps-fold');
      fold.type = 'button';
      fold.hidden = true;
      fold.appendChild(cards && typeof cards.glyph === 'function' ? cards.glyph('chevron', 'steps-chevron') : dom.el('span', 'steps-chevron'));
      fold.appendChild(dom.el('span', 'steps-fold-label'));
      fold.appendChild(dom.el('span', 'steps-fold-names'));
      wrap.appendChild(fold);
      wrap.appendChild(dom.el('div', 'steps'));
      dom.on(fold, 'click', function () {
        block.folded = !block.folded;
        renderAll();
      });
      return wrap;
    }
    var kind = block.type === 'said' ? 'chat-said'
      : (block.type === 'error' ? 'chat-error'
        : (block.type === 'note' ? 'chat-note' : 'chat-reply'));
    var chat = dom.el('div', 'chat-row ' + kind);
    chat.appendChild(dom.el('span', 'chat-who'));
    /* A reply is rendered, the others are set as text. The renderer is the
       one place a reply's shape is decided, and it builds elements and sets
       strings: nothing a model writes reaches the DOM as markup. */
    chat.appendChild(dom.el('div', block.type === 'reply' ? 'chat-text md' : 'chat-text'));
    /* A reply carries the app's mark at its top left and the clock it landed
       at, which the stylesheet shows on hover. Both after the text, so the
       who and the text keep their places for the update below. */
    if (block.type === 'reply') {
      var mark = dom.mark('chat-mark');
      if (mark) chat.appendChild(mark);
      chat.__time = chat.appendChild(dom.el('span', 'chat-time mono'));
    }
    return chat;
  }

  function clockOf(at) {
    if (typeof at !== 'number' || !isFinite(at)) return '';
    return dom.clock(new Date(at).toISOString());
  }

  function updateBlock(node, row, block, now, primary) {
    if (block.type === 'receipt' || block.type === 'card') {
      /* The shell keeps its own open flag and the block keeps the truth. */
      var cards = window.PhosphorCards;
      var fold = cards && typeof cards.foldOf === 'function' ? cards.foldOf(block.type === 'card' ? row.firstChild : row) : null;
      if (fold && fold.isOpen() !== (block.open !== false)) fold.setOpen(block.open !== false);
      return;
    }
    if (block.type === 'steps') {
      updateSteps(node, row, block, now, primary);
      return;
    }
    var who = row.children[0];
    var text = row.children[1];
    if (block.type === 'said') {
      /* The bubble sits on the right, so it needs no name. The one thing
         worth a label is a message the app never took. */
      dom.setText(who, block.state === 'failed' ? 'Not sent' : 'You');
      dom.setText(text, block.text);
      dom.setAttr(row, 'data-state', block.state || 'sent');
      return;
    }
    if (block.type === 'error') {
      dom.setText(who, 'The app');
      dom.setText(text, block.text);
      return;
    }
    if (block.type === 'note') {
      dom.setText(who, 'Note');
      dom.setText(text, block.text);
      return;
    }
    dom.setText(who, 'Assistant');
    if (row.__time) dom.setText(row.__time, clockOf(block.at));
    renderReply(text, block.text);
  }

  /* Rendered once per change of text, not once per pass: the reconciler calls
     update on every render and a table rebuilt on each tick of the turn clock
     would be the column doing work for nobody.

     A reply grows by whole blocks, joined on a blank line (ingest). When the
     new text is the old text with more under it, only the new blocks are
     drawn, under the paragraphs already there: the row keeps what it had
     rather than being emptied and rebuilt for every block that lands. */
  function renderReply(node, value) {
    var md = window.PhosphorMarkdown;
    if (!md) {
      dom.setText(node, value);
      return;
    }
    if (node.__md === value) return;
    var had = node.__md;
    node.__md = value;
    if (typeof had === 'string' && had !== '' && typeof md.appendInto === 'function' && value.indexOf(had + '\n\n') === 0) {
      md.appendInto(node, value.slice(had.length + 2));
      return;
    }
    md.renderInto(node, value);
  }

  function updateSteps(node, wrap, block, now, primary) {
    var fold = wrap.children[0];
    var list = wrap.children[1];
    dom.setHidden(fold, !block.done);
    /* A folded turn that hid a failed call would look like a turn that worked.
       The one row left on screen carries the worst outcome under it. */
    dom.setAttr(fold, 'data-state', block.done && anyError(block) ? 'error' : null);
    dom.setText(fold.children[1], block.done ? foldLabel(block, now) : '');
    dom.setText(fold.children[2], block.done ? foldNames(block) : '');
    dom.setAttr(fold, 'aria-expanded', block.folded ? 'false' : 'true');
    dom.setAttr(list, 'data-folded', block.folded ? 'true' : null);

    dom.reconcile(list, block.steps, function (step) {
      return step.id;
    }, function () {
      var step = dom.el('div', 'step');
      step.appendChild(dom.el('span', 'step-dot'));
      var text = dom.el('span', 'step-text');
      text.appendChild(dom.el('span', ''));
      text.appendChild(dom.el('span', 'step-args'));
      text.appendChild(dom.el('span', 'step-leaves'));
      step.appendChild(text);
      step.appendChild(dom.el('span', 'step-time'));
      return step;
    }, function (row, step) {
      var dot = row.children[0];
      var text = row.children[1];
      var time = row.children[2];
      dom.setAttr(row, 'data-state', step.state);
      dom.setText(text.children[0], step.label);
      dom.setText(text.children[1], step.args || '');
      dom.setHidden(text.children[1], !step.args);
      dom.setText(text.children[2], step.leaves ? 'leaves this computer' : '');
      dom.setHidden(text.children[2], !step.leaves);
      /* The head carries the live clock; the row gets its duration once the
         call has settled, so the same seconds do not count in two places one
         screen apart. The row still books itself as live so the ticker runs
         for the head, and the row's own time lands with the result. */
      dom.setText(time, step.state === 'live' ? '' : secondsText(elapsedOf(step, now)));
      if (step.state === 'live') node.live.push(step);
      if (primary && step.announce) {
        step.announce = false;
        announced.push({ step: step, dot: dot });
      }
    });
  }

  /* One interval, and only while something is in flight. A clock that keeps
     running behind a finished turn is the window doing work for nobody. */
  function tickerCheck() {
    var live = turn !== null;
    for (var i = 0; i < mounts.length && !live; i += 1) {
      if (mounts[i].live.length) live = true;
    }
    if (live && !ticker) {
      ticker = window.setInterval(tick, TICK_MS);
      return;
    }
    if (!live && ticker) {
      window.clearInterval(ticker);
      ticker = 0;
    }
  }

  /* Text writes only. The rows already exist, so the tick touches no layout. */
  function tick() {
    var now = Date.now();
    var since = statusStartedAt();
    for (var i = 0; i < mounts.length; i += 1) {
      if (turn) dom.setText(mounts[i].refs.turnTime, secondsText(now - turn.startedAt));
      if (since) dom.setText(mounts[i].refs.elapsed, secondsText(now - since));
    }
  }

  /* ---------- wiring ---------- */

  /* Off and stopped are both nobody at the wheel. The composer used to stay
     open after Turn off because stopped read as connected, and the first
     message into it came back "not sent". */
  function mapState(word) {
    if (word === 'off' || word === 'stopped' || !word) return 'idle';
    if (word === 'booting' || word === 'starting') return 'starting';
    if (word === 'working' || word === 'thinking') return 'working';
    if (word === 'error' || word === 'failed') return 'error';
    return 'connected';
  }

  /* One driver event, one change to the model. `replay` is the boot restore
     reading a stored transcript: the same shapes, an older clock, and no timers,
     because a thinking row 300 ms after a message from last week is a lie. */
  function ingest(event, replay) {
    var at = typeof event.at === 'number' ? event.at : Date.now();
    if (event.kind === 'status') {
      if (replay) return;
      /* A stopped answer, a failed session and a plain return to ready all end
         the turn. Without this the bar kept counting for an agent that was no
         longer working, which is the one lie it exists to prevent. */
      var next = mapState(event.state);
      if (next !== 'working' && next !== 'starting') {
        endTurn();
        turn = null;
      }
      /* The reason travels on the frame in plain words (src/driver.ts). A
         failed start always has one; an exit the person did not ask for has
         one; a stop they asked for has none and clears nothing but the seat. */
      if (next === 'error') {
        failure = { reason: event.reason || COPY.failedUnsaid, detail: event.detail || '' };
      } else if (next === 'idle' && event.reason) {
        failure = { reason: event.reason, detail: event.detail || '' };
      } else if (next === 'starting' || next === 'connected' || next === 'working') {
        failure = null;
      }
      setPhase(next, event.state);
      return;
    }
    /* Anything the conversation does is proof the start is alive. */
    clearStartWatch();
    if (event.kind === 'said') {
      if (replay) {
        openSteps = null;
        pushBlock({ type: 'said', text: event.text, state: 'sent' });
      } else if (!adoptPending(event.text)) {
        /* Nothing to adopt means the prompt came from somewhere else: a second
           window on the same chat, or the app replaying a restored session. It
           is still this conversation's message, so it goes in. */
        said(event.text);
      } else {
        startTurnBar();
      }
      return;
    }
    if (event.kind === 'tool') {
      if (phase === 'connected') phase = 'working';
      if (!replay && !turn) startTurnBar();
      openStep(event.name, at, event.input);
      if (turn) turn.state = 'calling';
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'tool_result') {
      closeStep(event.name, event.ok, at);
      if (turn) turn.state = 'thinking';
      if (!replay) renderAll();
      return;
    }
    /* A read's answer, as data (src/driver.ts). It goes in as a card under
       the steps that produced it, and the steps close there, so the next
       call opens its own fold under the card rather than above it. */
    if (event.kind === 'tool_data') {
      var cards = window.PhosphorCards;
      if (!cards || typeof cards.kindFor !== 'function') return;
      openSteps = null;
      pushBlock({
        type: 'card',
        kind: cards.kindFor(event.name, event.data),
        name: event.name,
        input: event.input,
        data: event.data,
        at: at,
        open: true
      });
      return;
    }
    if (event.kind === 'text') {
      if (phase === 'connected') phase = 'working';
      if (turn) turn.state = 'writing';
      openSteps = null;
      /* One turn's text arrives in pieces, one per model block, and each used
         to be its own row: a heading, then its table, then the sentence under
         it, three rows apart. Text that follows text with nothing between them
         is the same reply, so it joins the row that is already there. */
      var tail = blocks[blocks.length - 1];
      if (tail && tail.type === 'reply') {
        tail.text += '\n\n' + String(event.text);
        if (!replay) renderAll();
        return;
      }
      pushBlock({ type: 'reply', text: event.text, at: at });
      return;
    }
    if (event.kind === 'turn_end') {
      endTurn();
      turn = null;
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'error') {
      turn = null;
      /* The technical line of a failure the status frame already named in
         words. The head carries the reason; printing the driver's own string
         under it as a row is the thing that used to bury the card. Everything
         else on this channel is the child's stderr, kept as a quiet note. */
      if (failure && failure.detail && failure.detail === String(event.message)) return;
      pushBlock({ type: 'note', text: event.message });
      return;
    }
  }

  /* WHICH RECEIPTS GET A CARD. The list arrives whole on every read, newest
     first, so the column keeps the ids it has already seen and cards only an
     executed receipt it has not. The first read seeds that set: everything in
     it happened before this window opened and is Activity's to show, unless
     it was decided after the window opened, which is a move made in this
     session that landed while the list was still loading. A failed move is
     not a receipt for something that happened, so it gets no card and is not
     marked seen, and a card follows if it is later read back as executed. */
  var bootAt = Date.now();
  var receiptsSeen = null;

  function receiptAt(receipt) {
    var at = Date.parse(String(receipt.at || ''));
    return isFinite(at) ? at : 0;
  }

  function onReceipts(list, state) {
    if (state !== 'ready' || !Array.isArray(list)) return;
    var first = receiptsSeen === null;
    if (first) receiptsSeen = Object.create(null);
    var fresh = [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      var receipt = list[i];
      if (!receipt || typeof receipt.id !== 'string' || receiptsSeen[receipt.id]) continue;
      if (receipt.status !== 'executed') continue;
      receiptsSeen[receipt.id] = true;
      if (first && receiptAt(receipt) <= bootAt) continue;
      fresh.push(receipt);
    }
    for (var j = 0; j < fresh.length; j += 1) {
      /* The card closes the open steps block, so the calls that follow it
         start a new one under the card rather than appending above it. */
      openSteps = null;
      pushReceipt(fresh[j], receiptWhen(fresh[j]));
    }
  }

  function receiptWhen(receipt) {
    var when = receiptAt(receipt);
    return when > 0 ? when : Date.now();
  }

  /* The newest receipt is the one a person is looking for, so it opens; the
     ones before it fold to their one line. */
  function pushReceipt(receipt, when) {
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].type === 'receipt') blocks[i].open = false;
    }
    return pushBlock({ type: 'receipt', receipt: receipt, at: when, open: true });
  }

  /* A receipt opened anywhere in the window (an Activity row, a Done fill)
     posts the same card into the thread, as a message from the app. */
  function onReceiptOpen(payload) {
    var receipt = payload && payload.receipt;
    if (!receipt || typeof receipt !== 'object') return;
    openSteps = null;
    pushReceipt(receipt, receiptWhen(receipt));
  }

  /* A finished turn folds to one line. Any step still open when the turn ended
     is closed rather than left ticking: the answer arrived, so the call did. */
  function endTurn() {
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (block.type !== 'steps' || block.done) continue;
      for (var j = 0; j < block.steps.length; j += 1) {
        var step = block.steps[j];
        if (step.state !== 'live') continue;
        step.state = 'done';
        step.endedAt = Date.now();
        step.announce = true;
      }
      block.done = true;
      block.folded = true;
    }
    openSteps = null;
  }

  /* The roster, as the state frame carries it: the clients attached over
     MCP, named by themselves. Text, never markup. */
  function onAgents(slice) {
    var members = slice && Array.isArray(slice.members) ? slice.members : [];
    var next = [];
    for (var i = 0; i < members.length; i += 1) {
      var m = members[i] || {};
      next.push({
        name: String(m.client || m.label || m.session || 'an agent'),
        role: String(m.role || ''),
        calls: typeof m.ops === 'number' ? m.ops : 0
      });
    }
    roster = next;
    renderAll();
  }

  function start() {
    events.on('driver', function (frame) {
      var event = frame && frame.event;
      if (!event) return;
      /* One column, one conversation. The stream carries every chat the app has
         open and the tagged frames were being read untagged, so a second
         conversation printed its tool calls here and lit this window's panels
         for work this agent never did. */
      var from = frame.chat === undefined ? null : String(frame.chat);
      if (from !== null) {
        if (chatId === null) chatId = from;
        if (chatId !== from) return;
      }
      ingest(event, false);
    });

    events.on('receipt:open', onReceiptOpen);

    api.driverState().then(function (result) {
      var data = result.data || {};
      var chat = (data.chats && data.chats[0]) || {};
      /* The payload names an empty id when no chat is open yet, and adopting
         that would filter out the real one the moment it starts. */
      if (chat.id) chatId = String(chat.id);
      if (Array.isArray(chat.transcript)) {
        for (var i = 0; i < chat.transcript.length; i += 1) ingest(chat.transcript[i], true);
        endTurn();
      }
      setPhase(mapState(data.state), data.state);
    }).catch(function () { /* the column shows Off, which is true */ });

    api.connection().then(function (data) {
      if (!data || data.missing) return;
      connection = { command: typeof data.command === 'string' ? data.command : '' };
      renderAll();
    }).catch(function () { /* the sheet hides its offer when there is none */ });

    var store = window.PhosphorState;
    if (store && typeof store.select === 'function') store.select('agents', onAgents);

    /* The receipts, read once now to learn what already happened and then on
       every transactions frame (ui/screens/receipts.js), so a move that lands
       mid conversation shows up as a card in it. */
    var feed = window.PhosphorReceipts;
    if (feed && typeof feed.onChange === 'function') {
      feed.onChange(onReceipts);
      if (typeof feed.load === 'function') feed.load();
    }
  }

  window.PhosphorAgent = {
    mount: mount,
    start: start,
    isWorking: isWorking,
    phase: function () { return phase; },
    toolLabel: toolLabel
  };
})();
