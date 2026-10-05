// Sending a vault bundle (src/vault/submit.ts, PHASE2-PLAN C7), end to end in Node: payloads the app
// builds (src/vault/payload.ts), signed through the relay (src/vault/relay.ts) by a software chip
// that answers as the vault service does (tests/unit/helpers/chip-fake.ts) and checked by the chip
// signer (src/vault/chip.ts), then simulated, sent by the gas account and confirmed on a chain
// double that runs the verifier's rules and the RPC's (tests/unit/helpers/intents-double.ts).
//
// What it holds the code to: nothing is sent unless the simulation reports exactly the bundle's
// events; executed is only done once the views say so; and after any answer that leaves a signed
// bundle able to run (a timeout, a lost reply, INVALID_TRANSACTION for a copy that was forwarded, a
// failed call, a refused simulation), no new signature is asked for until the bundle is settled.
// One signature per move, counted at the chip, every time.
//
// Run: node --test tests/unit/vault-submit.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import { GAS_LOW_YOCTO, implicitAccountOf } from '../../src/chain/near-tx.ts';
import type { MultiPayload } from '../../src/chain/near-tx.ts';
import { erc191SignatureField } from '../../src/intents-sign.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce, decodeNonce } from '../../src/relay/payload.ts';
import type { Simulation, VerifierEvent } from '../../src/relay/verifier.ts';
import { CHIP_PAYLOAD_LIFE_MS, chipSign, commitChip, createChip } from '../../src/vault/chip.ts';
import type { ChipPin } from '../../src/vault/chip.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import type { VaultIntent } from '../../src/vault/payload.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRequest } from '../../src/vault/relay.ts';
import { VAULT_SETTLE_FLOOR_MS, createVaultSubmitter, fileJournal, journalPathFor, memoryJournal, rekeyViews, settleEntry, txFateOf } from '../../src/vault/submit.ts';
import type { VaultJournal, VaultMove, VaultResult } from '../../src/vault/submit.ts';
import { SoftwareChipService, serve } from './helpers/chip-fake.ts';
import type { Answer } from './helpers/chip-fake.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';
import type { Send } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const HALF_NEAR = 500_000_000_000_000_000_000_000n;

function secpKey(privateKey: `0x${string}`): string {
  return `secp256k1:${base58Encode(Buffer.from(privateKeyToAccount(privateKey).publicKey.slice(4), 'hex'))}`;
}

async function erc191(privateKey: `0x${string}`, payload: string): Promise<MultiPayload> {
  return { standard: 'erc191', payload, signature: erc191SignatureField(await privateKeyToAccount(privateKey).signMessage({ message: payload })) };
}

/* One vault on the double: its own key (OLD), a paper key (RECOVERY), a chip committed for it in
   the software service, an allowance, a funded gas account, and the submitter over all of it. */
async function world(opts: { chipOnChain?: boolean; gas?: bigint; journal?: VaultJournal; vaultUsdc?: bigint; service?: (now: () => number) => { run(request: VaultRequest): Answer } } = {}) {
  const double = createIntentsDouble();
  const relay = createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys: true });
  const service = new SoftwareChipService(double.now);
  const shell = serve(relay, opts.service?.(double.now) ?? service);
  const old = generatePrivateKey();
  const recovery = generatePrivateKey();
  const vault = privateKeyToAccount(old).address.toLowerCase();
  const allowance = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const made = await createChip(relay);
  assert.ok(made.ok);
  const committed = await commitChip(relay, { keyRef: made.keyRef, account: vault, allowance, recovery: secpKey(recovery) });
  assert.ok(committed.ok);
  const pin: ChipPin = { keyRef: made.keyRef, publicKey: made.publicKey, account: vault };
  if (opts.chipOnChain ?? true) double.addKey(vault, made.publicKey);
  double.fund(vault, USDC, opts.vaultUsdc ?? 100_000_000n);
  const gasSeed = Uint8Array.from(crypto.randomBytes(32));
  const gas = implicitAccountOf(gasSeed).accountId;
  double.fundGas(gas, opts.gas ?? HALF_NEAR);
  const journal = opts.journal ?? memoryJournal();
  const submitter = createVaultSubmitter({ verifier: double.verifier, gasSeed: () => gasSeed, journal, near: double.near, now: double.now, sleep: double.near.sleep });

  async function payload(intents: VaultIntent[], signer = vault): Promise<string> {
    const salt = (await double.verifier.currentSalt())!;
    return buildVaultPayload({ signerId: signer, intents, deadlineMs: double.now() + CHIP_PAYLOAD_LIFE_MS, salt });
  }

  // A move of `amount` USDC from the vault to the allowance, signed by the chip: what U9's top-up is.
  const signedBundles: MultiPayload[][] = [];
  function topUp(id: string, amount: bigint): VaultMove {
    return {
      id,
      account: vault,
      async sign() {
        const signed = await chipSign(relay, pin, await payload([{ intent: 'transfer', receiver_id: allowance, tokens: { [USDC]: amount.toString() } }]), { now: double.now, allowance });
        if (!signed.ok) return { ok: false, code: signed.code, detail: signed.detail };
        signedBundles.push([signed.signed]);
        return { ok: true, bundle: [signed.signed], before: {} };
      },
      balances: [
        { account: vault, asset: USDC },
        { account: allowance, asset: USDC },
      ],
    };
  }

  return { double, relay, service, shell, old, recovery, vault, allowance, pin, gas, gasSeed, journal, submitter, payload, topUp, signedBundles, stop: () => shell.stop() };
}

