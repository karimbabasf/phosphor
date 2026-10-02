// The release gate's check of an app bundle against its checkout (scripts/release-check.ts): the
// sign job runs it on the unsigned build before anything is signed and on the signed apps it
// ships. The audit found the sign job signing whatever the build job handed it, keeping nested
// entitlements from the unsigned build, and never comparing the payload with the checkout.
//
// The bundle tests build a small real one: a shell compiled with the payload's digest in it, the
// node sidecar and the Secure Enclave service beside it, ad-hoc signed by codesign the way Tauri's
// pass signs them, so the check reads real signatures and real entitlements.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAYLOAD, payloadDigest } from '../../scripts/payload-digest.ts';
import { checkApp, entitlementProblem, expectedEntitlements, payloadProblems, shellCarries } from '../../scripts/release-check.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const COMMITTED = path.join(ROOT, 'src-tauri', 'entitlements.plist');
const APP_ENTITLEMENTS = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.allow-unsigned-executable-memory': false, 'com.apple.security.cs.debugger': false };

// A checkout holding every payload entry, small.
function fakeCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-checkout-'));
  for (const entry of PAYLOAD) {
    const full = path.join(dir, ...entry.split('/'));
    if (path.extname(entry) === '') {
      fs.mkdirSync(path.join(full, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(full, 'a.ts'), `export const entry = '${entry}';\n`);
      fs.writeFileSync(path.join(full, 'inner', 'b.js'), `// ${entry}\n`);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.endsWith('.json') ? '{}\n' : `# ${entry}\n`);
    }
  }
  fs.mkdirSync(path.join(dir, 'src-tauri'));
  fs.copyFileSync(COMMITTED, path.join(dir, 'src-tauri', 'entitlements.plist'));
  return dir;
}

