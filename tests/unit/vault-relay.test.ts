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

test('the relay secret is checked in constant time and a missing secret admits nobody', () => {
  const relay = createVaultRelay({ transportKey: transport, secret: 'a'.repeat(64) });
  assert.equal(relay.authenticate('a'.repeat(64)), true);
  assert.equal(relay.authenticate('a'.repeat(63) + 'b'), false);
  assert.equal(relay.authenticate(''), false);
  assert.equal(relay.authenticate(undefined), false);
  const bare = createVaultRelay({ transportKey: transport });
  assert.equal(bare.authenticate('anything'), false, 'no secret, no relay routes');
});

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

test('commit, sweep and status come back typed, read strictly, and probe carries the keychain home', async () => {
  const relay = createVaultRelay({ transportKey: transport });
  const answered = async (request: Parameters<typeof relay.ask>[0], body: Record<string, unknown>) => {
    const asked = relay.ask(request);
    const handed = await relay.next(1000);
    assert.equal(handed?.op, request.op);
    relay.answer({ id: handed!.id, ok: true, ...body });
    return { handed: handed!, result: await asked };
  };

  const material = { keyBlob: 'keychain:k', ephemeralPublicKey: 'e', ciphertext: 'c', aad: 'a', addresses: 'd' };
  const committed = await answered({ op: 'commit', ...material }, { keyBlob: 'keychain:k', at: '2026-10-02T00:00:00Z' });
  assert.equal(committed.handed.addresses, 'd', 'the addresses travel with the wrap');
  assert.deepEqual(committed.result, { ok: true, op: 'commit', keyBlob: 'keychain:k', at: '2026-10-02T00:00:00Z' });
  const elsewhere = await answered({ op: 'commit', ...material }, { keyBlob: 'keychain:other' });
  assert.equal(!elsewhere.result.ok && elsewhere.result.error, 'garbled', 'a commit answered for another key is no commit');

  assert.deepEqual((await answered({ op: 'sweep', label: 'run-1' }, { deleted: 2, kept: 1 })).result, { ok: true, op: 'sweep', deleted: 2, kept: 1 });
  assert.deepEqual((await answered({ op: 'sweep' }, { deleted: -4, kept: 'x' })).result, { ok: true, op: 'sweep', deleted: 0, kept: 0 });

  const full = await answered({ op: 'status', ...material }, {
    keychainHome: true, bound: true, key: { present: true, fresh: false }, marker: { at: '2026-10-02T00:00:00Z' }, pinMatches: true,
  });
  assert.deepEqual(full.result, {
    ok: true, op: 'status',
    status: { keychainHome: true, bound: true, key: { present: true, fresh: false }, marker: { at: '2026-10-02T00:00:00Z' }, pinMatches: true },
  });
  const garbled = await answered({ op: 'status' }, { keychainHome: 'yes', bound: 1, key: 'k', marker: [], pinMatches: 'true' });
  assert.deepEqual(garbled.result, {
    ok: true, op: 'status', status: { keychainHome: false, bound: false, key: null, marker: null },
  }, 'anything not plainly true reads as false, so a garbled answer never claims a binding');

  await answered({ op: 'probe' }, { secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome: true });
  assert.equal(relay.capability()?.keychainHome, true);
  await answered({ op: 'probe' }, { secureEnclave: true, biometry: 'touchid', canAuthenticate: true });
  assert.equal(relay.capability()?.keychainHome, false);
});

/* verify-ra1b VRA1B-01: bound() is what the service read off this Mac's markers. A service with no
   keychain home (the development shell's, a copy built without the Developer ID) answers bound: false
   whatever the Mac holds, so that answer never says the Mac keeps no Phosphor-only wallet. */
