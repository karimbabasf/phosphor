// The whole authorisation surface: the window token, and the three request predicates every
// mutating route checks before it does anything.
//
// THE TOKEN IS NEVER SERVED, AND IT NEVER TRAVELS BY ENVIRONMENT. It is minted outside this
// process by the Tauri shell, written as the first line of this process's stdin, and injected
// into the control webview as window.__PHOSPHOR_TOKEN__. No route hands it out, which is what
// makes it an authorisation rather than an identifier. GET /api/session used to hand it to any
// caller on loopback and is deleted; the write-up is
// Lessons/2026-08-11-phosphor-approval-token-reachable.md in the vault.
//
// The pipe replaced PHOSPHOR_WINDOW_TOKEN, and the reason is the one src/runner/host.ts already
// gives for the Hyperliquid key: `ps eww <pid>` prints the environment of any process this user
// owns, which is the attacker this app is built against. A local process read the token back and
// drove the kill switch, the idle beacon, the driver prompt and approve on a real pending
// proposal, which the audit then recorded as decidedBy 'human'. That is the whole of the
// capability GET /api/session used to hand out, through a second channel. A hardened runtime does
// not close it either: the signed node binary still shows its environment to ps.
//
// A bare `node src/main.ts` for development has nobody to send one, so this file mints a token
// and prints it once to stderr. That is a development convenience and it is stated where it
// happens: an installed app always arrives with one on the pipe, and refuses to boot without it.

import crypto from 'node:crypto';
import type http from 'node:http';

export const HOST = '127.0.0.1';

// One token per boot, minted before the port opens. It is what the window carries back on
// every write. Only the fallback below calls it: the shell mints the real one.
export function mintToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/* The variable this token used to travel in. It is named here so the test that asserts it is NOT
   set can name it too, and so a reader grepping for it finds the reason it went. Nothing in src/
   reads it any more. */
export const WINDOW_TOKEN_VAR = 'PHOSPHOR_WINDOW_TOKEN';

// 32 characters is the floor because that is what the shell sends. A shorter line is a truncated
// or half-written pipe, not a shorter secret somebody meant.
const MIN_TOKEN_CHARS = 32;

// Long enough that a shell writing one line has finished, short enough that a developer who piped
// nothing is not left staring at a window that has not opened.
const TOKEN_WAIT_MS = 2_000;

export type TokenSource = {
  // The stream the first line is read from. Defaults to this process's stdin.
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  waitMs?: number;
  /* Whether the Tauri shell started this process, which it says with PHOSPHOR_APP_DATA=1. A shell
     child that receives no token must not mint one: the shell has already injected a token into
     the webview, and a different one here leaves a window that cannot approve anything and no
     sentence saying why. */
  fromShell?: boolean;
  env?: NodeJS.ProcessEnv;
  onMinted?: (token: string) => void;
};

/* The token this boot answers to, read from the pipe before the port opens.
   Resolves on the first newline, on end of stream, or on the deadline, whichever comes first, and
   stops listening either way: nothing else in this process reads stdin, and holding it open would
   keep an fd the shell wants closed. */
export async function readWindowToken(opts: TokenSource = {}): Promise<string> {
  const stdin = opts.stdin ?? (process.stdin as NodeJS.ReadableStream & { isTTY?: boolean });
  const waitMs = opts.waitMs ?? TOKEN_WAIT_MS;
  const env = opts.env ?? process.env;
  const fromShell = opts.fromShell ?? env.PHOSPHOR_APP_DATA === '1';

  // A terminal is nobody about to pipe a secret, so there is nothing to wait for.
  const supplied = stdin.isTTY === true ? '' : await firstLine(stdin, waitMs);

  if (supplied.length >= MIN_TOKEN_CHARS) return supplied;
  if (fromShell) {
    throw new Error(
      'the window token never arrived on stdin, and this process was started by the app shell. ' +
        'Minting one here would leave a window that cannot approve anything, so this instance will not start.',
    );
  }

  const minted = mintToken();
  const say = opts.onMinted ?? announceMinted;
  say(minted);
  return minted;
}

function firstLine(stdin: NodeJS.ReadableStream, waitMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buffered = '';
    let done = false;

    const finish = (value: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      // Read no further. The token is the only thing this process ever wants from stdin.
      stdin.pause?.();
      resolve(value.trim());
    };

    const onData = (chunk: Buffer | string): void => {
      buffered += String(chunk);
      const at = buffered.indexOf('\n');
      if (at !== -1) finish(buffered.slice(0, at));
    };
    const onEnd = (): void => finish(buffered);

    const timer = setTimeout(() => finish(buffered), waitMs);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onEnd);
    stdin.resume?.();
  });
}

/* Printed once per PROCESS, not once per call. createServer resolves the token, and every test
   in this repo builds a server, so a line per construction would bury the transcript it is
   meant to sit in. */
let announced = false;

function announceMinted(minted: string): void {
  if (announced) return;
  announced = true;
  process.stderr.write(`phosphor: no window token arrived on stdin, so this boot minted one: ${minted}\n`);
}

/* The synchronous fallback, and it is for tests and for a server built without one.
   src/main.ts reads the pipe and hands the value to createServer, so the real backend never comes
   through here. Every test in this repo builds a server, most of them do not care what the token
   is, and a few play the shell by setting the variable themselves; that is safe in a test process
   and unsafe in the app, which is why the app no longer does it.

   `env` is a parameter so a test can drive both paths without mutating the process. */
export function windowToken(env: NodeJS.ProcessEnv = process.env): string {
  const supplied = (env[WINDOW_TOKEN_VAR] ?? '').trim();
  if (supplied.length >= MIN_TOKEN_CHARS) return supplied;
  const minted = mintToken();
  announceMinted(minted);
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
