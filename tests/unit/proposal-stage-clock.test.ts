// The stage clock: when a row records a stage, and when it does not.
//
// The card and the agent both count from lastChangeAt, so the one property that matters is that
// it moves on a stage change and stands still through the several writes one stage takes.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal } from '../../src/types.ts';
import { persist } from '../../src/proposals/lifecycle.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import { createStore } from '../../src/store.ts';
import { makeCtx } from './helpers/proposals.ts';

function rowOf(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    kind: 'hl_deposit',
    createdAt: '2026-09-18T10:00:00.000Z',
    status: 'pending',
    draft: {
      kind: 'hl_deposit',
      symbol: 'USDC',
      originAsset: 'nep141:eth-usdc',
      amount: 7.5425,
      amountUsd: 7.5425,
      minCredited: 5,
      from: '0x1111111111111111111111111111111111111111',
      hlAccount: '0x1111111111111111111111111111111111111111',
      counterparty: 'hypercore',
    },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: [] },
    ...over,
  };
}

// A store and a notify, which is all persist() reads.
function ctxOf(): PCtx {
  const h = makeCtx();
  const store = createStore(h.dataDir);
  return { store, notify: () => {} } as unknown as PCtx;
}

test('a status change writes a new stageAt key', () => {
  const ctx = ctxOf();
  const pending = persist(ctx, rowOf());
  assert.deepEqual(Object.keys(pending.stageAt ?? {}), ['waiting_for_you']);

  const executing = persist(ctx, { ...pending, status: 'executing' });
  assert.deepEqual(Object.keys(executing.stageAt ?? {}), ['waiting_for_you', 'submitting']);
  assert.equal(executing.lastChangeAt, executing.stageAt?.submitting);
  assert.notEqual(executing.lastChangeAt, pending.lastChangeAt);
});

test('a rewrite with no status change leaves lastChangeAt alone', () => {
  const ctx = ctxOf();
  const first = persist(ctx, rowOf({ status: 'executing' }));
  const second = persist(ctx, { ...first, result: { ok: false, detail: 'submitted', txids: ['0xabc'] } });
  assert.equal(second.lastChangeAt, first.lastChangeAt);
  assert.deepEqual(Object.keys(second.stageAt ?? {}), ['submitting']);
});

test('a provider stage change with the same status still moves lastChangeAt', () => {
  const ctx = ctxOf();
  const submitting = persist(ctx, rowOf({ status: 'executing' }));
  const processing = persist(ctx, {
    ...submitting,
    result: { ok: false, detail: 'polling', evidence: { providerStage: 'PROCESSING' } },
  });
  assert.equal(processing.stageAt?.PROCESSING !== undefined, true);
  assert.notEqual(processing.lastChangeAt, submitting.lastChangeAt);
  assert.equal(processing.lastChangeAt, processing.stageAt?.PROCESSING);
});