function stateOf(result: VaultResult): string {
  return result.state === 'done' ? result.state : `${result.state} ${result.code}: ${result.detail}`;
}

test('a top-up the software chip signed runs in the double: one Touch ID, one call, both balances exact', async () => {
  const w = await world();
  try {
    const result = await w.submitter.move(w.topUp('top-up-1', 5_000_000n));
    assert.equal(result.state, 'done', stateOf(result));
    assert.ok(result.state === 'done');
    assert.deepEqual(
      result.balances.map((b) => b.amount),
      [95_000_000n, 5_000_000n],
    );
    assert.equal(w.service.signatures, 1);
    assert.equal(w.double.executions(), 1);
    assert.equal(w.double.balanceOf(w.vault, USDC), 95_000_000n);
    assert.equal(w.double.balanceOf(w.allowance, USDC), 5_000_000n);
    // The nonce lives exactly seven days past the payload (buildVaultPayload, buildNonce).
    const body = JSON.parse(w.signedBundles[0]![0]!.payload) as { deadline: string; nonce: string };
    assert.equal(decodeNonce(body.nonce)!.deadlineMs, Date.parse(body.deadline) + NONCE_LIFE_AFTER_DEADLINE_MS);
    // Done lets the entry go; the gas account paid.
    assert.deepEqual(w.submitter.pending(), []);
    assert.ok(w.double.gasAmount(w.gas)! < HALF_NEAR);
  } finally {
    await w.stop();
  }
});

test('one changed event in the simulation stops the submit: nothing is sent, and nothing is signed again while it may run', async () => {
  type Tamper = [string, (events: VerifierEvent[]) => VerifierEvent[]];
  const tampers: Tamper[] = [
    ['the amount', (e) => e.map((x) => (x.event === 'transfer' ? { event: 'transfer', data: [{ ...x.data[0]!, tokens: { [USDC]: '5000001' } }] } : x))],
    ['the receiver', (e) => e.map((x) => (x.event === 'transfer' ? { event: 'transfer', data: [{ ...x.data[0]!, receiver_id: `0x${'ee'.repeat(20)}` }] } : x))],
    ['the asset', (e) => e.map((x) => (x.event === 'transfer' ? { event: 'transfer', data: [{ ...x.data[0]!, tokens: { 'nep141:wrap.near': '5000000' } }] } : x))],
    ['a missing event', (e) => e.filter((x) => x.event !== 'transfer')],
    ['an extra key event', (e) => [{ event: 'public_key_added', data: { intent_hash: (e.at(-1) as Extract<VerifierEvent, { event: 'intents_executed' }>).data[0]!.intent_hash, account_id: (e[0] as Extract<VerifierEvent, { event: 'transfer' }>).data[0]!.account_id, public_key: `p256:${base58Encode(Buffer.alloc(64, 9))}` } }, ...e]],
    ['predecessor auth switched on', (e) => [...e.slice(0, -1), { event: 'set_auth_by_predecessor_id', data: { intent_hash: (e.at(-1) as Extract<VerifierEvent, { event: 'intents_executed' }>).data[0]!.intent_hash, account_id: (e[0] as Extract<VerifierEvent, { event: 'transfer' }>).data[0]!.account_id, enabled: true } }, e.at(-1)!]],
    ['an event of another standard', (e) => [...e.slice(0, -1), { event: 'other', line: 'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[]}' }, e.at(-1)!]],
    ['no events at all', () => undefined as unknown as VerifierEvent[]],
  ];
  for (const [what, tamper] of tampers) {
    const w = await world();
    try {
      w.double.faults.simulate = (sim: Simulation) => (sim.ok ? { ...sim, events: tamper(structuredClone(sim.events ?? [])) } : sim);
      const result = await w.submitter.move(w.topUp('top-up', 5_000_000n));
      assert.equal(result.state, 'refused', `${what}: ${stateOf(result)}`);
      assert.ok(result.state === 'refused');
      assert.equal(result.code, 'events_mismatch', what);
      assert.equal(result.released, true, what);
      assert.equal(w.double.sendCount(), 0, `${what}: nothing was sent`);
      assert.equal(w.double.balanceOf(w.allowance, USDC), 0n, what);
      // The simulation already handed the signed bundle to the RPC, so the same move waits.
      w.double.faults.simulate = null;
      const again = await w.submitter.move(w.topUp('top-up', 5_000_000n));
      assert.equal(again.state, 'settling', `${what}: ${stateOf(again)}`);
      assert.equal(w.service.signatures, 1, `${what}: one Touch ID`);
    } finally {
      await w.stop();
    }
  }
});

