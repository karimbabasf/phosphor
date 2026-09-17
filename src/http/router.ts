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
import { capLabel, errText, fail, intParam, sendCachedJson, sendJson, serveStatic } from './respond.ts';
import { buildStateCached, proposalPage, transactionsPayload } from './state.ts';
import { chartPayload, handleChartWrite, handleSnapshotDelivery, partParam, sendCandles, slotParam } from './chart.ts';
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
  handleIntentsReceive,
} from './wallet.ts';
import {
  handleDepositShow,
  handleDepositStatus,
  handleDepositStop,
  handleVaultAnswer,
  handleVaultBackupProven,
  handleVaultCreate,
  handleVaultForget,
  handleVaultMigrate,
  handleVaultPending,
  handleVaultPrefs,
  handleVaultRestore,
  handleVaultReveal,
  handleVaultStatus,
  handleVaultUnlock,
} from './vault.ts';
import { sendHealth } from './health.ts';
import { sendReceipts } from './receipts.ts';
import { LOG_LIMIT_MAX } from './context.ts';
import type { Ctx } from './context.ts';

type Route = (ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

const GET: Record<string, Route> = {
  // The body and the tag are built by buildStateCached, which keeps them until something the
  // payload reads moves. See the note beside it: a 304 used to cost the server as much as a 200.
  '/api/state': (ctx, req, res) => sendCachedJson(req, res, buildStateCached(ctx)),
  /* The proposal history, paged, because it is the one list that grows for the life of a data
     directory and /api/state may not carry it. Same gate as every other read here: the Host
     check above, and nothing else, because this answers only on 127.0.0.1. */
  '/api/proposals': (ctx, _req, res, url) => {
    const page = proposalPage(ctx, url);
    sendJson(res, page.status, page.body);
  },
  '/api/candles': (ctx, _req, res, url) => sendCandles(ctx, url, res),
  // ?slot=n picks one of the charts a layout put up; no slot is the primary. A slot no layout
  // filled is a 404, never the primary under another chart's name.
  // ?part=markup is the payload without the candles, for the window answering a chart frame.
  '/api/chart': (ctx, _req, res, url) => {
    const slot = slotParam(url.searchParams.get('slot'));
    if (slot === null) return fail(res, 400, `slot must be 0 to 3, got ${capLabel(String(url.searchParams.get('slot')))}`);
    const part = partParam(url.searchParams.get('part'));
    if (part === null) return fail(res, 400, `part must be full or markup, got ${capLabel(String(url.searchParams.get('part')))}`);
    const payload = chartPayload(ctx, slot, part);
    if (payload === null) return fail(res, 404, `no chart in slot ${slot}; chart_layout puts one there`);
    sendJson(res, 200, payload);
  },
  '/api/log': (ctx, _req, res, url) =>
    sendJson(res, 200, ctx.audit.tail(intParam(url.searchParams.get('limit'), 200, LOG_LIMIT_MAX))),
  '/api/transactions': (ctx, _req, res) => sendJson(res, 200, transactionsPayload(ctx)),
  '/api/trade': (ctx, _req, res) => sendJson(res, 200, ctx.trade.payload()),
  '/api/driver': (ctx, _req, res) => sendJson(res, 200, ctx.chats.payload()),
  // Money arriving is the one thing nobody should have to unlock for, so this reads the
  // addresses out of the keystore's plaintext header and answers while locked.
  '/api/receive': (ctx, _req, res) => handleReceive(ctx, res),
  // The same question asked of the other place money can sit. Reaches the network, so it
  // is the one receive route that can be slow; it still answers while locked.
  '/api/intents-receive': (ctx, _req, res) => handleIntentsReceive(ctx, res),
  '/api/events': (ctx, req, res) => ctx.sse.open(req, res),
  // The vault's own facts: custody kind, enclave reach, backed up, what the dialog is waiting
  // on. No key and no address; the window draws the Vault tab off it.
  '/api/vault': (ctx, _req, res) => handleVaultStatus(ctx, res),
  '/api/deposit': (ctx, _req, res) => handleDepositStatus(ctx, res),
  // No token, no secret, and deliberately the only unauthenticated proof of life. See health.ts.
  '/api/health': (ctx, _req, res) => sendHealth(ctx, res),
  // One card per action that actually happened.
  '/api/receipts': (ctx, _req, res, url) => sendReceipts(ctx, url, res),
};

const POST: Record<string, Route> = {
  '/api/mcp': (ctx, req, res) => handleMcp(ctx, req, res),
  '/api/chart': (ctx, req, res) => handleChartWrite(ctx, req, res),
  // The window's answer to a snapshot frame. Same guard as every window write, plus a body cap
  // of its own, because an image is the one thing the window posts that could be large.
  '/api/chart/snapshot': (ctx, req, res) => handleSnapshotDelivery(ctx, req, res),
  '/api/trade': (ctx, req, res) => handleTradeWrite(ctx, req, res),
  '/api/trade/action': (ctx, req, res) => handleTradeAction(ctx, req, res),
  '/api/approve': (ctx, req, res) => handleMutation(ctx, '/api/approve', req, res),
  '/api/refuse': (ctx, req, res) => handleMutation(ctx, '/api/refuse', req, res),
  '/api/kill': (ctx, req, res) => handleMutation(ctx, '/api/kill', req, res),
  // The tab the person clicked, so the server knows which screen the window is on. Window
  // token like every human write; the agent's own switch is the set_view_mode op on /api/mcp.
  '/api/view': (ctx, req, res) => handleMutation(ctx, '/api/view', req, res),
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
  '/api/acknowledge': (ctx, req, res) => handleMutation(ctx, '/api/acknowledge', req, res),
  /* The enclave. The first two are the shell's relay (see src/vault/relay.ts); the rest are the
     wallet verbs of an enclave wallet, each of which asks the relay and waits for a person. All
     of them carry the window token, and none of them is reachable from /api/mcp. */
  '/api/vault/pending': (ctx, req, res) => handleVaultPending(ctx, req, res),
  '/api/vault/answer': (ctx, req, res) => handleVaultAnswer(ctx, req, res),
  '/api/vault/create': (ctx, req, res) => handleVaultCreate(ctx, req, res),
  '/api/vault/unlock': (ctx, req, res) => handleVaultUnlock(ctx, req, res),
  '/api/vault/reveal': (ctx, req, res) => handleVaultReveal(ctx, req, res),
  '/api/vault/backup-proven': (ctx, req, res) => handleVaultBackupProven(ctx, req, res),
  '/api/vault/restore': (ctx, req, res) => handleVaultRestore(ctx, req, res),
  '/api/vault/migrate': (ctx, req, res) => handleVaultMigrate(ctx, req, res),
  '/api/vault/forget': (ctx, req, res) => handleVaultForget(ctx, req, res),
  '/api/vault/prefs': (ctx, req, res) => handleVaultPrefs(ctx, req, res),
  '/api/deposit/show': (ctx, req, res) => handleDepositShow(ctx, req, res),
  '/api/deposit/stop': (ctx, req, res) => handleDepositStop(ctx, req, res),
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
