// The rekey's own pieces, in Node with software keys (src/vault/rekey.ts, phrase24.ts,
// gas-account.ts): the bundle a migration and a restore sign, the exact events the verifier must
// report for it (C7's five for a migration), the payload checks before anything leaves, the paper
// key, and the gas account's numbers. Every bundle here is run by the chain double, which applies
// the verifier's rules (tests/unit/helpers/intents-double.ts), so a bundle that passes here is one
// the double executes to C7's four views.
//
// Run: node --test tests/unit/rekey-core.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { english, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import type { MultiPayload } from '../../src/chain/near-tx.ts';
import { YOCTO_PER_NEAR } from '../../src/chain/near-tx.ts';
import type { VerifierEvent } from '../../src/relay/verifier.ts';
import { GAS_FUND_MAX_NEAR, GAS_FUND_MIN_NEAR, fundingNear, gasAccountOf, nearText } from '../../src/vault/gas-account.ts';
import { eventsMismatch, expectedEvents, readVaultPayload } from '../../src/vault/payload.ts';
import { PAPER_PATH, isPaperPhrase, newPaperPhrase, paperKeyOf, phraseDigest, phraseOf, verifierKeyOf } from '../../src/vault/phrase24.ts';
import { SUBMIT_MARGIN_MS, erc191Signed, rekeyChecks, rekeyEvents, rekeyIntents, signRekey } from '../../src/vault/rekey.ts';
import type { RekeyPlan, RekeySigners } from '../../src/vault/rekey.ts';
import { webauthnMessage, webauthnSigned } from '../../src/vault/webauthn.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';

