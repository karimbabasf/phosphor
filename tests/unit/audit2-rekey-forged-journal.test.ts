// audit2 AU2-07: a rekey journal entry someone else wrote, with a payload deadline far ahead, no
// longer pauses agents and blocks every vault move with no end.
//
// The attack: anyone who can write the data folder plants state/vault-moves.json with one `rekey:`
// entry, released, a well-formed nonce and a deadline a year out. Nothing about the entry is signed
// or checked against the chain, mayStillRun() read the payload's own `deadline`, and settleEntry()
// waited until that deadline + 2 min, so agents waited and every top-up, migration and restore
// answered vault_settling until the file was removed.
// The rule held here (src/vault/submit.ts foreignBundle): every vault payload this app signs lives
// CHIP_PAYLOAD_LIFE_MS from its build, so a deadline later than now + CHIP_PAYLOAD_LIFE_MS + 60 s
// is not the app's. Such a bundle settles unknown (terminal, never signed again) and is left out of
// mayStillRun, so it holds nothing back. A bundle inside that bound still does.
//
// Run: node scripts/run-tests.ts tests/unit/audit2-rekey-forged-journal.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { implicitAccountOf } from '../../src/chain/near-tx.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { CHIP_PAYLOAD_LIFE_MS } from '../../src/vault/chip.ts';
import { useChipVault, vaultMoveUnderWay } from '../../src/vault/rekey.ts';
import { FOREIGN_DEADLINE_MS, createVaultSubmitter, fileJournal, journalPathFor } from '../../src/vault/submit.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';

const DAY = 24 * 60 * 60_000;

/* A journal with one released `rekey:` entry for a fresh vault whose payload's deadline lies
   `ahead` ms past the double's clock, and the submitter and chip vault over it. */
function planted(ahead: number) {
  const double = createIntentsDouble();
  const vault = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const gasSeed = Uint8Array.from(crypto.randomBytes(32));
  // The gas account an entry 0.10.16 wrote names: it still loads.
  const gas = implicitAccountOf(gasSeed).accountId;
  const file = journalPathFor(tempDir('audit2-forged-'));
  const deadlineMs = double.now() + ahead;
  const nonce = buildNonce({ salt: SALT, deadlineMs: deadlineMs + 7 * DAY, random: Uint8Array.from(crypto.randomBytes(15)) });
  const payload = JSON.stringify({ signer_id: vault, verifying_contract: 'intents.near', deadline: new Date(deadlineMs).toISOString(), nonce, intents: [] });
  fs.writeFileSync(
    file,
    JSON.stringify({ v: 1, entries: [{ id: 'rekey:forged', account: vault, gas, signed: [{ standard: 'erc191', payload, signature: 'secp256k1:x' }], txHashes: [], state: 'released', at: double.now() }] }),
  );
  const submitter = createVaultSubmitter({ verifier: double.verifier, relay: double.relay, journal: fileJournal(file), now: double.now, sleep: double.near.sleep });
  useChipVault({ verifier: double.verifier, submitter, accounts: { accounts: () => ({}) as never, refresh: async () => ({}) as never }, near: double.near, now: double.now });
  const keystore = { addresses: () => ({ evm: vault }) } as never;
  // A vault move: whether it gets as far as its signature.
  async function move(): Promise<{ signedAsked: boolean; said: string }> {
    let signedAsked = false;
    const result = await submitter.move({
      id: `vault_top_up:${crypto.randomUUID()}`,
      account: vault,
      async sign() {
        signedAsked = true;
        return { ok: false, code: 'probe', detail: 'the move reached its signature' };
      },
    });
    return { signedAsked, said: `${result.state} ${'code' in result ? result.code : ''}: ${'detail' in result ? result.detail : ''}` };
  }
  return { double, vault, submitter, keystore, move };
}

test('AU2-07: a planted rekey entry with a deadline a year out pauses no agent and blocks no move, from the first read', async () => {
  const w = planted(365 * DAY);
  try {
    assert.equal(vaultMoveUnderWay(w.keystore), false, 'agents are not paused');
    const first = await w.move();
    assert.ok(first.signedAsked, `a vault move answers ${first.said}`);
    const entry = w.submitter.pending(w.vault).find((e) => e.id === 'rekey:forged');
    assert.equal(entry?.state, 'unknown', 'settled unknown: never waited on, never signed again');
    assert.match(entry?.why ?? '', /not the app's/);
    w.double.advance(30 * DAY);
    assert.equal(vaultMoveUnderWay(w.keystore), false);
    assert.ok((await w.move()).signedAsked);
  } finally {
    useChipVault(null);
  }
});

test('AU2-07: a bundle inside the bound the app signs to still holds agents and moves back until NEAR settles it', async () => {
  const honest = planted(CHIP_PAYLOAD_LIFE_MS);
  try {
    assert.equal(vaultMoveUnderWay(honest.keystore), true, 'a bundle this app could have written keeps agents waiting');
    const blocked = await honest.move();
    assert.equal(blocked.signedAsked, false, `${blocked.said}`);
  } finally {
    useChipVault(null);
  }
  // One millisecond past the bound is not the app's.
  const past = planted(FOREIGN_DEADLINE_MS + 1);
  try {
    assert.equal(vaultMoveUnderWay(past.keystore), false);
    assert.ok((await past.move()).signedAsked);
  } finally {
    useChipVault(null);
  }
});
