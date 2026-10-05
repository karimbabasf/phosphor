// The chip key's ops in the vault service (src-tauri/se-helper/ChipOps.swift, contract C1), run for
// real against the stand-in keychain, enclave and clock (tests/swift/VaultTestPlatform.swift, built
// with PHOSPHOR_TESTSEAM by tests/unit/helpers/vault-double.ts). The stand-in's chip key is a
// software P-256 key that signs where the enclave would ask for a Touch ID, and keeps the sentence
// that dialog would have shown, so every sentence is held byte for byte with no dialog at all.
//
// What it holds: every refusal before the key answers with no signature asked for; every payload
// the grammar takes is signed once, under exactly its sentence, and verifies in Node; the two
// refusals the rekey rests on (add_public_key and set_auth_by_predecessor_id from the chip) hold
// through the whole path; a nonce expires exactly seven days after its payload; a leading byte
// order mark is read, signed and answered without it; and chip keys and markers never meet the
// vault's own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Decode, base58Encode } from '../../src/chain/near.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { AUTHENTICATOR_DATA, P256_N, clientDataJson, webauthnMultiPayload } from '../../src/vault/webauthn.ts';
import { ACCEPTED, ALLOWANCE, NOW_MS, PINS, RECOVERY, REFUSED, U128_MAX, USDC, VAULT, payload } from '../fixtures/intent-grammar/corpus.ts';
import { CHIP_SOURCES, GROUP, SERVICE, VaultDouble, swiftc } from './helpers/vault-double.ts';
import type { Answer } from './helpers/vault-double.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHIP_OPS = CHIP_SOURCES[0]!;
const skip = swiftc ? false : 'needs macOS with swiftc';

const NOW = NOW_MS / 1000;
const DEADLINE_MS = NOW_MS + 60_000;
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
const TAG = /^chip:com\.karimbabasf\.phosphor\.chip\.(?:[a-z0-9-]{1,40}\.)?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const TOP_UP = ACCEPTED.find((c) => c.name.startsWith('a top-up moves 100 USDC'))!;
const TOP_UP_SAID = 'move 100.00 USDC from your vault to your allowance';

type Chip = { mac: VaultDouble; keyRef: string; publicKey: string; tag: string };

function mac(): VaultDouble {
  const m = new VaultDouble();
  m.now = NOW;
  return m;
}

function created(m: VaultDouble, label?: string): { keyRef: string; publicKey: string; tag: string } {
  const a = m.run({ op: 'chipCreate', ...(label === undefined ? {} : { label }) });
  assert.equal(a.ok, true, JSON.stringify(a));
  return { keyRef: a.keyRef as string, publicKey: a.publicKey as string, tag: (a.keyRef as string).slice('chip:'.length) };
}

/* A Mac with one chip key made and pinned to the corpus's vault, as a move to the chip leaves it. */
function pinned(): Chip {
  const m = mac();
  const chip = created(m);
  const a = m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS });
  assert.equal(a.ok, true, JSON.stringify(a));
  return { mac: m, ...chip };
}

const signs = (m: VaultDouble): string[] => m.state().calls.filter((c) => c.startsWith('sign '));
const sign = (c: Chip, body: string): Answer => c.mac.run({ op: 'signIntent', keyRef: c.keyRef, payload: body });

/* The same request as Node sends it, but the stand-in's file edited first, the way something
   outside the service would leave the keychain. */
function edit(m: VaultDouble, change: (s: ReturnType<VaultDouble['state']>) => void): void {
  const s = m.state();
  change(s);
  fs.writeFileSync(m.store, JSON.stringify(s));
}

function point(publicKey: string): crypto.KeyObject {
  assert.ok(publicKey.startsWith('p256:'));
  const xy = Buffer.from(base58Decode(publicKey.slice(5)));
  assert.equal(xy.length, 64);
  assert.equal(`p256:${base58Encode(xy)}`, publicKey, 'one spelling');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: xy.subarray(0, 32).toString('base64url'), y: xy.subarray(32).toString('base64url') }, format: 'jwk' });
}

/* An accepted answer, checked the way Node checks it (src/vault/webauthn.ts) and once more by hand:
   the payload it echoes is the one asked for, the key is the pinned chip, S is low, and ES256 over
   authenticator data || sha256(client data) verifies under that key. */
