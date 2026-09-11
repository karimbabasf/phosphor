// The plan: one object, one shape, two homes.
//
// Every field has a bound and every refusal names the field, because the agent reads the
// refusal and fixes the plan without asking anyone. The hash is what the human clicks on, so it
// has to survive a reordering of keys and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXPIRY_MS,
  MAX_EXPIRY_MS,
  mintPlanId,
  planHash,
  renderCondition,
  renderPlan,
  validatePlanInput,
} from '../../src/trade/plan.ts';
import type { Plan, PlanInput } from '../../src/trade/plan.ts';

const NOW = 1_786_492_800_000;

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 4000,
    leverage: 40,
    entry: { type: 'market' },
    stop: 63000,
    target: 66000,
    ...over,
  };
}

function ok(over: Record<string, unknown> = {}): PlanInput {
  const out = validatePlanInput(raw(over), NOW);
  assert.ok(out.ok, out.ok ? '' : out.errors.join('; '));
  return out.plan;
}

function refused(over: Record<string, unknown>, pattern: RegExp): void {
  const out = validatePlanInput(raw(over), NOW);
  assert.equal(out.ok, false, `expected a refusal for ${JSON.stringify(over)}`);
  assert.match(out.ok ? '' : out.errors.join('; '), pattern);
}

test('a market plan takes its defaults: 30 bps slippage, 24 h expiry, uppercase symbol', () => {
  const p = ok({ symbol: 'btc' });
  assert.equal(p.symbol, 'BTC');
  assert.deepEqual(p.entry, { type: 'market', maxSlippageBps: 30 });
  assert.equal(p.expiresAt, new Date(NOW + DEFAULT_EXPIRY_MS).toISOString());
  assert.equal(p.when, undefined);
});

test('every field is bounded and the refusal names it', () => {
  refused({ symbol: 'BTC-USD' }, /symbol/);
  refused({ symbol: 'ABCDEFGHIJKLM' }, /symbol/);
  refused({ side: 'flat' }, /side/);
  refused({ sizeUsd: 10 }, /sizeUsd/);
  refused({ sizeUsd: Number.POSITIVE_INFINITY }, /sizeUsd/);
  refused({ leverage: 0 }, /leverage/);
  refused({ leverage: 2.5 }, /leverage/);
  refused({ stop: 0 }, /stop/);
  refused({ target: -1 }, /target/);
  refused({ entry: { type: 'market', maxSlippageBps: 5000 } }, /maxSlippageBps/);
  refused({ entry: { type: 'limit' } }, /px/);
  refused({ entry: { type: 'twap' } }, /entry/);
  refused({ note: 'x'.repeat(121) }, /note/);
  refused({ note: 'a; b' }, /note/);
  refused({ note: 'ab' }, /note/);
  refused({ when: new Array(7).fill({ type: 'time' }) }, /when/);
  refused({ when: [{ type: 'close', tf: '2h', is: 'above', at: { px: 1 } }] }, /tf/);
  refused({ when: [{ type: 'close', tf: '1h', is: 'above', at: { line: 'zn_1' } }] }, /line/);
  refused({ when: [{ type: 'volume', tf: '1h', atLeast: 0 }] }, /atLeast/);
  refused({ when: [{ type: 'price_cross', px: 1 }] }, /when/);
});

test('the schema is closed: an unknown key is a refusal, not a silent drop', () => {
  refused({ recipient: '0xabc' }, /recipient/);
  refused({ entry: { type: 'market', to: '0xabc' } }, /to/);
});

test('expiry defaults to a day, refuses the past and refuses beyond seven days', () => {
  assert.equal(ok({ expiresAt: new Date(NOW + 3_600_000).toISOString() }).expiresAt, new Date(NOW + 3_600_000).toISOString());
  refused({ expiresAt: new Date(NOW - 1).toISOString() }, /expiresAt/);
  refused({ expiresAt: new Date(NOW + MAX_EXPIRY_MS + 1).toISOString() }, /expiresAt/);
  refused({ expiresAt: 'tomorrow' }, /expiresAt/);
});

