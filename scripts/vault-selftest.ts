// Proves the enclave half of the vault on THIS Mac, with a real Touch ID.
//
// The unit tests stand a software P-256 key in for the enclave and check every byte on the Node
// side. This is the other half: the built sidecar makes a real enclave key, Node wraps a data
// key to it exactly as the keystore does, and the sidecar unwraps it after the person touches
// the sensor. A wrong AAD is tried first and must fail. Two Touch ID prompts, nothing written.
//
//   npm run se:build && node scripts/vault-selftest.ts

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seWrap } from '../src/keystore/sewrap.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const helper = path.join(ROOT, 'src-tauri', 'binaries', `se-helper-${TRIPLE}`);

if (!fs.existsSync(helper)) {
  console.error(`no sidecar at ${helper}; run npm run se:build first`);
  process.exit(2);
}

function call(req: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(execFileSync(helper, { input: JSON.stringify(req) + '\n' }).toString()) as Record<string, unknown>;
}

function openSealed(sealedB64: string, transport: Buffer, id: string): Buffer {
  const combined = Buffer.from(sealedB64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', transport, combined.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(id, 'utf8'));
  d.setAuthTag(combined.subarray(combined.length - 16));
  return Buffer.concat([d.update(combined.subarray(12, combined.length - 16)), d.final()]);
}

const probe = call({ op: 'probe' });
console.log('probe:', JSON.stringify(probe));
if (probe.secureEnclave !== true) {
  console.error('this Mac has no Secure Enclave the sidecar can reach');
  process.exit(1);
}

const created = call({ op: 'create' });
if (created.ok !== true) {
  console.error('create failed:', created);
  process.exit(1);
}
console.log(`enclave key made, binding ${String(created.binding)}`);

const dek = crypto.randomBytes(32);
const aad = Buffer.from('{"version":2,"selftest":true}');
const wrapped = seWrap(dek, String(created.publicKey), aad);
const transport = crypto.randomBytes(32);
const base = { op: 'unwrap', keyBlob: created.keyBlob, ...wrapped, transportKey: transport.toString('base64') };

const wrong = call({ ...base, id: 'selftest-wrong', aad: Buffer.from('{"version":2,"selftest":false}').toString('base64'), reason: 'Phosphor self-test: this one must FAIL' });
console.log('wrong AAD ->', wrong.ok === true ? 'OPENED, WHICH IS A BUG' : String(wrong.error));
if (wrong.ok === true) process.exit(1);

const right = call({ ...base, id: 'selftest-right', aad: aad.toString('base64'), reason: 'Phosphor self-test: unwrap the test key' });
if (right.ok !== true) {
  console.error('unwrap failed:', right);
  process.exit(1);
}
const back = openSealed(String(right.dekSealed), transport, 'selftest-right');
console.log('right AAD ->', back.equals(dek) ? 'the data key round-tripped through the enclave after Touch ID' : 'MISMATCH');
process.exit(back.equals(dek) ? 0 : 1);
