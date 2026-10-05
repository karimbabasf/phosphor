// audit2 AU2-04: resumeChip() writes vault.json and lets the owner key go for good only when the
// move reads done, never on two has_public_key reads.
//
// The attack: a lying (or compromised) NEAR RPC, after a move that stopped after the chip commit (a
// cancelled Touch ID leaves a committed chip with a marker for the vault). resumeChip runs on a
// plain /api/state read: no person acts. It used to call the vault moved when the chip and its
// paper read on, and finish() was permanent: vault.json named a chip the vault never took, the
// owner key stayed out of every later session, and a real move answered `already_moved`.
// The rule held here (src/vault/rekey.ts resumeChip): finish() only when all four views agree at
// one block (CHIP on, RECOVERY on, OLD off, predecessor auth off), or when every nonce of the
// bundle this Mac wrote down for that chip reads spent. Anything else is vault_mismatch, and
// nothing is written.
//
// Run: node scripts/run-tests.ts tests/unit/audit2-rekey-resume-weak.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import type { MultiPayload } from '../../src/relay/client.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';
import { CHIP_PAYLOAD_LIFE_MS } from '../../src/vault/chip.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import { verifierKeyOf } from '../../src/vault/phrase24.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { resumeChip, useChipVault } from '../../src/vault/rekey.ts';
import type { RekeyHost } from '../../src/vault/rekey.ts';
import { createVaultSubmitter, memoryJournal } from '../../src/vault/submit.ts';
import { createIntentsDouble } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';

function p256Key(): string {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-64);
  return `p256:${base58Encode(Buffer.from(raw))}`;
}

type Lies = { predecessorOff?: boolean; oldOff?: boolean; spent?: Set<string> };

/* A vault that never moved on the honest chain, a chip of this Mac's committed to it, and an RPC
   that says the chip and the paper are on it (and whatever else `lies` names). `ownerKnown` false:
   nothing this process read names the owner key's public half. `journal`: the bundle this Mac wrote
   down for the chip, as a crash after the send leaves it. */
async function resumeAgainst(lies: Lies, opts: { ownerKnown?: boolean; journal?: boolean; plantedOld?: boolean } = {}) {
  const double = createIntentsDouble();
  const ownerHex = generatePrivateKey();
  const vault = privateKeyToAccount(ownerHex).address.toLowerCase();
  const old = verifierKeyOf(Buffer.from(ownerHex.slice(2), 'hex'));
  const chip = p256Key();
  const recovery = verifierKeyOf(Buffer.from(generatePrivateKey().slice(2), 'hex'));
  const allowance = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const keyRef = `chip:com.karimbabasf.phosphor.chip.${crypto.randomUUID().toUpperCase()}`;

  // The honest chain: the vault never moved (OLD on, predecessor auth on, no chip, no paper).
  assert.equal(await double.verifier.hasPublicKey!(vault, chip), false);
  assert.equal(await double.verifier.isAuthByPredecessorIdEnabled!(vault), true);
  const lying: VerifierPort = {
    ...double.verifier,
    hasPublicKey: (account, key, at) =>
      key === chip || key === recovery ? Promise.resolve(true) : key === old && lies.oldOff === true ? Promise.resolve(false) : double.verifier.hasPublicKey!(account, key, at),
    isAuthByPredecessorIdEnabled: (account, at) => (lies.predecessorOff === true ? Promise.resolve(false) : double.verifier.isAuthByPredecessorIdEnabled!(account, at)),
    nonceUsed: (account, nonce, at) => (lies.spent?.has(nonce) === true ? Promise.resolve(true) : double.verifier.nonceUsed(account, nonce, at)),
  };

  const journal = memoryJournal();
  if (opts.journal === true) {
    const salt = (await double.verifier.currentSalt())!;
    const payload = (intents: Parameters<typeof buildVaultPayload>[0]['intents']) => buildVaultPayload({ signerId: vault, intents, deadlineMs: double.now() + CHIP_PAYLOAD_LIFE_MS, salt });
    const signed = [payload([{ intent: 'remove_public_key', public_key: old }]), payload([]), payload([])].map((p) => ({ standard: 'erc191', payload: p, signature: 'secp256k1:x' }) as unknown as MultiPayload);
    journal.put({ id: `rekey:${keyRef}`, account: vault, gas: 'a'.repeat(64), signed, txHashes: [], state: 'sent', at: double.now() });
    if (lies.spent !== undefined) for (const s of signed) lies.spent.add((JSON.parse(s.payload) as { nonce: string }).nonce);
  }

  const dataDir = tempDir('audit2-resume-');
  const prefs = createVaultPrefs(dataDir);
  if (opts.plantedOld === true) {
    // A run record a program wrote, naming as the owner key one that is not the vault's own: NEAR
    // reads it off, because it was never on.
    const planted = verifierKeyOf(Buffer.from(generatePrivateKey().slice(2), 'hex'));
    const record = { v: 1, vault, kind: 'migrate', phraseAt: null, recovery, old: planted, chip: { keyRef, publicKey: chip }, status: 'moving', at: new Date().toISOString() };
    fs.writeFileSync(path.join(dataDir, 'chip-run.json'), JSON.stringify(record));
  }
  let dropped = 0;
  const audit: string[] = [];
  const keystore = {
    addresses: () => ({ evm: vault }),
    onChange: () => () => undefined,
    evmPrivateKey: () => {
      if (opts.ownerKnown === false) throw new Error('owner_touch_required');
      return ownerHex;
    },
    ownerPublicKey: () => (opts.ownerKnown === false ? null : old),
    dropOwnerKey: () => void (dropped += 1),
  };
  const host: RekeyHost = {
    keystore: keystore as never,
    // What the service reports after a move cancelled at its first Touch ID: one committed chip.
    relay: {
      chipMarkers: () => [{ publicKey: chip, recovery, account: vault, allowance }],
      ask: async () => ({ ok: true, op: 'chipStatus', status: { keychainHome: true, chips: [{ keyRef, publicKey: chip, fresh: false, marker: { account: vault, allowance, recovery } }] } }),
    } as never,
    prefs,
    audit: { append: (_type: string, message: string) => void audit.push(message) } as never,
    dataDir,
    frame: () => undefined,
    changed: () => undefined,
    backedUp: () => true,
    ownerTouch: async () => ({ ok: false, code: 'unused', detail: 'unused' }),
  };
  useChipVault({
    verifier: lying,
    submitter: createVaultSubmitter({ verifier: lying, relay: double.relay, journal, now: double.now }),
    accounts: { accounts: () => ({}) as never, refresh: async () => ({}) as never },
    near: double.near,
    now: double.now,
  });
  try {
    const said = await resumeChip(host, false);
    return { said, named: prefs.get().chip?.publicKey ?? null, chip, dropped, audit, lying, vault, old };
  } finally {
    useChipVault(null);
  }
}

