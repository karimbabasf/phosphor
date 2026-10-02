// The claim, end to end against a fake verifier, a fake relay and a fake 1Click that execute what
// was signed the way intents.near would: the nonce spent and the transfer applied in one step.
// Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The claim, step by step",
// "Plan B" and "Tests". Time is the world's: a sleep moves this Mac's clock and the chain's.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SIGNED_DEADLINE_MS } from '../../src/rails/intents-native.ts';
import type { RelayClient } from '../../src/relay/client.ts';
import { decodeNonce } from '../../src/relay/payload.ts';
import { createInviteService } from '../../src/invite/claim.ts';
import type { InviteDeps } from '../../src/invite/claim.ts';
import { inviteLink } from '../../src/invite/code.ts';
import { codeSigner } from '../../src/invite/signer.ts';
import type { KeySigner } from '../../src/invite/signer.ts';
import { CLAIM_DEADLINE_MS, INVITE_ASSET_ID, intentHashOf } from '../../src/invite/payload.ts';
import { CLAIMS_FILE, createClaimStore } from '../../src/invite/store.ts';
import type { ClaimRecord } from '../../src/invite/store.ts';
import { TEST_QUOTE_KEY } from './helpers/signed-quote.ts';
import {
  CODE,
  CODE_ADDRESS,
  HANDLE,
  SECRET,
  START,
  WALLET,
  WALLET_ID,
  freshWorld,
  oneclickOf,
  relayOf,
  transferOf,
  verifierOf,
} from './helpers/invite-world.ts';
import type { World } from './helpers/invite-world.ts';

type Harness = {
  world: World;
  service: ReturnType<typeof createInviteService>;
  audit: Array<{ type: string; msg: string; data: unknown }>;
  frames: Array<Record<string, unknown>>;
  holds: Array<{ asset: string; walletBefore: bigint | null; proven?: bigint | null }>;
  refreshes: number;
  dataDir: string;
  lock: { state: 'unlocked' | 'locked'; verified: boolean; tampered: boolean };
};

function harness(over: Partial<InviteDeps> & { world?: World; dataDir?: string } = {}): Harness {
  const world = over.world ?? freshWorld();
  const dataDir = over.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-'));
  const h: Harness = { world, service: null as never, audit: [], frames: [], holds: [], refreshes: 0, dataDir, lock: { state: 'unlocked', verified: true, tampered: false } };
  h.service = createInviteService({
    dataDir,
    movesMoney: true,
    audit: { append: (type, msg, data) => (h.audit.push({ type, msg, data }), { ts: '', type, msg, data }) },
    keystore: {
      state: () => h.lock.state,
      addressReport: () => ({ addresses: { evm: WALLET, solana: null, near: null, nearPublicKey: null }, verified: h.lock.verified, tampered: h.lock.tampered }),
    },
    broadcast: (frame) => h.frames.push(frame as Record<string, unknown>),
    broadcastState: () => {},
    refreshLedger: async () => {
      h.refreshes += 1;
    },
    hold: (asset, walletBefore) => {
      const entry: { asset: string; walletBefore: bigint | null; proven?: bigint | null } = { asset, walletBefore };
      h.holds.push(entry);
      return (proven) => {
        entry.proven = proven;
      };
    },
    verifier: verifierOf(world),
    relay: relayOf(world),
    oneclick: oneclickOf(world),
    quoteKey: TEST_QUOTE_KEY,
    now: () => world.mac,
    sleep: async (ms) => {
      world.mac += ms;
      world.chain += ms;
    },
    random: (n) => new Uint8Array(n).fill(9),
    firstPollMs: 250,
    pollMs: 3_000,
    ...over,
  });
  return h;
}

// Everything the claim left behind that a person, an agent or a disk could read.
function everythingWritten(h: Harness): string {
  const file = path.join(h.dataDir, CLAIMS_FILE);
  return [
    JSON.stringify(h.audit),
    JSON.stringify(h.frames),
    JSON.stringify(h.service.state()),
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
    JSON.stringify(h.world.published),
  ].join('\n');
}

function assertNoCode(text: string): void {
  const data = CODE.slice(5).replace(/-/g, '');
  for (const form of [CODE, CODE.toLowerCase(), data, data.toLowerCase(), Buffer.from(SECRET).toString('hex')]) {
    assert.ok(!text.includes(form), `the code reached somewhere it must not: ${form}`);
  }
}