function verified(c: Chip, a: Answer, asked: string, sentence: string): void {
  assert.equal(a.ok, true, `${sentence}: ${a.error}: ${a.message}`);
  assert.equal(a.keyRef, c.keyRef);
  assert.equal(a.sentence, sentence);
  const signed = webauthnMultiPayload(a.signed);
  assert.equal(signed.payload, asked, 'the payload comes back byte for byte');
  assert.equal(signed.public_key, c.publicKey, 'signed by the pinned chip key');
  assert.equal(signed.client_data_json, clientDataJson(asked));
  assert.equal(signed.authenticator_data, AUTHENTICATOR_DATA);
  const rs = Buffer.from(base58Decode(signed.signature.slice(5)));
  assert.ok(BigInt(`0x${rs.subarray(32).toString('hex')}`) <= P256_N >> 1n, 'low S');
  const message = Buffer.concat([Buffer.from(AUTHENTICATOR_DATA, 'base64url'), crypto.createHash('sha256').update(signed.client_data_json).digest()]);
  assert.ok(crypto.verify('sha256', message, { key: point(c.publicKey), dsaEncoding: 'ieee-p1363' }, rs));
}

function refused(a: Answer, code: string, says?: string): void {
  assert.equal(a.ok, false, JSON.stringify(a));
  assert.equal(a.error, code, String(a.message));
  if (says !== undefined) assert.ok(String(a.message).startsWith(says), `"${a.message}" does not start with ${says}`);
  assert.equal(a.signed, undefined);
}

// ---------- the four keychain ops ----------

test('chipCreate makes a key in the keychain home under the chip prefix and answers its keyRef and public key', { skip }, () => {
  const m = mac();
  const plain = created(m);
  const labelled = created(m, 'p2-1a2b3c4d');
  assert.match(plain.keyRef, TAG);
  assert.match(labelled.keyRef, TAG);
  assert.ok(labelled.tag.startsWith('com.karimbabasf.phosphor.chip.p2-1a2b3c4d.'));
  point(plain.publicKey);
  assert.notEqual(plain.publicKey, labelled.publicKey);
  const s = m.state();
  assert.deepEqual(s.keys.map((k) => [k.tag, k.group]), [[plain.tag, GROUP], [labelled.tag, GROUP]]);
  assert.deepEqual(s.calls.filter((c) => c.startsWith('makeKey')), [`makeKey ${GROUP}`, `makeKey ${GROUP}`], 'in the group, named on the call');
  assert.equal(s.blobs, 0, 'never a device-bound blob');
  assert.equal(signs(m).length, 0);
  // Unpinned and fresh, as status reads it.
  const status = m.run({ op: 'chipStatus', keyRef: plain.keyRef });
  assert.deepEqual(status, { ok: true, keychainHome: true, chips: [{ keyRef: plain.keyRef, publicKey: plain.publicKey, fresh: true, marker: null }] });
});

test('every chip op on a build with no Team ID answers keychain_unavailable and asks the keychain nothing', { skip }, () => {
  const c = pinned();
  c.mac.team = '';
  const before = c.mac.state().calls.length;
  for (const request of [
    { op: 'chipCreate' },
    { op: 'chipCommit', keyRef: c.keyRef, ...PINS },
    { op: 'chipStatus' },
    { op: 'chipSweep' },
    { op: 'signIntent', keyRef: c.keyRef, payload: TOP_UP.payload },
  ]) {
    refused(c.mac.run(request), 'keychain_unavailable');
  }
  assert.equal(c.mac.state().calls.length, before, 'no keychain call at all');
});

test('chipCreate makes nothing on a Mac with no Secure Enclave, in a home that refuses the key, or for a bad label', { skip }, () => {
  const m = mac();
  m.enclave = false;
  refused(m.run({ op: 'chipCreate' }), 'se_unavailable');
  m.enclave = true;
  m.fail = 'makeKey=-34018';
  refused(m.run({ op: 'chipCreate' }), 'keychain_unavailable');
  m.fail = undefined;
  for (const label of ['', 'A', 'a.b', 'x'.repeat(41), 7]) refused(m.run({ op: 'chipCreate', label }), 'bad_input');
  assert.equal(m.state().keys.length, 0);
});

