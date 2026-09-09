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
    candles: 'reading prices',
    policy_show: 'reading the policy',
    proposal_status: 'checking the approval',
    market_search: 'looking up a market',
    gas_report: 'checking gas',
    log_tail: 'reading the log',
    /* The one tool that leaves this machine, and the row says so in its own
       words beside the phrase. A person watching their wallet app reach the
       internet is entitled to see that happen. */
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
    chart_remove_indicator: 'removing an indicator',
    chart_level: 'drawing a level',
    chart_mark: 'marking the chart',
    chart_trendline: 'drawing a trendline',
    chart_batch: 'redrawing the chart',
    chart_preset: 'applying a chart preset',
    chart_clear: 'clearing the chart',
    /* the trading window */
    trade_focus: 'focusing a market',
    trade_highlight: 'highlighting the chart',
    trade_overlay: 'drawing on the chart',
    trade_note: 'leaving a note',
    trade_batch: 'redrawing the account',
    trade_clear: 'clearing the chart',
    /* asking. None of these moves anything: each puts a request in the gate. */
    propose_consolidate: 'asking to consolidate',
    propose_swap: 'asking to swap',
    propose_intents_deposit: 'asking to deposit',
    propose_intents_withdraw: 'asking to withdraw',
    propose_mandate: 'asking to arm a mandate',
    propose_hl_deposit: 'asking to fund trading',
    propose_policy_change: 'asking to change a rule',
    /* doing, once a human has said yes */
    consolidate: 'consolidating',
    swap: 'swapping',
    intents_deposit: 'depositing',
    intents_withdraw: 'withdrawing',
    mandate_arm: 'arming a mandate',
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
  /* Five lines, and the line's height is read off the box rather than written
     down here: the fallback is only for a computed style that says `normal`. */
  var COMPOSER_MAX_LINES = 5;
  var COMPOSER_LINE_FALLBACK_PX = 21;

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
     `writing` (text has arrived and no tool is open). */
  var turn = null;

  /* WHICH CONVERSATION THIS COLUMN IS. The stream carries every chat's events
     and the app opens up to four, so an untagged reader printed another
     conversation's tool calls into this one and fired the beam for work this
     agent never did. The column adopts the first chat it hears from and
     ignores the rest. */
  var chatId = null;

  /* Five phases for the rest of the window, six words for the person. `ready`
     and `stopped` are both a live assistant that is not answering, so they share
     a phase, and only the chip tells them apart. */
  var STATE_WORDS = {
    idle: 'Off',
    starting: 'Starting',
    connected: 'Ready',
    working: 'Working',
    error: 'Could not start'
  };

  function chipWord() {
    if (phase === 'connected' && serverWord === 'stopped') return 'Stopped';
    return STATE_WORDS[phase] || 'Off';
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
    var title = dom.el('div', 'hstack-2');
    title.appendChild(dom.el('span', 'title-sm', 'Your assistant'));
    var chip = dom.el('span', 'chip');
    var dot = dom.el('span', 'dot');
    chip.appendChild(dot);
    chip.appendChild(dom.el('span', '', 'Off'));
    title.appendChild(chip);
    head.appendChild(title);

    var controls = dom.el('div', 'hstack-2');
    var start = dom.el('button', 'btn btn-primary btn-sm');
    start.appendChild(dom.el('span', 'btn-label', 'Start your assistant'));
    var stopAnswer = dom.el('button', 'btn btn-ghost btn-sm');
    stopAnswer.appendChild(dom.el('span', 'btn-label', 'Stop the answer'));
    var stopAgent = dom.el('button', 'btn btn-ghost btn-sm');
    stopAgent.appendChild(dom.el('span', 'btn-label', 'Stop'));
    controls.appendChild(start);
    controls.appendChild(stopAnswer);
    controls.appendChild(stopAgent);
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
    var emptySeat = dom.el('div', 'agent-seat');
    emptySeat.appendChild(dom.el('span', 'agent-seat-dot'));
    emptyInner.appendChild(emptySeat);
    var emptyTitle = dom.el('p', 'title', 'Nobody is at the wheel.');
    var emptyNote = dom.el('p', 'meta', 'Start your assistant, or connect one you already use.');
    emptyInner.appendChild(emptyTitle);
    emptyInner.appendChild(emptyNote);
    var emptyActions = dom.el('div', 'agent-empty-actions');
    var startBig = dom.el('button', 'btn btn-primary');
    startBig.appendChild(dom.el('span', 'btn-label', 'Start your assistant'));
    var connectBtn = dom.el('button', 'btn btn-ghost');
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

    var composer = dom.el('form', 'agent-composer');
    var input = dom.el('textarea', 'input');
    input.rows = 1;
    input.placeholder = 'Tell your assistant what to do.';
    input.autocomplete = 'off';
    var send = dom.el('button', 'btn btn-primary');
    send.type = 'submit';
    send.appendChild(dom.el('span', 'btn-label', 'Send'));
    composer.appendChild(input);
    composer.appendChild(send);
    var note = dom.el('p', 'composer-note', 'Start your assistant to talk to it.');
    var composerHost = node.composerHost || host;
    composerHost.appendChild(turnBar);
    composerHost.appendChild(composer);
    composerHost.appendChild(note);

    node.refs = {
      chip: chip,
      dot: dot,
      word: chip.lastChild,
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
      note: note,
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
    /* The box has always been described as growing to five lines and never did:
       it was one row of a textarea and a paragraph scrolled inside it. */
    dom.on(input, 'input', function () { autogrow(input); });
  }

  /* Height from content, capped at five lines, and measured from zero so
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
    window.PhosphorShell.setPending(button, true, 'Stopping');
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
    phase = next;
    if (word) serverWord = word;
    detail = note || '';
    renderAll();
    if (arrived) focusComposer();
    window.PhosphorShell.updateField();
    /* The world reads the assistant's state to write its own hero sentence, and
       polling a getter on every heartbeat frame is a read the event replaces. */
    if (changed) announcePhase();
  }

  function announcePhase() {
    if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('phosphor:agent-phase', { detail: { phase: phase } }));
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

    dom.setText(refs.word, chipWord());
    dom.setAttr(refs.chip, 'data-tone', phase === 'error' ? 'down' : (phase === 'idle' ? null : 'beam'));
    dom.setAttr(refs.dot, 'class', phase === 'working' ? 'dot dot-live' : 'dot');

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
    dom.setHidden(refs.note, canTalk());

    dom.setHidden(refs.turnBar, !turn);
    if (turn) {
      dom.setText(refs.turnWhat, turnLine());
      dom.setText(refs.turnTime, secondsText(Date.now() - turn.startedAt));
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

  function createBlock(block) {
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
    chat.appendChild(dom.el('span', 'chat-text'));
    return chat;
  }

  function updateBlock(node, row, block, now, primary) {
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
    dom.setText(text, block.text);
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
      dom.setText(time, secondsText(elapsedOf(step, now)));
      if (step.state === 'live') node.live.push({ step: step, time: time });
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
    for (var i = 0; i < mounts.length; i += 1) {
      var live = mounts[i].live;
      for (var j = 0; j < live.length; j += 1) {
        dom.setText(live[j].time, secondsText(elapsedOf(live[j].step, now)));
      }
      if (turn) dom.setText(mounts[i].refs.turnTime, secondsText(now - turn.startedAt));
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
  }

  window.PhosphorAgent = {
    mount: mount,
    start: start,
    isWorking: isWorking,
    phase: function () { return phase; },
    toolLabel: toolLabel
  };
})();
