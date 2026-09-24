// The slippage floor, shared by every swap rail.
//
// This lived in the Uniswap rail because that is where it was first needed, and the two NEAR
// Intents rails imported it from there rather than keep a second and a third copy of the
// number. Uniswap is gone; the reasoning never belonged to it.
//
// A caller supplies its own floor in the draft (minAmountOut) and this never widens it. What
// it refuses is a floor set so far below the app's own quote that it is not protection at all:
// the venue fills at the floor and the difference is somebody else's. Generous on purpose. A
// real swap's floor is a percent or two under the quote, never twenty, so this rejects the
// absurd without touching anything legitimate. A tighter, policy-configurable slippage is the
// follow-up.

export const MAX_SLIPPAGE_BPS = 2000;

// Pure, so it can be asserted without a live quoter. Both arguments are base units of the same
// token, so the comparison is exact. A zero or absent quote is not judged: there is nothing to
// compare against, and the floor-set-too-HIGH check on each rail catches that path.
export function floorTooLow(quoteOut: bigint, minOut: bigint, maxSlippageBps: number): boolean {
  if (quoteOut <= 0n) return false;
  const limit = (quoteOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  return minOut < limit;
}

/* THE FLOOR THE APP SETS WHEN THE AGENT NAMES NONE: one percent under the rail's own live
   quote, cut toward zero at six significant figures so the card prints what was approved
   (frozen rule 2: off the quote, never off a guess, never zero; a floor is truncated, never
   rounded). An agent used to have to supply a floor before any quote existed and sized it off
   a market price, which is the guess the rule forbids. */
export const DEFAULT_FLOOR_BPS = 100;

/* How long the price a propose cut its floor from is reused by the check that follows it. The
   floor-setting ask and the simulate were the same request a second apart, both paid a round
   trip before the card could draw, and the second one coming back a hair lower refused the swap
   against a floor cut from the first. One price per propose, used once. */
export const QUOTE_REUSE_MS = 20_000;

export function floorUnderQuote(quoteOut: number, bps: number = DEFAULT_FLOOR_BPS): number {
  if (!(quoteOut > 0) || !Number.isFinite(quoteOut)) return 0;
  const raw = quoteOut * (10_000 - bps) / 10_000;
  // Six significant figures, cut toward zero.
  const magnitude = Math.floor(Math.log10(raw));
  const scale = Math.pow(10, 5 - magnitude);
  return Math.floor(raw * scale) / scale;
}

