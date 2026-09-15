// What a rail's answer becomes on the row, and what the day is charged for it.
//
// Every ok:false used to land `failed`, whatever hashes it carried. On 2026-09-15 two $10
// Hyperliquid deposits were reported FAILED by 1Click with the intent hash on each; both rows
// said failed, neither counted against the 24 hour cap, the receipt said nothing left the
// wallet, and about $40 had left the intents balance. A hash is evidence that money moved, and
// a row with one is unconfirmed, not failed: it counts, it can be reconciled, and it never says
// nothing happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { landed, makeCtx, railThat } from './helpers/proposals.ts';

test('a rail that failed with a hash lands unconfirmed, charged to the day, with its evidence kept', async () => {
  const h = makeCtx({
    rails: [railThat('hl_deposit', async () => ({ ok: false, detail: '1click reported FAILED', txids: ['intent-h1'], evidence: { handle: 'dep-1', refundedAmount: '0' } }))],
  });
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.verdict.outcome, 'allow');
  assert.equal(p.status, 'needs_reconciliation');
  assert.equal(p.result?.ok, false);
  assert.deepEqual(p.result?.txids, ['intent-h1']);
  assert.equal(p.result?.evidence?.handle, 'dep-1');
  assert.equal(p.result?.evidence?.refundedAmount, '0');
  assert.ok(typeof p.settledAt === 'string' && Date.parse(p.settledAt) > 0, 'the row is stamped when the rail answered');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10, 'the $10 that left the balance is charged');
  assert.equal(h.svc.sessionSpentUsd(), 10);
  assert.ok(h.eventTypes().includes('execution_unconfirmed'), `the log says unconfirmed, not failed: ${h.eventTypes().join(', ')}`);
  assert.ok(!h.eventTypes().includes('execution_failed'));
});

test('a rail that failed with no hash still lands failed and charges nothing', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: false, detail: 'refused before anything was signed' }))] });
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'failed');
  assert.deepEqual(p.result?.txids, []);
  assert.ok(typeof p.settledAt === 'string');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 0);
  assert.ok(h.eventTypes().includes('execution_failed'));
});

test('a rail that succeeded lands executed with its evidence and a settled stamp', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'funded', txids: ['intent-h2'], evidence: { settledAmountOut: '9.97' } }))] });
  const before = Date.now();
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'executed');
  assert.equal(p.result?.evidence?.settledAmountOut, '9.97');
  assert.ok(Date.parse(p.settledAt ?? '') >= before - 1000);
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10);
});

// ---------- evidence without a hash is still money that may have moved ----------
//
// Three rail outcomes carry no transaction hash and still may have moved money: an intent that
// was signed but whose submission was never confirmed (a handle and a deadline), an ambiguous
// Hyperliquid spotSend (a handle and a nonce), and an ambiguous class transfer (a nonce alone).
// Each is unconfirmed, not failed, and each is charged to the day: the venue may be holding it.

const NO_HASH_BUT_EVIDENCE = [
  ['a signed intent whose submission was never confirmed', { handle: 'dep-9', deadline: '2026-09-16T00:00:00.000Z' }],
  ['an ambiguous Hyperliquid spotSend', { handle: 'dep-9', nonce: '1726000000000' }],
  ['an ambiguous class transfer', { nonce: '1726000000001' }],
] as const;

for (const [name, evidence] of NO_HASH_BUT_EVIDENCE) {
  test(`${name} lands unconfirmed with no hash, keeps its evidence, and is charged to the day`, async () => {
    const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: false, detail: 'the venue did not answer', evidence }))] });
    const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
    assert.equal(p.status, 'needs_reconciliation', `${name}: ${p.status}`);
    assert.deepEqual(p.result?.txids, []);
    assert.deepEqual(p.result?.evidence, evidence);
    assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10, `${name}: the day is charged`);
    assert.equal(h.svc.sessionSpentUsd(), 10);
    assert.ok(h.eventTypes().includes('execution_unconfirmed'));
  });
}

test('evidence that names neither a handle nor a nonce is not a sign that money moved', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: false, detail: 'refused at the quote', evidence: { explorerUrl: 'https://x' } }))] });
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'failed');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 0);
});