test('a claim on the relay: rehearsed, then one signature published with no quote, proven, written, never executed', async () => {
  const h = harness();
  const answer = await h.service.claim(CODE);
  assert.equal(answer.ok, true);
  assert.ok(answer.ok && /^[0-9a-f]{16}$/.test(answer.claim));
  assert.equal(h.service.state()?.status, 'running');
  await h.service.idle();

  // A rehearsal simulated, then the claim itself published once with an empty quote_hashes and
  // never simulated: the two are the same transfer with different deadlines and nonces.
  assert.equal(h.world.simulated.length, 1);
  assert.equal(h.world.published.length, 1);
  const sent = h.world.published[0]!;
  assert.deepEqual(sent.quoteHashes, []);
  const rehearsed = JSON.parse(h.world.simulated[0]![0]!.payload) as { deadline: string; intents: unknown };
  assert.notEqual(sent.payload, h.world.simulated[0]![0]!.payload, 'the claim itself never went to the simulation');
  assert.deepEqual(rehearsed.intents, JSON.parse(sent.payload).intents);
  const body = JSON.parse(sent.payload) as { signer_id: string; deadline: string; nonce: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> };
  assert.equal(body.signer_id, CODE_ADDRESS);
  assert.equal(body.intents[0]!.receiver_id, WALLET_ID, 'the receiver is the decrypted address, lowercased');
  assert.equal(body.intents[0]!.tokens[INVITE_ASSET_ID], '5000000', 'the whole balance, exactly');

  // Landed: the audit line, the record, the refresh, the frame, the hold released with the amount.
  const claimed = h.audit.filter((e) => e.type === 'invite_claimed');
  assert.equal(claimed.length, 1);
  assert.deepEqual(
    { ...(claimed[0]!.data as Record<string, unknown>), claim: 'x' },
    { claim: 'x', codeAddress: CODE_ADDRESS, receiver: WALLET_ID, asset: 'USDC', amount: '5.00', intentHash: intentHashOf(sent.payload), route: 'relay' },
  );
  assert.equal(h.audit.filter((e) => e.type === 'executed').length, 0, 'never executed: no approval comes before a claim');
  assert.equal(h.refreshes, 1);
  // The hold opened right before the send, with the wallet's balance from a moment before.
  assert.deepEqual(h.holds, [{ asset: INVITE_ASSET_ID, walletBefore: 0n, proven: 5_000_000n }]);
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);
  assert.deepEqual(h.frames[1], { type: 'invite', kind: 'invite', claim: answer.ok ? answer.claim : '', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.deepEqual(h.service.state(), { claim: answer.ok ? answer.claim : '', status: 'landed', amount: '5.00' });
  const record = h.service.landed()[0]!;
  assert.equal(record.status, 'done');
  assert.equal(record.route, 'relay');
  assert.equal(record.creditedBase, '5000000');
  assert.equal(h.world.balances.get(WALLET_ID), 5_000_000n);
  assertNoCode(everythingWritten(h));
});

test("the deadline is the chain's clock plus two minutes even when this Mac runs up to two minutes slow", async () => {
  const world = freshWorld();
  world.mac = world.chain - 100_000;
  const h = harness({ world });
  const chainAtSign = world.chain;
  await h.service.claim(CODE);
  await h.service.idle();
  const body = JSON.parse(h.world.published[0]!.payload) as { deadline: string; nonce: string };
  assert.equal(Date.parse(body.deadline), chainAtSign + CLAIM_DEADLINE_MS);
  assert.equal(decodeNonce(body.nonce)!.deadlineMs, Date.parse(body.deadline) + 7 * 86_400_000);
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);
});

test('the pending record is on disk before the publish, and never holds the code', async () => {
  const world = freshWorld();
  const h = harness({ world });
  let onDisk: ClaimRecord[] = [];
  const relay = relayOf(world);
  const watching: RelayClient = {
    ...relay,
    async publishIntent(req) {
      onDisk = (JSON.parse(fs.readFileSync(path.join(h.dataDir, CLAIMS_FILE), 'utf8')) as { claims: ClaimRecord[] }).claims;
      return relay.publishIntent(req);
    },
  };
  const h2 = harness({ world, dataDir: h.dataDir, relay: watching });
  await h2.service.claim(CODE);
  await h2.service.idle();
  assert.equal(onDisk.length, 1);
  const pending = onDisk[0]!;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.codeAddress, CODE_ADDRESS);
  assert.equal(pending.amountBase, '5000000');
  // The rehearsal, then the claim itself: every signature the code's key made, before it left.
  assert.equal(pending.attempts.length, 2);
  assert.equal(pending.attempts[0]!.rehearsal, true);
  assert.equal(pending.attempts[0]!.nonce, JSON.parse(world.simulated[0]![0]!.payload).nonce);
  assert.equal(pending.attempts[1]!.rehearsal, undefined);
  assert.equal(pending.attempts[1]!.nonce, JSON.parse(world.published[0]!.payload).nonce);
  assert.equal(pending.attempts[1]!.intentHash, intentHashOf(world.published[0]!.payload));
  assertNoCode(JSON.stringify(onDisk));
  assertNoCode(fs.readFileSync(path.join(h.dataDir, CLAIMS_FILE), 'utf8'));
  const mode = fs.statSync(path.join(h.dataDir, CLAIMS_FILE)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('no reply: the identical bytes once more, never a second signature, then the proof by the nonce', async () => {
  const world = freshWorld();
  world.relayMode = 'noreply';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.published.length, 2, 'one resend');
  assert.deepEqual(world.published[1], world.published[0], 'of the same bytes');
  assert.equal(world.simulated.length, 1, 'signed once');
  assert.equal(world.oneclick.quotes, 0, 'and never a second route');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);
});

