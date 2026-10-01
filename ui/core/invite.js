/* The invite code's one door to the app: two routes, one frame on the stream and one
   slice of the state. Every call the invite screens make goes through here, so wiring
   the backend is this file and nothing else.

     POST /api/invite/check  { token, code }  what the code holds, or why it cannot pay
     POST /api/invite/claim  { token, code }  202 and an opaque claim id; runs on its own
     frame { type: 'invite', claim, status, amount?, asset? }  how a claim ended
     state.invite { claim, status, amount }  the latest claim, for a window opened late

   The code is held by the screen that asked, for as long as the ask takes. Nothing here
   keeps it, prints it or puts it in an error, and no answer from the app ever quotes it. */
(function () {
  'use strict';

  var net = window.PhosphorNet;
  var events = window.PhosphorEvents;
  var store = window.PhosphorState;

  var REASONS = ['typo', 'empty', 'offline', 'locked', 'busy', 'wallet-locked'];
  var STATUSES = ['running', 'landed', 'failed'];

  /* A refusal the app named, or offline for anything else: a dropped connection, a
     route this backend has not learned yet, a missing window token. Each of those
     means the code could not be checked right now, and that is what a person is told. */
  function reasonOf(answer) {
    var reason = answer && typeof answer.reason === 'string' ? answer.reason : '';
    return REASONS.indexOf(reason) >= 0 ? reason : 'offline';
  }

  /* "5.00", a figure, or nothing. */
  function amountOf(value) {
    if (typeof value === 'number' && isFinite(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) return value;
    return '';
  }

  function check(code) {
    return net.postJson('/api/invite/check', { code: code })
      .then(function (answer) {
        if (!answer || answer.ok !== true) return { ok: false, reason: reasonOf(answer) };
        return {
          ok: true,
          amount: amountOf(answer.amount),
          asset: typeof answer.asset === 'string' && answer.asset ? answer.asset : 'USDC',
          route: answer.route === 'oneclick' ? 'oneclick' : 'relay',
          /* What lands. On the 1Click route it is a quarter of a percent under the amount. */
          net: amountOf(answer.net) || amountOf(answer.amount)
        };
      })
      .catch(function () { return { ok: false, reason: 'offline' }; });
  }

  function claim(code) {
    return net.postJson('/api/invite/claim', { code: code })
      .then(function (answer) {
        if (answer && answer.ok === true && typeof answer.claim === 'string' && answer.claim) {
          return { ok: true, claim: answer.claim };
        }
        return { ok: false, reason: reasonOf(answer) };
      })
      .catch(function () { return { ok: false, reason: 'offline' }; });
  }

  /* A claim's progress in one shape, from the frame or the slice. */
  function outcomeOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = typeof raw.claim === 'string' && raw.claim ? raw.claim : '';
    if (!id || STATUSES.indexOf(raw.status) < 0) return null;
    return {
      claim: id,
      status: raw.status,
      amount: amountOf(raw.amount),
      asset: typeof raw.asset === 'string' && raw.asset ? raw.asset : ''
    };
  }

  /* Every outcome the app reports, from the stream as it happens and from the state
     slice as the window last read it. The frame carries `type: 'invite'` beside the
     contract's `kind`, because the stream dispatches on `type` (ui/core/events.js). */
  function onOutcome(fn) {
    var offs = [];
    if (events && typeof events.on === 'function') {
      offs.push(events.on('invite', function (frame) {
        var outcome = outcomeOf(frame);
        if (outcome) fn(outcome, 'frame');
      }));
    }
    if (store && typeof store.select === 'function') {
      offs.push(store.select('invite', function (slice) {
        var outcome = outcomeOf(slice);
        if (outcome) fn(outcome, 'state');
      }));
    }
    return function () {
      for (var i = 0; i < offs.length; i += 1) if (typeof offs[i] === 'function') offs[i]();
    };
  }

  /* THE CODE'S SHAPE, which keeps a code out of the chat: the contract's composer guard,
     mirrored exactly (src/invite/code.ts looksLikeInviteCode). First the canonical shape
     (INVITE_CODE_SOURCE, the log tail's redaction): PHOS or PH0S in any case, a separator
     or five data characters in a row, then 27 data characters with any spaces or hyphens
     between them and none after the 27th, alone or inside an invite link.

     Then one rule, because prose can fill the shape: two digits or more in the match, as
     typed, an O, I or L counting as a letter and the zero of a PH0S prefix as a digit.
     Every issued code carries two in its secret characters alone. "phosphorus is used in
     fertilizer and in matches" has the shape and no digit, so it goes; "phosphates cost
     25 dollars per ton in 2026 so" has two and stays out, a sentence given up so that a
     code typed with a slip in it still never reaches the assistant.
     tests/fixtures/invite-code-texts.ts holds this and the backend's copy to one corpus. */
  var SHAPE = /PH[O0]S(?:[\s-]+|(?=[0-9A-Z]{5}))[0-9A-Z](?:[\s-]*[0-9A-Z]){26}(?![0-9A-Z])/gi;
  var DIGITS = /[0-9]/g;

  function codeIn(text) {
    var value = String(text || '');
    SHAPE.lastIndex = 0;
    var found = SHAPE.exec(value);
    while (found !== null) {
      if ((found[0].match(DIGITS) || []).length >= 2) {
        SHAPE.lastIndex = 0;
        return found[0];
      }
      /* Prose that fits the shape: look on, from the next character, for a code after it. */
      SHAPE.lastIndex = found.index + 1;
      found = SHAPE.exec(value);
    }
    SHAPE.lastIndex = 0;
    return null;
  }

  window.PhosphorInviteApi = {
    check: check,
    claim: claim,
    onOutcome: onOutcome,
    outcomeOf: outcomeOf,
    codeIn: codeIn
  };
})();
