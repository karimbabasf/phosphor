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

// The other half of the contract lives in Rust, and the two have to agree on the CHANNEL and the
// shape or the window opens with a token the backend has never heard of. Read rather than
// assumed, because the failure is silent: every approval would simply be refused.
test('the shell and the backend agree on the channel and the injected global', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  const child = fs.readFileSync(path.join(ROOT, 'src-tauri/src/backend.rs'), 'utf8');

  /* Down the pipe, never through the environment. `ps eww <pid>` prints the environment of any
     process this user owns, so a token that travelled there was readable by every process on the
     machine: a local one drove the kill switch and approved a real proposal with it. */
  // Five lines now: the window token, the boot nonce the shell recognises its own backend by,
  // the roster seat secret, the enclave transport key and the relay secret. The token is still
  // line one, which is what src/http/auth.ts reads.
  assert.ok(
    child.includes('writeln!(pipe, "{}\\n{}\\n{}\\n{}\\n{}", hand.token, hand.nonce, hand.seat, hand.transport, hand.relay)'),
    "the shell writes the handshake to the backend's stdin, token first",
  );
  assert.ok(child.includes('.stdin(Stdio::piped())'), 'and opens a pipe for it to go down');
  assert.ok(!child.includes(WINDOW_TOKEN_VAR), 'the token is nowhere in the environment the shell hands over');
  assert.ok(shell.includes('window.__PHOSPHOR_TOKEN__'), 'the shell injects the token into the page');
  assert.ok(shell.includes('.initialization_script(&script)'), 'through an initialization script, so it runs before page script');
  // On the control window only. A splash that carried the token would put it on a second webview
  // for no reason, and the splash is created by a different builder call. Since the window went
  // dark only (2026-09-15) nothing read off the disk reaches the splash, and the colourway it
  // paints is the one in its own stylesheet. Its one script is its state, starting or failed
  // (splash_init), so a failure is drawn in the app's own look instead of a system alert.
  const controlBlock = shell.slice(shell.indexOf('fn open_control_window'), shell.indexOf('fn open_in_browser'));
  assert.ok(controlBlock.includes('initialization_script(&script)'), 'the injection sits in open_control_window');
  assert.equal(shell.split('initialization_script(&script)').length, 2, 'the token script is injected once, into the control window');
  const splashStart = shell.indexOf('fn open_splash');
  assert.ok(splashStart >= 0, 'the splash has one builder');
  const splashBlock = shell.slice(splashStart, shell.indexOf('.build()', splashStart));
  assert.ok(splashBlock.includes('WebviewWindowBuilder::new(app, SPLASH'), 'and it builds the splash');
  assert.ok(!splashBlock.includes('__PHOSPHOR_TOKEN__'), 'the splash window never receives the token');
  assert.ok(!splashBlock.includes('token'), 'nothing named token reaches the splash builder');
  assert.equal(splashBlock.split('initialization_script').length, 2, 'the splash is given one script');
  assert.ok(splashBlock.includes('.initialization_script(&splash_init(failed))'), 'and that script is its state');
  assert.ok(!shell.includes('__PHOSPHOR_PROFILE__'), 'no colourway is read off the disk and handed to a page');
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
  function body(name: string): string {
    const from = shell.indexOf(`fn ${name}(`);
    assert.ok(from > 0, `fn ${name} must exist`);
    const next = shell.indexOf('\nfn ', from + 1);
    return shell.slice(from, next === -1 ? shell.length : next);
  }
  // What a launch finds is acted on before anything is spawned, and every answer is one of four:
  // start its own backend, give way to a running copy of this app, stop a backend it proved an
  // orphan and then start, or refuse. None of them opens a window onto what it found.
  for (const name of ['launch', 'occupant', 'survey', 'hand_over']) {
    assert.ok(!body(name).includes('open_control_window'), `fn ${name} opens no window`);
  }
  const start = body('start');
  const spawn = start.indexOf('spawn_backend(');
  assert.ok(start.indexOf('match found') > 0 && start.indexOf('match found') < spawn, 'the survey is acted on before the spawn');
  assert.ok(!start.slice(0, spawn).includes('open_control_window'), 'and nothing before the spawn opens a window');
  // `None` on purpose: this is the loose question, "is a Phosphor holding this port", and the only
  // place it is still asked. It decides what to do about a process and never opens a window onto
  // one. tests/unit/boot-nonce.test.ts holds the other side, where the nonce is required.
  assert.match(body('occupant'), /if phosphor_is_listening\(port, None\)/);
  assert.ok(shell.includes('Quit it (`kill {backend}`)'), 'an orphan that will not stop is named with a command the person can run');
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
