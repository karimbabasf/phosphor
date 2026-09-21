// kill -9 at every stage of a relay swap, and what the boot sweep and reconciliation make of
// the row the dead process left: nothing lost, nothing signed twice, and a verdict the verifier
// or the relay can stand behind. One test per stage the rail reports through its hooks
// (src/rails/intents-relay.ts): signed but not published, published and PENDING, on NEAR
// (TX_BROADCASTED), settled with the balance not yet read, and settling with a pocket.
//
// The relay and the verifier are fixtures with no signer and no publish in them at all, which
// is the whole of "signs nothing twice": reconciliation has no key to reach for.
//
// Run: node --test tests/unit/reconcile-relay.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, RailEvidence } from '../../src/types.ts';
import type { RelayLookup } from '../../src/rails/index.ts';
import type { RelayStatus } from '../../src/relay/client.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { RELAY_DEADLINE_GRACE_MS } from '../../src/proposals/reconcile.ts';
import { makeCtx, SELF_EVM } from './helpers/proposals.ts';
import type { Harness } from './helpers/proposals.ts';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDT = 'nep141:usdt.tether-token.near';
const INTENT_HASH = 'GoiKQ5gPe5Ne2kT8mtL7c4qHKMjbdpMJhJ8dv1S3CYbM';
const NEAR_TX = '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj';
const NONCE = 'Vij2xgAlKBKzADZykFdbpB8CcBXsE9wRhklzE4/mgS8=';
const RELAY_QUOTE = { quoteHash: 'Cw6dV7MV3NvKRNrXjLpymkWneBzuhTjrgEYuQLwnnCg6', amountIn: '2000000', amountOut: '1961996', expiration: '2026-09-20T12:01:00.000Z' };

function future(): string {
  return new Date(Date.now() + 90_000).toISOString();
}
function past(): string {
  return new Date(Date.now() - RELAY_DEADLINE_GRACE_MS - 60_000).toISOString();
}

type Fixture = {
  status?: RelayStatus | Error;
  nonceUsed?: boolean | null;
  saltValid?: boolean | null; // what the verifier says of the nonce's salt; default true
};

type Rig = Harness & { asked: { status: string[]; nonce: Array<{ account: string; nonce: string }>; salt: string[] } };

function statusOf(status: string, over: Partial<RelayStatus> = {}): RelayStatus {
  return { intentHash: INTENT_HASH, status, statusDetails: null, nearTxHash: null, filledAmounts: [], ...over };
}

function rig(fixture: Fixture = {}, wire = true): Rig {
  const asked = { status: [] as string[], nonce: [] as Array<{ account: string; nonce: string }>, salt: [] as string[] };
  const relay: RelayLookup = {
    async status(hash) {
      asked.status.push(hash);
      const answer = fixture.status ?? statusOf('PENDING');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async nonceUsed(account, nonce) {
      asked.nonce.push({ account, nonce });
      return fixture.nonceUsed === undefined ? false : fixture.nonceUsed;
    },
    async saltValid(salt) {
      asked.salt.push(Buffer.from(salt).toString('hex'));
      return fixture.saltValid === undefined ? true : fixture.saltValid;
    },
  };
  const h = makeCtx({ deps: { rails: { for: () => null, kinds: () => [], ...(wire ? { relay } : {}) } } });
  return { ...h, asked };
}

// The row as the executor wrote it the moment the rail's hook fired, before the process died.
function seed(h: Harness, over: { status?: Proposal['status']; txids?: string[]; evidence: RailEvidence; pocket?: Proposal['pocket']; detail?: string }): Proposal {
  const p: Proposal = {
    id: 'relay-1',
    kind: 'swap',
    createdAt: new Date().toISOString(),
    status: over.status ?? 'executing',
    draft: {
      kind: 'swap',
      venue: 'intents-relay',
      chain: 'near',
      toChain: 'near',
      fromSymbol: 'USDC',
      toSymbol: 'USDT',
      amountIn: 2,
      amountUsd: 2,
      minAmountOut: 1.95,
      from: SELF_EVM.toLowerCase(),
      to: SELF_EVM.toLowerCase(),
      counterparty: 'intents.near',
      quote: null,
    },
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    decidedBy: 'policy',
    decidedAt: new Date().toISOString(),
    result: { ok: false, detail: over.detail ?? 'submitted, waiting for the venue', txids: over.txids ?? [], evidence: over.evidence },
    ...(over.pocket === undefined ? {} : { pocket: over.pocket }),
  };
  h.store.put(p);
  return p;
}

// ---------- stage: signed, not yet published (the hook wrote nonce and deadline) ----------

test('killed after the signature: the boot sweep keeps the nonce, and an unspent nonce inside its deadline waits', async () => {
  const h = rig({ nonceUsed: false });
  seed(h, { evidence: { nonce: NONCE, deadline: future(), relayQuote: RELAY_QUOTE } });
  const moved = h.svc.reconcileOnBoot();
  assert.equal(moved.length, 1);
  assert.equal(moved[0].status, 'needs_reconciliation');
  assert.equal(moved[0].result?.evidence?.nonce, NONCE, 'the nonce survives the sweep');
  assert.match(moved[0].result?.detail ?? '', /The intent is signed, with its deadline at/);
  assert.match(moved[0].result?.detail ?? '', /the verifier is asked whether it executed/);

  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /nonce unspent and the deadline .* has not passed, so the swap can still execute/);
  assert.deepEqual(h.asked.status, [], 'no hash, so the relay is not asked');
  assert.deepEqual(h.asked.nonce, [{ account: SELF_EVM.toLowerCase(), nonce: NONCE }]);
});

