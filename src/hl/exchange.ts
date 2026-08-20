// Building and posting Hyperliquid exchange actions.
//
// Everything here is about making an order the venue will accept rather than reject, because
// a rejection on this venue is nearly always OUR bug and it is reported without a reason. The
// four that bite, all handled here and all pinned by tests:
//
//   1. Field order is part of the signature. Every action object below is constructed with its
//      keys in the documented order, and src/hl/msgpack.ts preserves insertion order. Building
//      one of these with a spread of a differently-ordered object is a silent break.
//   2. `f` on an order and `a` on a modify must be OMITTED when false, not sent as false. The
//      venue documents that actions hashed with `f: false` are rejected outright.
//   3. Numbers are wire strings, never JS numbers, and never with trailing zeroes.
//   4. The nonce must be unique per signer and inside a two-day window. One atomic counter,
//      fast-forwarded to unix milliseconds, which is the venue's own recommendation.
//
// The transport is injected so this is testable without touching the venue. Nothing in this
// repo's tests ever posts to a real exchange.

import { formatPrice, formatSize, wireNumber } from './format.ts';
import { signL1Action } from './sign.ts';

export type Transport = (url: string, body: unknown) => Promise<unknown>;

export type ExchangeConfig = {
  privKey: `0x${string}`;
  isMainnet: boolean;
  baseUrl: string;
  transport?: Transport;
};

export type OrderRequest = {
  assetId: number;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly: boolean;
  tif: 'Alo' | 'Ioc' | 'Gtc';
  szDecimals: number;
  cloid?: string;
};

export type TriggerRequest = {
  assetId: number;
  isBuy: boolean;
  size: number;
  triggerPx: number;
  isMarket: boolean;
  tpsl: 'tp' | 'sl';
  szDecimals: number;
  cloid?: string;
};

const defaultTransport: Transport = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
};

// A 128-bit client order id. Its job is idempotent retry: after an ambiguous network failure
// the same cloid cannot produce a second fill, which is the difference between a retry and a
// double position.
export function newCloid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Nonces are per signer and the venue keeps only the 100 highest, so they must rise and must
// never repeat. Starting from the clock and only ever incrementing means a restart cannot
// reuse a nonce it already burned.
export function createNonces(now: () => number = () => Date.now()) {
  let last = 0;
  return {
    next(): number {
      const t = now();
      last = t > last ? t : last + 1;
      return last;
    },
  };
}

export function buildOrderAction(orders: OrderRequest[], builder?: { b: string; f: number }): unknown {
  const wire = orders.map((o) => {
    // Key order is the documented one: a, b, p, s, r, t, then the optional c.
    const entry: Record<string, unknown> = {
      a: o.assetId,
      b: o.isBuy,
      p: formatPrice(o.price, o.szDecimals, true),
      s: formatSize(o.size, o.szDecimals),
      r: o.reduceOnly,
      t: { limit: { tif: o.tif } },
    };
    if (o.cloid !== undefined) entry.c = o.cloid;
    return entry;
  });

  const action: Record<string, unknown> = { type: 'order', orders: wire, grouping: 'na' };
  // The builder key is omitted entirely when unused rather than sent as null, for the same
  // reason `f` is: an unexpected key changes the hash.
  if (builder !== undefined) action.builder = { b: builder.b.toLowerCase(), f: builder.f };
  return action;
}

export function buildTriggerAction(triggers: TriggerRequest[]): unknown {
  const wire = triggers.map((t) => {
    const entry: Record<string, unknown> = {
      a: t.assetId,
      b: t.isBuy,
      // A trigger order's limit price is unused when isMarket is true, but the field is still
      // required, so it carries the trigger price rather than a zero that would read as free.
      p: formatPrice(t.triggerPx, t.szDecimals, true),
      s: formatSize(t.size, t.szDecimals),
      r: true, // a stop or target only ever reduces
      t: { trigger: { isMarket: t.isMarket, triggerPx: formatPrice(t.triggerPx, t.szDecimals, true), tpsl: t.tpsl } },
    };
    if (t.cloid !== undefined) entry.c = t.cloid;
    return entry;
  });
  // positionTpsl sizes the trigger to whatever the position is when it fires, which is what a
  // stop should do after a partial exit has already reduced it.
  return { type: 'order', orders: wire, grouping: 'positionTpsl' };
}

