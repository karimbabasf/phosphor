// Freeze binds at the signature, on every path a move takes to a key (re-audit R-L1).
//
// The engine refuses every move once Freeze is on, but a move already past its check ran on: an
// allow-tier move whose simulation was still out when Freeze was pressed executed, and so did a
// move whose rail was reading its quote after a click or a touch, while the confirm said "Nothing
// can move your money until you unfreeze". Now land() reads Freeze again before the executing
// write, and every rail calls the executor's last check (RailHooks.lastCheck) as its last step
// before the key. The rails here sign the way the real ones do: their reads, the last check, the
// key. The runner's half (a plan firing) is in runner-host.test.ts; each real rail's call is in
// its own suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay } from '../../src/vault/relay.ts';
import { loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import type { MovedAssets, Rail, RailResult, WriteDraft } from '../../src/types.ts';
import { landed, makeCtx } from './helpers/proposals.ts';
import { tempDir } from './helpers/tmp.ts';

const SMALL_SWAP = { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '20', minAmountOut: 19.5, by: 'seat' };
const BIG_SWAP = { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '500', minAmountOut: 490, by: 'seat' };
const DEPOSIT_ASSETS: MovedAssets = {
  origin: { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6 },
  destination: { assetId: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8 },
};

// What /api/kill writes.
function freeze(dataDir: string): void {
  const policy = loadPolicy(dataDir)!;
  policy.killSwitch = true;
  policy.sentences = renderSentences(policy);
  savePolicy(dataDir, policy);
}

// A gate a test opens: the rail's quote and balance reads, or a simulation, held open.
function gate(): { wait: Promise<void>; open: () => void; reached: Promise<void>; arrive: () => void } {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return { wait, open, reached, arrive };
}

/* A rail that signs the way every real rail does: it reads (held at `reads` when given), asks the
   executor's last check, and only then signs. `signed` counts signatures. */
function signingRail(kind: WriteDraft['kind'], signed: string[], options: { reads?: ReturnType<typeof gate>; simulation?: ReturnType<typeof gate>; assets?: MovedAssets } = {}): Rail {
  return {
    kind,
    valueUsd: () => 0,
    async simulate() {
      if (options.simulation !== undefined) {
        options.simulation.arrive();
        await options.simulation.wait;
      }
      return { ok: true, summary: 'scripted', ...(options.assets === undefined ? {} : { assets: options.assets }) };
    },
    async execute(_draft, id, hooks): Promise<RailResult> {
      if (options.reads !== undefined) {
        options.reads.arrive();
        await options.reads.wait;
      }
      hooks?.lastCheck?.();
      signed.push(String(id));
      return { ok: true, detail: 'signed', txids: ['0x' + crypto.randomBytes(4).toString('hex')] };
    },
  };
}

test.afterEach(() => useKeystore(null));

test('no click: Freeze pressed while an allow-tier move is simulated refuses it at landing, nothing signed', async () => {
  const signed: string[] = [];
  const simulation = gate();
  const h = makeCtx({ rails: [signingRail('hl_deposit', signed, { simulation, assets: DEPOSIT_ASSETS })], intentsUsdc: 500 });
  const asked = h.svc.proposeHlDeposit({ amount: 20 });
  await simulation.reached;
  freeze(h.dataDir);
  simulation.open();
  const p = await h.svc.settled((await asked).id, 5000);
  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'kill_switch');
  assert.deepEqual(signed, []);
});

test('no click: Freeze pressed while the rail reads its quote stops it at the signature, nothing signed', async () => {
  const signed: string[] = [];
  const reads = gate();
  const h = makeCtx({ rails: [signingRail('swap', signed, { reads })], intentsUsdc: 100_000 });
  const asked = h.svc.proposeSwap(SMALL_SWAP);
  await reads.reached;
  assert.equal(h.store.get((await asked).id)?.decidedBy, 'policy');
  freeze(h.dataDir);
  reads.open();
  const p = await h.svc.settled((await asked).id, 5000);
  assert.equal(p.status, 'failed');
  assert.equal(p.result?.reason, 'kill_switch');
  assert.match(String(p.result?.detail), /Everything is frozen, so nothing was signed/);
  assert.deepEqual(signed, []);
  assert.equal(h.svc.sessionSpentUsd(), 0, 'a move stopped before its signature charges nothing');
});