test('the migrate rekey: C7\'s five events on the old key\'s payload, then the four views, before done', async () => {
  const w = await world({ chipOnChain: false });
  try {
    const chipKey = w.pin.publicKey;
    const recoveryKey = secpKey(w.recovery);
    const oldKey = secpKey(w.old);
    assert.equal(w.double.predecessorAuth(w.vault), true);
    const move: VaultMove = {
      id: 'rekey-1',
      account: w.vault,
      async sign() {
        const before = { predecessorAuth: (await w.double.verifier.isAuthByPredecessorIdEnabled(w.vault))! };
        const pa = await erc191(
          w.old,
          await w.payload([
            { intent: 'add_public_key', public_key: chipKey },
            { intent: 'add_public_key', public_key: recoveryKey },
            { intent: 'remove_public_key', public_key: oldKey },
            { intent: 'set_auth_by_predecessor_id', enabled: false },
          ]),
        );
        const pc = await erc191(w.recovery, await w.payload([]));
        const pb = await chipSign(w.relay, w.pin, await w.payload([]), { now: w.double.now });
        if (!pb.ok) return { ok: false, code: pb.code, detail: pb.detail };
        return { ok: true, bundle: [pa, pc, pb.signed], before };
      },
      views: rekeyViews({ vault: w.vault, chip: chipKey, recovery: recoveryKey, old: oldKey }),
    };
    // What the simulation must report, read off the double before the real move.
    let reported: VerifierEvent[] = [];
    w.double.faults.simulate = (sim) => {
      if (sim.ok) reported = sim.events ?? [];
      return sim;
    };
    const result = await w.submitter.move(move);
    assert.equal(result.state, 'done', stateOf(result));
    assert.deepEqual(
      reported.map((e) => (e.event === 'set_auth_by_predecessor_id' ? `${e.event}:${e.data.enabled}` : e.event)),
      ['public_key_added', 'public_key_added', 'public_key_removed', 'set_auth_by_predecessor_id:false', 'intents_executed'],
    );
    const pa = reported[0]!;
    assert.ok(pa.event === 'public_key_added');
    for (const e of reported.slice(0, 4)) assert.ok(e.event !== 'intents_executed' && e.event !== 'other' && e.event !== 'transfer' && e.data.intent_hash === pa.data.intent_hash, 'all four on the old key\'s payload');
    const executed = reported[4]!;
    assert.ok(executed.event === 'intents_executed' && executed.data.length === 3);
    assert.equal(w.double.hasKey(w.vault, chipKey), true);
    assert.equal(w.double.hasKey(w.vault, recoveryKey), true);
    assert.equal(w.double.hasKey(w.vault, oldKey), false);
    assert.equal(w.double.predecessorAuth(w.vault), false);
    assert.equal(w.service.signatures, 1);

    // A restore runs with the flag already off: no predecessor event is expected, and the same
    // bundle shape with a stale "true" read stops before the send.
    const stale: VaultMove = {
      id: 'restore-stale',
      account: w.vault,
      async sign() {
        const pa2 = await erc191(w.recovery, await w.payload([{ intent: 'set_auth_by_predecessor_id', enabled: false }]));
        return { ok: true, bundle: [pa2], before: { predecessorAuth: true } };
      },
    };
    const sends = w.double.sendCount();
    const refused = await w.submitter.move(stale);
    assert.equal(refused.state, 'refused', stateOf(refused));
    assert.ok(refused.state === 'refused' && refused.code === 'events_mismatch');
    assert.equal(w.double.sendCount(), sends);
  } finally {
    await w.stop();
  }
});

test('a restore expects the predecessor event only when the flag read true, and confirms the same four views', async () => {
  const w = await world({ chipOnChain: false });
  try {
    // A vault whose predecessor auth is already off, keys CHIP_old and RECOVERY on it, OLD gone:
    // the paper (RECOVERY) moves it to a new chip.
    const recoveryKey = secpKey(w.recovery);
    const oldKey = secpKey(w.old);
    const first = await w.submitter.move({
      id: 'migrate',
      account: w.vault,
      async sign() {
        const pa = await erc191(w.old, await w.payload([
          { intent: 'add_public_key', public_key: recoveryKey },
          { intent: 'remove_public_key', public_key: oldKey },
          { intent: 'set_auth_by_predecessor_id', enabled: false },
        ]));
        return { ok: true, bundle: [pa], before: { predecessorAuth: true } };
      },
    });
    assert.equal(first.state, 'done', stateOf(first));
    const fresh = await createChip(w.relay);
    assert.ok(fresh.ok);
    const restored = await w.submitter.move({
      id: 'restore',
      account: w.vault,
      async sign() {
        const before = { predecessorAuth: (await w.double.verifier.isAuthByPredecessorIdEnabled(w.vault))! };
        assert.equal(before.predecessorAuth, false);
        const pa = await erc191(w.recovery, await w.payload([
          { intent: 'add_public_key', public_key: fresh.publicKey },
          { intent: 'set_auth_by_predecessor_id', enabled: false },
        ]));
        return { ok: true, bundle: [pa], before };
      },
      views: rekeyViews({ vault: w.vault, chip: fresh.publicKey, recovery: recoveryKey, old: oldKey }),
    });
    assert.equal(restored.state, 'done', stateOf(restored));
    assert.equal(w.double.hasKey(w.vault, fresh.publicKey), true);
  } finally {
    await w.stop();
  }
});

