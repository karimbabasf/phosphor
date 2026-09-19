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

/* The Sends section (2026-09-17) makes four claims a code change can falsify: that every send
   kind is turned from allow to needs_approval in land(), that the tool holds `confirmed` to the
   literal true, that the engine no longer allowlists a send's receiver, and that the reason
   sentence names the receiver. Each is read off the code here, not off the prose. */
test('the Sends section describes the gate the code has', () => {
  assert.ok(DOC.includes('## Sends'), 'the document has no Sends section');
  assert.ok(DOC.replace(/\s+/g, ' ').includes('There is no allowlist for a receiver'), 'the section has to say there is no allowlist');

  const execute = fs.readFileSync(path.join(ROOT, 'src', 'proposals', 'execute.ts'), 'utf8');
  for (const kind of ['intents_send', 'intents_pay', 'hl_withdraw']) {
    assert.ok(execute.includes(`'${kind}'`), `land() does not name ${kind}`);
  }
  assert.match(execute, /p\.verdict\.outcome === 'allow'[\s\S]*?outcome: 'needs_approval'/, 'land() no longer turns allow into needs_approval');

  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp.ts'), 'utf8');
  assert.match(mcp, /confirmed: z\.literal\(true\)/, 'propose_send lost the literal-true confirmed field');
  assert.ok(mcp.includes("'propose_send'"), 'propose_send is not registered');
  assert.ok(!mcp.includes("'propose_intents_send'"), 'the old send tool is back');

  const engine = fs.readFileSync(path.join(ROOT, 'src', 'policy', 'engine.ts'), 'utf8');
  assert.match(engine, /draft\.kind === 'intents_send' \|\| draft\.kind === 'intents_pay'\) return null/, 'the engine allowlists a send receiver again');

  const reason = fs.readFileSync(path.join(ROOT, 'src', 'vault', 'reason.ts'), 'utf8');
  assert.match(reason, /case 'intents_pay':[\s\S]*?shortAddress\(draft\.to\)/, 'the Touch ID sentence for a payout does not name the receiver');
  assert.ok(DOC.includes('Pay 0.01 ETH to 0xb583f4...84BB5DB0 on Ethereum ($24.40)'), 'the documented dialog sentence has to be the one the code writes');

  const door = fs.readFileSync(path.join(ROOT, 'src', 'http', 'propose.ts'), 'utf8');
  assert.match(door, /params\.confirmed !== true/, 'the door no longer holds confirmed to true');
});
