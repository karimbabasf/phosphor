// A demo boot owns only its fixture account. A developer's config.local.json sits beside the
// repo with the real wallet's address in it, and the tests boot from that directory: if the
// config address counted in demo mode, every drafted send would carry the real address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownBook } from '../../src/proposals/lifecycle.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';

const REAL = '0xb583f41992cd21b2f2345e194a36d33684bb5db0';
const KEY = '0x2222222222222222222222222222222222222222';

function ctx(mode: 'demo' | 'live', keystoreEvm?: string): PCtx {
  return {
    cfg: { mode, addresses: { evm: REAL } },
    keystore: keystoreEvm === undefined ? undefined : { addressReport: () => ({ addresses: { evm: keystoreEvm } }) },
  } as unknown as PCtx;
}

test('a demo ignores the configured address, so the fixture account is the only owner', () => {
  assert.deepEqual(ownBook(ctx('demo')), { evm: [] });
});

test('a live boot without a keystore still reads the configured address', () => {
  assert.deepEqual(ownBook(ctx('live')), { evm: [REAL] });
});

test('the keystore comes first and the configured address follows it, live only', () => {
  assert.deepEqual(ownBook(ctx('live', KEY)), { evm: [KEY, REAL] });
  assert.deepEqual(ownBook(ctx('demo', KEY)), { evm: [KEY] });
});
