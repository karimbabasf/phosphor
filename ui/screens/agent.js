/* The conversation column. It is on screen in every mode, in the same place,
   and it is the product: what a person asked, what the assistant did to answer,
   and what it said back.

   Two properties keep it safe and neither is a tidiness preference. Nothing the
   assistant writes reaches the DOM as markup, and this file draws no control
   that decides anything. An approval is a physical click on the dock below,
   which is drawn from server state, so a transcript row cannot impersonate one.

   The column never calls the beam either. Every step row dispatches
   phosphor:step on window and ui/beam/trace.js decides what lights up, so the
   transcript keeps working in a window where the beam file is not there. */
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
    /* the human's own profile */
    profile_learned: 'noting what you learned',
    /* asking. None of these moves anything: each puts a request in the gate. */
    propose_consolidate: 'asking to consolidate',
    propose_swap: 'asking to swap',
    propose_intents_deposit: 'asking to deposit',
    propose_intents_withdraw: 'asking to withdraw',
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
    'chain', 'toChain', 'venue', 'label', 'text', 'sentence', 'what', 'source', 'id'
  ];
  var ARG_MAX = 38;

  var TRANSCRIPT_CAP = 400;
  var TICK_MS = 100;
  var STICK_PX = 40;
  /* Six lines, and the line's height is read off the box rather than written
     down here: the fallback is only for a computed style that says `normal`. */
  var COMPOSER_MAX_LINES = 6;
  var COMPOSER_LINE_FALLBACK_PX = 21;

  /* What the box says while it cannot be used, and what it says when it can.
     The first is the sentence that used to sit under the box as a note. */
  var PLACEHOLDER_OFF = 'Start your assistant to talk to it.';
  var PLACEHOLDER_STARTING = 'Starting your assistant.';
  var PLACEHOLDER_ON = 'Tell your assistant what to do.';

  /* The three first moves on the empty card. Each is a question this window
     answers from what it already holds, in the words a person would use. */
  var SUGGESTIONS = ['What do I hold?', 'Is anything waiting on me?', 'Find a trade on BTC'];

  /* One glyph, drawn here: the send arrow. A path on a 16 box in the current
     colour at 1.5 px, built in the svg namespace the way dom.mark builds the
     logo, and null where there is no namespace to build in. */
  var GLYPH_ARROW_UP = 'M8 12.75V3.25M3.75 7.5L8 3.25l4.25 4.25';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* THE RECEIPT CARD. When a move this app made lands as a receipt
     (src/http/receipts.ts, read through ui/screens/receipts.js), the
     transcript shows one card drawn from that receipt and never from the
     assistant's prose: the headline sentence Activity shows, one line of what
     arrived and what it cost, and the id. Karim, 2026-09-14: "when trades
     happen I dont want to see this, I want to see a nice card, simple, no
     unnecessary info, and the intent id should be a clickable link".

     The id opens the explorer only where the receipt carries a url for it,
     and the server decides that (src/transactions.ts): a chain hash opens its
     chain's explorer, an intent hash opens the swap's page on the NEAR
     Intents explorer, which is keyed by the deposit address the rail wrote
     into its evidence sentence, and an id with no page is copied rather than
     opened. Where money lands, in the owner's words. */
  var WHERE = { intents: 'in your NEAR Intents balance', hyperliquid: 'in your trading account' };

  function whereText(place) {
    var key = String(place || '');
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(WHERE, key)) return WHERE[key];
    var names = window.PhosphorReceipt;
    var chain = names && typeof names.chainName === 'function' ? names.chainName(key) : key;
    return 'on ' + chain;
  }

  function receiptLine(receipt) {
    var parts = [];
    var got = receipt.received;
    if (got && typeof got.amount === 'number' && got.symbol) {
      parts.push(dom.qty(got.amount) + ' ' + String(got.symbol) + ' received');
    }
    if (typeof receipt.feesUsd === 'number') {
      parts.push(receipt.feesUsd > 0 ? 'fee about ' + dom.fee(receipt.feesUsd) : 'no fee');
    }
    var where = whereText(receipt.toChain);
    if (where) parts.push(where);
    return parts.join(', ');
  }

  /* The first six and the last four: enough to match against a wallet or an
     explorer by eye, and the whole id is one hover or one Copy away. */
  function shortId(hash) {
    var text = String(hash);
    return text.length > 14 ? text.slice(0, 6) + '...' + text.slice(-4) : text;
  }

  function glyph(path, className) {
    if (typeof document.createElementNS !== 'function') return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', path);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
    return svg;
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
    if (joined.length > ARG_MAX) joined = joined.slice(0, ARG_MAX - 1).replace(/\s+\S*$/, '') + '…';
    return joined;
  }

  var mounts = [];
  var blocks = [];
  var seq = 0;
  var phase = 'idle';
  var serverWord = 'off';
  var detail = '';
  var connection = { command: '', connected: [] };
  var openSteps = null;
  var ticker = 0;
  var announced = [];

  /* THE TURN, and why it is not a transcript row.

     The old build put a "thinking" row in the transcript, removed it the moment
     any frame arrived, and never brought it back. So the two longest silences
     in a turn were the two with nothing on screen: before the first tool call,
     and after the last one while the answer is being written. A person watching
     that has no way to tell a working agent from a dead one.

     This is one line that lives between the transcript and the composer, from
     the moment a prompt goes out until the turn ends. It does not scroll away,
     it names what is happening now in the same words the step rows use, and it
     carries the turn's own clock. Three states, each one an event rather than a
     guess: `thinking` (sent, nothing back yet), `calling` (a tool is open) and
     `writing` (text has arrived and no tool is open).

     Since 2026-09-14 the seat light in the head shows the same thing (the
     verb and the clock come from this same record), so the bar is clipped
     out of sight by the stylesheet and kept as the live region a screen
     reader hears. The record is the source for both. */
  var turn = null;

  /* WHICH CONVERSATION THIS COLUMN IS. The stream carries every chat's events
     and the app opens up to four, so an untagged reader printed another
     conversation's tool calls into this one and fired the beam for work this
     agent never did. The column adopts the first chat it hears from and
     ignores the rest. */
  var chatId = null;

  /* Five phases for the rest of the window, six words for the person. `ready`
     and `stopped` are both a live assistant that is not answering, so they share
     a phase, and only the status line tells them apart. */
  var STATE_WORDS = {
    idle: 'Off',
    starting: 'Starting',
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
    if (phase === 'connected' && serverWord === 'stopped') return 'stopped';
    return STATE_ATTR[phase] || 'off';
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
    if (phase === 'connected' && serverWord === 'stopped') return 'Stopped';
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

  /* ---------- mount ---------- */

  function mount(host, options) {
    if (!host) return null;
    var opts = options || {};
    var node = { host: host, composerHost: opts.composerHost || null, refs: {}, live: [] };
    build(node);
    mounts.push(node);
    render(node, mounts.length === 1);
    return node;
  }

  function build(node) {
    var host = node.host;
    dom.clear(host);

    var head = dom.el('div', 'between agent-head');
    var title = dom.el('div', 'agent-title');
    title.appendChild(dom.el('span', 'title-sm', 'Assistant'));
    /* THE SEAT LIGHT. One status line beside the name, in the shared grammar
       (components.css): a 6 px dot, the verb, and the seconds. The dot is
       still while nobody is working and breathes while a call is open; the
       verb is the state word until a tool runs, and then the tool's own
       words. It replaced a pill that said "Working" in a border, which was a
       label about the state rather than the state itself. The id is how the
       beam finds it: ui/beam/beam.js sets data-live on it while it holds a
       surface, and this file never writes that attribute. */
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

    /* Two controls that used to read as one: "Stop the answer" and "Stop"
       side by side were the same word twice. The one a person reaches for
       while an answer is running is Stop, and it stops the answer; turning
       the assistant off is the rarer, larger act, so it is a quiet text
       button with the verb that says what it does. */
    var controls = dom.el('div', 'hstack-2');
    var start = dom.el('button', 'btn btn-primary btn-sm');
    start.appendChild(dom.el('span', 'btn-label', 'Start your assistant'));
    var stopAnswer = dom.el('button', 'btn btn-ghost btn-sm');
    stopAnswer.title = 'Stop this answer';
    stopAnswer.appendChild(dom.el('span', 'btn-label', 'Stop'));
    var stopAgent = dom.el('button', 'btn btn-quiet btn-sm');
    stopAgent.title = 'Turn your assistant off';
    stopAgent.appendChild(dom.el('span', 'btn-label', 'Turn off'));
    controls.appendChild(start);
    controls.appendChild(stopAgent);
    controls.appendChild(stopAnswer);
    head.appendChild(controls);
    host.appendChild(head);

    /* Who else is holding the reins. A second client that can ask for money is
       not a detail, so it is named under the head rather than behind a fold. */
    var clients = dom.el('div', 'agent-clients');
    host.appendChild(clients);

    var detailLine = dom.el('p', 'meta agent-detail');
    host.appendChild(detailLine);

    /* THE EMPTY STATE, AND WHY IT HAS THREE OF THEM NOW.

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
    /* The seat is the mark (Karim, 2026-09-14: the ring and its dot gave way
       to the logo). It keeps the seat's three answers by colour: grey when
       nobody is there, waking while one comes up, lit once one is. */
    var emptySeat = dom.el('div', 'agent-seat');
    emptySeat.setAttribute('aria-hidden', 'true');
    var seatMark = dom.mark('agent-seat-mark');
    if (seatMark) emptySeat.appendChild(seatMark);
    emptyInner.appendChild(emptySeat);
    var emptyTitle = dom.el('p', 'title-sm agent-empty-title', 'Nobody is at the wheel.');
    var emptyNote = dom.el('p', 'meta', 'Start your assistant, or connect one you already use.');
    emptyInner.appendChild(emptyTitle);
    emptyInner.appendChild(emptyNote);
    var emptyActions = dom.el('div', 'agent-empty-actions');
    var startBig = dom.el('button', 'btn btn-primary');
    startBig.appendChild(dom.el('span', 'btn-label', 'Start your assistant'));
    var connectBtn = dom.el('button', 'btn btn-quiet');
    connectBtn.appendChild(dom.el('span', 'btn-label', 'Connect your own'));
    emptyActions.appendChild(startBig);
    emptyActions.appendChild(connectBtn);
    emptyInner.appendChild(emptyActions);

    var connectBlock = dom.el('div', 'connection-block');
    connectBlock.hidden = true;
    var row = dom.el('div', 'connection-row');
    var line = dom.el('code', 'connection-line');
    var copy = dom.el('button', 'btn btn-ghost btn-sm');
    copy.type = 'button';
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    row.appendChild(line);
    row.appendChild(copy);
    connectBlock.appendChild(row);
    connectBlock.appendChild(dom.el('p', 'meta', 'Paste this into your terminal.'));
    emptyInner.appendChild(connectBlock);

    /* THREE FIRST MOVES. A card that only says nobody is there is a dead end:
       the person has an assistant and no idea what to say to it. Each row is
       a real question this window can answer, and pressing one puts the words
       in the box rather than sending them, so the first message is still
       theirs to send. They are rows, not buttons with borders: the card is
       already the quietest thing on screen and three boxes would make it a
       menu. */
    var suggest = dom.el('div', 'agent-suggest');
    for (var s = 0; s < SUGGESTIONS.length; s += 1) {
      var suggestion = dom.el('button', 'suggest', SUGGESTIONS[s]);
      suggestion.type = 'button';
      suggest.appendChild(suggestion);
      dom.on(suggestion, 'click', suggestClick(node, SUGGESTIONS[s]));
    }
    emptyInner.appendChild(suggest);
    empty.appendChild(emptyInner);
    host.appendChild(empty);

    var list = dom.el('div', 'transcript');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    host.appendChild(list);

    /* The turn bar sits above the composer rather than in the transcript, so
       it is in the same place every time and a scrolled-back reader still has
       it. It is text and one dot: no control, nothing that decides anything. */
    var turnBar = dom.el('div', 'turn-bar');
    turnBar.setAttribute('role', 'status');
    turnBar.setAttribute('aria-live', 'polite');
    turnBar.appendChild(dom.el('span', 'turn-dot'));
    turnBar.appendChild(dom.el('span', 'turn-what'));
    turnBar.appendChild(dom.el('span', 'turn-time'));
    turnBar.hidden = true;

    /* THE COMPOSER. One field on the column's own ground under a hairline,
       no box around the box: the textarea is bare and grows to six lines, and
       the one control is a round arrow inside the field that is grey until
       there is something to send. The line that used to sit under it saying
       "Start your assistant to talk to it." is the placeholder now, so the
       box says why it is quiet in the place a person looks for words. */
    var composer = dom.el('form', 'agent-composer');
    var field = dom.el('div', 'composer-field');
    var input = dom.el('textarea', 'input composer-input');
    input.rows = 1;
    input.placeholder = PLACEHOLDER_OFF;
    input.autocomplete = 'off';
    var send = dom.el('button', 'composer-send');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send');
    send.title = 'Send';
    var arrow = glyph(GLYPH_ARROW_UP, 'composer-send-glyph');
    if (arrow) send.appendChild(arrow);
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
      stopAnswer: stopAnswer,
      stopAgent: stopAgent,
      connect: connectBtn,
      connectBlock: connectBlock,
      detail: detailLine,
      empty: empty,
      emptyInner: emptyInner,
      list: list,
      composer: composer,
      input: input,
      send: send,
      line: line,
      row: row,
      copy: copy,
      clients: clients,
      turnBar: turnBar,
      turnDot: turnBar.children[0],
      turnWhat: turnBar.children[1],
      turnTime: turnBar.children[2],
      emptySeat: emptySeat,
      emptyTitle: emptyTitle,
      emptyNote: emptyNote,
      emptyActions: emptyActions
    };

    dom.on(start, 'click', function () { doStart(node, start); });
    dom.on(startBig, 'click', function () { doStart(node, startBig); });
    dom.on(stopAnswer, 'click', function () { doStop('interrupt', node); });
    dom.on(stopAgent, 'click', function () { doStop('stop', node); });
    dom.on(copy, 'click', function () { copyLine(node); });
    dom.on(connectBtn, 'click', function () {
      var open = connectBlock.hidden;
      dom.setHidden(connectBlock, !open);
      dom.setAttr(emptyInner, 'data-connect', open ? 'true' : null);
    });

    /* Enter sends and Shift+Enter breaks the line, which is the shape every
       chat box has. Nothing animates on the keyboard path: a person who has
       just typed does not need the window to confirm that they pressed a key. */
    dom.on(input, 'keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submit(node);
    });
    dom.on(composer, 'submit', function (event) {
      event.preventDefault();
      submit(node);
    });
    /* The box has always been described as growing and never did: it was one
       row of a textarea and a paragraph scrolled inside it. The arrow arms on
       the same event, because "there is something to send" is a fact about
       the text and not about the phase. */
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
  }

  /* A SUGGESTION IS A QUESTION, SO PRESSING ONE ASKS IT.

     On a live column it goes straight out. On a column with nobody at the
     wheel it used to land in a box the column keeps disabled, where it sat
     as grey text over the placeholder that had just explained why the box
     was quiet. So it starts the assistant instead, through the same door
     the Start button uses, with the words waiting in the box, and sends them
     the moment the seat reports ready. A start that fails leaves the words
     where they are and lets the card say what went wrong; nothing sends,
     and the next press is the person's. */
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
    var mine = said(text, 'pending');
    api.driver({ action: 'prompt', text: text, chat: '' }).catch(function (err) {
      mine.state = 'failed';
      endTurnBar();
      pushBlock({ type: 'error', text: net.readable(err) });
    });
  }

  function doStart(node, button) {
    /* Starting over gives the app a new chat with a new id, so the column has
       to forget the one it was following or it filters out its own agent. */
    chatId = null;
    setPhase('starting', 'starting', 'Starting your assistant.');
    window.PhosphorShell.setPending(button, true, 'Starting');
    api.driver({ action: 'start', chat: '' })
      .catch(function (err) {
        setPhase('error', 'failed', net.readable(err));
      })
      .finally(function () {
        window.PhosphorShell.setPending(button, false);
      });
  }

  function doStop(action, node) {
    var button = action === 'stop' ? node.refs.stopAgent : node.refs.stopAnswer;
    window.PhosphorShell.setPending(button, true, action === 'stop' ? 'Turning off' : 'Stopping');
    api.driver({ action: action, chat: '' })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () {
        window.PhosphorShell.setPending(button, false);
      });
  }

  function copyLine(node) {
    var value = node.refs.line.textContent;
    if (!value) return;
    var done = function () {
      dom.setText(node.refs.copy.querySelector('.btn-label'), 'Copied');
      window.setTimeout(function () {
        dom.setText(node.refs.copy.querySelector('.btn-label'), 'Copy');
      }, 1600);
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

  /* WHAT THE BAR SAYS, and what it deliberately does not.

     It named the open tool call at first, and that was wrong: the step row
     directly above it already names the call and times it, so the two lines
     said the same thing one under the other. The bar carries what the
     transcript cannot, which is the state of the TURN. The step rows answer
     "on what", this answers "still going, and for how long". */
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

  function setPhase(next, word, note) {
    if (floorTimer) {
      window.clearTimeout(floorTimer);
      floorTimer = 0;
    }
    if (phase === 'starting' && next !== 'starting') {
      var waited = Date.now() - startingAt;
      if (waited < STARTING_FLOOR_MS) {
        floorTimer = window.setTimeout(function () {
          floorTimer = 0;
          applyPhase(next, word, note);
        }, STARTING_FLOOR_MS - waited);
        return;
      }
    }
    if (next === 'starting' && phase !== 'starting') startingAt = Date.now();
    applyPhase(next, word, note);
  }

  function applyPhase(next, word, note) {
    var changed = phase !== next;
    /* Coming up and then arriving is the one transition a person was watching,
       so it is the one that hands them the caret. Keyed on `starting` rather
       than on canTalk() so a window that loads with an agent already running
       does not take focus off whatever they were doing. */
    var arrived = phase === 'starting' && (next === 'connected' || next === 'working');
    var settled = phase === 'working' && next !== 'working';
    phase = next;
    if (word) serverWord = word;
    detail = note || '';
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
    if (motion && typeof motion.reduced === 'function' && motion.reduced()) return;
    var ease = motion && typeof motion.spring === 'function'
      ? motion.spring()
      : 'cubic-bezier(0.23, 1, 0.32, 1)';
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
      detail: { id: step.id, name: step.name, state: step.state, node: dot }
    }));
  }

  /* ---------- render ---------- */

  function renderAll() {
    for (var i = 0; i < mounts.length; i += 1) render(mounts[i], i === 0);
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

    var empty = blocks.length === 0;
    /* The empty state already asks once, in the middle of the column, and two
       Start buttons on one screen is the window asking twice. The head's copy
       takes over the moment there is a transcript to keep company. */
    dom.setHidden(refs.start, empty || (phase !== 'idle' && phase !== 'error'));
    dom.setHidden(refs.stopAnswer, phase !== 'working');
    dom.setHidden(refs.stopAgent, !canTalk());

    dom.setHidden(refs.empty, !empty);
    dom.setHidden(refs.list, empty);
    if (empty) renderEmpty(node);

    var note = detail;
    if (!note && phase === 'starting') note = 'Starting your assistant.';
    dom.setText(refs.detail, note);
    /* One place says it. The empty card carries the same sentence in the middle
       of the column and larger, so printing it under the head as well was the
       window telling somebody twice. */
    dom.setHidden(refs.detail, !note || empty);

    /* The composer is present in every phase and says why it cannot be used,
       because a box that vanishes teaches nothing about how to get it back. */
    refs.input.disabled = !canTalk();
    refs.send.disabled = !canTalk();
    refs.input.placeholder = canTalk() ? PLACEHOLDER_ON
      : (phase === 'starting' ? PLACEHOLDER_STARTING : PLACEHOLDER_OFF);
    arm(node);

    dom.setHidden(refs.turnBar, !turn);
    if (turn) {
      dom.setText(refs.turnWhat, turnLine());
      dom.setText(refs.turnTime, secondsText(now - turn.startedAt));
      dom.setAttr(refs.turnBar, 'data-state', turn.state);
    }

    var stick = refs.list.scrollHeight - refs.list.scrollTop - refs.list.clientHeight < STICK_PX;
    renderBlocks(node, primary);
    if (stick) refs.list.scrollTop = refs.list.scrollHeight;

    /* No line means the backend cannot name one, so the offer goes away with it.
       A button that reveals an empty block is worse than no button. */
    dom.setText(refs.line, connection.command || '');
    dom.setHidden(refs.connect, !connection.command);
    if (!connection.command) {
      dom.setHidden(refs.connectBlock, true);
      dom.setAttr(refs.emptyInner, 'data-connect', null);
    }

    dom.reconcile(refs.clients, connection.connected || [], function (client, i) {
      return client.name + ':' + i;
    }, function () {
      var row = dom.el('div', 'hstack-2 agent-client');
      row.appendChild(dom.el('span', 'dot'));
      row.appendChild(dom.el('span', 'meta grow truncate'));
      row.appendChild(dom.el('span', 'meta mono'));
      return row;
    }, function (row, client) {
      var kids = row.children;
      dom.setText(kids[1], client.name + ', ' + (client.role === 'analyst' ? 'read only' : 'can ask'));
      dom.setText(kids[2], String(client.calls || 0) + ' calls');
    });
  }

  /* No, coming, and yes. The seat carries the state as an attribute so the
     stylesheet draws the light, and the two buttons are present only in the one
     state where pressing them means anything.

     The connected copy names the first thing that has to happen rather than
     congratulating anybody: an agent nobody has spoken to has not attached its
     tools yet, because Claude Code does not emit its init event until a turn
     arrives. Saying so is the difference between a screen that is friendly and
     one that is true. */
  function renderEmpty(node) {
    var refs = node.refs;
    var seat = phase === 'connected' || phase === 'working' ? 'live'
      : (phase === 'starting' ? 'coming' : (phase === 'error' ? 'error' : 'off'));
    if (seat === 'live' && serverWord === 'stopped') seat = 'off';
    dom.setAttr(refs.emptySeat, 'data-seat', seat);

    if (seat === 'live') {
      dom.setText(refs.emptyTitle, 'Your assistant is at the wheel.');
      dom.setText(refs.emptyNote, 'Tell it what to do. It picks up your wallet, the policy and the chart on your first message.');
    } else if (seat === 'coming') {
      dom.setText(refs.emptyTitle, 'Taking the wheel.');
      dom.setText(refs.emptyNote, detail || 'Starting your assistant.');
    } else if (seat === 'error') {
      dom.setText(refs.emptyTitle, 'It could not start.');
      dom.setText(refs.emptyNote, detail || 'The assistant did not come up. Try again, or connect one you already use.');
    } else {
      dom.setText(refs.emptyTitle, 'Nobody is at the wheel.');
      dom.setText(refs.emptyNote, 'Start your assistant, or connect one you already use.');
    }

    /* Offering Start to somebody whose agent is already running is the window
       asking a question it knows the answer to, and it was the whole reason
       pressing the button looked like it did nothing. */
    dom.setHidden(refs.emptyActions, seat === 'live' || seat === 'coming');
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

  /* One bordered card in the transcript's measure: the coin that left, the
     headline, the line of what arrived and what it cost, and under them the
     id with its Copy. Built once, from the receipt, and never updated: a
     receipt is a record. */
  function createReceiptCard(receipt) {
    var card = dom.el('div', 'panel receipt-card enter');
    var line = dom.el('div', 'tx');
    var marks = window.PhosphorMarks;
    var mark = receipt.symbol && marks && typeof marks.disc === 'function' ? marks.disc(receipt.symbol) : null;
    line.appendChild(mark || dom.el('span', 'tx-mark'));
    line.appendChild(dom.el('span', 'tx-title', receipt.headline || receipt.summary || 'Something moved.'));
    line.appendChild(dom.el('span', 'tx-when', receiptLine(receipt)));
    card.appendChild(line);

    var tx = Array.isArray(receipt.txids) && receipt.txids.length ? receipt.txids[0] : null;
    if (tx && tx.hash) {
      var hash = String(tx.hash);
      /* Only a url the server built (transactions.ts explorerTxUrl) is opened,
         and only an http one: nothing in a receipt is typed by a person, but
         the link is the one place this column hands the system browser a
         string, so it is checked here as well. */
      var url = typeof tx.url === 'string' && /^https?:\/\//.test(tx.url) ? tx.url : '';
      var row = dom.el('div', 'receipt-id');
      var id = dom.el(url ? 'a' : 'span', 'receipt-hash mono', shortId(hash));
      id.title = hash;
      if (url) {
        id.href = url;
        id.target = '_blank';
        id.rel = 'noreferrer noopener';
      }
      row.appendChild(id);
      var copy = dom.el('button', 'btn btn-quiet btn-sm');
      copy.type = 'button';
      var copyLabel = dom.el('span', 'btn-label', 'Copy');
      copy.appendChild(copyLabel);
      row.appendChild(copy);
      card.appendChild(row);
      dom.on(copy, 'click', function () { copyHash(hash, copyLabel); });
    }
    return card;
  }

  function copyHash(hash, label) {
    if (!(navigator.clipboard && navigator.clipboard.writeText)) return;
    navigator.clipboard.writeText(hash).then(function () {
      dom.setText(label, 'Copied');
      window.setTimeout(function () { dom.setText(label, 'Copy'); }, 1600);
    }).catch(function () { /* the id is on screen to read */ });
  }

  function createBlock(block) {
    if (block.type === 'receipt') return createReceiptCard(block.receipt);
    if (block.type === 'steps') {
      var wrap = dom.el('div', 'steps-block');
      var fold = dom.el('button', 'steps-fold');
      fold.type = 'button';
      fold.hidden = true;
      fold.appendChild(dom.el('span', 'step-dot'));
      fold.appendChild(dom.el('span', ''));
      wrap.appendChild(fold);
      wrap.appendChild(dom.el('div', 'steps'));
      dom.on(fold, 'click', function () {
        block.folded = !block.folded;
        renderAll();
      });
      return wrap;
    }
    var kind = block.type === 'said' ? 'chat-said'
      : (block.type === 'error' ? 'chat-error' : 'chat-reply');
    var chat = dom.el('div', 'chat-row ' + kind);
    chat.appendChild(dom.el('span', 'chat-who'));
    /* A reply is rendered, the two others are set as text. The renderer is
       the one place a reply's shape is decided, and it builds elements and
       sets strings: nothing a model writes reaches the DOM as markup. */
    chat.appendChild(dom.el('div', block.type === 'reply' ? 'chat-text md' : 'chat-text'));
    return chat;
  }

  function updateBlock(node, row, block, now, primary) {
    if (block.type === 'receipt') return;
    if (block.type === 'steps') {
      updateSteps(node, row, block, now, primary);
      return;
    }
    var who = row.children[0];
    var text = row.children[1];
    if (block.type === 'said') {
      /* Three words for three states, and the row only says one of them out
         loud. A delivered message needs no label: it is the normal case and
         labelling it would put a receipt under every line a person types. */
      dom.setText(who, block.state === 'failed' ? 'you, not sent' : 'you');
      dom.setText(text, block.text);
      dom.setAttr(row, 'data-state', block.state || 'sent');
      return;
    }
    if (block.type === 'error') {
      dom.setText(who, 'stopped');
      dom.setText(text, block.text);
      return;
    }
    dom.setText(who, 'assistant');
    renderReply(text, block.text);
  }

  /* Rendered once per change of text, not once per pass: the reconciler calls
     update on every render and a table rebuilt on each tick of the turn clock
     would be the column doing work for nobody. */
  function renderReply(node, value) {
    var md = window.PhosphorMarkdown;
    if (!md) {
      dom.setText(node, value);
      return;
    }
    if (node.__md === value) return;
    node.__md = value;
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

  function mapState(word) {
    if (word === 'off' || !word) return 'idle';
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
      setPhase(next, event.state, event.detail || '');
      return;
    }
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
      pushBlock({ type: 'reply', text: event.text });
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
      pushBlock({ type: 'error', text: event.message });
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
      pushBlock({ type: 'receipt', receipt: fresh[j] });
    }
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
      connection = {
        command: typeof data.command === 'string' ? data.command : '',
        connected: Array.isArray(data.connected) ? data.connected : []
      };
      renderAll();
    }).catch(function () { /* the block hides its line when there is none */ });

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
