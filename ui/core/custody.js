/* What a person types as a backup, read the one way every screen reads it,
   and what a refused Touch ID request says on screen. The first run, the lock
   card and the Vault each take a private key back (restore, Check your copy),
   and each used to read it its own way.

   A key is told from recovery words by its digits: the words of a phrase
   never hold one. It is read the way the app reads it (src/keystore/derive.ts
   keyProblem): 0x or not, either case, spaces, line breaks or dashes between
   the groups, and the sixteen groups typed with the numbers the backup and
   its printed sheet show beside them. What cannot be a key is said by the
   group it is in, so a person looks at one group of their paper, not all
   sixty-four characters, and nothing it says quotes what was typed.

   A refusal's sentence is the backend's (src/http/wallet.ts REFUSALS, one per
   code). `sentence` puts it on screen only when it reads as one: a code, a
   status number or an OS phrase is never shown, whatever sent it. */
(function () {
  'use strict';

  var KEY_LENGTH = 64;
  var GROUPS = 16;
  var GROUP = 4;
  var NUMBER = /^(\d{1,2})[.):]?$/;

  var CANCELLED = 'Touch ID was cancelled. Nothing changed.';
  var NOT_A_KEY = 'a private key never uses. A key has only 0 to 9 and a to f.';

  function fold(text) {
    var raw = String(text || '');
    return typeof raw.normalize === 'function' ? raw.normalize('NFKC') : raw;
  }

  function isKey(text) {
    return /[0-9]/.test(fold(text));
  }

  function countWords(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /* { hex, problem }: the 64 characters when `problem` is null, else the one
     sentence that says what to look at. */
  function readKey(text) {
    var folded = fold(text).toLowerCase();
    var tokens = folded.split(/[\s\p{Pd}]+/u).filter(Boolean);
    // Sixteen numbered groups, as the backup shows them: the numbers go.
    if (tokens.length === GROUPS * 2 && tokens.every(function (t, i) { return i % 2 === 1 || numberOf(t) === i / 2 + 1; })) {
      tokens = tokens.filter(function (t, i) { return i % 2 === 1; });
    }
    if (tokens.length && tokens[0].indexOf('0x') === 0) {
      tokens[0] = tokens[0].slice(2);
      if (!tokens[0]) tokens.shift();
    }
    var hex = tokens.join('');
    var bad = hex.search(/[^0-9a-f]/);
    if (bad >= 0) return { hex: '', problem: strayIn(tokens, hex, bad) };
    if (hex.length !== KEY_LENGTH) {
      return { hex: '', problem: 'That is ' + countWords(hex.length, 'character', 'characters') + '. A private key is 64.' };
    }
    return { hex: hex, problem: null };
  }

  function numberOf(token) {
    var m = NUMBER.exec(token);
    return m ? Number(m[1]) : -1;
  }

  /* The group a stray character is in: by the groups as typed when there are
     sixteen of them, by its place in a key typed whole when that is 64 long
     (the printed groups are fours), and by neither otherwise. */
  function strayIn(tokens, hex, at) {
    var group = -1;
    if (tokens.length === GROUPS) {
      for (var i = 0; i < tokens.length && group < 0; i += 1) {
        if (/[^0-9a-f]/.test(tokens[i])) group = i;
      }
    } else if (hex.length === KEY_LENGTH) {
      group = Math.floor(at / GROUP);
    }
    return group >= 0 ? 'Group ' + (group + 1) + ' has a character ' + NOT_A_KEY : 'That has a character ' + NOT_A_KEY;
  }

  /* The backend's sentence when it is one, `fallback` when it is anything
     else. */
  function sentence(answer, fallback) {
    var text = answer && typeof answer.error === 'string' ? answer.error.trim() : '';
    if (!/^[A-Z][^_]*[.!?]$/.test(text)) return fallback;
    if (/-\d{4,5}\b|no user present|access control/i.test(text)) return fallback;
    return text;
  }

  window.PhosphorCustody = {
    CANCELLED: CANCELLED,
    isKey: isKey,
    readKey: readKey,
    sentence: sentence
  };
})();
