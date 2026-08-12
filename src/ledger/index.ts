// Ledger orchestrator. Demo mode wraps the static fixture in mutable state so an executed
// consolidation stays visible across refreshes. Live mode fans out to the chain modules below,
// keeping each chain's previous good holdings on failure (stale, never silently zero).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppConfig, ChainId, ChainStatus, Holding, LedgerSnapshot, LpPosition, Network, TransferLeg } from '../types.ts';
import { loadDemoLedger } from './demo.ts';
import * as evm from './evm.ts';
import * as solana from './solana.ts';
import * as near from './near.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

type TokenTable = Record<string, Record<string, { tokenId: string; decimals: number }>>;

const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

// Per network, with no default. A flat mainnet table was the original shape and it was a
// real bug: with mode live and network testnet the ledger read MAINNET balances using
// MAINNET contracts, so a funded testnet wallet reported zero and looked simply empty
// rather than misconfigured. The wrong answer was indistinguishable from the right one,
// which is the worst kind.
const RPC_URLS: Record<Network, Record<ChainId, string>> = {
  mainnet: {
    eth: 'https://ethereum-rpc.publicnode.com',
    base: 'https://base-rpc.publicnode.com',
    arb: 'https://arbitrum-one-rpc.publicnode.com',
    sol: 'https://api.mainnet-beta.solana.com',
    near: 'https://rpc.mainnet.near.org',
  },
  testnet: {
    eth: 'https://ethereum-sepolia-rpc.publicnode.com',
    base: 'https://sepolia.base.org',
    arb: 'https://sepolia-rollup.arbitrum.io/rpc',
    sol: 'https://api.devnet.solana.com',
    near: 'https://rpc.testnet.near.org',
  },
};

// Est. cost of one stable transfer out of a chain, in usd. Same constants as demo.ts, but
// live mode prices them off a live gas price / live spot instead of the fixture.
const EVM_TRANSFER_GAS_UNITS = 65000;
const SOL_TRANSFER_LAMPORTS = 0.000005;
const SOL_TRANSFER_SIGNATURES = 2;
const NEAR_TRANSFER_NATIVE = 0.005;

export type Ledger = {
  snapshot(): LedgerSnapshot;
  // Pool positions held by the configured addresses. Separate from snapshot() because
  // they are read from venue contracts rather than from token balances, and a venue
  // being down must not mark the whole chain stale.
  positions(): LpPosition[];
  refresh(): Promise<LedgerSnapshot>;
  applyDemoTransfer(leg: TransferLeg): void;
};

function emptyChainStatus(): Record<ChainId, ChainStatus> {
  const fetchedAt = new Date().toISOString();
  return Object.fromEntries(ALL_CHAINS.map(c => [c, { ok: true, fetchedAt }])) as Record<ChainId, ChainStatus>;
}

function loadTokenTable(network: Network): TokenTable {
  const file = network === 'testnet' ? 'tokens.testnet.json' : 'tokens.json';
  return JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8')) as TokenTable;
}

// ---------- demo mode ----------

function createDemoLedger(): Ledger {
  let current: LedgerSnapshot = loadDemoLedger();

  function applyDemoTransfer(leg: TransferLeg): void {
    const holdings = current.holdings.map(h => ({ ...h }));

    const from = holdings.find(h => h.chain === leg.fromChain && h.symbol === leg.symbol && !h.native);
    if (from) from.amount = Math.max(0, from.amount - leg.amount);

    const gasHolding = holdings.find(h => h.chain === leg.fromChain && h.native);
    if (gasHolding) {
      const nativePrice = current.prices[gasHolding.symbol] ?? 0;
      const gasUsd = current.gas[leg.fromChain]?.transferCostUsd ?? 0;
      const gasNativeUnits = nativePrice > 0 ? gasUsd / nativePrice : 0;
      gasHolding.amount = Math.max(0, gasHolding.amount - gasNativeUnits);
    }

    const amountOut = leg.quote?.amountOut ?? leg.amount;
    let to = holdings.find(h => h.chain === leg.toChain && h.symbol === leg.symbol && !h.native);
    if (!to) {
      to = {
        chain: leg.toChain,
        address: from?.address ?? leg.to,
        symbol: leg.symbol,
        tokenId: from?.tokenId ?? leg.symbol,
        amount: 0,
        usd: 0,
        native: false,
      };
      holdings.push(to);
    }
    to.amount += amountOut;

    for (const h of holdings) {
      h.usd = h.native ? h.amount * (current.prices[h.symbol] ?? 0) : h.amount;
    }
    current = { ...current, holdings };
  }

  return {
    snapshot: () => current,
    positions: () => [], // the demo fixture holds no pool positions
    refresh: async () => current, // fixture is static; nothing to re-fetch
    applyDemoTransfer,
  };
}

