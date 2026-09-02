// The trading surface's reads. They sit here rather than under market because what they read
// is a position and a mandate, not a price.

import { sendJson } from '../respond.ts';
import type { ReadTable } from '../context.ts';

export const tradeReads: ReadTable = {
  trade_read: (ctx, _body, args, res) => {
    const symbol = typeof args.symbol === 'string' ? args.symbol : undefined;
    sendJson(res, 200, ctx.trade.read(symbol));
  },
  trade_batch: (ctx, _body, args, res) => {
    sendJson(res, 200, ctx.trade.batch(Array.isArray(args.ops) ? (args.ops as unknown[]) : []));
  },
};