test('the watch runs to the deadline plus 30 s on the chain clock before it calls a claim failed', async () => {
  const world = freshWorld();
  world.executes = false;
  const h = harness({ world });
  await h.service.claim(CODE);
  const signedAt = world.chain;
  await h.service.idle();
  const deadline = signedAt + CLAIM_DEADLINE_MS;
  assert.ok(world.chain > deadline + 30_000, 'not before the chain is 30 s past the deadline');
  assert.ok(world.chain < deadline + 30_000 + 4_000, 'and not long after');
  const failed = h.audit.filter((e) => e.type === 'invite_failed');
  assert.equal(failed.length, 1);
  assert.equal((failed[0]!.data as { reason: string }).reason, 'expired');
  assert.match(failed[0]!.msg, /Nothing moved, and the money is still on the code/);
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  assert.deepEqual(h.holds, [{ asset: INVITE_ASSET_ID, walletBefore: 0n, proven: null }]);
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
  assert.equal(world.balances.get(CODE_ADDRESS), 5_000_000n, 'a failed claim loses nothing');
});

test("a wallet rise alone is not success, and dust on the code's address cannot stop a paid claim", async () => {
  const world = freshWorld();
  world.executes = false;
  const h = harness({ world });
  await h.service.claim(CODE);
  // A deposit lands in the wallet at the same moment; the claim itself never ran.
  world.balances.set(WALLET_ID, 5_000_000n);
  await h.service.idle();
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  assert.equal(h.audit.filter((e) => e.type === 'invite_claimed').length, 0);

  // Someone sends a base unit to the public code address between the signature and the proof.
  // The code never reads zero again, and the claim is still proven, by its nonce.
  const dusty = freshWorld();
  dusty.balances.set('0x00000000000000000000000000000000000d0057', 1_000n);
  const relay = relayOf(dusty);
  const h2 = harness({
    world: dusty,
    relay: {
      ...relay,
      async publishIntent(req) {
        dusty.queued.push({ at: dusty.mac + 500, t: { from: '0x00000000000000000000000000000000000d0057', to: CODE_ADDRESS, amount: 1n, nonce: 'dust' } });
        return relay.publishIntent(req);
      },
    },
  });
  await h2.service.claim(CODE);
  await h2.service.idle();
  assert.equal(dusty.balances.get(CODE_ADDRESS), 1n, 'the dust stays on the code');
  assert.deepEqual(h2.frames.map((f) => f.status), ['running', 'landed']);
  assert.equal(h2.audit.filter((e) => e.type === 'invite_claimed').length, 1);

  // Dust on a used code is not an invite: under a cent reads as empty, and nothing is signed.
  const used = freshWorld();
  used.balances.set(CODE_ADDRESS, 9_999n);
  const h3 = harness({ world: used });
  assert.deepEqual(await h3.service.check(CODE), { ok: false, reason: 'empty' });
  assert.deepEqual(await h3.service.claim(CODE), { ok: false, reason: 'empty' });
  assert.equal(used.simulated.length, 0);
});

test('Plan B only on a refusal to the first send: a resend refused after no reply signs nothing more', async () => {
  const world = freshWorld();
  world.relayMode = 'noreply-then-auth';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.published.length, 2, 'the one resend, refused');
  assert.equal(world.oneclick.quotes, 0, 'no second signature: the first send may be live');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed'], 'and it was: the first bytes ran');
});