test('killed after the signature: an unspent nonce past its deadline is failed, nothing lost, once the salt is still valid', async () => {
  const h = rig({ nonceUsed: false, saltValid: true });
  seed(h, { evidence: { nonce: NONCE, deadline: past(), relayQuote: RELAY_QUOTE } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'failed');
  assert.equal(out.result?.ok, false);
  assert.match(out.result?.detail ?? '', /passed with the nonce unspent, so the swap never executed and nothing left the balance/);
  assert.deepEqual(h.asked.salt, ['252812b3'], 'the salt in the nonce is checked before "unspent" is believed');
  assert.ok(h.eventTypes().includes('error'), 'the verdict is on the audit log');
});

/* The contract prunes a SPENT nonce once its salt is rotated out (garbage_collector.rs:
   is_nonce_cleanable is "deadline passed or salt invalid"), after which is_nonce_used answers
   false for a swap that executed. A retired salt therefore gives no verdict at all. */
test('killed after the signature: a nonce whose salt the verifier has retired gets no verdict, never "nothing left the balance"', async () => {
  const h = rig({ nonceUsed: false, saltValid: false });
  seed(h, { evidence: { nonce: NONCE, deadline: past(), relayQuote: RELAY_QUOTE } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /the verifier has retired the key of that price window/);
  assert.match(out.result?.detail ?? '', /The balance read decides/);
  assert.equal((out.result?.detail ?? '').includes('nothing left the balance'), false);

  const silent = rig({ nonceUsed: false, saltValid: null });
  seed(silent, { evidence: { nonce: NONCE, deadline: past(), relayQuote: RELAY_QUOTE } });
  silent.svc.reconcileOnBoot();
  const held = await silent.svc.reconcile('relay-1');
  assert.equal(held.status, 'needs_reconciliation');
  assert.match(held.result?.detail ?? '', /did not answer whether that salt is still valid/);
});

test('killed after the signature: a spent nonce means the swap executed', async () => {
  const h = rig({ nonceUsed: true });
  seed(h, { evidence: { nonce: NONCE, deadline: past(), relayQuote: RELAY_QUOTE } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.ok, true);
  assert.match(out.result?.detail ?? '', /nonce spent, so the swap executed at the signed diff \(1961996 base units out\)/);
  assert.ok(h.eventTypes().includes('executed'));
});

test('killed after the signature: a verifier that does not answer changes nothing', async () => {
  const h = rig({ nonceUsed: null });
  seed(h, { evidence: { nonce: NONCE, deadline: past() } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /did not answer whether the nonce was spent/);
});

// ---------- stage: published, PENDING (the hook wrote the intent hash) ----------

test('killed while PENDING: the relay is asked by the hash, its word goes on the row, and the row waits', async () => {
  const h = rig({ status: statusOf('PENDING') });
  seed(h, { txids: [INTENT_HASH], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'PENDING', relayQuote: RELAY_QUOTE } });
  const moved = h.svc.reconcileOnBoot();
  assert.match(moved[0].result?.detail ?? '', /signed and published/);
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.equal(out.result?.evidence?.providerStage, 'PENDING');
  assert.match(out.result?.detail ?? '', /The relay reports PENDING\. Nothing has changed/);
  assert.deepEqual(h.asked.status, [INTENT_HASH]);
  assert.deepEqual(h.asked.nonce, [], 'a relay word that is not an ending asks nothing of the verifier');
});

test('killed while PENDING: the relay saying SETTLED with the NEAR hash settles the row with the link once the verifier shows the nonce spent', async () => {
  const h = rig({ status: statusOf('SETTLED', { nearTxHash: NEAR_TX }), nonceUsed: true });
  seed(h, { txids: [INTENT_HASH], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'PENDING', relayQuote: RELAY_QUOTE } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'executed');
  assert.deepEqual(out.result?.txids, [INTENT_HASH, NEAR_TX]);
  assert.equal(out.result?.evidence?.explorerUrl, `https://nearblocks.io/txns/${NEAR_TX}`);
  assert.equal(out.result?.evidence?.providerStage, 'SETTLED');
  assert.match(out.result?.detail ?? '', /settled on NEAR \(NEAR tx 8yFNEk/);
  assert.match(out.result?.detail ?? '', /amount out is the signed 1961996 base units/);
  const view = h.svc.view(out);
  assert.equal(view.stage, 'confirmed');
  assert.equal(view.txs.at(-1)?.explorer, `https://nearblocks.io/txns/${NEAR_TX}`, 'the terminal row carries the link');
});

test('killed while PENDING: the relay saying not valid hands the question to the verifier, and past the deadline the row fails', async () => {
  const h = rig({ status: statusOf('NOT_FOUND_OR_NOT_VALID', { statusDetails: 'expired' }), nonceUsed: false });
  seed(h, { txids: [INTENT_HASH], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: past(), providerStage: 'PENDING' } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'failed');
  assert.match(out.result?.detail ?? '', /nonce unspent, so the swap never executed/);
  assert.match(out.result?.detail ?? '', /The relay reports NOT_FOUND_OR_NOT_VALID/);
  assert.deepEqual(h.asked.status, [INTENT_HASH]);
  assert.equal(h.asked.nonce.length, 1);
});

test('killed while PENDING: a relay that cannot be asked changes nothing and says so', async () => {
  const h = rig({ status: new Error('relay get_status failed: 503') });
  seed(h, { txids: [INTENT_HASH], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future() } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /The relay could not be asked \(relay get_status failed: 503\)/);
});

// ---------- stage: TX_BROADCASTED (the hook wrote the NEAR hash and the link) ----------

test('killed while TX_BROADCASTED: the NEAR hash and link survive the sweep, and SETTLED lands the row executed', async () => {
  const h = rig({ status: statusOf('SETTLED', { nearTxHash: NEAR_TX }), nonceUsed: true });
  seed(h, {
    txids: [INTENT_HASH, NEAR_TX],
    evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'TX_BROADCASTED', explorerUrl: `https://nearblocks.io/txns/${NEAR_TX}` },
  });
  const moved = h.svc.reconcileOnBoot();
  assert.deepEqual(moved[0].result?.txids, [INTENT_HASH, NEAR_TX]);
  assert.equal(moved[0].result?.evidence?.explorerUrl, `https://nearblocks.io/txns/${NEAR_TX}`);
  assert.equal(h.svc.view(moved[0]).stage, 'TX_BROADCASTED', 'the relay word still drives the stage');
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'executed');
  assert.deepEqual(out.result?.txids, [INTENT_HASH, NEAR_TX], 'the hash is not duplicated');
});

// ---------- stage: SETTLED, balance not yet read; and settling with a pocket ----------

test('killed at SETTLED before the balance read: the relay word settles a row with no pocket only once the verifier shows the nonce spent', async () => {
  const spent = rig({ status: statusOf('SETTLED', { nearTxHash: NEAR_TX }), nonceUsed: true });
  seed(spent, { txids: [INTENT_HASH, NEAR_TX], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'SETTLED' } });
  spent.svc.reconcileOnBoot();
  const out = await spent.svc.reconcile('relay-1');
  assert.equal(out.status, 'executed');
  assert.deepEqual(spent.asked.nonce, [{ account: SELF_EVM.toLowerCase(), nonce: NONCE }], 'the relay word is checked against the chain');

  /* The relay's word alone is not the chain's. SETTLED with the nonce still unspent (a view a
     block behind, or a relay that is wrong) stays unconfirmed and says which of the two has
     not answered, and the next sweep asks again. */
  const lagging = rig({ status: statusOf('SETTLED', { nearTxHash: NEAR_TX }), nonceUsed: false });
  seed(lagging, { txids: [INTENT_HASH, NEAR_TX], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'SETTLED' } });
  lagging.svc.reconcileOnBoot();
  const held = await lagging.svc.reconcile('relay-1');
  assert.equal(held.status, 'needs_reconciliation');
  assert.match(held.result?.detail ?? '', /The relay reports the swap settled .*the verifier has not shown the nonce spent/);
  assert.equal(held.result?.evidence?.providerStage, 'SETTLED');
});

