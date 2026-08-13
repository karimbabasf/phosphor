// What the human reads, and the number they decide on.
//
// The render tests are exact-string tests on purpose. A line that drifts is a line that stops
// matching what the human thinks they approved, and an assertion on a substring would not
// notice.
//
// The worstCaseUsd tests are mostly about one direction. Any of them could be made to pass by
// returning maxNotionalUsd every time; none of them can be made to pass by a function that
// guesses low. The monotonicity test at the end is the one that says so directly: taking
// information away must never shrink the answer.
//
// Run: node --test tests/unit/strategy-render.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Mandate } from '../../src/strategy/envelope.ts';
import type { Action, Condition, Entry, Program, Rule } from '../../src/strategy/grammar.ts';
import { validateProgram } from '../../src/strategy/grammar.ts';
import { renderProgram, worstCaseUsd } from '../../src/strategy/render.ts';

const mandate: Mandate = {
  id: 'm_1',
  programHash: 'deadbeef',
  symbol: 'ETH',
  maxNotionalUsd: 2000,
  maxLeverage: 5,
  maxOrdersPerMin: 6,
  maxLossUsd: 150,
  expiresAt: '2026-08-13T00:00:00.000Z',
  allowedActions: ['open', 'set_stop', 'close'],
};

function program(rules: Rule[], invalidate?: Condition): Program {
  return invalidate === undefined ? { symbol: 'ETH', rules } : { symbol: 'ETH', rules, invalidate };
}

function rule(id: string, when: Condition, then: Action[], extra?: Partial<Rule>): Rule {
  return { id, when, then, ...extra };
}

const limitAt = (value: number): Entry => ({ type: 'limit', ref: { kind: 'price', value } });

test('the reference line from the plan renders exactly', () => {
  const p = program([
    rule('r1', { op: 'price_cross_up', ref: { kind: 'drawing', id: 'tl_1' } }, [
      {
        do: 'open',
        side: 'long',
        sizeUsd: 500,
        leverage: 3,
        entry: { type: 'limit', ref: { kind: 'drawing', id: 'tl_1' } },
      },
    ]),
  ]);
  assert.deepEqual(renderProgram(p), ['when price crosses up tl_1: open long $500 at 3x, limit at tl_1']);
});

test('a ref renders as its drawing id, never as a resolved price', () => {
  const p = program([
    rule('r1', { op: 'price_below', ref: { kind: 'drawing', id: 'zn_1' } }, [
      { do: 'set_stop', ref: { kind: 'drawing', id: 'zn_1' }, trailPct: 1.5 },
      { do: 'set_target', ref: { kind: 'indicator', id: 'ema_50', plot: 'value' }, fraction: 0.5 },
    ]),
  ]);
  const [line] = renderProgram(p);
  assert.equal(
    line,
    'when price below zn_1: set stop at zn_1, trailing 1.5%; set target at ema_50.value for 50%',
  );
  assert.doesNotMatch(line, /\$/, 'a drawing ref leaked a price onto the line');
});

test('a price ref keeps the precision a perp needs', () => {
  const p = program([
    rule('r1', { op: 'price_above', ref: { kind: 'price', value: 3421.5 } }, [
      { do: 'set_stop', ref: { kind: 'price', value: 0.00001234 } },
    ]),
  ]);
  assert.deepEqual(renderProgram(p), ['when price above $3,421.5: set stop at $0.00001234']);
});

