// The click that waits for a finger: approve on an enclave wallet goes to awaiting_touch, the
// enclave's answer approves exactly that proposal, and a cancelled dialog puts it back.
//
// The shell is played by hand: the test polls the relay the way src-tauri/src/enclave.rs does
// and answers the way the sidecar does, with a software P-256 key standing in for the enclave
// and the data key sealed under the transport key with the request id as AAD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, Policy, RiskRow } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import type { EnclaveRef } from '../../src/keystore/store.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay, VaultRequest } from '../../src/vault/relay.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

function happyPolicy(): Policy {
  const p = defaultPolicy();
  delete p.composition.minNativeGasUsd.near;
  p.sentences = renderSentences(p);
  return p;
}

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function fakeEnclave(): { ref: EnclaveRef; priv: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    ref: { keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() },
    priv: pair.privateKey,
  };
}

function sealLikeTheSidecar(dek: Buffer, id: string, transport: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
  c.setAAD(Buffer.from(id, 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

/* The shell, by hand: one poll, one answer. `cancel` plays a person pressing Cancel. */
async function playShell(relay: VaultRelay, priv: crypto.KeyObject, transport: Buffer, cancel = false): Promise<VaultRequest> {
  const request = await relay.next(1000);
  assert.ok(request !== null, 'the relay handed the shell a request');
  assert.equal(request.op, 'unwrap');
  if (cancel) {
    relay.answer({ id: request.id, ok: false, error: 'user_cancel', message: 'cancelled' });
    return request;
  }
  const dek = seUnwrapWithSoftwareKey(
    { ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! },
    priv,
    Buffer.from(request.aad!, 'base64'),
  );
  relay.answer({ id: request.id, ok: true, dekSealed: sealLikeTheSidecar(dek, request.id, transport) });
  return request;
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-touch-'));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const cfg: AppConfig = {
    mode: 'demo',
    keysPath,
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
  };
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = createLedger(cfg);
  savePolicy(dataDir, happyPolicy());
  const keystore = createKeystore({ keysPath, kdf: fast });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  keystore.lock();
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, quoter: syntheticQuoter(), signer: stubSigner(), dataDir, vault, keystore });
  return { audit, store, svc, keystore, vault, transport, enclave };
}

test.afterEach(() => {
  useKeystore(null);
});

/* The relay only counts as attached once a poll has been seen, so the first poll is made
   before the click, the way the shell's thread is already running before anyone can click. */
async function attach(h: ReturnType<typeof setup>): Promise<void> {
  assert.equal(await h.vault.next(0), null);
  assert.equal(h.vault.attached(), true);
}

test('a click on an enclave wallet waits for a finger, and the finger approves exactly that proposal', async () => {
  const h = setup();
  await attach(h);
  const big = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 5000 });
  assert.equal(big.status, 'pending', 'a large move waits for a click even while locked: the touch will open the wallet');
  assert.equal(big.verdict.outcome, 'needs_approval');

  const clicked = await h.svc.approve(big.id);
  assert.equal(clicked.status, 'awaiting_touch');
  assert.equal(h.keystore.state(), 'locked', 'nothing is open until the enclave answers');
  assert.equal(h.vault.waiting()?.op, 'unwrap');
  assert.match(h.vault.waiting()?.reason ?? '', /^Approve: Consolidate USDT onto eth/);

  const request = await playShell(h.vault, h.enclave.priv, h.transport);
  assert.equal(request.id, `approve:${big.id}`, 'the request is named after the proposal it approves');
  await h.svc.settle(5000);

  const done = h.store.get(big.id);
  assert.ok(done !== undefined);
  assert.ok(['executed', 'failed', 'executing'].includes(done.status), `the proposal ran after the touch (${done.status})`);
  assert.equal(done.decidedBy, 'human');
  assert.equal(h.keystore.state(), 'unlocked', 'the touch opened the wallet for the session');
  const messages = h.audit.tail(80).map((e) => e.msg);
  assert.ok(messages.some((m) => m.includes('waiting for Touch ID')));
  assert.ok(messages.some((m) => m.includes('with Touch ID')));
});

test('a cancelled dialog puts the proposal back to pending and signs nothing', async () => {
  const h = setup();
  await attach(h);
  const big = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 5000 });
  const clicked = await h.svc.approve(big.id);
  assert.equal(clicked.status, 'awaiting_touch');

  await playShell(h.vault, h.enclave.priv, h.transport, true);
  await h.svc.settle(5000);

  assert.equal(h.store.get(big.id)?.status, 'pending');
  assert.equal(h.keystore.state(), 'locked');
  assert.ok(h.audit.tail(50).some((e) => e.msg.includes('did not complete (user_cancel)')));

  // The click is not lost: approving again asks again.
  const again = await h.svc.approve(big.id);
  assert.equal(again.status, 'awaiting_touch');
  await playShell(h.vault, h.enclave.priv, h.transport);
  await h.svc.settle(5000);
  assert.equal(h.store.get(big.id)?.decidedBy, 'human');
});

test('an open session still asks for the finger on every click-tier move', async () => {
  const h = setup();
  await attach(h);
  // Open the wallet by hand, as a previous touch would have.
  const request0 = h.keystore.enclaveRequest()!;
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request0.ephemeralPublicKey, ciphertext: request0.ciphertext }, h.enclave.priv, Buffer.from(request0.aad, 'base64'));
  assert.deepEqual(h.keystore.unlockWithDataKey(dek), { ok: true });

  const big = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 5000 });
  const clicked = await h.svc.approve(big.id);
  assert.equal(clicked.status, 'awaiting_touch', 'open or shut, a click-tier move gets its own dialog');
  await playShell(h.vault, h.enclave.priv, h.transport);
  await h.svc.settle(5000);
  assert.equal(h.store.get(big.id)?.decidedBy, 'human');
});

test('a second click while the dialog is up is refused, and a click while nothing relays queues the old way', async () => {
  const h = setup();
  await attach(h);
  const big = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 5000 });
  await h.svc.approve(big.id);
  await assert.rejects(h.svc.approve(big.id), /pending/);
  await playShell(h.vault, h.enclave.priv, h.transport, true);
  await h.svc.settle(5000);

  // No shell: the relay goes stale and the click parks as pending_unlock, as it always did.
  const bare = createVaultRelay({ transportKey: null });
  const svc2 = createProposalService({
    ...(h as unknown as { svc: never }),
    cfg: { mode: 'demo', keysPath: h.keystore.path().replace(/keys\.enc\.json$/, 'keys.json'), port: 4177, addresses: { evm: [], solana: [], near: [] }, economicTransferUsd: 10, candleProducts: [], dataDir: path.dirname(path.dirname(h.keystore.path())) },
    audit: h.audit,
    store: h.store,
    ledger: createLedger({ mode: 'demo', keysPath: '', port: 0, addresses: { evm: [], solana: [], near: [] }, economicTransferUsd: 10, candleProducts: [], dataDir: path.dirname(path.dirname(h.keystore.path())) }),
    riskRows,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: path.dirname(path.dirname(h.keystore.path())),
    vault: bare,
    keystore: h.keystore,
  });
  const parked = await svc2.approve(big.id);
  assert.equal(parked.status, 'pending_unlock');
});
