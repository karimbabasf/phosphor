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
      if (req.url === '/info') {
        const type = String(json.type);
        if (type === 'activeAssetData') return res.end(JSON.stringify({ leverage: state.leverage, markPx: '100' }));
        if (type === 'clearinghouseState') {
          const positions = state.position === null ? [] : [{ position: { coin: 'ETH', szi: String(state.position.szi), entryPx: String(state.position.entryPx), leverage: state.leverage } }];
          return res.end(JSON.stringify({ assetPositions: positions }));
        }
        if (type === 'openOrders') return res.end(JSON.stringify(state.openOrders));
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