test('chipCommit pins a fresh key once, writes the contract bytes, and the same pins again answer as the first time did', { skip }, () => {
  const m = mac();
  const chip = created(m);
  const first = m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS });
  assert.deepEqual(first, { ok: true, keyRef: chip.keyRef, at: new Date(NOW_MS).toISOString().replace('.000Z', 'Z') });
  const s = m.state();
  assert.equal(s.markers.length, 0, 'not a vault marker: the Mac is not "bound" by a chip');
  assert.equal(s.chipMarkers?.length, 1);
  assert.equal(s.chipMarkers![0]!.tag, chip.tag);
  assert.equal(s.chipMarkers![0]!.group, GROUP);
  assert.equal(Buffer.from(s.chipMarkers![0]!.body, 'base64').toString('utf8'), JSON.stringify({ account: VAULT, allowance: ALLOWANCE, recovery: RECOVERY, v: 1 }));
  // Again, a minute later: the same answer, the same time, no second marker.
  m.now = NOW + 60;
  assert.deepEqual(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS }), first);
  refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS, allowance: `0x${'d4'.repeat(20)}` }), 'marker_exists');
  refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS, account: `0x${'d4'.repeat(20)}` }), 'marker_exists');
  assert.equal(m.state().chipMarkers?.length, 1);
  const status = m.run({ op: 'chipStatus' });
  assert.deepEqual(status.chips, [{ keyRef: chip.keyRef, publicKey: chip.publicKey, fresh: true, marker: { ...PINS, at: first.at } }]);
});

test('chipCommit refuses what it cannot pin, and writes no marker', { skip }, () => {
  const m = mac();
  const chip = created(m);
  const vault = m.run({ op: 'create' });
  assert.equal(vault.ok, true);
  const vaultTag = String(vault.keyBlob).slice('keychain:'.length);
  for (const keyRef of [undefined, 7, '', chip.tag, `keychain:${chip.tag}`, `chip:${vaultTag}`, `chip:${chip.tag} `, chip.keyRef.toLowerCase(), chip.keyRef.replace('chip.', 'chip.Label.'), chip.keyRef.replace('chip.', 'chip..')]) {
    refused(m.run({ op: 'chipCommit', keyRef, ...PINS }), 'bad_input');
  }
  const ed = `ed25519:${base58Encode(Buffer.alloc(32, 0x44))}`;
  for (const over of [
    { account: undefined },
    { account: VAULT.toUpperCase().replace('0X', '0x') },
    { account: 'vault..near' },
    { allowance: undefined },
    { allowance: VAULT },
    { allowance: 'alice.' },
    { recovery: undefined },
    { recovery: chip.publicKey },
    { recovery: ed },
    { recovery: `secp256k1:${base58Encode(Buffer.alloc(63, 0x5e))}` },
    { recovery: RECOVERY.replace('secp256k1:', 'secp256k1:1') },
    { recovery: 5 },
  ]) {
    refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS, ...over }), 'bad_input');
  }
  refused(m.run({ op: 'chipCommit', keyRef: `chip:com.karimbabasf.phosphor.chip.${crypto.randomUUID().toUpperCase()}`, ...PINS }), 'no_key');
  m.fail = 'chipMarkers=-25308';
  refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS }), 'keychain_unavailable');
  m.fail = 'addChipMarker=-34018';
  refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS }), 'keychain_unavailable');
  m.fail = undefined;
  // Ten minutes after it was made, a key nobody pinned is an orphan for good.
  m.now = NOW + 600;
  refused(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS }), 'stale_key');
  assert.equal((m.state().chipMarkers ?? []).length, 0);
  assert.equal(signs(m).length, 0);
});