test('a refused rehearsal stops the claim before its signature, in plain words, and the next start closes the record', async () => {
  for (const [refusal, reason, words] of [
    ['insufficient balance or overflow', 'empty', /holds nothing now/],
    ['account is locked', 'locked', /locked the code's account/],
    ['deadline has expired', 'expired', /passed its deadline/],
    ['V recovery byte 0 through 3 are valid but was provided 192', 'refused', /refused before anything moved/],
  ] as const) {
    const world = freshWorld();
    world.simRefusal = refusal;
    const h = harness({ world });
    const answer = await h.service.claim(CODE);
    assert.equal(answer.ok, true);
    await h.service.idle();
    assert.equal(world.published.length, 0, `${refusal}: nothing was published`);
    const failed = h.audit.find((e) => e.type === 'invite_failed')!;
    assert.equal((failed.data as { reason: string }).reason, reason);
    assert.match(failed.msg, words);
    assert.match((failed.data as { detail: string }).detail, /The claim itself was never signed/);
    assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
    // The rehearsal went to the RPC, so the record keeps it until a start proves it dead.
    const [kept] = createClaimStore(h.dataDir).all();
    assert.equal(kept!.status, 'pending');
    assert.deepEqual(kept!.attempts.map((a) => a.rehearsal), [true]);
    assertNoCode(everythingWritten(h));

    world.simRefusal = null;
    world.mac += 60_000;
    world.chain += 60_000;
    const next = harness({ world, dataDir: h.dataDir });
    next.service.reconcile();
    await next.service.idle();
    assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
    assert.deepEqual(next.frames, [], 'no toast at launch for it');
    assert.equal(world.balances.get(CODE_ADDRESS), 5_000_000n);
  }
});

test('the boot reconcile finishes a claim published before a quit', async () => {
  // First life: the claim is published and the app quits before the watch sees anything.
  const world = freshWorld();
  world.executeAfterMs = 60_000;
  const first = harness({ world });
  const quitting = harness({
    world,
    dataDir: first.dataDir,
    sleep: async () => {
      throw new Error('the app quit');
    },
  });
  await quitting.service.claim(CODE);
  await quitting.service.idle();
  const pending = createClaimStore(first.dataDir).all();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.status, 'pending', 'a quit leaves the record pending');
  assert.equal(quitting.audit.filter((e) => e.type === 'invite_claimed').length, 0);

  // Second life: the transfer ran while the app was down; the reconcile proves it and writes it.
  world.mac += 120_000;
  world.chain += 120_000;
  const second = harness({ world, dataDir: first.dataDir });
  second.service.reconcile();
  await second.service.idle();
  const claimed = second.audit.filter((e) => e.type === 'invite_claimed');
  assert.equal(claimed.length, 1);
  assert.equal((claimed[0]!.data as { codeAddress: string }).codeAddress, CODE_ADDRESS);
  assert.equal(createClaimStore(first.dataDir).all()[0]!.status, 'done');
  assert.equal(second.service.landed().length, 1, 'and an Activity row');
  assert.equal(second.refreshes, 1);
  assert.deepEqual(second.holds.map((x) => x.proven), [5_000_000n]);
  assert.deepEqual(second.frames.map((f) => f.status), ['landed'], 'money that arrived is worth a toast');

  // A record whose claim never ran ends failed once its deadline is past, and only then.
  const world2 = freshWorld();
  world2.executes = false;
  const dying = harness({ world: world2, sleep: async () => { throw new Error('the app quit'); } });
  await dying.service.claim(CODE);
  await dying.service.idle();
  const third = harness({ world: world2, dataDir: dying.dataDir });
  third.service.reconcile();
  await third.service.idle();
  assert.equal(createClaimStore(dying.dataDir).all()[0]!.status, 'failed');
  assert.equal((third.audit.find((e) => e.type === 'invite_failed')!.data as { reason: string }).reason, 'expired');
  assert.deepEqual(third.frames, [], 'no toast at launch about a claim from an earlier session');
  assert.equal(third.service.state(), null);

  // A pending record naming another receiver is not this wallet's to finish: left as it is.
  const world3 = freshWorld();
  world3.executeAfterMs = 60_000;
  const other = harness({ world: world3, sleep: async () => { throw new Error('the app quit'); } });
  await other.service.claim(CODE);
  await other.service.idle();
  const store = createClaimStore(other.dataDir);
  store.put({ ...store.all()[0]!, receiver: '0x2222222222222222222222222222222222222222' });
  world3.mac += 120_000;
  world3.chain += 120_000;
  const fourth = harness({ world: world3, dataDir: other.dataDir });
  fourth.service.reconcile();
  await fourth.service.idle();
  assert.equal(fourth.audit.length, 0, 'nothing written for a record that is not this wallet');
  assert.equal(createClaimStore(other.dataDir).all()[0]!.status, 'pending');
});