test('no click, the control: the same move with no Freeze signs once', async () => {
  const signed: string[] = [];
  const reads = gate();
  const h = makeCtx({ rails: [signingRail('swap', signed, { reads })], intentsUsdc: 100_000 });
  const asked = h.svc.proposeSwap(SMALL_SWAP);
  await reads.reached;
  reads.open();
  const p = await h.svc.settled((await asked).id, 5000);
  assert.equal(p.status, 'executed');
  assert.equal(signed.length, 1);
});

test('a click: Freeze pressed while the approved move reads its quote stops it at the signature', async () => {
  const signed: string[] = [];
  const reads = gate();
  const h = makeCtx({ rails: [signingRail('swap', signed, { reads })], intentsUsdc: 100_000 });
  const p = await landed(h, h.svc.proposeSwap(BIG_SWAP));
  assert.equal(p.status, 'pending', 'over the click line');
  const approving = h.svc.approve(p.id);
  await reads.reached;
  assert.equal(h.store.get(p.id)?.decidedBy, 'human');
  freeze(h.dataDir);
  reads.open();
  const after = await h.svc.settled((await approving).id, 5000);
  assert.equal(after.status, 'failed');
  assert.equal(after.result?.reason, 'kill_switch');
  assert.deepEqual(signed, []);
});

test('a click: a policy file that stopped loading while the rail read stops it at the signature too', async () => {
  const signed: string[] = [];
  const reads = gate();
  const h = makeCtx({ rails: [signingRail('swap', signed, { reads })], intentsUsdc: 100_000 });
  const p = await landed(h, h.svc.proposeSwap(BIG_SWAP));
  const approving = h.svc.approve(p.id);
  await reads.reached;
  fs.writeFileSync(path.join(h.dataDir, 'policy.json'), '{ not json');
  reads.open();
  const after = await h.svc.settled((await approving).id, 5000);
  assert.equal(after.status, 'failed');
  assert.equal(after.result?.reason, 'rules_unreadable');
  assert.deepEqual(signed, []);
});

// ---------- Touch ID: the shell is played by hand, as in approve-touch.test.ts ----------

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

async function touch(relay: VaultRelay, priv: crypto.KeyObject, transport: Buffer): Promise<void> {
  const request = await relay.next(1000);
  assert.ok(request !== null, 'the relay handed the shell a dialog');
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! }, priv, Buffer.from(request.aad!, 'base64'));
  relay.answer({ id: request.id, ok: true, dekSealed: seal(dek, request.id, transport) });
}

function enclaveWorld(rail: Rail) {
  const keyDir = tempDir('phosphor-freeze-touch-');
  const keystore = createKeystore({ keysPath: path.join(keyDir, 'keys', 'keys.json'), kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  keystore.lock();
  const h = makeCtx({ rails: [rail], intentsUsdc: 100_000, deps: { vault, keystore } });
  return { h, vault, keystore, enclave, transport };
}

test('Touch ID: Freeze pressed after the touch, while the rail reads its quote, stops it at the signature and the wallet shuts', async () => {
  const signed: string[] = [];
  const reads = gate();
  const { h, vault, keystore, enclave, transport } = enclaveWorld(signingRail('swap', signed, { reads }));
  assert.equal(await vault.next(0), null);
  const p = await landed(h, h.svc.proposeSwap(BIG_SWAP));
  assert.equal((await h.svc.approve(p.id)).status, 'awaiting_touch');
  await touch(vault, enclave.priv, transport);
  await reads.reached; // past the touch's own re-check, the rail is reading: nothing signed yet
  freeze(h.dataDir);
  reads.open();
  await h.svc.settle(5000);
  const after = h.store.get(p.id)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.result?.reason, 'kill_switch');
  assert.deepEqual(signed, []);
  // The touch opened the wallet for this move alone; with the move over, the key goes.
  for (let i = 0; i < 50 && keystore.state() !== 'locked'; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(keystore.state(), 'locked');
});

test('Touch ID, the control: the same touch with no Freeze signs once', async () => {
  const signed: string[] = [];
  const { h, vault, enclave, transport } = enclaveWorld(signingRail('swap', signed));
  assert.equal(await vault.next(0), null);
  const p = await landed(h, h.svc.proposeSwap(BIG_SWAP));
  assert.equal((await h.svc.approve(p.id)).status, 'awaiting_touch');
  await touch(vault, enclave.priv, transport);
  await h.svc.settle(5000);
  assert.equal(h.store.get(p.id)!.status, 'executed');
  assert.equal(signed.length, 1);
});
