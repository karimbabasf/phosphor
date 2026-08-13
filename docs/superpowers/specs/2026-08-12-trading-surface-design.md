# The trading surface

**Status:** design, approved to build 2026-08-12
**Implements:** the second interface named in `2026-08-12-phosphor-trading-design.md`
**Flow and states:** `ux/flow.md` (written first, and binding)

## What this is

Phosphor has one screen today and it is a custody screen: what you hold on the left, what
governs it on the right. Swaps, liquidity positions, balances. That surface stays exactly as it
is and this document does not touch it.

Perpetuals are a different job. A custody screen answers "what do I own". A trading screen
answers a question custody never asks: **what happens to me if price moves against this.**
Those need different furniture, so they get different pages: `/` stays the pro page, `/trade`
is new.

## The one idea

Every leveraged position has two prices that end it.

The first is the **liquidation**, drawn by the venue. Cross that and Hyperliquid takes the
position and the margin behind it. Every trading interface in existence shows this line.

The second is the **mandate stop-out**, drawn by the human. It is the price at which the loss
they signed for is reached and the bot stands down. **No other trading interface can show this
line, because in no other interface does it exist.** There is nothing to draw when authority was
never bounded: you gave an app your keys, or you clicked buy yourself, and either way the only
wall is the exchange's.

Phosphor can draw both. That is the whole architecture rendered as two lines on a chart, and it
is what the page is built around.

### A correction to that claim, found by looking at real numbers

An earlier draft of this document said the human's wall is **always** nearer than the venue's,
because a mandate whose maximum loss exceeds its own notional is refused at propose time. That
is wrong, and the first armed mandate on live data showed it.

A mandate capped at $60 notional with a $12 loss allowance, holding a $30 position, put its
stop-out at **$1,133** while the projected liquidation for the same account sat at **$1,422**.
The venue's wall was nearer by three hundred dollars of price.

The reason is that the two walls are computed against different quantities. The liquidation
follows the margin behind the position **actually held**; the stop-out follows the loss
allowance spread over that same position, so a generous allowance on a small position puts it a
very long way down. The propose-time guard compares the loss cap to the **maximum** notional,
which says nothing about the position that ends up open.

What is true is narrower and still worth the page: **the human's wall exists at all.** Whether
it bites first depends on the numbers, and that is precisely why the surface draws both rather
than asserting an ordering. Where it lands is a fact about a particular mandate and the reader
should be able to see it, not be told a rule that holds only sometimes.

Everything else on the screen is in service of that or is ordinary competence.

## Layout

