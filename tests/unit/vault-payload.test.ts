// The chip vault's payloads and the events a bundle of them must produce. The builder is held to
// the bytes the live verifier accepted on 2026-10-04 (tests/fixtures/verifier/simulate-0.4.4.json),
// and the expected events to the events it reported for those same bundles, exactly.
// Nothing here touches a network or a key.
//
// Run: node --test tests/unit/vault-payload.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAddress } from 'viem';

import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce, decodeNonce } from '../../src/relay/payload.ts';
import { simulationOf } from '../../src/relay/verifier.ts';
import type { SignedIntent, VerifierEvent } from '../../src/relay/verifier.ts';
import { buildVaultPayload, eventsMismatch, expectedEvents, readVaultPayload, signedIntentHash } from '../../src/vault/payload.ts';
import type { VaultIntent } from '../../src/vault/payload.ts';

type Recorded = { spike: string; signed: SignedIntent[]; rpcBody: { result: { result?: number[] } } };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/verifier/simulate-0.4.4.json', import.meta.url), 'utf8')) as Record<'run1' | 'run2', Record<string, Recorded>>;
const ALL = (['run1', 'run2'] as const).flatMap((run) => Object.entries(FIXTURE[run]).map(([name, entry]) => ({ run, name, entry })));
const ACCEPTED = ALL.filter((t) => t.entry.rpcBody.result.result !== undefined);

function reported(entry: Recorded): VerifierEvent[] {
  const sim = simulationOf(JSON.parse(Buffer.from(Uint8Array.from(entry.rpcBody.result.result!)).toString('utf8')), entry.signed.length);
  assert.ok(sim.ok && sim.events !== undefined);
  return sim.events;
}

// Every T10p test starts from a fresh throwaway account, whose predecessor flag reads true.
function before(name: string): { predecessorAuth?: boolean } {
  return name.startsWith('T10p') ? { predecessorAuth: true } : {};
}

const VAULT = '0xbb36a6ccc6d6a7a8929d9e7c06cd1fd305e20fb9';
const OLD = 'secp256k1:41dQd2hdKXSMSGXhYnoh8v6b5qcqHh55SYb9Dg3D4kadzsfKbpeWYrBd2TnkbttJRxZkGiHhia1rQacNwj2tNeD1';
const ALLOWANCE = '0x12ab5678901234567890123456789012390abcd3';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
const DEADLINE = Date.parse('2026-10-04T18:57:00.839Z');
const RANDOM = () => Uint8Array.from({ length: 15 }, (_, i) => i + 1);

test('the builder writes every payload the live verifier read on 2026-10-04 byte for byte, its nonce now living seven days longer', () => {
  let rebuilt = 0;
  for (const { run, name, entry } of ALL) {
    for (const signed of entry.signed) {
      const body = JSON.parse(signed.payload) as { signer_id: string; deadline: string; nonce: string; intents: VaultIntent[] };
      const nonce = decodeNonce(body.nonce)!;
      let again: string;
      try {
        again = buildVaultPayload({ signerId: body.signer_id, intents: body.intents, deadlineMs: Date.parse(body.deadline), salt: nonce.salt, random: () => nonce.random });
      } catch {
        continue; // T7's payload was changed after signing on purpose
      }
      // Recorded before the seven-day rule, when a vault nonce expired with its payload.
      assert.equal(nonce.deadlineMs, Date.parse(body.deadline), `${run} ${name}`);
      const lived = buildNonce({ salt: nonce.salt, deadlineMs: nonce.deadlineMs + NONCE_LIFE_AFTER_DEADLINE_MS, random: nonce.random });
      assert.equal(again, signed.payload.replace(body.nonce, lived), `${run} ${name}`);
      rebuilt += 1;
    }
  }
  assert.ok(rebuilt >= 80, `rebuilt ${rebuilt}`);
});