// ---------- live mode ----------

type ChainRefreshResult = { holdings: Holding[]; status: ChainStatus; transferCostUsd: number };

async function fetchSpotUsd(product: string, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`);
  if (!res.ok) throw new Error(`coinbase ${product} http ${res.status}`);
  const rows = (await res.json()) as number[][]; // [time,low,high,open,close,volume], newest first
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`coinbase ${product} returned no candles`);
  return rows[0][4]; // close
}

// Best-effort spot prices for the three native gas assets. A failure here must never throw
// refresh() itself; it falls back to the last known price (or 0 on the very first refresh).
async function resolveLivePrices(
  fetchImpl: typeof fetch,
  fallback: Record<string, number>,
): Promise<Record<string, number>> {
  const products: Array<[string, string]> = [
    ['ETH', 'ETH-USD'],
    ['SOL', 'SOL-USD'],
    ['NEAR', 'NEAR-USD'],
  ];
  const prices: Record<string, number> = { ...fallback };
  await Promise.all(
    products.map(async ([symbol, product]) => {
      try {
        prices[symbol] = await fetchSpotUsd(product, fetchImpl);
      } catch {
        prices[symbol] = fallback[symbol] ?? 0;
      }
    }),
  );
  return prices;
}

function priceNatives(holdings: Holding[], prices: Record<string, number>): Holding[] {
  return holdings.map(h => (h.native ? { ...h, usd: h.amount * (prices[h.symbol] ?? 0) } : h));
}

async function refreshEvmChain(
  chain: ChainId,
  cfg: AppConfig,
  tokens: TokenTable,
  prices: Record<string, number>,
  prevSnapshot: LedgerSnapshot,
  fetchImpl: typeof fetch,
): Promise<ChainRefreshResult> {
  const fetchedAt = new Date().toISOString();
  const addresses = cfg.addresses.evm;
  if (addresses.length === 0) {
    return { holdings: [], status: { ok: true, fetchedAt }, transferCostUsd: 0 };
  }
  try {
    const perAddress = await Promise.all(
      addresses.map(addr => evm.fetchHoldings(chain, RPC_URLS[cfg.network][chain], addr, tokens[chain] ?? {}, fetchImpl)),
    );
    const gasPriceWei = await evm.fetchGasPriceWei(RPC_URLS[cfg.network][chain], fetchImpl);
    const transferCostUsd = (Number(gasPriceWei) / 1e18) * EVM_TRANSFER_GAS_UNITS * (prices.ETH ?? 0);
    return { holdings: perAddress.flat(), status: { ok: true, fetchedAt }, transferCostUsd };
  } catch (err) {
    return {
      holdings: prevSnapshot.holdings.filter(h => h.chain === chain),
      status: { ok: false, fetchedAt, error: err instanceof Error ? err.message : String(err) },
      transferCostUsd: prevSnapshot.gas[chain]?.transferCostUsd ?? 0,
    };
  }
}

async function refreshSolChain(
  cfg: AppConfig,
  tokens: TokenTable,
  prices: Record<string, number>,
  prevSnapshot: LedgerSnapshot,
  fetchImpl: typeof fetch,
): Promise<ChainRefreshResult> {
  const fetchedAt = new Date().toISOString();
  const addresses = cfg.addresses.solana;
  if (addresses.length === 0) {
    return { holdings: [], status: { ok: true, fetchedAt }, transferCostUsd: 0 };
  }
  try {
    const perAddress = await Promise.all(
      addresses.map(addr => solana.fetchHoldings('sol', RPC_URLS[cfg.network].sol, addr, tokens.sol ?? {}, fetchImpl)),
    );
    const transferCostUsd = SOL_TRANSFER_LAMPORTS * (prices.SOL ?? 0) * SOL_TRANSFER_SIGNATURES;
    return { holdings: perAddress.flat(), status: { ok: true, fetchedAt }, transferCostUsd };
  } catch (err) {
    return {
      holdings: prevSnapshot.holdings.filter(h => h.chain === 'sol'),
      status: { ok: false, fetchedAt, error: err instanceof Error ? err.message : String(err) },
      transferCostUsd: prevSnapshot.gas.sol?.transferCostUsd ?? 0,
    };
  }
}

async function refreshNearChain(
  cfg: AppConfig,
  tokens: TokenTable,
  prices: Record<string, number>,
  prevSnapshot: LedgerSnapshot,
  fetchImpl: typeof fetch,
): Promise<ChainRefreshResult> {
  const fetchedAt = new Date().toISOString();
  const addresses = cfg.addresses.near;
  if (addresses.length === 0) {
    return { holdings: [], status: { ok: true, fetchedAt }, transferCostUsd: 0 };
  }
  try {
    const perAddress = await Promise.all(
      addresses.map(addr => near.fetchHoldings('near', RPC_URLS[cfg.network].near, addr, tokens.near ?? {}, fetchImpl)),
    );
    const transferCostUsd = NEAR_TRANSFER_NATIVE * (prices.NEAR ?? 0);
    return { holdings: perAddress.flat(), status: { ok: true, fetchedAt }, transferCostUsd };
  } catch (err) {
    return {
      holdings: prevSnapshot.holdings.filter(h => h.chain === 'near'),
      status: { ok: false, fetchedAt, error: err instanceof Error ? err.message : String(err) },
      transferCostUsd: prevSnapshot.gas.near?.transferCostUsd ?? 0,
    };
  }
}

function createLiveLedger(cfg: AppConfig, fetchImpl: typeof fetch): Ledger {
  const tokens = loadTokenTable(cfg.network);
  const livePositions: LpPosition[] = [];
  let current: LedgerSnapshot = {
    holdings: [],
    chainStatus: emptyChainStatus(),
    mode: 'live',
    prices: {},
    gas: Object.fromEntries(ALL_CHAINS.map(c => [c, { transferCostUsd: 0 }])) as Record<ChainId, { transferCostUsd: number }>,
  };

  async function refresh(): Promise<LedgerSnapshot> {
    const prices = await resolveLivePrices(fetchImpl, current.prices);
    const [ethR, baseR, arbR, solR, nearR] = await Promise.all([
      refreshEvmChain('eth', cfg, tokens, prices, current, fetchImpl),
      refreshEvmChain('base', cfg, tokens, prices, current, fetchImpl),
      refreshEvmChain('arb', cfg, tokens, prices, current, fetchImpl),
      refreshSolChain(cfg, tokens, prices, current, fetchImpl),
      refreshNearChain(cfg, tokens, prices, current, fetchImpl),
    ]);

    const holdings = priceNatives(
      [...ethR.holdings, ...baseR.holdings, ...arbR.holdings, ...solR.holdings, ...nearR.holdings],
      prices,
    );

    current = {
      holdings,
      chainStatus: { eth: ethR.status, base: baseR.status, arb: arbR.status, sol: solR.status, near: nearR.status },
      mode: 'live',
      prices,
      gas: {
        eth: { transferCostUsd: ethR.transferCostUsd },
        base: { transferCostUsd: baseR.transferCostUsd },
        arb: { transferCostUsd: arbR.transferCostUsd },
        sol: { transferCostUsd: solR.transferCostUsd },
        near: { transferCostUsd: nearR.transferCostUsd },
      },
    };
    return current;
  }

  return {
    snapshot: () => current,
    // Filled by the LP reader once the venue is wired (wave 1A). Empty is honest here:
    // no positions have been read, so none are claimed.
    positions: () => livePositions,
    refresh,
    applyDemoTransfer: () => {
      throw new Error('applyDemoTransfer is demo-mode only');
    },
  };
}

export function createLedger(cfg: AppConfig, deps?: { fetchImpl?: typeof fetch }): Ledger {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  return cfg.mode === 'demo' ? createDemoLedger() : createLiveLedger(cfg, fetchImpl);
}

export type { Holding };
