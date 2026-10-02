// How the shell tells its own backend from anything else that took the port.
//
// tests/unit/shell-handshake.test.ts holds the two halves of the marker together: the header this
// app sends and the header the shell probes for. This file is about the other half of that
// handshake, which was missing until now: the VALUE.
//
// It used to be the fixed word `control`, always. `x-phosphor: control` is a string any local
// process can send, so the shell's identity check was a liveness probe wearing an identity check's
// name. Two ways to be handed the approval token by it, both same-user and neither needing a
// privilege the attacker did not already have:
//
//   A. the boot race. `start` probes the port, finds it free, spawns the backend. Between that and
//      the backend's listen(), a local process binds the port and answers with the header. The
//      real backend dies on EADDRINUSE. The readiness loop tested the port BEFORE it tested
//      whether its own child had exited, so the squatter won the first iteration and
//      open_control_window injected window.__PHOSPHOR_TOKEN__ into its page.
//   B. the respawn, which is the deterministic one. `watch` sleeps three seconds before respawning
//      and had no port check on that path at all. Worse than A, because the control window from
//      the first boot is still open, still holds the token, and goes on posting writes and the
//      keystore passphrase to whatever is now answering.
//
// So the shell mints a nonce per spawn and writes it down the backend's stdin beside the window
// token. The nonce was echoed in the header at first, which only moved the hole: any local process
// could GET /api/health once, read it, and answer with it after the backend died (audit
// 2026-10-01, L15). Now the backend never sends it. The shell asks with a fresh challenge and the
// backend answers HMAC-SHA256(nonce, "phosphor identity\n" + challenge). The Rust half is tested in
// src-tauri/src/backend.rs against stub servers that replay the nonce and an earlier answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHALLENGE_HEADER, IDENTITY_HEADER, IDENTITY_VALUE, identityProof, identityValue, useIdentityValue } from '../../src/http/respond.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const NONCE = 'a1b2c3d4'.repeat(8);
const CHALLENGE = '0123456789abcdef'.repeat(4);

function shell(file: string): string {
  return fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', file), 'utf8');
}

function asked(challenge?: string): http.IncomingMessage {
  return { headers: challenge === undefined ? {} : { [CHALLENGE_HEADER]: challenge } } as unknown as http.IncomingMessage;
}

test('the identity header proves this boot nonce for a challenge and never shows the nonce', () => {
  assert.equal(identityValue(asked(CHALLENGE)), IDENTITY_VALUE, 'with no shell above it, the fixed word is the only answer');
  useIdentityValue(NONCE);
  const proof = identityValue(asked(CHALLENGE));
  assert.equal(proof, identityProof(NONCE, CHALLENGE));
  // The vector src-tauri/src/backend.rs holds the shell's side to, so the two halves agree.
  assert.equal(proof, 'a12aa33231a6d44541d89e7db2589e4bc49d9c5d92fc4faa2208ab845a607375');
  assert.notEqual(identityValue(asked('f'.repeat(64))), proof, 'every challenge has its own answer');

  for (const [why, req] of [
    ['no challenge (the survey, the page)', asked()],
    ['no request at all', undefined],
    ['upper-case hex', asked(CHALLENGE.toUpperCase())],
    ['too short', asked('ab')],
    ['two challenges joined by the parser', asked(`${CHALLENGE}, ${CHALLENGE}`)],
    ['header text', asked(`${CHALLENGE}\r\nx-phosphor: ${NONCE}`)],
  ] as const) {
    const value = identityValue(req);
    assert.equal(value, IDENTITY_VALUE, `${why}: the fixed word`);
    assert.ok(!value.includes(NONCE), `${why}: the nonce is never served`);
  }
});

test('an empty nonce leaves the earlier key rather than proving under an empty one', () => {
  useIdentityValue(NONCE);
  useIdentityValue('');
  assert.equal(identityValue(asked(CHALLENGE)), identityProof(NONCE, CHALLENGE));
});

test('both served headers answer the request they are answering', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'http', 'respond.ts'), 'utf8');
  assert.equal(
    source.split('[IDENTITY_HEADER]: identityValue(res.req),').length - 1,
    2,
    'sendJson and serveStatic must both prove against the challenge of the request in hand',
  );
  assert.ok(!source.includes('[IDENTITY_HEADER]: identityValue(),'), 'an answer that ignores the challenge');
  assert.equal(IDENTITY_HEADER, 'x-phosphor', 'the NAME is what shell-handshake.test.ts pins');
  assert.equal(CHALLENGE_HEADER, 'x-phosphor-challenge');
  assert.match(shell('backend.rs'), /x-phosphor-challenge: \{\}\\r\\n/, 'the shell sends the challenge under the same name');
});

