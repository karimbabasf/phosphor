// What the runner knows about the market and the account.
//
// Two corrections are baked in here, both found against the live venue rather than by reading:
//
//   1. Collateral does NOT come from clearinghouseState. On a unified account that endpoint
//      reports accountValue 0.0 while the account holds real money and trades fine, because it
//      is the legacy perp-only view. Feeding those zeros to the supervisor would have it
//      computing liquidation distance from a blank and concluding nothing is at risk.
//      activeAssetData is the authority: it returns availableToTrade, the leverage actually in
//      force, and the mark price, per coin.
//   2. Positions still come from clearinghouseState, which reports them correctly. So the two
//      endpoints are both needed and neither is sufficient. That split is the whole reason this
//      module exists instead of one fetch inline.
//
// Polling rather than websocket, stated plainly as a limitation. The design calls for
// activeAssetData over a socket and that is the right end state; a poll is what makes the loop
// correct today. It bounds reaction time to the interval, which is fine for a strategy working
// on minute bars and NOT fine for anything genuinely high frequency. The signing path is
// unaffected either way, since that was never the slow part.
//
// Every read goes through the shared /info client rather than bare fetch, and that is a fix
// rather than tidiness. Against a testnet that went to ~16s per call, this module's 2s poll
// stacked eight requests per symbol and delivered no book at all, so an armed mandate sat
// blind. The client bounds each request, merges the identical ones already in flight, and
// stops asking a refusing venue. See src/hl/info.ts.

import { createInfoClient, type InfoClient } from '../hl/info.ts';

export type Book = {
  markPx: number;
  positionUsd: number;
  positionSide: 'flat' | 'long' | 'short';
  entryPx: number;
  unrealisedUsd: number;
  marginAvailable: number;
  maintenanceLeverage: number;
  szDecimals: number;
  assetId: number;
};

export type FeedDeps = {
  baseUrl: string;
  user: string;
  fetchImpl?: typeof fetch;
  // Share one client across the process when there is one. Two clients means two backoff
  // states and two views of whether the venue is answering, and the runner and the window
  // disagreeing about that is exactly the confusion this is meant to end.
  client?: InfoClient;
};

type MetaAsset = { name: string; szDecimals: number; maxLeverage: number };

export function createFeed(deps: FeedDeps) {
  const client =
    deps.client ?? createInfoClient({ baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
  let universe: MetaAsset[] | null = null;

  function info<T>(body: unknown): Promise<T> {
    return client.post<T>(body);
  }

  // Fetched once and held: asset ids and decimals do not change under a running process, and
  // re-reading them every tick would spend rate limit on a constant.
  async function meta(): Promise<MetaAsset[]> {
    if (universe !== null) return universe;
    const m = await info<{ universe: MetaAsset[] }>({ type: 'meta' });
    universe = m.universe;
    return universe;
  }

  return {
    async book(coin: string): Promise<Book | null> {
      const uni = await meta();
      const assetId = uni.findIndex((a) => a.name === coin);
      if (assetId < 0) return null;
      const spec = uni[assetId];

      const [active, clearing] = await Promise.all([
        info<{ markPx: string; availableToTrade: string[]; leverage: { value: number } }>({
          type: 'activeAssetData',
          user: deps.user,
          coin,
        }),
        info<{ assetPositions: { position: Record<string, unknown> }[] }>({
          type: 'clearinghouseState',
          user: deps.user,
        }),
      ]);

      const held = (clearing.assetPositions ?? [])
        .map((p) => p.position)
        .find((p) => String(p.coin) === coin);

      // szi is signed: negative is short. Its absolute value times the mark is the notional
      // the envelope caps on, which is why the sign is read separately rather than left in.
      const szi = held ? Number(held.szi) : 0;
      const markPx = Number(active.markPx);

      return {
        markPx,
        positionUsd: Math.abs(szi) * markPx,
        positionSide: szi === 0 ? 'flat' : szi > 0 ? 'long' : 'short',
        entryPx: held ? Number(held.entryPx) : 0,
        unrealisedUsd: held ? Number(held.unrealizedPnl) : 0,
        // The number clearinghouseState gets wrong on a unified account.
        marginAvailable: Number(active.availableToTrade?.[0] ?? 0),
        // The docs put maintenance margin at half the initial margin at max leverage, so the
        // maintenance leverage is twice the asset's maximum. Derived rather than assumed at a
        // constant, because it varies from 3x to 40x across assets and a wrong value here moves
        // the computed liquidation price.
        maintenanceLeverage: spec.maxLeverage * 2,
        szDecimals: spec.szDecimals,
        assetId,
      };
    },

    // The leverage the venue currently has set for this coin, which is not necessarily the one
    // any program asked for. The runner compares against it before opening.
    async venueLeverage(coin: string): Promise<number | null> {
      const active = await info<{ leverage?: { value: number } }>({
        type: 'activeAssetData',
        user: deps.user,
        coin,
      });
      return active.leverage?.value ?? null;
    },

    // Whether the venue is answering, and how slowly. Surfaced so a stalled feed shows up as
    // a stalled feed on screen rather than as a bot that mysteriously does nothing.
    health: () => client.health(),
  };
}
