// The dispatch: a table of routes rather than the if-chain it replaces.
//
// A table is safe now that every handler is a free function taking a Ctx, and it is worth
// having for one reason beyond tidiness: a chain of `if (route === ...)` answers the wrong
// refusal the moment a branch above it forgets to return, and the surface that carries the
// approval gate is the last place to leave that shape lying around. The read tools had the same
// break for a while (see the note in mcp.ts).
//
// Order still matters in exactly two places, and both are kept: the Host gate runs before any
// route, and the static file server is the fallback only after every /api/ path has been tried.

import http from 'node:http';

import { HOST, hostIsLocal } from './auth.ts';
import { errText, fail, intParam, sendJson, sendJsonConditional, serveStatic } from './respond.ts';
import { buildState, fillGas, gasReport, transactionsPayload } from './state.ts';
import { chartPayload, handleChartWrite, sendCandles } from './chart.ts';
import { handleMutation } from './mutation.ts';
import { handleTradeAction, handleTradeWrite } from './trade.ts';
import { handleMcp } from './mcp.ts';
import { LOG_LIMIT_MAX } from './context.ts';
import type { Ctx } from './context.ts';

type Route = (ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

const GET: Record<string, Route> = {
  '/api/state': (ctx, req, res) => sendJsonConditional(req, res, buildState(ctx)),
  '/api/candles': (ctx, _req, res, url) => sendCandles(ctx, url, res),
  '/api/chart': (ctx, _req, res) => sendJson(res, 200, chartPayload(ctx)),
  '/api/log': (ctx, _req, res, url) =>
    sendJson(res, 200, ctx.audit.tail(intParam(url.searchParams.get('limit'), 200, LOG_LIMIT_MAX))),
  '/api/transactions': (ctx, _req, res) => {
    const payload = transactionsPayload(ctx);
    fillGas(ctx, payload.entries);
    sendJson(res, 200, payload);
  },
  // Same derivation as /api/transactions and the same background fill, so opening GAS
  // after HISTORY costs nothing and opening it first warms the cache for HISTORY. The
  // report says how many receipts are still coming rather than counting them as free.
  '/api/gas': (ctx, _req, res, url) => {
    const report = gasReport(ctx, url.searchParams.get('window') ?? '7d');
    sendJson(res, report.status, report.body);
  },
  '/api/trade': (ctx, _req, res) => sendJson(res, 200, ctx.trade.payload()),
  '/api/driver': (ctx, _req, res) => sendJson(res, 200, ctx.chats.payload()),
  '/api/events': (ctx, req, res) => ctx.sse.open(req, res),
};

const POST: Record<string, Route> = {
  '/api/mcp': (ctx, req, res) => handleMcp(ctx, req, res),
  '/api/chart': (ctx, req, res) => handleChartWrite(ctx, req, res),
  '/api/trade': (ctx, req, res) => handleTradeWrite(ctx, req, res),
  '/api/trade/action': (ctx, req, res) => handleTradeAction(ctx, req, res),
  '/api/approve': (ctx, req, res) => handleMutation(ctx, '/api/approve', req, res),
  '/api/refuse': (ctx, req, res) => handleMutation(ctx, '/api/refuse', req, res),
  '/api/kill': (ctx, req, res) => handleMutation(ctx, '/api/kill', req, res),
  '/api/yield/withdraw': (ctx, req, res) => handleMutation(ctx, '/api/yield/withdraw', req, res),
  '/api/driver': (ctx, req, res) => handleMutation(ctx, '/api/driver', req, res),
};

export async function handle(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const route = url.pathname;
  try {
    // First gate, before any route: refuse a forged Host. This is the one line that closes
    // DNS-rebinding for the whole surface, reads included, so a page cannot rebind its own
    // domain to 127.0.0.1 and then read the wallet and the session token as same-origin.
    if (!hostIsLocal(req)) {
      fail(res, 403, 'request refused: this app answers only on 127.0.0.1');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const handler = GET[route];
      if (handler !== undefined) return await handler(ctx, req, res, url);
      if (route.startsWith('/api/')) return fail(res, 404, `unknown route: ${route}`);
      // The second surface. A bare /trade is the page; everything else still resolves as a
      // file, so the two pages share one static root and one stylesheet.
      if (route === '/trade' || route === '/trade/') return serveStatic('/trade.html', res);
      return serveStatic(route, res);
    }
    if (req.method === 'POST') {
      const handler = POST[route];
      if (handler !== undefined) return await handler(ctx, req, res, url);
      return fail(res, 404, `unknown route: ${route}`);
    }
    fail(res, 405, `method not allowed: ${String(req.method)}`);
  } catch (err) {
    ctx.audit.append('error', `server error on ${route}: ${errText(err)}`);
    if (!res.headersSent) fail(res, 500, errText(err));
    else res.end();
  }
}
