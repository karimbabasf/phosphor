// What the composition panel renders: everything held, the way a normal wallet shows it.
// Karim, 2026-08-11: "the composition thing should just show what a normal crypto wallet
// would show". So natives are in (classify() filters them out for the policy engine's
// purposes, which is a different question) and pool positions sit in the same table as
// one line each, because a wallet that hides your LP is lying about what you hold.
//
// Pure function, no IO. LP positions are passed in rather than fetched here: the chain
// readers own fetching, this owns presentation.

import type { ChainId, LedgerSnapshot, LpPosition, WalletRow, WalletView } from './types.ts';

// Price per unit, derived from what the ledger already priced rather than re-fetched.
// Stables land on ~1.0, natives on spot, and a zero balance cannot divide.
function unitPrice(amount: number, usd: number): number {
  return amount > 0 ? usd / amount : 0;
}

function lpLabel(pos: LpPosition): string {
  const pair = `${pos.token0.symbol}/${pos.token1.symbol}`;
  if (pos.feeTier === null) return pair;
  return `${pair} ${(pos.feeTier / 10_000).toFixed(2)}%`;
}

// An LP position's value is the two sides plus whatever fees it has accrued. Prices come
// from the same snapshot the tokens are priced from, so a pool position and a loose token
// of the same symbol never disagree about what that symbol is worth.
function lpValueUsd(pos: LpPosition, priceOf: (symbol: string) => number): number {
  const sides = pos.token0.amount * priceOf(pos.token0.symbol) + pos.token1.amount * priceOf(pos.token1.symbol);
  return sides + (pos.uncollectedFeesUsd ?? 0);
}

export function buildWallet(snapshot: LedgerSnapshot, positions: LpPosition[] = []): WalletView {
  // Symbol -> unit price, learned from the holdings themselves and topped up from the
  // snapshot's native price table for symbols held only inside a pool.
  const priceBySymbol = new Map<string, number>();
  for (const h of snapshot.holdings) {
    const price = unitPrice(h.amount, h.usd);
    if (price > 0) priceBySymbol.set(h.symbol, price);
  }
  for (const [symbol, price] of Object.entries(snapshot.prices)) {
    if (!priceBySymbol.has(symbol)) priceBySymbol.set(symbol, price);
  }
  const priceOf = (symbol: string): number => priceBySymbol.get(symbol) ?? 0;

  const tokenRows: WalletRow[] = snapshot.holdings.map(h => ({
    kind: 'token',
    chain: h.chain,
    symbol: h.symbol,
    tokenId: h.tokenId,
    quantity: h.amount,
    priceUsd: unitPrice(h.amount, h.usd),
    valueUsd: h.usd,
    share: 0, // filled below, once the total is known
    native: h.native,
  }));

  const lpRows: WalletRow[] = positions.map(pos => {
    const valueUsd = lpValueUsd(pos, priceOf);
    return {
      kind: 'lp',
      chain: pos.chain,
      symbol: lpLabel(pos),
      tokenId: pos.poolId,
      // A pool position has no meaningful unit count, so quantity carries the position
      // count (always 1) and price carries its value. Showing a fabricated "LP token
      // amount" for a v3 NFT would be inventing a number the chain does not have.
      quantity: 1,
      priceUsd: valueUsd,
      valueUsd,
      share: 0,
      native: false,
      lp: pos,
    };
  });

  const rows = [...tokenRows, ...lpRows].sort((a, b) => b.valueUsd - a.valueUsd);
  const totalUsd = rows.reduce((sum, r) => sum + r.valueUsd, 0);
  for (const row of rows) row.share = totalUsd > 0 ? row.valueUsd / totalUsd : 0;

  const byChain: Record<string, number> = {};
  for (const row of rows) byChain[row.chain] = (byChain[row.chain] ?? 0) + row.valueUsd;

  const stale = (Object.entries(snapshot.chainStatus) as Array<[ChainId, { ok: boolean }]>)
    .filter(([, status]) => !status.ok)
    .map(([chain]) => chain);

  return { rows, totalUsd, byChain, stale };
}
