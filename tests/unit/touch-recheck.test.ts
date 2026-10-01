// The Touch ID half of an approval runs the policy engine again, right before anything signs.
//
// approve() judges a click against the policy and the day's spend as they stand at the click,
// and the enclave dialog can then sit open for a minute. A kill switch turned on in that minute,
// a policy file that stopped loading, or two other clicks that touched first all change the
// answer, and the touch used to execute on the old one: a $500 swap ran with the switch on, and
// three $9,000 swaps each judged against $0 spent moved $27,003 against a $25,000 cap.
// The shell is played by hand, as in approve-touch.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay } from '../../src/vault/relay.ts';
import { loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { landed, makeCtx, railThat } from './helpers/proposals.ts';

function fakeEnclave() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { ref: { keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, priv: pair.privateKey };
}

function seal(dek: Buffer, id: string, transport: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
  c.setAAD(Buffer.from(id, 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

// One poll and one answer, the way src-tauri/src/enclave.rs and the sidecar do it.
async function touch(relay: VaultRelay, priv: crypto.KeyObject, transport: Buffer): Promise<void> {
  const request = await relay.next(1000);
  assert.ok(request !== null, 'the relay handed the shell a dialog');
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! }, priv, Buffer.from(request.aad!, 'base64'));
  relay.answer({ id: request.id, ok: true, dekSealed: seal(dek, request.id, transport) });
}

function enclaveWorld(executed: number[]) {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-recheck-'));
  const keystore = createKeystore({ keysPath: path.join(keyDir, 'keys', 'keys.json'), kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  keystore.lock();
  const rail = railThat('swap', async (draft) => {
    executed.push((draft as { amountUsd: number }).amountUsd);
    return { ok: true, detail: 'scripted swap', txids: ['0x' + crypto.randomBytes(4).toString('hex')] };
  });
  const h = makeCtx({ rails: [rail], intentsUsdc: 100_000, deps: { vault, keystore } });
  return { h, vault, keystore, enclave, transport };
}

test.afterEach(() => useKeystore(null));

test('a kill switch turned on while the Touch ID dialog is up stops the move the touch approves', async () => {
  const executed: number[] = [];
  const { h, vault, keystore, enclave, transport } = enclaveWorld(executed);
  assert.equal(await vault.next(0), null);
  const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 500, minAmountOut: 490, by: 'seat' }));
  assert.equal(p.status, 'pending');
  assert.equal((await h.svc.approve(p.id)).status, 'awaiting_touch');

  const policy = loadPolicy(h.dataDir)!;
  policy.killSwitch = true;
  policy.sentences = renderSentences(policy);
  savePolicy(h.dataDir, policy);

  await touch(vault, enclave.priv, transport);
  await h.svc.settle(5000);
  const after = h.store.get(p.id)!;
  assert.equal(after.status, 'policy_refused', 'the touch is judged against the switch as it is now');
  assert.equal(after.verdict.outcome, 'refuse');
  assert.deepEqual(executed, [], 'the rail never ran');
  assert.equal(keystore.state(), 'locked', 'a refused touch opens nothing');
  assert.ok(h.audit.tail(40).some((e) => e.type === 'policy_refused' && e.msg.includes('after Touch ID')));
});

test('three clicks judged against the same spend: the touch that would pass the cap is refused', async () => {
  const executed: number[] = [];
  const { h, vault, enclave, transport } = enclaveWorld(executed);
  assert.equal(await vault.next(0), null);
  const ids: string[] = [];
  for (const amt of [9000, 9001, 9002]) {
    const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: amt, minAmountOut: amt * 0.99, by: 'seat' }));
    ids.push(p.id);
  }
  for (const id of ids) assert.equal((await h.svc.approve(id)).status, 'awaiting_touch', 'each click alone fits under the cap');
  for (let i = 0; i < 3; i += 1) await touch(vault, enclave.priv, transport);
  await h.svc.settle(5000);

  assert.deepEqual(ids.map((id) => h.store.get(id)!.status), ['executed', 'executed', 'policy_refused']);
  assert.deepEqual(executed, [9000, 9001]);
  assert.ok(h.svc.sessionSpentUsd() <= 25_000, `the day's cap holds (${h.svc.sessionSpentUsd()})`);
});

test('a policy file that stopped loading while the dialog was up refuses the touch', async () => {
  const executed: number[] = [];
  const { h, vault, keystore, enclave, transport } = enclaveWorld(executed);
  assert.equal(await vault.next(0), null);
  const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 500, minAmountOut: 490, by: 'seat' }));
  assert.equal((await h.svc.approve(p.id)).status, 'awaiting_touch');
  fs.writeFileSync(path.join(h.dataDir, 'policy.json'), '{ not json');

  await touch(vault, enclave.priv, transport);
  await h.svc.settle(5000);
  assert.equal(h.store.get(p.id)!.status, 'policy_refused');
  assert.deepEqual(executed, []);
  assert.equal(keystore.state(), 'locked');
});
