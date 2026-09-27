// Every 1Click quote carries Phosphor's referral, so the Intents Explorer can count its swaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oneClickClient, PHOSPHOR_REFERRAL } from '../../src/intents.ts';

function capture(): { bodies: Record<string, unknown>[]; fetchImpl: typeof fetch } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: 'stop' }), { status: 400 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const params = {
  dry: true,
  originAsset: 'nep141:a',
  destinationAsset: 'nep141:b',
  amount: '1',
  refundTo: 'r',
  recipient: 'r',
};

test('a quote with no referral is tagged phosphor', async () => {
  const { bodies, fetchImpl } = capture();
  await oneClickClient({ fetchImpl }).quote(params).catch(() => {});
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.['referral'], PHOSPHOR_REFERRAL);
  assert.equal(PHOSPHOR_REFERRAL, 'phosphor');
});

test('a caller that names a referral keeps its own', async () => {
  const { bodies, fetchImpl } = capture();
  await oneClickClient({ fetchImpl }).quote({ ...params, referral: 'other' }).catch(() => {});
  assert.equal(bodies[0]?.['referral'], 'other');
});
