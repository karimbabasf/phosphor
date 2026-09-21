// The log tail, as anything outside this process is allowed to read it.
//
// GET /api/log and the log_tail tool hand the newest audit lines to any local caller and to
// every agent, worker included, and a person pastes them into a problem report. Two things
// must never be in that paste: the key, and a credential of this boot. The write paths already
// hold both out (src/http/mcp.ts strips the seat secret and the token before a call is logged;
// tests/unit/seat-secret-log.test.ts and tests/unit/log-fingerprint.test.ts hold them to it),
// and this is the second wall, on the way out, so a write path that slips later still cannot
// publish a credential through the log.
//
// What is redacted, and what deliberately is not:
//   1. This boot's seat secret and window token, by asking the holders (agents.recognises,
//      tokenMatches), never by holding a copy here: every long opaque run in a line is offered to
//      both, and a match is replaced. Both compare hashes, so nothing about either value leaks
//      through the comparison.
//   2. A value stored under a field whose name says it is a secret (privateKey, seed,
//      mnemonic, passphrase and the like), whatever the value looks like.
//   3. A PEM private key block.
// A bare 64 hex run is NOT redacted by shape. A transaction hash, an intent hash and a 1Click
// deposit handle are the same 32 bytes of hex as a private key, and they are the evidence the
// log exists to carry; cutting them would leave a person a log that proves nothing. The key is
// kept out of the log by never being given to a writer (frozen rule: key material never
// appears in a log), and that is asserted at the write paths, not disguised here.

import type { Ctx } from './context.ts';
import { tokenMatches } from './auth.ts';
import type { LogEvent } from '../types.ts';

export const REDACTED = '[redacted]';

// Field names under which a secret would be stored if one ever were. Matched whole and case
// insensitively, so `tokenId` (a NEAR token contract) and `symbol` are untouched. `token` is
// not here on purpose: a Hyperliquid action names its asset under that key, and the window
// token is caught by value above.
const SECRET_FIELDS = new Set([
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'secret',
  'seed',
  'mnemonic',
  'passphrase',
  'password',
  'seatsecret',
  'seat_secret',
  'phosphor_seat',
  'phosphor_window_token',
]);

// A run long enough to be a credential of this boot: 32 bytes of hex from mint_token, or any
// other spelling a later mint might choose. Anchored on both sides against its own character
// class so a longer run is offered whole and never as overlapping pieces.
const CREDENTIAL_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,128}(?![A-Za-z0-9_-])/g;
const PEM_BLOCK = /-----BEGIN[ A-Z]*(PRIVATE KEY|RSA|EC|OPENSSH)[ A-Z]*-----[\s\S]*?(-----END[ A-Z]*-----|$)/g;

export type IsCredential = (candidate: string) => boolean;

export function credentialCheck(ctx: Pick<Ctx, 'agents' | 'token'>): IsCredential {
  return (candidate) =>
    ctx.agents.recognises(candidate) || (typeof ctx.token === 'string' && ctx.token.length > 0 && tokenMatches(candidate, ctx.token));
}

function redactString(text: string, isCredential: IsCredential): string {
  const swept = text.replace(PEM_BLOCK, REDACTED);
  return swept.replace(CREDENTIAL_RUN, (run) => (isCredential(run) ? REDACTED : run));
}

function redactValue(value: unknown, isCredential: IsCredential): unknown {
  if (typeof value === 'string') return redactString(value, isCredential);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, isCredential));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELDS.has(key.toLowerCase()) && v !== null && v !== undefined ? REDACTED : redactValue(v, isCredential);
    }
    return out;
  }
  return value;
}

export function redactEvent(event: LogEvent, isCredential: IsCredential): LogEvent {
  return redactValue(event, isCredential) as LogEvent;
}

// The newest `limit` lines, redacted. Both tail routes call this and nothing else reads the
// audit file on behalf of a caller outside the process.
export function redactedTail(ctx: Pick<Ctx, 'agents' | 'token' | 'audit'>, limit: number): LogEvent[] {
  const isCredential = credentialCheck(ctx);
  return ctx.audit.tail(limit).map((event) => redactEvent(event, isCredential));
}