test('the wallet must be open and its address decrypted: locked, unverified or tampered refuses', async () => {
  for (const lock of [
    { state: 'locked' as const, verified: true, tampered: false },
    { state: 'unlocked' as const, verified: false, tampered: false },
    { state: 'unlocked' as const, verified: true, tampered: true },
  ]) {
    const h = harness();
    h.lock = lock;
    assert.deepEqual(await h.service.claim(CODE), { ok: false, reason: 'wallet-locked' });
    assert.equal(h.world.reads, 0, 'refused before any read');
    assert.equal(h.world.simulated.length, 0);
  }
});

test('typo, empty, locked, offline and busy, each before anything is signed', async () => {
  const h = harness();
  assert.deepEqual(await h.service.claim(CODE.slice(0, -1) + (CODE.endsWith('0') ? '1' : '0')), { ok: false, reason: 'typo' });
  assert.deepEqual(await h.service.check('PHOS-hello'), { ok: false, reason: 'typo' });
  assert.equal(h.world.reads, 0, 'a typo costs no network call');

  assert.deepEqual(await h.service.check(inviteLink(CODE)), { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' });

  const empty = harness();
  empty.world.balances.set(CODE_ADDRESS, 0n);
  assert.deepEqual(await empty.service.check(CODE), { ok: false, reason: 'empty' });
  assert.deepEqual(await empty.service.claim(CODE), { ok: false, reason: 'empty' });

  const locked = harness();
  locked.world.locked.add(CODE_ADDRESS);
  assert.deepEqual(await locked.service.check(CODE), { ok: false, reason: 'locked' });
  assert.deepEqual(await locked.service.claim(CODE), { ok: false, reason: 'locked' });

  const offline = harness();
  offline.world.offline = true;
  assert.deepEqual(await offline.service.check(CODE), { ok: false, reason: 'offline' });
  assert.deepEqual(await offline.service.claim(CODE), { ok: false, reason: 'offline' });

  const busy = harness();
  busy.world.executes = false;
  const first = await busy.service.claim(CODE);
  assert.equal(first.ok, true);
  assert.deepEqual(await busy.service.claim(CODE), { ok: false, reason: 'busy' });
  assert.deepEqual(await busy.service.check(CODE), { ok: false, reason: 'busy' });
  await busy.service.idle();
  for (const s of [h, empty, locked, offline, busy]) assertNoCode(everythingWritten(s));
});

test('demo mode moves nothing: a claim is refused before any read', async () => {
  const h = harness({ movesMoney: false });
  assert.deepEqual(await h.service.claim(CODE), { ok: false, reason: 'offline' });
  assert.equal(h.world.reads, 0);
});

test('a relay auth refusal falls back to Plan B with the 3 minute deadline, and the check says so', async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  const h = harness({ world });
  const answer = await h.service.claim(CODE);
  assert.equal(answer.ok, true);
  await h.service.idle();
  assert.equal(world.published.length, 1, 'the relay was asked once and refused');
  assert.equal(world.oneclick.submitted.length, 1, 'then 1Click took the claim');
  const submitted = JSON.parse(world.oneclick.submitted[0]!.payload) as { deadline: string; signer_id: string; intents: Array<{ receiver_id: string }> };
  assert.equal(submitted.signer_id, CODE_ADDRESS);
  assert.equal(submitted.intents[0]!.receiver_id, HANDLE);
  const lifeMs = Date.parse(submitted.deadline) - START;
  assert.ok(lifeMs <= SIGNED_DEADLINE_MS && lifeMs > SIGNED_DEADLINE_MS - 60_000, `the 72 hour deadline was cut to three minutes, got ${lifeMs} ms`);

  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);
  assert.equal(h.frames[1]!.amount, '4.98');
  const claimed = h.audit.find((e) => e.type === 'invite_claimed')!;
  assert.equal((claimed.data as { route: string }).route, 'oneclick');
  assert.match(claimed.msg, /through 1Click/);
  assert.deepEqual(h.holds.map((x) => x.proven), [4_987_500n]);
  const record = h.service.landed()[0]!;
  assert.equal(record.attempts.length, 3, 'the rehearsal, the refused relay attempt and the 1Click one');
  assert.equal(record.attempts[0]!.rehearsal, true);
  assert.equal(record.attempts[2]!.depositAddress, HANDLE);
  assertNoCode(everythingWritten(h));

  // From now on the check says where the money will come from, and what lands.
  const world2 = freshWorld();
  world2.relayMode = 'auth';
  const again = harness({ world: world2 });
  await again.service.claim(CODE);
  await again.service.idle();
  world2.balances.set(CODE_ADDRESS, 5_000_000n);
  assert.deepEqual(await again.service.check(CODE), { ok: true, amount: '5.00', asset: 'USDC', route: 'oneclick', net: '4.98' });
});

