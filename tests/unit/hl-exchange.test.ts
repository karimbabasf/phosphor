import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggressiveLimitPrice,
  buildCancelAction,
  buildOrderAction,
  buildTriggerAction,
  buildUpdateLeverageAction,
  createExchange,
  createNonces,
  newCloid,
} from '../../src/hl/exchange.ts';

const base = {
  assetId: 0,
  isBuy: true,
  price: 1234.5,
  size: 0.001,
  reduceOnly: false,
  tif: 'Gtc' as const,
  szDecimals: 3,
};

test('an order action carries its keys in the documented order', () => {
  const a = buildOrderAction([base]) as { type: string; orders: Record<string, unknown>[] };
  // Field order is part of the signature, so the key order itself is the assertion.
  assert.deepEqual(Object.keys(a), ['type', 'orders', 'grouping']);
  assert.deepEqual(Object.keys(a.orders[0]), ['a', 'b', 'p', 's', 'r', 't']);
});

test('numbers go on the wire as strings with no trailing zeroes', () => {
  const a = buildOrderAction([{ ...base, price: 1234.5, size: 0.001 }]) as {
    orders: { p: string; s: string }[];
  };
  assert.equal(a.orders[0].p, '1234.5');
  assert.equal(a.orders[0].s, '0.001');
  assert.equal(typeof a.orders[0].p, 'string');
});

test('the cloid key is omitted entirely when absent, and present when given', () => {
  const without = buildOrderAction([base]) as { orders: Record<string, unknown>[] };
  assert.ok(!('c' in without.orders[0]), 'an unexpected key changes the hash');

  const cloid = newCloid();
  const with_ = buildOrderAction([{ ...base, cloid }]) as { orders: Record<string, unknown>[] };
  assert.equal(with_.orders[0].c, cloid);
  assert.deepEqual(Object.keys(with_.orders[0]), ['a', 'b', 'p', 's', 'r', 't', 'c']);
});

test('the builder key is omitted rather than sent as null', () => {
  const a = buildOrderAction([base]) as Record<string, unknown>;
  assert.ok(!('builder' in a));
});

test('a cloid is 128 bits of hex', () => {
  const c = newCloid();
  assert.match(c, /^0x[0-9a-f]{32}$/);
  assert.notEqual(newCloid(), c, 'two cloids must differ or retry dedup is meaningless');
});

test('nonces rise strictly, even when the clock does not move', () => {
  const n = createNonces(() => 1_700_000_000_000);
  const a = n.next();
  const b = n.next();
  const c = n.next();
  assert.ok(b > a && c > b, 'the venue keeps the 100 highest per signer; a repeat is rejected');
});

test('a nonce follows the clock forward', () => {
  let t = 1_700_000_000_000;
  const n = createNonces(() => t);
  const first = n.next();
  t += 5_000;
  assert.equal(n.next(), t);
  assert.ok(n.next() > first);
});

test('a trigger order is reduce-only and grouped so it resizes with the position', () => {
  const a = buildTriggerAction([
    { assetId: 0, isBuy: false, size: 0.5, triggerPx: 1200, isMarket: true, tpsl: 'sl', szDecimals: 3 },
  ]) as { grouping: string; orders: { r: boolean; t: { trigger: Record<string, unknown> } }[] };
  assert.equal(a.grouping, 'positionTpsl');
  assert.equal(a.orders[0].r, true, 'a stop can only ever reduce');
  assert.deepEqual(Object.keys(a.orders[0].t.trigger), ['isMarket', 'triggerPx', 'tpsl']);
});

test('an aggressive buy bounds above the reference and a sell below', () => {
  // Slippage on a book is a price bound, not a tolerance: anything worse simply does not fill.
  assert.ok(Math.abs(aggressiveLimitPrice(100, true, 50) - 100.5) < 1e-9);
  assert.ok(Math.abs(aggressiveLimitPrice(100, false, 50) - 99.5) < 1e-9);
  assert.equal(aggressiveLimitPrice(100, true, 0), 100);
});

test('cancel and leverage actions keep their documented shapes', () => {
  assert.deepEqual(buildCancelAction([{ assetId: 3, oid: 99 }]),
    { type: 'cancel', cancels: [{ a: 3, o: 99 }] });
  assert.deepEqual(buildUpdateLeverageAction(3, true, 5),
    { type: 'updateLeverage', asset: 3, isCross: true, leverage: 5 });
});

test('the posted envelope carries action, nonce, signature and a null vault', async () => {
  // Typed rather than inferred from the initial null: the assignment happens inside an async
  // callback, which control-flow narrowing does not follow, so an inferred type collapses to
  // never at the assertions below.
  let seen = null as Record<string, unknown> | null;
  const ex = createExchange({
    privKey: '0x0123456789012345678901234567890123456789012345678901234567890123',
    isMainnet: false,
    baseUrl: 'https://example.invalid',
    transport: async (_url, body) => {
      seen = body as Record<string, unknown>;
      return { status: 'ok' };
    },
  });

  await ex.order([base]);
  assert.ok(seen);
  assert.deepEqual(Object.keys(seen).sort(), ['action', 'nonce', 'signature', 'vaultAddress']);
  assert.equal(seen.vaultAddress, null);
  const sig = seen.signature as { r: string; s: string; v: number };
  assert.match(sig.r, /^0x[0-9a-f]{64}$/);
  assert.ok(sig.v === 27 || sig.v === 28);
  assert.ok(!('expiresAfter' in seen), 'omitted when unused, since an extra key changes the hash');
});