test('only a status that read the markers tells the relay whether this Mac keeps a Phosphor-only wallet', async () => {
  const relay = createVaultRelay({ transportKey: transport });
  const status = async (body: Record<string, unknown>): Promise<void> => {
    const asked = relay.ask({ op: 'status' });
    const handed = await relay.next(1000);
    relay.answer({ id: handed!.id, ok: true, key: null, marker: null, ...body });
    assert.equal((await asked).ok, true);
  };
  assert.equal(relay.bound(), null, 'nothing said yet');
  await status({ keychainHome: false, bound: false });
  assert.equal(relay.bound(), null, 'a service that cannot read the markers said this Mac keeps none');
  await status({ keychainHome: true, bound: false });
  assert.equal(relay.bound(), false);
  await status({ keychainHome: true, bound: true });
  assert.equal(relay.bound(), true);
  await status({ keychainHome: false, bound: false });
  await status({ keychainHome: true, bound: false });
  assert.equal(relay.bound(), true, 'no op deletes a marker, and no answer takes one back');
  relay.stop();
});

/* A demo's relay (src/main.ts: makesKeys only in live mode). The marker a signed release's commit
   writes is for the whole Mac, so a demo never hands the shell create, commit or sweep, whatever
   the service says it is, and has no enclave to make a wallet with. Reads and Touch IDs pass. */
test('a relay that makes no keys answers create, commit and sweep itself, and the shell never sees one', async () => {
  const material = { keyBlob: 'keychain:k', ephemeralPublicKey: 'e', ciphertext: 'c', aad: 'a', addresses: 'd' };
  const writes = [{ op: 'create' as const }, { op: 'commit' as const, ...material }, { op: 'sweep' as const }, { op: 'sweep' as const, label: 'run-1' }];
  for (const keychainHome of [true, false]) {
    const relay = createVaultRelay({ transportKey: transport, makesKeys: false });
    // Before the service has said what it is, too.
    for (const request of writes) {
      const early = await relay.ask(request);
      assert.deepEqual(early, { ok: false, error: 'no_keychain_home', message: 'a demo makes no Touch ID key and writes nothing to the keychain' }, `${request.op} before the probe`);
    }
    assert.equal(relay.queued(), 0, 'a write reached the queue before the probe');
    const probe = relay.ask({ op: 'probe' });
    const asked = await relay.next(1000);
    relay.answer({ id: asked!.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome });
    assert.equal((await probe).ok, true);
    assert.equal(relay.capability()?.keychainHome, keychainHome);
    assert.equal(relay.enclaveReady(), false, 'a demo was offered a Touch ID wallet');

    for (const request of writes) {
      const refused = await relay.ask(request);
      assert.equal(!refused.ok && refused.error, 'no_keychain_home', request.op);
      assert.equal(relay.queued(), 0, `${request.op} was queued for the shell`);
    }
    assert.equal(await relay.next(30), null, 'the shell was handed a write');

    // Reading still reaches the shell, and comes back typed.
    const status = relay.ask({ op: 'status', ...material });
    const read = await relay.next(1000);
    assert.equal(read?.op, 'status');
    relay.answer({ id: read!.id, ok: true, keychainHome, bound: false, key: null, marker: null });
    assert.deepEqual(await status, { ok: true, op: 'status', status: { keychainHome, bound: false, key: null, marker: null } });
    for (const op of ['unwrap', 'presence'] as const) {
      const pending = relay.ask({ op, ...material, reason: 'x' });
      const handed = await relay.next(1000);
      assert.equal(handed?.op, op);
      relay.answer({ id: handed!.id, ok: false, error: 'user_cancel', message: 'cancelled' });
      await pending;
    }
  }

  // The live app's relay is unchanged: it makes keys.
  const live = createVaultRelay({ transportKey: transport });
  const probe = live.ask({ op: 'probe' });
  const asked = await live.next(1000);
  live.answer({ id: asked!.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome: true });
  await probe;
  assert.equal(live.enclaveReady(), true);
  void live.ask({ op: 'create' });
  assert.equal((await live.next(1000))?.op, 'create');
  live.stop();
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
