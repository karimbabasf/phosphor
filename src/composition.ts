// Classifies stable holdings by issuer, freeze power and reserve type using the curated risk
// table. Pure function, no IO. Unclassified symbols fail pessimistic: freezable, not classified.
import type { CompositionRow, CompositionView, LedgerSnapshot, RiskRow } from './types.ts';

export function classify(snapshot: LedgerSnapshot, rows: RiskRow[]): CompositionView {
  const bySymbol = new Map(rows.map(r => [r.symbol, r]));
  const stableHoldings = snapshot.holdings.filter(h => !h.native);
  const totalUsd = stableHoldings.reduce((sum, h) => sum + h.usd, 0);

  const compRows: CompositionRow[] = stableHoldings
    .map(h => {
      const risk = bySymbol.get(h.symbol);
      return {
        issuer: risk ? risk.issuer : 'unclassified',
        symbol: h.symbol,
        chain: h.chain,
        amount: h.amount,
        usd: h.usd,
        share: totalUsd > 0 ? h.usd / totalUsd : 0,
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
