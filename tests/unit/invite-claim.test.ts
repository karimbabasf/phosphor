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
  verifierOf,
} from './helpers/invite-world.ts';
import type { World } from './helpers/invite-world.ts';

type Harness = {
  world: World;
  service: ReturnType<typeof createInviteService>;
  audit: Array<{ type: string; msg: string; data: unknown }>;
  frames: Array<Record<string, unknown>>;
  holds: Array<{ asset: string; proven?: bigint | null }>;
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
    hold: (asset) => {
      const entry: { asset: string; proven?: bigint | null } = { asset };
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

test('a claim on the relay: one signature, simulated, published with no quote, proven, written, never executed', async () => {
  const h = harness();
  const answer = await h.service.claim(CODE);
  assert.equal(answer.ok, true);
  assert.ok(answer.ok && /^[0-9a-f]{16}$/.test(answer.claim));
  assert.equal(h.service.state()?.status, 'running');
  await h.service.idle();

  // One signed payload, simulated first, then published once with an empty quote_hashes.
  assert.equal(h.world.simulated.length, 1);
  assert.equal(h.world.published.length, 1);
  const sent = h.world.published[0]!;
  assert.deepEqual(sent.quoteHashes, []);
  assert.equal(sent.payload, h.world.simulated[0]![0]!.payload);
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
  assert.deepEqual(h.holds, [{ asset: INVITE_ASSET_ID, proven: 5_000_000n }]);
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

test("the deadline is the chain's clock plus two minutes even when this Mac runs slow", async () => {
  const world = freshWorld();
  world.mac = world.chain - 10 * 60_000;
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
  assert.equal(pending.attempts.length, 1);
  assert.equal(pending.attempts[0]!.nonce, JSON.parse(world.published[0]!.payload).nonce);
  assert.equal(pending.attempts[0]!.intentHash, intentHashOf(world.published[0]!.payload));
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
  assert.deepEqual(h.holds, [{ asset: INVITE_ASSET_ID, proven: null }]);
  assert.equal(createClaimStore(h.dataDir).all()[0]!.status, 'failed');
  assert.equal(world.balances.get(CODE_ADDRESS), 5_000_000n, 'a failed claim loses nothing');
});

test("a wallet rise alone is not success: proof is the code's nonce plus the code's balance", async () => {
  const world = freshWorld();
  world.executes = false;
  const h = harness({ world });
  await h.service.claim(CODE);
  // A deposit lands in the wallet at the same moment; the claim itself never ran.
  world.balances.set(WALLET_ID, 5_000_000n);
  await h.service.idle();
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  assert.equal(h.audit.filter((e) => e.type === 'invite_claimed').length, 0);

  // The nonce spent but the code's balance not down yet (a read a block behind): still waiting,
  // and read again until the fall shows.
  const world2 = freshWorld();
  let stale = 0;
  const live = verifierOf(world2);
  const lagging = harness({
    world: world2,
    verifier: {
      ...live,
      balance: async (account, asset) => {
        const real = await live.balance(account, asset);
        if (account === CODE_ADDRESS && world2.published.length > 0 && stale < 3) {
          stale += 1;
          return 5_000_000n;
        }
        return real;
      },
    },
  });
  await lagging.service.claim(CODE);
  await lagging.service.idle();
  assert.equal(stale, 3, 'three reads still showed the code full');
  assert.deepEqual(lagging.frames.map((f) => f.status), ['running', 'landed']);
});

test('simulate refusals stop the claim before anything is sent, in plain words', async () => {
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
    assert.equal(createClaimStore(h.dataDir).all().length, 0, 'no pending record for a claim never sent');
    assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
    assertNoCode(everythingWritten(h));
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
  assert.equal(record.attempts.length, 2, 'the refused relay attempt and the 1Click one');
  assert.equal(record.attempts[1]!.depositAddress, HANDLE);
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

test('Plan B refunded: the money is back on the code and the claim ends failed', async () => {
  const world = freshWorld();
  world.relayMode = 'auth';
  world.oneclick.status = 'REFUNDED';
  const h = harness({ world });
  await h.service.claim(CODE);
  await h.service.idle();
  assert.deepEqual(h.frames.map((f) => f.status), ['running', 'failed']);
  assert.equal((h.audit.find((e) => e.type === 'invite_failed')!.data as { reason: string }).reason, 'refunded');
});
