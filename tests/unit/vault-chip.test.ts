// The chip signer and this process's side of the chip ops (src/vault/chip.ts, src/vault/relay.ts;
// PHASE2-PLAN C1 and C7). The relay reads every chip answer strictly and a demo relay keeps the
// three keychain writes to itself; chipSign refuses before any Touch ID what it can, and holds what
// comes back to what it asked for; the service's chip markers keep the owner key out of the session
// even with vault.json's chip entry deleted (src/main.ts wires that gate). The service here is the
// software stand-in (tests/unit/helpers/chip-fake.ts); its answers can be edited on the way back,
// the way a broken or hostile shell could.
//
// Run: node --test tests/unit/vault-chip.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { base58Decode, base58Encode } from '../../src/chain/near.ts';
import { knownRefusal, refusal } from '../../src/http/wallet.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { OwnerTouchRequired, createKeystore } from '../../src/keystore/store.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { createAccounts } from '../../src/vault/accounts.ts';
import { CHIP_PAYLOAD_LIFE_MS, ChipStatusRefused, MARKER_RECHECK_MS, chipSign, chipStatusReader, commitChip, createChip, isChipPublicKey, ownerKeyGate, sweepChips } from '../../src/vault/chip.ts';
import type { ChipPin } from '../../src/vault/chip.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import type { VaultIntent } from '../../src/vault/payload.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay, VaultRequest } from '../../src/vault/relay.ts';
import { P256_N, webauthnMessage } from '../../src/vault/webauthn.ts';
import { RAW } from '../fixtures/vault-refusal-codes.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { SoftwareChipService, serve } from './helpers/chip-fake.ts';
import type { Answer } from './helpers/chip-fake.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const PAPER = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;
const calm = (said: string): boolean => /^[A-Z]/.test(said) && /\.$/.test(said) && !RAW.test(said);

function liveRelay(makesKeys = true): VaultRelay {
  return createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys });
}

// One request asked, and answered with exactly `answer` by a shell that reads it first.
async function askAnswered(relay: VaultRelay, ask: Omit<VaultRequest, 'id'>, answer: (request: VaultRequest) => Record<string, unknown>) {
  const asked = relay.ask(ask);
  const request = await relay.next(1000);
  assert.ok(request !== null);
  relay.answer({ ...answer(request), id: request.id });
  return asked;
}

async function chipWorld(edit?: (request: VaultRequest, answer: Answer) => Answer) {
  const relay = liveRelay();
  const service = new SoftwareChipService();
  const shell = serve(relay, service, edit);
  const vault = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const allowance = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const made = await createChip(relay);
  assert.ok(made.ok);
  const committed = await commitChip(relay, { keyRef: made.keyRef, account: vault, allowance, recovery: PAPER });
  assert.ok(committed.ok);
  const pin: ChipPin = { keyRef: made.keyRef, publicKey: made.publicKey, account: vault };
  const payload = (intents: VaultIntent[] = [], signer = vault) => buildVaultPayload({ signerId: signer, intents, deadlineMs: Date.now() + CHIP_PAYLOAD_LIFE_MS, salt: SALT });
  return { relay, service, shell, vault, allowance, pin, payload, stop: () => shell.stop() };
}