test('chipStatus lists every chip key and marker: a gone key with no public key, an unreadable marker with no pins', { skip }, () => {
  const m = mac();
  const a = created(m);
  const b = created(m);
  const gone = created(m);
  const unread = created(m, 'p2-0badc0de');
  for (const chip of [a, gone]) assert.equal(m.run({ op: 'chipCommit', keyRef: chip.keyRef, ...PINS }).ok, true);
  edit(m, (s) => {
    s.keys = s.keys.filter((k) => k.tag !== gone.tag);
    s.chipMarkers = [...(s.chipMarkers ?? []), { tag: unread.tag, group: GROUP, body: Buffer.from('{}').toString('base64'), created: NOW }];
  });
  // A vault key and its marker beside them are not chips.
  const vault = m.run({ op: 'create' });
  edit(m, (s) => s.markers.push({ tag: String(vault.keyBlob).slice(9), group: GROUP, body: Buffer.from('{}').toString('base64'), created: NOW }));
  m.now = NOW + 30;
  const status = m.run({ op: 'chipStatus' });
  const at = new Date(NOW_MS).toISOString().replace('.000Z', 'Z');
  const want = [
    { keyRef: a.keyRef, publicKey: a.publicKey, fresh: true, marker: { ...PINS, at } },
    { keyRef: b.keyRef, publicKey: b.publicKey, fresh: true, marker: null },
    { keyRef: gone.keyRef, publicKey: null, fresh: false, marker: { ...PINS, at } },
    { keyRef: unread.keyRef, publicKey: unread.publicKey, fresh: true, marker: { account: '', allowance: '', recovery: '', at } },
  ].sort((x, y) => (x.keyRef < y.keyRef ? -1 : 1));
  assert.deepEqual(status, { ok: true, keychainHome: true, chips: want });
  assert.deepEqual(m.run({ op: 'chipStatus', keyRef: gone.keyRef }).chips, want.filter((c) => c.keyRef === gone.keyRef));
  assert.deepEqual(m.run({ op: 'chipStatus', keyRef: `chip:com.karimbabasf.phosphor.chip.${crypto.randomUUID().toUpperCase()}` }).chips, []);
  refused(m.run({ op: 'chipStatus', keyRef: `keychain:${a.tag}` }), 'bad_input');
  for (const fail of ['keys=-25308', 'chipMarkers=-25308', 'publicKey=-25308']) {
    m.fail = fail;
    refused(m.run({ op: 'chipStatus' }), 'keychain_unavailable');
  }
  m.fail = undefined;
  // The pinned key whose marker reads is the only one that signs.
  const read = { mac: m, ...unread };
  refused(sign(read, TOP_UP.payload), 'not_committed');
  refused(sign({ mac: m, ...gone }, TOP_UP.payload), 'no_key');
  assert.equal(signs(m).length, 0);
});

test('chipSweep deletes only unpinned chip keys past their first minutes, in its label\'s scope, and never a vault key', { skip }, () => {
  const m = mac();
  const keep = created(m);
  assert.equal(m.run({ op: 'chipCommit', keyRef: keep.keyRef, ...PINS }).ok, true);
  const orphan = created(m);
  const labelled = created(m, 'p2-feedface');
  const vault = m.run({ op: 'create' });
  assert.equal(vault.ok, true);
  // Nothing is old enough yet, and nothing pinned is needed first.
  assert.deepEqual(m.run({ op: 'chipSweep' }), { ok: true, deleted: 0, kept: 3 });
  m.now = NOW + 600;
  const young = created(m);
  refused(m.run({ op: 'chipSweep', label: 'P2' }), 'bad_input');
  assert.deepEqual(m.run({ op: 'chipSweep', label: 'p2-feedface' }), { ok: true, deleted: 1, kept: 0 });
  m.fail = 'deleteKey=-25244';
  assert.deepEqual(m.run({ op: 'chipSweep' }), { ok: true, deleted: 0, kept: 3 });
  m.fail = undefined;
  assert.deepEqual(m.run({ op: 'chipSweep' }), { ok: true, deleted: 1, kept: 2 });
  const tags = m.state().keys.map((k) => k.tag);
  assert.ok(tags.includes(keep.tag) && tags.includes(young.tag), 'the pinned key and the young one stay');
  assert.ok(!tags.includes(orphan.tag) && !tags.includes(labelled.tag));
  assert.ok(tags.includes(String(vault.keyBlob).slice(9)), 'a vault key is never in a chip sweep');
  assert.equal(m.state().chipMarkers?.length, 1, 'no marker is ever deleted');
  assert.equal(signs(m).length, 0);
});

test('the vault side never sees a chip key or a chip marker, and the chip side never sees the vault\'s', { skip }, () => {
  const c = pinned();
  const m = c.mac;
  // A chip marker does not make the Mac "bound": every device-bound wallet here still opens.
  assert.equal(m.run({ op: 'status' }).bound, false);
  refused(m.run({ op: 'sweep' }), 'nothing_bound');
  m.now = NOW + 3600;
  for (const op of ['commit', 'status']) refused(m.run({ op, keyBlob: `keychain:${c.tag}` }), 'bad_input');
  refused(m.run({ op: 'unwrap', id: 'u1', keyBlob: `keychain:${c.tag}`, ephemeralPublicKey: '', ciphertext: '', aad: '', addresses: '', transportKey: Buffer.alloc(32).toString('base64') }), 'bad_input');
  assert.ok(m.state().keys.some((k) => k.tag === c.tag), 'the chip key is still there');
  assert.equal(m.touches().length, 0);
  // And a vault key cannot be pinned, listed, swept or used to sign as a chip.
  const vault = m.run({ op: 'create' });
  const vaultRef = `chip:${String(vault.keyBlob).slice(9)}`;
  refused(m.run({ op: 'chipCommit', keyRef: vaultRef, ...PINS }), 'bad_input');
  refused(m.run({ op: 'signIntent', keyRef: vaultRef, payload: TOP_UP.payload }), 'bad_input');
  assert.deepEqual(m.run({ op: 'chipStatus' }).chips, [{ keyRef: c.keyRef, publicKey: c.publicKey, fresh: false, marker: { ...PINS, at: new Date(NOW_MS).toISOString().replace('.000Z', 'Z') } }]);
  m.now = NOW + 7200;
  assert.deepEqual(m.run({ op: 'chipSweep' }), { ok: true, deleted: 0, kept: 1 });
  assert.ok(m.state().keys.some((k) => k.tag === String(vault.keyBlob).slice(9)));
});