test('conditions parse with their defaults and the wick flag', () => {
  const p = ok({
    when: [
      { type: 'close', tf: '15m', is: 'above', at: { px: 64200 }, wick: 'through' },
      { type: 'volume', tf: '15m', atLeast: 1.5 },
      { type: 'time', after: new Date(NOW).toISOString() },
      { type: 'close', tf: '1h', is: 'below', at: { line: 'tl_3' } },
    ],
  });
  assert.equal(p.when?.length, 4);
});

test('the id is minted by the app and reads as pl_ plus base36', () => {
  const id = mintPlanId(NOW);
  assert.match(id, /^pl_[0-9a-z]+$/);
  assert.notEqual(mintPlanId(NOW, 1), id, 'a second plan in the same millisecond gets its own id');
});

test('the hash is stable across key order and moves on any value', () => {
  const a: Plan = { id: 'pl_1', ...ok() };
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))) as Plan;
  assert.equal(planHash(a), planHash(reordered));
  assert.match(planHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(planHash(a), planHash({ ...a, stop: 63001 }));
  assert.notEqual(planHash(a), planHash({ ...a, id: 'pl_2' }));
});

test('the render says the whole plan in English, one line per fact', () => {
  const plan: Plan = { id: 'pl_1', ...ok({ note: 'reclaim of the range low' }) };
  const lines = renderPlan(plan, {
    marginUsd: 100,
    maxLossUsd: 66.1,
    stopSlipUsd: 400,
    entryRef: 64000,
    liquidationPx: 63190,
    notionalUsd: 3999.4,
    amountUsd: 100,
  });
  const text = lines.join('\n');
  assert.match(text, /Long BTC/);
  assert.match(text, /\$4,000\.00 notional at 40x/);
  assert.match(text, /\$100\.00 of collateral/);
  assert.match(text, /market, up to 30 bps/);
  assert.match(text, /Stop 63000/);
  assert.match(text, /\$66\.10/);
  assert.match(text, /\$400\.00/);
  assert.match(text, /Target 66000/);
  assert.match(text, /When: now/);
  assert.match(text, /Liquidation near 63190/);
  assert.match(text, /reclaim of the range low/);
  assert.equal(lines.some((l) => /[\u2013\u2014]/.test(l)), false, 'no dashes anywhere');
});

test('each entry type and each condition renders as a sentence a person can check', () => {
  const limit: Plan = { id: 'pl_2', ...ok({ entry: { type: 'limit', px: 63500 }, target: undefined }) };
  assert.match(renderPlan(limit).join('\n'), /limit at 63500/);
  assert.match(renderPlan(limit).join('\n'), /No target/);
  const stop: Plan = { id: 'pl_3', ...ok({ side: 'short', entry: { type: 'stop', px: 62000 }, stop: 63000, target: 60000 }) };
  assert.match(renderPlan(stop).join('\n'), /Short BTC/);
  assert.match(renderPlan(stop).join('\n'), /stop entry at 62000/);

  assert.equal(renderCondition({ type: 'close', tf: '15m', is: 'above', at: { px: 64200 } }), 'a 15m bar closes above 64200');
  assert.equal(
    renderCondition({ type: 'close', tf: '1h', is: 'below', at: { px: 100 }, wick: 'through' }),
    'a 1h bar wicks above 100 and closes back below it',
  );
  assert.equal(renderCondition({ type: 'close', tf: '4h', is: 'above', at: { line: 'tl_3' } }), 'a 4h bar closes above line tl_3');
  assert.equal(renderCondition({ type: 'volume', tf: '5m', atLeast: 1.5 }), 'volume on the 5m is at least 1.5x its 20-bar average');
  assert.equal(
    renderCondition({ type: 'time', after: '2026-09-11T12:00:00.000Z', before: '2026-09-12T12:00:00.000Z' }),
    'after 2026-09-11T12:00:00.000Z and before 2026-09-12T12:00:00.000Z',
  );
  assert.equal(renderCondition({ type: 'time' }), 'any time');
});
