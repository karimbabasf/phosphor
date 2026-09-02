/* The assistant panel. One component, mounted once per view, five states.

   The globe is gone. It was the button, which meant the only way to start the
   assistant was to click a spinning canvas that carried no label of its own.
   The button is now a button, it says what it does, and it names the wait. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var events = window.PhosphorEvents;

  /* Carried over verbatim from ui/driver-chat.js. A tool call is the honest
     unit of "what the agent actually did", so it is rendered as its own line
     with a phrase rather than a tool id. The propose and do pairs below are
     deliberately one word apart ("asking to swap" against "swapping"), because
     that word is the entire difference between them. */
  var TOOL_PHRASES = {
    /* reading */
    balances: 'reading your balances',
    wallet: 'reading your wallet',
    composition: 'checking what you hold',
    candles: 'reading prices',
    policy_show: 'reading the policy',
    proposal_status: 'checking the approval',
    market_search: 'looking up a market',
    /* The one tool that leaves this machine, and the line says so. A person
       watching their wallet app reach the internet is entitled to see that
       happen in words. */
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
    /* asking. None of these moves anything: each puts a request in the gate. */
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
    start: 'starting up'
  };

  var TRANSCRIPT_CAP = 400;

  /* typeof, not truthiness: the tool id arrives from a language model, and a
     lookup on a plain object hands back Object.prototype's own members for ids
     like `constructor`. A function stringified into a transcript is not a phrase. */
  function toolLabel(name) {
    var id = String(name || 'tool').replace(/^mcp__phosphor__/, '');
    var phrase = TOOL_PHRASES[id];
    return typeof phrase === 'string' ? phrase : id;
  }

  var mounts = [];
  var phase = 'idle';
  var detail = '';
  var transcript = [];
  var connection = { command: '', connected: [] };

  var STATE_WORDS = {
    idle: 'Not started',
    starting: 'Starting',
    connected: 'Connected',
    working: 'Working',
    error: 'Could not start'
  };

  function isWorking() {
    return phase === 'working';
  }

  /* ---------- mount ---------- */

  function mount(host, options) {
    if (!host) return null;
    var opts = options || {};
    var node = {
      host: host,
      compact: opts.compact === true,
      refs: {}
    };
    build(node);
    mounts.push(node);
    render(node);
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
    chip.appendChild(dom.el('span', '', 'Not started'));
    title.appendChild(chip);
    head.appendChild(title);

    var controls = dom.el('div', 'hstack-2');
    var start = dom.el('button', 'btn btn-primary');
    start.appendChild(dom.el('span', 'btn-label', 'Start'));
    var stopAnswer = dom.el('button', 'btn btn-ghost');
    stopAnswer.appendChild(dom.el('span', 'btn-label', 'Stop the answer'));
    var stopAgent = dom.el('button', 'btn btn-ghost');
    stopAgent.appendChild(dom.el('span', 'btn-label', 'Stop the assistant'));
    controls.appendChild(start);
    controls.appendChild(stopAnswer);
    controls.appendChild(stopAgent);
    head.appendChild(controls);
    host.appendChild(head);

    var detailLine = dom.el('p', 'meta agent-detail');
    host.appendChild(detailLine);

    /* The empty state carries the pattern, because it is the one place in the
       window with room for it and the one moment the person is waiting. */
    var empty = dom.el('div', 'agent-empty');
    var emptyField = dom.el('div', 'pattern-local');
    empty.appendChild(emptyField);
    var emptyInner = dom.el('div', 'agent-empty-inner');
    emptyInner.appendChild(dom.el('p', 'body', 'Nothing is driving the app.'));
    emptyInner.appendChild(dom.el('p', 'meta', 'Start the one built in, or paste the line below into your terminal to connect your own.'));
    empty.appendChild(emptyInner);
    host.appendChild(empty);

    var list = dom.el('div', 'transcript');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    host.appendChild(list);

    var composer = dom.el('form', 'agent-composer');
    var input = dom.el('input', 'input');
    input.type = 'text';
    input.placeholder = 'Ask your assistant';
    input.autocomplete = 'off';
    var send = dom.el('button', 'btn');
    send.type = 'submit';
    send.appendChild(dom.el('span', 'btn-label', 'Send'));
    composer.appendChild(input);
    composer.appendChild(send);
    host.appendChild(composer);

    var external = dom.el('div', 'agent-external');
    external.appendChild(dom.el('p', 'label', 'Connect your own assistant'));
    var row = dom.el('div', 'field-row');
    var line = dom.el('input', 'input');
    line.type = 'text';
    line.readOnly = true;
    line.value = '';
    var copy = dom.el('button', 'btn btn-ghost');
    copy.type = 'button';
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    row.appendChild(line);
    row.appendChild(copy);
    external.appendChild(row);
    external.appendChild(dom.el('p', 'meta', 'Paste this into your terminal.'));
    var clients = dom.el('div', 'stack-2 agent-clients');
    external.appendChild(clients);
    host.appendChild(external);

    node.refs = {
      chip: chip,
      dot: dot,
      word: chip.lastChild,
      start: start,
      stopAnswer: stopAnswer,
      stopAgent: stopAgent,
      detail: detailLine,
      empty: empty,
      emptyField: emptyField,
      list: list,
      composer: composer,
      input: input,
      send: send,
      line: line,
      lineRow: row,
      copy: copy,
      clients: clients,
      external: external
    };

    dom.on(start, 'click', function () { doStart(node); });
    dom.on(stopAnswer, 'click', function () { send_('interrupt', node); });
    dom.on(stopAgent, 'click', function () { send_('stop', node); });
    dom.on(copy, 'click', function () { copyLine(node); });
    dom.on(composer, 'submit', function (event) {
      event.preventDefault();
      var text = node.refs.input.value.trim();
      if (!text) return;
      node.refs.input.value = '';
      push({ kind: 'said', text: text });
      api.driver({ action: 'prompt', text: text, chat: '' }).catch(function (err) {
        push({ kind: 'error', message: net.readable(err) });
      });
    });

    if (window.PhosphorPattern) {
      node.field = window.PhosphorPattern.mount(emptyField, { cells: 9, state: 'idle', seed: 7 });
    }

    /* This panel is mounted once per view, and two of the three are hidden when
       they are built. A canvas in a hidden subtree measures 1 by 1, so each one
       re-fits when its view comes on screen. */
    window.addEventListener('phosphor:view', function () {
      if (node.field && node.host.offsetParent !== null) node.field.resize();
    });
  }

  /* ---------- actions ---------- */

  function doStart(node) {
    setPhase('starting', 'Starting your assistant.');
    window.PhosphorShell.setPending(node.refs.start, true, 'Starting');
    api.driver({ action: 'start', chat: '' })
      .catch(function (err) {
        setPhase('error', net.readable(err));
      })
      .finally(function () {
        window.PhosphorShell.setPending(node.refs.start, false);
      });
  }

  function send_(action, node) {
    var button = action === 'stop' ? node.refs.stopAgent : node.refs.stopAnswer;
    window.PhosphorShell.setPending(button, true, action === 'stop' ? 'Stopping' : 'Stopping');
    api.driver({ action: action, chat: '' })
      .catch(function (err) {
        window.PhosphorToast.show(net.readable(err), 'down');
      })
      .finally(function () {
        window.PhosphorShell.setPending(button, false);
      });
  }

  function copyLine(node) {
    var value = node.refs.line.value;
    if (!value) return;
    var done = function () {
      dom.setText(node.refs.copy.querySelector('.btn-label'), 'Copied');
      window.setTimeout(function () {
        dom.setText(node.refs.copy.querySelector('.btn-label'), 'Copy');
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () {
        node.refs.line.select();
      });
      return;
    }
    node.refs.line.select();
  }

  /* ---------- state ---------- */

  function setPhase(next, note) {
    phase = next;
    detail = note || '';
    renderAll();
    window.PhosphorShell.updateField();
  }

  function push(event) {
    transcript.push(event);
    if (transcript.length > TRANSCRIPT_CAP) transcript.splice(0, transcript.length - TRANSCRIPT_CAP);
    renderAll();
  }

  function renderAll() {
    for (var i = 0; i < mounts.length; i += 1) render(mounts[i]);
  }

  function render(node) {
    var refs = node.refs;
    var word = STATE_WORDS[phase] || 'Not started';
    dom.setText(refs.word, word);
    dom.setAttr(refs.chip, 'data-tone', phase === 'error' ? 'down' : (phase === 'idle' ? null : 'agent'));
    dom.setAttr(refs.dot, 'class', phase === 'working' ? 'dot dot-live' : 'dot');

    dom.setHidden(refs.start, phase === 'connected' || phase === 'working' || phase === 'starting');
    dom.setHidden(refs.stopAnswer, phase !== 'working');
    dom.setHidden(refs.stopAgent, phase !== 'connected' && phase !== 'working');
    dom.setHidden(refs.composer, phase !== 'connected' && phase !== 'working');

    var showEmpty = transcript.length === 0;
    dom.setHidden(refs.empty, !showEmpty);
    dom.setHidden(refs.list, showEmpty);

    var note = detail;
    if (!note && phase === 'starting') note = 'Starting your assistant.';
    if (!note && phase === 'working') note = 'Working.';
    dom.setText(refs.detail, note);
    dom.setHidden(refs.detail, !note);

    if (node.field) node.field.setState(phase === 'working' ? 'working' : 'idle');

    renderTranscript(refs.list);
    if (refs.line.value !== connection.command) refs.line.value = connection.command || '';
    dom.setHidden(refs.lineRow, !connection.command);

    dom.reconcile(refs.clients, connection.connected || [], function (client, i) {
      return client.name + ':' + i;
    }, function () {
      var row = dom.el('div', 'hstack-2 agent-client');
      row.appendChild(dom.el('span', 'dot'));
      row.appendChild(dom.el('span', 'body grow truncate'));
      row.appendChild(dom.el('span', 'meta mono'));
      return row;
    }, function (row, client) {
      var kids = row.children;
      dom.setText(kids[1], client.name + ' (' + (client.role === 'analyst' ? 'read only' : 'can ask') + ')');
      dom.setText(kids[2], String(client.calls || 0) + ' calls');
    });
  }

  /* The transcript renders as text only, never as markup, and never renders an
     approval control. That is the property that keeps the trust boundary where
     it is: nothing an assistant writes can draw a button that moves money. */
  function renderTranscript(list) {
    dom.reconcile(list, transcript, function (event, i) {
      return i + ':' + event.kind;
    }, function (event) {
      var row = dom.el('div', 'chat-row chat-' + event.kind);
      row.appendChild(dom.el('span', 'chat-who'));
      row.appendChild(dom.el('span', 'chat-text'));
      return row;
    }, function (row, event) {
      var who = row.children[0];
      var text = row.children[1];
      if (event.kind === 'said') {
        dom.setText(who, 'you');
        dom.setText(text, event.text);
      } else if (event.kind === 'text') {
        dom.setText(who, 'assistant');
        dom.setText(text, event.text);
      } else if (event.kind === 'tool') {
        dom.setText(who, '▪');
        dom.setText(text, toolLabel(event.name));
      } else if (event.kind === 'error') {
        dom.setText(who, 'stopped');
        dom.setText(text, event.message);
      } else if (event.kind === 'boot' || event.kind === 'status') {
        dom.setText(who, '');
        dom.setText(text, event.text || event.detail || '');
      }
    });
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- wiring ---------- */

  function mapState(word) {
    if (word === 'off' || !word) return 'idle';
    if (word === 'booting' || word === 'starting') return 'starting';
    if (word === 'working' || word === 'thinking') return 'working';
    if (word === 'error' || word === 'failed') return 'error';
    return 'connected';
  }

  function start() {
    events.on('driver', function (frame) {
      var event = frame && frame.event;
      if (!event) return;
      if (event.kind === 'status') {
        setPhase(mapState(event.state), event.detail || '');
        return;
      }
      if (event.kind === 'tool_result') return;
      if (event.kind === 'text' || event.kind === 'tool') {
        if (phase === 'connected') phase = 'working';
      }
      push(event);
    });

    api.driverState().then(function (result) {
      var data = result.data || {};
      setPhase(mapState(data.state));
      var chat = (data.chats && data.chats[0]) || {};
      if (Array.isArray(chat.transcript) && chat.transcript.length) {
        transcript = chat.transcript.slice(-TRANSCRIPT_CAP);
        renderAll();
      }
    }).catch(function () { /* the panel shows Not started, which is true */ });

    api.connection().then(function (data) {
      if (!data || data.missing) return;
      connection = {
        command: typeof data.command === 'string' ? data.command : '',
        connected: Array.isArray(data.connected) ? data.connected : []
      };
      renderAll();
    }).catch(function () { /* the block hides its field when there is no line */ });
  }

  window.PhosphorAgent = {
    mount: mount,
    start: start,
    isWorking: isWorking,
    toolLabel: toolLabel
  };
})();
