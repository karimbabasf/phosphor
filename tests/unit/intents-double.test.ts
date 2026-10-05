// The chain double (tests/unit/helpers/intents-double.ts) is only worth what it agrees with the real
// verifier. So it is held to the 32 bundles intents.near 0.4.4 simulated live on 2026-10-04
// (tests/fixtures/verifier/simulate-0.4.4.json, spike2's two runs, real Secure Enclave signatures):
// every accepted bundle gives the very events the verifier reported, and every refused one is
// refused with the verifier's own words. Then its own rules, one each: the nonce and deadline
// refusals in the verifier's order, a call that runs whole or not at all, reads at an older block,
// the relay running a bundle once and in order, and the RPC running the same bytes once however
// often they are sent.
//
// Run: node --test tests/unit/intents-double.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import { implicitAccountOf, transferAll } from '../../src/chain/near-tx.ts';
import type { MultiPayload } from '../../src/relay/client.ts';
import { erc191SignatureField } from '../../src/intents-sign.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { simulationOf, simulationRefusal } from '../../src/relay/verifier.ts';
import type { SignedIntent } from '../../src/relay/verifier.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';

type Recorded = { spike: string; signed: SignedIntent[]; rpcBody: { result: { result?: number[]; error?: string } } };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/verifier/simulate-0.4.4.json', import.meta.url), 'utf8')) as Record<'run1' | 'run2', Record<string, Recorded>>;
const ALL = (['run1', 'run2'] as const).flatMap((run) => Object.entries(FIXTURE[run]).map(([name, entry]) => ({ run, name, entry })));
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

async function erc191(key: `0x${string}`, payload: string): Promise<MultiPayload> {
  return { standard: 'erc191', payload, signature: erc191SignatureField(await privateKeyToAccount(key).signMessage({ message: payload })) };
}

test('the double gives every recorded 0.4.4 answer: the same events for the 16 accepted bundles, the same words for the 16 refused', async () => {
  let accepted = 0;
  let refused = 0;
  for (const { run, name, entry } of ALL) {
    const deadlines = entry.signed.map((s) => Date.parse((JSON.parse(s.payload) as { deadline: string }).deadline));
    const double = createIntentsDouble({ start: Math.min(...deadlines) - 30_000 });
    const got = (await double.verifier.simulate(entry.signed))!;
    const recorded = entry.rpcBody.result;
    if (recorded.result !== undefined) {
      const want = simulationOf(JSON.parse(Buffer.from(Uint8Array.from(recorded.result)).toString('utf8')), entry.signed.length);
      assert.deepEqual(got, want, `${run} ${name}`);
      accepted += 1;
    } else {
      if (got.ok) assert.fail(`${run} ${name} was refused live`);
      assert.equal(got.refusal, simulationRefusal(recorded.error), `${run} ${name}`);
      refused += 1;
    }
  }
  assert.deepEqual([accepted, refused], [16, 16]);
});

test('the verifier\'s refusals for a payload, in its words: the deadline, the salt, a nonce that dies first, the contract, the key, a nonce used twice', async () => {
  const double = createIntentsDouble();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key).address.toLowerCase();
  const deadlineMs = double.now() + 60_000;
  const nonceOf = (over: { salt?: Uint8Array; deadlineMs?: number }) => buildNonce({ salt: over.salt ?? SALT, deadlineMs: over.deadlineMs ?? deadlineMs + NONCE_LIFE_AFTER_DEADLINE_MS, random: Uint8Array.from(crypto.randomBytes(15)) });
  const payload = (over: Record<string, unknown>) => JSON.stringify({ signer_id: account, verifying_contract: 'intents.near', deadline: new Date(deadlineMs).toISOString(), nonce: nonceOf({}), intents: [], ...over });
  const cases: [string, string, string][] = [
    ['a payload past its deadline', payload({ deadline: new Date(double.now() - 1).toISOString() }), 'deadline has expired'],
    ['a salt the verifier does not take', payload({ nonce: nonceOf({ salt: Uint8Array.from([1, 2, 3, 4]) }) }), 'invalid salt'],
    ['a nonce that expires before its payload', payload({ nonce: nonceOf({ deadlineMs: deadlineMs - 1 }) }), 'deadline is greater than nonce'],
    ['another contract', payload({ verifying_contract: 'evil.near' }), 'wrong verifying_contract'],
  ];
  for (const [what, text, words] of cases) {
    const sim = (await double.verifier.simulate([await erc191(key, text)]))!;
    assert.equal(sim.ok ? 'accepted' : sim.refusal, words, what);
  }
  // A key that is not the account's own.
  const stranger = generatePrivateKey();
  const sim = (await double.verifier.simulate([await erc191(stranger, payload({}))]))!;
  assert.match(sim.ok ? 'accepted' : sim.refusal, /^public key 'secp256k1:.*' doesn't exist for account '0x/);
  // A nonce spent once is refused the second time, in the same call or a later one.
  const once = await erc191(key, payload({}));
  const twice = (await double.verifier.simulate([once, once]))!;
  assert.equal(twice.ok ? 'accepted' : twice.refusal, 'nonce was already used');
});