test("1Click's word for what landed is never more than the code held", async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  world.oneclick.settledOut = '999999.5';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(h.frames[1]!.amount, '5.00');
  assert.equal(h.service.landed()[0]!.creditedBase, '5000000');
});

test('a relay quote refusal falls back too, and any other refusal does not', async () => {
  const quote = freshWorld();
  quote.relayMode = 'quote';
  const h = harness({ world: quote });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(quote.oneclick.submitted.length, 1);
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);

  const other = freshWorld();
  other.relayMode = 'failed';
  const h2 = harness({ world: other });
  await h2.service.claim(CODE);
  await h2.service.idle();
  assert.equal(other.oneclick.quotes, 0, 'no second signature on a refusal Plan B does not answer');
  assert.deepEqual(h2.frames.map((f) => f.status), ['running', 'failed']);

  // No reply is never a reason to sign again either.
  const silent = freshWorld();
  silent.relayMode = 'noreply';
  silent.executes = false;
  const h3 = harness({ world: silent });
  await h3.service.claim(CODE);
  await h3.service.idle();
  assert.equal(silent.oneclick.quotes, 0);
});

test('Plan B refunded: the claim ends failed only once the refund shows on the code', async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  world.oneclick.status = 'REFUNDED';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.balances.get(CODE_ADDRESS), 4_990_000n, 'the refund is back on the code');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  const failed = h.audit.find((e) => e.type === 'invite_failed')!;
  assert.equal((failed.data as { reason: string }).reason, 'refunded');
  assert.match(failed.msg, /back on it/);
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
  assert.deepEqual(h.holds.map((x) => x.proven), [null]);
});

test("Plan B FAILED with the refund not back yet never closes on 1Click's word", async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  world.oneclick.status = 'FAILED';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.balances.get(CODE_ADDRESS), 0n, 'the money sits on the handle');
  const failed = h.audit.find((e) => e.type === 'invite_failed')!;
  assert.equal((failed.data as { reason: string }).reason, 'unconfirmed');
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'pending', 'left for the next start to finish');
  assert.equal(h.holds[0]!.proven, undefined, 'the hold stays: the money may still land');
});

test('Plan B stopping before its signature watches the refused relay claim to its end', async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  world.oneclick.quoteFails = true;
  const h = harness({ world });
  const signedAt = world.chain;
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.oneclick.submitted.length, 0, 'nothing was signed on Plan B');
  assert.ok(world.chain > signedAt + CLAIM_DEADLINE_MS + 30_000, 'closed only once the relay claim was proved dead');
  const failed = h.audit.find((e) => e.type === 'invite_failed')!;
  assert.equal((failed.data as { reason: string }).reason, 'expired');
  assert.match((failed.data as { detail: string }).detail, /1Click stopped the claim before signing/);
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
});

/* Audit L5: the NEAR RPC is someone else's computer. Whatever it is handed to simulate, it can keep
   and publish, and it can answer anything. The claim hands it only a rehearsal that dies a
   millisecond past the block it is simulated at, written to the record first. */

test('the RPC never holds claim bytes that can still run: only a rehearsal, on disk first, dying a millisecond past its block', async () => {
  const world = freshWorld();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-'));
  const v = verifierOf(world);
  const seen: Array<{ payload: string; at: string | undefined; onDisk: boolean }> = [];
  const verifier = {
    ...v,
    async simulate(signed: Array<{ standard: string; payload: string; signature: string }>, at?: string) {
      const file = path.join(dataDir, CLAIMS_FILE);
      const records = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { claims: ClaimRecord[] }).claims : [];
      for (const s of signed) {
        const nonce = (JSON.parse(s.payload) as { nonce: string }).nonce;
        seen.push({ payload: s.payload, at, onDisk: records.some((r) => r.attempts.some((a) => a.nonce === nonce)) });
      }
      return v.simulate!(signed, at);
    },
  };
  const h = harness({ world, dataDir, verifier });
  const chainAtRehearsal = world.chain;
  await h.service.claim(CODE);
  await h.service.idle();
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'landed']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.onDisk, true, 'the rehearsal was on disk before the RPC saw it');
  assert.equal(seen[0]!.at, `block${chainAtRehearsal}`, 'simulated at the block its deadline is counted from');
  assert.equal(Date.parse((JSON.parse(seen[0]!.payload) as { deadline: string }).deadline), chainAtRehearsal + 1);
  assert.ok(!seen.some((s) => s.payload === world.published[0]!.payload), 'the claim itself was handed to the RPC');
});