/* The ambiguous answers. Each script makes near-tx answer `unknown` (the budget runs out with the
   copy's fate unread) while the copy did run; the same move asked again settles on GAS's own
   transaction by hash and is done, with the one signature it already had. */
const LANDED: [string, Send[]][] = [
  ['a timeout, the copy landed', [{ kind: 'timeout', land: true }, { kind: 'timeout', land: false }]],
  ['a lost reply, the copy landed', [{ kind: 'lost', land: true }, { kind: 'lost', land: false }]],
  ['INVALID_TRANSACTION for a copy that was forwarded and ran', [{ kind: 'invalid', land: true }, { kind: 'invalid', land: false, variant: { InvalidNonce: { tx_nonce: 1, ak_nonce: 1 } } }]],
];

for (const [what, script] of LANDED) {
  test(`ambiguous submit, ${what}: one signature, one call that ran, done on the second ask`, async () => {
    const w = await world();
    try {
      w.double.sends.push(...script);
      const first = await w.submitter.move(w.topUp('top-up', 5_000_000n));
      assert.equal(first.state, 'sent', stateOf(first));
      assert.ok(first.state === 'sent' && first.code === 'vault_pending');
      assert.equal(w.double.executions(), 1, 'the copy ran');
      const second = await w.submitter.move(w.topUp('top-up', 5_000_000n));
      assert.equal(second.state, 'done', stateOf(second));
      assert.equal(w.service.signatures, 1, 'one Touch ID for the move');
      assert.equal(w.double.executions(), 1);
      assert.equal(w.double.balanceOf(w.allowance, USDC), 5_000_000n);
      // A new move (a new id) is signed normally afterwards.
      w.double.sends.splice(0, w.double.sends.length);
      const next = await w.submitter.move(w.topUp('top-up-2', 1_000_000n));
      assert.equal(next.state, 'done', stateOf(next));
      assert.equal(w.service.signatures, 2);
      assert.equal(w.double.balanceOf(w.allowance, USDC), 6_000_000n);
    } finally {
      await w.stop();
    }
  });
}

test('ambiguous submit that never landed: nothing is signed before the deadline and two minutes, then once more with fresh nonces', async () => {
  const w = await world();
  try {
    w.double.sends.push({ kind: 'timeout', land: false });
    const first = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(first.state, 'sent', stateOf(first));
    // Before the deadline and the two minutes: wait, whatever is asked, and no touch.
    for (const step of [0, 30_000, 60_000]) {
      w.double.advance(step);
      const asked = await w.submitter.move(w.topUp('top-up', 5_000_000n));
      assert.equal(asked.state, 'settling', stateOf(asked));
      // Another move for the same vault waits too: no new vault signature while one can still run.
      const other = await w.submitter.move(w.topUp('another', 1n));
      assert.equal(other.state, 'settling', stateOf(other));
    }
    assert.equal(w.service.signatures, 1);
    const deadline = Date.parse((JSON.parse(w.signedBundles[0]![0]!.payload) as { deadline: string }).deadline);
    w.double.advance(deadline + VAULT_SETTLE_FLOOR_MS + 1 - w.double.now());
    w.double.sends.splice(0, w.double.sends.length, { kind: 'ok' });
    const again = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(again.state, 'done', stateOf(again));
    assert.equal(w.service.signatures, 2, 'signed again only once the first was proved dead');
    assert.equal(w.double.executions(), 1);
    assert.equal(w.double.balanceOf(w.allowance, USDC), 5_000_000n);
    const nonces = w.signedBundles.map((b) => (JSON.parse(b[0]!.payload) as { nonce: string }).nonce);
    assert.notEqual(nonces[0], nonces[1], 'a move signed again gets a fresh nonce');
  } finally {
    await w.stop();
  }
});

test('ambiguous submit that lands after the budget, before the deadline: settled as ran, never signed again', async () => {
  const w = await world();
  try {
    w.double.sends.push({ kind: 'later', afterMs: 75_000 });
    const first = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(first.state, 'sent', stateOf(first));
    assert.equal(w.double.executions(), 0);
    const waiting = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(waiting.state, 'settling', stateOf(waiting));
    w.double.advance(20_000);
    const done = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(done.state, 'done', stateOf(done));
    assert.equal(w.service.signatures, 1);
    assert.equal(w.double.executions(), 1);
  } finally {
    await w.stop();
  }
});

