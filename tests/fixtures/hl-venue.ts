// A loopback stand-in for api.hyperliquid.xyz with the response shapes the docs give:
// statuses[].filled.totalSz, resting.oid, error; clearinghouseState.assetPositions; openOrders
// with a cloid. Nothing here reaches the network.
//
// Shared by the child test, which drives every command path once, and the latency harness,
// which needs to know the instant a POST arrived. State a test can set: the leverage on the
// coin, the position, the resting orders, and how the next order answers. Every exchange action
// is recorded in order.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Wire = { a: number; b: boolean; p: string; s: string; r: boolean; t: Record<string, unknown>; c?: string };
export type OrderAction = { type: 'order'; orders: Wire[]; grouping: string };
export type Action =
  | OrderAction
  | { type: 'cancelByCloid'; cancels: { asset: number; cloid: string }[] }
  | { type: 'updateLeverage'; asset: number; isCross: boolean; leverage: number };

export function venue() {
  const state = {
    leverage: { type: 'isolated', value: 5 } as { type: string; value: number },
    position: null as { szi: number; entryPx: number } | null,
    openOrders: [] as { coin: string; oid: number; cloid: string | null }[],
    actions: [] as Action[],
    // Every /exchange body as it arrived, envelope included, so a test can read the nonce and
    // the expiry beside the action.
    bodies: [] as Record<string, unknown>[],
    // When each POST reached this server, on the performance clock, as the request line came
    // in and before the body was read. The latency harness reads the /exchange rows.
    arrivals: [] as { path: string; at: number }[],
    // What the next order action answers, per wire order. Default: an Ioc fills whole, a Gtc
    // and a trigger rest.
    answer: null as null | ((orders: Wire[]) => unknown[]),
    cancelAnswer: null as null | ((cancels: unknown[]) => unknown[]),
    // The HTTP status the next /exchange POST gets, then cleared. A test sets it to 502 or 429
    // to stand in for the venue failing after the request reached it.
    exchangeStatus: null as null | number,
    // A top-level rejection the next /exchange POST gets, then cleared: HTTP 200 with
    // status 'err' and this sentence, which is how the venue answers an action it will not
    // take at all (a stale expiresAfter, a bad signature) rather than an order it refused.
    exchangeError: null as null | string,
    // Every order the venue accepted, by the client id it carried: its original size, what of
    // it filled, and whether the rest was canceled. orderStatus answers from it the way the
    // venue does (origSz, and sz as what is left), and a test moves `filled` to stand in for a
    // resting entry that filled later.
    book: new Map<string, { origSz: number; filled: number; canceled: boolean }>(),
    // What every orderStatus read answers instead, when a test needs the venue silent or odd.
    statusAnswer: null as null | ((oid: unknown) => unknown),
  };
  const server = http.createServer((req, res) => {
    state.arrivals.push({ path: req.url ?? '', at: performance.now() });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/exchange' && state.exchangeStatus !== null) {
        const code = state.exchangeStatus;
        state.exchangeStatus = null;
        res.writeHead(code, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `the venue is having a bad time (${code})` }));
      }
      const json = JSON.parse(body || '{}') as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/exchange') state.bodies.push(json);
      if (req.url === '/exchange' && state.exchangeError !== null) {
        const sentence = state.exchangeError;
        state.exchangeError = null;
        return res.end(JSON.stringify({ status: 'err', response: sentence }));
      }
      if (req.url === '/info') {
        const type = String(json.type);
        if (type === 'activeAssetData') return res.end(JSON.stringify({ leverage: state.leverage, markPx: '100' }));
        if (type === 'clearinghouseState') {
          const positions = state.position === null ? [] : [{ position: { coin: 'ETH', szi: String(state.position.szi), entryPx: String(state.position.entryPx), leverage: state.leverage } }];
          return res.end(JSON.stringify({ assetPositions: positions }));
        }
        if (type === 'openOrders') return res.end(JSON.stringify(state.openOrders));
        // The read-back after placing (src/hl/confirm.ts): this venue knows every order it
        // accepted, so the host's confirmation stops at its first read rather than polling for
        // twenty seconds against a fixture that only ever answered {}.
        if (type === 'orderStatus') {
          if (state.statusAnswer !== null) return res.end(JSON.stringify(state.statusAnswer(json.oid)));
          const known = typeof json.oid === 'string' ? state.book.get(json.oid) : undefined;
          if (known === undefined) {
            return res.end(JSON.stringify({ status: 'order', order: { status: 'open', statusTimestamp: Date.now(), order: { oid: json.oid, coin: 'ETH' } } }));
          }
          const left = Number((known.origSz - known.filled).toFixed(8));
          const status = left <= 0 ? 'filled' : known.canceled ? 'canceled' : 'open';
          return res.end(JSON.stringify({ status: 'order', order: { status, statusTimestamp: Date.now(), order: { oid: json.oid, coin: 'ETH', origSz: String(known.origSz), sz: String(left) } } }));
        }
        return res.end('{}');
      }
      const action = (json.action ?? {}) as Action;
      state.actions.push(action);
      if (action.type === 'updateLeverage') {
        state.leverage = { type: action.isCross ? 'cross' : 'isolated', value: action.leverage };
        return res.end(JSON.stringify({ status: 'ok', response: { type: 'default' } }));
      }
      if (action.type === 'cancelByCloid') {
        const statuses = state.cancelAnswer !== null ? state.cancelAnswer(action.cancels) : action.cancels.map(() => 'success');
        if (state.cancelAnswer === null) {
          for (const c of action.cancels) {
            const known = state.book.get(c.cloid);
            if (known !== undefined) known.canceled = true;
          }
        }
        return res.end(JSON.stringify({ status: 'ok', response: { type: 'cancel', data: { statuses } } }));
      }
      const statuses =
        state.answer !== null
          ? state.answer(action.orders)
          : action.orders.map((o, i) => {
              const tif = (o.t.limit as { tif?: string } | undefined)?.tif;
              if (tif === 'Ioc') return { filled: { totalSz: o.s, avgPx: o.p, oid: 1000 + i } };
              if (action.grouping === 'normalTpsl' && i > 0) return 'waitingForFill';
              return { resting: { oid: 2000 + i } };
            });
      action.orders.forEach((o, i) => {
        const s = statuses[i] as { filled?: { totalSz: string }; error?: string } | string | undefined;
        if (typeof o.c !== 'string' || (typeof s === 'object' && s !== null && s.error !== undefined)) return;
        const filled = typeof s === 'object' && s !== null && s.filled !== undefined ? Number(s.filled.totalSz) : 0;
        const ioc = (o.t.limit as { tif?: string } | undefined)?.tif === 'Ioc';
        state.book.set(o.c, { origSz: Number(o.s), filled, canceled: ioc && filled < Number(o.s) });
      });
      res.end(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses } } }));
    });
  });
  return {
    state,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    // Keep-alive sockets from a child that has not exited yet would hold close() open.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    orders: () => state.actions.filter((a): a is OrderAction => a.type === 'order'),
  };
}
