// What a rail does with a resolveAsset answer it cannot act on alone.
//
// Two tokens under one ticker is a question for the person, and the window asks it as two tiles
// (ui/screens/assetpick.js). A rail reached without the window, which is every rail today and the
// MCP door always, cannot draw tiles, so it refuses and hands the agent the two ids. The refusal
// is the same fact in words: name one of these two and call again.

import type { AssetPick } from '../intents.ts';
import { oneLine } from '../intents.ts';

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
  throw new Error(
    `${pick.candidates.length} different tokens are called ${oneLine(symbol, 20)} on ${network}: ${said}. ` +
      'They are not the same coin and their decimals differ, so this app will not pick one for you: ' +
      'ask the person which they mean, then name one of them as the symbol and propose again',
  );
}