test('a failed call is about that call only: the same signed intents run for someone else before the deadline, and the move is done, not signed again', async () => {
  const w = await world();
  try {
    // The simulation passes; the vault is emptied before the call runs, so the verifier refuses it.
    w.double.faults.simulate = (sim) => {
      w.double.fund(w.vault, USDC, -w.double.balanceOf(w.vault, USDC));
      w.double.faults.simulate = null;
      return sim;
    };
    const first = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(first.state, 'sent', stateOf(first));
    assert.ok(first.state === 'sent');
    assert.match(first.detail, /insufficient balance/);
    assert.equal(w.double.executions(), 0);
    // Money arrives, and whoever saw the signed bytes runs them in a call of their own.
    w.double.fund(w.vault, USDC, 10_000_000n);
    const stranger = await w.double.runAsStranger(w.signedBundles[0]!);
    assert.equal(stranger.ok, true, stranger.panic ?? '');
    const second = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(second.state, 'done', stateOf(second));
    assert.equal(w.service.signatures, 1);
    assert.equal(w.double.balanceOf(w.allowance, USDC), 5_000_000n);
  } finally {
    await w.stop();
  }
});

test('a refused simulation still released the bundle: the move waits out its deadline, then is signed afresh', async () => {
  const w = await world({ vaultUsdc: 1_000_000n });
  try {
    const first = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(first.state, 'refused', stateOf(first));
    assert.ok(first.state === 'refused' && first.code === 'simulate_refused' && first.released);
    assert.equal(w.double.sendCount(), 0);
    w.double.fund(w.vault, USDC, 9_000_000n);
    const early = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(early.state, 'settling', stateOf(early));
    w.double.advance(CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS + 1);
    const later = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(later.state, 'done', stateOf(later));
    assert.equal(w.service.signatures, 2);
    assert.equal(w.double.executions(), 1);
  } finally {
    await w.stop();
  }
});

test('"never ran" needs every proof at one block: reads that fail, or a lookup with no answer, keep the move and the account waiting', async () => {
  const w0 = await world();
  try {
    w0.double.sends.push({ kind: 'timeout', land: false });
    assert.equal((await w0.submitter.move(w0.topUp('top-up', 5_000_000n))).state, 'sent');
    w0.double.advance(CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS + 1);
    w0.double.faults.reads = true;
    for (const id of ['top-up', 'another']) {
      const asked = await w0.submitter.move(w0.topUp(id, 5_000_000n));
      assert.ok(asked.state === 'settling' && /did not say which block is final/.test(asked.detail), `${id}: ${stateOf(asked)}`);
    }
    assert.equal(w0.service.signatures, 1);
  } finally {
    await w0.stop();
  }

  // A lookup by hash with no answer: the nonces read unspent past the deadline, and it still waits.
  const w = await world();
  try {
    w.double.sends.push({ kind: 'timeout', land: false });
    assert.equal((await w.submitter.move(w.topUp('top-up', 5_000_000n))).state, 'sent');
    w.double.advance(CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS + 1);
    const [entry] = w.submitter.pending();
    const settled = await settleEntry(entry!, { verifier: w.double.verifier, lookup: async () => 'unknown', now: w.double.now });
    assert.equal(settled.verdict, 'wait');
    assert.ok(settled.verdict === 'wait' && /did not say what became of a transaction/.test(settled.why));
    // The same entry with a lookup that answers: dead, proved at one block.
    const dead = await settleEntry(entry!, { verifier: w.double.verifier, lookup: async () => 'not_found', now: w.double.now });
    assert.equal(dead.verdict, 'dead');
    // A final block stamped minutes ahead of this clock is no block at all.
    const ahead = await settleEntry(entry!, {
      verifier: { ...w.double.verifier, finalBlock: async () => ({ hash: 'x', atMs: w.double.now() + 10 * 60_000 }) },
      lookup: async () => 'not_found',
      now: w.double.now,
    });
    assert.ok(ahead.verdict === 'wait' && /too far ahead/.test(ahead.why));
    // A salt read with no answer is no "valid".
    const saltUnread = await settleEntry(entry!, { verifier: { ...w.double.verifier, isValidSalt: async () => null }, lookup: async () => 'not_found', now: w.double.now });
    assert.ok(saltUnread.verdict === 'wait' && /whether a nonce salt is valid/.test(saltUnread.why));
    // A nonce read with no answer is no "unspent".
    const nonceUnread = await settleEntry(entry!, { verifier: { ...w.double.verifier, nonceUsed: async () => null }, lookup: async () => 'not_found', now: w.double.now });
    assert.ok(nonceUnread.verdict === 'wait' && /whether every nonce is spent/.test(nonceUnread.why));
    // This Mac's clock short of the deadline and two minutes is a wait, whatever the block says.
    const lastDeadline = Date.parse((JSON.parse(entry!.signed[0]!.payload) as { deadline: string }).deadline);
    const early = await settleEntry(entry!, { verifier: w.double.verifier, lookup: async () => 'not_found', now: () => lastDeadline + VAULT_SETTLE_FLOOR_MS - 1 });
    assert.ok(early.verdict === 'wait' && early.notBefore !== null, JSON.stringify(early));
  } finally {
    await w.stop();
  }
});