test('an RPC that keeps what it simulates and publishes it while saying nothing: the rehearsal cannot run, and the record is kept', async () => {
  const world = freshWorld();
  const v = verifierOf(world);
  const verifier = {
    ...v,
    async simulate(signed: Array<{ payload: string }>) {
      for (const s of signed) world.queued.push({ at: world.mac + 5_000, t: transferOf(s.payload) });
      return null;
    },
  };
  const h = harness({ world, verifier: verifier as never });
  assert.equal((await h.service.claim(CODE)).ok, true);
  await h.service.idle();
  world.mac += 10_000;
  world.chain += 10_000;
  await v.balance(WALLET_ID, INVITE_ASSET_ID);
  assert.equal(world.balances.get(WALLET_ID) ?? 0n, 0n, 'nothing the RPC kept could run');
  assert.equal(world.balances.get(CODE_ADDRESS), 5_000_000n);
  assert.equal(world.published.length, 0, 'the claim itself was never signed or sent');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  assert.equal((h.audit.find((e) => e.type === 'invite_failed')!.data as { reason: string }).reason, 'offline');
  const [kept] = createClaimStore(h.dataDir).all();
  assert.equal(kept!.status, 'pending');
  assert.deepEqual(kept!.attempts.map((a) => a.rehearsal), [true, true, true], 'three blocks tried, each rehearsal written first');

  // The next start proves every rehearsal dead and closes the record without a toast; the code
  // still holds its money, so the person can add it again.
  world.mac += 60_000;
  world.chain += 60_000;
  const next = harness({ world, dataDir: h.dataDir });
  next.service.reconcile();
  await next.service.idle();
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
  assert.deepEqual(next.frames, []);
  const again = harness({ world, dataDir: h.dataDir });
  assert.equal((await again.service.claim(CODE)).ok, true);
  await again.service.idle();
  assert.deepEqual(again.frames.map((f) => f.status), ['running', 'landed']);
});

test('an RPC that lies about the time and runs a rehearsal anyway pays only this wallet, and the claim is still proven', async () => {
  // Its final block is stamped a minute ahead of real time (inside the two minutes this Mac's clock
  // allows), so the rehearsal it keeps lives a minute; it says nothing and publishes it 5 s later.
  const world = freshWorld();
  const v = verifierOf(world);
  const lying = {
    ...v,
    finalBlock: async () => ({ hash: `block${world.mac + 60_000}`, atMs: world.mac + 60_000 }),
    async simulate(signed: Array<{ payload: string }>) {
      for (const s of signed) world.queued.push({ at: world.mac + 5_000, t: transferOf(s.payload) });
      return null;
    },
  };
  const h = harness({ world, verifier: lying as never });
  await h.service.claim(CODE);
  await h.service.idle();
  world.mac += 10_000;
  world.chain += 10_000;
  await v.balance(WALLET_ID, INVITE_ASSET_ID);
  assert.equal(world.balances.get(WALLET_ID), 5_000_000n, 'it ran, and the wallet is the only payee it can name');
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed'], 'the window was told what the RPC said');
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'pending', 'but nothing was written as over');

  // The next start, with an RPC that answers truly, finds the rehearsal's nonce spent.
  const next = harness({ world, dataDir: h.dataDir });
  next.service.reconcile();
  await next.service.idle();
  assert.equal(next.audit.filter((e) => e.type === 'invite_claimed').length, 1);
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'done');
  assert.equal(next.service.landed().length, 1, 'and an Activity row');
});