// ---------- signIntent ----------

test('every payload the grammar takes is signed once, its dialog says exactly its sentence, and the signature verifies in Node', { skip }, (t) => {
  const c = pinned();
  let signed = 0;
  for (const k of ACCEPTED) {
    const before = signs(c.mac).length;
    const a = sign(c, k.payload);
    if (JSON.parse(k.payload).signer_id !== VAULT) {
      // The grammar can name any signer; the service signs only for the vault the key is pinned to.
      refused(a, 'wrong_signer');
      assert.equal(signs(c.mac).length, before, `${k.name}: no dialog`);
      continue;
    }
    verified(c, a, k.payload, 'sentence' in k ? k.sentence : '');
    assert.equal(signs(c.mac).length, before + 1, `${k.name}: one signature`);
    assert.equal(c.mac.dialogs().at(-1), a.sentence, `${k.name}: the dialog says the sentence, byte for byte`);
    signed += 1;
  }
  assert.equal(c.mac.dialogs().length, signed);
  assert.ok(signed >= 20);
  t.diagnostic(`${signed} payloads signed and verified, ${ACCEPTED.length - signed} refused as another signer`);
});

test('every refusal before the key answers with no dialog: the corpus, the signer, and the order C1 gives', { skip }, (t) => {
  const c = pinned();
  let count = 0;
  const no = (a: Answer, code: string, says?: string): void => {
    refused(a, code, says);
    count += 1;
  };
  for (const k of REFUSED) {
    // The corpus's signing key is a pattern; the stand-in chip's own is held below. A leading byte
    // order mark does not survive the request's own decoding (its test is below).
    if (!('rule' in k) || k.rule === 'signing_key' || k.payload.startsWith('﻿')) continue;
    // A payload signed for another account meets the signer check before its sentence is written.
    if (k.rule === 'receiver' && !k.payload.includes(`"signer_id":"${VAULT}"`)) {
      no(sign(c, k.payload), 'wrong_signer');
      continue;
    }
    no(sign(c, k.payload), 'grammar', `${k.rule}: `);
  }
  const corpus = count;
  no(sign(c, payload({ intents: [{ intent: 'remove_public_key', public_key: c.publicKey }] })), 'grammar', 'signing_key: ');
  no(sign(c, payload({ intents: [{ intent: 'remove_public_key', public_key: RECOVERY }, { intent: 'remove_public_key', public_key: c.publicKey }] })), 'grammar', 'signing_key: ');
  // Signed for another account, the allowance included.
  for (const signer of [ALLOWANCE, `0x${'c3'.repeat(20)}`, 'vault.near']) no(sign(c, payload({ signer_id: signer })), 'wrong_signer');
  // The order: form, marker, key, grammar, signer, sentence.
  const stranger = `0x${'c3'.repeat(20)}`;
  const long = payload({ signer_id: stranger, intents: [{ intent: 'transfer', receiver_id: `${'a'.repeat(59)}.near`, tokens: { [USDC]: U128_MAX } }] });
  no(sign(c, payload({ signer_id: stranger, intents: [{ intent: 'add_public_key', public_key: c.publicKey }] })), 'grammar', 'refused_kind: ');
  no(sign(c, long), 'wrong_signer');
  no(sign(c, payload({ intents: [{ intent: 'transfer', receiver_id: `${'a'.repeat(59)}.near`, tokens: { [USDC]: U128_MAX } }] })), 'grammar', 'receiver: ');
  no(sign(c, payload({ intents: [{ intent: 'transfer', receiver_id: 'your-allowance.near', tokens: { [USDC]: '100000000' } }] })), 'grammar', 'receiver: ');
  const huge = (asset: string) => ({ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [asset]: U128_MAX } });
  no(sign(c, payload({ intents: [huge(USDC), huge('nep141:usdt.tether-token.near')] })), 'grammar', 'sentence: ');
  for (const request of [
    { op: 'signIntent', keyRef: c.keyRef },
    { op: 'signIntent', keyRef: c.keyRef, payload: JSON.parse(TOP_UP.payload) },
    { op: 'signIntent', keyRef: c.keyRef, payload: 7 },
    { op: 'signIntent', payload: TOP_UP.payload },
    { op: 'signIntent', keyRef: `keychain:${c.tag}`, payload: TOP_UP.payload },
    { op: 'signIntent', keyRef: c.tag, payload: TOP_UP.payload },
  ]) {
    no(c.mac.run(request), 'bad_input');
  }
  const other = created(c.mac);
  no(c.mac.run({ op: 'signIntent', keyRef: other.keyRef, payload: '{' }), 'not_committed');
  edit(c.mac, (s) => (s.keys = s.keys.filter((k) => k.tag !== c.tag)));
  no(sign(c, '{'), 'no_key');
  c.mac.fail = 'chipMarkers=-25308';
  no(sign(c, TOP_UP.payload), 'keychain_unavailable');
  assert.equal(signs(c.mac).length, 0, 'not one signature was asked for');
  assert.deepEqual(c.mac.dialogs(), []);
  t.diagnostic(`${corpus} corpus refusals and ${count - corpus} more, none reached the key`);
});