test('a bundle whose fate can no longer be proved (its salt taken out, or its nonce past its own life) is never signed again, and holds no other move back', async () => {
  const cases: [string, (w: Awaited<ReturnType<typeof world>>) => void, RegExp][] = [
    ['a salt taken out', (w) => w.double.retireSalt('252812b3'), /salt was taken out/],
    ['a nonce past its own life', (w) => w.double.advance(NONCE_LIFE_AFTER_DEADLINE_MS + 60_000), /past its own life/],
  ];
  for (const [what, harm, why] of cases) {
    const w = await world();
    try {
      w.double.sends.push({ kind: 'timeout', land: false });
      assert.equal((await w.submitter.move(w.topUp('top-up', 5_000_000n))).state, 'sent');
      // Before the deadline and two minutes it waits like any other.
      harm(w);
      if (what === 'a salt taken out') assert.equal((await w.submitter.move(w.topUp('top-up', 5_000_000n))).state, 'settling', what);
      w.double.advance(CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS + 1);
      for (let i = 0; i < 2; i += 1) {
        const asked = await w.submitter.move(w.topUp('top-up', 5_000_000n));
        assert.ok(asked.state === 'unknown' && asked.code === 'vault_unknown' && why.test(asked.detail), `${what}: ${stateOf(asked)}`);
      }
      assert.equal(w.service.signatures, 1, `${what}: the move is never signed again`);
      w.double.sends.splice(0, w.double.sends.length, { kind: 'ok' });
      const other = await w.submitter.move(w.topUp('next', 1_000_000n));
      assert.equal(other.state, 'done', `${what}: ${stateOf(other)}`);
      assert.equal(w.service.signatures, 2);
      // Kept for its move a week from when it settled, then let go.
      w.double.advance(7 * 24 * 60 * 60 * 1000 - 60_000);
      await w.submitter.settle();
      assert.deepEqual(w.submitter.pending().map((e) => [e.id, e.state]), [['top-up', 'unknown']], what);
      w.double.advance(60_001);
      await w.submitter.settle();
      assert.deepEqual(w.submitter.pending(), [], what);
    } finally {
      await w.stop();
    }
  }
});

test('part of a bundle run on its own is never done: the move reads as a mismatch and is not signed again', async () => {
  const w = await world();
  try {
    w.double.sends.push({ kind: 'timeout', land: false });
    const first = await w.submitter.move({
      id: 'proofs',
      account: w.vault,
      async sign() {
        const one = await erc191(w.old, await w.payload([]));
        const two = await chipSign(w.relay, w.pin, await w.payload([]), { now: w.double.now });
        assert.ok(two.ok);
        w.signedBundles.push([one, two.signed]);
        return { ok: true, bundle: [one, two.signed], before: {} };
      },
    });
    assert.equal(first.state, 'sent', stateOf(first));
    assert.equal((await w.double.runAsStranger([w.signedBundles[0]![0]!])).ok, true);
    w.double.advance(CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS + 1);
    for (let i = 0; i < 2; i += 1) {
      const asked = await w.submitter.move({ id: 'proofs', account: w.vault, sign: async () => assert.fail('never signed again') });
      assert.equal(asked.state, 'mismatch', stateOf(asked));
    }
    assert.equal(w.service.signatures, 1);
  } finally {
    await w.stop();
  }
});

test('a view that reads wrong after the call ran is a mismatch, and asking again reads the views again with no new signature', async () => {
  const w = await world();
  try {
    const move: VaultMove = { ...w.topUp('top-up', 5_000_000n), views: [{ view: 'predecessorAuth', account: w.vault, is: false }] };
    const first = await w.submitter.move(move);
    assert.equal(first.state, 'mismatch', stateOf(first));
    assert.ok(first.state === 'mismatch' && /is_auth_by_predecessor_id_enabled .* reads true where false was expected/.test(first.detail));
    const again = await w.submitter.move(move);
    assert.equal(again.state, 'mismatch', stateOf(again));
    assert.equal(w.service.signatures, 1);
    assert.equal(w.double.executions(), 1);
  } finally {
    await w.stop();
  }
});