// A software chip: a P-256 key that signs the C1 wrapper, as the vault service does.
function softwareChip() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xy = Uint8Array.from(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return {
    publicKey: `p256:${base58Encode(xy)}`,
    sign: (payload: string): MultiPayload => webauthnSigned(payload, xy, crypto.sign('sha256', webauthnMessage(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' })),
  };
}

function keyOf(hex: `0x${string}`): Buffer {
  return Buffer.from(hex.slice(2), 'hex');
}

// One vault on the double, its owner key, a new chip and a new paper key: what a migration starts from.
function vaultWorld() {
  const chain = createIntentsDouble();
  const old = generatePrivateKey();
  const vault = privateKeyToAccount(old).address.toLowerCase();
  const chip = softwareChip();
  const paper = generatePrivateKey();
  return { chain, old, vault, chip, paper, oldKey: verifierKeyOf(keyOf(old)), paperKey: verifierKeyOf(keyOf(paper)) };
}

function signersOf(w: ReturnType<typeof vaultWorld>, opts: { oldSigner?: `0x${string}`; chipSign?: (p: string) => MultiPayload; onChip?: () => void } = {}): RekeySigners {
  return {
    old: (make) => erc191Signed(keyOf(opts.oldSigner ?? w.old), make()),
    chip: async (payload) => {
      opts.onChip?.();
      return (opts.chipSign ?? w.chip.sign)(payload);
    },
    paper: (payload) => erc191Signed(keyOf(w.paper), payload),
  };
}

// What the verifier reports for a bundle, or a throw naming its refusal.
async function simulated(chain: ReturnType<typeof createIntentsDouble>, bundle: readonly MultiPayload[]): Promise<VerifierEvent[] | undefined> {
  const sim = await chain.verifier.simulate(bundle as never);
  if (sim === null || !sim.ok) throw new Error(`the double refused the bundle: ${JSON.stringify(sim)}`);
  return sim.events;
}

function names(events: readonly VerifierEvent[]): string[] {
  return events.map((e) => (e.event === 'set_auth_by_predecessor_id' ? `${e.event}:${e.data.enabled}` : e.event === 'intents_executed' ? `${e.event}(${e.data.length})` : e.event));
}

test('a migration signs C7\'s bundle: P_a adds the chip and the paper, removes the owner key and turns predecessor auth off', () => {
  const w = vaultWorld();
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  assert.deepEqual(rekeyIntents(plan), [
    { intent: 'add_public_key', public_key: w.chip.publicKey },
    { intent: 'add_public_key', public_key: w.paperKey },
    { intent: 'remove_public_key', public_key: w.oldKey },
    { intent: 'set_auth_by_predecessor_id', enabled: false },
  ]);
  // Done waits for C7's four views and nothing fewer.
  assert.deepEqual(rekeyChecks(plan, w.oldKey), [
    { view: 'hasPublicKey', account: w.vault, publicKey: w.chip.publicKey, is: true },
    { view: 'hasPublicKey', account: w.vault, publicKey: w.paperKey, is: true },
    { view: 'hasPublicKey', account: w.vault, publicKey: w.oldKey, is: false },
    { view: 'predecessorAuth', account: w.vault, is: false },
  ]);
});

test('the migration bundle simulates to exactly C7\'s five events on P_a\'s hash, and runs to the four views', async () => {
  const w = vaultWorld();
  assert.equal(w.chain.predecessorAuth(w.vault), true, 'on by default for an account the verifier never stored');
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  const signed = await signRekey(plan, signersOf(w), { salt: SALT, now: w.chain.now });
  assert.ok(signed.ok, JSON.stringify(signed));
  const bundle = signed.bundle;
  assert.deepEqual(bundle.map((s) => s.standard), ['erc191', 'erc191', 'webauthn'], 'P_a (old signer), P_c (paper), P_b (chip)');
  assert.deepEqual(bundle.slice(1).map((s) => readVaultPayload(s.payload).intents), [[], []], 'P_c and P_b are empty proofs');

  const want = rekeyEvents(plan, bundle);
  assert.deepEqual(names(want), ['public_key_added', 'public_key_added', 'public_key_removed', 'set_auth_by_predecessor_id:false', 'intents_executed(3)']);
  const pa = (want[0] as Extract<VerifierEvent, { event: 'public_key_added' }>).data.intent_hash;
  for (const e of want.slice(0, 4)) assert.ok(e.event !== 'intents_executed' && e.event !== 'transfer' && e.event !== 'other' && e.data.intent_hash === pa, 'all four on P_a');
  assert.equal(eventsMismatch(expectedEvents(bundle, { predecessorAuth: true }), want), null, 'the plan and the bundle agree');

  assert.equal(eventsMismatch(await simulated(w.chain, bundle), want), null, 'the verifier reports the plan exactly');

  assert.deepEqual(await w.chain.runAsStranger(bundle), { ok: true });
  assert.equal(w.chain.hasKey(w.vault, w.chip.publicKey), true);
  assert.equal(w.chain.hasKey(w.vault, w.paperKey), true);
  assert.equal(w.chain.hasKey(w.vault, w.oldKey), false);
  assert.equal(w.chain.predecessorAuth(w.vault), false);
});

test('with predecessor auth already off the plan expects no set_auth event, and a stale "on" read stops the bundle', async () => {
  const w = vaultWorld();
  const off = await erc191Signed(keyOf(w.old), (await import('../../src/vault/payload.ts')).buildVaultPayload({ signerId: w.vault, intents: [{ intent: 'set_auth_by_predecessor_id', enabled: false }], deadlineMs: w.chain.now() + 60_000, salt: SALT }));
  assert.deepEqual(await w.chain.runAsStranger([off]), { ok: true });
  assert.equal(w.chain.predecessorAuth(w.vault), false);

  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: false };
  const signed = await signRekey(plan, signersOf(w), { salt: SALT, now: w.chain.now });
  assert.ok(signed.ok);
  assert.deepEqual(names(rekeyEvents(plan, signed.bundle)), ['public_key_added', 'public_key_added', 'public_key_removed', 'intents_executed(3)']);
  const events = await simulated(w.chain, signed.bundle);
  assert.equal(eventsMismatch(events, rekeyEvents(plan, signed.bundle)), null);
  // The same bundle checked against a read that said "on" expects an event the verifier never makes.
  assert.notEqual(eventsMismatch(events, rekeyEvents({ ...plan, predecessorAuth: true }, signed.bundle)), null);
});

test('a key the vault already lists is taken off in the same payload, and done reads it off too', async () => {
  const w = vaultWorld();
  const stranger = verifierKeyOf(keyOf(generatePrivateKey()));
  w.chain.addKey(w.vault, stranger);
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey, stranger], predecessorAuth: true };
  const signed = await signRekey(plan, signersOf(w), { salt: SALT, now: w.chain.now });
  assert.ok(signed.ok);
  assert.equal(eventsMismatch(await simulated(w.chain, signed.bundle), rekeyEvents(plan, signed.bundle)), null);
  assert.deepEqual(rekeyChecks(plan, w.oldKey).at(-1), { view: 'hasPublicKey', account: w.vault, publicKey: stranger, is: false });
  assert.deepEqual(await w.chain.runAsStranger(signed.bundle), { ok: true });
  assert.equal(w.chain.hasKey(w.vault, stranger), false);
});

