// The notarized release is a chain whose order is the whole point: sign inside out, notarize and
// staple the app, rebuild the updater bundle from it, put it in the DMG, sign, notarize and staple
// the DMG, and only then checksum. These read the workflow and the script as text and hold that
// order, so a later edit cannot quietly checksum an unstapled file or ship an ad-hoc release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const workflow = fs.readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
const script = fs.readFileSync(new URL('scripts/notarize-mac.sh', root), 'utf8');

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `no step named ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test('Tauri itself never sees an Apple secret or the update key: it builds ad-hoc and the scripts sign', () => {
  assert.doesNotMatch(step('Build and bundle'), /APPLE_|TAURI_SIGNING/);
  const conf = JSON.parse(fs.readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
  assert.equal(conf.bundle.createUpdaterArtifacts, false, 'tauri build makes no updater bundle, so it needs no key');
});

test('every release is notarized: no ad-hoc path, no Open Anyway step, both notary routes', () => {
  const keychain = step('The signing keychain and the notarization credentials');
  assert.match(keychain, /every release is Developer ID signed/);
  assert.match(keychain, /APPLE_ID/);
  assert.match(keychain, /APPLE_API_KEY_P8/);
  const notarize = step('Sign, notarize and staple the app and the DMG');
  assert.doesNotMatch(notarize, /\n\s+if:/, 'the notarize step always runs');
  assert.match(notarize, /scripts\/notarize-mac\.sh/);
  assert.doesNotMatch(workflow, /Open Anyway|open-anyway|SIGNED/);
  assert.ok(!fs.existsSync(new URL('scripts/dmg-open-anyway.ts', root)));
});

test('the Secure Enclave service is built ad-hoc and signed by the script with everything else', () => {
  assert.doesNotMatch(step('Stage the payload and prove it boots on the bundled runtime'), /APPLE_|secrets\./);
  assert.ok(workflow.indexOf('- name: Stage the payload and prove it boots') < workflow.indexOf('- name: The signing keychain and the notarization credentials'));
  assert.match(script, /-name '\*\.xpc'/, 'the nested bundle loop signs XPC services');
});

test('the DMG is changed, then signed and stapled, before anything is checksummed, checked or attested', () => {
  const order = [
    '- name: Build and bundle',
    '- name: Sign, notarize and staple the app and the DMG',
    '- name: Delete the signing keychain',
    '- name: Sign the updater bundle',
    '- name: Stage the release assets and write latest.json and SHA256SUMS',
    '- name: The app and the DMG pass Gatekeeper, and the update passes the installed app\'s check',
    '- name: Attest where the release assets came from',
    '- name: Publish the GitHub Release',
  ].map((name) => workflow.indexOf(name));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the release is verified the way Gatekeeper and an installed copy verify it, and the keychain always goes', () => {
  const verify = step('The app and the DMG pass Gatekeeper, and the update passes the installed app\'s check');
  assert.match(verify, /spctl -a -vv -t exec/);
  assert.match(verify, /spctl -a -vv -t open --context context:primary-signature/);
  assert.equal(verify.match(/xcrun stapler validate/g)?.length, 2, 'the app and the DMG');
  assert.match(verify, /node scripts\/updater-sign\.ts "\$tarball" --check --manifest "\$RELEASE_DIR\/latest\.json"/);
  assert.match(verify, /codesign --verify --deep --strict --verbose=2 --test-requirement='=identifier "com\.karimbabasf\.phosphor" and anchor apple generic/);
  assert.match(step('Delete the signing keychain'), /if: always\(\)/);
  assert.doesNotMatch(step('Write the release notes'), /notarized|Open Anyway/);
});

test('a local signed build is held to the checkout before it is signed and after', () => {
  const local = fs.readFileSync(new URL('scripts/sign-and-notarize-local.sh', root), 'utf8');
  const before = local.indexOf('node "$root/scripts/release-check.ts" --app "$bundle/macos/Phosphor.app" --checkout "$root" --stage built');
  const signing = local.indexOf('bash "$root/scripts/notarize-mac.sh" "$bundle" "$version"');
  const after = local.indexOf('node "$root/scripts/release-check.ts" --app "$app" --checkout "$root" --stage signed');
  assert.ok(before >= 0 && before < signing, 'checked before notarize-mac.sh signs it');
  assert.ok(after > signing, 'and among the rows after');
});

test('the script signs inside out, staples the app before the updater bundle and the DMG are made', () => {
  const at = (needle: string) => {
    const i = script.indexOf(needle);
    assert.ok(i >= 0, `script lost: ${needle}`);
    return i;
  };
  const order = [
    at('--preserve-metadata=entitlements "$file"'),
    at('--preserve-metadata=entitlements "$nested"'),
    at('sign --entitlements "$entitlements" "$app"'),
    at('notarize_file "$work/Phosphor.zip" app'),
    at('xcrun stapler staple "$app"'),
    at('tar --no-mac-metadata --no-xattrs -czf "$tarball"'),
    at('ditto "$app" "$mounted/Phosphor.app"'),
    at('codesign --force --timestamp -s "$SIGN_IDENTITY"'),
    at('notarize_file "$dmg" dmg'),
    at('xcrun stapler staple "$dmg"'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(script, /codesign --force --timestamp --options runtime/, 'hardened runtime and secure timestamp on all code');
  assert.match(script, /Contents\/XPCServices/, 'nested XPC services are named where they are signed');
  assert.doesNotMatch(script, /tauri signer|TAURI_SIGNING|\bnpx\b/, 'the update key is never in the script that holds the keychain');
});
