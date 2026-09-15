// The sidecar's contract, held by reading the source, the way tests/unit/window-token.test.ts
// holds the shell's. None of this runs the enclave; scripts/vault-selftest.ts does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SE_WRAP_INFO, SE_WRAP_SALT } from '../../src/keystore/sewrap.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const swift = fs.readFileSync(path.join(ROOT, 'src-tauri/se-helper/main.swift'), 'utf8');
const plist = fs.readFileSync(path.join(ROOT, 'src-tauri/se-helper/Info.plist'), 'utf8');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')) as { bundle: { externalBin: string[] } };
const build = fs.readFileSync(path.join(ROOT, 'scripts/build-se-helper.sh'), 'utf8');
const rust = fs.readFileSync(path.join(ROOT, 'src-tauri/src/enclave.rs'), 'utf8');

test('the sidecar ships beside node and names itself Phosphor in the dialog', () => {
  assert.deepEqual(conf.bundle.externalBin, ['binaries/node', 'binaries/se-helper']);
  assert.ok(build.includes('__info_plist'), 'the Info.plist is embedded at link time');
  assert.ok(plist.includes('<string>Phosphor</string>'), 'CFBundleName is Phosphor');
  assert.ok(plist.includes('com.karimbabasf.phosphor.vault'));
});

test('the enclave key demands the owner every time, and the two wrap halves share their constants', () => {
  assert.ok(swift.includes('[.privateKeyUsage, .userPresence]'), 'userPresence: Touch ID, or the login password, never silent');
  assert.ok(swift.includes('kSecAttrAccessibleWhenUnlockedThisDeviceOnly'));
  assert.ok(swift.includes(`Data("${SE_WRAP_INFO}".utf8)`), 'the HKDF info string matches sewrap.ts');
  assert.ok(swift.includes(`Data("${SE_WRAP_SALT}".utf8)`), 'the HKDF salt matches sewrap.ts');
  assert.ok(swift.includes('HKDF<SHA256>.deriveKey'));
  assert.ok(swift.includes('AES.GCM.open(box, using: wrapKey, authenticating: aad)'));
});

test('the data key leaves the sidecar only sealed under the transport key with the request id as AAD', () => {
  assert.ok(swift.includes('AES.GCM.seal(dek, using: SymmetricKey(data: transport), authenticating: Data(id.utf8))'));
  assert.ok(!/"dek":\s*dek\.base64EncodedString/.test(swift), 'no plaintext data key in any answer');
  assert.ok(swift.includes('transport.count == 32'));
  // The shell adds the transport key and nothing else, and reads nothing out of the request.
  assert.ok(rust.includes('map.insert("transportKey".to_string()'));
  assert.ok(!rust.includes('dekSealed'), 'the shell never looks inside an answer');
  assert.ok(!rust.includes('"token"'), 'the relay never sends the window token anywhere');
  assert.ok(rust.includes('"relay": relay.relay'), 'it sends the relay secret, which the page never holds');
  assert.ok(rust.includes('identity_matches(response, Some(nonce))'), 'every hop is checked against this boot\'s nonce');
});

test('the sidecar never logs, never reads a file, and never opens a socket', () => {
  for (const banned of ['print(', 'NSLog', 'os_log', 'FileManager', 'URLSession', 'contentsOf', 'Process()']) {
    assert.ok(!swift.includes(banned), `${banned} has no place in the sidecar`);
  }
  assert.ok(swift.includes('readLine(strippingNewline: true)'), 'one line in');
  assert.ok(swift.includes('FileHandle.standardOutput.write'), 'one line out');
});
