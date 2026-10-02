/* The invite code's one door to the app: two routes, one frame on the stream and one
   slice of the state. Every call the invite screens make goes through here, so wiring
   the backend is this file and nothing else.

     POST /api/invite/check  { token, code }  what the code holds, or why it cannot pay
     POST /api/invite/claim  { token, code }  202 and an opaque claim id; runs on its own
     frame { type: 'invite', claim, status, amount?, asset?, reason? }  how a claim ended
     state.invite { claim, status, amount, reason? }  the latest claim, for a window opened late
     (reason is 'clock' on a claim that failed because this Mac's clock is behind, else absent)

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
      asset: typeof raw.asset === 'string' && raw.asset ? raw.asset : '',
      /* The one end a person can fix: a Mac clock set wrong. Anything else reads as no reason. */
      reason: raw.status === 'failed' && raw.reason === 'clock' ? 'clock' : ''
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
     mirrored exactly (src/invite/code.ts findInviteCode).

     First the fold: each character through Unicode NFKD, with marks and invisible format
     characters dropped, so a dash an editor put in, a zero-width space or a full-width
     letter reads as the code it was. After it an ASCII letter or digit is a data character
     and anything else separates.

     Then a match is the canonical shape (INVITE_CODE_SOURCE, the log tail's redaction):
     PHOS or PH0S in any case, a separator, five data characters in a row or a digit, then
     27 data characters with any separators between them and none after the 27th, alone or
     inside an invite link. Or a bare run, a code copied without its prefix: 27 data
     characters that start a word and end one, only spaces or dashes between them, every
     group but the last three or more long, that read as a valid code and hold two digits.

     Then one rule, because prose can fill the shape: two digits or more in the match, as
     typed, an O, I or L counting as a letter and the zero of a PH0S prefix as a digit.
     Every issued code carries two in its secret characters alone. "phosphorus is used in
     fertilizer and in matches" has the shape and no digit, so it goes; "phosphates cost
     25 dollars per ton in 2026 so" has two and stays out, a sentence given up so that a
     code typed with a slip in it still never reaches the assistant.

     codeIn answers the first such match as it was written, so the composer can take
     exactly that out of the box. tests/fixtures/invite-code-texts.ts holds this and the
     backend's copy to one corpus. */
  var SHAPE = /PH[O0]S(?:[^0-9A-Za-z]+|(?=[0-9A-Za-z]{5})|(?=[0-9]))[0-9A-Za-z](?:[^0-9A-Za-z]*[0-9A-Za-z]){26}(?![0-9A-Za-z])/gi;
  var DIGITS = /[0-9]/g;
  var DATA = /[0-9A-Za-z]/;
  var BARE_SEP = /[\s\p{Pd}−]/u;
  var DROPPED = /[\p{M}\p{Cf}]/gu;
  var CODE_POINTS = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g;
  var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function fold(value) {
    if (!/[^\x00-\x7f]/.test(value)) return { text: value, starts: null, ends: null };
    var text = '';
    var starts = [];
    var ends = [];
    var at = 0;
    var chars = value.match(CODE_POINTS) || [];
    for (var c = 0; c < chars.length; c += 1) {
      var ch = chars[c];
      var out = ch.charCodeAt(0) < 0x80 ? ch : ch.normalize('NFKD').replace(DROPPED, '');
      for (var i = 0; i < out.length; i += 1) {
        starts.push(at);
        ends.push(at + ch.length);
      }
      text += out;
      at += ch.length;
    }
    return { text: text, starts: starts, ends: ends };
  }

  /* Crockford's reading: any case, O as 0, I and L as 1, U never. */
  function crockford(ch) {
    if (!DATA.test(ch)) return -1;
    var upper = ch.toUpperCase();
    var mapped = upper === 'O' ? '0' : upper === 'I' || upper === 'L' ? '1' : upper;
    return CROCKFORD.indexOf(mapped);
  }

  function digitsIn(text) {
    return (text.match(DIGITS) || []).length;
  }

  /* Every match of the canonical shape, overlapping ones included: prose that fits the
     shape can swallow the prefix of a code right behind it, so each search starts again
     one character after the last match's start. */
  function shapeMatches(text, out) {
    SHAPE.lastIndex = 0;
    var found = SHAPE.exec(text);
    while (found !== null) {
      out.push({ start: found.index, end: found.index + found[0].length, digits: digitsIn(found[0]) });
      SHAPE.lastIndex = found.index + 1;
      found = SHAPE.exec(text);
    }
    SHAPE.lastIndex = 0;
  }

  /* Every bare run that reads as a valid code: the first character 0 to 7, every one a
     Crockford character, the 27th the mod 37 check of the 26 before it, only spaces or
     dashes between them, no group but the last under three long, and two digits. */
  function bareRuns(text, out) {
    for (var start = 0; start < text.length; start += 1) {
      if (!DATA.test(text[start]) || (start > 0 && DATA.test(text[start - 1]))) continue;
      var first = crockford(text[start]);
      if (first < 0 || first >= 8) continue;
      var check = 0;
      var count = 0;
      var digits = 0;
      var group = 0;
      var short = false;
      var end = start;
      for (var i = start; i < text.length && count < 27; i += 1) {
        var ch = text[i];
        if (!DATA.test(ch)) {
          if (!BARE_SEP.test(ch)) break;
          if (group > 0 && group < 3) short = true;
          group = 0;
          continue;
        }
        var index = crockford(ch);
        if (index < 0) break;
        if (count < 26) check = (check * 32 + index) % 37;
        else if (index !== check) break;
        if (ch >= '0' && ch <= '9') digits += 1;
        count += 1;
        group += 1;
        end = i + 1;
      }
      if (count !== 27 || short || digits < 2 || (end < text.length && DATA.test(text[end]))) continue;
      out.push({ start: start, end: end, digits: digits });
    }
  }

  function codeIn(text) {
    var value = String(text || '');
    var folded = fold(value);
    var found = [];
    shapeMatches(folded.text, found);
    bareRuns(folded.text, found);
    var best = null;
    for (var i = 0; i < found.length; i += 1) {
      var f = found[i];
      if (f.digits < 2) continue;
      var from = folded.starts ? folded.starts[f.start] : f.start;
      var to = folded.ends ? folded.ends[f.end - 1] : f.end;
      if (best === null || from < best.from || (from === best.from && to > best.to)) best = { from: from, to: to };
    }
    return best === null ? null : value.slice(best.from, best.to);
  }

  window.PhosphorInviteApi = {
    check: check,
    claim: claim,
    onOutcome: onOutcome,
    outcomeOf: outcomeOf,
    codeIn: codeIn
  };
})();
