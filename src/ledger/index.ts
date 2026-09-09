// Ledger orchestrator. Demo mode wraps the static fixture in mutable state so an executed
// consolidation stays visible across refreshes.
//
// LIVE MODE READS ONE PLACE, and that is the whole shape of this app now. This app holds money
// in two venues, NEAR Intents and Hyperliquid, and neither of them is a chain balance: an
// Intents balance is an entry on the verifier's own ledger, and a Hyperliquid balance lives in
// the trading account, read by src/hl/ where it is traded. The five chains still exist and are
// still signed for, but as TRANSIT: money crosses them on its way in and on its way out, and it
// is not held there. So there is no per-chain balance fan-out any more, and chainStatus and gas
// stay on the snapshot only because every reader of a LedgerSnapshot expects one entry per
// chain (see the note on emptyChainStatus).
import type { AppConfig, ChainId, ChainStatus, Holding, LedgerSnapshot, TransferLeg } from '../types.ts';
import { loadDemoLedger } from './demo.ts';
import { fetchIntentsHoldings, type IntentsRead } from './intents.ts';
import { oneClickClient } from '../intents.ts';
import { evmAddress } from '../chain/evm.ts';
import { nearChainSpec } from '../chain/near.ts';
import { readTimeout } from '../net.ts';

const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

// The verifier lives on NEAR, so this is the one RPC endpoint the ledger still needs. It comes
// from src/chain/near.ts so the reader and the signer can never point at different endpoints.
// NOT rpc.mainnet.near.org: that host now answers EVERY request with HTTP 429 and a notice
// telling you to stop using it. Verified 2026-08-13: fastnear answers view_account for
// intents.near in ~200ms.
const NEAR_RPC_URL = nearChainSpec().rpcUrl;

export type Ledger = {
  snapshot(): LedgerSnapshot;
  // What the intents.near verifier holds for this app. Separate from snapshot() because it is
  // not a chain balance, a verifier outage must not mark a chain stale, and it is undefined
  // rather than empty when no read was attempted (demo mode, or no key), because "not asked"
  // and "holds nothing" are different facts.
  intents(): IntentsRead | undefined;
  refresh(): Promise<LedgerSnapshot>;
  applyDemoTransfer(leg: TransferLeg): void;
};

/* Every chain ok, and stamped once. There is no per-chain read left to fail, so there is no
   chain that can go stale: a STALE badge would be reporting on a request nobody made. The five
   keys stay because chainStatus is a total Record<ChainId, ...> and several readers index it
   without a guard; an absent key would be a crash where a truthful "nothing to say" is what is
   meant. The verifier read carries its own ok flag (IntentsRead), and that is the one staleness
   this app can honestly report. */
function emptyChainStatus(): Record<ChainId, ChainStatus> {
  const fetchedAt = new Date().toISOString();
  return Object.fromEntries(ALL_CHAINS.map(c => [c, { ok: true, fetchedAt }])) as Record<ChainId, ChainStatus>;
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
    intents: () => undefined, // demo mode signs nothing and deposits nothing
    refresh: async () => current, // fixture is static; nothing to re-fetch
    applyDemoTransfer,
  };
}

// ---------- live mode ----------

async function fetchSpotUsd(product: string, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`, {
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`coinbase ${product} http ${res.status}`);
  const rows = (await res.json()) as unknown; // [time,low,high,open,close,volume], newest first
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`coinbase ${product} returned no candles`);
  /* The CELL, not just the row. `rows[0][4]` length-checked `rows` and never `rows[0]`, so a
     short row yielded undefined and every holding priced off this table was valued at $0: a
     wallet that reads as empty because one array was the wrong shape. */
  const close = (rows[0] as unknown[] | undefined)?.[4];
  if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
    throw new Error(`coinbase ${product} candle carries no usable close price`);
  }
  return close;
}

/* Best-effort spot prices for the three native gas assets. A failure here must never throw
   refresh() itself; it falls back to the last known price (or 0 on the very first refresh).

   The fallback is what makes the timestamp necessary. Reusing the last known price is the right
   behaviour for a display, which is why it stays, and the wrong behaviour for a cap, because a
   number reused indefinitely reads exactly like a fresh one. So each price carries the time it
   was FETCHED, never the time it was copied forward: a failed fetch keeps the old stamp and the
   value ages out of use on its own. What the panel shows and what the policy engine will govern
   against are then two different questions with two different answers, instead of one number
   silently answering both. */
type LivePrices = { prices: Record<string, number>; asOf: Record<string, number> };

async function resolveLivePrices(
  fetchImpl: typeof fetch,
  fallback: Record<string, number>,
  fallbackAsOf: Record<string, number>,
  now: () => number = Date.now,
): Promise<LivePrices> {
  const products: Array<[string, string]> = [
    ['ETH', 'ETH-USD'],
    ['SOL', 'SOL-USD'],
    ['NEAR', 'NEAR-USD'],
  ];
  const prices: Record<string, number> = { ...fallback };
  const asOf: Record<string, number> = { ...fallbackAsOf };
  await Promise.all(
    products.map(async ([symbol, product]) => {
      try {
        prices[symbol] = await fetchSpotUsd(product, fetchImpl);
        asOf[symbol] = now();
      } catch {
        prices[symbol] = fallback[symbol] ?? 0;
        // The stamp is deliberately NOT touched. This price was not read now.
      }
    }),
  );
  return { prices, asOf };
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
  // Shared client so the 186-entry token list is fetched once per process, not per refresh.
  const oneClick = oneClickClient({ fetchImpl });
  const intentsAccount = intentsAccountId(cfg);
  let liveIntents: IntentsRead | undefined;
  let current: LedgerSnapshot = {
    holdings: [],
    chainStatus: emptyChainStatus(),
    mode: 'live',
    prices: {},
    priceAsOf: {},
    gas: Object.fromEntries(ALL_CHAINS.map(c => [c, { transferCostUsd: 0 }])) as Record<ChainId, { transferCostUsd: number }>,
  };

  // A verifier read that fails keeps the last good holdings, exactly as a chain read does,
  // and carries ok:false so the panel can mark it stale. Blanking the row would say the
  // deposit is gone.
  async function refreshIntents(): Promise<IntentsRead | undefined> {
    if (intentsAccount === null) return undefined;
    const read = await fetchIntentsHoldings({
      rpcUrl: NEAR_RPC_URL,
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
    // Started, not awaited: the verifier read does not depend on a price to happen, only to
    // be valued, so the two run together and meet at the end.
    const livePrices = resolveLivePrices(fetchImpl, current.prices, current.priceAsOf ?? {});

    const [intentsRead, priced] = await Promise.all([refreshIntents(), livePrices]);
    liveIntents = intentsRead;

    /* holdings stays EMPTY on a live snapshot, and that is the fact rather than a gap. What
       this app owns sits inside the Intents verifier and inside the Hyperliquid account, and
       both are read elsewhere: the verifier through intents() just above, the trading account
       through src/hl/. A chain balance would be money parked in transit, which is a state this
       app moves through and does not hold.
       The prices are still fetched, because the wallet panel prices the verifier's rows off
       this same table and a stablecoin held only inside the verifier is priced off nothing
       otherwise. */
    current = {
      holdings: [],
      chainStatus: current.chainStatus,
      mode: 'live',
      prices: priced.prices,
      priceAsOf: priced.asOf,
      gas: current.gas,
    };
    return current;
  }

  return {
    snapshot: () => current,
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
