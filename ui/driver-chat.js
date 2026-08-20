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
 *   booting   the intro prints while the child process comes up. No input box yet: there is
 *             nothing on the other end of it to read what gets typed.
 *   live      the transcript and the prompt box. This is the phase the panel exists for.
 *   closing   the stop was confirmed. The panel is taken apart on screen and comes back idle.
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

  function api(body) {
    return withToken()
      .then(function (current) {
        return fetch('/api/driver', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ token: current }, body)),
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
      row.appendChild(el('span', 'chat-text', body));
    } else if (event.kind === 'tool') {
      row = el('div', 'chat-row chat-tool');
      row.appendChild(el('span', 'chat-who', 'ran'));
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
     A boot print, not a loading spinner. Every line of it is a true statement about the agent
     being started: the timing is cosmetic, the content is not.

     IT IS ALLOWED TO FINISH. The driver reports ready on the child's spawn event, which lands
     in a few tens of milliseconds, so cutting the print off at ready meant one line of it was
     ever seen. Ready arriving mid-print is remembered instead, and the last line hands over.
     Four lines at 130ms is half a second, which is a beat and not a wait, and nothing is held
     back by it: the box a person types into opens the moment the print ends, and the child has
     been up the whole time. */
  function printIntro(mount) {
    stopIntro(mount);
    var lines = mount.intro;
    var i = 0;
    function step() {
      if (mount.phase !== 'booting') {
        mount.introTimer = 0;
        return;
      }
      if (i >= lines.length) {
        mount.introTimer = 0;
        if (mount.liveWhenPrinted) goLive(mount);
        return;
      }
      renderEvent(mount.list, { kind: 'boot', text: lines[i] });
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

  /* ---------- phases ---------- */

  function setPhase(mount, next) {
    if (mount.phase === next) return;
    mount.phase = next;
    mount.root.setAttribute('data-phase', next);

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

    if (next === 'idle') {
      mount.orb.start();
      mount.jump.hidden = true;
    } else {
      mount.orb.stop();
    }
  }

  function setState(mount, next, detail) {
    mount.root.setAttribute('data-driver-state', next);
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

  function openConfirm(mount) {
    mount.confirm.hidden = false;
    mount.stopBtn.hidden = true;
    mount.form.hidden = true;
    try { mount.no.focus(); } catch (err) {}
  }

  function closeConfirm(mount) {
    mount.confirm.hidden = true;
    mount.stopBtn.hidden = false;
    if (mount.phase === 'live') mount.form.hidden = false;
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

    stage.appendChild(globe);
    stage.appendChild(list);
    stage.appendChild(jump);

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
    form.appendChild(send);
    form.hidden = true;

    root.appendChild(stage);
    root.appendChild(bar);
    root.appendChild(form);

    var record = {
      root: root,
      stage: stage,
      globe: globe,
      sub: sub,
      list: list,
      jump: jump,
      bar: bar,
      form: form,
      input: input,
      status: status,
      halt: halt,
      stopBtn: stopBtn,
      confirm: confirm,
      yes: yes,
      no: no,
      phase: 'idle',
      pinned: true,
      introTimer: 0,
      liveWhenPrinted: false,
      reason: '',
      idleNote: options.idleNote || 'no agent is running',
      intro: options.intro || ['starting a local agent'],
      veil: options.veil === 'fade' ? 'fade' : 'rain',
      orb: window.PhosphorGlobe
        ? PhosphorGlobe.create(canvas, { colorVar: options.colorVar || '--green' })
        : null,
    };
    /* A browser with no 2d context still gets a working panel: the globe is the only thing
       that goes, and the button around it is what actually starts the agent. */
    if (!record.orb) record.orb = { start: function () {}, stop: function () {}, running: function () { return false; } };

    root.setAttribute('data-phase', 'idle');
    root.setAttribute('data-driver-state', 'off');
    record.orb.start();

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
    return record;
  }

  function push(event) {
    for (var i = 0; i < mounts.length; i++) {
      var record = mounts[i];
      if (event.kind === 'status') setState(record, event.state, event.detail);
      if (record.phase === 'idle' || record.phase === 'closing') continue;
      if (event.kind === 'said') record.pinned = true;
      renderEvent(record.list, event);
      follow(record);
    }
  }

  /* Called once per page, after every mount has registered. A window that reloaded mid
     conversation comes back to the conversation rather than to the globe, which is the only
     reason the transcript lives on the server at all.

     THE APP STARTS ITS OWN AGENT AT BOOT (see autostart in src/server.ts), so by the time this
     page paints the driver is usually already up and the press that would have printed the
     intro never happened. A driver that is running and has not said or done anything yet is
     exactly that case, and it gets the intro anyway: the window is opening, which is what the
     print is about. A reload in the middle of a real conversation is not that case and goes
     straight back to the transcript. */
  function load() {
    fetch('/api/session')
      .then(function (r) { return r.json(); })
      .then(function (json) { token = json.token || ''; })
      .catch(function () {});
    fetch('/api/driver')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var running = json.state === 'ready' || json.state === 'thinking' || json.state === 'starting';
        var entries = json.transcript || [];
        /* Nothing has been said and nothing has been run: the driver came up on its own and is
           waiting. Status and error rows do not count, because neither is a conversation. */
        var untouched = true;
        for (var k = 0; k < entries.length; k++) {
          if (entries[k].kind !== 'status' && entries[k].kind !== 'error') untouched = false;
        }
        for (var i = 0; i < mounts.length; i++) {
          var record = mounts[i];
          record.list.textContent = '';
          if (!running) {
            /* Through setState rather than straight to idle(), so the state word and the
               data-driver-state attribute are set by the one function that owns them. */
            setState(record, json.state || 'off');
            continue;
          }
          if (untouched) {
            setPhase(record, 'booting');
            printIntro(record);
            // Queues the handover behind the last intro line, exactly as a live start does.
            setState(record, json.state);
            continue;
          }
          setPhase(record, json.state === 'starting' ? 'booting' : 'live');
          for (var j = 0; j < entries.length; j++) renderEvent(record.list, entries[j]);
          setState(record, json.state);
          toBottom(record);
        }
      })
      .catch(function () {});
  }

  return { mount: mount, push: push, load: load };
})();
