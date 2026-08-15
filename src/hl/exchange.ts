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

export function buildCancelAction(cancels: { assetId: number; oid: number }[]): unknown {
  return { type: 'cancel', cancels: cancels.map((c) => ({ a: c.assetId, o: c.oid })) };
}

function buildCancelByCloidAction(cancels: { assetId: number; cloid: string }[]): unknown {
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
    cancel: (cancels: { assetId: number; oid: number }[]) => post(buildCancelAction(cancels)),
    cancelByCloid: (cancels: { assetId: number; cloid: string }[]) => post(buildCancelByCloidAction(cancels)),
    updateLeverage: (assetId: number, isCross: boolean, leverage: number) =>
      post(buildUpdateLeverageAction(assetId, isCross, leverage)),
    wireNumber,
  };
}