// An entry and its two exits, placed as ONE action.
//
// buildTriggerAction above uses grouping 'positionTpsl', which sizes a stop to whatever the
// position happens to be when it fires. That is right for a stop attached to a position that
// already exists. It is wrong for a bracket, where the stop belongs to THIS entry and to its
// size: 'normalTpsl' is the grouping that ties them together, so the exits are born with the
// entry rather than placed by a second round trip that can fail on its own.
//
// This is the difference between an agent that has to be present to attach a stop and one that
// does not. The whole entry, target and stop go to the venue in one signature, and after that
// they are the venue's problem at match speed rather than ours at tick speed.
export function buildBracketAction(entry: OrderRequest, exits: TriggerRequest[]): unknown {
  if (exits.length === 0) {
    throw new Error('a bracket with no exits is just an order; use buildOrderAction');
  }
  if (exits.length > 2) {
    throw new Error(`a bracket takes at most a target and a stop (got ${exits.length} exits)`);
  }
  for (const exit of exits) {
    if (exit.assetId !== entry.assetId) {
      throw new Error(`bracket exit is on asset ${exit.assetId} and the entry is on ${entry.assetId}`);
    }
    if (exit.isBuy === entry.isBuy) {
      throw new Error('a bracket exit must be the opposite side from its entry, or it adds to the position');
    }
  }

  const wire: Record<string, unknown>[] = [];

  // The entry comes first. The venue reads the group in order and the exits attach to what
  // precedes them, so this array is not a set.
  const first: Record<string, unknown> = {
    a: entry.assetId,
    b: entry.isBuy,
    p: formatPrice(entry.price, entry.szDecimals, true),
    s: formatSize(entry.size, entry.szDecimals),
    r: entry.reduceOnly,
    t: { limit: { tif: entry.tif } },
  };
  if (entry.cloid !== undefined) first.c = entry.cloid;
  wire.push(first);

  for (const exit of exits) {
    const e: Record<string, unknown> = {
      a: exit.assetId,
      b: exit.isBuy,
      p: formatPrice(exit.triggerPx, exit.szDecimals, true),
      s: formatSize(exit.size, exit.szDecimals),
      r: true,
      t: { trigger: { isMarket: exit.isMarket, triggerPx: formatPrice(exit.triggerPx, exit.szDecimals, true), tpsl: exit.tpsl } },
    };
    if (exit.cloid !== undefined) e.c = exit.cloid;
    wire.push(e);
  }

  return { type: 'order', orders: wire, grouping: 'normalTpsl' };
}

// Move a resting order without giving up its place in the queue.
//
// The alternative is cancel then place, which costs two round trips, loses queue priority, and
// leaves a window where the order is not on the book at all. For anything that maintains a
// quote, that window is the whole risk.
//
// `a` is always_place and is the one field here that follows rule 2 in the header: OMITTED when
// false, never sent as false. It says whether to place the new order even if the old one is
// already gone. Defaulting it to false is the safe direction: an order that filled while the
// modify was in flight must not be silently replaced with a fresh one.
export function buildModifyAction(oid: number | string, order: OrderRequest, alwaysPlace = false): unknown {
  const wire: Record<string, unknown> = {
    a: order.assetId,
    b: order.isBuy,
    p: formatPrice(order.price, order.szDecimals, true),
    s: formatSize(order.size, order.szDecimals),
    r: order.reduceOnly,
    t: { limit: { tif: order.tif } },
  };
  if (order.cloid !== undefined) wire.c = order.cloid;

  const action: Record<string, unknown> = { type: 'modify', oid, order: wire };
  if (alwaysPlace) action.a = true;
  return action;
}

