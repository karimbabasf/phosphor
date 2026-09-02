// The market reads: bars for any product, what can be charted at all, and the one tool in
// this app whose answer comes from off the machine.

import { errText, fail, intParam, sendJson } from '../respond.ts';
import { research } from '../../research.ts';
import { CANDLE_LIMIT_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';

export const marketReads: ReadTable = {
  candles: async (ctx, _body, args, res) => {
    const product = typeof args.product === 'string' ? args.product : (ctx.cfg.candleProducts[0] ?? 'BTC-USD');
    const granularity = intParam(args.granularity, 60, 86400);
    const limit = intParam(args.limit, 120, CANDLE_LIMIT_MAX);
    try {
      sendJson(res, 200, await ctx.candles.get(product, granularity, limit));
    } catch (err) {
      fail(res, 502, errText(err));
    }
  },
  // What can be charted, so an agent can find a market before trying to open it rather
  // than guessing at a product id and reading an error.
  market_search: (ctx, _body, args, res) => {
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = intParam(args.limit, 10, 50);
    const exact = query === '' ? null : ctx.market.resolve(query);
    sendJson(res, 200, {
      query,
      // The one it would open, when the query is unambiguous.
      match: exact,
      candidates: ctx.market.search(query, limit),
      catalogLoadedAt: ctx.market.catalogLoadedAt(),
      note: 'Any of these can be charted on any timeframe from 1m to 1w.',
    });
  },
  /* Market news, and the only place in this app where an agent's question causes a request to
     leave the machine. Three things make that safe enough to ship, and all three live in
     src/research.ts rather than here: the hosts are a fixed set checked by exact match, the
     agent supplies a search phrase and never a URL, and everything coming back is stripped and
     wrapped in a quote envelope that says out loud it is somebody else's writing.
     The query is already in the audit log: every agent read is written there before dispatch,
     arguments included, by the one line that covers the whole surface. */
  research: async (_ctx, _body, args, res) => {
    const query = typeof args.query === 'string' ? args.query : '';
    if (query.trim() === '') return fail(res, 400, 'query is required');
    sendJson(res, 200, await research(query, { limit: intParam(args.limit, 8, 20) }));
  },
};