test('the relay carries the five chip ops and reads every answer strictly', async () => {
  const relay = liveRelay();
  const xy = Buffer.alloc(64, 1);
  const created = await askAnswered(relay, { op: 'chipCreate' }, () => ({ ok: true, keyRef: KEY_REF, publicKey: `p256:${base58Encode(xy)}` }));
  assert.deepEqual(created, { ok: true, op: 'chipCreate', keyRef: KEY_REF, publicKey: `p256:${base58Encode(xy)}` });
  for (const [what, body] of [
    ['a key outside the chip prefix', { keyRef: 'chip:com.karimbabasf.phosphor.vault.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0', publicKey: 'p256:x' }],
    ['a lower-case uuid', { keyRef: KEY_REF.toLowerCase(), publicKey: 'p256:x' }],
    ['no public key', { keyRef: KEY_REF }],
    ['a key on another curve', { keyRef: KEY_REF, publicKey: 'secp256k1:x' }],
  ] as const) {
    const answer = await askAnswered(relay, { op: 'chipCreate' }, () => ({ ok: true, ...body }));
    assert.ok(!answer.ok && answer.error === 'garbled', what);
  }

  const commit = { keyRef: KEY_REF, account: `0x${'ab'.repeat(20)}`, allowance: `0x${'cd'.repeat(20)}`, recovery: 'secp256k1:x' };
  const other = await askAnswered(relay, { op: 'chipCommit', ...commit }, () => ({ ok: true, keyRef: KEY_REF.replace('0F1E', '1F1E'), at: 'now' }));
  assert.ok(!other.ok && other.error === 'garbled', 'a commit answered for another key');
  assert.deepEqual(await askAnswered(relay, { op: 'chipCommit', ...commit }, () => ({ ok: true, keyRef: KEY_REF, at: '2026-10-04T12:00:00.000Z' })), { ok: true, op: 'chipCommit', keyRef: KEY_REF, at: '2026-10-04T12:00:00.000Z' });
  // The markers the gate reads come from chipStatus, which names each one's chip key.
  assert.deepEqual(relay.chipMarkers(commit.account), []);

  const marker = { account: `0x${'12'.repeat(20)}`, allowance: `0x${'34'.repeat(20)}`, recovery: 'secp256k1:y', at: '2026-10-04T12:00:00.000Z' };
  const status = await askAnswered(relay, { op: 'chipStatus' }, () => ({
    ok: true,
    keychainHome: true,
    chips: [
      { keyRef: KEY_REF, publicKey: 'p256:a', fresh: true, marker },
      { keyRef: 'chip:not-a-tag', publicKey: 'p256:b', fresh: false, marker },
      { keyRef: KEY_REF.replace('0F1E', '2F1E'), publicKey: 'p256:c', fresh: 'yes', marker: { ...marker, at: 7 } },
      'not an object',
    ],
  }));
  assert.deepEqual(status, {
    ok: true,
    op: 'chipStatus',
    status: {
      keychainHome: true,
      chips: [
        { keyRef: KEY_REF, publicKey: 'p256:a', fresh: true, marker },
        { keyRef: KEY_REF.replace('0F1E', '2F1E'), publicKey: 'p256:c', fresh: false, marker: null },
      ],
    },
  });
  assert.deepEqual(relay.chipMarkers(marker.account.toUpperCase().replace('0X', '0x')), [{ publicKey: 'p256:a', recovery: 'secp256k1:y' }]);
  // A marker whose key is gone still names its vault (the service answers publicKey null).
  const orphan = { ...marker, account: `0x${'56'.repeat(20)}` };
  const gone = await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: null, fresh: false, marker: orphan }] }));
  assert.deepEqual(gone, { ok: true, op: 'chipStatus', status: { keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: '', fresh: false, marker: orphan }] } });
  assert.deepEqual(relay.chipMarkers(orphan.account), [{ publicKey: null, recovery: 'secp256k1:y' }]);
  // An unreadable marker (empty pins) names nobody.
  const unreadable = await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: 'p256:a', fresh: false, marker: { account: '', allowance: '', recovery: '', at: 'x' } }] }));
  assert.ok(unreadable.ok && unreadable.op === 'chipStatus' && unreadable.status.chips[0]!.marker === null);
  const asked = await askAnswered(relay, { op: 'chipStatus', keyRef: KEY_REF }, () => ({ ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF.replace('0F1E', '3F1E'), publicKey: 'p256:d', fresh: false, marker: null }] }));
  assert.ok(!asked.ok && asked.error === 'garbled', 'an answer about one chip names that chip and no other');
  const homeless = { ...marker, account: `0x${'99'.repeat(20)}` };
  await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: true, keychainHome: false, chips: [{ keyRef: KEY_REF, publicKey: 'p256:a', fresh: false, marker: homeless }] }));
  assert.deepEqual(relay.chipMarkers(homeless.account), [], 'only an answer that read the keychain home names a marker');

  assert.deepEqual(await askAnswered(relay, { op: 'chipSweep' }, () => ({ ok: true, deleted: 2, kept: -1 })), { ok: true, op: 'chipSweep', deleted: 2, kept: 0 });

  const signed = { standard: 'webauthn', payload: '{}', public_key: 'p256:a', signature: 'p256:b', client_data_json: '{}', authenticator_data: 'x' };
  const ok = await askAnswered(relay, { op: 'signIntent', keyRef: KEY_REF, payload: '{}' }, () => ({ ok: true, keyRef: KEY_REF, sentence: 'move it', signed }));
  assert.deepEqual(ok, { ok: true, op: 'signIntent', keyRef: KEY_REF, sentence: 'move it', signed });
  for (const [what, body] of [
    ['another key', { keyRef: KEY_REF.replace('0F1E', '4F1E'), sentence: 'move it', signed }],
    ['no key', { sentence: 'move it', signed }],
    ['no sentence', { keyRef: KEY_REF, sentence: '', signed }],
    ['no signed object', { keyRef: KEY_REF, sentence: 'move it', signed: [signed] }],
  ] as const) {
    const answer = await askAnswered(relay, { op: 'signIntent', keyRef: KEY_REF, payload: '{}' }, () => ({ ok: true, ...body }));
    assert.ok(!answer.ok && answer.error === 'garbled', what);
  }
  relay.stop();
});

test('a demo relay answers the three chip writes itself and passes the reads and the Touch ID on', async () => {
  const relay = liveRelay(false);
  for (const op of ['chipCreate', 'chipCommit', 'chipSweep'] as const) {
    const answer = await relay.ask({ op, keyRef: KEY_REF, account: `0x${'ab'.repeat(20)}` });
    assert.ok(!answer.ok && answer.error === 'no_keychain_home', op);
    assert.equal(relay.queued(), 0, `${op} never reaches the shell`);
  }
  // The same as the 1b writes, which stay refused.
  for (const op of ['create', 'commit', 'sweep'] as const) assert.ok(!(await relay.ask({ op })).ok);
  for (const op of ['chipStatus', 'signIntent'] as const) {
    const asked = relay.ask({ op, keyRef: KEY_REF, payload: '{}' });
    const request = await relay.next(1000);
    assert.equal(request?.op, op, `${op} is handed to the shell`);
    relay.answer({ id: request!.id, ok: false, error: 'keychain_unavailable', message: 'test' });
    await asked;
  }
  assert.equal(refusal('no_keychain_home').error, 'This copy of Phosphor cannot do this, so your wallet stays as it is.');
  relay.stop();
});

