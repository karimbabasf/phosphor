import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvelope } from '../../src/strategy/envelope.ts';
import type { Mandate, RunState } from '../../src/strategy/envelope.ts';
import type { Action } from '../../src/strategy/grammar.ts';

const HASH = 'a'.repeat(64);

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: 'md_1',
    programHash: HASH,
    symbol: 'ETH',
    maxNotionalUsd: 1000,
    maxLeverage: 5,
    maxOrdersPerMin: 10,
    maxLossUsd: 100,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    allowedActions: ['open', 'add', 'reduce', 'close', 'set_stop', 'cancel', 'stand_down', 'notify'],
    ...over,
  };
}

function state(over: Partial<RunState> = {}): RunState {
  return {
    nowMs: Date.now(),
    armedAtMs: Date.now() - 60_000,
    symbol: 'ETH',
    positionUsd: 0,
    positionSide: 'flat',
    entryAtMs: null,
    realisedUsd: 0,
    unrealisedUsd: 0,
    ordersInLastMin: 0,
    programHash: HASH,
    ...over,
  };
}

const open = (sizeUsd: number, leverage = 2): Action => ({
  do: 'open',
  side: 'long',
  sizeUsd,
  leverage,
  entry: { type: 'market', maxSlippageBps: 20 },
});

test('a plain opening order inside every limit is allowed', () => {
  assert.deepEqual(checkEnvelope(open(500), mandate(), state()), { allow: true });
});

test('a hash mismatch halts before anything else is considered', () => {
  // Even a safety verb halts here: if the program is not the one that was approved, nothing
  // about the mandate applies to it.
  const r = checkEnvelope({ do: 'close', exit: { type: 'market', maxSlippageBps: 50 } },
    mandate(), state({ programHash: 'b'.repeat(64) }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, true);
  assert.match(r.allow === false ? r.reason : '', /does not match/);
});

test('a verb the human did not grant is refused and halts', () => {
  const r = checkEnvelope(open(100), mandate({ allowedActions: ['close', 'notify'] }), state());
  assert.equal(r.allow, false);
  assert.match(r.allow === false ? r.reason : '', /not in this mandate/);
});

test('notional counts the position already open, and refuses whole rather than shrinking', () => {
  const r = checkEnvelope(open(600), mandate(), state({ positionUsd: 700 }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, true);
  assert.match(r.allow === false ? r.reason : '', /1300\.00.*over the 1000\.00/);
});

test('leverage over the cap is refused', () => {
  const r = checkEnvelope(open(100, 10), mandate(), state());
  assert.equal(r.allow, false);
  assert.match(r.allow === false ? r.reason : '', /10x is over the 5x/);
});

test('the order rate refuses without halting, because pace is not a wrong program', () => {
  const r = checkEnvelope(open(100), mandate(), state({ ordersInLastMin: 10 }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, false, 'a busy minute must not kill the mandate');
});

test('past the loss limit, opening is refused but getting flat is not', () => {
  const s = state({ realisedUsd: -60, unrealisedUsd: -45 }); // 105 down against a 100 limit
  const blocked = checkEnvelope(open(100), mandate(), s);
  assert.equal(blocked.allow, false);
  assert.match(blocked.allow === false ? blocked.reason : '', /reached the 100\.00 limit/);

  for (const a of [
    { do: 'close', exit: { type: 'market', maxSlippageBps: 50 } },
    { do: 'reduce', fraction: 0.5, exit: { type: 'market', maxSlippageBps: 50 } },
    { do: 'cancel', which: 'all' },
    { do: 'stand_down', reason: 'x' },
  ] as Action[]) {
    assert.deepEqual(checkEnvelope(a, mandate(), s), { allow: true },
      `${a.do} must still be allowed when the account is down`);
  }
});

test('past expiry, opening is refused but closing is not', () => {
  const m = mandate({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(checkEnvelope(open(100), m, state()).allow, false);
  assert.deepEqual(
    checkEnvelope({ do: 'close', exit: { type: 'market', maxSlippageBps: 50 } }, m, state()),
    { allow: true },
  );
});

test('a symbol the mandate does not cover halts', () => {
  const r = checkEnvelope(open(100), mandate(), state({ symbol: 'BTC' }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, true);
});

test('a non-positive size is refused', () => {
  assert.equal(checkEnvelope(open(0), mandate(), state()).allow, false);
  assert.equal(checkEnvelope(open(-100), mandate(), state()).allow, false);
});

test('property: no accepted sequence can exceed notional or leverage', () => {
  // The guarantee the whole design rests on, exercised rather than asserted in prose.
  const m = mandate();
  let s = state();
  let rejected = 0;

  for (let i = 0; i < 400; i++) {
    const size = ((i * 37) % 500) + 1;
    const lev = ((i * 7) % 8) + 1;
    const a = open(size, lev);
    const r = checkEnvelope(a, m, s);
    if (!r.allow) {
      rejected += 1;
      continue;
    }
    s = { ...s, positionUsd: s.positionUsd + size, ordersInLastMin: 0 };
    assert.ok(s.positionUsd <= m.maxNotionalUsd, `notional escaped: ${s.positionUsd}`);
    assert.ok(lev <= m.maxLeverage, `leverage escaped: ${lev}`);
  }
  assert.ok(rejected > 0, 'the property is vacuous if nothing was ever rejected');
});
