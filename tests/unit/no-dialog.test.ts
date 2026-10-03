// npm test never opens a dialog on the Mac that runs it (tests/unit/helpers/no-dialog.ts).
//
// Three holds. The vault service can ask a person in exactly one op once the stand-in replaces its
// keychain and enclave, and that op is the one every runner refuses. Both runners refuse it loudly:
// the stand-in throws, and its shell answers with a refusal and then fails the test when it stops,
// rather than leaving the backend waiting out its 150 seconds. And nothing npm test runs starts a
// program that shows something: no AppleScript, no app or browser, no sound, no disk image, no
// signing identity, and the one real service built here (the peer check) is only asked a probe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIALOG_OPS, refuseDialog } from './helpers/no-dialog.ts';
import { relayTo, SEAM, SERVICE, VaultDouble } from './helpers/vault-double.ts';
import type { Post } from './helpers/vault-double.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWIFT = fs.readFileSync(SERVICE, 'utf8');

/* The text of a top-level Swift declaration that starts at `head`, up to its closing brace at the
   start of a line. */
function block(source: string, head: string): { from: number; to: number } {
  const from = source.indexOf(head);
  assert.ok(from >= 0, `main.swift has no ${head}`);
  const to = source.indexOf('\n}\n', from);
  assert.ok(to > from, `${head} has no end`);
  return { from, to };
}

test('the vault service asks a person only in presence once the stand-in replaces its keychain and enclave', () => {
  assert.doesNotMatch(fs.readFileSync(SEAM, 'utf8'), /LocalAuthentication|LAContext|evaluatePolicy|kSecUseAuthenticationContext/, 'the stand-in reaches LocalAuthentication');
  const system = block(SWIFT, 'struct SystemPlatform');
  const outside = (at: number): boolean => at < system.from || at > system.to;
  // A dialog comes from evaluatePolicy, or from a keychain call handed a context that may ask.
  // canEvaluatePolicy (probe) only answers whether it could, and quiet() forbids asking.
  const asking = [...SWIFT.matchAll(/(?<![A-Za-z])evaluatePolicy\(|kSecUseAuthenticationContext as String: (?!quiet\(\))/g)].map((m) => m.index ?? -1).filter(outside);
  const owners = asking.map((at) => {
    const head = SWIFT.lastIndexOf('\nfunc ', at);
    return SWIFT.slice(head + 6, SWIFT.indexOf('(', head));
  });
  assert.deepEqual([...new Set(owners)], ['presence'], `outside the seam, only presence may ask a person: ${owners.join(', ')}`);
  const ops = [...SWIFT.matchAll(/case "([a-z]+)": result = (?:try )?([a-zA-Z]+)\(req\)/g)].filter((m) => owners.includes(m[2]!)).map((m) => m[1]);
  assert.deepEqual(ops, [...DIALOG_OPS], 'the ops that reach it are the ones every runner refuses');
});

test('every runner of the service refuses presence, loudly, and passes every other op', async () => {
  assert.throws(() => refuseDialog({ op: 'presence', reason: 'Forget this wallet on this Mac' }), /would open a real Touch ID dialog/);
  for (const op of ['probe', 'create', 'unwrap', 'commit', 'sweep', 'status']) assert.doesNotThrow(() => refuseDialog({ op }), op);
  // The stand-in refuses before it starts anything.
  assert.throws(() => new VaultDouble().run({ op: 'presence' }), /would open a real Touch ID dialog/);

  // Its shell answers presence with a refusal, so the backend is not left waiting, and fails the
  // test when it stops; a test that answers presence in its hook stops cleanly.
  for (const hooked of [false, true]) {
    const answered: Record<string, unknown>[] = [];
    let handed = false;
    const post: Post = async (route, body) => {
      if (route === '/api/vault/pending') {
        if (!handed) {
          handed = true;
          return { status: 200, json: { request: { id: 'r1', op: 'presence', reason: 'Forget this wallet on this Mac' } } };
        }
        await new Promise((r) => setTimeout(r, 5));
        return { status: 200, json: { request: null } };
      }
      answered.push(body);
      return { status: 200, json: { ok: true } };
    };
    const shell = relayTo(post, new VaultDouble(), Buffer.alloc(32), (r) => (hooked && r.op === 'presence' ? { kind: 'answer', answer: { ok: true } } : { kind: 'run' }));
    for (let i = 0; i < 200 && answered.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(answered.length, 1, 'the request was answered');
    if (hooked) {
      assert.deepEqual(answered[0], { ok: true, id: 'r1' });
      await shell.stop();
    } else {
      assert.equal(answered[0]!.error, 'interaction_required');
      await assert.rejects(shell.stop(), /would open a real Touch ID dialog/);
    }
  }
});

/* What npm test runs (package.json "test"), and everything it imports from tests/: this file's own
   patterns are left out, being the list itself. */
function suiteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && full !== fileURLToPath(import.meta.url)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'tests', 'unit'));
  walk(path.join(ROOT, 'tests', 'fixtures'));
  out.push(path.join(ROOT, 'tests', 'injection.test.ts'), path.join(ROOT, 'tests', 'lockdown.test.ts'));
  return out;
}

