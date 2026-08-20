/* driver-chat.js — the agent conversation, shared by the pro, trade and basic windows.
 *
 * ONE job: let a person talk to the agent without leaving the app, and show what the agent said
 * and did. It is deliberately not a terminal emulator and not a log viewer. The log is still the
 * log and it now lives behind its own button; this is the conversation, and the two are different
 * things that were previously the same rectangle.
 *
 * THE RULE THAT DOES NOT BEND. Every string this file puts on screen is agent-authored or
 * human-authored text, and it reaches the DOM through textContent, never innerHTML. That is the
 * same rule app.js states in its own header and it matters more here than anywhere else in the
 * app: this is the one surface whose entire content is written by a language model that reads
 * token names and web-shaped text. A single innerHTML in this file would turn the chat panel into
 * a script-injection surface inside a window that holds an approval button.
 *
 * WHAT IS NOT HERE. No approval. The chat cannot approve, refuse, or arm anything, and it never
 * renders a control that does. When the agent proposes, the approval surface appears where it has
 * always appeared, and a person clicks it there. The conversation and the consent are separate on
 * purpose: an approval button inside a scrolling transcript authored by the thing being approved
 * is precisely the design this whole app exists to argue against. */

'use strict';

var PhosphorChat = (function () {
  var TRANSCRIPT_MAX = 400;
  var mounts = [];
  var token = '';
  var state = 'off';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Fetched on demand rather than only at boot. The token arrives from a second request, and a
     person who presses START in the moment between the page painting and that request landing
     would otherwise get a 403 for doing nothing wrong. */
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

  /* A tool call is the honest unit of "what the agent actually did", so it is rendered as its own
     line rather than folded into prose. The name is stripped of the mcp__phosphor__ prefix
     because a person reading this does not need to be told, forty times, which server it came
     from: they are looking at that server. */
  function toolLabel(name) {
    return String(name || 'tool').replace(/^mcp__phosphor__/, '');
  }

  function renderEvent(list, event) {
    var row = null;
    if (event.kind === 'said') {
      row = el('div', 'chat-row chat-said');
      row.appendChild(el('span', 'chat-who', 'you'));
      row.appendChild(el('span', 'chat-text', event.text));
    } else if (event.kind === 'text') {
      row = el('div', 'chat-row chat-agent');
      row.appendChild(el('span', 'chat-who', 'agent'));
      row.appendChild(el('span', 'chat-text', event.text));
    } else if (event.kind === 'tool') {
      row = el('div', 'chat-row chat-tool');
      row.appendChild(el('span', 'chat-who', 'ran'));
      row.appendChild(el('span', 'chat-text', toolLabel(event.name)));
    } else if (event.kind === 'tool_result') {
      return; /* The result is visible in the app's own state. A second line saying it returned
                 is noise in a transcript a person is reading to follow a conversation. */
    } else if (event.kind === 'error') {
      row = el('div', 'chat-row chat-error');
      row.appendChild(el('span', 'chat-who', 'stopped'));
      row.appendChild(el('span', 'chat-text', event.message));
    } else if (event.kind === 'status') {
      if (event.state === 'ready' || event.state === 'thinking') return;
      row = el('div', 'chat-row chat-status');
      row.appendChild(el('span', 'chat-who', ''));
      row.appendChild(el('span', 'chat-text', event.detail || event.state));
    } else {
      return;
    }
    list.appendChild(row);
    while (list.childElementCount > TRANSCRIPT_MAX) list.removeChild(list.firstChild);
  }

  /* Pinned to the bottom only when the reader is already there. Yanking the view back down while
     somebody is reading three messages up is the single most common way a chat panel becomes
     unusable, and the check costs one comparison. */
  function scrollIfPinned(list) {
    var slack = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (slack < 48) list.scrollTop = list.scrollHeight;
  }

  function setState(mount, next, detail) {
    state = next;
    var running = next === 'ready' || next === 'thinking' || next === 'starting';
    mount.form.hidden = !running;
    mount.startBtn.hidden = running;
    mount.stopBtn.hidden = !running;
    mount.root.setAttribute('data-driver-state', next);
    mount.status.textContent =
      next === 'thinking' ? 'working' : next === 'starting' ? 'starting' : detail ? detail : next;
  }

  function mount(root, opts) {
    if (!root) return null;
    var options = opts || {};
    root.textContent = '';
    root.classList.add('chat');

    var list = el('div', 'chat-list');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-label', 'conversation with the agent');

    var status = el('span', 'chat-state', 'off');
    var startBtn = el('button', 'chat-btn chat-start', options.startLabel || 'START THE AGENT');
    startBtn.type = 'button';
    var stopBtn = el('button', 'chat-btn chat-stop', 'STOP');
    stopBtn.type = 'button';
    stopBtn.hidden = true;

    var form = el('form', 'chat-form');
    var input = el('input', 'chat-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = options.placeholder || 'tell the agent what to do';
    input.setAttribute('aria-label', 'message to the agent');
    var send = el('button', 'chat-btn chat-send', 'SEND');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    form.hidden = true;

    var bar = el('div', 'chat-bar');
    bar.appendChild(status);
    bar.appendChild(startBtn);
    bar.appendChild(stopBtn);

    root.appendChild(list);
    root.appendChild(bar);
    root.appendChild(form);

    var record = { root: root, list: list, form: form, input: input, status: status, startBtn: startBtn, stopBtn: stopBtn };

    startBtn.addEventListener('click', function () {
      setState(record, 'starting');
      api({ action: 'start' }).catch(function (err) {
        renderEvent(list, { kind: 'error', message: err.message });
        setState(record, 'failed', err.message);
      });
    });

    stopBtn.addEventListener('click', function () {
      api({ action: 'stop' }).catch(function () {});
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      /* Cleared before the request resolves, and never restored on failure. A person who typed a
         sentence and pressed enter has moved on; handing the sentence back to them half a second
         later, in a box they may already be typing in again, is worse than losing it. The failure
         is reported in the transcript instead, where it can be read. */
      input.value = '';
      api({ action: 'prompt', text: text }).catch(function (err) {
        renderEvent(list, { kind: 'error', message: err.message });
        scrollIfPinned(list);
      });
    });

    mounts.push(record);
    return record;
  }

  function push(event) {
    for (var i = 0; i < mounts.length; i++) {
      var record = mounts[i];
      if (event.kind === 'status') setState(record, event.state, event.detail);
      renderEvent(record.list, event);
      scrollIfPinned(record.list);
    }
  }

  function load() {
    fetch('/api/session')
      .then(function (r) { return r.json(); })
      .then(function (json) { token = json.token || ''; })
      .catch(function () {});
    fetch('/api/driver')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        for (var i = 0; i < mounts.length; i++) {
          var record = mounts[i];
          record.list.textContent = '';
          var entries = json.transcript || [];
          for (var j = 0; j < entries.length; j++) renderEvent(record.list, entries[j]);
          setState(record, json.state || 'off');
          record.list.scrollTop = record.list.scrollHeight;
        }
      })
      .catch(function () {});
  }

  return { mount: mount, push: push, load: load, state: function () { return state; } };
})();
