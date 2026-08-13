// Second candles that have a past.
//
// The gap this closes: no venue serves a sub-minute candle over REST. Hyperliquid's
// candleSnapshot rejects "1s" with a 422 and Coinbase answers granularity=1 with
// "Unsupported granularity". So the old shape bucketed the live trade websocket in
// process, which is correct but starts empty: open the app and a 1s chart holds nothing,
// and after twenty minutes it holds twenty minutes. Measured on the running app, every
// sub-minute timeframe capped at a half hour span no matter what was asked for.
//
// Trades are the missing history. Coinbase serves a public trade tape with cursor paging
// (verified: a thousand trades a page, about three and a half minutes of BTC-USD per page,
// each page strictly older than the last), and a candle is just trades in a bucket. So the
// same bars the websocket builds going forward can be built backward from the tape, and
// the two meet in the middle.
//
// One deliberate difference from the aggregate module, which drops empty buckets: a second
// with no trade is carried forward as a flat bar at the last close. At minute resolution a
// hole means the venue lost data and hiding it would be a lie. At second resolution a hole
// just means nobody traded, and a chart full of gaps is unreadable. This matches what the
// live rail already did.

import type { Candle } from '../types.ts';

export type TradeRow = {
  timeSec: number;
  price: number;
  size: number;
};

export type SecondsBackfill = (product: string, stepSec: number, bars: number) => Promise<Candle[]>;

/* Fold an oldest-first trade tape into bars of stepSec.
   Seconds with no trade carry the previous close as a flat bar, so the time axis stays
   continuous. Nothing is carried before the first trade: there is no price to carry. */
export function bucketTrades(trades: readonly TradeRow[], stepSec: number): Candle[] {
  if (trades.length === 0) return [];
  const step = Math.max(1, Math.floor(stepSec));

  const buckets = new Map<number, Candle>();
  for (const trade of trades) {
    if (!Number.isFinite(trade.price) || !Number.isFinite(trade.timeSec)) continue;
    const slot = Math.floor(trade.timeSec / step) * step;
    const held = buckets.get(slot);
    if (held === undefined) {
      buckets.set(slot, {
        t: slot,
        o: trade.price,
        h: trade.price,
        l: trade.price,
        c: trade.price,
        v: trade.size,
      });
      continue;
    }
    if (trade.price > held.h) held.h = trade.price;
    if (trade.price < held.l) held.l = trade.price;
    held.c = trade.price;
    held.v += trade.size;
  }

  const slots = [...buckets.keys()].sort((a, b) => a - b);
  if (slots.length === 0) return [];

  const out: Candle[] = [];
  let carry = (buckets.get(slots[0] as number) as Candle).o;
  const lastSlot = slots[slots.length - 1] as number;

  for (let slot = slots[0] as number; slot <= lastSlot; slot += step) {
    const bar = buckets.get(slot);
    if (bar === undefined) {
      out.push({ t: slot, o: carry, h: carry, l: carry, c: carry, v: 0 });
      continue;
    }
    out.push(bar);
    carry = bar.c;
  }
  return out;
}

type CoinbaseTrade = { trade_id: number; price: string; size: string; time: string };

/* Page the Coinbase trade tape backward until the window is covered or the page budget
   runs out, then fold it into bars.
   The budget exists because the tape is dense: covering an hour of a busy book costs
   roughly twenty requests, and an unbounded loop against a public endpoint is how an app
   earns a rate limit. Whatever depth was reached is what gets returned, and the caller
   reports it rather than implying the window is full. */
export function coinbaseSeconds(deps?: {
  fetchImpl?: typeof fetch;
  maxPages?: number;
  now?: () => number;
}): SecondsBackfill {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const maxPages = deps?.maxPages ?? 24;
  const now = deps?.now ?? (() => Date.now());

  return async function backfill(product: string, stepSec: number, bars: number): Promise<Candle[]> {
    const step = Math.max(1, Math.floor(stepSec));
    const wantSec = step * Math.max(1, bars);
    const oldestWanted = Math.floor(now() / 1000) - wantSec;

    const trades: TradeRow[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/trades`);
      url.searchParams.set('limit', '1000');
      if (cursor !== null) url.searchParams.set('after', cursor);

      const res = await fetchImpl(url.toString());
      if (!res.ok) {
        // A refused page is not a reason to throw away the pages already in hand.
        if (trades.length === 0) {
          throw new Error(`coinbase trades failed: ${res.status} ${await res.text()}`);
        }
        break;
      }

      const rows = (await res.json()) as CoinbaseTrade[];
      if (!Array.isArray(rows) || rows.length === 0) break;

      let oldestOnPage = Infinity;
      for (const row of rows) {
        const timeSec = Date.parse(row.time) / 1000;
        if (!Number.isFinite(timeSec)) continue;
        trades.push({ timeSec, price: Number(row.price), size: Number(row.size) });
        if (timeSec < oldestOnPage) oldestOnPage = timeSec;
      }

      if (oldestOnPage <= oldestWanted) break;

      const next = res.headers.get('cb-after');
      if (next === null || next === cursor) break;
      cursor = next;
    }

    trades.sort((a, b) => a.timeSec - b.timeSec);
    const folded = bucketTrades(trades, step);
    return folded.length > bars ? folded.slice(-bars) : folded;
  };
}

/* Coverage, so the chart can say how far back the seconds actually go instead of drawing a
   short series that looks like the whole story. */
export function coverageSec(candles: readonly Candle[], stepSec: number): number {
  if (candles.length === 0) return 0;
  const first = candles[0] as Candle;
  const last = candles[candles.length - 1] as Candle;
  return last.t + stepSec - first.t;
}
