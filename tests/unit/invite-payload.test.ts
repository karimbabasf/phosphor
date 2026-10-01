// The payload an invite key signs, the reader that checks it as a stranger would, the relay
// publish with no quote, and the two verifier views the claim adds. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path" and "The claim".

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, keccak256, stringToBytes, hexToBytes } from 'viem';

import { base58Encode } from '../../src/chain/near.ts';
import { INTENTS_USDC_ASSET_ID } from '../../src/rails/hypercore-withdraw.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import type { RelayClient, RelayPublishRequest } from '../../src/relay/client.ts';
import { buildNonce, decodeNonce } from '../../src/relay/payload.ts';
import { liveVerifier, simulationOf, simulationRefusal } from '../../src/relay/verifier.ts';
import {
  CLAIM_DEADLINE_MS,
  INVITE_ASSET_ID,
  MAX_TRANSFERS,
  buildTransfersPayload,
  checkTransfersPayload,
  claimNonce,
  formatUsdc,
  intentHashOf,
  publishWithoutQuote,
  signingDeadline,
  simulationVerdict,
} from '../../src/invite/payload.ts';
import type { TransfersExpectation } from '../../src/invite/payload.ts';

const CODE = '0xbb90cf2a04bcdfe8c2893bd107bba26ef6553157';
const WALLET = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const SALT = Uint8Array.from(Buffer.from('252812b3', 'hex'));
const DEADLINE = '2026-10-01T20:02:00.000Z';
const CHAIN_NOW = Date.parse(DEADLINE) - CLAIM_DEADLINE_MS;
const NONCE = buildNonce({ salt: SALT, deadlineMs: Date.parse(DEADLINE) + NONCE_LIFE_AFTER_DEADLINE_MS, random: new Uint8Array(15).fill(7) });

function claimPayload(over: Partial<Parameters<typeof buildTransfersPayload>[0]> = {}): string {
  return buildTransfersPayload({
    signerId: getAddress(CODE),
    assetId: INVITE_ASSET_ID,
    deadline: DEADLINE,
    nonce: NONCE,
    transfers: [{ receiverId: getAddress(WALLET), amountBase: 5_000_000n }],
    ...over,
  });
}

function expectation(over: Partial<TransfersExpectation> = {}): TransfersExpectation {
  return {
    signerId: CODE,
    assetId: INVITE_ASSET_ID,
    transfers: [{ receiverId: WALLET, amountBase: 5_000_000n }],
    salt: SALT,
    now: CHAIN_NOW,
    maxDeadlineMs: CLAIM_DEADLINE_MS,
    ...over,
  };
}

test('exact bytes for a fixed input: the spec shape, keys in order, ids lowercased', () => {
  assert.equal(
    claimPayload(),
    '{"signer_id":"0xbb90cf2a04bcdfe8c2893bd107bba26ef6553157","verifying_contract":"intents.near",' +
      '"deadline":"2026-10-01T20:02:00.000Z","nonce":"Vij2xgAlKBKzADBdm2im3BgHBwcHBwcHBwcHBwcHBwc=",' +
      '"intents":[{"intent":"transfer","receiver_id":"0x9858effd232b4033e47d90003d41ec34ecaeda94",' +
      '"tokens":{"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":"5000000"}}]}',
  );
  // Checksummed in, lowercase out: the verifier keys an erc191 account by the lowercase address.
  assert.ok(getAddress(CODE) !== CODE);
  assert.deepEqual(checkTransfersPayload(claimPayload(), expectation()), []);
  // The asset is native USDC on NEAR, the same id the HyperCore withdraw rail spends.
  assert.equal(INVITE_ASSET_ID, INTENTS_USDC_ASSET_ID);
});

test('the V1 nonce decodes, carries the salt, and lives seven days past the payload deadline', () => {
  const nonce = claimNonce(SALT, DEADLINE, (n) => new Uint8Array(n).fill(7));
  assert.equal(nonce, NONCE);
  const parts = decodeNonce(nonce);
  assert.ok(parts !== null);
  assert.deepEqual([...parts.salt], [...SALT]);
  assert.equal(parts.deadlineMs, Date.parse(DEADLINE) + NONCE_LIFE_AFTER_DEADLINE_MS);
  assert.equal(NONCE_LIFE_AFTER_DEADLINE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(DEADLINE) <= parts.deadlineMs, 'the payload deadline is no later than the nonce deadline');
  // A nonce that dies with the intent is refused: a reconcile after a crash could not ask about it.
  const short = buildNonce({ salt: SALT, deadlineMs: Date.parse(DEADLINE), random: new Uint8Array(15).fill(7) });
  assert.match(checkTransfersPayload(claimPayload({ nonce: short }), expectation())[0] ?? '', /seven days/);
});