The pro page's grid, reused rather than reinvented: a full-width status bar over a two-column
deck, each column a stack of framed panels, the page itself never scrolling.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PHOSPHOR TRADE │ BTC │ mark │ funding │ equity │ free │ feed │ [KILL]    │
├───────────────────────────────────────┬──────────────────────────────────┤
│ CHART                                 │ RISK                             │
│   candles, indicators, drawings       │   equity / margin / free         │
│   + entry, liquidation, mandate wall  │   liquidation distance bar       │
│   + working orders, fills             │   in percent, dollars AND ATR    │
│                                       ├──────────────────────────────────┤
│                                       │ MANDATE                          │
│                                       │   program in English             │
│                                       │   four bounds filling up         │
│                                       │   [ DISARM ]                     │
├───────────────────────────────────────┼──────────────────────────────────┤
│ BOOK                                  │ LOG                              │
│   position rows, with their working   │   audit lines, refusals in red   │
│   orders nested underneath            │                                  │
└───────────────────────────────────────┴──────────────────────────────────┘
```

Two decisions in there are not conventional and are deliberate.

**There is no order ticket.** The place every trading UI puts a buy/sell form is where this one
puts the mandate console. That is not an omission; it is the thesis. A human clicking buy is
the thing this app is not for. Manual controls exist and every one of them STOPS something:
disarm, cancel, close, flatten, kill.

**Working orders are nested under the position they belong to, not listed in their own table.**
A stop at 3200 is not an independent object floating in an orders blotter, it is a property of
the ETH long. Rendering it as a child row is more truthful and saves a whole table's worth of
screen. An order with no position (a resting entry) sorts to the bottom under its own heading.

## Data: websocket, not polling

The runner's REST poller starved against a testnet doing sixteen seconds per call, which
`src/hl/info.ts` now bounds. That fix makes REST survivable. It does not make it right here.

Hyperliquid's own rate-limit documentation says it plainly: the IP weight budget is 1200 per
minute, most `/info` calls weigh 20, and "it is far easier to blow the limit with a chatty
polling loop than with orders. Prefer WebSocket for state." A trading screen wanting positions,
orders, fills, mark, funding and account health, refreshed, is exactly that chatty loop.

So the trading surface reads over one websocket:

| what | subscription |
|---|---|
| account state, positions | `{"type":"clearinghouseState","user":"0x..","dex":""}` |
| collateral on a unified account | `{"type":"activeAssetData","user":"0x..","coin":"<coin>"}` |
| resting and trigger orders | `{"type":"openOrders","user":"0x..","dex":""}` |
| fills | `{"type":"userFills","user":"0x.."}` |
| liquidations and funding events | `{"type":"userEvents","user":"0x.."}` (channel name is `user`) |
| mark, oracle, funding, open interest | `{"type":"activeAssetCtx","coin":"<coin>"}` |

Three details that are easy to get wrong and expensive to get wrong:

1. **Heartbeat.** The server closes any connection it has not sent a message to in 60 seconds.
   The existing `hyperliquidLive` gets away with having no ping because a `trades` subscription
   on a busy coin never idles. An account subscription on a quiet account idles constantly, so
   this client MUST send `{"method":"ping"}` on a timer and expect `{"channel":"pong"}`.
2. **Snapshots.** Messages carry `isSnapshot: true` on reconnect. Missed data arrives in the
   snapshot, so a reconnect replaces state rather than appending to it, or fills double.
3. **REST stays** for one-shot reads (`meta` at boot) and as the declared fallback when the
   socket is down. `src/hl/info.ts` is that path and it is already bounded.

Latency, stated honestly: a websocket removes the poll interval, so the screen is behind the
venue by the network hop and one animation frame. That is the right end state and it was
already named as such in the runner's own feed comments. **It does not change execution
latency at all**, which lives in the runner child process and was never the slow part.

## Derived numbers: where the instrument layer earns its keep

The venue reports a liquidation price. Phosphor reports how far away it is, in three units at
once, and the third is the one that means something:

- **percent**, which is familiar and nearly useless alone
- **dollars**, which is what you actually lose
- **ATR multiples**, which is the only one that answers "is that far?"

Twelve percent from liquidation sounds safe and is not, if this thing moves eight percent a
day. `src/analysis/regime.ts` already computes Wilder ATR for the chart. Reusing it here means
the risk panel and the chart cannot disagree about volatility, and it is a number no venue UI
shows because no venue UI has an analysis layer sitting next to its account state.

The **mandate wall price** is derived, not fetched. For a position of size `s` at entry `e`
with an approved maximum loss `L` and realised loss `r` already taken, the wall is the price at
which unrealised loss reaches `L - r`:

```
long:  wall = e - (L - r) / s
short: wall = e + (L - r) / s
```

Flat with a mandate armed and no position, there is no wall to draw yet, and the panel says so
rather than drawing a line at a price that means nothing.

## Agent surface

The chart taught this: an agent that can only read a picture cannot do the job, and an agent
that can write arbitrary objects onto the screen is a hazard. The answer both times is a closed
grammar with attribution.

**Reads** (`op: read`), returning numbers in context and never pixels:

- `trade_read` — the whole surface: account, positions with derived distances, orders, fills,
  armed mandates with their consumption, venue health. One call answers "what is my situation".
- `trade_batch` — several reads in one round trip, same `$ref` chaining as `chart_batch`.

**Writes** (`op: view`), none of which move money or place anything:

- `trade_focus` — which market the surface is looking at
- `trade_highlight` — point at a row by kind and id, with a note. Expires.
- `trade_overlay` — turn one of the seven overlays on or off
- `trade_note` — pin one line of the agent's own reasoning to the surface
- `trade_clear` — remove the agent's own objects

The highlight is the generalisation of the trend line. A drawn line makes PRICE addressable
between three parties; a highlight makes a ROW addressable. When the agent says "the ETH
position is the one at risk", the row lights up and both parties are demonstrably looking at
the same object. Highlights expire because a pointer that outlives its reason still looks
current, which is worse than no pointer.

**What the agent deliberately cannot do:** close a position, cancel an order, flatten, or
disarm. Those are the human's controls. The temptation to make an exception for closing is real
and is refused: closing is risk-reducing, so it feels safe, but "cognition has no authority" is
the property the whole design rests on and an architecture rots at its exceptions. An agent
that wants a position closed proposes a mandate whose program closes it, or it asks. It is not
guarded from closing; it has no verb for it.

## Locked interfaces

Every type below is the contract between the modules. They are written out here so that work
proceeding in parallel converges without drift.

### `src/trade/feed-ws.ts`

```ts
export type FeedStatus = {
  connected: boolean;
  since: string | null;
  lastMessageMs: number | null;
  reconnects: number;
  lastError: string | null;
};