test('chipSign: one Touch ID, and the chip\'s own signature over exactly the payload asked for', async () => {
  const w = await chipWorld();
  try {
    const payload = w.payload([{ intent: 'transfer', receiver_id: w.allowance, tokens: { [USDC]: '5000000' } }]);
    const signed = await chipSign(w.relay, w.pin, payload, { allowance: w.allowance });
    assert.ok(signed.ok, JSON.stringify(signed));
    assert.equal(signed.signed.payload, payload);
    assert.equal(signed.signed.public_key, w.pin.publicKey);
    assert.equal(signed.sentence, 'transfer from your vault');
    // The signature verifies under the pinned key over the webauthn wrapper, S low.
    const xy = base58Decode(w.pin.publicKey.slice(5));
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(xy.subarray(0, 32)).toString('base64url'), y: Buffer.from(xy.subarray(32)).toString('base64url') }, format: 'jwk' });
    const rs = base58Decode(signed.signed.signature.slice(5));
    assert.ok(crypto.verify('sha256', webauthnMessage(payload), { key, dsaEncoding: 'ieee-p1363' }, rs));
    assert.ok(BigInt(`0x${Buffer.from(rs.subarray(32)).toString('hex')}`) <= P256_N >> 1n);
    assert.equal(w.service.signatures, 1);
  } finally {
    await w.stop();
  }
});

