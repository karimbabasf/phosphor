// The WebAuthn wrapper on the Node side, held to the live verifier's own verdicts on real Secure
// Enclave signatures (tests/fixtures/verifier/simulate-0.4.4.json): every answer it accepted passes
// webauthnMultiPayload unchanged, and every way it refused one (a high S, flags without user
// present, a payload changed after signing, client data with no origin) is refused here first.
// A software P-256 key stands in for the chip. Nothing here touches a network.
//
// Run: node --test tests/unit/vault-webauthn.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { base58Decode, base58Encode } from '../../src/chain/near.ts';
import {
  AUTHENTICATOR_DATA,
  P256_N,
  WEBAUTHN_ORIGIN,
  clientDataJson,
  lowS,
  webauthnMessage,
  webauthnMultiPayload,
  webauthnSigned,
} from '../../src/vault/webauthn.ts';

type Signed = { standard: string; payload: string; signature: string; public_key?: string; client_data_json?: string; authenticator_data?: string };
type Recorded = { signed: Signed[]; rpcBody: { result: { result?: number[] } } };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/verifier/simulate-0.4.4.json', import.meta.url), 'utf8')) as Record<'run1' | 'run2', Record<string, Recorded>>;

function webauthnOf(run: 'run1' | 'run2', name: string): Signed[] {
  return FIXTURE[run][name]!.signed.filter((s) => s.standard === 'webauthn');
}

function softwareKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xy = Uint8Array.from(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const sign = (payload: string) => Uint8Array.from(crypto.sign('sha256', webauthnMessage(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  return { xy, publicKey, sign };
}

const PAYLOAD = '{"signer_id":"0xbb36a6ccc6d6a7a8929d9e7c06cd1fd305e20fb9","verifying_contract":"intents.near","deadline":"2026-10-04T18:57:00.839Z","nonce":"Vij2xgAlKBKzwPcFfopo2xhLJEAOvuqnMpieNZa9XHQ=","intents":[]}';

test('the authenticator data and client data are the bytes the live verifier accepted', () => {
  assert.equal(AUTHENTICATOR_DATA, 'MHWRbLRuOkhWcUDwtTnTsw39STVjMPw6wraVMkTcPTEFAAAAAA');
  const raw = Buffer.from(AUTHENTICATOR_DATA, 'base64url');
  assert.equal(raw.length, 37);
  assert.deepEqual(raw.subarray(0, 32), crypto.createHash('sha256').update('phosphor.money').digest());
  assert.deepEqual([...raw.subarray(32)], [0x05, 0, 0, 0, 0], 'user present and verified, sign count 0');
  assert.equal(clientDataJson(PAYLOAD), `{"type":"webauthn.get","challenge":"${crypto.createHash('sha256').update(PAYLOAD).digest('base64url')}","origin":"${WEBAUTHN_ORIGIN}"}`);
  let seen = 0;
  for (const run of ['run1', 'run2'] as const) {
    for (const [name, entry] of Object.entries(FIXTURE[run])) {
      if (entry.rpcBody.result.result === undefined) continue;
      for (const s of webauthnOf(run, name)) {
        assert.equal(s.authenticator_data, AUTHENTICATOR_DATA, `${run} ${name}`);
        assert.equal(s.client_data_json, clientDataJson(s.payload), `${run} ${name}`);
        seen += 1;
      }
    }
  }
  assert.ok(seen >= 15, `checked ${seen} accepted answers`);
});

test('every enclave answer the verifier accepted passes unchanged; every one it refused is refused here', () => {
  let passed = 0;
  for (const run of ['run1', 'run2'] as const) {
    for (const [name, entry] of Object.entries(FIXTURE[run])) {
      if (entry.rpcBody.result.result === undefined) continue;
      for (const s of webauthnOf(run, name)) {
        assert.deepEqual(webauthnMultiPayload(s), s, `${run} ${name}`);
        passed += 1;
      }
    }
    // The verifier refused these with "invalid signature"; here each is refused for its cause.
    assert.throws(() => webauthnMultiPayload(webauthnOf(run, 'T5')[0]), /high S/, `${run} T5`);
    assert.throws(() => webauthnMultiPayload(webauthnOf(run, 'T6')[0]), /authenticator data is not this app's/, `${run} T6, flags 0x00`);
    assert.throws(() => webauthnMultiPayload(webauthnOf(run, 'T6b')[0]), /authenticator data is not this app's/, `${run} T6b, flags 0x04`);
    assert.throws(() => webauthnMultiPayload(webauthnOf(run, 'T7')[0]), /client data is not the template/, `${run} T7, payload changed after signing`);
    assert.throws(() => webauthnMultiPayload(webauthnOf(run, 'T8')[0]), /client data is not the template/, `${run} T8, no origin`);
    // T2 is a sound answer from a key the account never added: the chain's refusal, not ours.
    assert.doesNotThrow(() => webauthnMultiPayload(webauthnOf(run, 'T2')[0]));
  }
  assert.ok(passed >= 15);
});

test("lowS turns the enclave's own high-S answer into the one the verifier accepted", () => {
  for (const run of ['run1', 'run2'] as const) {
    const high = webauthnOf(run, 'T5')[0]!;
    const accepted = webauthnOf(run, 'T1')[0]!;
    assert.equal(high.payload, accepted.payload, `${run}: T5 sends T1's P2 as the enclave signed it`);
    const folded = lowS(base58Decode(high.signature.slice('p256:'.length)));
    assert.equal(`p256:${base58Encode(folded)}`, accepted.signature, run);
  }
});

test('lowS on 1000 software signatures: S at most n / 2, r untouched, still verifies, idempotent', () => {
  const key = softwareKey();
  let high = 0;
  for (let i = 0; i < 1000; i += 1) {
    const payload = `${PAYLOAD.slice(0, -2)}${i}]}`;
    const rs = key.sign(payload);
    const folded = lowS(rs);
    const s = BigInt(`0x${Buffer.from(folded.subarray(32)).toString('hex')}`);
    const before = BigInt(`0x${Buffer.from(rs.subarray(32)).toString('hex')}`);
    if (before > P256_N / 2n) {
      high += 1;
      assert.equal(s, P256_N - before);
    } else assert.deepEqual(folded, rs);
    assert.ok(s <= P256_N / 2n);
    assert.deepEqual(folded.subarray(0, 32), rs.subarray(0, 32));
    assert.ok(crypto.verify('sha256', webauthnMessage(payload), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, folded));
    assert.deepEqual(lowS(folded), folded);
  }
  assert.ok(high > 350 && high < 650, `${high} of 1000 came out high`);
  assert.throws(() => lowS(new Uint8Array(63)), /64 bytes/);
  assert.throws(() => lowS(new Uint8Array(64)), /between 1 and n - 1/);
});

test('a software-signed answer passes, and every tampered one is refused by name', () => {
  const key = softwareKey();
  const good = webauthnSigned(PAYLOAD, key.xy, key.sign(PAYLOAD));
  assert.deepEqual(webauthnMultiPayload(good), good);
  assert.deepEqual(Object.keys(good), ['standard', 'payload', 'public_key', 'signature', 'client_data_json', 'authenticator_data']);

  const other = softwareKey();
  const otherPayload = PAYLOAD.replace('"intents":[]', '"intents":[{"intent":"set_auth_by_predecessor_id","enabled":true}]');
  const bigS = Buffer.concat([Buffer.alloc(31), Buffer.from([1]), Buffer.from(P256_N.toString(16), 'hex')]);
  const cases: Array<[string, unknown, RegExp]> = [
    ['another payload under the same signature', { ...good, payload: otherPayload, client_data_json: clientDataJson(otherPayload) }, /does not verify/],
    ['the payload swapped, client data left', { ...good, payload: otherPayload }, /client data is not the template/],
    ['another key', { ...good, public_key: `p256:${base58Encode(other.xy)}` }, /does not verify/],
    ['a key that is not on the curve', { ...good, public_key: `p256:${base58Encode(new Uint8Array(64).fill(1))}` }, /not a point on P-256/],
    ['a key of 63 bytes', { ...good, public_key: `p256:${base58Encode(new Uint8Array(63).fill(9))}` }, /public key is not 64 bytes/],
    ['an ed25519 key', { ...good, public_key: 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z' }, /public key is not a p256 value/],
    ['S equal to n', { ...good, signature: `p256:${base58Encode(bigS)}` }, /out of range/],
    ['erc191', { ...good, standard: 'erc191' }, /not webauthn/],
    ['a field missing', { ...good, authenticator_data: undefined }, /not exactly standard/],
    ['a field added', { ...good, user_handle: 'x' }, /not exactly standard/],
    ['a number for a string', { ...good, signature: 7 }, /every field of the signed answer is a string/],
    ['not an object', [good], /not an object/],
  ];
  for (const [why, answer, message] of cases) {
    const clean = answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? Object.fromEntries(Object.entries(answer).filter(([, v]) => v !== undefined)) : answer;
    assert.throws(() => webauthnMultiPayload(clean), message, why);
  }
});