test('the gas account is asked before the Touch ID: under 0.06 NEAR, or not funded, nobody is asked to sign', async () => {
  for (const [what, gas, code] of [
    ['one yocto short of what a submit needs', GAS_LOW_YOCTO - 1n, 'gas_low'],
    ['no account yet', null, 'gas_unfunded'],
  ] as const) {
    const w = await world({ gas: gas ?? HALF_NEAR });
    try {
      if (gas === null) {
        const other = Uint8Array.from(crypto.randomBytes(32));
        const sub = createVaultSubmitter({ verifier: w.double.verifier, gasSeed: () => other, journal: memoryJournal(), near: w.double.near, now: w.double.now, sleep: w.double.near.sleep });
        const result = await sub.move(w.topUp('top-up', 5_000_000n));
        assert.ok(result.state === 'refused' && result.code === code && !result.released, `${what}: ${stateOf(result)}`);
      } else {
        const result = await w.submitter.move(w.topUp('top-up', 5_000_000n));
        assert.ok(result.state === 'refused' && result.code === code && !result.released, `${what}: ${stateOf(result)}`);
      }
      assert.equal(w.service.signatures, 0, what);
      assert.deepEqual(w.service.seen.filter((r) => r.op === 'signIntent'), [], what);
    } finally {
      await w.stop();
    }
  }
  // Exactly the threshold is enough.
  const w = await world({ gas: GAS_LOW_YOCTO });
  try {
    assert.equal((await w.submitter.move(w.topUp('top-up', 5_000_000n))).state, 'done');
  } finally {
    await w.stop();
  }
});

test('a shut wallet has no gas key: the move is refused before any Touch ID', async () => {
  const w = await world();
  try {
    const shut = createVaultSubmitter({
      verifier: w.double.verifier,
      gasSeed: () => {
        throw new Error('the wallet is locked: open it first');
      },
      journal: memoryJournal(),
      near: w.double.near,
      now: w.double.now,
      sleep: w.double.near.sleep,
    });
    const result = await shut.move(w.topUp('top-up', 5_000_000n));
    assert.ok(result.state === 'refused' && result.code === 'wallet_locked', stateOf(result));
    assert.equal(w.service.signatures, 0);
  } finally {
    await w.stop();
  }
});

test('the journal on disk outlives the process: a new submitter over it waits, then settles the bundle that ran', async () => {
  const dir = tempDir('phosphor-vault-moves-');
  const file = journalPathFor(dir);
  assert.equal(path.basename(file), 'vault-moves.json');
  const w = await world({ journal: fileJournal(file) });
  try {
    w.double.sends.push({ kind: 'later', afterMs: 70_000 });
    assert.equal((await w.submitter.move(w.topUp('top-up', 5_000_000n))).state, 'sent');
    // The process dies here. The next one reads the same file.
    const reborn = createVaultSubmitter({ verifier: w.double.verifier, gasSeed: () => w.gasSeed, journal: fileJournal(file), near: w.double.near, now: w.double.now, sleep: w.double.near.sleep });
    assert.equal(reborn.pending().length, 1);
    assert.equal((await reborn.move(w.topUp('top-up', 5_000_000n))).state, 'settling');
    w.double.advance(30_000);
    const done = await reborn.move(w.topUp('top-up', 5_000_000n));
    assert.equal(done.state, 'done', stateOf(done));
    assert.equal(w.service.signatures, 1);
    assert.deepEqual(fileJournal(file).list(), []);
  } finally {
    await w.stop();
  }
});

test('a bundle that is not the app\'s is never released: another account, a reused nonce, a nonce built by hand', async () => {
  const w = await world();
  try {
    const own = await w.payload([]);
    const signedOwn = await erc191(w.old, own);
    const body = JSON.parse(own) as { deadline: string };
    // The nonce life before the seven-day rule, built by hand: the chain takes it, the app does not.
    const shortLived = JSON.stringify({ ...body, nonce: buildNonce({ salt: SALT, deadlineMs: Date.parse(body.deadline), random: new Uint8Array(15).fill(3) }) });
    const cases: [string, MultiPayload[]][] = [
      ['another account', [await erc191(w.recovery, await w.payload([], privateKeyToAccount(w.recovery).address.toLowerCase()))]],
      ['the same nonce twice', [signedOwn, signedOwn]],
      ['a nonce that expires with its payload', [await erc191(w.old, shortLived)]],
      ['nothing at all', []],
    ];
    for (const [what, bundle] of cases) {
      const result = await w.submitter.move({ id: what, account: w.vault, sign: async () => ({ ok: true, bundle, before: {} }) });
      assert.ok(result.state === 'refused' && result.code === 'vault_bundle' && !result.released, `${what}: ${stateOf(result)}`);
    }
    // A signer that throws (a wallet that locked between two touches, say) signed nothing that left.
    const thrown = await w.submitter.move({ id: 'throws', account: w.vault, sign: async () => { throw new Error('the wallet is locked: open it first'); } });
    assert.ok(thrown.state === 'refused' && thrown.code === 'vault_bundle' && !thrown.released, stateOf(thrown));
    assert.equal(w.double.sendCount(), 0);
    assert.deepEqual(w.submitter.pending(), []);
  } finally {
    await w.stop();
  }
});