test('a built payload: keys in order, a V1 nonce on the live salt that lives seven days past the payload deadline', () => {
  const payload = buildVaultPayload({
    signerId: getAddress(VAULT),
    intents: [{ intent: 'transfer', receiver_id: getAddress(ALLOWANCE), tokens: { [USDC]: '100000000' } }],
    deadlineMs: DEADLINE,
    salt: SALT,
    random: RANDOM,
  });
  const nonce = decodeNonce(JSON.parse(payload).nonce)!;
  assert.equal(
    payload,
    `{"signer_id":"${VAULT}","verifying_contract":"intents.near","deadline":"2026-10-04T18:57:00.839Z","nonce":"${JSON.parse(payload).nonce}","intents":[{"intent":"transfer","receiver_id":"${ALLOWANCE}","tokens":{"${USDC}":"100000000"}}]}`,
  );
  assert.deepEqual([...nonce.salt], [...SALT]);
  assert.equal(nonce.deadlineMs, DEADLINE + NONCE_LIFE_AFTER_DEADLINE_MS);
  assert.deepEqual([...nonce.random], [...RANDOM()]);
  assert.deepEqual(readVaultPayload(payload).intents, [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [USDC]: '100000000' } }]);
  // Two payloads built a moment apart never share a nonce.
  const one = buildVaultPayload({ signerId: VAULT, intents: [], deadlineMs: DEADLINE, salt: SALT });
  const two = buildVaultPayload({ signerId: VAULT, intents: [], deadlineMs: DEADLINE, salt: SALT });
  assert.notEqual(JSON.parse(one).nonce, JSON.parse(two).nonce);
});

test('the builder refuses anything a vault would not sign', () => {
  const base = { signerId: VAULT, deadlineMs: DEADLINE, salt: SALT, random: RANDOM };
  const transfer = (over: Record<string, unknown>) => ({ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [USDC]: '5' }, ...over }) as unknown as VaultIntent;
  const cases: Array<[string, Partial<Parameters<typeof buildVaultPayload>[0]>, RegExp]> = [
    ['an intent a vault never signs', { intents: [{ intent: 'token_diff', diff: {} } as unknown as VaultIntent] }, /no token_diff intent/],
    ['auth_call', { intents: [{ intent: 'auth_call' } as unknown as VaultIntent] }, /no auth_call intent/],
    ['a key that is not a key', { intents: [{ intent: 'add_public_key', public_key: 'p256:abc' }] }, /not an ed25519, secp256k1 or p256 key/],
    ['an extra field on a key intent', { intents: [{ intent: 'remove_public_key', public_key: OLD, note: 'x' } as unknown as VaultIntent] }, /carries exactly intent, public_key/],
    ['a flag that is not a boolean', { intents: [{ intent: 'set_auth_by_predecessor_id', enabled: 'false' } as unknown as VaultIntent] }, /enabled true or false/],
    ['a memo', { intents: [transfer({ memo: 'hi' })] }, /carries exactly intent, receiver_id, tokens/],
    ['a msg', { intents: [transfer({ msg: '{}' })] }, /carries exactly intent, receiver_id, tokens/],
    ['two tokens in one transfer', { intents: [transfer({ tokens: { [USDC]: '5', 'nep141:wrap.near': '5' } })] }, /moves one token, got 2/],
    ['no token', { intents: [transfer({ tokens: {} })] }, /moves one token, got 0/],
    ['a zero amount', { intents: [transfer({ tokens: { [USDC]: '0' } })] }, /1 or more/],
    ['a leading zero', { intents: [transfer({ tokens: { [USDC]: '05' } })] }, /no leading zero/],
    ['a decimal amount', { intents: [transfer({ tokens: { [USDC]: '1.5' } })] }, /in digits/],
    ['an amount over u128', { intents: [transfer({ tokens: { [USDC]: (1n << 128n).toString() } })] }, /at most u128/],
    ['an asset that is not a verifier token id', { intents: [transfer({ tokens: { USDC: '5' } })] }, /not a token id inside the verifier/],
    ['an asset id outside printable ASCII', { intents: [transfer({ tokens: { 'nep141:usdc\u00e9.near': '5' } })] }, /not a token id inside the verifier/],
    ['an asset id with a quote in it', { intents: [transfer({ tokens: { 'nep141:a"b.near': '5' } })] }, /not a token id inside the verifier/],
    ['a transfer to the signer', { intents: [transfer({ receiver_id: VAULT })] }, /moves nothing/],
    ['a receiver that is not an account', { intents: [transfer({ receiver_id: 'Not An Account' })] }, /transfer receiver is unusable/],
    ['a signer that is not an account', { signerId: '0x12', intents: [] }, /signer is unusable/],
    ['a deadline that is not whole milliseconds', { intents: [], deadlineMs: DEADLINE + 0.5 }, /whole milliseconds/],
    ['a salt of the wrong size', { intents: [], salt: Uint8Array.from([1, 2, 3]) }, /salt is 4 bytes/],
  ];
  for (const [why, over, message] of cases) {
    assert.throws(() => buildVaultPayload({ ...base, intents: [], ...over }), message, why);
  }
});

