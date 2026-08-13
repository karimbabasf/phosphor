// Walking backwards through history one page at a time.
//
// The cursor is a timestamp rather than an offset because the venue's candle endpoint is
// addressed by time range. An offset cursor would have to be translated on every call and
// would break the moment a bar was backfilled.
//
// De-duplication is not paranoia: the venue returns a closed range, so consecutive pages
// can repeat a boundary bar, and a repeated bar would be counted twice by anything summing
// volume. The later read wins because it is the fresher one.

import type { Candle } from './types.ts';

export type Page = { candles: Candle[]; cursor: number | null; complete: boolean };

export type Fetcher = (
  product: string,
  granularitySec: number,
  endSec: number,
  limit: number,
) => Promise<Candle[]>;

const DEFAULT_PAGE = 500;

export function createHistory(fetch: Fetcher, opts?: { pageSize?: number }) {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE;

  return {
    async page(
      product: string,
      granularitySec: number,
      cursor: number | null,
      limit?: number,
    ): Promise<Page> {
      const want = limit ?? pageSize;
      const end = cursor ?? Math.floor(Date.now() / 1000);
      const raw = await fetch(product, granularitySec, end, want);

      const byTime = new Map<number, Candle>();
      for (const c of raw) byTime.set(c.t, c);
      const candles = [...byTime.values()].sort((a, b) => a.t - b.t);

      if (candles.length === 0) return { candles: [], cursor: null, complete: true };

      // Fewer bars than asked for is how the venue says it has no more. Using the returned
      // count rather than a separate "hasMore" flag keeps this working against any source
      // that honours a limit.
      const complete = raw.length < want;
      return { candles, cursor: complete ? null : candles[0].t, complete };
    },
  };
}
