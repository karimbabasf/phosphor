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

/* allow-jit was <false/> here and this test asserted it, and between them they meant every signed
   build shipped a working window over a dead backend. V8 cannot start without it: the node child
   died instantly with "Failed to reserve virtual memory for CodeRange", and because the shell's
   window opens either way, the app looked installed. Settled by building it, 2026-09-09.

   It is not a hole in what this file protects. allow-jit lets THIS process map its OWN memory
   executable through MAP_JIT and grants nothing to any other process; the control that stops
   another process reading an unlocked key out of this heap is the absence of get-task-allow,
   asserted above and untouched. The blanket version stays denied, because V8 uses MAP_JIT
   properly and does not need it. */
test('the runtime allows this process to jit, and nothing broader', () => {
  assert.equal(entitlement('com.apple.security.cs.allow-jit'), true, 'node cannot start without it');
  assert.equal(entitlement('com.apple.security.cs.allow-unsigned-executable-memory'), false);
});

/* This was the one entitlement here that weakened the runtime, and it was carried as an open
   question with a note saying what would settle it. The first signed build settled it on
   2026-09-09: the key is gone, library validation is enforced, and the backend still comes up.
   `tauri build` signs the sidecar with the app's own identity, so a same-team sidecar satisfies
   validation without an opt-out, and the payload's dependencies are pure JavaScript.

   The test now guards the retirement rather than the note. Re-adding it should take evidence,
   and the evidence is a health check, because "the app launches" is the wrong check and the
   tempting one: library validation bites the CHILD, and a shell whose backend never spawned
   still shows a window. */
test('the library-validation opt-out is retired and stays retired', () => {
  assert.equal(
    entitlement('com.apple.security.cs.disable-library-validation'),
    null,
    'settled at the first signed build: the sidecar is same-team signed and needs no opt-out',
  );
  assert.match(plist(), /api\/health/, 'the file still names the check that would reopen it');
});

/* codesign does not use plutil's parser. It uses AMFI's, which enforces the XML rule that a
   comment may not contain a double hyphen, and it fails the ENTIRE bundle when it finds one:
   "Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 31". A command-line
   flag written out longhand in the comment cost exactly that, and `plutil -lint` called the file
   OK the whole time, so the local check disagreed with the build. */
test('the comment carries no double hyphen, which codesign refuses to parse', () => {
  const raw = plist();
  const comment = raw.slice(raw.indexOf('<!--') + 4, raw.indexOf('-->'));
  assert.doesNotMatch(comment, /--/, 'a double hyphen inside the comment fails codesign, not plutil');
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