export function buildBatchModifyAction(
  modifies: { oid: number | string; order: OrderRequest }[],
  alwaysPlace = false,
): unknown {
  const wire = modifies.map((m) => {
    const o: Record<string, unknown> = {
      a: m.order.assetId,
      b: m.order.isBuy,
      p: formatPrice(m.order.price, m.order.szDecimals, true),
      s: formatSize(m.order.size, m.order.szDecimals),
      r: m.order.reduceOnly,
      t: { limit: { tif: m.order.tif } },
    };
    if (m.order.cloid !== undefined) o.c = m.order.cloid;
    return { oid: m.oid, order: o };
  });

  const action: Record<string, unknown> = { type: 'batchModify', modifies: wire };
  if (alwaysPlace) action.a = true;
  return action;
}

// The dead-man switch, and the only safety primitive here that works when this app is not.
//
// Everything else in this repo protects against a bot doing the wrong thing. This protects
// against the app DYING while resting orders sit on the venue: the kill switch, the supervisor
// and the envelope all need a process to run in, and a laptop that sleeps has none. Arm this
// and the venue cancels everything by itself at a time we chose.
//
// Three venue rules shape how it can be used. The first two are documented; the third is not,
// and it is the one that decides whether this feature exists for you at all.
//
//   - the time must be at least 5 seconds ahead, so this cannot be used as an instant cancel;
//   - a trigger costs one of TEN per day, reset at 00:00 UTC. It is a safety net, not a
//     heartbeat: re-arming it every few seconds would exhaust the budget before lunch;
//   - IT IS GATED BEHIND $1,000,000 OF TRADED VOLUME. Measured, not read: arming it on the
//     testnet account on 2026-08-20 returned
//     "Cannot set scheduled cancel time until enough volume traded. Required: $1000000.
//     Traded: $40988.83."
//
// That third rule is why isScheduleCancelLocked() exists below. A new account cannot have this
// net, and code that assumes it can is code that believes it is protected and is not. Anything
// relying on it has to read the response and fall back to its own supervision, which is what
// the runner already does on every tick.
//
// Omitting the time REMOVES a scheduled cancel, which is how a bot stands the net down when it
// disarms cleanly.
export const SCHEDULE_CANCEL_MIN_LEAD_MS = 5_000;
export const SCHEDULE_CANCEL_MAX_PER_DAY = 10;
export const SCHEDULE_CANCEL_VOLUME_REQUIRED_USD = 1_000_000;

// Whether the venue refused because the account has not traded enough, rather than because the
// request was wrong. The two need different responses: this one is permanent until volume
// arrives, so retrying it is pointless and reporting it as a failure to arm is misleading.
export function isScheduleCancelLocked(response: unknown): boolean {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return /enough volume traded/i.test(text);
}

export function buildScheduleCancelAction(timeMs: number | null): unknown {
  // Key order again: one key, and its absence is meaningful.
  if (timeMs === null) return { type: 'scheduleCancel' };
  if (!Number.isFinite(timeMs) || !Number.isInteger(timeMs)) {
    throw new Error(`scheduleCancel time must be an integer millisecond timestamp (got ${timeMs})`);
  }
  return { type: 'scheduleCancel', time: timeMs };
}