test('a signer that signs anything but the planned payload is caught before the bundle leaves', async () => {
  const w = vaultWorld();
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  // An old signer that drops the predecessor intent: the payload it signed is not the plan's.
  const short: RekeySigners = {
    ...signersOf(w),
    old: async (make) => {
      const body = JSON.parse(make()) as { intents: unknown[] };
      const edited = JSON.stringify({ ...body, intents: body.intents.slice(0, 3) });
      return erc191Signed(keyOf(w.old), edited);
    },
  };
  const refused = await signRekey(plan, short, { salt: SALT, now: w.chain.now });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.code === 'vault_bundle', JSON.stringify(refused));
});

test('a Touch ID slower than the payload can wait sends nothing: rekey_slow, with every signature still on this Mac', async () => {
  const w = vaultWorld();
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  const slow = await signRekey(plan, signersOf(w, { onChip: () => w.chain.advance(110_000 - SUBMIT_MARGIN_MS + 1) }), { salt: SALT, now: w.chain.now });
  assert.ok(!slow.ok && slow.code === 'rekey_slow', JSON.stringify(slow));
  const fresh = await signRekey(plan, signersOf(w, { onChip: () => w.chain.advance(110_000 - SUBMIT_MARGIN_MS - 1_000) }), { salt: SALT, now: w.chain.now });
  assert.ok(fresh.ok, 'a touch inside the margin still sends');
});

test('a slow first Touch ID does not eat P_a\'s life: P_a is built once the owner key\'s touch is over', async () => {
  const w = vaultWorld();
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  const slowTouch: RekeySigners = {
    ...signersOf(w),
    old: async (make) => {
      w.chain.advance(100_000);
      return erc191Signed(keyOf(w.old), make());
    },
  };
  const signed = await signRekey(plan, slowTouch, { salt: SALT, now: w.chain.now });
  assert.ok(signed.ok, JSON.stringify(signed));
  assert.ok(Date.parse(readVaultPayload(signed.bundle[0]!.payload).deadline) >= w.chain.now() + 100_000, 'P_a\'s deadline runs from the end of the touch');
});

test('a refusal from a signer stops the bundle where it is: the chip is never asked after the owner key says no', async () => {
  const w = vaultWorld();
  const plan: RekeyPlan = { vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true };
  let chipAsked = 0;
  const said: string[] = [];
  const refused = await signRekey(
    plan,
    { ...signersOf(w, { onChip: () => (chipAsked += 1) }), old: async () => ({ ok: false, code: 'user_cancel', detail: 'cancelled' }) },
    { salt: SALT, now: w.chain.now, said: (s) => said.push(s) },
  );
  assert.ok(!refused.ok && refused.code === 'user_cancel');
  assert.equal(chipAsked, 0);
  assert.deepEqual(said, ['touch_old']);
});

test('a restore: the paper brought signs P_a, takes off the old chip and itself, and adds the new chip and paper', async () => {
  const w = vaultWorld();
  const migrated = await signRekey({ vault: w.vault, chip: w.chip.publicKey, recovery: w.paperKey, remove: [w.oldKey], predecessorAuth: true }, signersOf(w), { salt: SALT, now: w.chain.now });
  assert.ok(migrated.ok);
  assert.deepEqual(await w.chain.runAsStranger(migrated.bundle), { ok: true });

  // A new Mac: a new chip, a new paper, and the old paper as the old signer.
  const chip2 = softwareChip();
  const paper2 = generatePrivateKey();
  const paper2Key = verifierKeyOf(keyOf(paper2));
  const listed = (await w.chain.verifier.publicKeysOf(w.vault))!;
  assert.deepEqual([...listed].sort(), [w.chip.publicKey, w.paperKey].sort(), 'public_keys_of lists the chip and the paper, never the owner key');
  assert.equal(await w.chain.verifier.hasPublicKey(w.vault, w.oldKey), false, 'the owner key is asked by name');
  const plan: RekeyPlan = { vault: w.vault, chip: chip2.publicKey, recovery: paper2Key, remove: listed, predecessorAuth: (await w.chain.verifier.isAuthByPredecessorIdEnabled(w.vault))! };
  assert.equal(plan.predecessorAuth, false);
  const signed = await signRekey(
    plan,
    { old: (make) => erc191Signed(keyOf(w.paper), make()), chip: async (payload) => chip2.sign(payload), paper: (payload) => erc191Signed(keyOf(paper2), payload) },
    { salt: SALT, now: w.chain.now, oldTouches: false },
  );
  assert.ok(signed.ok, JSON.stringify(signed));
  const want = rekeyEvents(plan, signed.bundle);
  assert.deepEqual(names(want), ['public_key_added', 'public_key_added', 'public_key_removed', 'public_key_removed', 'intents_executed(3)'], 'no set_auth event: the flag is already off');
  assert.equal(eventsMismatch(await simulated(w.chain, signed.bundle), want), null);
  assert.deepEqual(await w.chain.runAsStranger(signed.bundle), { ok: true });
  for (const [key, is] of [[chip2.publicKey, true], [paper2Key, true], [w.oldKey, false], [w.chip.publicKey, false], [w.paperKey, false]] as const) assert.equal(w.chain.hasKey(w.vault, key), is, key);
  assert.equal(w.chain.predecessorAuth(w.vault), false);
});

