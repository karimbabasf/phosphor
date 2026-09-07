// The security model document, held to the code it describes.
//
// On this app the document is a control. It is what a reviewer reads, and what the person deciding
// how much money to leave in the wallet reads. It went stale in the worst possible direction: it
// described a hole that had been closed (`GET /api/session` handing the approval token to any local
// caller) and said nothing about the one that was open, so it sent a reader to reproduce something
// that no longer exists and left them believing the reproduction failing meant they were safe.
//
// These do not check prose. They check the handful of facts in it that a code change can falsify,
// which is the half that goes stale silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'security-model.md'), 'utf8');

function lines(needle: string): string[] {
  return DOC.split('\n').filter((line) => line.includes(needle));
}

test('/api/session is only ever mentioned as something that is gone', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src', 'http', 'router.ts'), 'utf8');
  assert.ok(!router.includes("'/api/session'"), 'the route is deleted, and this test is about saying so');

  // Every mention has to carry its own evidence that it is history. Without this the document can
  // drift back to describing it as live, which is the exact failure being guarded.
  const history = /used to|deleted|404|no longer/;
  for (const line of lines('/api/session')) {
    assert.match(line, history, `security-model.md mentions /api/session as if it still exists: ${line.trim()}`);
  }
});

test('the document does not tell a reader the token is served', () => {
  for (const claim of ['served at `/api/session`', 'handed to the page by `GET /api/session`']) {
    assert.ok(!DOC.includes(claim), `security-model.md still claims the token is ${claim}`);
  }
  assert.ok(DOC.includes('The window token is never served.'), 'and it has to say the opposite plainly');
});

test('the document does not claim an absent Origin is allowed', () => {
  // src/http/auth.ts requires a present, matching Origin, and refuses the literal `null` a
  // sandboxed iframe sends. The document said the opposite, and so did two comments.
  assert.ok(!DOC.includes('An absent `Origin` (curl, the e2e script) is allowed'));
  const auth = fs.readFileSync(path.join(ROOT, 'src', 'http', 'auth.ts'), 'utf8');
  assert.match(auth, /origin === 'null'\) return false/, 'the code this paragraph describes');
});

test('the token length the document states is the length the shell mints', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'backend.rs'), 'utf8');
  assert.match(shell, /let mut bytes = \[0u8; 32\]/, 'the shell mints 32 bytes');
  assert.ok(DOC.includes('32 random bytes, hex'), 'and the document has to say 32, not the old 24');
  assert.ok(!DOC.includes('24-byte hex token'));
  assert.ok(!DOC.includes('24 random bytes'));
});

test('every source file the document points at exists', () => {
  const named = new Set([...DOC.matchAll(/`(src(?:-tauri)?\/[A-Za-z0-9_./-]+\.(?:ts|rs))`/g)].map((m) => m[1]));
  assert.ok(named.size > 0, 'the document is supposed to name the code it describes');
  for (const file of named) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `security-model.md points at ${file}, which is not there`);
  }
});

test('the three secrets the document describes are the three the shell mints', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'backend.rs'), 'utf8');
  assert.match(shell, /pub struct Handshake \{[\s\S]*?token: String,[\s\S]*?nonce: String,[\s\S]*?seat: String,/);
  for (const name of ['window token', 'boot nonce', 'seat secret']) {
    assert.ok(DOC.includes(name), `security-model.md has to name the ${name}`);
  }
});

test('no long dash reaches the document', () => {
  // Built from code points rather than written out, so this file holds none of them itself.
  const long = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
  const offenders = DOC.split('\n')
    .map((line, n) => ({ line, n: n + 1 }))
    .filter(({ line }) => long.test(line));
  assert.deepEqual(offenders.map(({ n }) => n), []);
});