test('the chip key never signs add_public_key or set_auth_by_predecessor_id, however the payload dresses it, through the whole signIntent path', { skip }, () => {
  const c = pinned();
  const p256 = `p256:${base58Encode(Buffer.alloc(64, 0x33))}`;
  const top = (intents: unknown[]) => payload({ intents });
  const transfer = { intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [USDC]: '1' } };
  const dressed: [string, string, string?][] = [
    ['set_auth_by_predecessor_id off', top([{ intent: 'set_auth_by_predecessor_id', enabled: false }]), 'refused_kind: set_auth_by_predecessor_id'],
    ['set_auth_by_predecessor_id on', top([{ intent: 'set_auth_by_predecessor_id', enabled: true }]), 'refused_kind: set_auth_by_predecessor_id'],
    ['set_auth_by_predecessor_id with nothing else', top([{ intent: 'set_auth_by_predecessor_id' }]), 'refused_kind: set_auth_by_predecessor_id'],
    ['add_public_key of a new p256 key', top([{ intent: 'add_public_key', public_key: p256 }]), 'refused_kind: add_public_key'],
    ['add_public_key of the paper key', top([{ intent: 'add_public_key', public_key: RECOVERY }]), 'refused_kind: add_public_key'],
    ['add_public_key of the signing chip itself', top([{ intent: 'add_public_key', public_key: c.publicKey }]), 'refused_kind: add_public_key'],
    ['the whole rekey P_a', top([
      { intent: 'add_public_key', public_key: p256 },
      { intent: 'add_public_key', public_key: RECOVERY },
      { intent: 'remove_public_key', public_key: `secp256k1:${base58Encode(Buffer.alloc(64, 0x17))}` },
      { intent: 'set_auth_by_predecessor_id', enabled: false },
    ]), 'refused_kind: add_public_key'],
    ['a top-up, then predecessor auth on', top([transfer, { intent: 'set_auth_by_predecessor_id', enabled: true }]), 'refused_kind: set_auth_by_predecessor_id'],
    ['a top-up, then a new key', top([transfer, { intent: 'add_public_key', public_key: p256 }]), 'refused_kind: add_public_key'],
    ['a removal, then predecessor auth on', top([{ intent: 'remove_public_key', public_key: RECOVERY }, { intent: 'set_auth_by_predecessor_id', enabled: true }]), 'refused_kind: set_auth_by_predecessor_id'],
    ['a transfer that is also set_auth_by_predecessor_id', top([transfer]).replace('"intent":"transfer"', '"intent":"transfer","intent":"set_auth_by_predecessor_id"')],
    ['set_auth_by_predecessor_id that is also a transfer', top([transfer]).replace('"intent":"transfer"', '"intent":"set_auth_by_predecessor_id","intent":"transfer"')],
    ['add_public_key spelled with an escape', top([{ intent: 'add_public_key', public_key: p256 }]).replace('add_public_key', 'add\\u005fpublic_key')],
    ['set_auth_by_predecessor_id spelled with an escape', top([{ intent: 'set_auth_by_predecessor_id', enabled: true }]).replace('set_auth', 'set\\u005fauth')],
    ['Add_public_key with a capital', top([{ intent: 'Add_public_key', public_key: p256 }])],
    ['set_auth_by_predecessor_id in a list of five', top([transfer, transfer, transfer, transfer, { intent: 'set_auth_by_predecessor_id', enabled: true }])],
    ['predecessor auth on, signed as the allowance', payload({ signer_id: ALLOWANCE, intents: [{ intent: 'set_auth_by_predecessor_id', enabled: true }] }), 'refused_kind: set_auth_by_predecessor_id'],
  ];
  for (const [name, body, says] of dressed) {
    const a = sign(c, body);
    assert.equal(a.ok, false, `${name}: signed as "${a.sentence}"`);
    assert.equal(a.error, 'grammar', `${name}: ${a.error} ${a.message}`);
    if (says !== undefined) assert.ok(String(a.message).startsWith(says), `${name}: ${a.message}`);
  }
  assert.equal(signs(c.mac).length, 0, 'no dialog for any of them');
  // The same chip signs a plain top-up, so the refusals above are the grammar's and not a dead key.
  verified(c, sign(c, TOP_UP.payload), TOP_UP.payload, TOP_UP_SAID);
});

