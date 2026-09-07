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
// So the shell mints a nonce per boot, writes it down the backend's stdin beside the window token,
// and the backend echoes it here. A squatter cannot read that pipe and cannot guess 32 random
// bytes. The Rust half is tested in src-tauri/src/backend.rs against a stub server that sends the
// header with the wrong value.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IDENTITY_HEADER, IDENTITY_VALUE, identityValue, useIdentityValue } from '../../src/http/respond.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function shell(file: string): string {
  return fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', file), 'utf8');
}

test('the identity value answers with this boot nonce once one has arrived', () => {
  const before = identityValue();
  try {
    assert.equal(before, IDENTITY_VALUE, 'with no shell above it, the fixed word is the answer');

    useIdentityValue('a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6');
    assert.equal(identityValue(), 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6');
    assert.notEqual(identityValue(), IDENTITY_VALUE, 'a value any process can send is not an identity');
  } finally {
    useIdentityValue(before);
  }
});

test('an empty nonce leaves the fallback rather than blanking the marker', () => {
  const before = identityValue();
  try {
    useIdentityValue('');
    assert.equal(identityValue(), before, 'a missing marker is a boot no shell can recognise at all');
  } finally {
    useIdentityValue(before);
  }
});

test('the served header carries whatever the identity value currently is', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'http', 'respond.ts'), 'utf8');
  assert.ok(
    source.includes('[IDENTITY_HEADER]: identityValue(),'),
    'serveStatic must send the live value, not the constant it falls back to',
  );
  assert.equal(IDENTITY_HEADER, 'x-phosphor', 'the NAME is what shell-handshake.test.ts pins');
});

test('the shell compares the marker value rather than merely finding the header', () => {
  const source = shell('backend.rs');
  assert.match(source, /fn identity_matches\(response: &str, nonce: Option<&str>\)/);
  assert.match(source, /fn phosphor_is_listening\(port: u16, nonce: Option<&str>\)/);
  assert.ok(
    !/contains\("x-phosphor:"\)/.test(source),
    'a header that is merely present is a liveness probe, and any local process can pass it',
  );
});

test('the handshake reaches the backend on the pipe and never on the environment', () => {
  const source = shell('backend.rs');
  assert.match(source, /\.stdin\(Stdio::piped\(\)\)/);
  assert.match(source, /hand\.token, hand\.nonce, hand\.seat/, 'three lines, in the order src/main.ts reads them');
  assert.ok(!/\.env\("PHOSPHOR_WINDOW_TOKEN"/.test(source), 'ps eww prints the environment of any process this user owns');
});

test('the window only opens onto a backend that answered with this boot nonce', () => {
  const source = shell('main.rs');
  const opens = source.indexOf('open_control_window(&ready, port)');
  assert.ok(opens > 0, 'the boot readiness loop is where the token gets injected');

  // The two readiness loops pass the nonce; only the refusal path, which goes on to name a process
  // to quit rather than open anything, asks the loose question.
  assert.equal(
    [...source.matchAll(/phosphor_is_listening\(port, Some\(&nonce\)\)/g)].length,
    2,
    'both the boot poll and the respawn poll must require this shell own nonce',
  );
  assert.equal(
    [...source.matchAll(/phosphor_is_listening\(port, None\)/g)].length,
    1,
    'the only loose probe left is the one that refuses by name',
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
    const listeningAt = fn.indexOf('phosphor_is_listening(port, Some(&nonce))');
    assert.ok(exitedAt > 0, `fn ${name} must ask whether its own child has exited`);
    assert.ok(listeningAt > 0, `fn ${name} must require this boot nonce before it trusts the port`);
    assert.ok(exitedAt < listeningAt, `fn ${name} must test its own child before it trusts the port`);
  }

  assert.match(
    body('watch'),
    /if get_root\(port\)\.is_some\(\)/,
    'the respawn path must refuse a port something else took during the backoff',
  );
});
