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
     slice as the window last read it. The stream keys a frame by `type`
     (ui/core/events.js); the contract calls the same field `kind`, so a frame that
     carries it under that name is read too. */
  function onOutcome(fn) {
    var offs = [];
    if (events && typeof events.on === 'function') {
      offs.push(events.on('invite', function (frame) {
        var outcome = outcomeOf(frame);
        if (outcome) fn(outcome, 'frame');
      }));
      offs.push(events.on('*', function (frame) {
        if (!frame || frame.type === 'invite' || frame.kind !== 'invite') return;
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

  /* THE CODE'S SHAPE, which keeps a code out of the chat. The contract's shape: PHOS or
     PH0S in any case, then 27 data characters from 0-9 and A-Z with any spaces or
     hyphens between them, alone or inside an invite link. The backend's matcher (the log
     tail's redaction) is the canonical one and this mirrors it, tested on the same forms.

     One rule more on this side. The first data character carries the two spare bits,
     which are always zero, so it is 0 to 7 (or O, I or L, which the parser reads as 0, 1
     and 1). Without that rule "Phosphor send 50 usdc to my wallet please" has 27 letters
     and digits after its "Phos" and a plain message would be refused. */
  var SHAPE = /PH[O0]S(?:[\s-]*[0-9A-Z]){27}/gi;
  var FIRST = /^[\s-]*[0-7OIL]/i;

  function codeIn(text) {
    var value = String(text || '');
    SHAPE.lastIndex = 0;
    var found = SHAPE.exec(value);
    while (found !== null) {
      if (FIRST.test(found[0].slice(4))) {
        SHAPE.lastIndex = 0;
        return found[0];
      }
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
