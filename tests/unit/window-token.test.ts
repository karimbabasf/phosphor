// Where the window token comes from.
//
// The shell mints 32 random bytes, passes them here as PHOSPHOR_WINDOW_TOKEN, and injects the
// same value into the control webview alone. The token is then reachable by exactly two processes
// and served over HTTP by neither, which is the whole point: a per-boot token that any local
// caller could read was an identifier, never an authorisation.
//
// The mint is the development path. `npm run app` has no shell above it, so a token is made and
// printed to stderr, because a token nobody can read is a window nobody can approve in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { windowToken, mintToken, tokenMatches, WINDOW_TOKEN_VAR } from '../../src/http/auth.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('the environment wins when it carries a token', () => {
  const supplied = 'a'.repeat(64);
  assert.equal(windowToken({ [WINDOW_TOKEN_VAR]: supplied }), supplied);
  assert.equal(windowToken({ [WINDOW_TOKEN_VAR]: `  ${supplied}  ` }), supplied, 'trimmed');
});

test('an absent, empty or truncated variable mints one instead of running without', () => {
  const minted = windowToken({});
  assert.match(minted, /^[0-9a-f]{64}$/, '32 bytes, the same as the shell mints');
  for (const bad of ['', '   ', 'short', 'a'.repeat(31)]) {
    const out = windowToken({ [WINDOW_TOKEN_VAR]: bad });
    assert.notEqual(out, bad.trim());
    assert.equal(out.length, 64, 'a value below the floor is a broken variable, not a shorter secret');
  }
});

test('two mints are different, so a token is never guessable from another run', () => {
  assert.notEqual(mintToken(), mintToken());
});

test('the supplied token is the one every write is checked against', () => {
  const supplied = 'b'.repeat(64);
  const token = windowToken({ [WINDOW_TOKEN_VAR]: supplied });
  assert.equal(tokenMatches(supplied, token), true);
  assert.equal(tokenMatches('b'.repeat(63) + 'c', token), false);
  assert.equal(tokenMatches('', token), false);
  assert.equal(tokenMatches(undefined, token), false);
});

// The other half of the contract lives in Rust, and the two have to agree on the name and the
// shape or the window opens with a token the backend has never heard of. Read rather than
// assumed, because the failure is silent: every approval would simply be refused.
test('the shell and the backend agree on the variable and the injected global', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  const child = fs.readFileSync(path.join(ROOT, 'src-tauri/src/backend.rs'), 'utf8');

  assert.ok(child.includes(`.env("${WINDOW_TOKEN_VAR}", token)`), 'the shell passes the token to node under the agreed name');
  assert.ok(shell.includes('window.__PHOSPHOR_TOKEN__'), 'the shell injects the token into the page');
  assert.ok(shell.includes('.initialization_script(&script)'), 'through an initialization script, so it runs before page script');
  // On the control window only. A splash that carried the token would put it on a second webview
  // for no reason, and the splash is created by a different builder call.
  const controlBlock = shell.slice(shell.indexOf('fn open_control_window'), shell.indexOf('fn refuse_existing'));
  assert.ok(controlBlock.includes('initialization_script'), 'the injection sits in open_control_window');
  const splashBlock = shell.slice(shell.indexOf('"splash"'));
  assert.ok(!splashBlock.includes('initialization_script'), 'the splash window never receives it');
});

test('the shell refuses to inject anything that is not hex', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  assert.ok(
    shell.includes('is_ascii_hexdigit'),
    'a token with a quote in it would break out of the injected literal, so the shape is checked',
  );
});

// ---------- the shell as a supervisor ----------
//
// Everything below is a property of Rust that no Node test can execute, so it is asserted
// against the source. That is a weak form of test and it is here for one reason: each of these
// lines was ABSENT and its absence cost something real, so a silent removal has to fail
// something. The behavioural proof is manual (kill the node pid, watch the window say so).

function shellSource(): string {
  return (
    fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8') +
    fs.readFileSync(path.join(ROOT, 'src-tauri/src/backend.rs'), 'utf8')
  );
}

test('the backend has a Drop guard, so a force quit cannot orphan it', () => {
  const src = shellSource();
  assert.match(src, /impl Drop for Backend/);
  assert.match(src, /fn drop\(&mut self\) \{\s*self\.kill\(\);/);
});

test('a pid file is written at spawn and removed when the backend is killed', () => {
  const src = shellSource();
  assert.match(src, /fn write_pid_file/);
  assert.match(src, /fn read_pid_file/);
  assert.match(src, /fn clear_pid_file/);
  assert.ok(src.includes('"shell": std::process::id()'), 'the file names the shell as well as the backend');
});

test('a launch never attaches to a backend it did not start', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  // The old line was `if phosphor_is_listening(port) { return open_control_window(app, port); }`,
  // and that is how the orphan became permanent: the window attached to a process the shell held
  // no handle for, so every later quit killed nothing.
  const start = shell.slice(shell.indexOf('fn start(app: &tauri::AppHandle)'));
  assert.match(start, /if phosphor_is_listening\(port\) \{\s*return Err\(refuse_existing/);
  assert.ok(shell.includes('fn refuse_existing'), 'and the refusal names the process holding the port');
  assert.ok(shell.includes('Quit it (`kill {}`)'), 'with a command the person can actually run');
});

test('the readiness thread goes on to supervise rather than returning', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(shell, /watch\(handle, paths, port\);/, 'the same thread keeps watching after the window opens');
  assert.match(shell, /fn watch\(/);
  assert.ok(shell.includes('RESPAWN_BACKOFF'), 'a post-boot death is respawned once, with a backoff');
  assert.ok(shell.includes('stopped twice'), 'and twice is a crash loop, so it stops and says so');
});

test('closing the window asks the backend to lock', () => {
  const src = shellSource();
  assert.ok(src.includes('fn post_lock'));
  assert.match(src, /POST \/api\/lock HTTP\/1\.1/);
  assert.ok(src.includes('WindowEvent::CloseRequested'), 'on the close event');
});
