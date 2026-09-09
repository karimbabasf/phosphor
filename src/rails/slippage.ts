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