function stage(checkout: string, payloadRoot: string): void {
  for (const entry of PAYLOAD) {
    fs.mkdirSync(path.dirname(path.join(payloadRoot, entry)), { recursive: true });
    fs.cpSync(path.join(checkout, entry), path.join(payloadRoot, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(payloadRoot, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
}

test('first-party payload files must be the checkout, byte for byte, with nothing added or missing', () => {
  const checkout = fakeCheckout();
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-payload-'));
  try {
    stage(checkout, payload);
    assert.deepEqual(payloadProblems(checkout, payload), []);
    // node_modules is the build job's install from the lockfile, which this cannot rebuild.
    fs.writeFileSync(path.join(payload, 'node_modules', 'dep', 'extra.js'), '1\n');
    fs.writeFileSync(path.join(payload, 'src', '.DS_Store'), 'finder');
    assert.deepEqual(payloadProblems(checkout, payload), []);

    fs.appendFileSync(path.join(payload, 'src', 'inner', 'b.js'), 'globalThis.x = 1;\n');
    fs.writeFileSync(path.join(payload, 'ui', 'added.js'), 'fetch("https://example.invalid")\n');
    fs.rmSync(path.join(payload, 'skills', 'a.ts'));
    fs.writeFileSync(path.join(payload, 'evil.mjs'), '');
    fs.rmSync(path.join(payload, 'docs', 'changelog.md'));
    fs.writeFileSync(path.join(payload, 'docs', 'notes.md'), 'not shipped\n');
    const problems = payloadProblems(checkout, payload).join('\n');
    for (const named of ['src/inner/b.js differs', 'ui/added.js is in the payload', 'skills/a.ts is in the checkout and missing', 'evil.mjs is in the payload and not in the checkout', 'docs/changelog.md is in the checkout and missing', 'docs/notes.md is in the payload']) {
      assert.ok(problems.includes(named), `not named: ${named}\n${problems}`);
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(payload, { recursive: true, force: true });
  }
});

/* A folder named .DS_Store is not Finder's file: the digest walks it and counts what is in it, and the
   shell loads it, so the check reads it too (re-audit R-L10). Only a regular file by that name is left out. */
test('a folder named .DS_Store is read like any other, so a file planted in one is named', () => {
  const checkout = fakeCheckout();
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-payload-'));
  try {
    stage(checkout, payload);
    fs.writeFileSync(path.join(payload, 'src', '.DS_Store'), 'finder');
    fs.writeFileSync(path.join(payload, '.DS_Store'), 'finder');
    assert.deepEqual(payloadProblems(checkout, payload), [], 'Finder\'s own files are left out');
    const counted = payloadDigest(payload).files;
    fs.rmSync(path.join(payload, 'src', '.DS_Store'));
    fs.mkdirSync(path.join(payload, 'src', '.DS_Store'));
    fs.writeFileSync(path.join(payload, 'src', '.DS_Store', 'planted.ts'), 'console.log("not in the checkout")\n');
    fs.rmSync(path.join(payload, '.DS_Store'));
    fs.mkdirSync(path.join(payload, '.DS_Store'));
    fs.writeFileSync(path.join(payload, '.DS_Store', 'top.mjs'), '1\n');
    const problems = payloadProblems(checkout, payload).join('\n');
    assert.ok(problems.includes('src/.DS_Store/planted.ts is in the payload and not in the checkout'), problems);
    assert.ok(problems.includes('.DS_Store/top.mjs is in the payload and not in the checkout'), problems);
    assert.equal(payloadDigest(payload).files, counted + 2, 'the digest counts both, which is why the check must read them');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(payload, { recursive: true, force: true });
  }
});

test('the app executables carry the committed entitlements, and everything else carries none', () => {
  assert.deepEqual(expectedEntitlements('Contents/MacOS/phosphor-desktop', APP_ENTITLEMENTS), APP_ENTITLEMENTS);
  assert.deepEqual(expectedEntitlements('Contents/MacOS/node', APP_ENTITLEMENTS), APP_ENTITLEMENTS);
  assert.deepEqual(expectedEntitlements('Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc/Contents/MacOS/se-helper', APP_ENTITLEMENTS), {});
  assert.deepEqual(expectedEntitlements('Contents/Resources/lib.dylib', APP_ENTITLEMENTS), {});

  const reordered = Object.fromEntries(Object.entries(APP_ENTITLEMENTS).reverse());
  assert.equal(entitlementProblem('Contents/MacOS/node', reordered, APP_ENTITLEMENTS), null, 'key order is not a difference');
  const planted = entitlementProblem('Contents/XPCServices/x.xpc/Contents/MacOS/se-helper', { 'com.apple.security.get-task-allow': true }, {});
  assert.match(String(planted), /se-helper carries entitlements other than the ones it should \(com\.apple\.security\.get-task-allow\)/);
  assert.match(String(entitlementProblem('Contents/MacOS/node', { ...APP_ENTITLEMENTS, 'com.apple.security.cs.disable-library-validation': true }, APP_ENTITLEMENTS)), /disable-library-validation/);
  assert.match(String(entitlementProblem('Contents/MacOS/node', { ...APP_ENTITLEMENTS, 'com.apple.security.cs.debugger': true }, APP_ENTITLEMENTS)), /cs\.debugger/);
  assert.match(String(entitlementProblem('Contents/MacOS/node', {}, APP_ENTITLEMENTS)), /allow-jit/);
});

test('the shell is read for the digest it was built for, as bytes', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(shellCarries(Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(`\0${digest}\0`)]), digest), true);
  assert.equal(shellCarries(Buffer.from(`\0${'cd'.repeat(32)}\0`), digest), false);
});

const tooling = process.platform === 'darwin' && spawnSync('cc', ['--version']).status === 0 && spawnSync('codesign', ['-h']).status !== null;

// A shell compiled with this digest as a string constant, as src-tauri/build.rs compiles one in.
function compile(out: string, digest: string): void {
  const source = path.join(path.dirname(out), 'shell.c');
  fs.writeFileSync(source, `const char *phosphor_payload_digest = "${digest}";\nint main(void) { return phosphor_payload_digest[0] == 0; }\n`);
  execFileSync('cc', ['-O0', '-o', out, source]);
  fs.rmSync(source);
}

function sign(file: string, entitlements?: string): void {
  execFileSync('codesign', ['-s', '-', '-f', '--options', 'runtime', ...(entitlements === undefined ? [] : ['--entitlements', entitlements]), file], { stdio: 'pipe' });
}

function fakeApp(checkout: string, opts: { digest?: string } = {}): string {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-app-')), 'Phosphor.app');
  const payload = path.join(app, 'Contents', 'Resources', 'phosphor');
  fs.mkdirSync(payload, { recursive: true });
  stage(checkout, payload);
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>phosphor-desktop</string></dict></plist>\n',
  );
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos);
  compile(path.join(macos, 'phosphor-desktop'), opts.digest ?? payloadDigest(payload).digest);
  fs.copyFileSync(path.join(macos, 'phosphor-desktop'), path.join(macos, 'node'));
  sign(path.join(macos, 'phosphor-desktop'), COMMITTED);
  sign(path.join(macos, 'node'), COMMITTED);
  const service = path.join(app, 'Contents', 'XPCServices', 'com.karimbabasf.phosphor.vault.xpc', 'Contents', 'MacOS');
  fs.mkdirSync(service, { recursive: true });
  fs.copyFileSync(path.join(macos, 'phosphor-desktop'), path.join(service, 'se-helper'));
  sign(path.join(service, 'se-helper'));
  return app;
}

