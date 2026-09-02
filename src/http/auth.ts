// The whole authorisation surface: the window token, and the three request predicates every
// mutating route checks before it does anything.
//
// THE TOKEN IS NEVER SERVED. It is minted outside this process by the Tauri shell, handed to
// the backend in PHOSPHOR_WINDOW_TOKEN, and injected into the control webview as
// window.__PHOSPHOR_TOKEN__. No route hands it out, which is what makes it an authorisation
// rather than an identifier. GET /api/session used to hand it to any caller on loopback and is
// deleted; the write-up is Lessons/2026-08-11-phosphor-approval-token-reachable.md in the vault.
//
// A bare `node src/main.ts` for development has no shell to mint one, so this file mints a
// token and prints it once to stderr. That is a development convenience and it is stated where
// it happens: an installed app always arrives with the variable set.

import crypto from 'node:crypto';
import type http from 'node:http';

export const HOST = '127.0.0.1';

// One token per boot, minted before the port opens. It is what the window carries back on
// every write. Only the fallback below calls it: the shell mints the real one.
export function mintToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// The token this boot answers to. The shell that owns the window puts it in the environment
// before it starts this process, so the only holder is the webview the shell injected it into.
//
// Absent means a developer ran the backend by hand. Minting one and printing it once is what
// keeps that path usable; it is printed to stderr rather than served, because a route that
// hands the token out is the hole this whole file exists to close.
export const WINDOW_TOKEN_VAR = 'PHOSPHOR_WINDOW_TOKEN';

/* Printed once per PROCESS, not once per call. createServer resolves the token, and every test
   in this repo builds a server, so a line per construction would bury the transcript it is
   meant to sit in. */
let announced = false;

/* The token this boot answers to.

   ENV OR MINT, and the env is the real path. The Tauri shell mints 32 random bytes, hands them
   here in PHOSPHOR_WINDOW_TOKEN, and injects the same value into the control webview alone with
   an initialization script (src-tauri/src/main.rs). The token is then reachable by exactly two
   processes and served over HTTP by neither, which is what makes it an authorisation rather than
   an identifier and what closes the hole this file's header describes.

   Absent means a developer ran the backend by hand. Minting one and printing it once is what
   keeps that path usable; it goes to stderr rather than to a route, because a route that hands
   the token out is the hole. A SHORT value is treated as absent rather than accepted: 32
   characters is the floor because that is what the shell sends, and a token below it is a
   truncated or half-written variable, not a shorter secret somebody meant.

   `env` is a parameter so a test can drive both paths without mutating the process. */
export function windowToken(env: NodeJS.ProcessEnv = process.env): string {
  const supplied = (env[WINDOW_TOKEN_VAR] ?? '').trim();
  if (supplied.length >= 32) return supplied;
  const minted = mintToken();
  if (!announced) {
    announced = true;
    process.stderr.write(
      `phosphor: no ${WINDOW_TOKEN_VAR} in the environment, so this boot minted one: ${minted}\n`,
    );
  }
  return minted;
}

// Hash both sides so the comparison is constant length as well as constant time:
// a raw timingSafeEqual on the tokens themselves would throw on a length mismatch
// and leak the token length through that error.
export function tokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// The SHA-256 prefix of a token, for the audit log. The supplied token itself never enters the
// log; this is the difference between "a token was rejected" and "which client is holding which
// token": two rejections sharing a fingerprint are one stale page retrying, and a fingerprint
// that matches no boot this app has served is a client that never had one.
export function tokenFingerprint(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

// The Host header, on its own. A browser that has been pointed at this loopback service by a
// DNS-rebinding page sends the ATTACKER's domain here, not 127.0.0.1: after the rebind the tab
// still thinks it is talking to evil.com, so Host is evil.com. Refusing a non-loopback Host is
// what closes rebinding for the READ routes too (/api/state, /api/events), which
// sameOrigin never guarded because they carry no Origin. An absent Host is a Host-less HTTP/1.0
// client (curl, the e2e script), a local tool and not a browser, so it is allowed: a browser
// cannot omit it. The app binds to 127.0.0.1 only, so no legitimate request arrives under any
// other name anyway; this only rejects the forged ones.
export function hostIsLocal(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  if (host === '') return true;
  const hostname = host.split(':')[0];
  return hostname === HOST || hostname === 'localhost';
}

// A PRESENT Origin that names this app, and nothing else. Three things it refuses that the
// older, laxer version allowed:
//
//   'null'   an opaque origin. `<iframe sandbox="allow-scripts">` on any page the human has
//            open gives its script exactly that, and the browser really did dial 127.0.0.1, so
//            Host passes. Allowing the literal string was the one branch that let a web page
//            reach /api/mcp and auto-execute under the click threshold.
//   absent   any local process posting with no Origin at all. It was allowed so curl and the
//            e2e script worked, which is the same door.
//   foreign  unchanged: a page on another origin cannot post here.
//
// Origin is a forbidden header name, so no page can set it: a matching Origin can only come
// from a page this app served, or from a local process that chose to send one. The local
// process is not held out by this line, it is held out by the window token on every route that
// decides anything; on /api/mcp, where the agent's door deliberately has no token, this is
// what makes the door unreachable from a browser.
export function sameOrigin(req: http.IncomingMessage): boolean {
  if (!hostIsLocal(req)) return false;
  const host = String(req.headers.host ?? '');
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  return origin === `http://${host}`;
}