test("the deadline is the chain's clock plus two minutes, whatever this Mac's clock says", () => {
  assert.equal(signingDeadline(CHAIN_NOW), DEADLINE);
  // A Mac ten minutes slow builds the same deadline: the clock is an input, never Date.now().
  const realNow = Date.now;
  Date.now = () => CHAIN_NOW - 10 * 60_000;
  try {
    assert.equal(signingDeadline(CHAIN_NOW), DEADLINE);
  } finally {
    Date.now = realNow;
  }
  assert.throws(() => signingDeadline(Number.NaN));
  // Judged against the chain's time: passed, and too far out, both refused.
  assert.match(checkTransfersPayload(claimPayload(), expectation({ now: Date.parse(DEADLINE) }))[0] ?? '', /already passed/);
  assert.match(checkTransfersPayload(claimPayload(), expectation({ now: CHAIN_NOW - 60_000 }))[0] ?? '', /more than 120 s/);
});

test('a receiver equal to the signing account is refused, by the builder and by the reader', () => {
  assert.throws(() => claimPayload({ transfers: [{ receiverId: CODE, amountBase: 5_000_000n }] }), /moves nothing/);
  const forged = claimPayload().replace(WALLET, CODE);
  assert.match(checkTransfersPayload(forged, expectation({ transfers: [{ receiverId: CODE, amountBase: 5_000_000n }] }))[0] ?? '', /signing account/);
});

test('the reader refuses every way the string could say something else', () => {
  const good = claimPayload();
  const body = JSON.parse(good) as Record<string, unknown>;
  const cases: Array<[string, string, RegExp]> = [
    ['another contract', JSON.stringify({ ...body, verifying_contract: 'evil.near' }), /verifying contract/],
    ['another signer', JSON.stringify({ ...body, signer_id: WALLET }), /authored for/],
    ['a memo', JSON.stringify({ ...body, intents: [{ ...(body.intents as object[])[0], memo: 'x' }] }), /memo/],
    ['a msg', JSON.stringify({ ...body, intents: [{ ...(body.intents as object[])[0], msg: '{}' }] }), /msg/],
    ['a second transfer', JSON.stringify({ ...body, intents: [...(body.intents as object[]), (body.intents as object[])[0]] }), /2 intents/],
    ['a stray key', JSON.stringify({ ...body, referral: 'x' }), /referral/],
    ['another receiver', good.replace(WALLET, '0x1111111111111111111111111111111111111111'), /pays 0x1111/],
    ['another amount', good.replace('"5000000"', '"5000001"'), /5000001/],
    ['another asset', good.replace(INVITE_ASSET_ID, 'nep141:wrap.near'), /does not move exactly/],
    ['a duplicate key', good.replace('"signer_id":', '"signer_id":"0x1","signer_id":'), /twice/],
    ['a legacy nonce', JSON.stringify({ ...body, nonce: Buffer.alloc(32, 9).toString('base64') }), /versioned nonce/],
    ['another salt', JSON.stringify({ ...body, nonce: buildNonce({ salt: Uint8Array.from([1, 2, 3, 4]), deadlineMs: Date.parse(DEADLINE) + NONCE_LIFE_AFTER_DEADLINE_MS, random: new Uint8Array(15) }) }), /salt/],
    ['not JSON', '{', /not valid JSON/],
  ];
  for (const [name, raw, why] of cases) {
    const problems = checkTransfersPayload(raw, expectation());
    assert.equal(problems.length, 1, `${name} was not refused`);
    assert.match(problems[0]!, why, `${name}: ${problems[0]}`);
  }
});

test('one payload carries at most ten transfers, the operator batch', () => {
  const legs = Array.from({ length: MAX_TRANSFERS }, (_, i) => ({ receiverId: `0x${(i + 1).toString(16).padStart(40, '0')}`, amountBase: 5_000_000n }));
  const batch = buildTransfersPayload({ signerId: CODE, assetId: INVITE_ASSET_ID, deadline: DEADLINE, nonce: NONCE, transfers: legs });
  assert.deepEqual(checkTransfersPayload(batch, expectation({ transfers: legs })), []);
  assert.throws(() => buildTransfersPayload({ signerId: CODE, assetId: INVITE_ASSET_ID, deadline: DEADLINE, nonce: NONCE, transfers: [...legs, legs[0]!] }), /at most 10/);
  assert.throws(() => buildTransfersPayload({ signerId: CODE, assetId: INVITE_ASSET_ID, deadline: DEADLINE, nonce: NONCE, transfers: [] }), /moves nothing/);
  assert.throws(() => claimPayload({ transfers: [{ receiverId: WALLET, amountBase: 0n }] }), /positive/);
});

test('the intent hash is base58 of the EIP-191 hash, worked out here by hand', () => {
  const payload = claimPayload();
  const prefixed = `\x19Ethereum Signed Message:\n${stringToBytes(payload).length}${payload}`;
  assert.equal(intentHashOf(payload), base58Encode(hexToBytes(keccak256(stringToBytes(prefixed)))));
  assert.equal(intentHashOf(payload), 'CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd');
});

