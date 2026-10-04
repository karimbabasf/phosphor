// The chip vault's pieces joined the way src/main.ts joins them (PHASE2-PLAN.md, wave 2). Four
// units built them apart: the service's chip ops (U5), the chip signer and its owner key gate (U6),
// the rails switch (U7) and the Hyperliquid owner touch (U8). Here they meet. The owner key gate is
// one function that the keystore and the owner touch both read, so a vault the chain shows moved is
// one Touch ID per owner action whichever of the two asks first.
//
// Real parts wherever a key is involved: the keystore, the relay, the proposal service and the
// withdrawal rail are the app's own; a software P-256 key plays the enclave, the shell is played by
// hand, and every remote is faked. No dialog, nothing signed for real money.
//
// Run: node --test tests/unit/chip-wiring.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { ownerTouchVia } from '../../src/proposals/lifecycle.ts';
import { ownerTouchRequired, useOwnerTouch } from '../../src/rails/hl-user-signed.ts';
import { ownerKeyOut } from '../../src/vault/accounts.ts';
import { ownerKeyGate } from '../../src/vault/chip.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { chipVault, teardown, withdrawWorld } from './helpers/owner-touch.ts';
import { makeCtx } from './helpers/proposals.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [V] = DERIVED_VECTORS;
const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const PAPER = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;

const main = (): string => fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');

function chipPublicKey(): string {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return `p256:${base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))}`;
}

test.afterEach(teardown);

test('src/main.ts hands the Hyperliquid owner touch the keystore\'s own gate, and asks no second one', () => {
  const source = main();
  const gate = source.indexOf('keystore.keepOwnerKeyOutWhen(ownerKeyStaysOut);');
  const touch = source.indexOf('useOwnerTouch(ownerTouchVia({ vault, keystore, ownerOut: ownerKeyStaysOut }));');
  assert.ok(gate > 0 && touch > gate, 'the touch reads the gate the keystore was given');
  assert.equal(source.match(/ownerKeyGate\(/g)?.length, 1, 'one gate');
  assert.ok(!source.includes('ownerKeyOut('), 'vault.json\'s word alone decides nothing in src/main.ts');
});

/* The case the one gate is for: the chain shows the vault moved to its chip, the service's marker
   names the vault, and vault.json's chip entry is gone. The keystore keeps the owner key out on the
   marker, so the owner touch must say the same, or a withdrawal asks for a Touch ID that opens
   nothing before the one that signs. `ownerOut` is what the touch is handed: the gate src/main.ts
   passes, or vault.json's word alone, the predicate it passed before the units met. */
async function withdrawalOnMarker(ownerOut: 'gate' | 'vault.json') {
  const v = chipVault(V.old, { moved: false });
  await v.attach();
  const dir = tempDir('phosphor-chip-wiring-');
  fs.mkdirSync(path.join(dir, 'state'));
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  assert.equal(prefs.get().chip, null, 'vault.json names no chip');

  const chip = chipPublicKey();
  const vault = v.vault.toLowerCase();
  const read = v.relay.ask({ op: 'chipStatus' });
  const request = await v.relay.next(1_000);
  assert.ok(request !== null && request.op === 'chipStatus');
  const marker = { account: vault, allowance: V.allowance.toLowerCase(), recovery: PAPER, at: '2026-10-04T12:00:00.000Z' };
  v.relay.answer({ id: request.id, ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: chip, fresh: false, marker }] });
  assert.ok((await read).ok);

  const chainAsked: string[] = [];
  const gate = ownerKeyGate(() => prefs.get(), v.relay, { hasPublicKey: async (account, key) => (chainAsked.push(key), account === vault && key === chip) });
  v.store.keepOwnerKeyOutWhen(gate);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: ownerOut === 'gate' ? gate : (evm) => ownerKeyOut(prefs.get(), evm) }));
  assert.equal(gate(v.vault), true, 'out while the chain is asked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chainAsked, [chip, PAPER]);
  assert.equal(gate(v.vault), true, 'the chain shows the chip on the vault: out for good');

  const world = withdrawWorld(v.keysPath);
  const h = makeCtx({ rails: [world.rail], deps: { vault: v.relay, keystore: v.store } });
  const proposed = await h.svc.proposeHlWithdraw({ amount: 8 });
  assert.equal(proposed.status, 'pending');
  return { v, world, h, proposed };
}

test('a vault the chain shows moved, with vault.json\'s chip entry gone: a withdrawal asks one Touch ID, the send\'s', async () => {
  const { v, world, h, proposed } = await withdrawalOnMarker('gate');
  assert.equal(ownerTouchRequired(), true, 'the touch reads what the keystore reads');
  const clicked = await h.svc.approve(proposed.id);
  assert.notEqual(clicked.status, 'awaiting_touch', 'the click is the approval');
  const asked = await v.shell.answer();
  assert.equal(asked.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 1, 'one dialog for the whole withdrawal');
  assert.equal(world.posts.length, 1);
  assert.equal(v.store.state(), 'locked', 'and no session was opened');
});

test('the same withdrawal with vault.json\'s word alone handed to the touch asks a Touch ID that opens nothing first', async () => {
  const { v, world, h, proposed } = await withdrawalOnMarker('vault.json');
  assert.equal(ownerTouchRequired(), false, 'vault.json names no chip, so this touch thinks the key is in');
  const clicked = await h.svc.approve(proposed.id);
  assert.equal(clicked.status, 'awaiting_touch');
  const approval = await v.shell.answer();
  assert.ok(approval.id.startsWith('approve:'), 'an approval touch first');
  const send = await v.shell.answer();
  assert.equal(send.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954', 'and the key still signs only behind its own');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 2, 'two dialogs where one does: the mismatch src/main.ts no longer has');
  assert.equal(world.posts.length, 1);
});
