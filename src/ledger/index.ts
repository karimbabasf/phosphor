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
import { fetchIntentsHoldings, type IntentsRead } from './intents.ts';
import { oneClickClient } from '../intents.ts';
import { evmAddress } from '../chain/evm.ts';
import { readPositions } from '../rails/uniswap.ts';

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
    // NOT rpc.mainnet.near.org. That host now answers EVERY request with HTTP 429 and a
    // notice telling you to stop using it, so from the app's side each refresh threw, NEAR
    // was marked stale and its holdings fell back to the last good read (empty on a fresh
    // boot). A dead endpoint and an empty wallet looked identical, which is the same
    // failure this file's network table was written to prevent. Verified 2026-08-13:
    // fastnear answers view_account for intents.near in ~200ms.
    near: 'https://free.rpc.fastnear.com',
  },
  testnet: {
    eth: 'https://ethereum-sepolia-rpc.publicnode.com',
    base: 'https://sepolia.base.org',
    arb: 'https://sepolia-rollup.arbitrum.io/rpc',
    sol: 'https://api.devnet.solana.com',
    near: 'https://test.rpc.fastnear.com', // rpc.testnet.near.org is deprecated the same way
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
  // What the intents.near verifier holds for this app. Separate from snapshot() for the
  // same reason positions() is: it is not a chain balance, a verifier outage must not mark
  // a chain stale, and it is undefined rather than empty when no read was attempted (demo
  // mode, testnet, or no key), because "not asked" and "holds nothing" are different facts.
  intents(): IntentsRead | undefined;
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
    intents: () => undefined, // demo mode signs nothing and deposits nothing
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

// The chain readers set usd = amount for every non-native token, which is this app's
// original stablecoin assumption and is correct for USDC, USDT, DAI and friends. It is
// wrong for any other ERC-20: a wallet holding WETH reported it at a dollar a token. So
// anything we have a spot price for gets priced properly here, natives and non-natives
// alike, and WETH maps to ETH because it is the same dollar behind two contracts.
function priceHoldings(holdings: Holding[], prices: Record<string, number>): Holding[] {
  return holdings.map(h => {
    const key = h.symbol.toUpperCase() === 'WETH' ? 'ETH' : h.symbol.toUpperCase();
    const spot = prices[key];
    if (h.native) return { ...h, usd: h.amount * (spot ?? 0) };
    if (typeof spot === 'number' && Number.isFinite(spot) && spot > 0) return { ...h, usd: h.amount * spot };
    return h; // no spot: leave the reader's stablecoin assumption in place
  });
}

// `prices` is a promise, not a value, and that is the point: a chain read does not depend
// on a price to happen, only to be costed. Awaiting the price feed before starting any of
// this made every refresh pay a Coinbase round trip before the first RPC left the machine.
// The reads and the prices now run together and meet at the end.
async function refreshEvmChain(
  chain: ChainId,
  cfg: AppConfig,
  tokens: TokenTable,
  pricesPromise: Promise<Record<string, number>>,
  prevSnapshot: LedgerSnapshot,
  fetchImpl: typeof fetch,
): Promise<ChainRefreshResult> {
  const fetchedAt = new Date().toISOString();
  const addresses = cfg.addresses.evm;
  if (addresses.length === 0) {
    return { holdings: [], status: { ok: true, fetchedAt }, transferCostUsd: 0 };
  }
  try {
    // One batched round trip per address: token balances, native balance and gas price.
    const perAddress = await Promise.all(
      addresses.map(addr =>
        evm.fetchChainState(chain, RPC_URLS[cfg.network][chain], addr, tokens[chain] ?? {}, fetchImpl),
      ),
    );
    const prices = await pricesPromise;
    const gasPriceWei = perAddress[0]?.gasPriceWei ?? 0n;
    const transferCostUsd = (Number(gasPriceWei) / 1e18) * EVM_TRANSFER_GAS_UNITS * (prices.ETH ?? 0);
    return {
      holdings: perAddress.flatMap(r => r.holdings),
      status: { ok: true, fetchedAt },
      transferCostUsd,
    };
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
  pricesPromise: Promise<Record<string, number>>,
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
    const prices = await pricesPromise;
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
  pricesPromise: Promise<Record<string, number>>,
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
    const prices = await pricesPromise;
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

// Pool positions held by the configured EVM addresses, read off the venue contracts.
//
// Deliberately outside the per-chain token refresh. A venue read failing is not the same
// fact as a chain read failing: a Uniswap deployment can be absent or an NPM call can
// revert while the chain answers token balances perfectly well, so a venue problem must
// not mark the chain stale and blank the token rows. readPositions reports per position
// and per chain through onError and returns what it could read rather than throwing.
async function refreshPositions(cfg: AppConfig, previous: LpPosition[]): Promise<LpPosition[]> {
  if (cfg.addresses.evm.length === 0) return [];
  try {
    const perAddress = await Promise.all(
      cfg.addresses.evm.map(address => readPositions(cfg.network, address, { onError: () => {} })),
    );
    return perAddress.flat();
  } catch {
    // readPositions is written not to throw. If it ever does, the last good list is a
    // better answer than claiming the wallet holds no positions.
    return previous;
  }
}

// The account id the intents.near verifier credits, derived from the KEY rather than from
// config. src/rails/intents-deposit.ts credits `owner.toLowerCase()` and refuses a draft
// naming anything else, so reading the same id is what makes the panel's number and the
// rail's number the same number. Config could name an account this app cannot spend, and a
// balance we cannot touch reported as ours is worse than no row at all.
//
// No key is a normal state, not an error: a read-only install has nothing deposited because
// it cannot deposit. Returns null and the verifier is simply not read.
function intentsAccountId(cfg: AppConfig): string | null {
  try {
    return evmAddress(cfg.keysPath).toLowerCase();
  } catch {
    return null;
  }
}

function createLiveLedger(cfg: AppConfig, fetchImpl: typeof fetch): Ledger {
  const tokens = loadTokenTable(cfg.network);
  let livePositions: LpPosition[] = [];
  // Shared client so the 186-entry token list is fetched once per process, not per refresh.
  const oneClick = oneClickClient({ fetchImpl });
  // intents.near is mainnet only: it has never been deployed on testnet, so there is
  // nothing there to read and asking would produce a permanent stale badge.
  const intentsAccount = cfg.network === 'mainnet' ? intentsAccountId(cfg) : null;
  let liveIntents: IntentsRead | undefined;
  let current: LedgerSnapshot = {
    holdings: [],
    chainStatus: emptyChainStatus(),
    mode: 'live',
    prices: {},
    gas: Object.fromEntries(ALL_CHAINS.map(c => [c, { transferCostUsd: 0 }])) as Record<ChainId, { transferCostUsd: number }>,
  };

  // A verifier read that fails keeps the last good holdings, exactly as a chain read does,
  // and carries ok:false so the panel can mark it stale. Blanking the row would say the
  // deposit is gone.
  async function refreshIntents(): Promise<IntentsRead | undefined> {
    if (intentsAccount === null) return undefined;
    const read = await fetchIntentsHoldings({
      rpcUrl: RPC_URLS[cfg.network].near,
      accountId: intentsAccount,
      tokenList: () => oneClick.tokens(),
      fetchImpl,
    });
    if (!read.ok && liveIntents !== undefined) {
      return { ...read, holdings: liveIntents.holdings };
    }
    return read;
  }

  async function refresh(): Promise<LedgerSnapshot> {
    // Started, not awaited. Everything below runs against this promise and joins it only
    // where a dollar figure is actually needed.
    const pricesPromise = resolveLivePrices(fetchImpl, current.prices);

    const [ethR, baseR, arbR, solR, nearR, positions, intentsRead, prices] = await Promise.all([
      refreshEvmChain('eth', cfg, tokens, pricesPromise, current, fetchImpl),
      refreshEvmChain('base', cfg, tokens, pricesPromise, current, fetchImpl),
      refreshEvmChain('arb', cfg, tokens, pricesPromise, current, fetchImpl),
      refreshSolChain(cfg, tokens, pricesPromise, current, fetchImpl),
      refreshNearChain(cfg, tokens, pricesPromise, current, fetchImpl),
      refreshPositions(cfg, livePositions),
      refreshIntents(),
      pricesPromise,
    ]);
    livePositions = positions;
    liveIntents = intentsRead;

    const holdings = priceHoldings(
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
    // Filled by refreshPositions on every refresh. Empty before the first one, which is
    // honest: nothing has been read, so nothing is claimed.
    positions: () => livePositions,
    intents: () => liveIntents,
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
