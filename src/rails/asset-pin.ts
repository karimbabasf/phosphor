// The coins a card was priced with, held to at execute.
//
// Every intents rail names its coins by 1Click's asset id and counts them in that coin's decimals,
// and both come off 1Click's token list, which nothing signs. The rails read the list again at
// execute, after the click, so a list that had changed in between (a TLS position on the venue, or
// the venue's own list) bought a different coin than the card showed, or scaled the amount by a
// power of ten (audit 2026-10-01, aud-money-rails). Now the card's coins ride on its simulation
// (SimulationResult.assets), the proposal pins them into the draft it lands (src/proposals/draft.ts),
// and execute signs for exactly those: a list that says anything else about them refuses the move.

import type { AssetPin, MovedAssets } from '../types.ts';
import { oneLine } from '../intents.ts';
import { ReasonError } from './reasons.ts';

/* The coin to use: the pinned one, once the list agrees with it, or the list's own answer while
   nothing is pinned yet (the propose that prices the card). `coin` names it for the sentence. */
export function heldToPin(pin: AssetPin | undefined, listed: AssetPin, coin: string): AssetPin {
  if (pin === undefined) return listed;
  if (listed.assetId !== pin.assetId) {
    throw new ReasonError(
      'simulation_failed',
      `1Click's coin list now gives ${coin} as ${oneLine(listed.assetId, 90)}, not the ${oneLine(pin.assetId, 90)} this move was ` +
        'priced and approved with, so nothing was signed. Ask again for a fresh quote.',
    );
  }
  if (listed.decimals !== pin.decimals) {
    throw new ReasonError(
      'simulation_failed',
      `1Click's coin list now counts ${coin} in ${listed.decimals} decimals, not the ${pin.decimals} this move was priced and ` +
        'approved with, so nothing was signed. Ask again for a fresh quote.',
    );
  }
  return pin;
}

/* What execute requires: a draft that lands now always carries its coins, and one that does not
   was approved before they were pinned. Run as asked it would be priced off today's list. */
export function pinnedAssets(assets: MovedAssets | undefined): MovedAssets {
  if (assets === undefined) {
    throw new ReasonError(
      'simulation_failed',
      'This move was approved before Phosphor pinned the coins it moves, so it was not run and nothing was signed. Ask for it again.',
    );
  }
  return assets;
}
