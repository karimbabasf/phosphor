// What the venue says about an order after it was placed, read back by id.
//
// "The exchange did not return an error" is the whole of what placing an order proves, and
// the runner used to book that as placed. A reply that timed out was booked as placed too. The
// venue's own word is one /info call away: `orderStatus` takes the numeric oid or the client
// order id this app minted, and answers `filled`, `open`, one of the canceled family, one of
// the rejected family, or `unknownOid`. This reads it, bounded, and names what it found. A
// window that runs out is `unconfirmed`: the order may exist, so nothing here or after it may
// place a second one on the strength of not having heard.
//
// Read only. Nothing here signs or sends.

import type { InfoClient } from './info.ts';
import { watchRise } from '../ledger/settle.ts';
import type { RiseSchedule } from '../ledger/settle.ts';

export type OrderConfirmState = 'filled' | 'resting' | 'canceled' | 'rejected' | 'unconfirmed';

export type OrderConfirm = {
  state: OrderConfirmState;
  // The venue's own status word, verbatim, when it answered; null when it never did.
  venueStatus: string | null;
  oid: number | null;
  reads: number;
  at: string;
};

// Every second for twenty seconds: the venue indexes a placed order within a block, and a
// read-back that takes longer than that is not a read-back anyone is waiting on.
export const ORDER_CONFIRM: RiseSchedule = { firstMs: 1_000, maxMs: 1_000, timeoutMs: 20_000 };

/* The venue's status words, per its docs: `open` and `filled`, then a family of canceled
   (canceled, marginCanceled, siblingFilledCanceled, ...) and a family of rejected
   (rejected, tickRejected, perpMarginRejected, ...). `triggered` is a trigger order that has
   become a resting limit. Anything else the venue may add later is read by its suffix so a new
   cancel reason is still a cancel. */
export function classifyVenueStatus(status: string): Exclude<OrderConfirmState, 'unconfirmed'> | null {
  const s = status.trim();
  if (s === '') return null;
  const lower = s.toLowerCase();
  if (lower === 'filled') return 'filled';
  if (lower === 'open' || lower === 'triggered') return 'resting';
  if (lower.endsWith('canceled') || lower.endsWith('cancelled') || lower === 'scheduledcancel') return 'canceled';
  if (lower.endsWith('rejected')) return 'rejected';
  return null;
}

type OrderStatusReply = {
  status?: unknown;
  order?: { status?: unknown; order?: { oid?: unknown } };
};

/* One read. Null when the venue does not know the id yet (unknownOid), when the answer has no
   status in it, or when the call fails: all three are "not heard", and only the window ending
   turns that into an answer. */
async function readOnce(info: InfoClient, user: string, oid: number | string): Promise<{ state: Exclude<OrderConfirmState, 'unconfirmed'>; venueStatus: string; oid: number | null } | null> {
  let reply: OrderStatusReply;
  try {
    reply = await info.post<OrderStatusReply>({ type: 'orderStatus', user, oid });
  } catch {
    return null;
  }
  if (reply === null || typeof reply !== 'object' || reply.status !== 'order') return null;
  const venueStatus = typeof reply.order?.status === 'string' ? reply.order.status : '';
  const state = classifyVenueStatus(venueStatus);
  if (state === null) return null;
  const rawOid = reply.order?.order?.oid;
  return { state, venueStatus, oid: typeof rawOid === 'number' ? rawOid : null };
}

export async function confirmOrder(opts: {
  info: InfoClient;
  user: string;
  // The venue's oid, or the 16-byte hex client order id this app minted for the leg.
  oid: number | string;
  schedule?: RiseSchedule;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<OrderConfirm> {
  const watched = await watchRise({
    read: () => readOnce(opts.info, opts.user, opts.oid),
    rose: () => true,
    schedule: opts.schedule ?? ORDER_CONFIRM,
    // Unref'd: a read-back is never the reason the process stays alive.
    sleep: opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())),
    now: opts.now ?? Date.now,
  });
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  if (watched.last === null) return { state: 'unconfirmed', venueStatus: null, oid: typeof opts.oid === 'number' ? opts.oid : null, reads: watched.reads, at };
  return { state: watched.last.state, venueStatus: watched.last.venueStatus, oid: watched.last.oid, reads: watched.reads, at };
}