test('a payload nonce must expire exactly seven days after its deadline, through the service', { skip }, () => {
  const c = pinned();
  const random = new Uint8Array(15).fill(0x6b);
  const at = (expiryMs: number) => payload({ nonce: buildNonce({ salt: SALT, deadlineMs: expiryMs, random }) });
  const said = "confirm this Mac's Touch ID key for your vault";
  verified(c, sign(c, at(DEADLINE_MS + NONCE_LIFE_AFTER_DEADLINE_MS)), at(DEADLINE_MS + NONCE_LIFE_AFTER_DEADLINE_MS), said);
  verified(c, sign(c, at(DEADLINE_MS + 7 * 86_400_000)), at(DEADLINE_MS + 7 * 86_400_000), said);
  const before = signs(c.mac).length;
  for (const expiry of [DEADLINE_MS, DEADLINE_MS + 1, DEADLINE_MS + 86_400_000, DEADLINE_MS + NONCE_LIFE_AFTER_DEADLINE_MS - 1, DEADLINE_MS + NONCE_LIFE_AFTER_DEADLINE_MS + 1, DEADLINE_MS + 2 * NONCE_LIFE_AFTER_DEADLINE_MS]) {
    refused(sign(c, at(expiry)), 'grammar', 'nonce: the nonce must expire exactly seven days after');
  }
  assert.equal(signs(c.mac).length, before, 'no dialog for a nonce of any other life');
});

test('a payload sent with a leading byte order mark is read, signed and answered without it, so Node\'s byte-equal check is what tells', { skip }, () => {
  const c = pinned();
  const asked = `﻿${TOP_UP.payload}`;
  const a = sign(c, asked);
  // One Data for the grammar, the wrapper and the echo: all three are the string without the mark.
  verified(c, a, TOP_UP.payload, TOP_UP_SAID);
  const signed = a.signed as Record<string, string>;
  assert.notEqual(signed.payload, asked, 'the echo is not what Node asked to sign, and Node must compare');
  assert.equal(JSON.parse(signed.client_data_json).challenge, crypto.createHash('sha256').update(TOP_UP.payload).digest('base64url'));
  assert.deepEqual(c.mac.dialogs(), [TOP_UP_SAID]);
  // A second mark, or one inside, survives the decoding and the grammar refuses it, before the key.
  refused(sign(c, `﻿﻿${TOP_UP.payload}`), 'grammar', 'ascii: ');
  refused(sign(c, TOP_UP.payload.replace('"intents"', '"﻿intents"')), 'grammar', 'ascii: ');
  assert.equal(signs(c.mac).length, 1);
});

test('a high S from the chip comes back low, a low one stays low, and both verify', { skip }, () => {
  const c = pinned();
  for (const side of ['high', 'low', 'high', 'low'] as const) {
    c.mac.sign = side;
    verified(c, sign(c, TOP_UP.payload), TOP_UP.payload, TOP_UP_SAID);
  }
  assert.equal(signs(c.mac).length, 4);
});

test('a cancelled touch is a cancel, and a signature that does not verify never leaves the service', { skip }, () => {
  const c = pinned();
  c.mac.touch = 'cancel';
  refused(sign(c, TOP_UP.payload), 'user_cancel');
  c.mac.touch = undefined;
  for (const answer of ['garbage', 'otherkey'] as const) {
    c.mac.sign = answer;
    refused(sign(c, TOP_UP.payload), 'crypto_failed');
  }
  // Each of the three was asked once, under the top-up's sentence: the dialog came, nothing left.
  assert.equal(signs(c.mac).length, 3);
  assert.deepEqual(c.mac.dialogs(), [TOP_UP_SAID, TOP_UP_SAID, TOP_UP_SAID]);
  c.mac.sign = undefined;
  verified(c, sign(c, TOP_UP.payload), TOP_UP.payload, TOP_UP_SAID);
});