const CALL = String.raw`(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|run)\(\s*['"\x60]`;

test('nothing npm test runs starts a program that shows something on screen', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.ts tests/unit/*.test.ts tests/injection.test.ts tests/lockdown.test.ts', 'npm test runs other files: widen this scan');
  const never: Array<[RegExp, string]> = [
    [/\bosascript\b/, 'AppleScript can show dialogs and asks to control other apps'],
    [new RegExp(`${CALL}(?:/usr/bin/)?open['"\\x60]`), 'open starts an app or a browser'],
    [new RegExp(`${CALL}(?:afplay|say)['"\\x60]`), 'a sound'],
    [new RegExp(`${CALL}hdiutil['"\\x60]\\s*,\\s*\\[\\s*['"\\x60]attach`), 'a mounted disk image opens a Finder window'],
    [/se-helper-dev-|binaries\/xpc\/com\.karimbabasf\.phosphor\.vault\.xpc['"\x60]\s*\)/, 'the built vault service, which asks the real Touch ID'],
  ];
  const found: string[] = [];
  for (const file of suiteFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, why] of never) if (pattern.test(text)) found.push(`${path.relative(ROOT, file)}: ${why}`);
    // codesign only ever signs ad hoc: an identity would ask for the keychain's permission.
    for (const m of text.matchAll(new RegExp(`${CALL}codesign['"\\x60]\\s*,\\s*\\[([^\\]]*)\\]`, 'g'))) {
      const args = m[1]!;
      if (/['"\x60]-s['"\x60]/.test(args) && !/['"\x60]-s['"\x60]\s*,\s*['"\x60]-['"\x60]/.test(args)) found.push(`${path.relative(ROOT, file)}: codesign with an identity`);
    }
    // The service built without the stand-in is the real one: only the peer check builds it, and
    // asks it for a probe and nothing else.
    if (/se-helper\/main\.swift/.test(text) && new RegExp(`${CALL}swiftc['"\\x60]`).test(text) && !/PHOSPHOR_TESTSEAM/.test(text)) {
      const calls = text.split('\n').filter((line) => line.includes('phosphor_xpc_call("com.karimbabasf.phosphor.vault"'));
      const probeOnly = calls.length === 1 && /probe/.test(calls[0]!) && !/create|unwrap|commit|sweep|status|presence/.test(calls[0]!);
      if (path.basename(file) !== 'vault-peer-check.test.ts' || !probeOnly) {
        found.push(`${path.relative(ROOT, file)}: the real vault service, asked for more than a probe (${calls.join(' | ').trim()})`);
      }
    }
  }
  assert.deepEqual(found, []);
});
