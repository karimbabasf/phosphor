// Everything that writes a response: the JSON senders, the conditional (ETag) one, the static
// file server, the body reader, and the small pure helpers every handler shares.
//
// ONE FAILURE SHAPE. `fail` is the single door every error response goes through, so a client
// can switch on one field. Before it, this surface answered a failure four different ways: 66
// sites with `{ error }`, 5 with `{ error }` plus one extra key, 26 bare domain objects with no
// wrapper at all, and one `{ ok: false, detail }`. The two sites that still do not use `fail`
// are both on /api/trade/action and are marked TRACK B where they sit: changing their bodies
// would change what the window reads, so they are left exactly as they are and named instead.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', '..', 'ui');

const MAX_BODY_BYTES = 1024 * 1024;
// Every label component on the MCP surface is caller-controlled and lands in an
// append-only file. The body cap is 1 MB, so without this one request can write a
// 1 MB log line, and a loop of them fills the disk the audit record lives on.
const MAX_LABEL_CHARS = 64;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

export type JsonBody = Record<string, unknown>;
// `status` is on the failure because the two refusals are different answers: a body this
// surface will not read at all is 415, a body it read and could not parse is 400.
type BodyResult = { ok: true; value: JsonBody } | { ok: false; error: string; status: number };

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function asRecord(value: unknown): JsonBody {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonBody) : {};
}

// Bound a caller-supplied string before it reaches a log label. Truncation is
// enough here: the log is JSONL, so JSON.stringify already escapes newlines and
// quotes, and no caller-controlled text is ever rendered as HTML.
export function capLabel(raw: string): string {
  return raw.length <= MAX_LABEL_CHARS ? raw : `${raw.slice(0, MAX_LABEL_CHARS)}...`;
}

export function intParam(raw: unknown, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/* The one door every refusal goes through. `extra` carries the keys a particular refusal adds
   beside the message (the notes on a chart write, the coins on a rejected coin list, the
   duplicate id, the seat marker), and `error` stays first so the shape on the wire is the one
   every caller already reads.

   `message` is REQUIRED, and it took a type change elsewhere to make that possible. Eight sites
   in this directory used to pass an `Outcome.error` the type said might be undefined, and
   JSON.stringify drops an undefined value, so those refusals went out as `{ notes: [...] }` or
   `{}`: a 400 with nothing in it to render. Outcome is a discriminated union now (src/chart.ts,
   src/trade/view.ts), so a failure cannot be built without a sentence and this signature can
   insist on one. The fallback below is for the untyped edges only. */
export function fail(res: http.ServerResponse, status: number, message: string, extra?: JsonBody): void {
  const error = message.trim().length > 0 ? message : 'the request was refused and no reason was recorded';
  sendJson(res, status, extra === undefined ? { error } : { error, ...extra });
}

// As sendJson, but the caller may ask whether anything changed since last time.
//
// State is pushed on a timer whether or not it moved: the heartbeat fires every
// HEARTBEAT_MS, and the ledger refresh in main.ts broadcasts on every pass. The browser
// answers each one by refetching 54KB and rebuilding the wallet, the policy and the basic
// screen, and measured on a running instance those bodies are byte-identical, so the rebuild
// repaints exactly what was already there.
//
// The ETag lets that case cost a 304: no body, no parse, no DOM teardown, no layout. Nothing
// about freshness changes, because the request still happens on every signal. Only the redraw
// is skipped, and only when the bytes match.
//
// no-store stays. The browser's own HTTP cache must not hold a wallet balance; the conditional
// request here is driven by an ETag the page holds in memory and loses on reload.
//
// THE BODY AND THE TAG ARE SEPARABLE from the sending, and that is what CachedJson is for. Both
// used to be built here, in front of the if-none-match comparison, so a 304 cost the server
// everything a 200 did: measured at 1000 proposals, 4.49 ms on the 304 path against 4.66 ms on the
// 200 path. The ETag saved the wire and the browser's redraw and saved the server nothing. A
// caller that can tell when its payload last changed builds the pair once and hands it here.
export type CachedJson = { body: string; etag: string };

export function jsonWithEtag(payload: unknown): CachedJson {
  const body = JSON.stringify(payload);
  // Not a security boundary, just a change detector, so speed beats collision resistance.
  return { body, etag: `"${crypto.createHash('sha1').update(body).digest('base64')}"` };
}

export function sendJsonConditional(req: http.IncomingMessage, res: http.ServerResponse, payload: unknown): void {
  sendCachedJson(req, res, jsonWithEtag(payload));
}

export function sendCachedJson(req: http.IncomingMessage, res: http.ServerResponse, cached: CachedJson): void {
  const { body, etag } = cached;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    etag,
  });
  res.end(body);
}

