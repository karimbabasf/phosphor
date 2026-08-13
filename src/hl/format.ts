// Wire numbers, tick and lot.
//
// Every number Hyperliquid accepts is a string, and the string is hashed before it is signed, so
// "1.50" and "1.5" are two different orders as far as the signature is concerned. That makes
// formatting part of the trading logic rather than presentation, and it decides the one policy
// question these three functions share:
//
//   An input that does not fit the venue's grid THROWS. It is never quietly rounded.
//
// Silently rounding a price is how a bot fills at a level the human never approved: the operator
// reads 1234.56 in the plan, the venue gets 1234.6, and nobody finds out until the fill. A throw
// stops the order at the point where the caller still knows what it meant.
//
// `formatSize` is the one exception, and only downward. A size is derived from a dollar figure
// divided by a price, so it essentially never lands on the lot grid, and refusing it would make
// the function useless. It rounds toward zero, which can only ever make the position smaller
// than approved.
//
// JS number to string is also a trap worth naming: `toString()` flips to exponent notation for
// small and large magnitudes ("1e-8"), which the venue rejects, and a bare `toFixed()` rounds
// without telling anyone. Both appear below only inside a round-trip check that turns a lost
// digit into an error.

// Above 1e21 toFixed gives up and returns exponent notation. Nothing on a perp gets near this,
// so the guard exists to make the failure loud rather than to be reachable.
const NO_EXPONENT_LIMIT = 1e21;

export function wireNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`wireNumber: ${x} is not a finite number`);
  if (x === 0) return '0'; // -0 === 0, and "-0" would hash differently from "0"
  if (Math.abs(x) >= NO_EXPONENT_LIMIT) {
    throw new Error(`wireNumber: ${x} is too large to write without an exponent`);
  }

  const fixed = x.toFixed(8);
  // toFixed rounded to 8 places. If the rounded value is a different number from the input, the
  // input carried precision the wire cannot hold, and rounding it here would change the order.
  if (Number(fixed) !== x) {
    throw new Error(`wireNumber: ${x} needs more than 8 decimals; round it deliberately first`);
  }
  return stripTrailingZeros(fixed);
}

export function formatPrice(px: number, szDecimals: number, isPerp: boolean): string {
  if (!Number.isFinite(px) || px <= 0) throw new Error(`formatPrice: ${px} is not a price`);
  assertSzDecimals(szDecimals);

  const maxDecimals = (isPerp ? 6 : 8) - szDecimals;
  if (maxDecimals < 0) {
    throw new Error(`formatPrice: szDecimals ${szDecimals} leaves no room for a ${isPerp ? 'perp' : 'spot'} price`);
  }

  // An integer price is always valid, whatever its significant figures, so 123456 passes where
  // 123456.5 does not. Check this before the significant figure rule rather than after.
  if (Number.isInteger(px)) return wireNumber(px);

  const rounded = px.toFixed(maxDecimals);
  if (Number(rounded) !== px) {
    throw new Error(`formatPrice: ${px} needs more than ${maxDecimals} decimals for szDecimals ${szDecimals}`);
  }

  // Significant figures are counted on the exact decimal expansion, which `rounded` now is:
  // leading zeros are placeholders, trailing zeros past the last real digit are too.
  const digits = rounded.replace('-', '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 5) {
    throw new Error(`formatPrice: ${px} has ${digits.length} significant figures, the venue allows 5`);
  }

  // Cannot throw: rounded equals px exactly and maxDecimals is at most 8.
  return wireNumber(px);
}

export function formatSize(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz <= 0) throw new Error(`formatSize: ${sz} is not a size`);
  assertSzDecimals(szDecimals);

  const factor = 10 ** szDecimals;
  // Math.round first, because sz * factor carries float noise (0.29 * 100 is 28.999999999999996)
  // and truncating that noise would drop a whole lot. Then step down if rounding went up, so the
  // result is never larger than what the caller asked to trade.
  let lots = Math.round(sz * factor);
  if (lots / factor > sz) lots -= 1;
  if (lots <= 0) {
    throw new Error(`formatSize: ${sz} rounds to zero at ${szDecimals} decimals`);
  }
  return wireNumber(lots / factor);
}

function assertSzDecimals(szDecimals: number): void {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 8) {
    throw new Error(`szDecimals must be an integer 0..8, got ${szDecimals}`);
  }
}

function stripTrailingZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

// Round a computed price to something the venue will actually accept.
//
// This exists because formatPrice is a GUARD, not a converter: it throws on an invalid price
// rather than rounding, so that a bot can never silently fill at a price nobody approved. That
// leaves the caller responsible for arriving with a valid one, and an aggressive limit derived
// from mark times a slippage factor essentially never is. The first live order this code ever
// attempted died exactly here: 63980.30999999999 against BTC, which allows one decimal.
//
// Two limits bind at once and the tighter wins: at most `maxDecimals` decimal places, and at
// most 5 significant figures. For a five-figure price like BTC the significant-figure rule bites
// first and the answer is an integer, which the venue always accepts regardless of figures.
//
// Direction matters and is not a rounding preference. An aggressive BUY limit is the most it may
// pay, so it rounds DOWN; an aggressive SELL limit is the least it may accept, so it rounds UP.
// Rounding the other way would push the fill past the bound the human approved, which is the one
// outcome this whole path exists to prevent.
export function roundToValidPrice(px: number, szDecimals: number, isPerp: boolean, isBuy: boolean): number {
  const maxDecimals = (isPerp ? 6 : 8) - szDecimals;
  const whole = Math.floor(Math.abs(px)).toString().length;
  const bySigFigs = 5 - whole;
  const decimals = Math.max(0, Math.min(maxDecimals, bySigFigs));
  const f = 10 ** decimals;
  // Buy rounds down, sell rounds up: never past the bound.
  return (isBuy ? Math.floor(px * f) : Math.ceil(px * f)) / f;
}