test('a dead backend takes its window and its secrets with it, and the respawn gets its own', () => {
  // Audit 2026-10-01, HIGH. The dead backend's window used to stay open on the port, still holding
  // its token, while the shell slept and respawned with that same token. Now the window is torn
  // down the moment the child is gone, before the backoff, and the respawn mints and injects its
  // own token into a fresh window.
  const main = shell('main.rs');
  const from = main.indexOf('fn watch(');
  const watch = main.slice(from, main.indexOf('\nfn ', from + 1));
  const tearDown = watch.indexOf('show_reconnecting(&gone)');
  const respawn = watch.indexOf('spawn_backend(&paths.payload');
  const freshWindow = watch.indexOf('open_control_window(&back, port, &token, Some(RESTARTED))');
  assert.ok(tearDown > 0, 'the window is torn down when the child is seen gone');
  assert.ok(respawn > tearDown, 'and before the backoff and the respawn, so no page carries a token across the gap');
  assert.ok(freshWindow > respawn, 'the respawn builds a fresh window with its own token');
  assert.ok(!/notice\(&back, RESTARTED\)/.test(watch), 'the old code kept the same window and only wrote a notice onto it');

  // spawn_backend mints the handshake itself, one per spawn, and hands it back with the child.
  const backend = shell('backend.rs');
  assert.match(backend, /pub fn spawn_backend\(payload: &Path, data: &Path\) -> Result<\(Child, Handshake\), SpawnError>/);
  assert.ok(!/\bstruct Secrets\b/.test(main), 'there is no app-wide boot handshake to outlive a backend');
});

test('the control window is pinned to its own origin, and the enclave relay follows the respawn', () => {
  const main = shell('main.rs');
  // L3: the token init script runs on any page the window loads, so the window is pinned to its
  // http loopback origin. No in-window navigation exists today; this keeps it that way.
  assert.match(main, /\.on_navigation\(nav_guard\)/);
  assert.match(main, /url\.scheme\(\) == "http" && url\.host_str\(\) == origin_host\.as_deref\(\) && url\.port\(\) == Some\(port\)/);

  // L19: the relay is started for each spawn, keyed by that spawn's generation, so the old one
  // ends when a respawn replaces it and the respawn starts its own. It was started once only.
  assert.equal([...main.matchAll(/start_enclave_relay\(&\w+, port, &hand, generation\)/g)].length, 2, 'boot and respawn each start a relay');
  assert.match(main, /enclave::run\(relay, \|\| alive\.state::<Backend>\(\)\.alive\(generation\)\)/, 'the relay stops when its own spawn is gone, not merely any child');
});

test('the shell checks a proof rather than merely finding the header', () => {
  const source = shell('backend.rs');
  assert.match(source, /fn identity_matches\(response: &str, challenge: Option<&Challenge>\)/);
  assert.match(source, /fn phosphor_is_listening\(port: u16, nonce: Option<&str>\)/);
  assert.match(source, /format!\("phosphor identity\\n\{challenge\}"\)/, 'the same domain line as identityProof');
  assert.ok(
    !/contains\("x-phosphor:"\)/.test(source),
    'a header that is merely present is a liveness probe, and any local process can pass it',
  );
  for (const file of ['main.rs', 'enclave.rs']) {
    assert.ok(!/identity_matches\([^)]*Some\(nonce\)/.test(shell(file)), `${file}: compares a raw nonce`);
  }
});

test('the handshake reaches the backend on the pipe and never on the environment', () => {
  const source = shell('backend.rs');
  assert.match(source, /\.stdin\(Stdio::piped\(\)\)/);
  assert.match(source, /hand\.token, hand\.nonce, hand\.seat/, 'three lines, in the order src/main.ts reads them');
  assert.ok(!/\.env\("PHOSPHOR_WINDOW_TOKEN"/.test(source), 'ps eww prints the environment of any process this user owns');
});

test('the window only opens onto a backend that answered this spawn nonce', () => {
  const source = shell('main.rs');
  const opens = source.indexOf('open_control_window(&ready, port, &token, None)');
  assert.ok(opens > 0, 'the boot readiness loop is where the spawn token gets injected');

  // The two readiness loops pass this spawn's own nonce; only the launch survey, which gives way to
  // a running copy, stops a proven orphan or refuses, and never opens anything, asks the loose one.
  assert.equal(
    [...source.matchAll(/phosphor_is_listening\(port, Some\(&hand\.nonce\)\)/g)].length,
    2,
    'both the boot poll and the respawn poll must require this spawn own nonce',
  );
  assert.equal(
    [...source.matchAll(/phosphor_is_listening\(port, None\)/g)].length,
    1,
    'the only loose probe left is the launch survey, which opens nothing onto what it finds',
  );
});

test('a dead child is asked about before the port is, in both readiness loops', () => {
  const source = shell('main.rs');

  /* Sliced per function rather than searched whole, because the two loops are near-identical and
     an assertion that matched either would pass with one of them still wrong. This is the ordering
     the finding turns on: a backend that died on EADDRINUSE and a local process that took the port
     are the same observation from the port's side, so asking the port first lets the squatter win
     the first iteration and be handed a window with the approval token in it. */
  function body(name: string): string {
    const from = source.indexOf(`fn ${name}(`);
    assert.ok(from > 0, `fn ${name} must exist`);
    const next = source.indexOf('\nfn ', from + 1);
    return source.slice(from, next === -1 ? source.length : next);
  }

  for (const name of ['watch', 'start']) {
    const fn = body(name);
    const exitedAt = fn.indexOf('app_backend_exited(&');
    const listeningAt = fn.indexOf('phosphor_is_listening(port, Some(&hand.nonce))');
    assert.ok(exitedAt > 0, `fn ${name} must ask whether its own child has exited`);
    assert.ok(listeningAt > 0, `fn ${name} must require this spawn nonce before it trusts the port`);
    assert.ok(exitedAt < listeningAt, `fn ${name} must test its own child before it trusts the port`);
  }

  assert.match(
    body('watch'),
    /if get_root\(port\)\.is_some\(\)/,
    'the respawn path must refuse a port something else took during the backoff',
  );
});