test('a payload read back as the verifier will read it, refused on every shape a vault never builds', () => {
  const good = buildVaultPayload({ signerId: VAULT, intents: [{ intent: 'remove_public_key', public_key: OLD }], deadlineMs: DEADLINE, salt: SALT, random: RANDOM });
  const o = JSON.parse(good) as Record<string, unknown>;
  const text = (over: Record<string, unknown>) => JSON.stringify({ ...o, ...over });
  const legacy = Buffer.alloc(32, 7).toString('base64');
  const later = JSON.parse(buildVaultPayload({ signerId: VAULT, intents: [], deadlineMs: DEADLINE + 1, salt: SALT, random: RANDOM })).nonce;
  const withPayload = buildNonce({ salt: SALT, deadlineMs: DEADLINE, random: RANDOM() });
  const cases: Array<[string, unknown, RegExp]> = [
    ['a duplicated key', good.replace('"intents":', '"intents":[],"intents":'), /names intents twice/],
    ['another contract', text({ verifying_contract: 'evil.near' }), /not intents.near/],
    ['a key too many', text({ extra: 1 }), /carries exactly signer_id/],
    ['a checksummed signer', text({ signer_id: getAddress(VAULT) }), /written lowercase/],
    ['a deadline that is not a time', text({ deadline: 'soon' }), /not a time/],
    ['a legacy nonce', text({ nonce: legacy }), /not a V1 nonce/],
    ['a nonce that lives a millisecond longer than seven days past the payload', text({ nonce: later }), /does not live exactly seven days past the payload deadline/],
    ['a nonce that expires with the payload, as before the seven-day rule', text({ nonce: withPayload }), /does not live exactly seven days past the payload deadline/],
    ['a checksummed receiver', text({ intents: [{ intent: 'transfer', receiver_id: getAddress(ALLOWANCE), tokens: { [USDC]: '1' } }] }), /receiver is written lowercase/],
    ['not JSON', '{', /not JSON/],
    ['not a string', { intents: [] }, /not a JSON string/],
  ];
  for (const [why, raw, message] of cases) assert.throws(() => readVaultPayload(raw), message, why);
  assert.equal(readVaultPayload(good).signer_id, VAULT);
});

test('intent hashes are what intents_executed names each recorded payload by, in both standards', () => {
  let named = 0;
  for (const { entry } of ACCEPTED) {
    const executed = reported(entry).at(-1)!;
    assert.ok(executed.event === 'intents_executed');
    assert.deepEqual(entry.signed.map(signedIntentHash), executed.data.map((e) => e.intent_hash));
    named += entry.signed.length;
  }
  assert.ok(named >= 50);
  assert.throws(() => signedIntentHash({ standard: 'nep413', payload: '{}' }), /webauthn or erc191/);
});

test('expectedEvents matches what the verifier reported for every recorded bundle, exactly', () => {
  for (const { run, name, entry } of ACCEPTED) {
    assert.equal(eventsMismatch(reported(entry), expectedEvents(entry.signed, before(name))), null, `${run} ${name}`);
  }
  // T10p.again: P_a turns the flag off, then RECOVERY sets false again and adds no event.
  const again = expectedEvents(FIXTURE.run2['T10p.again']!.signed, { predecessorAuth: true });
  assert.equal(again.filter((e) => e.event === 'set_auth_by_predecessor_id').length, 1);
  assert.equal(again.length, 5);
  // T10p.chipOn: the chip key's payload turns it back on, which is an event of its own.
  const chipOn = expectedEvents(FIXTURE.run2['T10p.chipOn']!.signed, { predecessorAuth: true });
  assert.deepEqual(chipOn.filter((e) => e.event === 'set_auth_by_predecessor_id').map((e) => e.event === 'set_auth_by_predecessor_id' && e.data.enabled), [false, true]);
});