// ---------- the build and the protocol ----------

test('every build carries the chip ops beside the grammar, and the stand-in is in none of them', { skip }, () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build-se-helper.sh'), 'utf8');
  const commands = build.replace(/\\\n\s*/g, ' ').split('\n').filter((l) => l.startsWith('swiftc '));
  assert.equal(commands.length, 2, 'the service and the development build');
  for (const command of commands) {
    assert.ok(command.includes(' -D PHOSPHOR_CHIP '), command);
    for (const file of ['main.swift', 'ChipOps.swift', 'IntentGrammar.swift', 'TokenTable.swift']) assert.ok(command.includes(`"$src/${file}"`), `${file}: ${command}`);
    assert.ok(!/PHOSPHOR_TESTSEAM|VaultTestPlatform|tests\/swift/.test(command));
  }
  // Compiled the way the build script compiles them, alone: they build, and neither holds a byte of
  // the stand-in.
  const work = tempDir('phosphor-chip-shipped-');
  for (const [name, defines] of [['service', []], ['dev', ['-D', 'PHOSPHOR_STDIO']]] as [string, string[]][]) {
    const out = path.join(work, name);
    const run = spawnSync('swiftc', ['-Onone', ...defines, '-D', 'PHOSPHOR_CHIP', '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), '-o', out, SERVICE, ...CHIP_SOURCES], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: work },
    });
    assert.equal(run.status, 0, `swiftc ${name}: ${run.stderr}`);
    const bytes = fs.readFileSync(out);
    for (const needle of ['PHOSPHOR_TEST', 'TestPlatform', 'keychain.json']) assert.equal(bytes.indexOf(needle), -1, `${name} carries ${needle}`);
    // Op names are short enough for Swift to keep inside the code; these two sentences are not.
    for (const needle of ['so it holds no chip key', 'the nonce must expire exactly seven days']) assert.notEqual(bytes.indexOf(needle), -1, `${name} lacks "${needle}"`);
  }
});

test('the relay carries exactly the ops the service answers, the chip five compiled in with the grammar', () => {
  const rust = fs.readFileSync(path.join(ROOT, 'src-tauri/src/enclave.rs'), 'utf8');
  const list = rust.match(/const OPS: \[&str; (\d+)\] = \[([^\]]*)\]/);
  assert.ok(list);
  const carried = [...list[2]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
  assert.equal(Number(list[1]), 12);
  const main = fs.readFileSync(SERVICE, 'utf8');
  const answered = [...main.matchAll(/case "([A-Za-z]+)": result = /g)].map((m) => m[1]!);
  assert.deepEqual([...carried].sort(), [...answered].sort());
  const chip = ['chipCreate', 'chipCommit', 'chipStatus', 'chipSweep', 'signIntent'];
  const from = main.indexOf('#if PHOSPHOR_CHIP\n');
  const gated = main.slice(from, main.indexOf('#endif', from));
  assert.ok(from > 0);
  assert.deepEqual([...gated.matchAll(/case "([A-Za-z]+)"/g)].map((m) => m[1]), chip, 'the five are answered only with the grammar compiled in');
  for (const op of [...carried]) assert.ok(main.slice(0, main.indexOf('import Foundation')).includes(`{"op":"${op}"`), `THE PROTOCOL names ${op}`);
});

test('the chip ops reach the keychain and the enclave only through the platform, and answer only their own codes', () => {
  const ops = fs.readFileSync(CHIP_OPS, 'utf8');
  // The one call that asks the owner is the platform's sign, inside SystemPlatform, which
  // tests/unit/no-dialog.test.ts holds; this file holds none of its own.
  assert.doesNotMatch(ops, /LocalAuthentication|LAContext|evaluatePolicy|kSecUseAuthenticationContext|\bSecItem[A-Za-z]*\(|\bSecKey[A-Za-z]*\(/);
  const codes = [...new Set([...ops.matchAll(/Fail\(code: "([a-z_]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(codes, ['bad_input', 'crypto_failed', 'grammar', 'keychain_unavailable', 'marker_exists', 'no_key', 'not_committed', 'se_unavailable', 'stale_key', 'wrong_signer']);
});
