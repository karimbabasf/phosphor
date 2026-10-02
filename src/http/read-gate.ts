// The gate in front of every read, and the one place the window gets the key its reads carry.
//
// Every GET under /api/ needs the window token or the read key (src/http/auth.ts, readAllowed).
// Before this, the Host check was the only thing in front of the GET table, so any process that
// could open 127.0.0.1, under any macOS account, read the ledger, the policy with the size of a
// move that needs no click, the pending moves, the wallet's address and the Hyperliquid account.
//
// Deny by default: a route added to the GET table later is behind the gate without anyone
// remembering to put it there. The one exception is /api/health, which answers anyone that the
// app is alive and which version it is, and keeps everything about the wallet for a caller that
// carries a credential (src/http/health.ts).
//
// Who holds what: the window trades its token for the read key (below); the shell sends the token;
// agents read through /api/mcp with the seat secret, where their reads are seated and marked; and
// a program the person runs (a proof script, curl) reads <dataDir>/read.key, which src/main.ts
// writes owner-readable at every boot. Mode 0600 is what keeps out another account on this Mac
// and a sandboxed app, the callers this gate is for; a process running as this user can read the
// data directory itself, so the file gives it nothing the directory does not.

import path from 'node:path';
import type http from 'node:http';

import { readAllowed, readKeyFor } from './auth.ts';
import type { Ctx } from './context.ts';
import { capLabel, fail, sendJson } from './respond.ts';
import { guarded } from './wallet.ts';

const OPEN_READS = new Set(['/api/health']);

export const READ_KEY_FILE = 'read.key';

export function readKeyPath(dataDir: string): string {
  return path.join(dataDir, READ_KEY_FILE);
}

const REVEAL_PREFIX = '/api/wallet/reveal/';

/* A refused read is worth a line in the audit log: something on this Mac asked for the wallet
   without the window's key. A loop of them is not worth a line each, so it is one line, then at
   most one a minute saying how many more knocked. */
const KNOCK_LINE_MS = 60_000;
const knocks = new WeakMap<Ctx, { at: number; since: number }>();

export function readGate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const route = url.pathname;
  if (!route.startsWith('/api/') || OPEN_READS.has(route)) return true;
  if (readAllowed(req, url, ctx.token)) return true;
  noteKnock(ctx, route);
  fail(res, 401, 'reading this app needs the window token or its read key, and only the Phosphor window and its shell hold them');
  return false;
}

function noteKnock(ctx: Ctx, route: string): void {
  const now = Date.now();
  const seen = knocks.get(ctx) ?? { at: 0, since: 0 };
  seen.since += 1;
  knocks.set(ctx, seen);
  if (seen.at !== 0 && now - seen.at < KNOCK_LINE_MS) return;
  // The reveal path carries a one-time nonce, which never belongs in a file.
  const named = route.startsWith(REVEAL_PREFIX) ? REVEAL_PREFIX : capLabel(route);
  try {
    ctx.audit.append('read_refused', `GET ${named} refused: no window token or read key`, { route: named, refused: seen.since });
  } catch {
    // The refusal still goes out; the line is what is lost.
  }
  seen.at = now;
  seen.since = 0;
}

/* POST /api/read-key: the window trades its token for the read key, once per token. Behind the
   same guard as every window write (a matching Origin and the token in the body), so a holder of
   the token gets a key it could have computed, and nobody else gets one. */
export async function handleReadKey(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/read-key', req, res);
  if (body === null) return;
  sendJson(res, 200, { read: readKeyFor(ctx.token) });
}