export type AccountSnapshot = {
  atMs: number;
  equityUsd: number | null;
  marginUsedUsd: number | null;
  maintenanceUsd: number | null;
  withdrawableUsd: number | null;
  freeUsd: number | null;
  unified: boolean;
  positions: RawPosition[];
};

export type RawPosition = {
  coin: string;
  szi: number;            // signed: negative is short
  entryPx: number;
  positionValueUsd: number;
  unrealisedUsd: number;
  liqPx: number | null;
  leverage: number;
  leverageType: 'cross' | 'isolated';
  marginUsedUsd: number;
  fundingPaidUsd: number;
};

export type RawOrder = {
  oid: number; cloid: string | null; coin: string; side: 'buy' | 'sell';
  limitPx: number | null; triggerPx: number | null; sizeCoin: number;
  isTrigger: boolean; reduceOnly: boolean; tif: string | null; atMs: number;
  orderType: string;
};

export type RawFill = {
  tid: string; coin: string; side: 'buy' | 'sell'; px: number; sizeCoin: number;
  feeUsd: number; closedPnlUsd: number | null; atMs: number; liquidation: boolean;
};

export type MarketCtx = {
  coin: string; markPx: number; oraclePx: number | null; midPx: number | null;
  fundingRateHourly: number | null; openInterestUsd: number | null;
  volume24hUsd: number | null; premiumPct: number | null;
};

export type TradeFeed = {
  watch(coins: string[]): void;
  account(): AccountSnapshot | null;
  orders(): RawOrder[];
  fills(): RawFill[];
  market(coin: string): MarketCtx | null;
  status(): FeedStatus;
  onUpdate(fn: () => void): void;
  stop(): void;
};

export function createTradeFeed(deps: {
  wsUrl: string;
  user: string;
  info: InfoClient;        // src/hl/info.ts, for meta at boot and as the fallback
  maxFills?: number;       // default 200
}): TradeFeed;
```

### `src/trade/state.ts`

```ts
export type TradePayload = { /* the browser's whole view; fields as listed below */ };

export function buildTradePayload(deps: {
  view: TradeViewState;                // src/trade/view.ts
  feed: TradeFeed;
  mandates: MandateStatus[];
  meta: Map<string, AssetMeta>;        // szDecimals, maxLeverage, assetId
  atrFor: (coin: string) => number | null;
  products: string[];
  nowMs: number;
}): TradePayload;

export function buildTradeRead(payload: TradePayload): unknown;  // the agent's shape
export function mandateWallPrice(p: {
  side: 'long' | 'short'; entryPx: number; sizeCoin: number;
  maxLossUsd: number; realisedLossUsd: number;
}): number | null;
```

`TradePayload` fields, exactly:

```ts
{
  rev: number; lastDriver: 'agent' | 'human'; symbol: string;
  overlays: Record<OverlayName, boolean>;
  highlights: Highlight[]; note: string | null; noteSource: 'agent'|'human'|null;
  venue: { connected: boolean; source: 'ws'|'rest'|'none'; ageMs: number|null;
           latencyMs: number|null; error: string|null; degraded: boolean };
  account: { equityUsd, marginUsedUsd, freeUsd, maintenanceUsd, withdrawableUsd,
             crossLeverage, healthPct, unified };   // every number `number | null`
  markets: Market[]; positions: Position[]; orders: Order[]; fills: Fill[];
  mandates: MandateRow[]; products: string[];
}

Position = { coin, side: 'long'|'short', sizeCoin, notionalUsd, entryPx, markPx,
             liqPx: number|null, unrealisedUsd, roePct, leverage, leverageType,
             marginUsedUsd, fundingPaidUsd,
             liqDistancePct: number|null, liqDistanceUsd: number|null,
             liqDistanceAtr: number|null }