test('one call runs whole or not at all, and a read at an older block shows that block', async () => {
  const double = createIntentsDouble();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key).address.toLowerCase();
  const receiver = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  double.fund(account, USDC, 10n);
  const before = await double.verifier.finalBlock();
  const deadlineMs = double.now() + 60_000;
  const move = (amount: string) => buildVaultPayload({ signerId: account, intents: [{ intent: 'transfer', receiver_id: receiver, tokens: { [USDC]: amount } }], deadlineMs, salt: SALT });
  const ran = await double.runAsStranger([await erc191(key, move('4')), await erc191(key, move('7'))]);
  assert.deepEqual(ran, { ok: false, panic: 'insufficient balance or overflow' });
  assert.equal(double.balanceOf(account, USDC), 10n, 'the first transfer did not stay');
  assert.equal((await double.runAsStranger([await erc191(key, move('4'))])).ok, true);
  assert.equal(double.balanceOf(receiver, USDC), 4n);
  assert.equal(await double.verifier.balance(receiver, USDC, before!.hash), 0n);
  assert.equal(await double.verifier.balance(receiver, USDC), 4n);
});

test('the relay refuses what the verifier would, runs a bundle once in one call, and says SETTLED with that call\'s hash', async () => {
  const double = createIntentsDouble();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key).address.toLowerCase();
  const p256 = `p256:${base58Encode(Buffer.alloc(64, 2))}`;
  const deadlineMs = double.now() + 60_000;
  const signed = [
    await erc191(key, buildVaultPayload({ signerId: account, intents: [{ intent: 'add_public_key', public_key: p256 }], deadlineMs, salt: SALT })),
    await erc191(key, buildVaultPayload({ signerId: account, intents: [], deadlineMs, salt: SALT })),
  ];
  const ok = await double.relay.publishIntents(signed);
  assert.ok(ok.status === 'OK' && ok.intentHashes.length === 2);
  assert.equal(double.executions(), 1);
  assert.equal(double.hasKey(account, p256), true);
  const [first, second] = await Promise.all(ok.intentHashes.map((h) => double.relay.status(h)));
  assert.ok(first!.status === 'SETTLED' && first!.nearTxHash !== null && first!.nearTxHash === second!.nearTxHash, 'one call carried both');
  // The same bundle again: its nonces are spent, so the relay refuses it and nothing runs twice.
  const again = await double.relay.publishIntents(signed);
  assert.ok(again.status === 'FAILED' && /nonce was already used/.test(again.reason), JSON.stringify(again));
  assert.equal(double.executions(), 1);
  // A bundle the relay never saw has no word but NOT_FOUND_OR_NOT_VALID.
  assert.equal((await double.relay.status('H5kqrmnzGJxhW1YGFWS17ukfPgxBmWYp6xd81FrhhrGx')).status, 'NOT_FOUND_OR_NOT_VALID');
});

test('the RPC checks the account key\'s signature on a transfer and runs the same bytes once, however often they are sent', async () => {
  const double = createIntentsDouble();
  const seed = Uint8Array.from(crypto.randomBytes(32));
  const from = implicitAccountOf(seed).accountId;
  double.fundGas(from, 500_000_000_000_000_000_000_000n);
  const to = 'e'.repeat(64);
  // Every answer lost after the copy ran: near-tx keeps sending the identical bytes.
  double.sends.push({ kind: 'lost', land: true }, { kind: 'lost', land: false }, { kind: 'ok' });
  const outcome = await transferAll({ seed, receiverId: to, keep: 3n * 10n ** 21n, least: 10n ** 22n }, double.near);
  assert.equal(outcome.status, 'executed');
  assert.equal(double.executions(), 1);
  assert.ok(double.sendCount() >= 3);
  assert.equal(double.nearReceived(to), outcome.amount);
  assert.equal(outcome.amount, 497n * 10n ** 21n);
  // The same bytes with one bit of the account key's signature changed are refused as a bad signature.
  const sentBytes = Buffer.from(String(double.calls.find((c) => c.method === 'send_tx')!.params.signed_tx_base64), 'base64');
  sentBytes[sentBytes.length - 1]! ^= 1;
  const res = await double.near.fetchImpl(double.near.rpcUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'send_tx', params: { signed_tx_base64: sentBytes.toString('base64'), wait_until: 'FINAL' } }) });
  const body = (await res.json()) as { error?: { cause?: { name?: string }; data?: unknown } };
  assert.equal(body.error?.cause?.name, 'INVALID_TRANSACTION');
  assert.deepEqual(body.error?.data, { TxExecutionError: { InvalidTxError: 'InvalidSignature' } });
  assert.equal(double.executions(), 1);
});
