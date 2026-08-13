// The one place in this app where a string becomes a command.
//
// /api/summon opens a terminal. Nothing from the request reaches the command line, but a
// filesystem path still does, and a path is still a string. These tests read the exact text
// that would run, without a terminal ever appearing, which is the whole reason summonScript
// is a pure function separate from the process spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appleQuote, shellQuote, summonAgent, summonScript } from '../../src/summon.ts';

test('shell quoting survives the one character that can break out: the quote itself', () => {
  assert.equal(shellQuote('/Users/k/plain'), `'/Users/k/plain'`);
  // close, escape, reopen. The result is still one shell word.
  assert.equal(shellQuote(`/Users/k/O'Brien`), `'/Users/k/O'\\''Brien'`);
  assert.equal(shellQuote('/Users/k/a b'), `'/Users/k/a b'`);
  // Inside single quotes these are literal, so they must NOT be escaped into something else.
  assert.equal(shellQuote('/tmp/$(id)/`id`/;rm -rf'), `'/tmp/$(id)/\`id\`/;rm -rf'`);
});

test('applescript quoting escapes the backslash before the quote, not after', () => {
  // Backslash last would double-escape the backslashes the quote pass just added, and the
  // script would carry a different path than the one asked for.
  assert.equal(appleQuote('plain'), '"plain"');
  assert.equal(appleQuote('a"b'), '"a\\"b"');
  assert.equal(appleQuote('a\\b'), '"a\\\\b"');
  assert.equal(appleQuote('a\\"b'), '"a\\\\\\"b"');
});

test('the script cds to the project and runs claude, and nothing else', () => {
  const script = summonScript('/Users/k/phosphor');
  assert.equal(
    script,
    ['tell application "Terminal"', '  activate', '  do script "cd \'/Users/k/phosphor\' && claude"', 'end tell'].join('\n'),
  );
  // Bare `claude`, never an absolute path: on this machine it is a shell function that adds
  // --effort max, and `do script` runs a login shell so the function is in scope. Resolving
  // the binary directly would silently start a weaker agent than the user configured.
  assert.ok(!script.includes('/bin/claude'));
});

test('a hostile path is quoted into inertness rather than executed', () => {
  // Asserted by decoding rather than by pattern, because the interesting property is the
  // round trip through BOTH layers: applescript unescapes to a shell line, and that shell
  // line has to still be `cd <one word> && claude`. Matching an escape sequence by eye would
  // pass just as happily on a string that had been escaped once too many times.
  const hostile = `/tmp/x'; osascript -e 'do shell script "curl evil"`;
  const script = summonScript(hostile);

  const line = script.split('\n').filter((l) => l.trim().startsWith('do script'));
  assert.equal(line.length, 1, 'exactly one command, whatever the path contains');

  // Undo the applescript literal: \\ -> \ and \" -> "
  const literal = line[0].trim().slice('do script '.length);
  assert.ok(literal.startsWith('"') && literal.endsWith('"'));
  const shell = literal.slice(1, -1).replace(/\\(["\\])/g, '$1');

  // Undo the shell quoting: the whole path is one word, and '\'' is a literal quote.
  assert.ok(shell.startsWith(`cd '`) && shell.endsWith(`' && claude`));
  const word = shell.slice(4, -' && claude'.length - 1);
  assert.equal(word.replace(/'\\''/g, `'`), hostile, 'the path arrives intact and inert');
});

test('a path with a control character is refused, not escaped', () => {
  // There is no legitimate project directory with a newline in it, so accepting one would
  // only be a way to be clever about input that should not exist.
  const runner = async () => {
    throw new Error('must not run');
  };
  return summonAgent('/tmp/a\nb', 'darwin', runner).then((out) => {
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.error : '', /control character/);
  });
});

test('off macOS it says so plainly and tells you the command to type', () => {
  const runner = async () => {
    throw new Error('must not run');
  };
  return summonAgent('/srv/phosphor', 'linux', runner).then((out) => {
    assert.equal(out.ok, false);
    const error = out.ok === false ? out.error : '';
    assert.match(error, /only runs on macOS/);
    // The fallback is useful or it is not worth printing: it carries the real path.
    assert.match(error, /cd \/srv\/phosphor && claude/);
  });
});

test('a runner that fails is reported, not swallowed', () => {
  const runner = async () => {
    throw new Error('osascript: not permitted');
  };
  return summonAgent('/Users/k/phosphor', 'darwin', runner).then((out) => {
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.error : '', /not permitted/);
  });
});

test('the happy path calls osascript with exactly two arguments', () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
  };
  return summonAgent('/Users/k/phosphor', 'darwin', runner).then((out) => {
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'osascript');
    // -e plus the script. No shell, so no second layer of quoting to get wrong.
    assert.equal(calls[0].args.length, 2);
    assert.equal(calls[0].args[0], '-e');
    assert.equal(calls[0].args[1], summonScript('/Users/k/phosphor'));
  });
});