test('a build that is the checkout, with the committed entitlements, passes before signing', { skip: !tooling && 'needs macOS, cc and codesign' }, () => {
  const checkout = fakeCheckout();
  const app = fakeApp(checkout);
  try {
    assert.deepEqual(checkApp(app, checkout, 'built'), []);
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-check.ts'), '--app', app, '--checkout', checkout, '--stage', 'built'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /is the checkout, carries the committed entitlements/);
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('a build that planted an entitlement, changed a first-party file or ships another payload fails before it is signed', { skip: !tooling && 'needs macOS, cc and codesign' }, () => {
  const checkout = fakeCheckout();
  const planted = fakeApp(checkout);
  const edited = fakeApp(checkout);
  const mismatched = fakeApp(checkout, { digest: 'ef'.repeat(32) });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-ent-'));
  try {
    // A debugger entitlement on the Secure Enclave service: notarize-mac.sh would keep it.
    const debuggable = path.join(scratch, 'debuggable.plist');
    fs.writeFileSync(debuggable, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>\n');
    sign(path.join(planted, 'Contents', 'XPCServices', 'com.karimbabasf.phosphor.vault.xpc', 'Contents', 'MacOS', 'se-helper'), debuggable);
    assert.match(checkApp(planted, checkout, 'built').join('\n'), /se-helper carries entitlements other than the ones it should \(com\.apple\.security\.get-task-allow\)/);

    // A first-party file changed after the checkout: the digest the shell carries cannot catch
    // it when the build job compiled the shell for the changed payload too.
    const file = path.join(edited, 'Contents', 'Resources', 'phosphor', 'src', 'a.ts');
    fs.appendFileSync(file, 'export const exfiltrate = true;\n');
    const problems = checkApp(edited, checkout, 'built').join('\n');
    assert.match(problems, /src\/a\.ts differs from the checkout/);

    assert.match(checkApp(mismatched, checkout, 'built').join('\n'), /the shell was not built for the payload beside it/);

    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-check.ts'), '--app', planted, '--checkout', checkout, '--stage', 'built'], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /FAILS/);
  } finally {
    for (const app of [planted, edited, mismatched]) fs.rmSync(path.dirname(app), { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('after signing, an ad-hoc signature is not a release: every binary needs the hardened runtime and the team', { skip: !tooling && 'needs macOS, cc and codesign' }, () => {
  const checkout = fakeCheckout();
  const app = fakeApp(checkout);
  try {
    const problems = checkApp(app, checkout, 'signed').join('\n');
    assert.match(problems, /the shell is not signed by a team/);
    // The runtime flag is on (sign() asks for it), so the only refusal is the missing team.
    assert.doesNotMatch(problems, /hardened runtime/);
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
