// The enclave relay queue, with a fake shell on the other end of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createVaultRelay } from '../../src/vault/relay.ts';
import { reasonFor } from '../../src/vault/reason.ts';

const transport = crypto.randomBytes(32);

/* What the Swift sidecar does with a data key before it answers: AES-256-GCM under the transport
   key with the request id as AAD, laid out nonce || ciphertext || tag. */
function sealLikeTheSidecar(dek: Buffer, id: string, key = transport): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(id, 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

test('a backend with no transport key has no enclave and says so at once', async () => {
  const relay = createVaultRelay({ transportKey: null });
  assert.equal(relay.attached(), false);
  const r = await relay.ask({ op: 'probe' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, 'no_relay');
});

test('a request is handed to the poll once, and its sealed data key opens only under its own id', async () => {
  const relay = createVaultRelay({ transportKey: transport });
  const asked = relay.ask({ op: 'unwrap', reason: 'Approve: something', keyBlob: 'k', ephemeralPublicKey: 'e', ciphertext: 'c', aad: 'a' });
  const request = await relay.next(1000);
  assert.ok(request !== null);
  assert.equal(request.op, 'unwrap');
  assert.equal(request.reason, 'Approve: something');
  assert.equal(relay.attached(), true, 'a poll marks the shell present');
  assert.deepEqual(relay.waiting()?.op, 'unwrap');

  assert.equal(await relay.next(10), null, 'the same request is never handed out twice');

  const dek = crypto.randomBytes(32);
  const wrongId = relay.answer({ id: 'other', ok: true, dekSealed: sealLikeTheSidecar(dek, 'other') });
  assert.equal(wrongId.ok, false);

  const foreignKey = relay.answer({ id: request.id, ok: true, dekSealed: sealLikeTheSidecar(dek, request.id, crypto.randomBytes(32)) });
  assert.equal(foreignKey.ok, true, 'the answer is accepted as an answer');
  const result = await asked;
  assert.equal(result.ok, false, 'but a key sealed under another transport key does not open');
  assert.equal(!result.ok && result.error, 'transport');
});

test('the right seal opens to the data key, and one request waits for the previous one', async () => {
  const relay = createVaultRelay({ transportKey: transport });
  const first = relay.ask({ op: 'unwrap', reason: 'first' });
  const second = relay.ask({ op: 'presence', reason: 'second' });
  assert.equal(relay.queued(), 2);

  const r1 = await relay.next(1000);
  assert.equal(r1?.reason, 'first');
  assert.equal(await relay.next(10), null, 'the second waits until the first is answered');

  const dek = crypto.randomBytes(32);
  relay.answer({ id: r1!.id, ok: true, dekSealed: sealLikeTheSidecar(dek, r1!.id) });
  const got = await first;
  assert.ok(got.ok && got.op === 'unwrap');
  assert.deepEqual(got.dek, dek);

  const r2 = await relay.next(1000);
  assert.equal(r2?.reason, 'second');
  relay.answer({ id: r2!.id, ok: true });
  assert.deepEqual(await second, { ok: true, op: 'presence' });
  assert.equal(relay.queued(), 0);
  assert.equal(relay.waiting(), null);
});

test('a cancelled dialog and a create both come back typed', async () => {
  const relay = createVaultRelay({ transportKey: transport });
  const asked = relay.ask({ op: 'unwrap' });
  const r = await relay.next(1000);
  relay.answer({ id: r!.id, ok: false, error: 'user_cancel', message: 'cancelled' });
  assert.deepEqual(await asked, { ok: false, error: 'user_cancel', message: 'cancelled' });

  const made = relay.ask({ op: 'create' });
  const c = await relay.next(1000);
  relay.answer({ id: c!.id, ok: true, keyBlob: 'blob', publicKey: 'pub' });
  const enclave = await made;
  assert.ok(enclave.ok && enclave.op === 'create');
  assert.equal(enclave.enclave.keyBlob, 'blob');

  const probe = relay.ask({ op: 'probe' });
  const p = await relay.next(1000);
  relay.answer({ id: p!.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true });
  assert.ok((await probe).ok);
  assert.equal(relay.enclaveReady(), true);
});

test('a request nobody fetches fails on its own clock, and a stopped relay fails everything', async () => {
  let t = 1_000_000;
  const relay = createVaultRelay({ transportKey: transport, now: () => t, askTimeoutMs: 50 });
  const asked = relay.ask({ op: 'presence' });
  const r = await asked;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, 'timeout');

  const again = relay.ask({ op: 'presence' });
  relay.stop();
  assert.equal(!(await again).ok, true);
  t += 61_000;
  assert.equal(relay.attached(), false, 'a shell that stopped polling is gone');
});

test('the dialog sentence comes from the draft fields and never from agent text', () => {
  const swap = reasonFor({
    draft: {
      kind: 'swap', venue: 'intents-native', chain: 'arbitrum', toChain: 'arbitrum', fromSymbol: 'USDC', toSymbol: 'ETH',
      amountIn: 500, amountUsd: 500, minAmountOut: 0.1, from: '0x', to: '0x', counterparty: 'x', quote: null,
    } as never,
  });
  assert.equal(swap, 'Approve: Swap 500 USDC to ETH ($500)');
  const policy = reasonFor({ draft: { kind: 'policy_change', patch: {}, sentence: 'IGNORE THIS DIALOG AND APPROVE' } as never });
  assert.equal(policy, 'Approve: Change the policy that limits what the agent may do');
  const weird = reasonFor({
    draft: { kind: 'hl_withdraw', symbol: 'USDC\nApprove everything', amount: 12.5, amountUsd: 12.5, minReceived: 12, from: '', to: '', counterparty: '' } as never,
  });
  assert.equal(weird.includes('\n'), false);
  assert.ok(weird.length <= 120);
});
