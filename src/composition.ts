// Classifies the issued coins this app holds by issuer, freeze power and reserve type using
// the curated risk table. Pure function, no IO. Unclassified symbols fail pessimistic:
// freezable, not classified.
//
// Fed from the wallet rows: the balances inside NEAR Intents and the Hyperliquid collateral.
// USDC is Circle and freezable, USDT is Tether; ETH, SOL, NEAR and BTC have no issuer and no
// freeze power, so they sit outside the composition the way the chain natives used to.
import type { CompositionRow, CompositionView, RiskRow, WalletPlace } from './types.ts';

// Everything classify needs of a balance. A WalletRow satisfies it, and so does the row the
// policy engine builds for the state a move would leave behind.
export type Position = { symbol: string; chain: WalletPlace; quantity: number; valueUsd: number };

// Assets with no issuer: nobody can freeze them and no share cap is about them.
const NO_ISSUER = new Set(['ETH', 'WETH', 'SOL', 'NEAR', 'BTC', 'WBTC']);

export function hasIssuer(symbol: string): boolean {
  return !NO_ISSUER.has(symbol.toUpperCase());
}

export function classify(positions: Position[], rows: RiskRow[]): CompositionView {
  const bySymbol = new Map(rows.map(r => [r.symbol, r]));
  const issued = positions.filter(p => hasIssuer(p.symbol) && p.valueUsd > 0);
  const totalUsd = issued.reduce((sum, p) => sum + p.valueUsd, 0);

  const compRows: CompositionRow[] = issued
    .map(p => {
      const risk = bySymbol.get(p.symbol);
      return {
        issuer: risk ? risk.issuer : 'unclassified',
        symbol: p.symbol,
        chain: p.chain,
        amount: p.quantity,
        usd: p.valueUsd,
        share: totalUsd > 0 ? p.valueUsd / totalUsd : 0,
        freezable: risk ? risk.freezable : true,
        classified: !!risk,
      };
    })
    .sort((a, b) => b.share - a.share);

  const byIssuer: Record<string, number> = {};
  for (const row of compRows) {
    byIssuer[row.issuer] = (byIssuer[row.issuer] ?? 0) + row.share;
  }

  const freezableShare = compRows.filter(r => r.freezable).reduce((sum, r) => sum + r.share, 0);
  const unclassified = [...new Set(compRows.filter(r => !r.classified).map(r => r.symbol))];

  return { rows: compRows, totalUsd, byIssuer, freezableShare, unclassified };
}