test('the predecessor event is expected only when the flag read true before, and never guessed', () => {
  const t10p = FIXTURE.run2.T10p!;
  assert.throws(() => expectedEvents(t10p.signed, {}), /read is_auth_by_predecessor_id_enabled before/);
  // A restore runs with the flag already off: the same bundle then expects no predecessor event,
  // and T10p's real report (the flag was on) does not match that expectation.
  const flagOff = expectedEvents(t10p.signed, { predecessorAuth: false });
  assert.deepEqual(flagOff.map((e) => e.event), ['public_key_added', 'public_key_added', 'public_key_removed', 'intents_executed']);
  assert.match(eventsMismatch(reported(t10p), flagOff)!, /^event 4 is set_auth_by_predecessor_id enabled false/);
  // Bundles that never touch the flag need no read.
  assert.doesNotThrow(() => expectedEvents(FIXTURE.run2.T10!.signed, {}));
});

test('one changed, missing or extra event is a mismatch, named in words', () => {
  const t10p = FIXTURE.run2.T10p!;
  const expected = expectedEvents(t10p.signed, { predecessorAuth: true });
  const actual = reported(t10p);
  assert.equal(eventsMismatch(actual, expected), null);

  const swapped = structuredClone(actual);
  const first = swapped[0]!;
  assert.ok(first.event === 'public_key_added');
  first.data.public_key = OLD;
  assert.match(eventsMismatch(swapped, expected)!, /^event 1 is public_key_added secp256k1:41dQd2hd\.\.\.2tNeD1 on 0xbb36a6\.\.\.e20fb9 for intent ASgKWtnP\.\.\.T4xbxP where public_key_added p256:3ipJdQBS\.\.\.tkzVM8 on .* was expected$/);

  const otherAccount = structuredClone(actual);
  const removed = otherAccount[2]!;
  assert.ok(removed.event === 'public_key_removed');
  removed.data.account_id = ALLOWANCE;
  assert.match(eventsMismatch(otherAccount, expected)!, /^event 3 is public_key_removed/);

  // One payload fewer in intents_executed is a different count, refused like any other change.
  const short = structuredClone(actual);
  const executed = short[4]!;
  assert.ok(executed.event === 'intents_executed');
  executed.data.pop();
  assert.match(eventsMismatch(short, expected)!, /^event 5 is intents_executed naming 2 payloads where intents_executed naming 3 payloads was expected$/);

  assert.match(eventsMismatch(actual.slice(0, 4), expected)!, /reported 4 events where 5 were expected; missing: intents_executed naming 3 payloads/);
  const extra: VerifierEvent[] = [...actual, { event: 'other', line: 'EVENT_JSON:{"standard":"nep245","event":"mt_transfer"}' }];
  assert.match(eventsMismatch(extra, expected)!, /reported 6 events where 5 were expected; extra: a log line no vault bundle makes/);
  assert.equal(eventsMismatch(undefined, expected), 'the simulation reported no events');
});

test('a top-up expects one transfer event, and one bundle signs for one account', () => {
  const payload = buildVaultPayload({ signerId: VAULT, intents: [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [USDC]: '5000000' } }], deadlineMs: DEADLINE, salt: SALT, random: RANDOM });
  const signed = { standard: 'webauthn', payload, signature: 'p256:unused' };
  const hash = signedIntentHash(signed);
  assert.deepEqual(expectedEvents([signed], {}), [
    { event: 'transfer', data: [{ intent_hash: hash, account_id: VAULT, receiver_id: ALLOWANCE, tokens: { [USDC]: '5000000' } }] },
    { event: 'intents_executed', data: [{ intent_hash: hash, account_id: VAULT, nonce: JSON.parse(payload).nonce }] },
  ]);
  const elsewhere = buildVaultPayload({ signerId: ALLOWANCE, intents: [], deadlineMs: DEADLINE, salt: SALT, random: RANDOM });
  assert.throws(() => expectedEvents([signed, { standard: 'erc191', payload: elsewhere, signature: 'x' }], {}), /one bundle signs for one account/);
  assert.throws(() => expectedEvents([], {}), /at least one payload/);
});
