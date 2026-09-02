// The whole authorisation surface: the per-boot approval token, and the two request predicates
// every mutating route checks before it does anything.
//
// KNOWN HOLE, do not read this file as a boundary. GET /api/session hands the token to ANY
// unauthenticated caller on loopback, and sameOrigin() deliberately allows an absent Origin
// header so curl and the e2e script work. So the whole path is open to anything with a shell:
//   GET  /api/session                        -> token, no auth
//   POST /api/approve  {id, token} no Origin -> 400 "unknown proposal" (auth CLEARED)
//   POST /api/approve  with a wrong token    -> 403 "invalid approval token"
// The 400-versus-403 split is the proof that authorisation passed and only the id was unknown.
// Every coding agent on this machine has a shell, so every one of them is already inside the
// boundary the product claims to have.
//
// Verified independently twice on 2026-08-11. Writeup:
// Lessons/2026-08-11-phosphor-approval-token-reachable.md in the vault. A per-boot token shared
// with every local caller is an identifier, never an authorisation.
// Unfixed: the fix is a design call on the thing the product exists for.

import crypto from 'node:crypto';
import type http from 'node:http';

export const HOST = '127.0.0.1';

// One token per boot, minted before the port opens. It is what GET /api/session hands the
// window and what every browser write carries back.
export function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
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
// what closes rebinding for the READ routes too (/api/state, /api/session, /api/events), which
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

// Absent Origin (curl, the e2e script) is allowed; a foreign one is not. Paired
// with the Host check this blunts drive-by and DNS-rebinding POSTs from a page
// the human happens to have open in the same browser.
export function sameOrigin(req: http.IncomingMessage): boolean {
  if (!hostIsLocal(req)) return false;
  const host = String(req.headers.host ?? '');
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return true;
  return origin === `http://${host}`;
}
