// The enclave helper's contract, held by reading the source, the way tests/unit/window-token.test.ts
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
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  bundle: { externalBin: string[]; macOS: { files?: Record<string, string> } };
};
const servicePlist = fs.readFileSync(path.join(ROOT, 'src-tauri/se-helper/XPCService-Info.plist'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'src-tauri/src/xpc_bridge.c'), 'utf8');
const build = fs.readFileSync(path.join(ROOT, 'scripts/build-se-helper.sh'), 'utf8');
const rust = fs.readFileSync(path.join(ROOT, 'src-tauri/src/enclave.rs'), 'utf8');

test('the helper ships as an XPC service inside the bundle, never as a launchable sidecar', () => {
  assert.deepEqual(conf.bundle.externalBin, ['binaries/node'], 'no se-helper in Contents/MacOS');
  assert.deepEqual(conf.bundle.macOS.files, {
    'XPCServices/com.karimbabasf.phosphor.vault.xpc': 'binaries/xpc/com.karimbabasf.phosphor.vault.xpc',
  });
  assert.ok(servicePlist.includes('<string>XPC!</string>'), 'packaged as an XPC service');
  assert.ok(servicePlist.includes('<string>com.karimbabasf.phosphor.vault</string>'), 'the service name is the bundle id');
  assert.ok(servicePlist.includes('<key>ServiceType</key>') && servicePlist.includes('<string>Application</string>'));
  assert.ok(servicePlist.includes('<string>Phosphor</string>'), 'the dialog still says Phosphor');
  assert.ok(!servicePlist.includes('MachServices'), 'no global Mach name anyone could look up');
  // The development build keeps the stdin door and its embedded Info.plist; it lands beside the
  // service, outside it, and nothing copies it into a bundle.
  assert.ok(build.includes('__info_plist'), 'the dev Info.plist is embedded at link time');
  assert.ok(plist.includes('<string>Phosphor</string>'), 'CFBundleName is Phosphor');
  assert.ok(plist.includes('com.karimbabasf.phosphor.vault'));
});

