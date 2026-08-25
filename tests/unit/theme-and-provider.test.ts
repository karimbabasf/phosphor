// The two things an agent gained the power to change: the window's colours, and which venue
// the chart's candles come from. Both are cheap to get wrong in a way nothing else notices,
// which is what these assert against.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THEME,
  THEME_SLOTS,
  applyPatch,
  contrastRatio,
  normaliseColour,
} from '../../src/view/theme.ts';
import { createMarketStore } from '../../src/market/store.ts';
import type { Candle } from '../../src/types.ts';

// ---------- colour ----------

test('a colour is hex or it is nothing', () => {
  assert.equal(normaliseColour('#33FF66'), '#33ff66');
  assert.equal(normaliseColour('  #3f6 '), '#33ff66');
  // Everything that is not provably a colour. Each of these would otherwise land in a CSS
  // custom property, which is the one place an agent-supplied string reaches a stylesheet.
  assert.equal(normaliseColour('red'), null);
  assert.equal(normaliseColour('rgb(255,0,0)'), null);
  assert.equal(normaliseColour('#33ff66; background: url(http://x)'), null);
  assert.equal(normaliseColour('var(--red)'), null);
  assert.equal(normaliseColour(''), null);
  assert.equal(normaliseColour(42), null);
});

test('a slot that is not a slot is refused by name', () => {
  const out = applyPatch(DEFAULT_THEME, { red: '#000000' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /unknown colour: red/);
  // And the refusal says why, because "red" is the one an agent would try.
  assert.match(out.ok === false ? out.error : '', /approval gate/);
});

test("the approval gate's red is not reachable, so no patch can move it", () => {
  assert.ok(!THEME_SLOTS.includes('red' as never));
  const out = applyPatch(DEFAULT_THEME, { accent: '#ffaa00' });
  assert.equal(out.ok, true);
  // Nothing named red came out the other side. The gate is a CSS token this file never writes.
  assert.deepEqual(Object.keys(out.ok ? out.theme : {}).sort(), [...THEME_SLOTS].sort());
});

test('a background nothing is readable on is refused, and nothing is changed', () => {
  const out = applyPatch(DEFAULT_THEME, { background: '#33ff66' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /under the 4.5:1/);
  assert.match(out.ok === false ? out.error : '', /nothing was changed/);
});

test('a background the gate red would disappear into is refused even though red is not a slot', () => {
  // Every slot the agent CAN name is set to white, which is readable on this ground. The only
  // colour left under its floor is the one it cannot name, so this is the gate check alone.
  const out = applyPatch(DEFAULT_THEME, {
    background: '#b03a30',
    accent: '#ffffff',
    agent: '#ffffff',
    up: '#ffffff',
    down: '#ffffff',
  });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /approval gate/);
});

test('the shipped default passes its own floors', () => {
  // The regression this catches is a floor raised without looking at what already ships:
  // a single 4.5 would refuse Phosphor's own #cc3a30 down candle, which measures 3.99.
  const out = applyPatch(DEFAULT_THEME, {});
  assert.equal(out.ok, true);
  assert.ok(contrastRatio(DEFAULT_THEME.accent, DEFAULT_THEME.background) >= 4.5);
  assert.ok(contrastRatio(DEFAULT_THEME.down, DEFAULT_THEME.background) >= 3);
});

test('reset puts every slot back, and a patch on top of reset still applies', () => {
  const amber = applyPatch(DEFAULT_THEME, { accent: '#ffaa00', down: '#ff8800' });
  assert.equal(amber.ok, true);
  const back = applyPatch(amber.ok ? amber.theme : DEFAULT_THEME, { reset: true });
  assert.deepEqual(back.ok ? back.theme : null, DEFAULT_THEME);
});

// ---------- venue ----------

const bar = (t: number): Candle => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });

test('two venues on one product are two series, not one spliced line', async () => {
  const asked: string[] = [];
  const store = createMarketStore({
    fetchWindow: async (product, baseSec, _bars, provider) => {
      asked.push(`${provider}:${product}:${baseSec}`);
      // Different prices from each venue, which is the real case: a perp and a spot market.
      const price = provider === 'coinbase' ? 200 : 100;
      return [{ ...bar(1_700_000_000), c: price }];
    },
    now: () => 1_700_000_060_000,
  });

  await store.warm('SOL-USD', 60, 60, 1, 'hyperliquid');
  await store.warm('SOL-USD', 60, 60, 1, 'coinbase');

  assert.deepEqual(asked.sort(), ['coinbase:SOL-USD:60', 'hyperliquid:SOL-USD:60']);
  assert.equal(store.read('SOL-USD', 60, 60, 1, 'hyperliquid').candles[0]?.c, 100);
  assert.equal(store.read('SOL-USD', 60, 60, 1, 'coinbase').candles[0]?.c, 200);
});
