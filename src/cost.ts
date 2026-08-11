// Fragmentation cost: what it would cost to consolidate every stable balance onto the chain
// that already holds the most, plus what is already lost to dust and stranded balances.
import type { AppConfig, ChainId, CompositionView, CostLine, CostReport, LedgerSnapshot } from './types.ts';

const CONVERSION_FEE_RATE = 0.0001; // 1 basis point, NEAR Intents' quoted rate

function holdingKey(chain: ChainId, symbol: string): string {
  return `${chain}|${symbol}`;
}

function nativeUsdByChain(snapshot: LedgerSnapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of snapshot.holdings) {
    if (h.native) out[h.chain] = h.usd;
  }
  return out;
}

export function fragmentationCost(
  snapshot: LedgerSnapshot,
  _comp: CompositionView,
  cfg: AppConfig,
): CostReport {
  const stableHoldings = snapshot.holdings.filter(h => !h.native);
  const transferCostUsd = (chain: ChainId) => snapshot.gas[chain]?.transferCostUsd ?? 0;

  // Target chain: whichever chain already holds the most stable usd.
  const usdByChain = new Map<ChainId, number>();
  for (const h of stableHoldings) usdByChain.set(h.chain, (usdByChain.get(h.chain) ?? 0) + h.usd);
  let targetChain: ChainId | null = null;
  let targetUsd = -Infinity;
  for (const [chain, usd] of usdByChain) {
    if (usd > targetUsd) {
      targetUsd = usd;
      targetChain = chain;
    }
  }

  // Dust: below the economic transfer size, or below 3x that chain's own transfer cost.
  const dustRows = stableHoldings.filter(
    h => h.usd < Math.max(cfg.economicTransferUsd, 3 * transferCostUsd(h.chain)),
  );
  const dustKeys = new Set(dustRows.map(h => holdingKey(h.chain, h.symbol)));
  const dustUsd = dustRows.reduce((sum, h) => sum + h.usd, 0);

  // Gas to consolidate: one transfer per non-dust holding sitting off the target chain.
  const scattered = targetChain
    ? stableHoldings.filter(h => h.chain !== targetChain && !dustKeys.has(holdingKey(h.chain, h.symbol)))
    : [];
  const gasUsd = scattered.reduce((sum, h) => sum + transferCostUsd(h.chain), 0);
  const scatteredUsd = scattered.reduce((sum, h) => sum + h.usd, 0);
  const conversionUsd = scatteredUsd * CONVERSION_FEE_RATE;

  const staleChains = Object.entries(snapshot.chainStatus)
    .filter(([, status]) => !status.ok)
    .map(([chain]) => chain);
  const gasNote =
    staleChains.length > 0
      ? `${scattered.length} holdings off ${targetChain ?? 'n/a'}; stale chains use last known gas price: ${staleChains.join(', ')}`
      : `${scattered.length} holdings off ${targetChain ?? 'n/a'}`;

  // Stranded: stable usd on a chain that does not have enough native gas to move it, and is
  // not already counted as dust.
  const nativeUsd = nativeUsdByChain(snapshot);
  const strandedRows = stableHoldings.filter(
    h => (nativeUsd[h.chain] ?? 0) < transferCostUsd(h.chain) && !dustKeys.has(holdingKey(h.chain, h.symbol)),
  );
  const strandedUsd = strandedRows.reduce((sum, h) => sum + h.usd, 0);

  const lines: CostLine[] = [
    { label: 'gas to consolidate now', usd: gasUsd, note: gasNote },
    {
      label: 'conversion fees at 1bp',
      usd: conversionUsd,
      note: '0.01% of the gas-eligible scattered balance, via NEAR Intents',
    },
    {
      label: 'dust below economic size',
      usd: dustUsd,
      note: `below $${cfg.economicTransferUsd} or 3x that chain's transfer cost, whichever is larger`,
    },
    {
      label: 'stranded without gas',
      usd: strandedUsd,
      note: 'stable balance on a chain without enough native gas to move it',
    },
  ];

  const totalUsd = lines.reduce((sum, l) => sum + (l.usd ?? 0), 0);
  return { totalUsd, lines };
}
