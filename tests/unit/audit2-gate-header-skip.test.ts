// audit2 AU2-02: a forged wallet header plus an unreadable vault.json chip entry never turns one
// honest owner Touch ID into a withdrawal to the forger.
//
// The attack: a same-user process edits two files in the data folder.
//   1. keys.enc.json's plaintext header: addresses.evm -> ATTACKER. The header is outside the
//      payload's AAD (proofAad), so the payload still opens; on an unbound wallet (not Phosphor-only:
//      the service's admit() checks no pin when the Mac has no vault marker) the unwrap still answers.
//   2. vault.json: "chip": {} . prefs reads it as account '' and ownerKeyOut says "out" for every
//      vault, the documented fail-shut.
// After a restart (header never verified this process), the gate is asked about ATTACKER and says
// out, so approve() of hl_withdraw skips the approval touch, and the withdraw rail builds the whole
// move from the header address: from/to, the HL balance read, the 1Click quote recipient. The one
// owner Touch ID then unwraps the real file. The guarantee held here (src/proposals/lifecycle.ts
// ownerTouchVia): inside withOwnerKey, before any signature, a key whose address is not the account
// the move was built for signs nothing, so nothing is posted to the venue and the row says why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { keystorePathFor } from '../../src/keystore/store.ts';
import { ownerTouchVia } from '../../src/proposals/lifecycle.ts';
import { buildSendAssetPayload, ownerTouchRequired, useOwnerTouch } from '../../src/rails/hl-user-signed.ts';
import type { HlSignature } from '../../src/rails/hl-user-signed.ts';
import { ownerKeyGate } from '../../src/vault/chip.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { chipVault, teardown, withdrawWorld } from './helpers/owner-touch.ts';
import { makeCtx } from './helpers/proposals.ts';
import { tempDir } from './helpers/tmp.ts';

const [V] = DERIVED_VECTORS;
const ATTACKER = privateKeyToAccount(generatePrivateKey()).address;

test.afterEach(teardown);

test('a forged header plus an unreadable vault.json chip entry must not turn one owner touch into a withdrawal to the forger', async () => {
  const v = chipVault(V.old);
  await v.attach();
  const VAULT = v.vault;

  // The planted files.
  const file = keystorePathFor(v.keysPath);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.header.addresses.evm = ATTACKER;
  fs.writeFileSync(file, JSON.stringify(stored));
  const dataDir = tempDir('phosphor-audit2-gate-');
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ backedUp: true, chip: {} }));
  const prefs = createVaultPrefs(dataDir);

  // A restart: a new keystore over the same file, wired as src/main.ts wires it.
  const store = createKeystore({ keysPath: v.keysPath });
  const gate = ownerKeyGate(() => prefs.get(), v.relay, { hasPublicKey: async () => false });
  store.keepOwnerKeyOutWhen(gate);
  useKeystore(store);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: store, ownerOut: gate }));

  assert.equal(store.addresses().evm, ATTACKER, 'precondition: the unverified header names the forger');
  assert.equal(ownerTouchRequired(), true, 'precondition: the gate reads "out" for the forged address');

  const world = withdrawWorld(v.keysPath);
  const h = makeCtx({ rails: [world.rail], deps: { vault: v.relay, keystore: store } });
  const proposed = await h.svc.proposeHlWithdraw({ amount: 8 });
  console.log(`proposed: ${proposed.status}`);
  if (proposed.status === 'pending') {
    const clicked = await h.svc.approve(proposed.id);
    assert.notEqual(clicked.status, 'awaiting_touch', 'precondition: no approval touch, so nothing opened the payload first');
  }

  let reason = '';
  try {
    const asked = await v.shell.answer();
    reason = asked.reason ?? '';
  } catch {
    // No owner touch was asked: the secure outcome.
  }
  const done = await h.svc.settled(proposed.id, 5_000);

  const recipients = world.quotes.map((q) => q.recipient);
  let signer = '';
  if (world.posts.length > 0) {
    const post = world.posts[0] as { action: { destination: string; amount: string; nonce: number }; signature: HlSignature };
    const { typedData } = buildSendAssetPayload(post.action);
    signer = (
      await recoverTypedDataAddress({
        domain: typedData.domain,
        types: typedData.types as never,
        primaryType: typedData.primaryType as never,
        message: typedData.message as never,
        signature: { r: post.signature.r, s: post.signature.s, yParity: post.signature.v - 27 },
      } as never)
    ).toLowerCase();
  }
  console.log(
    JSON.stringify({ status: done.status, dialog: reason, quoteRecipients: recipients, attacker: ATTACKER.toLowerCase(), vault: VAULT.toLowerCase(), venueDebits: signer, posts: world.posts.length }),
  );
  assert.equal(world.posts.length, 0, `owner key signed a sendAsset debiting ${signer} for a quote crediting ${recipients.join(',')}`);
  assert.equal(done.status, 'failed');
  const result = (done as { result?: { detail?: string; reason?: string } }).result;
  assert.equal(result?.reason, 'not_sent');
  assert.match(result?.detail ?? '', /^The key Touch ID opened is not the account this move was built for, so nothing was signed\. Unlock your wallet, then try again\./);
});