/* THE CONTROL PAGE HOLDS THE APPROVAL TOKEN, in window.__PHOSPHOR_TOKEN__, so one injected
   script is one approval an agent did not have to ask a person for.
   The only thing preventing that was that the UI never assigns innerHTML, insertAdjacentHTML or
   outerHTML: everything is built with createElement and textContent. That discipline is real
   (tests/unit/agent-panel-ui.test.ts asserts it for the panel that renders model output) and it
   is a convention, and a convention is not a control. This is the control.

   `script-src 'self'` with no 'unsafe-inline': every script in ui/index.html is a src, and the
   shell's token injection is an initialization script on the webview rather than a tag in the
   document, so neither needs the exemption. `style-src` keeps 'unsafe-inline' because the window
   sets element styles as it renders, and a stylesheet is not how a token leaves a machine.
   `connect-src 'self'` is what stops a script that did get in from posting the token anywhere,
   and `frame-ancestors 'none'` stops the page being framed at all. */
const CONTROL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/* HOW THE SHELL KNOWS THIS IS PHOSPHOR. The desktop shell spawns this process, then polls the
   port until something there names itself, and opens the window only once it has an answer. That
   marker used to be the page's <title>, which put a boot on the wrong side of a cosmetic edit:
   retitling ui/index.html to "Phosphor" left the shell polling a healthy server it no longer
   recognised, and the app failed as a 45-second timeout with nothing actually wrong with it.
   A response header cannot be moved by a redesign, and it is a fixed word rather than the version
   so that a bump cannot break a boot either. src-tauri/src/backend.rs reads it. */
export const IDENTITY_HEADER = 'x-phosphor';
export const IDENTITY_VALUE = 'control';

export function serveStatic(pathname: string, res: http.ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  } catch {
    fail(res, 404, 'not found');
    return;
  }
  const target = path.resolve(UI_DIR, rel);
  if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {
    fail(res, 404, 'not found');
    return;
  }
  const type = MIME[path.extname(target)];
  if (type === undefined) {
    fail(res, 404, 'not found');
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(target);
  } catch {
    fail(res, 404, 'not found');
    return;
  }
  // The UI is served from disk on every request so an edit shows up on reload, but a
  // font file is immutable content that would otherwise be refetched on every boot of
  // the window and re-run the swap.
  const cache = type === 'font/woff2' ? 'public, max-age=31536000, immutable' : 'no-store';
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': cache,
    [IDENTITY_HEADER]: IDENTITY_VALUE,
    ...(type === MIME['.html'] ? { 'content-security-policy': CONTROL_CSP } : {}),
  });
  res.end(body);
}

// application/json and nothing else, which is a security boundary rather than a formality.
//
// text/plain, multipart/form-data and application/x-www-form-urlencoded are the three types a
// browser can post cross-origin with NO preflight, so a page could shape a JSON body, label it
// text/plain and have this surface parse it. Requiring a type that is not on that list means
// any cross-origin post has to ask permission first, and this app answers no CORS headers, so
// the preflight fails and the request never arrives. Defence in depth behind sameOrigin: two
// independent reasons the same page is refused.
function jsonContentType(req: http.IncomingMessage): boolean {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') return false;
  return raw.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    if (!jsonContentType(req)) {
      // Read nothing and answer. A body this surface will not parse is not a body it should
      // spend a megabyte of memory buffering first.
      req.resume();
      resolve({ ok: false, error: 'content-type must be application/json', status: 415 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({ ok: false, error: 'request body too large', status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: asRecord(JSON.parse(raw)) });
      } catch {
        resolve({ ok: false, error: 'invalid json body', status: 400 });
      }
    });
    req.on('error', (err) => resolve({ ok: false, error: errText(err), status: 400 }));
  });
}
