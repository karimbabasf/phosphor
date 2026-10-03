// An approval's Touch ID on a locked enclave wallet opens it for that one move.
//
// The touch used to be a full unlock: the dialog named one move, and from then until the idle
// lock every move under the click threshold ran with no click, and the unlock reached every
// listener (src/main.ts re-arms plans on it). Now the wallet stays locked to everything else
// while the approved move signs, nothing is announced, and the key goes with its signature.
// The shell is played by hand, as in approve-touch.test.ts; the rail answers when the test says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import { createKeystore, evmPrivateKey, isLocked, keyHeld, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay } from '../../src/vault/relay.ts';
import type { LockState } from '../../src/keystore/index.ts';
import { makeCtx, slowRail } from './helpers/proposals.ts';
import { tempDir } from './helpers/tmp.ts';

function fakeEnclave() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { ref: { keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, priv: pair.privateKey };
}

async function touch(relay: VaultRelay, priv: crypto.KeyObject, transport: Buffer): Promise<void> {
  const request = await relay.next(1000);
  assert.ok(request !== null, 'the relay handed the shell a dialog');
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! }, priv, Buffer.from(request.aad!, 'base64'));
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
  c.setAAD(Buffer.from(request.id, 'utf8'));
  const sealed = Buffer.concat([nonce, c.update(dek), c.final(), c.getAuthTag()]).toString('base64');
  relay.answer({ id: request.id, ok: true, dekSealed: sealed });
}

async function until(what: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (what()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return what();
}

test.afterEach(() => useKeystore(null));

test('the touch that approves one move opens the wallet for that move alone, and the key goes with its signature', async () => {
  const keyDir = tempDir('phosphor-lease-');
  const keystore = createKeystore({ keysPath: path.join(keyDir, 'keys', 'keys.json'), kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  keystore.lock();
  const heard: LockState[] = [];
  keystore.onChange((state) => heard.push(state));

  const swap = slowRail('swap');
  const h = makeCtx({ rails: [swap.rail], intentsUsdc: 100_000, deps: { vault, keystore } });
  assert.equal(await vault.next(0), null);

  const big = await h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 500, minAmountOut: 490, by: 'seat' });
  assert.equal(big.status, 'pending', 'a click-tier move waits for its click while locked');
  assert.equal((await h.svc.approve(big.id)).status, 'awaiting_touch');
  await touch(vault, enclave.priv, transport);
  await swap.started();

  // The move is on its way to its signature: it can read the key, and nothing else can start.
  assert.equal(h.store.get(big.id)?.status, 'executing');
  assert.equal(keyHeld(), true);
  assert.match(evmPrivateKey('unused'), /^0x[0-9a-f]{64}$/);
  assert.equal(isLocked(), true, 'locked to everything but the move the touch named');
  assert.equal(keystore.state(), 'locked');
  const small = await h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 10, minAmountOut: 9.9, by: 'seat' });
  assert.equal(small.status, 'pending_unlock', 'a small move the agent asks for meanwhile does not run on that touch');
  assert.equal(heard.includes('unlocked'), false, 'no unlock was announced, so no plan re-arms and nothing queued is released');

  // The rail signs and hands its hash to the row: the key goes, while the venue still delivers.
  swap.hooks()?.onEvidence?.({ txids: ['0x' + 'ef'.repeat(32)] });
  assert.ok(await until(() => !keyHeld()), 'the key went with the signature');
  assert.throws(() => evmPrivateKey('unused'), /locked/);
  swap.release({ ok: true, detail: 'delivered', txids: ['0x' + 'ef'.repeat(32)] });
  await h.svc.settle(5000);
  assert.equal(h.store.get(big.id)?.status, 'executed');
  assert.equal(h.store.get(small.id)?.status, 'pending_unlock');
});

test('on an open wallet the touch approves the move and changes nothing else', async () => {
  const keyDir = tempDir('phosphor-lease-');
  const keystore = createKeystore({ keysPath: path.join(keyDir, 'keys', 'keys.json'), kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  const heard: LockState[] = [];
  keystore.onChange((state) => heard.push(state));

  const swap = slowRail('swap');
  const h = makeCtx({ rails: [swap.rail], intentsUsdc: 100_000, deps: { vault, keystore } });
  assert.equal(await vault.next(0), null);
  const big = await h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 500, minAmountOut: 490, by: 'seat' });
  await h.svc.approve(big.id);
  await touch(vault, enclave.priv, transport);
  await swap.started();
  swap.release({ ok: true, detail: 'delivered', txids: ['0x01'] });
  await h.svc.settle(5000);
  assert.equal(h.store.get(big.id)?.status, 'executed');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(keystore.state(), 'unlocked', 'an open wallet stays open');
  assert.deepEqual(heard, [], 'and nothing was announced');
});