test('AU2-04: resumeChip does not call a vault moved while the chain still shows its owner key and predecessor auth on', async () => {
  const r = await resumeAgainst({});
  // The same chain the move was judged on: OLD on, predecessor on.
  assert.equal(await r.lying.hasPublicKey!(r.vault, r.old), true);
  assert.equal(await r.lying.isAuthByPredecessorIdEnabled!(r.vault), true);
  assert.equal(r.named, null, `resumeChip answered ${r.said} and wrote vault.json naming chip ${r.named}; owner key dropped ${r.dropped} time(s)`);
  assert.equal(r.dropped, 0);
  assert.ok(r.audit.some((m) => m.includes('not the rest of the move')), r.audit.join(' | '));
});

test('AU2-04: three views are not the move: predecessor auth off with the owner key still on, or the owner key off with predecessor auth on, writes nothing', async () => {
  for (const lies of [{ predecessorOff: true }, { oldOff: true }]) {
    const r = await resumeAgainst(lies);
    assert.equal(r.named, null, JSON.stringify(lies));
    assert.equal(r.dropped, 0, JSON.stringify(lies));
  }
});

test('AU2-04: with the owner key\'s public half unknown, the views cannot agree, and nothing is written without the bundle\'s spent nonces', async () => {
  const r = await resumeAgainst({ predecessorOff: true, oldOff: true }, { ownerKnown: false });
  assert.equal(r.named, null);
  assert.equal(r.dropped, 0);
  // A bundle of this chip's written down, its nonces not spent: still nothing.
  const unspent = await resumeAgainst({ predecessorOff: true }, { ownerKnown: false, journal: true });
  assert.equal(unspent.named, null);
  // A run record naming a key that is not the vault's own counts for nothing.
  const planted = await resumeAgainst({ predecessorOff: true }, { ownerKnown: false, plantedOld: true });
  assert.equal(planted.named, null);
  assert.equal(planted.dropped, 0);
});

test('AU2-04: all four views at one block, or every nonce of the chip\'s own bundle spent, and the vault is the chip\'s', async () => {
  const four = await resumeAgainst({ predecessorOff: true, oldOff: true });
  assert.equal(four.said, 'done');
  assert.equal(four.named, four.chip, 'vault.json names the chip');
  assert.equal(four.dropped, 1, 'the owner key went once');
  const ran = await resumeAgainst({ spent: new Set() }, { ownerKnown: false, journal: true });
  assert.equal(ran.said, 'done');
  assert.equal(ran.named, ran.chip, 'the bundle ran, so the vault is the chip\'s');
});
