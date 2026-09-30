// The notarized release is a chain whose order is the whole point: sign inside out, notarize and
// staple the app, rebuild the updater bundle from it, put it in the DMG, sign, notarize and staple
// the DMG, and only then checksum. These read the workflow and the script as text and hold that
// order, so a later edit cannot quietly checksum an unstapled file or ship the Open Anyway
// shortcut in a notarized DMG (which would also break the DMG's signature).
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

test('Tauri itself never sees an Apple secret: it builds ad-hoc and the script signs', () => {
  assert.doesNotMatch(step('Build, sign and bundle'), /APPLE_/);
});

test('a signed build skips the Open Anyway step and runs the notarize step, an ad-hoc one the reverse', () => {
  assert.match(step('Put the Open Anyway shortcut in the DMG'), /if: env\.SIGNED != '1'/);
  const notarize = step('Sign, notarize and staple the app and the DMG');
  assert.match(notarize, /if: env\.SIGNED == '1'/);
  assert.match(notarize, /scripts\/notarize-mac\.sh/);
});

test('the DMG is changed, then signed and stapled, before anything is checksummed or attested', () => {
  const order = [
    '- name: Build, sign and bundle',
    '- name: Put the Open Anyway shortcut in the DMG',
    '- name: Sign, notarize and staple the app and the DMG',
    '- name: Stage the release assets and write latest.json and SHA256SUMS',
    '- name: Attest where the release assets came from',
    '- name: The app inside the DMG is signed the way this run was told to sign it',
    '- name: Publish the release',
  ].map((name) => workflow.indexOf(name));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a signed build is verified the way Gatekeeper verifies it, and the keychain always goes', () => {
  const verify = step('The app inside the DMG is signed the way this run was told to sign it');
  assert.match(verify, /spctl -a -vv -t exec/);
  assert.match(verify, /spctl -a -vv -t open --context context:primary-signature/);
  assert.equal(verify.match(/xcrun stapler validate/g)?.length, 2, 'the app and the DMG');
  assert.match(step('Delete the signing keychain'), /if: always\(\)/);
  assert.match(step('Publish the release'), /if \[ "\$SIGNED" != 1 \]; then\n.*not yet notarized/);
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
    at('tauri signer sign "$tarball"'),
    at('ditto "$app" "$mounted/Phosphor.app"'),
    at('codesign --force --timestamp -s "$SIGN_IDENTITY"'),
    at('notarize_file "$dmg" dmg'),
    at('xcrun stapler staple "$dmg"'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(script, /codesign --force --timestamp --options runtime/, 'hardened runtime and secure timestamp on all code');
  assert.match(script, /Contents\/XPCServices/, 'nested XPC services are named where they are signed');
});