Order = { oid, cloid, coin, side, kind: 'limit'|'trigger',
          role: 'entry'|'stop'|'target'|'reduce', px, triggerPx, sizeCoin,
          notionalUsd, reduceOnly, tif, atMs, mandateId: string|null }

Fill = { tid, coin, side, px, sizeCoin, notionalUsd, feeUsd,
         closedPnlUsd: number|null, atMs, tSec, liquidation, mandateId }

MandateRow = { id, symbol, armed, running, since, expiresAt, programHash,
               english: string[],
               envelope: { maxNotionalUsd, maxLeverage, maxOrdersPerMin,
                           maxLossUsd, allowedActions: string[] },
               used: { notionalUsd, lossUsd, ordersLastMin, msToExpiry },
               wallPx: number|null,
               lastRule: { id: string; at: string; action: string } | null,
               haltedReason: string|null }
```

**`null` means unknown and is never rendered as zero.** This is a hard rule and it comes from a
real incident: reading `clearinghouseState` on this account showed `accountValue: 0.0` while it
held 889 USDC, and believing that zero cost a needless bridge deposit.

### The unified-account correction

Checking that incident against the live venue showed the original diagnosis was only half
right, and the wrong half is the dangerous one.

`accountValue` is exactly `0.0` only when a unified account holds **no perp position**. That is
the case that was observed and it is the harmless one. **With a position open the number is
non-zero and still not the account's money.** The perp side draws collateral from spot, so
`totalRawUsd` goes negative and the identity `accountValue = totalRawUsd + totalNtlPos` holds
exactly: what comes back is position equity, not what the account is worth. `withdrawable`
reads `0.0` on such an account too.

A zero that is obviously wrong gets questioned. A plausible number that is wrong gets acted on.
So the rule for this surface is stronger than "do not print the zero":

> When the account is unified, `healthPct` and `crossLeverage` derived from `accountValue` are
> **`null`**, not a number. A risk panel showing a wrong health ratio is worse than one showing
> no health ratio, because the human trades on it.

Detection is `totalRawUsd < 0`, or `accountValue` zero while `activeAssetData` reports available
collateral. The real balance lives in `spotClearinghouseState` (`total` includes what backs perp
margin; `hold` is the reserved part). There is no single endpoint for whole-account health on a
unified account: the venue publishes the formula as `computeUnifiedAccountRatio`, the maximum
over collateral tokens of `crossMargin / (spotTotal - isolatedMargin)`, with maintenance being
`crossMaintenanceMarginUsed` per dex plus isolated `marginUsed`.

### Venue details that are easy to get wrong

All verified against the live API rather than taken from the documentation.

- `frontendOpenOrders`, not `openOrders`, for the REST read. Plain `openOrders` omits **every**
  trigger field, so stops and targets arrive looking like ordinary limits.
- On a trigger order, `limitPx` is a ten percent slippage bound, **not** the line. The line is
  `triggerPx`, and triggers fire on the **mark** price.
- `metaAndAssetCtxs` returns contexts aligned **positionally** with `universe`, carrying no coin
  key. Zipping them wrongly attributes one coin's mark price to another, silently.
- `liquidationPx` can be `null` on a cross position. Every distance derived from it is then null
  as well. This is the most likely real null on the whole payload.
- Fills key on `tid`. `hash` is frequently all zeroes. A liquidation is the **presence** of a
  `liquidation` object, not a boolean field.
- The websocket `candle` message is one object, not an array, and its values are strings.
- `pong` carries no `data` key.
- `ctx.funding` is the **hourly** rate, not the eight-hour figure exchanges usually quote.
- There is no per-position maintenance field: it is `positionValue / (2 * maxLeverage)` of the
  active margin tier.

### DOM contract for `ui/trade.html` and `ui/trade.js`

Element ids are locked so the markup and the renderer can be written independently.

```
statusbar        t-symbol t-mark t-funding t-equity t-free t-feed kill-btn t-agent
banners          t-banner-venue  t-banner-policy  t-alert
chart panel      product timeframes chart-cmd chart-meta chartwrap chart chart-hud
                 (identical ids to the pro page: ui/chart.js binds to these by id)