// ---------- the paper key ----------

test('a new paper key is 24 words with a checksum, and its key is the one any EVM wallet derives from them', () => {
  const phrase = newPaperPhrase();
  const words = phrase.split(' ');
  assert.equal(words.length, 24);
  assert.ok(words.every((w) => english.includes(w)));
  assert.equal(isPaperPhrase(phrase), true);
  const paper = paperKeyOf(phrase);
  const viem = mnemonicToAccount(phrase, { path: PAPER_PATH });
  assert.equal(paper.address, viem.address.toLowerCase());
  assert.equal(paper.publicKey, `secp256k1:${base58Encode(Buffer.from(viem.publicKey.slice(4), 'hex'))}`);
  assert.equal(paper.key.length, 32);
  assert.notEqual(newPaperPhrase(), phrase, 'drawn fresh each time');
});

test('the type-back reads 24 strings only, and a slip that breaks the checksum is no paper key', () => {
  const phrase = newPaperPhrase();
  const words = phrase.split(' ');
  assert.equal(phraseOf(words), phrase);
  assert.equal(phraseOf(words.map((w) => ` ${w.toUpperCase()} `)), phrase, 'case and spaces are the window\'s, not the paper\'s');
  assert.equal(phraseOf(words.slice(0, 23)), null);
  assert.equal(phraseOf([...words.slice(0, 23), 7]), null);
  assert.equal(phraseOf(phrase), null, 'one string is not 24 words');
  // Two words swapped: still 24 words from the list, and the checksum says no (in all but a few).
  const swapped = [...words];
  [swapped[3], swapped[17]] = [swapped[17]!, swapped[3]!];
  if (swapped[3] !== swapped[17]) {
    const read = phraseOf(swapped)!;
    assert.equal(isPaperPhrase(read) && paperKeyOf(read).publicKey === paperKeyOf(phrase).publicKey, false);
  }
  assert.equal(isPaperPhrase(phrase.split(' ').slice(0, 12).join(' ')), false, 'twelve words are a wallet phrase, not a paper key');
  assert.deepEqual(phraseDigest(phrase), phraseDigest(` ${phrase.toUpperCase()}  `));
});

test('a paper key\'s verifier name is secp256k1 and the base58 of its 64-byte public key', () => {
  const key = generatePrivateKey();
  const name = verifierKeyOf(keyOf(key));
  assert.match(name, /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(name, `secp256k1:${base58Encode(Buffer.from(privateKeyToAccount(key).publicKey.slice(4), 'hex'))}`);
});

// ---------- the gas account ----------

test('the gas account is the derived id, never one typed, and funding takes 0.1 to 1 NEAR in four places at most', () => {
  assert.equal(gasAccountOf({ derivedAccounts: () => null }), null);
  assert.equal(gasAccountOf({ derivedAccounts: () => ({ gas: 'a'.repeat(64) }) }), 'a'.repeat(64));
  assert.equal(gasAccountOf({ derivedAccounts: () => ({ gas: 'alice.near' }) }), null);
  assert.equal(fundingNear(GAS_FUND_MIN_NEAR), GAS_FUND_MIN_NEAR);
  assert.equal(fundingNear(0.5), 0.5);
  assert.equal(fundingNear(GAS_FUND_MAX_NEAR), GAS_FUND_MAX_NEAR);
  for (const bad of [0, 0.09, 1.01, 0.12345, Number.NaN, '0.5', null, -1]) assert.equal(fundingNear(bad), null, String(bad));
  assert.equal(nearText(0n), '0');
  assert.equal(nearText(YOCTO_PER_NEAR / 2n), '0.5');
  assert.equal(nearText(498_512_345_000_000_000_000_000n), '0.4985');
  assert.equal(nearText(60_000_000_000_000_000_000_000n), '0.06');
  assert.equal(nearText(3n * YOCTO_PER_NEAR), '3');
});
