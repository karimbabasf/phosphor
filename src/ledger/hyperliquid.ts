// What the Hyperliquid account holds, read off the venue's public info endpoint.
//
// The third pocket. Money moves wallet <-> intents <-> HyperCore, and the wallet panel has to
// show all three or the agent cannot verify a deposit or a withdrawal without a second tool.
// Same shape of contract as the verifier read beside it: never throws, carries its own ok
// flag, and undefined (not asked) is a different fact from empty (asked, holds nothing).
//
// No key is needed: the account is identified by the address the app signs for, which the
// keystore header carries in plaintext, and every read here is a public POST to /info.

import { accountSummary } from '../rails/hl-user-signed.ts';
import type { HlUserSignedDeps } from '../rails/hl-user-signed.ts';

export type HlRead = {
  ok: boolean;
  fetchedAt: string;
  account: string;
  // USDC on the venue, both books: the single balance on a unified account, spot plus perp
  // account value on a standard one.
  collateralUsdc: number;
  availableUsdc: number; // free to send or to margin a new position
  marginUsedUsd: number;
  openPositions: number;
  unified: boolean;
  error?: string;
};

export async function fetchHyperliquidRead(deps: HlUserSignedDeps, account: string): Promise<HlRead> {
  const fetchedAt = new Date().toISOString();
  try {
    const s = await accountSummary(deps, account);
    return {
      ok: true,
      fetchedAt,
      account,
      collateralUsdc: s.unified ? s.spotUsdc : s.spotUsdc + s.perpAccountValueUsd,
      availableUsdc: s.availableUsdc,
      marginUsedUsd: s.marginUsedUsd,
      openPositions: s.openPositions,
      unified: s.unified,
    };
  } catch (err) {
    return {
      ok: false,
      fetchedAt,
      account,
      collateralUsdc: 0,
      availableUsdc: 0,
      marginUsedUsd: 0,
      openPositions: 0,
      unified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