test('the relay publish carries an empty quote_hashes and resends identical bytes once on no reply', async () => {
  const sent: RelayPublishRequest[] = [];
  let calls = 0;
  const relay: RelayClient = {
    quote: async () => [],
    status: async () => {
      throw new Error('unused');
    },
    async publishIntent(req) {
      sent.push(req);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return { status: 'OK', intentHash: 'CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd' };
    },
  };
  const signed = { payload: claimPayload(), signature: 'secp256k1:SIG' };
  const answer = await publishWithoutQuote(relay, signed);
  assert.equal(answer.answered, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { quoteHashes: [], standard: 'erc191', payload: signed.payload, signature: signed.signature });
  assert.deepEqual(sent[1], sent[0], 'the resend is the same bytes');

  // An answered error is not resent: the relay answered, and the answer may mean it took it.
  const refusing: RelayClient = { ...relay, publishIntent: async (req) => { sent.push(req); throw new Error('relay publish_intent failed: 401'); } };
  sent.length = 0;
  const refused = await publishWithoutQuote(refusing, signed);
  assert.equal(refused.answered, false);
  assert.equal(sent.length, 1);
});

test("simulate refusals read as the contract's own words, then as a verdict", () => {
  // The three answers read live on 2026-10-01 from simulate_intents with a throwaway key.
  const live = {
    empty: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "insufficient balance or overflow" })',
    expired: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "deadline has expired" })',
    badSig: 'wasm execution failed with error: HostError(ECRecoverError { msg: "V recovery byte 0 through 3 are valid but was provided 192" })',
  };
  assert.equal(simulationRefusal(live.empty), 'insufficient balance or overflow');
  assert.equal(simulationRefusal(live.expired), 'deadline has expired');
  assert.equal(simulationRefusal(live.badSig), 'V recovery byte 0 through 3 are valid but was provided 192');
  assert.equal(simulationVerdict(simulationRefusal(live.empty)), 'empty');
  assert.equal(simulationVerdict(simulationRefusal(live.expired)), 'expired');
  assert.equal(simulationVerdict(simulationRefusal(live.badSig)), 'refused');
  assert.equal(simulationVerdict('account 0xab is locked'), 'locked');
  assert.equal(simulationVerdict('block height exceeded'), 'refused', 'a block is not a lock');
  // A run that executes names each intent by its hash; an unbalanced one is a refusal.
  const ran = simulationOf({ intents_executed: [{ intent_hash: 'CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd', account_id: CODE, nonce: NONCE }], logs: [], state: {} });
  assert.deepEqual(ran, { ok: true, intentHashes: ['CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd'] });
  assert.equal(simulationOf({ intents_executed: [], invariant_violated: { unmatched_deltas: {} } }).ok, false);
});

test('the live verifier asks simulate_intents and is_account_locked the way the contract reads them', async () => {
  const asked: Array<{ method: string; args: unknown }> = [];
  let answer: unknown = null;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { params: { method_name: string; args_base64: string } };
    asked.push({ method: body.params.method_name, args: JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8')) });
    return { ok: true, json: async () => answer } as unknown as Response;
  }) as unknown as typeof fetch;
  const verifier = liveVerifier(fetchImpl);
  const signed = { standard: 'erc191', payload: claimPayload(), signature: 'secp256k1:SIG' };

  answer = { result: { block_hash: 'x', block_height: 1, logs: [], error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "insufficient balance or overflow" })' } };
  assert.deepEqual(await verifier.simulate!([signed]), { ok: false, refusal: 'insufficient balance or overflow' });
  assert.deepEqual(asked[0], { method: 'simulate_intents', args: { signed: [signed] } });

  answer = { result: { result: [...Buffer.from(JSON.stringify({ intents_executed: [{ intent_hash: 'CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd' }] }))], logs: [] } };
  assert.deepEqual(await verifier.simulate!([signed]), { ok: true, intentHashes: ['CwtgtQGZ7x2UFBzCRMvDf9oBCnrKnmpVwHzXtfhg9hBd'] });

  answer = { error: { name: 'HANDLER_ERROR' } };
  assert.equal(await verifier.simulate!([signed]), null, 'an RPC that did not run the call is no answer');

  answer = { result: { result: [...Buffer.from('false')], logs: [] } };
  assert.equal(await verifier.accountLocked!(getAddress(CODE)), false);
  assert.deepEqual(asked[asked.length - 1], { method: 'is_account_locked', args: { account_id: CODE } });
  answer = { result: { result: [...Buffer.from('true')], logs: [] } };
  assert.equal(await verifier.accountLocked!(CODE), true);
  answer = { result: { result: [...Buffer.from('"yes"')], logs: [] } };
  assert.equal(await verifier.accountLocked!(CODE), null);
});

test('dollars are printed rounded down to the cent', () => {
  assert.equal(formatUsdc(5_000_000n), '5.00');
  assert.equal(formatUsdc(100_000n), '0.10');
  assert.equal(formatUsdc(4_987_500n), '4.98');
  assert.equal(formatUsdc(10_009_999n), '10.00');
  assert.equal(formatUsdc(0n), '0.00');
});
