// The live account that put two liquidation prices on one risk panel, captured and redacted.
//
// One unified Hyperliquid account holding one cross short in SOL, read off the testnet venue on
// 2026-08-13. The figures are kept exactly as the venue reported them, because their
// RELATIONSHIPS are the whole test. The venue's own liquidationPx of 713.4218650794 can be
// reproduced from the spot balance and from nothing else:
//
//   equity 888.381065 (spot USDC)          implies 713.42186508  the venue's own answer
//   equity 898.032117 (spot + perp value)  implies 720.39        7 dollars out
//   equity   9.651052 (perp value alone)   implies  79.42        what the panel was printing
//
// So the perp `accountValue` beside the position is not the account's money and is not part of
// it either: it is position equity, margin drawn from the spot balance plus what the position
// has made and paid since. Adding it to spot counts the same dollars twice.
//
// Two more things this capture pins, both of which the old detection missed:
//
//   totalRawUsd reads POSITIVE at 110.072692. It is the cash leg of the position, and a short
//   sells first, so a short's cash leg goes up. The negative-rawUsd tell only ever fired for
//   longs, which is why a unified account holding this short read as a plain perp account.
//
//   withdrawable reads 0.0 while 888 dollars sit in spot, which is the unified account's
//   signature and the reason no figure on this panel can be taken from the perp view.
//
// The wallet is a placeholder. Nothing here identifies an account.

import { createTradeFeed, type FeedSocket, type TradeFeed } from '../../src/trade/feed-ws.ts';
import type { InfoClient } from '../../src/hl/info.ts';

export const USER = '0xREDACTED00000000000000000000000000000000';

// The venue's own liquidation price for the short, and the number every risk figure on the panel
// has to agree with.
export const VENUE_LIQ_PX = 713.4218650794;

// USDC in spot, which on this account is the collateral behind the perp position.
export const SPOT_USDC_TOTAL = 888.381065;

// Position equity as the legacy perp view reports it. Kept named, because the bug was reading
// this as the account's money.
export const PERP_ACCOUNT_VALUE = 9.651052;

export const CLEARINGHOUSE_STATE: Record<string, unknown> = {
  marginSummary: {
    accountValue: '9.651052',
    totalNtlPos: '100.42164',
    // Positive: the short sold first, so its cash leg is a credit.
    totalRawUsd: '110.072692',
    totalMarginUsed: '10.042164',
  },
  crossMarginSummary: {
    accountValue: '9.651052',
    totalNtlPos: '100.42164',
    totalRawUsd: '110.072692',
    totalMarginUsed: '10.042164',
  },
  // Five percent of notional, which is SOL's maintenance requirement at this venue's maximum
  // leverage of 10. The venue's liquidationPx is only reproducible at this ratio.
  crossMaintenanceMarginUsed: '5.021082',
  withdrawable: '0.0',
  assetPositions: [
    {
      type: 'oneWay',
      position: {
        coin: 'SOL',
        szi: '-1.32',
        entryPx: '75.823',
        positionValue: '100.42164',
        unrealizedPnl: '-0.33528',
        returnOnEquity: '-0.03337',
        liquidationPx: '713.4218650794',
        leverage: { type: 'cross', value: 10, rawUsd: '110.072692' },
        marginUsed: '10.042164',
        maxLeverage: 10,
        cumFunding: { allTime: '0.055832', sinceOpen: '0.055832', sinceChange: '0.055832' },
      },
    },
  ],
  time: 1_786_492_800_000,
};

export const SPOT_STATE: Record<string, unknown> = {
  balances: [{ coin: 'USDC', token: 0, total: '888.381065', hold: '0.0', entryNtl: '888.381065' }],
};

// One field here was not captured: `availableToTrade` was read off the panel as an account-level
// collateral figure, not off the wire, so it is reconstructed as spot total minus margin used.
// Nothing depends on the exact number. What matters, and what was observed, is that the venue
// reports hundreds of dollars available to trade on an account whose whole perp pot is worth
// 9.65, which is collateral that cannot be coming from the perp pot.
export const ACTIVE_ASSET_DATA: Record<string, unknown> = {
  user: USER,
  coin: 'SOL',
  leverage: { type: 'cross', value: 10, rawUsd: '110.072692' },
  maxTradeSzs: ['115.4', '115.4'],
  availableToTrade: ['878.338901', '878.338901'],
  markPx: '76.077',
};

export const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'SOL', szDecimals: 2, maxLeverage: 10 },
  ],
};

// ---------- the harness ----------

// The socket is faked rather than dialled, for the same reason it is in trade-feed-ws.test.ts: a
// unit test cannot make a real venue hold this exact account state still while it asserts.
type FakeSocket = FeedSocket & { open(): void; deliver(msg: unknown): void };

export type FeedHarness = {
  feed: TradeFeed;
  deliver(channel: string, data: unknown): void;
  stop(): void;
};

function fakeInfo(spot: unknown): InfoClient {
  const table: Record<string, unknown> = { meta: META, spotClearinghouseState: spot };
  return {
    post<T>(body: unknown): Promise<T> {
      const type =
        typeof body === 'object' && body !== null ? String((body as Record<string, unknown>).type) : '';
      return Promise.resolve(table[type] as T);
    },
    health: () => ({
      ok: true,
      consecutiveFailures: 0,
      lastError: null,
      lastLatencyMs: null,
      backoffUntilMs: null,
    }),
  };
}

// The boot reads are promises, so one turn of the microtask queue lands them.
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A feed wired to the captured account, opened and watching the coin it holds. `spot` is a
// parameter so a plain perp account can be run through the same harness.
export async function openFeed(over?: { spot?: unknown; watch?: string[] }): Promise<FeedHarness> {
  let live: FakeSocket | null = null;
  function make(): FeedSocket {
    const sock: FakeSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(): void {},
      close(): void {
        sock.readyState = 3;
      },
      open(): void {
        sock.readyState = 1;
        sock.onopen?.();
      },
      deliver(msg: unknown): void {
        sock.onmessage?.({ data: JSON.stringify(msg) });
      },
    };
    live = sock;
    return sock;
  }

  const feed = createTradeFeed({
    wsUrl: 'wss://test.invalid/ws',
    user: USER,
    info: fakeInfo(over?.spot === undefined ? SPOT_STATE : over.spot),
    wsImpl: make,
  });
  await flush();
  const sock = live as FakeSocket | null;
  if (sock === null) throw new Error('the feed never opened a socket');
  sock.open();
  feed.watch(over?.watch === undefined ? ['SOL'] : over.watch);

  return {
    feed,
    deliver: (channel: string, data: unknown) => sock.deliver({ channel, data }),
    stop: () => feed.stop(),
  };
}