// What the venue actually said about each order, which is NOT the HTTP status and NOT the
// top-level `status` field.
//
// A rejected order comes back as HTTP 200 with `{"status":"ok"}` at the top and the refusal
// buried per order: `response.data.statuses[i] = {"error":"Price too far from oracle asset=4"}`.
// So a caller that checks only what it is handed sees success. The runner did exactly that and
// discarded the body entirely, which is why an order that never reached the book looked
// identical to one that filled, and why a mandate could arm, fire, place nothing, and report
// nothing. Found on 2026-08-20 while proving the bracket.
//
// Returns one string per refused order, empty when every order was accepted.
export function orderErrors(response: unknown): string[] {
  const r = response as { status?: string; response?: { data?: { statuses?: unknown[] } } } | null;
  if (r === null || typeof r !== 'object') return ['the venue returned no response body'];

  // A top-level failure carries its reason as a bare string where the object would be.
  if (r.status !== undefined && r.status !== 'ok') {
    const detail = typeof r.response === 'string' ? r.response : JSON.stringify(r.response ?? r.status);
    return [detail];
  }

  const statuses = r.response?.data?.statuses;
  if (!Array.isArray(statuses)) return [];
  const errors: string[] = [];
  for (const s of statuses) {
    if (typeof s === 'object' && s !== null && typeof (s as { error?: unknown }).error === 'string') {
      errors.push((s as { error: string }).error);
    }
  }
  return errors;
}

export function buildCancelAction(cancels: { assetId: number; oid: number }[]): unknown {
  return { type: 'cancel', cancels: cancels.map((c) => ({ a: c.assetId, o: c.oid })) };
}

export function buildCancelByCloidAction(cancels: { assetId: number; cloid: string }[]): unknown {
  return { type: 'cancelByCloid', cancels: cancels.map((c) => ({ asset: c.assetId, cloid: c.cloid })) };
}

export function buildUpdateLeverageAction(assetId: number, isCross: boolean, leverage: number): unknown {
  return { type: 'updateLeverage', asset: assetId, isCross, leverage };
}

// The worst acceptable price for an aggressive entry.
//
// Slippage on an order book is a price bound, not a percentage tolerance the way it is on an
// automated market maker. There is no such thing as a market order here: an aggressive fill is
// an immediate-or-cancel limit at a price you have decided is still acceptable. Anything that
// would fill worse simply does not fill, which is the behaviour a stop-loss needs and a naive
// market order cannot give.
export function aggressiveLimitPrice(reference: number, isBuy: boolean, maxSlippageBps: number): number {
  const factor = 1 + (isBuy ? 1 : -1) * (maxSlippageBps / 10_000);
  return reference * factor;
}

export function createExchange(cfg: ExchangeConfig) {
  const transport = cfg.transport ?? defaultTransport;
  const nonces = createNonces();

  async function post(action: unknown, expiresAfter: number | null = null): Promise<unknown> {
    const nonce = nonces.next();
    const signature = await signL1Action(cfg.privKey, action, nonce, cfg.isMainnet, null, expiresAfter);
    const body: Record<string, unknown> = { action, nonce, signature, vaultAddress: null };
    if (expiresAfter !== null) body.expiresAfter = expiresAfter;
    return await transport(`${cfg.baseUrl}/exchange`, body);
  }

  return {
    post,
    order: (orders: OrderRequest[]) => post(buildOrderAction(orders)),
    trigger: (triggers: TriggerRequest[]) => post(buildTriggerAction(triggers)),
    // Entry plus its exits in one signature, so a position is never briefly naked.
    bracket: (entry: OrderRequest, exits: TriggerRequest[]) => post(buildBracketAction(entry, exits)),
    // Re-peg without leaving the book.
    modify: (oid: number | string, order: OrderRequest, alwaysPlace = false) =>
      post(buildModifyAction(oid, order, alwaysPlace)),
    batchModify: (modifies: { oid: number | string; order: OrderRequest }[], alwaysPlace = false) =>
      post(buildBatchModifyAction(modifies, alwaysPlace)),
    // The net that works when this process does not. Null stands it down.
    scheduleCancel: (timeMs: number | null) => post(buildScheduleCancelAction(timeMs)),
    cancel: (cancels: { assetId: number; oid: number }[]) => post(buildCancelAction(cancels)),
    cancelByCloid: (cancels: { assetId: number; cloid: string }[]) => post(buildCancelByCloidAction(cancels)),
    updateLeverage: (assetId: number, isCross: boolean, leverage: number) =>
      post(buildUpdateLeverageAction(assetId, isCross, leverage)),
    wireNumber,
  };
}