test('an unspent nonce inside the grace after the deadline waits: the deadline is minted from this clock, not the chain', async () => {
  const h = rig({ nonceUsed: false });
  seed(h, { evidence: { nonce: NONCE, deadline: new Date(Date.now() - RELAY_DEADLINE_GRACE_MS + 30_000).toISOString() } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /can still execute/);
  assert.ok(RELAY_DEADLINE_GRACE_MS >= 5 * 60_000, 'five minutes of clock skew before an unspent nonce is called dead');
});

test('a nonce whose own life has passed never yields failed: the contract may have pruned it', async () => {
  const h = rig({ nonceUsed: false });
  const pruned = buildNonce({ salt: Uint8Array.from([0x25, 0x28, 0x12, 0xb3]), deadlineMs: Date.now() - 60_000, random: new Uint8Array(15) });
  seed(h, { evidence: { nonce: pruned, deadline: past() } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /nonce's own life .* has passed/);
  assert.match(out.result?.detail ?? '', /Compare the balances/);
});

test('a settling row with a pocket is judged by its balance first and waits for the rise even when the relay says SETTLED', async () => {
  const h = rig({ status: statusOf('SETTLED', { nearTxHash: NEAR_TX }), nonceUsed: true });
  const pocket = { venue: 'intents' as const, account: SELF_EVM.toLowerCase(), assetId: USDT, symbol: 'USDT', decimals: 6, before: '1000000', after: null, floor: '1961800' };
  seed(h, {
    status: 'needs_reconciliation',
    txids: [INTENT_HASH, NEAR_TX],
    evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'SETTLED' },
    pocket,
    detail: 'The solver reports the swap settled and the balance has not shown it yet.',
  });
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation', 'the balance, not the word, is what "done" means');
  assert.match(out.result?.detail ?? '', /The balance has not shown the rise yet/);
  assert.equal(out.pocket?.after, null);
  void USDC;
});

// ---------- the sweep and the wiring ----------

test('the scheduled sweep picks up a relay row that carries only a nonce', async () => {
  const h = rig({ nonceUsed: false });
  seed(h, { evidence: { nonce: NONCE, deadline: past() } });
  h.svc.reconcileOnBoot();
  const changed = await h.svc.reconcileOpen();
  assert.equal(changed, 1);
  assert.equal(h.store.get('relay-1')?.status, 'failed');
});

test('with no relay read wired the row stays as it is and says so, and nothing is asked', async () => {
  const h = rig({}, false);
  seed(h, { evidence: { nonce: NONCE, deadline: past() } });
  h.svc.reconcileOnBoot();
  const out = await h.svc.reconcile('relay-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /No relay read is wired in live mode/);
  assert.deepEqual(h.asked.status, []);
  assert.deepEqual(h.asked.nonce, []);
});

test('re-checking a row nothing has changed on writes nothing and logs nothing', async () => {
  const h = rig({ status: statusOf('PENDING') });
  seed(h, { txids: [INTENT_HASH], evidence: { handle: INTENT_HASH, nonce: NONCE, deadline: future(), providerStage: 'PENDING' } });
  h.svc.reconcileOnBoot();
  const first = await h.svc.reconcile('relay-1');
  const lines = h.eventTypes().length;
  const second = await h.svc.reconcile('relay-1');
  assert.deepEqual(second, first);
  assert.equal(h.eventTypes().length, lines, 'the ten-minute sweep must not pile up audit lines');
});