test('the service answers only a peer that passes its code signing requirement', () => {
  assert.ok(swift.includes('xpc_connection_set_peer_code_signing_requirement(peer, requirement) == 0'));
  assert.ok(/guard let requirement = peerRequirement\(\),[\s\S]{0,120}else \{\s*xpc_connection_cancel\(peer\)/.test(swift),
    'a requirement that cannot be set, or a signature that cannot be read, cancels the peer');
  // Under Developer ID the peer is pinned to Apple, a Developer ID certificate chain, the team and
  // the app: the team OU alone is carried by any cert issued to the team (audit 2026-10-01, L13).
  for (const part of [
    'anchor apple generic and identifier \\"\\(hostIdentifier)\\" ',
    'and certificate 1[field.1.2.840.113635.100.6.2.6] ',
    'and certificate leaf[field.1.2.840.113635.100.6.1.13] ',
    'and certificate leaf[subject.OU] = \\"\\(team)\\"',
  ]) {
    assert.ok(swift.includes(part), `the peer requirement pins ${part.trim()}`);
  }
  assert.ok(swift.includes('let hostIdentifier = "com.karimbabasf.phosphor"'));
  assert.ok(/xpc_get_type\(event\) == XPC_TYPE_DICTIONARY else \{[\s\S]{0,200}xpc_connection_cancel\(peer\)/.test(swift),
    'an error event, which is what a failed requirement produces, ends the connection');
  // The stdin door exists only in the development build.
  const ifDev = swift.indexOf('#if PHOSPHOR_STDIO\nFileHandle');
  const orElse = swift.indexOf('#else', ifDev);
  const readAt = swift.indexOf('readLine(strippingNewline: true)');
  assert.ok(ifDev > 0 && readAt > ifDev && readAt < orElse, 'readLine sits inside #if PHOSPHOR_STDIO');
  assert.equal(swift.split('readLine(').length, 2, 'one read, and only there');
  const serviceBuild = build.split('\n').find((l) => l.includes('"$service/Contents/MacOS/se-helper" "$src/main.swift"')) ?? '';
  assert.ok(serviceBuild.startsWith('swiftc') && !serviceBuild.includes('PHOSPHOR_STDIO'), 'the shipped service has no stdin door');
  assert.ok(/swiftc -O -D PHOSPHOR_STDIO[^\n]*"\$dev"/.test(build), 'only the dev build gets it');
});

test('both peer checks are the Developer ID branch of the requirement in Apple TN3127, team kept', () => {
  // TN3127, "Xcode designated requirement for Developer ID code": anchor apple generic and
  // identifier X and (certificate leaf[field.1.2.840.113635.100.6.1.9], the Mac App Store, or
  // certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]
  // and certificate leaf[subject.OU] = TEAM). Phosphor ships through Developer ID alone, so that
  // branch is the whole requirement on both sides.
  const branch = (id: string, team: string): string =>
    `anchor apple generic and identifier "${id}" and certificate 1[field.1.2.840.113635.100.6.2.6] ` +
    `and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;
  const literals = (code: string): string => [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('').replaceAll('\\"', '"');
  const inSwift = swift.slice(swift.indexOf('return "anchor apple generic'), swift.indexOf('\n  }\n  return "identifier'));
  assert.equal(literals(inSwift).replace('\\(hostIdentifier)', 'com.karimbabasf.phosphor').replace('\\(team)', 'T1'), branch('com.karimbabasf.phosphor', 'T1'));
  const inC = bridge.slice(bridge.indexOf('snprintf(requirement, sizeof requirement,'), bridge.indexOf('service, team);'));
  assert.equal(literals(inC).replace('%s', 'com.karimbabasf.phosphor.vault').replace('%s', 'T1'), branch('com.karimbabasf.phosphor.vault', 'T1'));
});

test('the shell reaches the service only over XPC in a release build, and checks it back', () => {
  assert.ok(rust.includes('pub const SERVICE: &str = "com.karimbabasf.phosphor.vault";'));
  assert.ok(rust.includes('xpc::call(SERVICE, &request.to_string(), HELPER_TIMEOUT)'));
  // Every spawn lives in the debug-only module.
  const devAt = rust.indexOf('#[cfg(debug_assertions)]\nmod dev {');
  assert.ok(devAt > 0, 'the spawn path is its own debug-only module');
  const spawns = [...rust.matchAll(/Command::new/g)].map((m) => m.index ?? 0);
  assert.ok(spawns.length === 1 && spawns[0] > devAt, 'no process is started outside mod dev');
  assert.ok(/#\[cfg\(debug_assertions\)\]\s*if !in_bundle\(\) \{\s*return dev::call\(request\);/.test(rust));
  assert.ok(bridge.includes('xpc_connection_set_peer_code_signing_requirement(conn, requirement)'), 'the shell pins the service too');
  for (const part of ['certificate 1[field.1.2.840.113635.100.6.2.6]', 'certificate leaf[field.1.2.840.113635.100.6.1.13]', 'certificate leaf[subject.OU]']) {
    assert.ok(bridge.includes(part), `the shell's side of the requirement pins ${part}`);
  }
  assert.ok(!bridge.includes('xpc_connection_create_mach_service'), 'the bundle namespace, never a global name');
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
  assert.ok(rust.includes('identity_matches(response, Some(challenge))'), 'every hop is checked against this boot\'s nonce');
  assert.ok(rust.includes('let challenge = Challenge::new(&relay.nonce).ok()?;'), 'with a challenge of its own, so no answer can be replayed');
});

test('the sidecar never logs, never reads a file, and never opens a socket', () => {
  for (const banned of ['print(', 'NSLog', 'os_log', 'FileManager', 'URLSession', 'contentsOf', 'Process()']) {
    assert.ok(!swift.includes(banned), `${banned} has no place in the sidecar`);
  }
  assert.ok(swift.includes('readLine(strippingNewline: true)'), 'one line in');
  assert.ok(swift.includes('FileHandle.standardOutput.write'), 'one line out');
});