test('a move that ran is answered from its own bundle, even while a later move of the same vault still waits', async () => {
  const w = await world({ journal: fileJournal(journalPathFor(tempDir('phosphor-vault-order-'))) });
  try {
    w.double.sends.push({ kind: 'timeout', land: true }, { kind: 'timeout', land: false });
    assert.equal((await w.submitter.move(w.topUp('a', 5_000_000n))).state, 'sent');
    // b is signed once a's bundle reads as ran, and is itself left undecided.
    w.double.sends.splice(0, w.double.sends.length, { kind: 'timeout', land: false });
    assert.equal((await w.submitter.move(w.topUp('b', 1_000_000n))).state, 'sent');
    const a = await w.submitter.move(w.topUp('a', 5_000_000n));
    assert.equal(a.state, 'done', stateOf(a));
    const b = await w.submitter.move(w.topUp('b', 1_000_000n));
    assert.ok(b.state === 'settling' && /^this move:/.test(b.detail), stateOf(b));
    const c = await w.submitter.move(w.topUp('c', 1n));
    assert.ok(c.state === 'settling' && /^an earlier vault move:/.test(c.detail), stateOf(c));
    assert.equal(w.service.signatures, 2);
  } finally {
    await w.stop();
  }
});

test('a bundle that cannot be written down never leaves this Mac', async () => {
  const full: VaultJournal = {
    list: () => [],
    put: () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
    drop: () => undefined,
  };
  const w = await world({ journal: full });
  try {
    let simulated = 0;
    w.double.faults.simulate = (sim) => ((simulated += 1), sim);
    const result = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.ok(result.state === 'refused' && result.code === 'vault_journal' && !result.released, stateOf(result));
    assert.equal(simulated, 0, 'not even simulated');
    assert.equal(w.double.sendCount(), 0);
  } finally {
    await w.stop();
  }
});

test('GAS\'s own transaction read by hash: only a FINAL answer decides, UNKNOWN_TRANSACTION is not found, anything else unknown', () => {
  const hash = 'H5kqrmnzGJxhW1YGFWS17ukfPgxBmWYp6xd81FrhhrGx';
  const final = (main: Record<string, unknown>, status = 'FINAL', txStatus: Record<string, unknown> = { SuccessReceiptId: 'R1' }) => ({
    result: {
      final_execution_status: status,
      transaction: { hash },
      transaction_outcome: { outcome: { receipt_ids: ['R1'], status: txStatus } },
      receipts_outcome: [{ id: 'R1', outcome: { executor_id: 'intents.near', status: main } }],
    },
  });
  assert.equal(txFateOf(final({ SuccessValue: '' }), hash), 'executed');
  assert.equal(txFateOf(final({ Failure: {} }), hash), 'failed');
  assert.equal(txFateOf(final({ SuccessValue: '' }, 'FINAL', { Failure: {} }), hash), 'failed');
  assert.equal(txFateOf(final({ SuccessValue: '' }, 'EXECUTED_OPTIMISTIC'), hash), 'unknown');
  assert.equal(txFateOf(final({ SuccessValue: '' }), 'another'), 'unknown');
  assert.equal(txFateOf({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } }, hash), 'not_found');
  assert.equal(txFateOf({ error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }, hash), 'unknown');
  assert.equal(txFateOf({ error: { code: -429 } }, hash), 'unknown');
  const elsewhere = final({ SuccessValue: '' });
  elsewhere.result.receipts_outcome[0]!.outcome.executor_id = 'wrap.near';
  assert.equal(txFateOf(elsewhere, hash), 'unknown');
});

/* The same top-up and the same ambiguous submit against the vault service's own stand-in (U5's
   tests/unit/helpers/vault-double.ts: main.swift, ChipOps.swift and the grammar compiled with the
   test seam), its grammar and its software-key seam signing where the enclave would ask a touch. */
test('the same moves against the vault service\'s own stand-in', async (t) => {
  const { VaultDouble, swiftc } = await import('./helpers/vault-double.ts');
  if (!swiftc) {
    t.skip('needs macOS with swiftc');
    return;
  }
  const clock = { now: () => Date.now() };
  const standIn = new VaultDouble();
  const probe = standIn.run({ id: 'probe-chip-ops', op: 'chipStatus' });
  assert.ok(probe.ok, `the stand-in answers the chip ops: ${String(probe.error)}`);
  let signatures = 0;
  const service = {
    run(request: VaultRequest) {
      standIn.now = Math.floor(clock.now() / 1000);
      const answer = standIn.run(request as unknown as Record<string, unknown>);
      if (request.op === 'signIntent' && answer.ok) signatures += 1;
      return answer as Answer;
    },
  };
  const w = await world({ service: (now) => ((clock.now = now), service) });
  try {
    const done = await w.submitter.move(w.topUp('top-up', 5_000_000n));
    assert.equal(done.state, 'done', stateOf(done));
    assert.equal(w.double.balanceOf(w.allowance, USDC), 5_000_000n);
    w.double.sends.push({ kind: 'timeout', land: true }, { kind: 'timeout', land: false });
    assert.equal((await w.submitter.move(w.topUp('ambiguous', 1_000_000n))).state, 'sent');
    const settled = await w.submitter.move(w.topUp('ambiguous', 1_000_000n));
    assert.equal(settled.state, 'done', stateOf(settled));
    assert.equal(signatures, 2, 'one Touch ID per move');
    assert.equal(w.double.executions(), 2);
  } finally {
    await w.stop();
  }
});
