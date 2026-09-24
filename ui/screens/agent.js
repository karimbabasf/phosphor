/* The conversation column. It is on screen in every mode, in the same place,
   and it is the product: what a person asked, what the assistant said back, and
   the one card per move that shows where the money is.

   Two properties keep it safe and neither is a tidiness preference. Nothing the
   assistant writes reaches the DOM as markup, and nothing the assistant writes
   can draw a control that decides anything. The buttons that answer a move are
   on its card, drawn by ui/screens/decision.js from the server's row, so a
   transcript row cannot impersonate one.

   CALM, FAST AND TRUE (Karim, 2026-09-23: the chat raised his anxiety). No card
   covers the thread, no clock ticks, and the tool steps a turn runs stay out of
   it (developer mode shows them). While the assistant works there is one quiet
   line with the mark and the step in plain words, and it becomes the reply when
   the words arrive, streamed as they are written. The column stays at the bottom
   while the person is there and holds still when they scroll up to read.

   The look lives in ui/design/agent.css. This file writes state as attributes
   and text, never as style. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;

  /* The step a tool call is, in plain words. The working line shows the open
     call's phrase ("Checking prices", "Swapping"); developer mode shows every
     call as a row with its arguments. The propose and do pairs stay one word
     apart where they differ, because that word is the whole difference. */
  var TOOL_PHRASES = {
    /* reading */
    wallet: 'reading your wallet',
    composition: 'checking what you hold',
    policy_show: 'reading your limits',
    proposal_status: 'checking on the move',
    market_search: 'looking up a market',
    log_tail: 'reading the log',
    research: 'reading the news',
    web_search: 'searching the web',
    web_fetch: 'reading a page',
    x_search: 'searching X',
    skill: 'reading its instructions',
    trade_read: 'reading the account',
    deposit: 'getting a deposit address',
    chain_address: 'looking up an address',
    chain_transactions: 'reading an address\'s history',
    chain_transaction: 'reading a transaction',
    intents_activity: 'reading your history',
    swap_assets: 'looking up coins',
    swap_quote: 'checking prices',
    swap_check: 'checking the swap',
    /* the chart */
    chart_read: 'reading the chart',
    chart_scan: 'scanning the timeframes',
    chart_snapshot: 'looking at the chart',
    chart_draw: 'drawing on the chart',
    chart_layout: 'arranging the charts',
    chart_batch: 'redrawing the chart',
    /* the trading window */
    trade_focus: 'focusing a market',
    trade_highlight: 'highlighting the chart',
    trade_overlay: 'drawing on the chart',
    trade_plan: 'drawing a plan',
    trade_batch: 'reading the account',
    trade_clear: 'clearing the chart',
    profile_learned: 'noting that for next time',
    /* asking. None of these moves anything: each puts a request in the gate. */
    propose_swap: 'checking prices',
    propose_send: 'getting a send ready',
    propose_trade: 'getting a trade ready',
    propose_trade_change: 'getting a change ready',
    propose_hl_deposit: 'getting the move ready',
    propose_hl_withdraw: 'getting the move ready',
    propose_policy_change: 'getting the change ready',
    /* doing, once a human has said yes */
    swap: 'swapping',
    intents_send: 'sending',
    intents_pay: 'paying out',
    trade: 'placing the trade',
    trade_change: 'changing the trade',
    hl_deposit: 'funding trading',
    hl_withdraw: 'bringing it back',
    /* the helpers */
    agent_spawn: 'starting a helper',
    agent_roster: 'checking the helpers',
    agent_post: 'talking to the helpers',
    agent_board: 'talking to the helpers',
    agent_jobs: 'talking to the helpers',
    /* the window itself */
    switch: 'switching the screen',
    set_theme: 'recolouring the window',
    start: 'starting up'
  };

  /* The tools that reach past this machine. Developer mode names them on their row. */
  var LEAVES = {
    research: true,
    web_search: true,
    web_fetch: true,
    x_search: true,
    chain_address: true,
    chain_transactions: true,
    chain_transaction: true,
    intents_activity: true
  };

  /* What a call was about, for developer mode's rows: a fixed list of field names rather
     than a table per tool, each value cut to length, and only strings, numbers and booleans. */
  var ARG_FIELDS = [
    'product', 'symbol', 'query', 'coins', 'mode', 'name', 'indicator',
    'chain', 'toChain', 'venue', 'label', 'text', 'sentence', 'what', 'source', 'id', 'concept'
  ];
  var ARG_MAX = 38;

  /* The kind of move each propose drafts, so the card can say what it is before any row
     exists. A send drafts either of two kinds; the row names which once it lands. */
  var PROPOSE_KINDS = {
    propose_swap: 'swap',
    propose_send: 'intents_send',
    propose_trade: 'trade',
    propose_trade_change: 'trade_change',
    propose_hl_deposit: 'hl_deposit',
    propose_hl_withdraw: 'hl_withdraw',
    propose_policy_change: 'policy_change'
  };

  var TRANSCRIPT_CAP = 400;
  var STICK_PX = 40;
  /* The follow: the column eases to its end on one motion that retargets as rows grow,
     with this time constant, so a reply streaming in reads as one glide and not a restart
     per word. */
  var FOLLOW_TAU_MS = 70;
  var COMPOSER_MAX_LINES = 6;
  var COMPOSER_LINE_FALLBACK_PX = 21;

  /* What the box says. It is only on screen while it can be used. */
  var PLACEHOLDER_ON = 'Ask, or tell it what to do';

  /* The three first moves on the empty card. Each is a question this window
     answers from what it already holds, in the words a person would use. */
  var SUGGESTIONS = ['What do I hold?', 'Is anything waiting on me?', 'Find a trade on BTC'];

  /* A question about what the person holds. A wallet read in a turn that asked one draws
     its card; any other wallet read was a check on the way to something else, and the
     balances beside the chat already show the money. */
  var ASKS_HOLDINGS = /\b(hold|holding|holdings|balance|balances|wallet|portfolio|how much|what do i have|what have i got|my money|worth)\b/i;

  /* The card's sentences, in one place. */
  var COPY = {
    offTitle: 'Nobody is at the wheel.',
    offLine: 'Start your agent, or connect one you already use.',
    comingTitle: 'Taking the wheel.',
    comingLine: 'Starting your assistant.',
    liveTitle: 'Your assistant is at the wheel.',
    liveLine: 'Tell it what to do. It picks up your wallet, your limits and the chart on your first message.',
    ownTitle: 'Your own agent is at the wheel.',
    ownLine: 'Talk to it from its own terminal. Its moves land here as cards.',
    idleTitle: 'Your own agent is connected.',
    idleLine: 'It has not made a move yet. Talk to it from its terminal; its moves land here as cards.',
    idleManyTitle: 'Your own agents are connected.',
    idleManyLine: 'None has made a move yet. Talk to one from its terminal; its moves land here as cards.',
    connectTitle: 'Connect your own agent',
    connectLine: 'Any MCP client can drive Phosphor.',
    connectHint: 'Paste this into your terminal, then send a message from there.',
    waiting: 'Waiting for a connection...',
    connected: 'Connected',
    noAnswer: 'The assistant did not answer in time.',
    failedUnsaid: 'The assistant could not start.',
    thinking: 'Thinking'
  };

  /* How long a start may sit at "Starting..." before the window says so. Ready
     arrives on the child's spawn event, a few hundred milliseconds after the
     click, so twenty seconds is not a start that is slow, it is one that has
     stopped reporting. The next frame from the driver still wins. */
  var START_TIMEOUT_MS = 20000;

  function icon(name, className) {
    return window.PhosphorIcons.svg(name, className);
  }

  function bareName(name) {
    return String(name || '').replace(/^mcp__phosphor__/, '');
  }

  /* typeof, not truthiness: the tool id arrives from a language model, and a
     lookup on a plain object hands back Object.prototype's own members for ids
     like `constructor`. */
  function toolLabel(name) {
    var id = bareName(name) || 'tool';
    var phrase = Object.prototype.hasOwnProperty.call(TOOL_PHRASES, id) ? TOOL_PHRASES[id] : null;
    return typeof phrase === 'string' ? phrase : id;
  }

  function leavesMachine(name) {
    return LEAVES[bareName(name)] === true;
  }

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

  function shortId(value) {
    var s = String(value || '');
    return s.length <= 20 ? s : s.slice(0, 8) + '...' + s.slice(-8);
  }

  function argsLabel(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    var parts = [];
    var amount = argText(input.amount);
    if (amount) parts.push(amount);
    for (var i = 0; i < ARG_FIELDS.length && parts.length < 3; i += 1) {
      var key = ARG_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      var text = key === 'id' ? shortId(argText(input[key])) : argText(input[key]);
      if (!text) continue;
      if (parts.indexOf(text) !== -1) continue;
      parts.push(text);
    }
    var joined = parts.join(' ');
    if (joined.length > ARG_MAX) joined = joined.slice(0, ARG_MAX - 1).replace(/\s+\S*$/, '') + '...';
    return joined;
  }

  /* The scalar arguments of a call, kept beside the row for the trace. */
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

  function sentence(text) {
    var value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  var mounts = [];
  var blocks = [];
  var seq = 0;
  var phase = 'idle';
  var connection = { command: '' };
  var roster = [];
  var openSteps = null;

  /* WHAT THE CENTRE SHOWS while there is no transcript: the card, or the connect sheet in
     its place. The sheet can only be open while nobody is at the wheel. */
  var view = 'card';

  /* THE ONE THING THAT WENT WRONG, in words: the driver's plain sentence under the head,
     with a Retry, and its technical line kept so the error frame that follows is not
     printed a second time as a row. */
  var failure = null;

  /* THE PICK: the agent a new chat runs (GET /api/driver `agent`). One that runs outside this
     window (Codex in a terminal) has no Start here; its sentence says where it runs instead. */
  var pick = null;

  function awayReason() {
    return pick && pick.inApp === false && typeof pick.reason === 'string' && pick.reason ? pick.reason : '';
  }

  /* THE TURN. One record from the moment a prompt goes out until the turn ends, in three
     states, each one an event rather than a guess: `thinking` (sent, nothing back yet),
     `calling` (a tool is open) and `writing` (words are arriving). The working line reads it,
     so the two longest silences in a turn (before the first call, and after the last) are
     never a blank column. No clock: the line says what is happening, not for how long. */
  var turn = null;

  /* Whether the last turn ended since the person last spoke: the header mark shows it. */
  var turnDone = false;

  /* The read cards drawn so far in this turn, so the next can take their place: at most
     one read card per turn, and none under a move. */
  var turnReadBlocks = [];

  /* What the person asked in this turn, so a wallet read draws its card only when they
     asked about their money. */
  var turnAsk = '';

  /* WHICH CONVERSATION THIS COLUMN IS. The stream carries every chat's events and the app
     opens up to four; the column adopts the first chat it hears from and ignores the rest. */
  var chatId = null;

  /* The rows the last state frame carried, by id: every waiting row and the twenty most
     recent decided ones (src/http/state.ts), each with its view. Null until the first frame. */
  var liveRows = null;

  /* Whether the stored transcript has been read back. Until it has, a waiting row's card
     is not drawn from the state frame: the transcript may already hold it, in its place. */
  var restored = false;
  var bootAt = Date.now();

  /* The working line, the one row that is not a block: it is drawn at the end while the
     turn is thinking or calling, and it gives way to the reply the moment words arrive. */
  var WORKING = { type: 'working', key: 'working' };

  function isWorking() {
    return phase === 'working';
  }

  function canTalk() {
    return phase === 'connected' || phase === 'working';
  }

  function canStart() {
    return phase === 'idle' || phase === 'error';
  }

  /* Somebody else's agent, attached over MCP while the built-in one is off. */
  function ownAgents() {
    return canStart() ? roster : [];
  }

  function workingAgents() {
    var out = [];
    var list = ownAgents();
    for (var i = 0; i < list.length; i += 1) if (list[i].calls > 0) out.push(list[i]);
    return out;
  }

  function rosterRows() {
    var list = ownAgents();
    var rows = workingAgents();
    var idle = list.length - rows.length;
    if (idle > 0) {
      var line;
      if (rows.length) line = idle + ' more connected, idle';
      else if (idle === 1) line = '1 connected, no call yet';
      else line = idle + ' connected, none has made a call yet';
      rows = rows.concat([{ idle: true, count: idle, name: line, role: '', calls: 0 }]);
    }
    return rows;
  }

  /* The newest call still open, which is the step the working line names. */
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

  function workingWords() {
    var step = liveStep();
    return step ? sentence(step.label) : COPY.thinking;
  }

  /* ---------- mount ---------- */

  function mount(host, options) {
    if (!host) return null;
    var opts = options || {};
    /* pinned: the column is at its end and follows what lands; following: the follow motion
       is running; lastTop: where the scroller was, to tell a person scrolling up from a row
       that shrank. */
    var node = { host: host, composerHost: opts.composerHost || null, refs: {}, pinned: true, following: false, lastTop: 0 };
    build(node);
    mounts.push(node);
    render(node);
    return node;
  }

  function button(className, label, title, pending) {
    var btn = dom.el('button', className);
    btn.type = 'button';
    if (title) btn.title = title;
    btn.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(btn, 'data-pending-label', pending);
    return btn;
  }

  function build(node) {
    var host = node.host;
    dom.clear(host);

    /* THE HEAD. No name and no status line: the header mark says whether the assistant is
       working, and the thread says what it is doing. What is left is what a person may need
       to press or read: why it stopped, with a Retry, and the one control. */
    var head = dom.el('div', 'agent-head');
    var note = dom.el('div', 'agent-note');
    note.setAttribute('role', 'status');
    var noteText = dom.el('span', 'agent-note-text');
    var retry = button('btn btn-ghost btn-sm agent-retry', 'Retry', '', 'Starting');
    note.appendChild(noteText);
    note.appendChild(retry);
    note.hidden = true;
    head.appendChild(note);

    var controls = dom.el('div', 'agent-controls');
    var start = button('btn btn-ghost btn-sm', 'Start your agent', '', 'Starting');
    var stopAgent = button('btn btn-quiet btn-sm', 'Turn off', 'Turn your assistant off', 'Turning off');
    controls.appendChild(start);
    controls.appendChild(stopAgent);
    head.appendChild(controls);
    host.appendChild(head);

    /* Who else is holding the reins. A second client that can ask for money is not a
       detail, so it is named under the head rather than behind a fold. */
    var clients = dom.el('div', 'agent-clients');
    host.appendChild(clients);

    /* THE CENTRE: the card, or the connect sheet in its place. */
    var centre = dom.el('div', 'agent-centre');
    var empty = dom.el('div', 'agent-empty');
    var emptyInner = dom.el('div', 'agent-empty-inner');
    var emptySeat = dom.el('div', 'agent-seat');
    emptySeat.setAttribute('aria-hidden', 'true');
    var seatMark = dom.mark('agent-seat-mark', 'idle');
    if (seatMark) emptySeat.appendChild(seatMark);
    emptyInner.appendChild(emptySeat);
    var emptyTitle = dom.el('p', 'agent-empty-title', COPY.offTitle);
    var emptyNote = dom.el('p', 'agent-empty-line', COPY.offLine);
    emptyInner.appendChild(emptyTitle);
    emptyInner.appendChild(emptyNote);
    var emptyActions = dom.el('div', 'agent-empty-actions');
    var startBig = button('btn', 'Start your agent', '', 'Starting');
    var connectBtn = button('btn btn-ghost', 'Connect your own');
    emptyActions.appendChild(startBig);
    emptyActions.appendChild(connectBtn);
    emptyInner.appendChild(emptyActions);
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
    var connectStatus = dom.el('p', 'agent-connect-status');
    var connectVerb = dom.el('span', '', COPY.waiting);
    connectStatus.appendChild(connectVerb);
    sheet.appendChild(connectStatus);
    var back = button('btn btn-ghost btn-sm agent-connect-back', 'Back');
    sheet.appendChild(back);
    centre.appendChild(sheet);
    host.appendChild(centre);

    /* THE THREAD. The scroller spans the column, so a wheel anywhere over it scrolls; the
       rows sit in one centred measure inside it, and that measure is what the resize
       observer watches: any row that grows, a card that opens, a reply that streams. */
    var wrap = dom.el('div', 'transcript-wrap');
    var list = dom.el('div', 'transcript');
    var rows = dom.el('div', 'transcript-rows');
    rows.setAttribute('role', 'log');
    rows.setAttribute('aria-live', 'polite');
    list.appendChild(rows);
    wrap.appendChild(list);
    var fadeTop = dom.el('div', 'transcript-fade');
    fadeTop.setAttribute('data-edge', 'top');
    wrap.appendChild(fadeTop);
    /* THE WAY BACK DOWN. A person who scrolled up to read is left where they are when a row
       lands; this small quiet control on the thread's bottom edge takes them to the latest. */
    var jump = button('jump-latest', 'Latest', 'Go to the latest message');
    jump.insertBefore(icon('chevron-down', 'jump-glyph'), jump.firstChild);
    wrap.appendChild(jump);
    host.appendChild(wrap);

    /* THE ONE THING WAITING. A move that needs the person, on a card they have scrolled
       away from, is one quiet line above the box, and the line takes them to it. */
    var waitLine = dom.el('button', 'agent-waiting');
    waitLine.type = 'button';
    waitLine.appendChild(icon('waiting', 'agent-waiting-glyph'));
    var waitWords = dom.el('span', 'agent-waiting-words', 'Waiting for your OK');
    waitLine.appendChild(waitWords);
    waitLine.hidden = true;

    /* THE COMPOSER. One field, the textarea bare inside it growing to six lines, and one
       round button at the right: the send arrow, which becomes a stop square while an
       answer is running. Enter sends. */
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
    composerHost.appendChild(waitLine);
    composerHost.appendChild(composer);

    node.refs = {
      head: head,
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
      rows: rows,
      listWrap: wrap,
      fadeTop: fadeTop,
      jump: jump,
      waitLine: waitLine,
      waitWords: waitWords,
      composer: composer,
      input: input,
      send: send,
      line: line,
      copy: copy,
      back: back,
      connectVerb: connectVerb,
      connectStatus: connectStatus,
      clients: clients,
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
    dom.on(jump, 'click', function () { toEnd(node); });
    dom.on(waitLine, 'click', function () { toWaiting(node); });

    /* The hand wins. A wheel or a key that moves up lets go of the end at once, so the
       follow never fights a person who is reading; reaching the end again takes it back. */
    dom.on(list, 'scroll', function () { onScroll(node); }, { passive: true });
    dom.on(list, 'wheel', function (event) {
      if (event && event.deltaY < 0) letGo(node);
    }, { passive: true });
    dom.on(list, 'keydown', function (event) {
      var key = event && event.key;
      if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') letGo(node);
    });
    if (typeof window.ResizeObserver === 'function') {
      var sizes = new window.ResizeObserver(function () { onResize(node); });
      sizes.observe(rows);
      sizes.observe(list);
    }

    dom.on(input, 'keydown', function (event) {
      if (event.key === 'Escape') {
        if (typeof input.blur === 'function') input.blur();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submit(node);
    });
    dom.on(composer, 'submit', function (event) {
      event.preventDefault();
      if (phase === 'working') {
        doStop('interrupt', node);
        return;
      }
      submit(node);
    });
    dom.on(input, 'input', function () {
      autogrow(input);
      arm(node);
    });
  }

  /* The send arrow is dim until the box holds a word. */
  function arm(node) {
    var text = String(node.refs.input.value || '').trim();
    dom.setAttr(node.refs.field, 'data-armed', text ? 'true' : null);
    node.refs.send.disabled = !canTalk() || (phase !== 'working' && !text);
  }

  function setView(next) {
    if (next === 'connect' && !canStart()) return;
    if (next === view) return;
    view = next;
    renderAll();
  }

  /* A SUGGESTION IS A QUESTION, SO PRESSING ONE ASKS IT: at once on a live column, and on a
     quiet one by starting the assistant first with the words waiting in the box. */
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

  function sendQueued() {
    var waiting = queued;
    queued = null;
    if (!waiting || !canTalk()) return;
    if (String(waiting.node.refs.input.value || '').trim() !== waiting.text) return;
    submit(waiting.node);
  }

  /* Height from content, capped at six lines, and measured from zero so deleting a line
     gives the space back. */
  function autogrow(input) {
    input.style.height = 'auto';
    var style = window.getComputedStyle(input);
    var line = parseFloat(style.lineHeight);
    if (!isFinite(line) || line <= 0) line = COMPOSER_LINE_FALLBACK_PX;
    var pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var border = input.offsetHeight - input.clientHeight;
    var content = input.scrollHeight;
    var cap = Math.round(COMPOSER_MAX_LINES * line + pad);
    input.style.height = Math.min(content, cap) + border + 'px';
    input.style.overflowY = content > cap ? 'auto' : 'hidden';
  }

  /* ---------- actions ---------- */

  /* THE ECHO AND THE EVENT ARE ONE MESSAGE. The local row goes in at once as `pending` and
     the server's own `said` event adopts it rather than pushing a second one. */
  function submit(node) {
    var text = node.refs.input.value.trim();
    if (!text || !canTalk()) return;
    node.refs.input.value = '';
    autogrow(node.refs.input);
    arm(node);
    prompt(text);
  }

  /* A message to the assistant, from the box or from a card's Try again. Their own words
     always land in view, however far up they were reading. */
  function prompt(text) {
    if (!text || !canTalk()) return false;
    jumpAll = true;
    var mine = said(text, 'pending');
    api.driver({ action: 'prompt', text: text, chat: '' }).catch(function (err) {
      mine.state = 'failed';
      turn = null;
      pushBlock({ type: 'error', text: net.readable(err) });
    });
    return true;
  }

  function doStart(node, btn) {
    chatId = null;
    failure = null;
    setPhase('starting', 'starting');
    window.PhosphorShell.setPending(btn, true);
    api.driver({ action: 'start', chat: '' })
      .catch(function (err) {
        fail(net.readable(err), '');
      })
      .finally(function () {
        window.PhosphorShell.setPending(btn, false);
      });
  }

  /* Turn off quits the assistant, with a confirmation first, and the confirmation is a
     card in the thread. Stopping an answer in progress is the composer's button and asks
     nothing. */
  function doStop(action, node) {
    if (action === 'stop') {
      confirmOff(node);
      return;
    }
    var btn = node.refs.send;
    window.PhosphorShell.setPending(btn, true);
    api.driver({ action: action, chat: '' })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () {
        window.PhosphorShell.setPending(btn, false);
      });
  }

  function confirmOff(node) {
    showCard(function (host, done) {
      dom.clear(host);
      host.appendChild(dom.el('h2', 'title', 'Turn off the assistant?'));
      host.appendChild(dom.el('p', 'body dim', 'Its transcript on this window is deleted. Your wallet, limits and open positions are untouched.'));
      var actions = dom.el('div', 'dock-actions');
      var keep = button('btn btn-ghost', 'Keep running');
      var off = button('btn', 'Turn off');
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
    window.PhosphorShell.setPending(btn, true);
    api.driver({ action: 'stop', chat: '' })
      .then(function () {
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

  /* THE COLUMN AFTER A QUIT is the column before anybody started. This is the quit's own
     step and never the stopped frame's: a crash arrives as the same state with a reason,
     and that transcript stays on screen under the reason. */
  function forget() {
    blocks.length = 0;
    openSteps = null;
    turn = null;
    turnDone = false;
    failure = null;
    queued = null;
    view = 'card';
    for (var i = 0; i < mounts.length; i += 1) mounts[i].pinned = true;
    setPhase('idle', 'stopped');
  }

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

  /* Drops this turn's read cards from the thread. The steps that produced them stay. */
  function dropTurnReads() {
    if (!turnReadBlocks.length) return;
    for (var i = 0; i < turnReadBlocks.length; i += 1) {
      var at = blocks.indexOf(turnReadBlocks[i]);
      if (at !== -1) blocks.splice(at, 1);
    }
    turnReadBlocks = [];
  }

  /* Blocks carry their own key, so trimming the head of a capped transcript does not
     renumber every row under the reconciler. */
  function pushBlock(block) {
    seq += 1;
    block.key = 'b' + seq;
    blocks.push(block);
    if (blocks.length > TRANSCRIPT_CAP) blocks.splice(0, blocks.length - TRANSCRIPT_CAP);
    renderAll();
    return block;
  }

  function removeBlock(block) {
    var at = blocks.indexOf(block);
    if (at === -1) return;
    blocks.splice(at, 1);
    renderAll();
  }

  /* A note from the child's own stderr is kept, quietly, and it does not make a
     conversation: the card stays until somebody has actually said something. */
  function hasConversation() {
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].type !== 'note') return true;
    }
    return false;
  }

  function said(text, state) {
    openSteps = null;
    turnReadBlocks = [];
    turnAsk = String(text || '');
    var block = pushBlock({ type: 'said', text: text, state: state || 'sent' });
    startTurn();
    return block;
  }

  /* The pending row this event is the receipt for, newest first. */
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

  function startTurn() {
    turn = { state: 'thinking' };
    turnDone = false;
    renderAll();
  }

  function stepsBlock() {
    if (openSteps && blocks.indexOf(openSteps) !== -1) return openSteps;
    openSteps = pushBlock({ type: 'steps', steps: [], folded: false, done: false });
    return openSteps;
  }

  function openStep(name, at, input) {
    var block = stepsBlock();
    seq += 1;
    block.steps.push({
      id: 's' + seq,
      name: name,
      label: toolLabel(name),
      args: argsLabel(input),
      input: scalarArgs(input),
      leaves: leavesMachine(name),
      state: 'live',
      startedAt: at
    });
  }

  function closeStep(name, ok) {
    if (!openSteps) return null;
    var steps = openSteps.steps;
    for (var i = steps.length - 1; i >= 0; i -= 1) {
      var step = steps[i];
      if (step.state !== 'live' || step.name !== name) continue;
      step.state = ok === false ? 'error' : 'done';
      return step;
    }
    return null;
  }

  function anyError(block) {
    for (var i = 0; i < block.steps.length; i += 1) {
      if (block.steps[i].state === 'error') return true;
    }
    return false;
  }

  /* A finished turn's calls, for developer mode: how many, then their phrases. No time: it
     measured the gap between frames arriving, which was noise and sometimes false. */
  function foldLabel(block) {
    var count = block.steps.length;
    return count === 1 ? '1 step' : count + ' steps';
  }

  function foldNames(block) {
    var cards = window.PhosphorCards;
    if (cards && typeof cards.foldNames === 'function') return cards.foldNames(block.steps);
    var out = [];
    for (var i = 0; i < block.steps.length; i += 1) {
      if (out.indexOf(block.steps[i].label) === -1) out.push(block.steps[i].label);
    }
    return out.join(', ');
  }

  /* ---------- streaming ---------- */

  /* THE FRAME'S SHAPE LIVES HERE AND NOWHERE ELSE. The driver streams a reply as it is
     written (contract 4, src/driver.ts): `{ kind: 'delta', block, text }` is the next piece of
     text block `block`, sent to the window only, and the `text` event with the same block
     number is its whole copy, the one the transcript keeps. This returns what to do with the
     open reply, and every other line in this file reads the answer, never the frame. */
  function deltaOf(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.kind === 'delta' && typeof event.text === 'string') return { append: event.text };
    return null;
  }

  function joined(done, live) {
    if (!done) return live || '';
    if (live === null || live === undefined || live === '') return done;
    return done + '\n\n' + live;
  }

  /* One reply per stretch of words. `done` is the blocks the model has finished, `live` the
     one still being written, and `text` what is drawn: both, joined on a blank line. */
  function streamInto(delta, at) {
    var tail = blocks[blocks.length - 1];
    var reply = tail && tail.type === 'reply' ? tail : null;
    if (!reply) {
      reply = pushBlock({ type: 'reply', done: '', live: '', text: '', at: at });
    } else if (reply.live === null) {
      reply.live = '';
    }
    reply.live += delta.append;
    reply.text = joined(reply.done, reply.live);
  }

  /* A whole text block: the canonical words for the block that was streaming, or a new
     block of the same reply, or a reply of its own. */
  function commitText(text, at) {
    var tail = blocks[blocks.length - 1];
    if (tail && tail.type === 'reply') {
      tail.done = joined(tail.done, String(text));
      tail.live = null;
      tail.text = tail.done;
      return;
    }
    pushBlock({ type: 'reply', done: String(text), live: null, text: String(text), at: at });
  }

  /* ---------- state ---------- */

  /* HOW LONG "STARTING" HAS TO BE ON SCREEN. The whole start is a couple of hundred
     milliseconds, over before a person can see it, so the transition out of starting waits
     for a floor. Nothing is invented: a change that already happened is made legible to the
     eye that was watching for it. */
  var STARTING_FLOOR_MS = 450;
  var startingAt = 0;
  var floorTimer = 0;
  var startTimer = 0;

  function clearStartWatch() {
    if (!startTimer) return;
    window.clearTimeout(startTimer);
    startTimer = 0;
  }

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

  function applyPhase(next) {
    var changed = phase !== next;
    var arrived = phase === 'starting' && (next === 'connected' || next === 'working');
    phase = next;
    if (!canStart()) view = 'card';
    if (next === 'idle' || next === 'error') turnDone = false;
    renderAll();
    if (arrived) focusComposer();
    if (arrived) sendQueued();
    else if (next === 'error' || next === 'idle') queued = null;
    /* The world reads the assistant's state to write its own sentences, and polling a
       getter on every heartbeat frame is a read the event replaces. */
    if (changed) announcePhase();
  }

  function announcePhase() {
    if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('phosphor:agent-phase', { detail: { phase: phase } }));
  }

  /* THE HEADER MARK (contract 10): the chat's own state on the root, for the top bar's mark
     to draw. Working while a turn runs, done once one has ended, idle otherwise. */
  function paintAgentState() {
    var root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root || !root.dataset) return;
    var next = turn || phase === 'working' ? 'working' : (turnDone && canTalk() ? 'done' : 'idle');
    if (root.dataset.agent !== next) root.dataset.agent = next;
  }

  /* ---------- render ---------- */

  /* Set by the one render that must end at the bottom whatever the scroll position was:
     the person's own message going in, and a card another screen asked to show. */
  var jumpAll = false;
  var frameAsked = false;

  function renderAll() {
    for (var i = 0; i < mounts.length; i += 1) render(mounts[i]);
    jumpAll = false;
    paintAgentState();
  }

  /* A reply that streams asks for a render per piece; they are drawn once a frame. */
  function renderSoon() {
    if (frameAsked) return;
    var raf = window.requestAnimationFrame;
    if (typeof raf !== 'function') {
      renderAll();
      return;
    }
    frameAsked = true;
    raf(function () {
      frameAsked = false;
      renderAll();
    });
  }

  function render(node) {
    var refs = node.refs;
    var empty = !hasConversation();
    var failed = failure !== null && canStart();
    var away = canStart() ? awayReason() : '';
    dom.setHidden(refs.note, !failed && !away);
    dom.setText(refs.noteText, failed ? failure.reason : away);
    dom.setHidden(refs.retry, !failed);
    dom.setAttr(refs.note, 'title', failed && failure.detail ? failure.detail : null);

    /* The card already asks once, in the middle of the column; the head's Start takes over
     the moment there is a transcript to keep company. */
    dom.setHidden(refs.start, empty || failed || !!away || !canStart());
    dom.setHidden(refs.stopAgent, !canTalk());

    var sheet = view === 'connect' && empty && canStart();
    dom.setHidden(refs.sheet, !sheet);
    dom.setHidden(refs.empty, !empty || sheet);
    dom.setHidden(refs.listWrap, empty);
    if (empty && !sheet) renderEmpty(node);
    if (sheet) renderSheet(node);

    /* The composer is on screen only while the built-in assistant can take a message. */
    dom.setHidden(refs.composer, !canTalk());
    refs.input.disabled = !canTalk();
    refs.send.disabled = !canTalk();
    var stopping = phase === 'working';
    dom.setAttr(refs.field, 'data-mode', stopping ? 'stop' : null);
    dom.setAttr(refs.send, 'aria-label', stopping ? 'Stop this answer' : 'Send');
    refs.send.title = stopping ? 'Stop this answer' : 'Send';
    arm(node);

    if (jumpAll) node.pinned = true;
    renderBlocks(node);
    if (node.pinned) follow(node);
    paintScroll(node);

    dom.setText(refs.line, connection.command || '');
    dom.setHidden(refs.connect, !connection.command);

    dom.reconcile(refs.clients, rosterRows(), function (client, i) {
      return (client.idle ? 'idle' : client.name) + ':' + i;
    }, function () {
      var row = dom.el('div', 'agent-client');
      row.appendChild(dom.el('span', 'agent-client-name'));
      row.appendChild(dom.el('span', 'agent-client-calls mono'));
      return row;
    }, function (row, client) {
      var kids = row.children;
      if (client.idle) {
        dom.setAttr(row, 'data-idle', 'true');
        dom.setText(kids[0], client.name);
        dom.setText(kids[1], '');
        return;
      }
      dom.setAttr(row, 'data-idle', null);
      dom.setText(kids[0], client.name + ', ' + (client.role === 'analyst' ? 'read only' : 'can ask'));
      dom.setText(kids[1], String(client.calls || 0) + ' calls');
    });
  }

  /* ---------- the scroll ---------- */

  function atEnd(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
  }

  function reduced() {
    var motion = window.PhosphorMotion;
    return !!(motion && typeof motion.reduced === 'function' && motion.reduced());
  }

  /* THE FOLLOW. While the column is pinned to its end it stays there through anything that
     changes the height (a row, a card that opens, a reply that streams, the window) on one
     motion toward the end that reads the end again every frame, so new growth retargets it
     instead of restarting it. Under reduced motion it lands at once. */
  function follow(node) {
    var list = node.refs.list;
    var raf = window.requestAnimationFrame;
    if (reduced() || typeof raf !== 'function') {
      list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      node.lastTop = list.scrollTop;
      return;
    }
    if (node.following) return;
    node.following = true;
    var before = 0;
    var step = function (now) {
      if (!node.pinned) {
        node.following = false;
        return;
      }
      var end = Math.max(0, list.scrollHeight - list.clientHeight);
      var gap = end - list.scrollTop;
      if (Math.abs(gap) < 1) {
        list.scrollTop = end;
        node.lastTop = list.scrollTop;
        node.following = false;
        paintScroll(node);
        return;
      }
      var dt = before ? Math.min(64, now - before) : 16;
      before = now;
      list.scrollTop = list.scrollTop + gap * (1 - Math.exp(-dt / FOLLOW_TAU_MS));
      node.lastTop = list.scrollTop;
      raf(step);
    };
    raf(step);
  }

  function letGo(node) {
    if (!node.pinned) return;
    node.pinned = false;
    paintScroll(node);
  }

  function onScroll(node) {
    var list = node.refs.list;
    var top = list.scrollTop;
    var moved = top - node.lastTop;
    node.lastTop = top;
    /* The follow only ever moves down, and a row that shrinks clamps the scroller at its end,
       so a move up away from the end is the person. */
    if (atEnd(list)) node.pinned = true;
    else if (moved < -1) node.pinned = false;
    paintScroll(node);
  }

  function onResize(node) {
    if (node.pinned) follow(node);
    paintScroll(node);
  }

  function toEnd(node) {
    node.pinned = true;
    follow(node);
    paintScroll(node);
  }

  /* The quiet controls at the bottom edge: Latest while the person is above the end, and
     the waiting line instead of it while a card they scrolled away from needs them. */
  function paintScroll(node) {
    var refs = node.refs;
    var list = refs.list;
    var waiting = waitingOutOfView(node);
    dom.setHidden(refs.waitLine, !waiting);
    dom.setAttr(refs.jump, 'data-on', !waiting && !node.pinned && !atEnd(list) ? 'true' : null);
    dom.setAttr(refs.listWrap, 'data-cut', list.scrollTop > 2 ? 'top' : null);
  }

  /* The row of a block on screen, through the reconciler's own map. */
  function rowOf(node, block) {
    var keyed = node.refs.rows.__keyed || {};
    return block && keyed[block.key] ? keyed[block.key] : null;
  }

  function waitingBlocks() {
    var out = [];
    var cards = window.PhosphorCards;
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (block.type !== 'card' || block.kind !== 'move' || block.waiting === false) continue;
      if (cards && typeof cards.plainState === 'function' && cards.plainState(block.data) === 'needs_you') out.push(block);
    }
    return out;
  }

  /* A waiting card with no part of it inside the scroller's box. A document without layout
     measures nothing and says nothing. */
  function waitingOutOfView(node) {
    var list = node.refs.list;
    if (typeof list.getBoundingClientRect !== 'function') return null;
    var box = list.getBoundingClientRect();
    var waiting = waitingBlocks();
    for (var i = waiting.length - 1; i >= 0; i -= 1) {
      var row = rowOf(node, waiting[i]);
      if (!row || typeof row.getBoundingClientRect !== 'function') continue;
      var r = row.getBoundingClientRect();
      if (r.bottom < box.top + 24 || r.top > box.bottom - 24) return waiting[i];
    }
    return null;
  }

  /* The line takes the person to the card, into the middle of the column, on the same
     motion the rest of the column uses, and puts the focus on the card itself (never on a
     button, where Enter would answer for them). */
  function toWaiting(node) {
    var block = waitingOutOfView(node) || waitingBlocks()[0];
    var row = rowOf(node, block);
    if (!row) return;
    var list = node.refs.list;
    var box = list.getBoundingClientRect();
    var r = row.getBoundingClientRect();
    var target = list.scrollTop + (r.top - box.top) - Math.max(0, (box.height - r.height) / 2);
    target = Math.max(0, Math.min(target, list.scrollHeight - list.clientHeight));
    node.pinned = target >= list.scrollHeight - list.clientHeight - STICK_PX;
    var motion = window.PhosphorMotion;
    if (!reduced() && motion && typeof motion.animate === 'function') {
      motion.animate(list.scrollTop, target, {
        duration: 0.32,
        ease: [0.23, 1, 0.32, 1],
        onUpdate: function (value) { list.scrollTop = value; node.lastTop = value; }
      });
    } else {
      list.scrollTop = target;
    }
    var card = row.firstChild || row;
    if (typeof card.focus === 'function') {
      dom.setAttr(card, 'tabindex', '-1');
      card.focus({ preventScroll: true });
    }
    paintScroll(node);
  }

  /* No, coming, and yes: the three true answers to "is anybody there". */
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
    } else if (own && workingAgents().length) {
      dom.setText(refs.emptyTitle, COPY.ownTitle);
      dom.setText(refs.emptyNote, COPY.ownLine);
    } else if (own) {
      var many = ownAgents().length > 1;
      dom.setText(refs.emptyTitle, many ? COPY.idleManyTitle : COPY.idleTitle);
      dom.setText(refs.emptyNote, many ? COPY.idleManyLine : COPY.idleLine);
    } else {
      dom.setText(refs.emptyTitle, COPY.offTitle);
      dom.setText(refs.emptyNote, COPY.offLine);
    }
    dom.setHidden(refs.emptyActions, !canStart());
    dom.setHidden(refs.startBig, phase === 'error' || !!awayReason());
  }

  function renderSheet(node) {
    var refs = node.refs;
    var attached = ownAgents().length > 0;
    dom.setAttr(refs.connectStatus, 'data-state', attached ? 'connected' : 'waiting');
    dom.setText(refs.connectVerb, attached ? COPY.connected : COPY.waiting);
  }

  function focusComposer() {
    for (var i = 0; i < mounts.length; i += 1) {
      var input = mounts[i].refs.input;
      if (!input || input.disabled || typeof input.focus !== 'function') continue;
      input.focus();
      return;
    }
  }

  /* The rows as drawn: every block, then the working line while the turn is thinking or
     calling. While words are arriving the reply itself is the progress, and while a move is
     being asked for its card already says what is happening. */
  function shownBlocks() {
    if (!turn || turn.state === 'writing') return blocks;
    var tail = blocks[blocks.length - 1];
    if (tail && tail.type === 'card' && tail.data && tail.data.placeholder === true && !tail.data.failed) return blocks;
    return blocks.concat([WORKING]);
  }

  function renderBlocks(node) {
    dom.reconcile(node.refs.rows, shownBlocks(), function (block) {
      return block.key;
    }, function (block) {
      return createBlock(block);
    }, function (row, block) {
      updateBlock(row, block);
    });
  }

  /* A move card's context: the tool it came from, whether the live state frame says it
     still waits, and where the person left its Details. */
  function cardOptions(block) {
    return {
      name: block.name,
      input: block.input,
      at: block.at,
      open: block.open !== false,
      onToggle: function (open) { block.open = open; },
      waiting: block.waiting,
      live: block.fromLive === true,
      detailsOpen: block.detailsOpen === true,
      onDetailsToggle: function (open) { block.detailsOpen = open; }
    };
  }

  function createBlock(block) {
    var cards = window.PhosphorCards;
    if (block.type === 'card') {
      var host = dom.el('div', 'chat-card');
      if (cards && typeof cards.render === 'function') host.appendChild(cards.render(block.kind, block.data, cardOptions(block)));
      host.__rev = block.rev;
      return host;
    }
    if (block.type === 'sheet') {
      /* A card another screen asked to show, at the thread's end, closed by its own
         buttons. It lives in this window only and is never part of the stored chat. */
      /* A quiet one (a reminder) is a line in the thread, not a card. */
      var wrap = dom.el('div', 'chat-sheet');
      if (block.quiet) wrap.setAttribute('data-quiet', 'true');
      var inner = dom.el('section', 'chat-sheet-card');
      wrap.appendChild(inner);
      block.build(inner, function () { removeBlock(block); });
      return wrap;
    }
    if (block.type === 'working') {
      var line = dom.el('div', 'chat-working');
      var mark = dom.mark('chat-working-mark', 'working');
      if (mark) line.appendChild(mark);
      line.appendChild(dom.el('span', 'chat-working-words'));
      return line;
    }
    if (block.type === 'steps') {
      var steps = dom.el('div', 'steps-block');
      steps.setAttribute('data-dev-only', '');
      var fold = dom.el('button', 'steps-fold');
      fold.type = 'button';
      fold.hidden = true;
      fold.appendChild(cards && typeof cards.glyph === 'function' ? cards.glyph('chevron', 'steps-chevron') : dom.el('span', 'steps-chevron'));
      fold.appendChild(dom.el('span', 'steps-fold-label'));
      fold.appendChild(dom.el('span', 'steps-fold-names'));
      steps.appendChild(fold);
      steps.appendChild(dom.el('div', 'steps'));
      dom.on(fold, 'click', function () {
        block.folded = !block.folded;
        renderAll();
      });
      return steps;
    }
    var kind = block.type === 'said' ? 'chat-said'
      : (block.type === 'error' ? 'chat-error'
        : (block.type === 'note' ? 'chat-note' : 'chat-reply'));
    var chat = dom.el('div', 'chat-row ' + kind);
    if (block.devOnly) chat.setAttribute('data-dev-only', '');
    chat.appendChild(dom.el('span', 'chat-who'));
    /* A reply is rendered, the others are set as text. The renderer builds elements and
       sets strings: nothing a model writes reaches the DOM as markup. */
    chat.appendChild(dom.el('div', block.type === 'reply' ? 'chat-text md' : 'chat-text'));
    return chat;
  }

  function updateBlock(row, block) {
    if (block.type === 'card') {
      var cards = window.PhosphorCards;
      var shown = row.firstChild;
      /* A move card repaints itself in place on every change of its row; any other card is
         settled when it lands and is drawn again only when its data moved. */
      if (shown && typeof shown.__paint === 'function') {
        if (row.__rev !== block.rev || row.__waiting !== block.waiting || row.__live !== block.fromLive) shown.__paint(block.data, cardOptions(block));
      } else if (row.__rev !== block.rev && cards && typeof cards.render === 'function') {
        var fresh = cards.render(block.kind, block.data, cardOptions(block));
        row.insertBefore(fresh, shown);
        if (shown) row.removeChild(shown);
      }
      row.__rev = block.rev;
      row.__waiting = block.waiting;
      row.__live = block.fromLive;
      var fold = cards && typeof cards.foldOf === 'function' ? cards.foldOf(row.firstChild) : null;
      if (fold && fold.isOpen() !== (block.open !== false)) fold.setOpen(block.open !== false);
      return;
    }
    if (block.type === 'sheet') return;
    if (block.type === 'working') {
      var words = row.children[row.children.length - 1];
      dom.setText(words, workingWords());
      return;
    }
    if (block.type === 'steps') {
      updateSteps(row, block);
      return;
    }
    var who = row.children[0];
    var text = row.children[1];
    if (block.type === 'said') {
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
    dom.setAttr(row, 'data-streaming', block.live !== null && block.live !== undefined ? 'true' : null);
    renderReply(text, block.text);
  }

  /* Rendered once per change of text. When the new text is the old text with whole blocks
     under it, only the new blocks are drawn; a streaming block is drawn again whole, once a
     frame, which for a reply of a few short lines is a handful of nodes. */
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

  /* Developer mode's trace: one row per call, the phrase and what it was about, and the
     calls fold to one line when the turn ends. */
  function updateSteps(wrap, block) {
    var fold = wrap.children[0];
    var list = wrap.children[1];
    dom.setHidden(fold, !block.done);
    dom.setAttr(fold, 'data-state', block.done && anyError(block) ? 'error' : null);
    dom.setText(fold.children[1], block.done ? foldLabel(block) : '');
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
      return step;
    }, function (row, step) {
      var text = row.children[1];
      dom.setAttr(row, 'data-state', step.state);
      dom.setText(text.children[0], step.label);
      dom.setText(text.children[1], step.args || '');
      dom.setHidden(text.children[1], !step.args);
      dom.setText(text.children[2], step.leaves ? 'leaves this computer' : '');
      dom.setHidden(text.children[2], !step.leaves);
    });
  }

  /* ---------- a card another screen shows ---------- */

  /* The backup nudge, the recovery words, Turn off the assistant: a card at the thread's
     end, in view. */
  function showCard(build, opts) {
    if (typeof build !== 'function') return;
    openSteps = null;
    jumpAll = true;
    pushBlock({ type: 'sheet', build: build, quiet: !!(opts && opts.quiet), at: Date.now() });
  }

  /* ---------- wiring ---------- */

  function mapState(word) {
    if (word === 'off' || word === 'stopped' || !word) return 'idle';
    if (word === 'booting' || word === 'starting') return 'starting';
    if (word === 'working' || word === 'thinking') return 'working';
    if (word === 'error' || word === 'failed') return 'error';
    return 'connected';
  }

  /* The newest move card still drawn from its propose call alone, for that tool. */
  function openPlaceholder(name) {
    var tool = name ? bareName(name) : null;
    for (var i = blocks.length - 1; i >= 0; i -= 1) {
      var block = blocks[i];
      if (block.type !== 'card' || block.kind !== 'move' || !block.data || block.data.placeholder !== true || block.data.failed) continue;
      if (tool === null || bareName(block.name) === tool) return block;
    }
    return null;
  }

  /* One driver event, one change to the model. `replay` is the boot restore reading a
     stored transcript: the same shapes and an older clock. */
  function ingest(event, replay) {
    var at = typeof event.at === 'number' ? event.at : Date.now();
    if (event.kind === 'status') {
      if (replay) return;
      var next = mapState(event.state);
      if (next !== 'working' && next !== 'starting') {
        endTurn();
        turn = null;
      }
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
    var delta = deltaOf(event);
    if (delta) {
      if (phase === 'connected') phase = 'working';
      if (turn) turn.state = 'writing';
      openSteps = null;
      streamInto(delta, at);
      if (!replay) renderSoon();
      return;
    }
    if (event.kind === 'said') {
      if (replay) {
        openSteps = null;
        turnReadBlocks = [];
        turnAsk = String(event.text || '');
        pushBlock({ type: 'said', text: event.text, state: 'sent' });
      } else if (!adoptPending(event.text)) {
        /* Nothing to adopt means the prompt came from somewhere else: a second window on the
           same chat, or a restored session. It is still this conversation's message. */
        said(event.text);
      } else {
        startTurn();
      }
      return;
    }
    if (event.kind === 'tool') {
      if (phase === 'connected') phase = 'working';
      if (!replay && !turn) startTurn();
      openStep(event.name, at, event.input);
      if (turn) turn.state = 'calling';
      /* SOMETHING ON SCREEN THE MOMENT A MOVE IS ASKED FOR. The propose call already names
         the pair and the amount, so the card is drawn from it now, working, and becomes the
         row's own card when the row lands. */
      var kind = PROPOSE_KINDS[bareName(event.name)];
      if (kind) {
        openSteps = null;
        pushBlock({ type: 'card', kind: 'move', name: event.name, input: event.input, data: { placeholder: true, kind: kind }, at: at, open: true, replayed: replay, waiting: replay ? false : undefined });
        return;
      }
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'tool_result') {
      closeStep(event.name, event.ok);
      if (turn) turn.state = 'thinking';
      if (event.ok === false) {
        var failed = openPlaceholder(event.name);
        if (failed) {
          failed.data = { placeholder: true, failed: true, kind: failed.data.kind };
          failed.rev = (failed.rev || 0) + 1;
        }
      }
      if (!replay) renderAll();
      return;
    }
    /* A read's answer, as data (src/driver.ts), drawn as a card under the steps that
       produced it. */
    if (event.kind === 'tool_data') {
      var cards = window.PhosphorCards;
      if (!cards || typeof cards.kindFor !== 'function') return;
      openSteps = null;
      var cardKind = cards.kindFor(event.name, event.data);
      if (cardKind === 'move') {
        /* A move already on the thread is updated where it stands: its placeholder, or the
           card an earlier read or the state frame drew. One card per move, for life. */
        var shown = moveBlockFor(event.data) || openPlaceholder(event.name);
        /* The state frame's row is the fuller truth (it carries the view), so it wins over the
           reply whenever the frame already has it. */
        var live = liveRows && event.data && typeof event.data.id === 'string' ? liveRows[event.data.id] : null;
        if (shown) {
          shown.data = live || event.data;
          shown.fromLive = !!live;
          shown.input = shown.input || event.input;
          shown.name = shown.name || event.name;
          shown.replayed = shown.replayed || replay;
          shown.waiting = waitingFlag(shown.data, shown.replayed);
          shown.rev = (shown.rev || 0) + 1;
          if (!replay) renderAll();
          return;
        }
        pushBlock({ type: 'card', kind: 'move', name: event.name, input: event.input, data: live || event.data, fromLive: !!live, at: at, open: true, replayed: replay, waiting: waitingFlag(live || event.data, replay) });
        return;
      }
      /* ONE READ CARD PER TURN, AND NONE THE PERSON DID NOT ASK FOR. A wallet read draws its
         card only in a turn that asked about the money: the balances beside the chat show it
         already. A read card under a move in the same turn was a check on the way there, and
         a second read in one turn replaces the first. */
      if (cardKind === 'balance' && !ASKS_HOLDINGS.test(turnAsk)) {
        if (!replay) renderAll();
        return;
      }
      if (turnHasMove()) {
        if (!replay) renderAll();
        return;
      }
      dropTurnReads();
      var block = pushBlock({ type: 'card', kind: cardKind, name: event.name, input: event.input, data: event.data, at: at, open: true });
      turnReadBlocks.push(block);
      return;
    }
    if (event.kind === 'text') {
      if (phase === 'connected') phase = 'working';
      if (turn) turn.state = 'writing';
      openSteps = null;
      commitText(event.text, at);
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'turn_end') {
      endTurn();
      turn = null;
      turnDone = true;
      /* The answer ended, so the box takes the next message: the ready frame that follows
         says the same, and a person typing between the two is not interrupting anything. */
      if (phase === 'working') phase = 'connected';
      turnReadBlocks = [];
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'error') {
      turn = null;
      if (failure && failure.detail && failure.detail === String(event.message)) return;
      /* A log line, not something the assistant said: developer mode shows it. The sentence a
         person needs comes on the failed status, beside Retry. */
      pushBlock({ type: 'note', text: event.message, devOnly: true });
      return;
    }
  }

  /* Whether this turn has already drawn a move card: a read under it is not drawn. */
  function turnHasMove() {
    for (var i = blocks.length - 1; i >= 0; i -= 1) {
      var block = blocks[i];
      if (block.type === 'said') return false;
      if (block.type === 'card' && block.kind === 'move') return true;
    }
    return false;
  }

  /* A finished turn folds its calls to one line, and a call still open is closed: the
     answer arrived, so the call did. A move card still drawn from its propose call alone
     never became a row, and says so. */
  function endTurn() {
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      /* A block that streamed and never got its whole copy was cut short by a stop: what
         arrived is what was said, so it stays, and stops reading as still arriving. */
      if (block.type === 'reply' && block.live !== null && block.live !== undefined) {
        block.done = joined(block.done, block.live);
        block.live = null;
        block.text = block.done;
        continue;
      }
      if (block.type === 'card' && block.kind === 'move' && block.data && block.data.placeholder === true && !block.data.failed) {
        block.data = { placeholder: true, failed: true, kind: block.data.kind };
        block.rev = (block.rev || 0) + 1;
      }
      if (block.type !== 'steps' || block.done) continue;
      for (var j = 0; j < block.steps.length; j += 1) {
        if (block.steps[j].state === 'live') block.steps[j].state = 'done';
      }
      block.done = true;
      block.folded = true;
    }
    openSteps = null;
  }

  /* ---------- the moves ---------- */

  function isWaitingRow(p) {
    return !!p && (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch');
  }

  /* Whether the card may ask: true while the live frame lists the row as waiting, false when
     the frame lists it as decided, and unknown for a row this session made that no frame has
     carried yet (the reply can beat the frame by a few milliseconds). A card read back from
     the stored chat does not ask until a frame says its row still waits: a stored propose
     reply says pending forever. */
  function waitingFlag(data, replay) {
    var id = data && typeof data.id === 'string' ? data.id : null;
    var live = liveRows !== null && id !== null ? liveRows[id] : undefined;
    if (live) return isWaitingRow(live);
    return replay ? false : undefined;
  }

  /* The move card on the thread for a row, by id, or null. */
  function moveBlockFor(data) {
    var id = data && typeof data.id === 'string' ? data.id : null;
    if (id === null) return null;
    for (var i = blocks.length - 1; i >= 0; i -= 1) {
      var block = blocks[i];
      if (block.type === 'card' && block.kind === 'move' && block.data && block.data.id === id) return block;
    }
    return null;
  }

  /* Whether the row says anything the card does not. */
  function liveMoved(shown, live) {
    if (shown.placeholder) return true;
    var was = shown.view || null;
    var now = live.view || null;
    if (!was !== !now) return true;
    if (was && now) {
      if (was.stage !== now.stage) return true;
      if (was.state !== now.state) return true;
      if (was.lastChangeAt !== now.lastChangeAt) return true;
      if ((was.settledAt || null) !== (now.settledAt || null)) return true;
      if ((was.providerStage || null) !== (now.providerStage || null)) return true;
      if ((was.money && was.money.amountOut) !== (now.money && now.money.amountOut)) return true;
    }
    if (shown.status !== live.status) return true;
    if ((shown.decidedAt || null) !== (live.decidedAt || null)) return true;
    if ((shown.settledAt || null) !== (live.settledAt || null)) return true;
    if (!shown.draft && live.draft) return true;
    if (!shown.result && live.result) return true;
    return false;
  }

  function createdAt(p) {
    var at = Date.parse(String(p && p.createdAt || ''));
    return isFinite(at) ? at : 0;
  }

  /* A row that needs a card of its own: one waiting on the person (its card is the only
     place it can be answered), or one made after this window opened by anyone at all, this
     conversation's assistant or another client. A card for it is its only card. */
  function needsCard(p) {
    if (!p || typeof p.id !== 'string') return false;
    return isWaitingRow(p) || createdAt(p) > bootAt;
  }

  /* THE MOVE CARD FOLLOWS ITS PROPOSAL. Every state frame carries every waiting row and the
     twenty most recent decided ones, each with its view; a card that names a row takes it
     and repaints in place, never appended. A row with no card yet gets one at the thread's
     end, adopting the card its propose call drew when there is one. */
  function onProposals(list) {
    if (!Array.isArray(list)) return;
    var byId = Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var p = list[i];
      if (p && typeof p.id === 'string') byId[p.id] = p;
    }
    liveRows = byId;
    var moved = false;
    for (var j = 0; j < blocks.length; j += 1) {
      var block = blocks[j];
      if (block.type !== 'card' || block.kind !== 'move' || !block.data || typeof block.data.id !== 'string') continue;
      var live = byId[block.data.id];
      var waiting = live ? isWaitingRow(live) : (block.replayed ? false : block.waiting);
      if (block.waiting !== waiting) {
        block.waiting = waiting;
        moved = true;
      }
      /* The frame's row replaces whatever the card was drawn from, always once and then
         whenever it moves: the buttons are offered on the server's own row and never on a
         reply that came through the conversation. */
      if (!live || (block.fromLive && !liveMoved(block.data, live))) continue;
      block.data = live;
      block.fromLive = true;
      block.rev = (block.rev || 0) + 1;
      moved = true;
    }
    if (restored) {
      var fresh = list.filter(function (row) { return needsCard(row) && !moveBlockFor(row); });
      fresh.sort(function (a, b) { return createdAt(a) - createdAt(b); });
      for (var k = 0; k < fresh.length; k += 1) {
        var row = fresh[k];
        var held = openPlaceholder(null);
        if (held && (!row.draft || !held.data.kind || row.draft.kind === held.data.kind || held.data.kind === 'intents_send')) {
          held.data = row;
          held.fromLive = true;
          held.waiting = isWaitingRow(row);
          held.rev = (held.rev || 0) + 1;
        } else {
          openSteps = null;
          blocks.push({ type: 'card', kind: 'move', name: 'proposal_status', input: { id: row.id }, data: row, fromLive: true, at: createdAt(row) || Date.now(), open: true, waiting: isWaitingRow(row), key: 'b' + (seq += 1) });
        }
        moved = true;
      }
      if (blocks.length > TRANSCRIPT_CAP) blocks.splice(0, blocks.length - TRANSCRIPT_CAP);
    }
    if (moved) renderAll();
  }

  /* The roster, as the state frame carries it: the clients attached over MCP, named by
     themselves. Text, never markup. */
  function onAgents(slice) {
    var members = slice && Array.isArray(slice.members) ? slice.members : [];
    var next = [];
    for (var i = 0; i < members.length; i += 1) {
      var m = members[i] || {};
      next.push({
        name: String(m.label || m.client || m.session || 'an agent'),
        role: String(m.role || ''),
        calls: typeof m.ops === 'number' ? m.ops : 0
      });
    }
    roster = next;
    renderAll();
  }

  /* The transcript is back (or there was none): rows that need a card and have none get
     one now, after everything the stored chat already drew. */
  function markRestored() {
    if (restored) return;
    restored = true;
    var store = window.PhosphorState;
    var state = store && typeof store.get === 'function' ? store.get() : null;
    if (state && Array.isArray(state.proposals)) onProposals(state.proposals);
  }

  function start() {
    events.on('driver', function (frame) {
      var event = frame && frame.event;
      if (!event) return;
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
      if (chat.id) chatId = String(chat.id);
      if (data.agent && typeof data.agent === 'object') pick = data.agent;
      if (Array.isArray(chat.transcript)) {
        for (var i = 0; i < chat.transcript.length; i += 1) ingest(chat.transcript[i], true);
        endTurn();
        turn = null;
      }
      setPhase(mapState(data.state), data.state);
      markRestored();
    }).catch(function () {
      markRestored();
    });

    /* A pick in the Vault (or the first run) is the agent the next Start runs, and says
       whether it runs in this window at all. */
    window.addEventListener('phosphor:agent', function () {
      api.driverState().then(function (r) {
        var d = r.data || {};
        if (d.agent && typeof d.agent === 'object') {
          pick = d.agent;
          renderAll();
        }
      }).catch(function () {});
    });

    api.connection().then(function (data) {
      if (!data || data.missing) return;
      connection = { command: typeof data.command === 'string' ? data.command : '' };
      renderAll();
    }).catch(function () { /* the sheet hides its offer when there is none */ });

    var store = window.PhosphorState;
    if (store && typeof store.select === 'function') {
      store.select('agents', onAgents);
      store.select('proposals', onProposals);
    }
  }

  window.PhosphorAgent = {
    mount: mount,
    start: start,
    isWorking: isWorking,
    phase: function () { return phase; },
    toolLabel: toolLabel,
    showCard: showCard,
    send: prompt
  };
})();
