// The route a swap takes inside NEAR Intents: the solver relay first, the 1Click rail when the
// relay offers no price for the pair.
//
// The relay is the first choice because what it signs is the price: one atomic token_diff, both
// sides moved in one call or neither (src/rails/intents-relay.ts). It quotes only the pairs a
// solver on it serves, and on 2026-10-02 no solver served USDC to ETH, wNEAR or Base ETH, while
// 1Click priced each in half a second; on the default config those swaps were refused at any size.
// Now the same swap is drafted on the 1Click rail (src/rails/intents-native.ts) and held to that
// rail's own checks: the signed quote, the echo of the request it sent, the one fee account, the
// 3 percent cap, the pinned coins and one signature.
//
// ONLY "NO PRICE" MOVES A SWAP. A relay price past the cap stays a refusal, and so does every other
// cause (a coin the list does not name, a balance too small, a list that names another coin): each
// would hold on the other route too, or is a reason to stop. Whoever answers for the relay can send
// a swap here by answering nothing. That buys them the 1Click route as it always was: its checks
// hold the price, and the coins sit with 1Click's solver for the seconds until it delivers, where
// the relay moves both sides at once. Both venues have one operator, already trusted for the price
// on both routes (docs/known-limits.md).
//
// DECIDED BEFORE THE CARD IS PRICED. The route is the draft's venue, pinned when the proposal lands
// as it always was, so the card shows the figures of the route that runs, and execute, a held retry
// and the reconcile sweep all reach that rail. Nothing ever signs on one route and then tries the
// other.

import type { Rail, SwapDraft, SwapQuoteFacts } from '../types.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_NATIVE_VENUE } from '../rails/intents-native.ts';
import { INTENTS_RELAY_VENUE } from '../rails/intents-relay.ts';
import { reasonOf } from '../rails/reasons.ts';
import type { PCtx } from './lifecycle.ts';

/* The same swap on the 1Click rail, with that rail, for a draft on the relay; null for any other
   draft, and where the registry hands one rail for both venues (demo mode, a test's own table):
   there is no other route to take there. */
export function oneClickRoute(ctx: PCtx, draft: SwapDraft): { draft: SwapDraft; rail: Rail } | null {
  if (draft.venue !== INTENTS_RELAY_VENUE) return null;
  const moved: SwapDraft = { ...draft, venue: INTENTS_NATIVE_VENUE, counterparty: INTENTS_NATIVE_COUNTERPARTY };
  const rail = ctx.rails.for(moved);
  return rail === null || rail === ctx.rails.for(draft) ? null : { draft: moved, rail };
}

/* What a swap would get on the route it would take, for a read that files nothing: the relay's
   figures, else 1Click's when the relay offers no price. Any other refusal is the answer as it
   stands, and so is 1Click's own refusal when it is asked. */
export async function routedFacts(ctx: PCtx, draft: SwapDraft, rail: Rail): Promise<SwapQuoteFacts> {
  if (typeof rail.facts !== 'function') throw new Error('this swap rail answers no quote');
  try {
    return await rail.facts(draft);
  } catch (err) {
    const other = reasonOf(err) === 'no_price' ? oneClickRoute(ctx, draft) : null;
    if (other === null || typeof other.rail.facts !== 'function') throw err;
    return other.rail.facts(other.draft);
  }
}
