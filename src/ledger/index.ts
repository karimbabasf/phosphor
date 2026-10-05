// Ledger orchestrator. Demo mode serves the static fixture; live mode reads the venues.
//
// LIVE MODE READS TWO PLACES, and that is the whole shape of this app now. This app holds money
// in two venues, NEAR Intents and Hyperliquid, and neither of them is a chain balance: an
// Intents balance is an entry on the verifier's own ledger, and a Hyperliquid balance lives in
// the trading account. Money crosses a chain on its way in (the POA deposit address) and on its
// way out (a payout), and it is not held there. So there is no per-chain balance fan-out, no
// chain status and no gas table: the snapshot carries the prices the pocket reads are valued at
// and the stamp of the pass, and each pocket read carries its own ok flag.
import path from 'node:path';
import type { AppConfig, LedgerSnapshot } from '../types.ts';
import { loadDemoLedger, loadDemoReads } from './demo.ts';
import { fetchIntentsHoldings, mergeIntentsReads, REFRESH_PERIOD_MS, type AccountRead, type IntentsRead } from './intents.ts';
import { fetchHyperliquidRead, type HlRead } from './hyperliquid.ts';
import { oneClickClient, type OneClickToken } from '../intents.ts';
import { evmAddress } from '../keystore/index.ts';
import { railAccounts } from '../intents-sign.ts';
import { nearChainSpec } from '../chain/near.ts';
import { readTimeout } from '../net.ts';

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
  // and "holds nothing" are different facts. Once the vault has moved to the chip this is the
  // vault's read and the allowance's together, every row naming its account (reads()).
  intents(): IntentsRead | undefined;
  /* The reads intents() is made of, one per account (PHASE2-PLAN.md C6), as the last pass named
     them. Under kind key both are the vault and its one read. Under kind chip `spend` is the
     allowance the rails sign for and `vault` is where deposits land; null is an account nobody
     can name yet (an allowance before this process has opened the wallet). Optional because the
     tests build many ledgers by hand. */
  reads?(): { vault: AccountRead | null; spend: AccountRead | null };
  // What the Hyperliquid account holds. Same contract as intents(): undefined when never asked.
  hyperliquid(): HlRead | undefined;
  refresh(): Promise<LedgerSnapshot>;
  // Told after every refresh lands, so a proposal waiting to see a balance move can judge the
  // same read the panel is about to show instead of making a read of its own. Returns the
  // unsubscribe. Optional because the tests build many small ledgers by hand and none of them
  // has anything to be told.
  onRefresh?(fn: () => void): () => void;
  /* 1Click's token list, off the one client the verifier read already keeps (a minute's cache,
     one read at a time), so the day feed (src/ledger/day.ts) names its coins without a second
     copy of the list. Absent in demo mode, which reads no venue, and on hand-built ledgers. */
  tokens?(): Promise<OneClickToken[]>;
  // The list as that client last read it, without a read: what a coin is called (src/proposals/coin-words.ts).
  listed?(): OneClickToken[] | null;
};

/* The listeners, kept beside the ledger objects so demo and live share one shape. A listener
   that throws must not cost the refresh that told it, nor the listeners behind it. */
function refreshListeners(): { add(fn: () => void): () => void; tell(): void } {
  const listeners = new Set<() => void>();
  return {
    add(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    tell() {
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          // The listener's problem, not the ledger's.
        }
      }
    },
  };
}

// ---------- demo mode ----------