risk panel       t-risk-equity t-risk-margin t-risk-free t-risk-maint
                 t-risk-health t-risk-healthbar
                 t-liq-price t-liq-pct t-liq-usd t-liq-atr t-liq-bar t-risk-empty
mandate panel    t-mandate-list  t-mandate-empty
                 per row, class hooks only: .mrow .mrow-head .mrow-english .mrow-bars
                 .mbar[data-bound="notional|loss|orders|time"] .mrow-actions
book panel       t-book-rows  t-book-empty   (tbody; position rows and nested order rows)
fills panel      t-fill-rows  t-fills-empty
log panel        t-log
overlay toggles  t-overlays   (one button per overlay, data-overlay="<name>")
note             t-note  t-note-src
```

`ui/trade.js` owns `window.TRADE`, assigning the payload before asking the chart to redraw.
`ui/trade-overlay.js` reads that global and nothing else. It is already written.

### Server routes

```
GET  /trade            -> ui/trade.html          (static, same serveStatic)
GET  /api/trade        -> TradePayload
POST /api/trade        -> human view writes: { token, focus?, overlay?, note?, clear? }
POST /api/trade/action -> human-only controls:
                          { token, action: 'disarm'|'cancel'|'cancel_all'|'close'|'flatten',
                            id?, coin? }
SSE  event: 'trade'    -> fires on payload change, same channel as state and chart
op read  trade_read, trade_batch
op view  trade_focus, trade_highlight, trade_overlay, trade_note, trade_clear
```

`/api/trade/action` takes the approval token and the same-origin check, exactly like
`/api/kill`. It is not reachable from `/api/mcp`, which is the structural half of "the agent has
no verb for it": the capability is absent from the agent's door rather than guarded behind a
check inside it.

## What a pro surface has that a retail one omits

Measured from Hyperliquid's own app, dYdX v4 and Binance Futures opened side by side, plus the
desktop conventions of TT and Bloomberg. Four of the findings change this design; they are
folded in above and listed here with their reasoning.

**The order ticket's real job is the receipt, not the form.** Every professional tool previews
the account's next state before you commit: if this fills, your liquidation moves here, your
free collateral becomes this. Phosphor has no ticket, so that job lands on the mandate console
at approval time. The ARM screen shows the account **as it would be** if the program opened its
maximum position, not merely the program's own text. This is the single most valuable thing the
survey turned up and it fits the mandate model better than it fits a ticket, because a mandate
is exactly a bounded claim about a future state.

**Funding is money and is almost never shown as money.** Retail apps print a rate. A position's
profit splits three ways, into price, funding and fees, and a carry trade that looks green on
price can be red once it has paid for itself. `cumFunding.sinceOpen` is already on the venue's
position object. The book panel splits profit into its three parts.

**Cross margin makes every position a term in every other position's liquidation price.** A
per-position view is therefore incomplete by construction. The risk panel carries net and gross
notional and one plain sentence: what a five percent move against the book does to equity.

**Numbers must not jitter.** Proportional digits that change width as they tick are the reason
professional blotters are unreadable in the retail apps. Monospace gives this for free and
`font-variant-numeric: tabular-nums` makes it explicit and survives a font fallback.

## What this does not do

- **No order book or depth ladder.** The survey's answer was specific and it is followed: at
  minute-and-above horizons a ladder is not a decision input. The visible levels on a typical
  market span a fraction of a percent while an hourly candle covers a hundred times that, and
  resting depth is free to cancel, so it promises nothing. It remains an execution instrument
  rather than an analysis one.

  What is worth having from the book is not the ladder but **one number**: what it costs to fill
  this size right now. A mandate that permits twenty basis points of slippage, next to a book
  that charges thirty-four to fill its maximum notional, is a mandate that will not do what its
  author thinks. **Named as the next thing to build** rather than built here, because it needs
  an `l2Book` subscription this surface does not otherwise want.
- **No manual order entry.** Stated above, and it is the point rather than a gap.
- **No hotkeys yet.** The survey found no perps web app has them and that professional desktop
  tools have had them for twenty years. The one that matters here is a key for the kill switch.
  Named, not built.
- **No manual order entry.** Stated above, and it is the point rather than a gap.
- **No mobile layout beyond not breaking.** The pro page's fallback (stacked, scrolling, under
  1100px) applies. Nobody arms a leveraged bot from a phone.
- **No multi-account switching.** One account, the one in `config.addresses.evm[0]`.
```
