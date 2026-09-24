// What a rail does with a resolveAsset answer it cannot act on alone.
//
// Two tokens under one ticker is a question for the person, and the window asks it as two tiles
// (ui/screens/assetpick.js). A rail reached without the window, which is every rail today and the
// MCP door always, cannot draw tiles, so it refuses and hands the agent the two ids. The refusal
// is the same fact in words: name one of these two and call again.

import type { AssetPick } from '../intents.ts';
import { oneLine } from '../intents.ts';
import type { SwapSimulation } from '../types.ts';
import { ReasonError } from './reasons.ts';

/* WHAT A SWAP GETS, in the words the agent says and the card prints: about how much arrives, the
   least it can be, the fee and the time ("About 3.8255 USDC, at least 3.8064. Fee about $0.01,
   about 12 seconds."). The engineer's lines ride on the simulation's `developer` field instead:
   "solver floor 3806395 base units" was being read out to a person (2026-09-23). */
export function swapSummary(swap: SwapSimulation, symbol: string): string {
  const coin = symbol.toUpperCase() === 'WNEAR' ? 'NEAR' : symbol;
  const tail: string[] = [];
  if (swap.feeUsd !== null && Number.isFinite(swap.feeUsd)) tail.push(swap.feeUsd < 0.005 ? 'fee under a cent' : `fee about $${swap.feeUsd.toFixed(2)}`);
  if (swap.etaSeconds !== null && Number.isFinite(swap.etaSeconds) && swap.etaSeconds > 0) {
    const s = Math.round(swap.etaSeconds);
    tail.push(s < 90 ? `about ${s} seconds` : `about ${Math.round(s / 60)} minutes`);
  }
  const said = tail.join(', ');
  const time = said === '' ? '' : ` ${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
  return `About ${about(swap.receives)} ${coin}, at least ${about(swap.receivesAtLeast)}.${time}`;
}

// Five significant figures: 3.825523 is "3.8255", and a small coin keeps its digits.
function about(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5 }).format(n) : amount;
}

export function pickOrExplain(
  pick: AssetPick,
  symbol: string,
  network: string,
): { assetId: string; decimals: number; native: boolean; priceUsd: number | null } {
  if (pick.kind === 'one') {
    return { assetId: pick.assetId, decimals: pick.decimals, native: pick.native, priceUsd: pick.priceUsd };
  }
  const said = pick.candidates
    .map((c) => `${oneLine(c.assetId, 60)} (${c.decimals} decimals)`)
    .join(' and ');
  throw new ReasonError(
    'ambiguous_asset',
    `${pick.candidates.length} different tokens are called ${oneLine(symbol, 20)} on ${network}: ${said}. ` +
      'They are not the same coin and their decimals differ, so this app will not pick one for you: ' +
      'ask the person which they mean, then name one of them as the symbol and propose again',
  );
}