function createDemoLedger(cfg: AppConfig): Ledger {
  /* The keystore's address on every read, not the fixture's, and read again on each refresh
     because the wallet may be made after this ledger is (first run). See loadDemoReads. */
  let current: LedgerSnapshot = loadDemoLedger();
  let reads = loadDemoReads(intentsAccountId(cfg));
  const listeners = refreshListeners();

  return {
    snapshot: () => current,
    intents: () => reads.intents,
    reads: () => reads.split,
    hyperliquid: () => reads.hyperliquid,
    // The fixture is static and nothing is re-fetched, but the stamp is a claim about WHEN the
    // balances were last read, and src/view/basic.ts holds it against the last fill. See the
    // live refresh for what a stamp that never moved did to the basic screen.
    refresh: async () => {
      current = { ...current, fetchedAt: new Date().toISOString() };
      reads = loadDemoReads(intentsAccountId(cfg));
      listeners.tell();
      return current;
    },
    onRefresh: listeners.add,
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
   refresh() itself; it falls back to the last known price, and with none known the price stays
   absent. It used to become 0 on the very first refresh, and a price of 0 reads as "worth
   nothing" wherever a reader forgets to ask whether it is a price at all: unknown stays unknown.

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
        // The last known price stays (copied in above) and so does its stamp: this price was not
        // read now. With none known the symbol stays absent, never a made-up 0.
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
//
// ASKED ON EVERY PASS, never once. This used to be captured when the ledger was built, at boot,
// and a fresh install has no wallet at boot: the first deposit stayed invisible until a restart
// (docs/bugs/2026-09-15-first-deposit-invisible-until-restart.md). The answer comes from the
// keystore's plaintext header, one file read, which is nothing next to the RPC calls behind it.
// Exported because the Hyperliquid reads in src/main.ts have to name the same account, for
// the same reason: the trading account is this address and nothing in config.
// It is the VAULT in every kind of wallet: deposits, invites and the trading account stay there
// once the vault moves to the chip, and only the rails move to the allowance (spendAccountId).
export function intentsAccountId(cfg: AppConfig): string | null {
  try {
    return evmAddress(cfg.keysPath).toLowerCase();
  } catch {
    return null;
  }
}

/* The account the rails spend from (src/intents-sign.ts railAccounts), lowercased: the vault
   under kind key, the allowance once the vault has moved, and null while that allowance cannot be
   named yet. Asked on every pass, like the vault. */
export function spendAccountId(cfg: AppConfig): string | null {
  const vault = intentsAccountId(cfg);
  try {
    const accounts = railAccounts(cfg.keysPath);
    return accounts.kind === 'key' ? vault : (accounts.spend?.toLowerCase() ?? null);
  } catch {
    // A read, so the vault alone is a safe answer; the signer asks again and fails by name.
    return vault;
  }
}

function createLiveLedger(cfg: AppConfig, fetchImpl: typeof fetch, log: (line: string) => void): Ledger {
  // Shared client so the 186-entry token list is fetched once per process, not per refresh, and
  // its names kept in the data directory so the next start has them before 1Click answers.
  const oneClick = oneClickClient({ fetchImpl, cachePath: path.join(cfg.dataDir, 'oneclick-tokens.json') });
  /* THE LIST IN HAND, NEVER A WAIT ON 1CLICK, once there is one. The verifier's balances came back
     in 0.38 s and waited on the list for their names and decimals until 0.72 s on a good day, and
     until the 10 s read deadline while 1Click hung (2026-10-05, Karim: "it says zero for a while").
     A list past its minute is read again behind the balance, for the next pass. With none in hand
     at all, a first run, the read still waits: decimals are what make the numbers right. */
  const tokenList = (): Promise<OneClickToken[]> => {
    const inHand = oneClick.cached?.() ?? null;
    if (inHand === null) return oneClick.tokens();
    void oneClick.tokens().catch(() => undefined);
    return Promise.resolve(inHand);
  };
  const listeners = refreshListeners();
  // One read per account (PHASE2-PLAN.md C6), each keeping its own misses and its own last good
  // holdings, and the accounts the last pass read: intents() and reads() answer from these.
  let byAccount = new Map<string, IntentsRead>();
  let named: { vault: string | null; spend: string | null } = { vault: null, spend: null };
  let liveHl: HlRead | undefined;
  // Reads started and the newest one written, so a slow read that answers after a newer one
  // has written is dropped at the write: the last answer to arrive is not the newest read, and
  // a read that failed on its 10 s deadline used to land on top of a good one that came after
  // it, marking the verifier stale when it had just answered.
  let started = 0;
  let written = 0;
  // Pending until the first pass lands: every place is unknown, not empty (src/wallet.ts).
  let current: LedgerSnapshot = {
    mode: 'live',
    fetchedAt: new Date().toISOString(),
    prices: {},
    priceAsOf: {},
    pending: true,
  };

  // A verifier read that fails keeps the last good holdings AND their stamp, counts the miss,
  // and says why, once, in the log. Blanking the row would say the deposit is gone; marking it
  // stale on the first miss flashed a warning over a readable balance (the wallet report waits
  // for two in a row, see intentsUnreadWhy). The reason used to be captured here and dropped.
  // Per account: the allowance's misses are its own, and its line names it.
  async function refreshIntents(account: string | null, which = ''): Promise<IntentsRead | undefined> {
    if (account === null) return undefined;
    const last = byAccount.get(account);
    const read = await fetchIntentsHoldings({
      rpcUrl: NEAR_RPC_URL,
      accountId: account,
      tokenList,
      listedAt: () => oneClick.listedAt?.() ?? null,
      fetchImpl,
    });
    if (read.ok) return { ...read, failures: 0 };
    const failures = (last?.failures ?? 0) + 1;
    log(`phosphor: the verifier read${which} failed (${read.error ?? 'no reason given'}), ${failures} in a row`);
    // No good read before this one: there are no holdings to keep, so none to show.
    if (last === undefined || last.unknown === true) return { ...read, failures, unknown: true };
    return { ...read, holdings: last.holdings, fetchedAt: last.fetchedAt, failures };
  }

  // The vault's read alone under kind key; under kind chip the vault's and the allowance's together.
  function combined(): IntentsRead | undefined {
    const vault = named.vault === null ? undefined : byAccount.get(named.vault);
    const spend = named.spend === null || named.spend === named.vault ? undefined : byAccount.get(named.spend);
    if (vault === undefined || spend === undefined) return vault ?? spend;
    return mergeIntentsReads([vault, spend]);
  }
  let liveIntents: IntentsRead | undefined;

  // The trading account is the same address the verifier credits, checksummed by the venue's
  // reader. A failed read keeps the last good figures under ok:false, as the verifier read does.
  async function refreshHyperliquid(account: string | null): Promise<HlRead | undefined> {
    if (account === null) return undefined;
    const read = await fetchHyperliquidRead({ keysPath: cfg.keysPath, fetchImpl }, account);
    if (read.ok) return read;
    if (liveHl === undefined || liveHl.unknown === true) return { ...read, unknown: true };
    return { ...liveHl, ok: false, fetchedAt: read.fetchedAt, error: read.error };
  }

  async function refresh(): Promise<LedgerSnapshot> {
    /* STAMPED WHEN THE READS START, and stamped on every pass.
       `fetchedAt` is what src/view/basic.ts holds against the newest executed proposal to decide
       whether the total on screen already counts the last fill. It used to be stamped once, at
       boot, and carried forward unchanged by every refresh, so from the first fill after boot
       the read was older than the execution for the life of the process and the basic screen
       said "checking your new balance" and never stopped. The stamp is taken before the reads
       rather than after them because a read that started before a fill can only carry the
       balance from before it, whatever the clock said when the answer came back. */
    const fetchedAt = new Date().toISOString();
    const seq = ++started;
    // Started, not awaited: the verifier read does not depend on a price to happen, only to
    // be valued, so the two run together and meet at the end.
    const livePrices = resolveLivePrices(fetchImpl, current.prices, current.priceAsOf ?? {});

    // Resolved here, on this pass, so a wallet created after boot is read from its first
    // refresh on. See intentsAccountId for the bug this closes. The allowance is read beside
    // the vault once the vault has moved; the trading account is the vault's in every kind.
    const account = intentsAccountId(cfg);
    const spend = spendAccountId(cfg);
    const apart = spend !== null && spend !== account ? spend : null;
    const [intentsRead, spendRead, hlRead, priced] = await Promise.all([
      refreshIntents(account),
      refreshIntents(apart, ' for the allowance'),
      refreshHyperliquid(account),
      livePrices,
    ]);
    // A newer read has already written: this answer is older than what is on screen.
    if (seq < written) return current;
    written = seq;
    const next = new Map<string, IntentsRead>();
    if (account !== null && intentsRead !== undefined) next.set(account, intentsRead);
    if (apart !== null && spendRead !== undefined) next.set(apart, spendRead);
    byAccount = next;
    named = { vault: account, spend };
    liveIntents = combined();
    liveHl = hlRead;

    /* What this app owns sits inside the Intents verifier and inside the Hyperliquid account,
       and both are read above: the verifier through intents(), the trading account through
       hyperliquid(). The prices are fetched because the wallet panel prices the verifier's
       rows off this table, and a stablecoin held only inside the verifier is priced off
       nothing otherwise. */
    current = {
      mode: 'live',
      fetchedAt,
      prices: priced.prices,
      priceAsOf: priced.asOf,
    };
    listeners.tell();
    return current;
  }

  const accountRead = (account: string | null): AccountRead | null => (account === null ? null : { account, read: byAccount.get(account) });

  return {
    snapshot: () => current,
    intents: () => liveIntents,
    reads: () => ({ vault: accountRead(named.vault), spend: accountRead(named.spend) }),
    hyperliquid: () => liveHl,
    refresh,
    onRefresh: listeners.add,
    tokens: () => oneClick.tokens(),
    listed: () => oneClick.cached?.() ?? null,
  };
}

// `log` is where a failed verifier read says why (the process log, by default); a test hands in
// a collector so the line can be checked and the run stays quiet.
export function createLedger(cfg: AppConfig, deps?: { fetchImpl?: typeof fetch; log?: (line: string) => void }): Ledger {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const log = deps?.log ?? ((line: string) => console.error(line));
  return cfg.mode === 'demo' ? createDemoLedger(cfg) : createLiveLedger(cfg, fetchImpl, log);
}

export { REFRESH_PERIOD_MS };