test('a final block stamped more than two minutes ahead of this Mac is refused before anything is signed', async () => {
  const YEAR = 365 * 86_400_000;
  for (const [name, stamp] of [
    ['an RPC a year ahead', (w: World) => w.mac + YEAR],
    ['this Mac ten minutes slow', (w: World) => w.mac + 10 * 60_000],
  ] as const) {
    const world = freshWorld();
    const v = verifierOf(world);
    const h = harness({ world, verifier: { ...v, finalBlock: async () => ({ hash: 'ahead', atMs: stamp(world) }) } });
    await h.service.claim(CODE);
    await h.service.idle();
    assert.equal(world.simulated.length, 0, `${name}: something was simulated`);
    assert.equal(world.published.length, 0, `${name}: something was published`);
    assert.equal(createClaimStore(h.dataDir).all().length, 0, `${name}: nothing was signed, so nothing is pending`);
    const failed = h.audit.find((e) => e.type === 'invite_failed')!;
    assert.equal((failed.data as { reason: string }).reason, 'clock');
    assert.match(failed.msg, /this Mac's clock is more than two minutes behind NEAR's, so the claim was never signed/);
    assert.match((failed.data as { detail: string }).detail, /ahead of this Mac's clock/);
    assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
    // The window is told why, so it can say how to fix it; the state carries it for a window opened late.
    assert.equal(h.frames[1]!.reason, 'clock', name);
    assert.equal(h.service.state()?.reason, 'clock', name);
  }

  // The claim itself is signed off the block its rehearsal passed at: no second read for an RPC to
  // move, and a deadline exactly two minutes past that block.
  const world = freshWorld();
  const h = harness({ world });
  const chainAtRehearsal = world.chain;
  await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(world.reads > 0, true);
  assert.equal(Date.parse(JSON.parse(world.published[0]!.payload).deadline as string), chainAtRehearsal + CLAIM_DEADLINE_MS);
  assert.equal(Date.parse(JSON.parse(world.simulated[0]![0]!.payload).deadline as string), chainAtRehearsal + 1);
});

/* Audit L6: the key's hex is an immutable string inside viem's account, so it cannot be wiped; what
   the claim can do is let go of it the moment it can sign nothing more, instead of holding it
   through a watch that runs for minutes. */

test("the code's key is dropped once it can sign nothing more: before the watch on the relay, right after Plan B's one signature, or when Plan B stops unsigned", async () => {
  for (const mode of ['ok', 'auth', 'auth, 1Click down'] as const) {
    const world = freshWorld();
    world.relayMode = mode === 'ok' ? 'ok' : 'auth';
    world.oneclick.quoteFails = mode === 'auth, 1Click down';
    let dropped = false;
    let signatures = 0;
    const signerOf = (secret: Uint8Array): KeySigner | null => {
      const inner = codeSigner(secret);
      if (inner === null) return null;
      return {
        address: inner.address,
        sign: async (payload) => {
          signatures += 1;
          return inner.sign(payload);
        },
        drop: () => {
          dropped = true;
          inner.drop();
        },
      };
    };
    const held: string[] = [];
    const v = verifierOf(world);
    const verifier = { ...v, nonceUsed: (...args: Parameters<typeof v.nonceUsed>) => (dropped || held.push('the watch read a nonce with the key held'), v.nonceUsed(...args)) };
    const oc = oneclickOf(world);
    const oneclick = { ...oc, status: (...args: Parameters<typeof oc.status>) => (dropped || held.push("1Click's watch ran with the key held"), oc.status(...args)) };
    const h = harness({ world, verifier, oneclick, signerOf });
    await h.service.claim(CODE);
    await h.service.idle();
    assert.deepEqual(h.frames.map((f) => f.status), ['running', mode === 'auth, 1Click down' ? 'failed' : 'landed'], mode);
    assert.equal(dropped, true, `${mode}: the key was never dropped`);
    assert.deepEqual(held, [], `${mode}: ${held[0] ?? ''}`);
    assert.equal(signatures, mode === 'auth' ? 3 : 2, `${mode}: the rehearsal, the relay claim, and Plan B's one signature when it signs`);
  }
});

test('a claim that goes straight to Plan B asks the clock too: a Mac more than two minutes behind is told so, with nothing quoted or signed', async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  let behind = 0;
  const v = verifierOf(world);
  const h = harness({ world, verifier: { ...v, finalBlock: async () => ({ hash: `block${world.chain + behind}`, atMs: world.chain + behind }) } });
  // The relay turns the first claim away for auth, Plan B lands it, and later claims skip the relay.
  const first = await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(first.ok, true);
  assert.equal(h.frames.at(-1)?.status, 'landed');
  const quotes = world.oneclick.quotes;
  const relayed = world.published.length;

  // The code is paid again, and this Mac's clock is now ten minutes behind NEAR's.
  world.balances.set(CODE_ADDRESS, 5_000_000n);
  behind = 10 * 60_000;
  const second = await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(second.ok, true);
  assert.equal(world.oneclick.quotes, quotes, 'nothing was quoted');
  assert.equal(world.published.length, relayed, 'nothing went to the relay');
  assert.equal(world.balances.get(CODE_ADDRESS), 5_000_000n, 'the money is still on the code');
  assert.deepEqual(h.frames.at(-1), { type: 'invite', kind: 'invite', claim: second.ok ? second.claim : '', status: 'failed', amount: '5.00', asset: 'USDC', reason: 'clock' });
  const failed = h.audit.filter((e) => e.type === 'invite_failed').at(-1)!;
  assert.equal((failed.data as { reason: string }).reason, 'clock');

  // A clock right again: the same code claims through Plan B as before.
  behind = 0;
  const third = await h.service.claim(CODE);
  await h.service.idle();
  assert.equal(third.ok, true);
  assert.equal(h.frames.at(-1)?.status, 'landed');
  assert.equal(h.frames.at(-1)?.reason, undefined);
});