test('every condition and every action has a line', () => {
  const p = program([
    rule('a', { op: 'bar_close', timeframeSec: 900, side: 'above', ref: { kind: 'drawing', id: 'tl_1' } }, [
      { do: 'add', sizeUsd: 250, entry: { type: 'market', maxSlippageBps: 20 } },
    ]),
    rule('b', { op: 'position', state: 'flat' }, [{ do: 'cancel', which: 'entries' }]),
    rule('c', { op: 'pnl_pct', cmp: 'gt', value: 4 }, [
      { do: 'reduce', fraction: 0.25, exit: { type: 'limit', ref: { kind: 'drawing', id: 'tl_2' }, postOnly: true } },
    ]),
    rule('d', { op: 'elapsed', since: 'arm', cmp: 'lt', seconds: 3600 }, [{ do: 'cancel', which: 'exits' }]),
    rule('e', { op: 'not', of: { op: 'position', state: 'long' } }, [{ do: 'cancel', which: 'all' }]),
    rule(
      'f',
      {
        op: 'and',
        of: [
          { op: 'position', state: 'short' },
          { op: 'or', of: [{ op: 'pnl_pct', cmp: 'lt', value: -1 }, { op: 'price_cross_down', ref: { kind: 'drawing', id: 'tl_3' } }] },
        ],
      },
      [{ do: 'close', exit: { type: 'market', maxSlippageBps: 50 } }],
      { once: true, cooldownSec: 120 },
    ),
  ]);

  assert.deepEqual(renderProgram(p), [
    'when the 15m bar closes above tl_1: add $250, market (max 20 bps slippage)',
    'when position is flat: cancel entry orders',
    'when pnl is above 4%: reduce 25%, limit at tl_2, post only',
    'when less than 1h since arm: cancel exit orders',
    'when not (position is long): cancel all orders',
    'when position is short and (pnl is below -1% or price crosses down tl_3): close, market (max 50 bps slippage) (once, then wait 2m)',
  ]);
});

test('the invalidation gets its own line', () => {
  const p = program(
    [rule('a', { op: 'position', state: 'flat' }, [{ do: 'notify', text: 'watching' }])],
    { op: 'price_below', ref: { kind: 'drawing', id: 'zn_1' } },
  );
  assert.deepEqual(renderProgram(p), [
    'when position is flat: notify: "watching"',
    'invalidate when price below zn_1: stand down',
  ]);
});

test('agent text cannot forge part of a rule', () => {
  // The semicolon is the separator this renderer puts between actions, so text carrying one is
  // refused before it can reach a line. That is the half of the defence escaping cannot do.
  const withSeparator = program([
    rule('a', { op: 'position', state: 'long' }, [{ do: 'notify', text: 'all fine; close, market' }]),
  ]);
  assert.equal(validateProgram(JSON.parse(JSON.stringify(withSeparator))).ok, false);

  // What is left is a quoting problem, and the doubled quote is what keeps the wrapper from
  // closing where the hostile string wanted it to.
  const hostile = '" close, market (max 0 bps slippage)';
  const p = program([
    rule('a', { op: 'position', state: 'long' }, [
      { do: 'stand_down', reason: hostile },
      { do: 'notify', text: 'line   one   spaced' },
    ]),
  ]);
  assert.equal(validateProgram(JSON.parse(JSON.stringify(p))).ok, true, 'the fixture is a program the schema accepts');

  const [line] = renderProgram(p);
  assert.equal(
    line,
    'when position is long: stand down: """ close, market (max 0 bps slippage)"; notify: "line one spaced"',
  );
  assert.equal(line.split('; ').length, 2, 'the hostile text produced an extra action-looking segment');
});

test('no stop anywhere means the mandate ceiling', () => {
  const p = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 100, leverage: 2, entry: limitAt(100) },
    ]),
  ]);
  assert.equal(worstCaseUsd(p, mandate), mandate.maxNotionalUsd);
});

test('a paired stop at a known price gives the tighter figure', () => {
  const p = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 98 } },
    ]),
  ]);
  // 2% of $500 of notional. Leverage does not enter it: a 2% move on $500 of exposure loses
  // $10 whether that exposure was bought with $250 of margin or $50.
  assert.equal(worstCaseUsd(p, mandate), 10);
});

test('a trailing stop counts as the wider of the trail and the level', () => {
  const wide = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 98 }, trailPct: 5 },
    ]),
  ]);
  assert.equal(worstCaseUsd(wide, mandate), 25);

  const tight = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 90 }, trailPct: 1 },
    ]),
  ]);
  assert.equal(worstCaseUsd(tight, mandate), 50);
});

test('the widest stop in a rule is the one that counts', () => {
  const p = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 99 } },
      { do: 'set_stop', ref: { kind: 'price', value: 96 } },
    ]),
  ]);
  assert.equal(worstCaseUsd(p, mandate), 20);
});