test('chipSign refuses before any Touch ID what it can see itself: a payload the app would not build, one for another vault, a pin it cannot use', async () => {
  const w = await chipWorld();
  try {
    const body = JSON.parse(w.payload()) as Record<string, string>;
    const cases: [string, ChipPin, string, string][] = [
      ['not JSON', w.pin, '{"signer_id"', 'chip_payload'],
      ['a leading byte order mark', w.pin, `﻿${w.payload()}`, 'chip_payload'],
      ['a nonce that expires with its payload', w.pin, JSON.stringify({ ...body, nonce: buildNonce({ salt: SALT, deadlineMs: Date.parse(body.deadline!), random: new Uint8Array(15) }) }), 'chip_payload'],
      ['a nonce a millisecond past seven days', w.pin, JSON.stringify({ ...body, nonce: buildNonce({ salt: SALT, deadlineMs: Date.parse(body.deadline!) + NONCE_LIFE_AFTER_DEADLINE_MS + 1, random: new Uint8Array(15) }) }), 'chip_payload'],
      ['a token_diff', w.pin, JSON.stringify({ ...body, intents: [{ intent: 'token_diff', diff: {} }] }), 'chip_payload'],
      ['another vault', w.pin, w.payload([], w.allowance), 'chip_payload'],
      ['a pin with no key', { ...w.pin, publicKey: '' }, w.payload(), 'chip_missing'],
      ['a pin whose key is not a point', { ...w.pin, publicKey: `p256:${base58Encode(Buffer.alloc(64, 0))}` }, w.payload(), 'chip_missing'],
      ['a pin with no account', { ...w.pin, account: '' }, w.payload(), 'chip_missing'],
    ];
    for (const [what, pin, payload, code] of cases) {
      const result = await chipSign(w.relay, pin, payload);
      assert.ok(!result.ok && result.code === code, `${what}: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(w.service.seen.filter((r) => r.op === 'signIntent'), [], 'no Touch ID was asked for');
  } finally {
    await w.stop();
  }
});

test('chipSign holds the answer to the question: the payload byte for byte, the pinned key, the wrapper, a low S and a signature that verifies', async () => {
  let edit: ((answer: Answer, request: VaultRequest) => Answer) | null = null;
  const w = await chipWorld((request, answer) => (edit === null || request.op !== 'signIntent' ? answer : edit(answer, request)));
  try {
    const other = await createChip(w.relay);
    assert.ok(other.ok);
    const asked = w.payload([{ intent: 'transfer', receiver_id: w.allowance, tokens: { [USDC]: '5000000' } }]);
    const swapped = w.payload([{ intent: 'transfer', receiver_id: w.allowance, tokens: { [USDC]: '9000000' } }]);
    const signedOf = (a: Answer) => a.signed as Record<string, string>;
    const edits: [string, (a: Answer) => Answer][] = [
      ['another payload, signed by the chip', (a) => ({ ...a, signed: w.service.signRaw(w.pin.keyRef, swapped) })],
      ['the same payload with one space more, signed by the chip', (a) => ({ ...a, signed: w.service.signRaw(w.pin.keyRef, `${asked} `) })],
      ['another chip\'s signature', (a) => ({ ...a, signed: w.service.signRaw(other.keyRef, asked) })],
      ['a high S', (a) => {
        const rs = Buffer.from(base58Decode(signedOf(a).signature!.slice(5)));
        const s = BigInt(`0x${rs.subarray(32).toString('hex')}`);
        rs.set(Buffer.from((P256_N - s).toString(16).padStart(64, '0'), 'hex'), 32);
        return { ...a, signed: { ...signedOf(a), signature: `p256:${base58Encode(rs)}` } };
      }],
      ['user present cleared in the authenticator data', (a) => {
        const data = Buffer.from(signedOf(a).authenticator_data!, 'base64url');
        data[32] = 0x04;
        return { ...a, signed: { ...signedOf(a), authenticator_data: data.toString('base64url') } };
      }],
      ['a signature with one bit changed', (a) => {
        const rs = Buffer.from(base58Decode(signedOf(a).signature!.slice(5)));
        rs[5]! ^= 1;
        return { ...a, signed: { ...signedOf(a), signature: `p256:${base58Encode(rs)}` } };
      }],
      ['a field too many', (a) => ({ ...a, signed: { ...signedOf(a), note: 'x' } })],
      ['erc191 in place of webauthn', (a) => ({ ...a, signed: { ...signedOf(a), standard: 'erc191' } })],
    ];
    for (const [what, change] of edits) {
      edit = (a) => change(a);
      const result = await chipSign(w.relay, w.pin, asked, { allowance: w.allowance });
      assert.ok(!result.ok && result.code === 'chip_answer', `${what}: ${JSON.stringify(result)}`);
    }
    edit = (a) => ({ ...a, keyRef: other.keyRef });
    const garbled = await chipSign(w.relay, w.pin, asked, { allowance: w.allowance });
    assert.ok(!garbled.ok && garbled.code === 'garbled', 'an answer for another chip key never reaches the checks');
    edit = null;
    assert.ok((await chipSign(w.relay, w.pin, asked, { allowance: w.allowance })).ok, 'the unedited answer passes');
  } finally {
    await w.stop();
  }
});

test('the service\'s refusals reach the caller by their codes, and each has a calm sentence', async () => {
  let asked = 0;
  const w = await chipWorld((request, answer) => {
    if (request.op === 'signIntent') asked += 1;
    return answer;
  });
  try {
    const unmarked = await createChip(w.relay);
    assert.ok(unmarked.ok);
    const transfer = w.payload([{ intent: 'transfer', receiver_id: w.allowance, tokens: { [USDC]: '1' } }]);
    w.service.touch = 'cancel';
    const toAllowance = { allowance: w.allowance };
    const cancelled = await chipSign(w.relay, w.pin, transfer, toAllowance);
    const cases: [string, Awaited<ReturnType<typeof chipSign>>, string][] = [
      ['a cancelled Touch ID', cancelled, 'user_cancel'],
      ['a chip with no marker', await chipSign(w.relay, { ...w.pin, keyRef: unmarked.keyRef, publicKey: unmarked.publicKey }, transfer, toAllowance), 'not_committed'],
    ];
    // A key the chip never adds: refused here before the service is asked, and by the service when asked straight.
    const addKey = w.payload([{ intent: 'add_public_key', public_key: `p256:${base58Encode(Buffer.alloc(64, 7))}` }]);
    const before = asked;
    const here = await chipSign(w.relay, w.pin, addKey);
    assert.ok(!here.ok && here.code === 'chip_payload' && here.detail.startsWith('refused_kind: add_public_key'), JSON.stringify(here));
    assert.equal(asked, before, 'the service was never asked');
    const there = await w.relay.ask({ op: 'signIntent', keyRef: w.pin.keyRef, payload: addKey });
    assert.ok(!there.ok && there.error === 'grammar', JSON.stringify(there));
    assert.ok(knownRefusal('grammar') && calm(String(refusal('grammar').error)));
    w.service.keychainHome = false;
    cases.push(['a build with no keychain home', await chipSign(w.relay, w.pin, transfer, toAllowance), 'keychain_unavailable']);
    w.service.keychainHome = true;
    // The marker pins another vault than the payload's signer.
    const elsewhere = await createChip(w.relay);
    assert.ok(elsewhere.ok);
    assert.ok((await commitChip(w.relay, { keyRef: elsewhere.keyRef, account: w.allowance, allowance: w.vault, recovery: PAPER })).ok);
    cases.push(['a payload for another vault than the marker\'s', await chipSign(w.relay, { keyRef: elsewhere.keyRef, publicKey: elsewhere.publicKey, account: w.vault }, transfer, toAllowance), 'wrong_signer']);
    for (const [what, result, code] of cases) {
      assert.ok(!result.ok && result.code === code, `${what}: ${JSON.stringify(result)}`);
      assert.ok(knownRefusal(code) && calm(String(refusal(code).error)), `${code}: ${String(refusal(code).error)}`);
    }
    assert.equal(w.service.signatures, 0);
  } finally {
    await w.stop();
  }
});

test('chipSign reads the service\'s grammar first: a key added, predecessor auth switched or any payload the grammar refuses never reaches the service', async () => {
  let asked = 0;
  const w = await chipWorld((request, answer) => {
    if (request.op === 'signIntent') asked += 1;
    return answer;
  });
  try {
    const now = Date.now();
    const at = (deadlineMs: number, intents: VaultIntent[] = []) => buildVaultPayload({ signerId: w.vault, intents, deadlineMs, salt: SALT });
    const send = (asset: string, amount: string, to: string): VaultIntent => ({ intent: 'transfer', receiver_id: to, tokens: { [asset]: amount } });
    const good = w.payload([send(USDC, '5000000', w.allowance)]);
    const other = `p256:${base58Encode(Buffer.alloc(64, 0x33))}`;
    const hostile: [string, string, string][] = [
      ['predecessor auth on', w.payload([{ intent: 'set_auth_by_predecessor_id', enabled: true }]), 'refused_kind'],
      ['predecessor auth off', w.payload([{ intent: 'set_auth_by_predecessor_id', enabled: false }]), 'refused_kind'],
      ['a key added', w.payload([{ intent: 'add_public_key', public_key: other }]), 'refused_kind'],
      ['two receivers', w.payload([send(USDC, '1', w.allowance), send('nep141:usdt.tether-token.near', '1', 'evil.near')]), 'one_receiver'],
      ['two kinds', w.payload([send(USDC, '1', w.allowance), { intent: 'remove_public_key', public_key: other }]), 'one_kind'],
      ['an asset id with no token id', w.payload([send('nep245:mt.near', '1', w.allowance)]), 'token'],
      ['USDC twice', w.payload([send(USDC, '1', w.allowance), send('nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', '1', w.allowance)]), 'token_repeat'],
      ['five transfers', w.payload([1, 2, 3, 4, 5].map((n) => send(USDC, String(n), w.allowance))), 'intents'],
      ['the chip removing itself', w.payload([{ intent: 'remove_public_key', public_key: w.pin.publicKey }]), 'signing_key'],
      ['one key removed twice', w.payload([{ intent: 'remove_public_key', public_key: other }, { intent: 'remove_public_key', public_key: other }]), 'key_repeat'],
      ['a receiver that is no NEAR name', good.replace(`"receiver_id":"${w.allowance}"`, '"receiver_id":"a"'), 'shape'],
      ['a send to a name that reads like the allowance', w.payload([send(USDC, '100000000', 'your-allowance.near')]), 'receiver'],
      ['a send to an address of its own', w.payload([send(USDC, '100000000', `0x${'c3'.repeat(20)}`)]), 'receiver'],
      ['a sentence over 120 characters', w.payload([send(USDC, '340282366920938463463374607431768211455', w.allowance), send('nep141:usdt.tether-token.near', '340282366920938463463374607431768211455', w.allowance)]), 'sentence'],
      ['over 4096 bytes', good + ' '.repeat(4096), 'size'],
      ['a character past ASCII', good.replace('intents.near', 'intents.nеar'), 'ascii'],
      ['a backslash escape', good.replace('intents.near', 'intents\\u002enear'), 'escape'],
      ['a past deadline', at(now - 1_000, [send(USDC, '1', w.allowance)]), 'deadline'],
      ['a deadline past now and 120 s', at(now + 121_000, [send(USDC, '1', w.allowance)]), 'deadline'],
    ];
    for (const [what, payload, rule] of hostile) {
      const r = await chipSign(w.relay, w.pin, payload, { now: () => now, allowance: w.allowance, recovery: PAPER });
      assert.ok(!r.ok && r.code === 'chip_payload', `${what}: ${JSON.stringify(r)}`);
      if (rule !== 'shape') assert.ok(r.detail.startsWith(`${rule}: `), `${what}: ${r.detail}`);
    }
    assert.equal(asked, 0, 'the service was asked');
    assert.equal(w.service.signatures, 0);
    // What the grammar takes still goes to the service, and signs once.
    const signed = await chipSign(w.relay, w.pin, good, { now: () => now, allowance: w.allowance, recovery: PAPER });
    assert.ok(signed.ok, JSON.stringify(signed));
    assert.equal(asked, 1);
    assert.equal(w.service.signatures, 1);
  } finally {
    await w.stop();
  }
});

test('chipStatus reads for the accounts: kind chip on the service\'s word, and a refusal leaves the last answer standing', async () => {
  const w = await chipWorld();
  try {
    const read = chipStatusReader(w.relay);
    const status = await read(w.pin.keyRef);
    assert.equal(status.chips.length, 1);
    assert.equal(status.chips[0]!.marker?.account, w.vault);
    const prefs = { get: () => ({ chip: { ...w.pin, migratedAt: '2026-10-04T12:00:00.000Z' } }) };
    const accounts = createAccounts({ keystore: { addresses: () => ({ evm: w.vault }), derivedAccounts: () => ({ allowance: w.allowance as `0x${string}`, gas: 'a'.repeat(64) }) }, prefs, chipStatus: read });
    assert.equal((await accounts.refresh()).kind, 'chip');
    w.service.keychainHome = false;
    await assert.rejects(read(w.pin.keyRef), /keychain_unavailable/);
    assert.equal((await accounts.refresh()).kind, 'chip', 'a refusal is no answer: the last one stands');
  } finally {
    await w.stop();
  }
});

test('createChip takes only a P-256 point, and chipCommit and chipSweep carry the service\'s answers', async () => {
  const w = await chipWorld();
  try {
    assert.equal(isChipPublicKey(w.pin.publicKey), true);
    assert.equal(isChipPublicKey(`p256:${base58Encode(Buffer.alloc(64, 0))}`), false);
    assert.equal(isChipPublicKey(`p256:${base58Encode(Buffer.alloc(63, 1))}`), false);
    const relay = liveRelay();
    const bad = await askAnswered(relay, { op: 'chipCreate' }, () => ({ ok: true, keyRef: KEY_REF, publicKey: `p256:${base58Encode(Buffer.alloc(64, 0))}` }));
    assert.ok(bad.ok, 'the relay reads the shape');
    relay.stop();
    const again = await commitChip(w.relay, { keyRef: w.pin.keyRef, account: w.vault, allowance: w.allowance, recovery: PAPER });
    assert.ok(again.ok, 'the same pins again answer ok');
    const changed = await commitChip(w.relay, { keyRef: w.pin.keyRef, account: w.vault, allowance: `0x${'cd'.repeat(20)}`, recovery: PAPER });
    assert.ok(!changed.ok && changed.code === 'marker_exists');
    const swept = await sweepChips(w.relay);
    assert.ok(swept.ok && swept.deleted === 0);
  } finally {
    await w.stop();
  }
});

test('a service built without the chip ops, or a shell that does not relay them, reads as no chip support in calm words', async () => {
  const relay = liveRelay();
  // What main.swift alone (no -D PHOSPHOR_CHIP) and an older shell answer an op they do not know.
  const shell = serve(relay, { run: () => ({ ok: false, error: 'bad_input', message: 'unknown op' }) });
  try {
    const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const pin: ChipPin = { keyRef: KEY_REF, publicKey: `p256:${base58Encode(Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]))}`, account: `0x${'ab'.repeat(20)}` };
    const results = [
      await createChip(relay),
      await commitChip(relay, { keyRef: KEY_REF, account: `0x${'ab'.repeat(20)}`, allowance: `0x${'cd'.repeat(20)}`, recovery: PAPER }),
      await sweepChips(relay),
    ];
    for (const r of results) assert.ok(!r.ok && r.code === 'chip_unsupported', JSON.stringify(r));
    assert.equal(isChipPublicKey(pin.publicKey), true);
    const signed = await chipSign(relay, pin, buildVaultPayload({ signerId: pin.account, intents: [], deadlineMs: Date.now() + CHIP_PAYLOAD_LIFE_MS, salt: SALT }));
    assert.ok(!signed.ok && signed.code === 'chip_unsupported', JSON.stringify(signed));
    await assert.rejects(chipStatusReader(relay)(KEY_REF), (err: unknown) => err instanceof ChipStatusRefused && err.code === 'chip_unsupported');
    const said = String(refusal('chip_unsupported').error);
    assert.ok(calm(said), said);
  } finally {
    await shell.stop();
    relay.stop();
  }
});

test('the chip ops are checked here before they are asked: a bad label, pins the service would refuse, a key ref that is not a chip\'s', async () => {
  const relay = liveRelay();
  const asked: VaultRequest[] = [];
  const shell = serve(relay, { run: (r) => (asked.push(r), { ok: false, error: 'bad_input', message: 'x' }) });
  try {
    const good = { keyRef: KEY_REF, account: `0x${'ab'.repeat(20)}`, allowance: `0x${'cd'.repeat(20)}`, recovery: PAPER };
    const cases: [string, Promise<{ ok: boolean; code?: string }>][] = [
      ['a label with a capital', createChip(relay, 'Bad')],
      ['a sweep label with a dot', sweepChips(relay, 'a.b')],
      ['a vault key ref', commitChip(relay, { ...good, keyRef: 'chip:com.karimbabasf.phosphor.vault.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0' })],
      ['the vault as its own allowance', commitChip(relay, { ...good, allowance: good.account.toUpperCase().replace('0X', '0x') })],
      ['a named account as the vault', commitChip(relay, { ...good, account: 'vault.near' })],
      ['a p256 paper key', commitChip(relay, { ...good, recovery: `p256:${base58Encode(Buffer.alloc(64, 1))}` })],
    ];
    for (const [what, pending] of cases) {
      const r = await pending;
      assert.ok(!r.ok && r.code === 'invalid_request', `${what}: ${JSON.stringify(r)}`);
    }
    await assert.rejects(chipStatusReader(relay)('chip:nope'), (err: unknown) => err instanceof ChipStatusRefused && err.code === 'chip_missing');
    assert.deepEqual(asked, [], 'nothing reached the service');
  } finally {
    await shell.stop();
    relay.stop();
  }
});

test('createChip refuses a new key that is not a point on P-256 before anything can pin it', async () => {
  const relay = liveRelay();
  const shell = serve(relay, { run: () => ({ ok: true, keyRef: KEY_REF, publicKey: `p256:${base58Encode(Buffer.alloc(64, 0))}` }) });
  try {
    const made = await createChip(relay);
    assert.ok(!made.ok && made.code === 'garbled');
  } finally {
    await shell.stop();
    relay.stop();
  }
});

test('deleting the chip entry in vault.json does not bring the owner key back while a marker names the vault and the chain shows it moved', async () => {
  const [V] = DERIVED_VECTORS;
  const vault = V.vault.toLowerCase();
  // One Mac: a wallet whose vault is V, the software service, a chain double the gate reads.
  async function mac(markerFor: string | null) {
    const dir = tempDir('phosphor-chip-gate-');
    fs.mkdirSync(path.join(dir, 'state'));
    const prefs = createVaultPrefs(path.join(dir, 'state'));
    const relay = liveRelay();
    const service = new SoftwareChipService();
    const shell = serve(relay, service);
    const chain = createIntentsDouble();
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const store = createKeystore({ keysPath: path.join(dir, 'keys.json'), kdf: () => ({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') }) });
    // As src/main.ts wires it.
    const gate = ownerKeyGate(() => prefs.get(), relay, chain.verifier);
    store.keepOwnerKeyOutWhen(gate);
    store.importWithEnclave({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, { keys: { evm: `0x${V.old}` } });
    const made = await createChip(relay);
    assert.ok(made.ok);
    if (markerFor !== null) assert.ok((await commitChip(relay, { keyRef: made.keyRef, account: markerFor, allowance: V.allowance.toLowerCase(), recovery: PAPER })).ok);
    const reopen = () => {
      store.lock();
      const req = store.enclaveRequest()!;
      store.unlockWithDataKey(seUnwrapWithSoftwareKey({ ephemeralPublicKey: req.ephemeralPublicKey, ciphertext: req.ciphertext }, pair.privateKey, Buffer.from(req.aad, 'base64')));
    };
    // What src/main.ts does at start: read the markers, then let the gate ask the chain.
    const boot = async () => {
      await relay.ask({ op: 'chipStatus' });
      gate(V.vault);
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { prefs, relay, store, made, chain, gate, reopen, boot, stop: async () => (await shell.stop(), relay.stop()) };
  }

  // The vault moved: its chip and paper keys are on chain. The chip entry is then deleted.
  const moved = await mac(vault);
  try {
    moved.chain.addKey(vault, moved.made.publicKey);
    moved.chain.addKey(vault, PAPER);
    moved.prefs.setChip({ keyRef: moved.made.keyRef, publicKey: moved.made.publicKey, account: vault });
    moved.reopen();
    assert.throws(() => moved.store.keys(), OwnerTouchRequired);
    moved.prefs.setChip(null);
    assert.equal(moved.prefs.get().chip, null);
    await moved.boot();
    moved.reopen();
    assert.throws(() => moved.store.keys(), OwnerTouchRequired, 'the owner key stays out');
    assert.throws(() => moved.store.evmPrivateKey(), OwnerTouchRequired);
    // Once the chain said moved, that is for good: a later read that says otherwise changes nothing.
    moved.chain.faults.reads = true;
    assert.equal(moved.gate(V.vault), true);
  } finally {
    await moved.stop();
  }

  // A marker on a vault that never moved (a migration stopped after its commit, or a backend that
  // pinned a key to it): the chain shows neither key, so the owner key opens as before.
  const stopped = await mac(vault);
  try {
    await stopped.boot();
    stopped.reopen();
    assert.equal(stopped.store.evmPrivateKey(), `0x${V.old}`);
  } finally {
    await stopped.stop();
  }

  // Until the chain has answered, a marker keeps the key out, and a read that fails keeps it out.
  const unread = await mac(vault);
  try {
    unread.chain.faults.reads = true;
    await unread.boot();
    unread.reopen();
    assert.throws(() => unread.store.keys(), OwnerTouchRequired, 'no chain answer, the key stays out');
    unread.chain.faults.reads = false;
    assert.equal(unread.gate(V.vault), true, 'asked again; out while it is asked');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unread.gate(V.vault), false, 'the chain answered: the vault never moved');
  } finally {
    await unread.stop();
  }

  // No marker for this vault: nothing is asked of the chain, and the owner key opens.
  const other = await mac(`0x${'77'.repeat(20)}`);
  try {
    await other.boot();
    other.reopen();
    assert.equal(other.store.evmPrivateKey(), `0x${V.old}`);
  } finally {
    await other.stop();
  }
});

test('the gate counts a marker whose chip key is gone by the paper key it pins, and asks again about a vault that did not move', async () => {
  const relay = liveRelay();
  const vault = `0x${'ab'.repeat(20)}`;
  const marker = { account: vault, allowance: `0x${'cd'.repeat(20)}`, recovery: PAPER, at: '2026-10-04T12:00:00.000Z' };
  await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: null, fresh: false, marker }] }));
  const asked: string[] = [];
  let paperOnChain = false;
  let clock = 0;
  const gate = ownerKeyGate(() => ({ chip: null }), relay, { hasPublicKey: async (_account, key) => (asked.push(key), key === PAPER && paperOnChain) }, { now: () => clock });
  assert.equal(gate(vault), true, 'out while the chain is asked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [PAPER], 'a gone key is not asked; the paper key is');
  assert.equal(gate(vault), false, 'the paper key is not on the vault: it never moved');
  // The vault moves later (on another Mac, say). The answer in hand stands until it is asked again.
  paperOnChain = true;
  clock += MARKER_RECHECK_MS - 1;
  assert.equal(gate(vault), false);
  assert.equal(asked.length, 1);
  clock += 2;
  assert.equal(gate(vault), false, 'asked again in the background; the old answer stands meanwhile');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 2);
  assert.equal(gate(vault), true, 'now it moved, and the key stays out');
  relay.stop();
});

test('no marker known is not no marker: until a status of every chip answers, the chain alone decides, and only no key listed with the owner key on lets the key in (FA-1)', async () => {
  const vault = `0x${'ab'.repeat(20)}`;
  const OWNER = `secp256k1:${base58Encode(Buffer.alloc(64, 0x17))}`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // A chain that answers `keys` for the vault's list and `ownerOn` for the owner key; null is no answer.
  const chainOf = (keys: string[] | null, ownerOn: boolean | null) => ({
    publicKeysOf: async () => (keys === null ? Promise.reject(new Error('no answer')) : keys),
    hasPublicKey: async () => (ownerOn === null ? Promise.reject(new Error('no answer')) : ownerOn),
  });
  const judged = async (keys: string[] | null, ownerOn: boolean | null, owner: string | null = OWNER): Promise<boolean> => {
    const relay = liveRelay();
    const gate = ownerKeyGate(() => ({ chip: null }), relay, chainOf(keys, ownerOn), { owner: () => owner });
    assert.equal(relay.chipMarkersKnown(), false, 'no status has answered: the markers are not known');
    assert.equal(gate(vault), true, 'out while the chain is asked');
    await settle();
    const verdict = gate(vault);
    relay.stop();
    return verdict;
  };
  assert.equal(await judged([], true), false, 'no key listed and the owner key on: the key comes in');
  assert.equal(await judged([PAPER], true), true, 'a key listed: the vault moved');
  assert.equal(await judged([], false), true, 'the owner key off: the vault moved');
  assert.equal(await judged(null, true), true, 'no list: out until there is one');
  assert.equal(await judged([], null), true, 'no word on the owner key: out');
  assert.equal(await judged([], true, null), true, 'the owner key not read by any open yet: out');

  // A status for one chip says nothing of the others; a status of every chip makes them known, and
  // the gate goes back to the markers, exactly as before.
  const relay = liveRelay();
  const gate = ownerKeyGate(() => ({ chip: null }), relay, chainOf([PAPER], false), { owner: () => OWNER });
  await askAnswered(relay, { op: 'chipStatus', keyRef: KEY_REF }, () => ({ ok: true, keychainHome: true, chips: [] }));
  assert.equal(relay.chipMarkersKnown(), false);
  await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: false, error: 'keychain_unavailable', message: 'locked' }));
  assert.equal(relay.chipMarkersKnown(), false, 'a refused status leaves them unknown');
  await askAnswered(relay, { op: 'chipStatus' }, () => ({ ok: true, keychainHome: true, chips: [] }));
  assert.equal(relay.chipMarkersKnown(), true);
  assert.equal(gate(vault), false, 'no marker for this vault, known: the key opens as before');
  relay.stop();
  // A backend the shell did not start has no chip to use: nothing to wait for.
  assert.equal(createVaultRelay({ transportKey: null }).chipMarkersKnown(), true);
});

test('src/main.ts wires the gate with the service\'s marker and reads the markers at start, before the server', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');
  // The gate reads the owner key's public half from the keystore, for the chain alone to judge by
  // while no marker is known (FA-1).
  const made = main.indexOf('const ownerKeyStaysOut = ownerKeyGate(() => vaultPrefs.get(), vault, liveVerifier(), { owner: () => keystore.ownerPublicKey() });');
  const gate = main.indexOf('keystore.keepOwnerKeyOutWhen(ownerKeyStaysOut);');
  assert.ok(made > 0 && made < gate, 'one gate, made beside the keystore and handed to it');
  const status = main.indexOf("    void vault.ask({ op: 'chipStatus' }).then((answer) => {");
  const probe = main.indexOf("void vault.ask({ op: 'probe' })");
  const first = main.indexOf('  askMarkers(0);');
  assert.ok(gate > 0 && status > 0 && probe > 0 && first > status);
  assert.ok(gate < main.indexOf('const server = createServer('));
  // Queued at start right behind the probe, not once it answers: nothing the window asks can come first.
  assert.ok(status > probe && !main.slice(probe + "void vault.ask({ op: 'probe' })".length, status).includes('vault.ask({'), 'the next ask after the probe');
  assert.ok(!main.slice(status + 10, first).includes('vault.ask({'), 'and asked at once, before anything else');
  // Its answer has the gate ask the chain about this wallet's vault before any unlock is answered,
  // and a status that did not answer is asked again until one does.
  const answered = main.slice(status, first);
  assert.ok(answered.includes('ownerKeyStaysOut(evm)'));
  assert.ok(answered.includes('if (answer.ok || vault.chipMarkersKnown()) return;') && answered.includes('askMarkers(attempt + 1)'));
});

test('the relay hands the chip markers out ahead of an unlock asked a moment later, so the gate knows them at the open', async () => {
  const relay = liveRelay();
  const probe = relay.ask({ op: 'probe' });
  const markers = relay.ask({ op: 'chipStatus' });
  const unwrap = relay.ask({ op: 'unwrap', keyBlob: 'x', reason: 'Unlock Phosphor' });
  const order: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const request = await relay.next(1000);
    assert.ok(request !== null);
    order.push(request.op);
    relay.answer({ id: request.id, ok: false, error: 'user_cancel', message: 'test' });
  }
  await Promise.all([probe, markers, unwrap]);
  assert.deepEqual(order, ['probe', 'chipStatus', 'unwrap']);
  relay.stop();
});

test('every code the chip signer and the submitter answer with has a calm sentence of its own', () => {
  const sources = ['src/vault/chip.ts', 'src/vault/submit.ts'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const codes = new Set([
    ...[...sources.matchAll(/refused\('([a-z_]+)'/g)].map((m) => m[1]!),
    ...[...sources.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!),
    // The NEAR RPC's refusals before signing (NearTxRefusal) that a vault move can still meet.
    'invalid_request', 'rpc_unavailable',
    // The service's two new chip refusals (C1), and the relay's.
    'grammar', 'wrong_signer', 'not_committed', 'keychain_unavailable', 'garbled', 'no_keychain_home',
  ]);
  assert.ok(codes.size >= 20, [...codes].join(' '));
  for (const code of codes) {
    assert.ok(knownRefusal(code), `${code} has no sentence in REFUSALS`);
    const said = String(refusal(code).error);
    assert.ok(calm(said), `${code}: ${said}`);
  }
});
