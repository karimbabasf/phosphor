// The signing configuration, held so a silent removal fails something.
//
// This is the other half of the keystore. Encrypting the keys at rest moves them off disk and
// into the heap of a running process, and on macOS a same-user process can attach to another
// with task_for_pid and read that heap. Encryption at rest with no hardened runtime therefore
// moves the key from a file anyone can read to a heap anyone can read, which is not a control.
//
// Nothing else in this repo can check any of it: the config is JSON with no code path through
// it, the entitlements are consumed by codesign at bundle time, and the bundle is built on a
// machine only the owner has. So these assertions are against the files, and they exist because
// each of these lines is one edit away from being gone with nothing else noticing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PLIST = path.join(ROOT, 'src-tauri/entitlements.plist');
const CONFIG = path.join(ROOT, 'src-tauri/tauri.conf.json');

type MacConfig = {
  entitlements?: string;
  hardenedRuntime?: boolean;
  signingIdentity?: string;
  minimumSystemVersion?: string;
};

function macConfig(): MacConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) as { bundle?: { macOS?: MacConfig } };
  return raw.bundle?.macOS ?? {};
}

function plist(): string {
  return fs.readFileSync(PLIST, 'utf8');
}

// The plist is XML with a long comment in it. Reading a key's value means reading the <dict>,
// not the prose above it, or the note explaining why a key might not be needed would be parsed
// as the key itself.
function entitlement(key: string): boolean | null {
  const body = plist().slice(plist().indexOf('<dict>'));
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(body);
  return match === null ? null : match[1] === 'true';
}

test('the bundle points at the entitlements file and asks for the hardened runtime', () => {
  const mac = macConfig();
  assert.equal(mac.entitlements, 'entitlements.plist');
  assert.equal(mac.hardenedRuntime, true);
  assert.ok(fs.existsSync(PLIST), 'and the file it points at exists');
});

test('the entitlements file is valid plist and parses as one dict', () => {
  const raw = plist();
  assert.match(raw, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(raw, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.match(raw, /<plist version="1\.0">/);
  const body = raw.slice(raw.indexOf('<dict>'));
  assert.equal((body.match(/<dict>/g) ?? []).length, 1);
  assert.equal((body.match(/<key>/g) ?? []).length, (body.match(/<(true|false)\/>/g) ?? []).length);
});

/* THE assertion in this file. get-task-allow is what lets a debugger attach to the process and
   read the unlocked key straight out of the heap. Its ABSENCE is the control, so absence is what
   is checked.

   The check is for a <key> ELEMENT anywhere in the file, commented or not, rather than for the
   name. Naming it in prose is how the file tells a reader what never to add, so the name has to
   be allowed; what must not appear is the thing somebody could uncomment, and a pasted
   entitlement is always a key element. */
test('nothing in this file lets a debugger attach', () => {
  assert.doesNotMatch(
    plist(),
    /<key>[^<]*get-task-allow[^<]*<\/key>/,
    'a get-task-allow key must not appear, not even inside a comment: it is one uncomment from live',
  );
  assert.equal(entitlement('com.apple.security.cs.debugger'), false);
});

test('the process may not make its own memory executable', () => {
  assert.equal(entitlement('com.apple.security.cs.allow-jit'), false);
  assert.equal(entitlement('com.apple.security.cs.allow-unsigned-executable-memory'), false);
});

/* The one entitlement here that WEAKENS the runtime, so it carries its own note.
   It is present because the bundle ships its own node binary in externalBin, which is the usual
   reason given for it. It may well be unnecessary: library validation governs dylibs loaded INTO
   a process, `tauri build` signs the sidecar with the same identity as the app, and the payload's
   dependencies are pure JavaScript with no native addons. That cannot be settled without a real
   signed build. The test asserts the note is there rather than asserting the value, so whichever
   way the first signed build resolves it, the reasoning has to be written down. */
test('the library-validation opt-out carries the note that says how to retire it', () => {
  const raw = plist();
  if (entitlement('com.apple.security.cs.disable-library-validation') !== true) return; // retired, as hoped
  assert.match(raw, /OPEN QUESTION/, 'a weakening entitlement has to say why it is there');
  assert.match(raw, /first signed build/, 'and what would settle it');
});

/* Ad-hoc, so a local build still produces something that runs. The real build reads
   APPLE_SIGNING_IDENTITY from the environment, which Tauri honours over this value, and only the
   owner holds that identity: signing is CONFIGURED here and PERFORMED by him (spec decision 10).

   The failure mode is worth naming where somebody will read it. A release built on a machine
   where that variable is not set does not fail: it produces an ad-hoc bundle that LOOKS signed
   and that Gatekeeper rejects on somebody else's machine. Checking the variable is a step in the
   release, not something this file can do. */
test('the identity is ad-hoc in the config and comes from the environment for a real build', () => {
  assert.equal(macConfig().signingIdentity, '-');
});