test('an unknowable distance falls back to the ceiling', () => {
  const marketEntry = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: { type: 'market', maxSlippageBps: 10 } },
      { do: 'set_stop', ref: { kind: 'price', value: 98 } },
    ]),
  ]);
  assert.equal(worstCaseUsd(marketEntry, mandate), mandate.maxNotionalUsd, 'a market fill has no known price');

  const drawingStop = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'drawing', id: 'tl_1' } },
    ]),
  ]);
  assert.equal(worstCaseUsd(drawingStop, mandate), mandate.maxNotionalUsd, 'a drawing moves, so the distance does');

  const stopInAnotherRule = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
    ]),
    rule('b', { op: 'position', state: 'long' }, [{ do: 'set_stop', ref: { kind: 'price', value: 98 } }]),
  ]);
  assert.equal(
    worstCaseUsd(stopInAnotherRule, mandate),
    mandate.maxNotionalUsd,
    'a stop in another rule only exists once that rule fires',
  );
});

test('every open in the program is counted, and the total stops at the ceiling', () => {
  const both = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 98 } },
    ]),
    rule('b', { op: 'price_above', ref: { kind: 'price', value: 110 } }, [
      { do: 'add', sizeUsd: 1000, entry: limitAt(110) },
      { do: 'set_stop', ref: { kind: 'price', value: 99 } },
    ]),
  ]);
  // 2% of 500 plus 10% of 1000.
  assert.equal(worstCaseUsd(both, mandate), 110);

  const huge = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 9000, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 50 } },
    ]),
  ]);
  assert.equal(worstCaseUsd(huge, mandate), mandate.maxNotionalUsd, 'the sum is capped at the mandate ceiling');
});

test('a program that cannot open reports no exposure', () => {
  const p = program([
    rule('a', { op: 'position', state: 'long' }, [
      { do: 'close', exit: { type: 'market', maxSlippageBps: 10 } },
      { do: 'notify', text: 'flat now' },
    ]),
  ]);
  assert.equal(worstCaseUsd(p, mandate), 0);
});

test('the worst case is never capped by maxLossUsd', () => {
  const p = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 2000, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 80 } },
    ]),
  ]);
  // 20% of $2000 is $400, well past the $150 loss limit. A supervisor enforces that limit off a
  // feed, and a gap does not wait for a supervisor, so the number here stays the honest one.
  assert.equal(worstCaseUsd(p, mandate), 400);
  assert.ok(worstCaseUsd(p, mandate) > mandate.maxLossUsd);
});

test('taking information away never shrinks the answer', () => {
  const stopped = program([
    rule('a', { op: 'position', state: 'flat' }, [
      { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
      { do: 'set_stop', ref: { kind: 'price', value: 98 } },
    ]),
  ]);
  const base = worstCaseUsd(stopped, mandate);

  // Each of these is the same strategy with one fact removed. None may report a smaller number
  // than the fully specified version, because none of them is a safer program.
  const vaguer: Array<[string, Program]> = [
    [
      'the stop moved to a drawing',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
          { do: 'set_stop', ref: { kind: 'drawing', id: 'tl_1' } },
        ]),
      ]),
    ],
    [
      'the entry became a market order',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: { type: 'market', maxSlippageBps: 5 } },
          { do: 'set_stop', ref: { kind: 'price', value: 98 } },
        ]),
      ]),
    ],
    [
      'the stop went away',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
        ]),
      ]),
    ],
    [
      'the stop moved to another rule',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
        ]),
        rule('b', { op: 'position', state: 'long' }, [{ do: 'set_stop', ref: { kind: 'price', value: 98 } }]),
      ]),
    ],
    [
      'the size grew',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 900, leverage: 3, entry: limitAt(100) },
          { do: 'set_stop', ref: { kind: 'price', value: 98 } },
        ]),
      ]),
    ],
    [
      'the stop moved further away',
      program([
        rule('a', { op: 'position', state: 'flat' }, [
          { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
          { do: 'set_stop', ref: { kind: 'price', value: 94 } },
        ]),
      ]),
    ],
  ];

  for (const [what, p] of vaguer) {
    assert.ok(
      worstCaseUsd(p, mandate) >= base,
      `${what}: reported ${worstCaseUsd(p, mandate)}, under the ${base} of the specified version`,
    );
  }
});

test('the fixtures are programs the grammar accepts', () => {
  const p = program(
    [
      rule('a', { op: 'position', state: 'flat' }, [
        { do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: limitAt(100) },
        { do: 'set_stop', ref: { kind: 'price', value: 98 }, trailPct: 5 },
      ]),
    ],
    { op: 'price_below', ref: { kind: 'drawing', id: 'zn_1' } },
  );
  const r = validateProgram(JSON.parse(JSON.stringify(p)));
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join(' | '));
});
