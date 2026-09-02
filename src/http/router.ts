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
import { isDraining } from '../draining.ts';
import { errText, fail, intParam, sendJson, sendJsonConditional, serveStatic } from './respond.ts';
import { buildState, fillGas, gasReport, transactionsPayload } from './state.ts';
import { chartPayload, handleChartWrite, sendCandles } from './chart.ts';
import { handleMutation } from './mutation.ts';
import { handleTradeAction, handleTradeWrite } from './trade.ts';
import { handleMcp } from './mcp.ts';
import {
  handleActivity,
  handleLock,
  handleReceive,
  handleRevealFetch,
  handleRevealStart,
  handleUnlock,
  handleWalletCreate,
  handleWalletExport,
  handleWalletImport,
  handleWalletMigrate,
} from './wallet.ts';
import { sendHealth } from './health.ts';
import { sendReceipts } from './receipts.ts';
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
  // Money arriving is the one thing nobody should have to unlock for, so this reads the
  // addresses out of the keystore's plaintext header and answers while locked.
  '/api/receive': (ctx, _req, res) => handleReceive(ctx, res),
  '/api/events': (ctx, req, res) => ctx.sse.open(req, res),
  // No token, no secret, and deliberately the only unauthenticated proof of life. See health.ts.
  '/api/health': (ctx, _req, res) => sendHealth(ctx, res),
  /* One card per action that actually happened. The same background gas fill the history uses,
     for the same reason: the panel draws immediately with whatever receipts are already read. */
  '/api/receipts': (ctx, _req, res, url) => {
    sendReceipts(ctx, url, res);
    fillGas(ctx, transactionsPayload(ctx).entries);
  },
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
  // Custody. Every one of these carries the window token, and no agent op reaches any of them:
  // there is no unlock op in /api/mcp and no unlock tool in src/mcp.ts.
  '/api/unlock': (ctx, req, res) => handleUnlock(ctx, req, res),
  '/api/lock': (ctx, req, res) => handleLock(ctx, req, res),
  '/api/activity': (ctx, req, res) => handleActivity(ctx, req, res),
  '/api/wallet/create': (ctx, req, res) => handleWalletCreate(ctx, req, res),
  '/api/wallet/import': (ctx, req, res) => handleWalletImport(ctx, req, res),
  '/api/wallet/migrate': (ctx, req, res) => handleWalletMigrate(ctx, req, res),
  '/api/wallet/reveal': (ctx, req, res) => handleRevealStart(ctx, req, res),
  '/api/wallet/export': (ctx, req, res) => handleWalletExport(ctx, req, res),
  '/api/reconcile': (ctx, req, res) => handleMutation(ctx, '/api/reconcile', req, res),
};

// The one path with a variable in it. A table cannot hold it, and a second table of patterns
// for one route would be a mechanism built for a single caller, so it is one branch named
// where the reader is already looking for the route.
const REVEAL_PREFIX = '/api/wallet/reveal/';

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
      if (route.startsWith(REVEAL_PREFIX)) {
        return handleRevealFetch(ctx, route.slice(REVEAL_PREFIX.length), req, res);
      }
      if (route.startsWith('/api/')) return fail(res, 404, `unknown route: ${route}`);
      /* One page, and one static root under it. There used to be a second surface here: a bare
         /trade served ui/trade.html. The UI rewrite moved the trading screen inside the one
         window and deleted that file, so the branch answered 404 for every request it ever took
         while still reading like a supported entry point. */
      return serveStatic(route, res);
    }
    if (req.method === 'POST') {
      /* Draining. Reads keep answering so the window still renders; every write is refused with
         a sentence rather than accepted two hundred milliseconds before the sockets close. See
         src/draining.ts and src/shutdown.ts. */
      if (isDraining()) {
        return fail(res, 503, 'Phosphor is shutting down, so nothing new can be written. Start it again and retry.');
      }
      const handler = POST[route];
      if (handler !== undefined) return await handler(ctx, req, res, url);
      return fail(res, 404, `unknown route: ${route}`);
    }
    fail(res, 405, `method not allowed: ${String(req.method)}`);
  } catch (err) {
    // Everything in here is itself wrapped. The audit append is a disk write, and an ENOSPC on
    // audit.jsonl throwing from inside this catch is exactly how one bad write on one request
    // used to end the whole backend. The response still goes out; the log line is what is lost.
    try {
      ctx.audit.append('error', `server error on ${route}: ${errText(err)}`);
    } catch (logErr) {
      process.stderr.write(`phosphor: could not log a ${route} failure: ${errText(logErr)}\n`);
    }
    try {
      if (!res.headersSent) fail(res, 500, errText(err));
      else res.end();
    } catch {
      res.destroy();
    }
  }
}
