// The trading surface's reads. They sit here rather than under market because what they read
// is a position and a plan, not a price.

import { sendJson } from '../respond.ts';
import { markIfCarried } from '../../web-read.ts';
import type { Ctx, ReadTable } from '../context.ts';

/* Every note the trade read hands an agent: a plan's note and a highlight's. One an agent wrote
   while its seat was marked carries the stamp (src/web-read.ts), and a seat that is handed it is
   marked as if it had read the page itself: a note is up to 120 characters of that page, and a
   plan's is kept in plans.json past the chat that wrote it. */
export function tradeNotes(ctx: Ctx): { webRead?: true }[] {
  let payload: { plans?: unknown; highlights?: unknown };
  try {
    payload = ctx.trade.payload() as { plans?: unknown; highlights?: unknown };
  } catch {
    return [];
  }
  const rows = [...(Array.isArray(payload?.plans) ? payload.plans : []), ...(Array.isArray(payload?.highlights) ? payload.highlights : [])] as Array<{ note?: unknown; webRead?: true }>;
  return rows.filter((r) => r !== null && typeof r === 'object' && typeof r.note === 'string' && r.note !== '');
}

export const tradeReads: ReadTable = {
  trade_read: (ctx, body, args, res) => {
    const symbol = typeof args.symbol === 'string' ? args.symbol : undefined;
    markIfCarried(body.session, tradeNotes(ctx));
    sendJson(res, 200, ctx.trade.read(symbol));
  },
  trade_batch: (ctx, body, args, res) => {
    const ops = Array.isArray(args.ops) ? (args.ops as unknown[]) : [];
    // Only the plans op hands notes over; the others are positions, orders, fills and prices.
    if (ops.some((op) => (op as { op?: unknown } | null)?.op === 'plans')) markIfCarried(body.session, tradeNotes(ctx));
    sendJson(res, 200, ctx.trade.batch(ops));
  },
};
