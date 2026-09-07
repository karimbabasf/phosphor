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
    yield_read: 'reading what you earn',
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
    propose_yield_deposit: 'asking to put money to work',
    propose_yield_withdraw: 'asking to take money out',
    propose_hl_deposit: 'asking to fund trading',
    propose_policy_change: 'asking to change a rule',
    /* doing, once a human has said yes */
    consolidate: 'consolidating',
    swap: 'swapping',
    intents_deposit: 'depositing',
    intents_withdraw: 'withdrawing',
    mandate_arm: 'arming a mandate',
    yield_auto: 'setting up auto earning',
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

  var TRANSCRIPT_CAP = 400;
  var THINKING_MS = 300;
  var TICK_MS = 100;
  var STICK_PX = 40;

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

  var mounts = [];
  var blocks = [];
  var seq = 0;
  var phase = 'idle';
  var serverWord = 'off';
  var detail = '';
  var connection = { command: '', connected: [] };
  var openSteps = null;
  var thinking = null;
  var thinkingTimer = 0;
  var ticker = 0;
  var announced = [];

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

    /* The empty state sits on the column's own afterglow field, so the two ways
       to get an assistant are the only things drawn on it. */
    var empty = dom.el('div', 'agent-empty');
    var emptyInner = dom.el('div', 'agent-empty-inner');
    emptyInner.appendChild(dom.el('p', 'title', 'Nobody is at the wheel.'));
    emptyInner.appendChild(dom.el('p', 'meta', 'Start your assistant, or connect one you already use.'));
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
      clients: clients
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
  }

  /* ---------- actions ---------- */

  function submit(node) {
    var text = node.refs.input.value.trim();
    if (!text || !canTalk()) return;
    node.refs.input.value = '';
    said(text);
    api.driver({ action: 'prompt', text: text, chat: '' }).catch(function (err) {
      clearThinking();
      pushBlock({ type: 'error', text: net.readable(err) });
    });
  }

  function doStart(node, button) {
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

  function said(text) {
    clearThinking();
    openSteps = null;
    pushBlock({ type: 'said', text: text });
    /* Three hundred milliseconds of nothing is a wait; less than that is the
       network. The row goes in only if the first frame has not arrived. */
    thinkingTimer = window.setTimeout(function () {
      thinkingTimer = 0;
      thinking = pushBlock({ type: 'thinking' });
    }, THINKING_MS);
  }

  function clearThinking() {
    if (thinkingTimer) {
      window.clearTimeout(thinkingTimer);
      thinkingTimer = 0;
    }
    if (!thinking) return;
    var at = blocks.indexOf(thinking);
    if (at !== -1) blocks.splice(at, 1);
    thinking = null;
  }

  function stepsBlock() {
    if (openSteps && blocks.indexOf(openSteps) !== -1) return openSteps;
    openSteps = pushBlock({ type: 'steps', steps: [], folded: false, done: false });
    return openSteps;
  }

  function openStep(name, at) {
    var block = stepsBlock();
    seq += 1;
    var step = {
      id: 's' + seq,
      name: name,
      label: toolLabel(name),
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

  function setPhase(next, word, note) {
    var changed = phase !== next;
    phase = next;
    if (word) serverWord = word;
    detail = note || '';
    renderAll();
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
    dom.setAttr(refs.chip, 'data-tone', phase === 'error' ? 'down' : (phase === 'idle' ? null : 'agent'));
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

    var note = detail;
    if (!note && phase === 'starting') note = 'Starting your assistant.';
    dom.setText(refs.detail, note);
    dom.setHidden(refs.detail, !note);

    /* The composer is present in every phase and says why it cannot be used,
       because a box that vanishes teaches nothing about how to get it back. */
    refs.input.disabled = !canTalk();
    refs.send.disabled = !canTalk();
    dom.setHidden(refs.note, canTalk());

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
    if (block.type === 'thinking') {
      var think = dom.el('div', 'thinking');
      think.appendChild(dom.el('span', '', 'thinking'));
      think.appendChild(dom.el('i'));
      think.appendChild(dom.el('i'));
      think.appendChild(dom.el('i'));
      return think;
    }
    var kind = block.type === 'said' ? 'chat-said'
      : (block.type === 'error' ? 'chat-error' : 'chat-reply');
    var chat = dom.el('div', 'chat-row ' + kind);
    chat.appendChild(dom.el('span', 'chat-who'));
    chat.appendChild(dom.el('span', 'chat-text'));
    return chat;
  }

  function updateBlock(node, row, block, now, primary) {
    if (block.type === 'thinking') return;
    if (block.type === 'steps') {
      updateSteps(node, row, block, now, primary);
      return;
    }
    var who = row.children[0];
    var text = row.children[1];
    if (block.type === 'said') {
      dom.setText(who, 'you');
      dom.setText(text, block.text);
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
      dom.setText(text.children[1], step.leaves ? 'leaves this computer' : '');
      dom.setHidden(text.children[1], !step.leaves);
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
    var live = false;
    for (var i = 0; i < mounts.length; i += 1) {
      if (mounts[i].live.length) { live = true; break; }
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
      if (!replay) setPhase(mapState(event.state), event.state, event.detail || '');
      return;
    }
    if (!replay) clearThinking();
    if (event.kind === 'said') {
      if (replay) {
        openSteps = null;
        pushBlock({ type: 'said', text: event.text });
      } else {
        said(event.text);
      }
      return;
    }
    if (event.kind === 'tool') {
      if (phase === 'connected') phase = 'working';
      openStep(event.name, at);
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'tool_result') {
      closeStep(event.name, event.ok, at);
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'text') {
      if (phase === 'connected') phase = 'working';
      openSteps = null;
      pushBlock({ type: 'reply', text: event.text });
      return;
    }
    if (event.kind === 'turn_end') {
      endTurn();
      if (!replay) renderAll();
      return;
    }
    if (event.kind === 'error') {
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
      ingest(event, false);
    });

    api.driverState().then(function (result) {
      var data = result.data || {};
      var chat = (data.chats && data.chats[0]) || {};
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
