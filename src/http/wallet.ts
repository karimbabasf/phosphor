// The custody routes: unlock, lock, the four wallet verbs, the reveal handshake, and the one
// read that works with no wallet open at all.
//
// WHY THESE ARE HTTP ROUTES. The audit wanted a native passphrase dialog and no unlock route,
// on the grounds that a route is a route and any local process can post to it. That was the
// right argument against the surface as it stood, when GET /api/session handed the token to
// anything with a shell. It is not the right argument now: the token is minted by the shell,
// injected into one webview, and served by nothing, so posting to /api/unlock needs the same
// thing posting to /api/approve needs. The gain is that the lock screen lives inside the one
// window a person is already looking at instead of a second native surface.
//
// NO AGENT REACHES ANY OF THIS. There is no unlock op in /api/mcp and no unlock tool in
// src/mcp.ts, and tests/tool-surface.ts is what keeps it that way. Absence is stronger than a
// refusal the agent could argue with.
//
// WHAT NEVER LEAVES. No key, no mnemonic and no password enters an audit line, a state
// payload, an SSE frame or a proposal. The reveal handshake below is the single exception and
// it is a handshake precisely so that the material moves on one request that cannot be
// replayed.

import crypto from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';

import { sameOrigin, tokenMatches } from './auth.ts';
import { fail, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { mnemonicProblem } from '../keystore/derive.ts';
import type { RailKeys } from '../keystore/derive.ts';
import type { Ctx } from './context.ts';

// Long enough that a four-digit guess is not the whole search space, short enough that it does
// not push people to a password manager they then have to unlock first. The KDF is what makes
// a weak one expensive; this is what stops a trivial one.
const MIN_PASSWORD = 8;

// The reveal window. Long enough to read twelve words off a screen and write them down, short
// enough that a nonce left in a page's memory is not a standing key.
const REVEAL_TTL_MS = 30_000;

type Pending = { what: 'mnemonic' | 'keys'; expires: number };
const pending = new Map<string, Pending>();

/* Every route here carries the window token, the same way approve does, and answers the same
   403. It is written once because the failure mode of writing it five times is that the fifth
   one forgets. */
async function guarded(
  ctx: Ctx,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<JsonBody | null> {
  const parsed = await readBody(req);
  if (!parsed.ok) {
    fail(res, parsed.status, parsed.error);
    return null;
  }
  const body = parsed.value;
  const reason = !sameOrigin(req)
    ? 'cross-origin request'
    : !tokenMatches(body.token, ctx.token)
      ? 'the window token is missing or wrong'
      : null;
  if (reason !== null) {
    // The password never reaches this line, and neither does anything derived from it. What is
    // worth recording is that somebody knocked on the custody surface without the window.
    ctx.audit.append('approve_attempt_rejected', `POST ${route} rejected: ${reason}`, {
      route,
      reason,
      origin: req.headers.origin ?? '(absent)',
    });
    fail(res, 403, reason);
    return null;
  }
  return body;
}

function passwordOf(body: JsonBody): string | null {
  const password = typeof body.password === 'string' ? body.password : '';
  return password.length >= MIN_PASSWORD ? password : null;
}

function announce(ctx: Ctx): void {
  ctx.sse.broadcastLock(ctx.keystore.state());
  ctx.sse.broadcastState();
}

// ---------- unlock and lock ----------

export async function handleUnlock(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/unlock', req, res);
  if (body === null) return;
  const password = typeof body.password === 'string' ? body.password : '';
  if (password === '') return sendJson(res, 200, { ok: false, error: 'wrong_password' });

  const out = await ctx.keystore.unlock(password);
  if (!out.ok) {
    // The reason is logged, the attempt is not counted in a way that could be mistaken for a
    // decision, and the password is nowhere near this line.
    ctx.audit.append('approve_attempt_rejected', `unlock refused: ${out.error}`, { error: out.error });
    return sendJson(res, 200, { ok: false, error: out.error, ...(out.retryInSec !== undefined ? { retryInSec: out.retryInSec } : {}) });
  }
  ctx.audit.append('app_start', 'the wallet was unlocked in the window');
  ctx.session.touch();
  announce(ctx);
  // Anything an agent proposed while the wallet was locked is re-decided now, under the
  // policy as it stands at this moment rather than as it stood when the agent asked.
  const released = await ctx.releaseQueued();
  sendJson(res, 200, { ok: true, released });
}

export async function handleLock(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/lock', req, res);
  if (body === null) return;
  const was = ctx.keystore.lock();
  if (was) ctx.audit.append('app_start', `the wallet was locked (${String(body.reason ?? 'on demand')})`, { reason: body.reason ?? 'on_demand' });
  announce(ctx);
  sendJson(res, 200, { ok: true });
}

// The idle beacon. It carries the token like every other write, because a timer any local
// process could reset is not a timer: the whole point of decision 6 is that agent traffic
// never refreshes the lock, and this route is the only thing that does.
export async function handleActivity(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/activity', req, res);
  if (body === null) return;
  ctx.session.touch();
  sendJson(res, 200, { ok: true, idleLocksInSec: ctx.session.idleLocksInSec() });
}

// ---------- the wallet verbs ----------

export async function handleWalletCreate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/wallet/create', req, res);
  if (body === null) return;
  const password = passwordOf(body);
  if (password === null) return fail(res, 400, `the password must be at least ${MIN_PASSWORD} characters`);
  try {
    const made = await ctx.keystore.create(password);
    // The words are audited by their absence: the line says a wallet exists and names the
    // address, which is the fact a log is for. The phrase is returned once, here, and never
    // written anywhere this process controls.
    ctx.audit.append('app_start', 'a new wallet was created in the window', { evm: made.addresses.evm });
    ctx.session.touch();
    announce(ctx);
    sendJson(res, 200, { ok: true, mnemonic: made.mnemonic.split(' '), addresses: made.addresses });
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : String(err));
  }
}

export async function handleWalletImport(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/wallet/import', req, res);
  if (body === null) return;
  const password = passwordOf(body);
  if (password === null) return fail(res, 400, `the password must be at least ${MIN_PASSWORD} characters`);

  const mnemonic = typeof body.mnemonic === 'string' ? body.mnemonic : undefined;
  if (mnemonic !== undefined) {
    const problem = mnemonicProblem(mnemonic);
    if (problem !== null) return fail(res, 400, problem);
  }
  const raw = body.keys !== null && typeof body.keys === 'object' ? (body.keys as Partial<RailKeys>) : undefined;
  if (mnemonic === undefined && raw === undefined) return fail(res, 400, 'bring twelve words or at least one private key');

  try {
    const out = await ctx.keystore.importWallet(password, { mnemonic, keys: raw });
    ctx.audit.append('app_start', `a wallet was imported in the window (${mnemonic !== undefined ? 'recovery phrase' : 'private keys'})`, {
      evm: out.addresses.evm,
    });
    ctx.session.touch();
    announce(ctx);
    sendJson(res, 200, { ok: true, addresses: out.addresses });
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : String(err));
  }
}

export async function handleWalletMigrate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/wallet/migrate', req, res);
  if (body === null) return;
  const password = passwordOf(body);
  if (password === null) return fail(res, 400, `the password must be at least ${MIN_PASSWORD} characters`);
  try {
    const out = await ctx.keystore.migrate(password);
    ctx.audit.append('app_start', `the plaintext key file was encrypted and destroyed (${out.destroyed.length} file(s))`, {
      destroyed: out.destroyed.map((p) => path.basename(p)),
      evm: out.addresses.evm,
    });
    ctx.session.touch();
    announce(ctx);
    sendJson(res, 200, {
      ok: true,
      destroyed: out.destroyed,
      addresses: out.addresses,
      // Said out loud rather than buried in a doc: an overwrite is not an erasure on a file
      // system that keeps snapshots, and the only complete answer is a fresh wallet.
      note: 'Overwritten and deleted. A Time Machine or APFS snapshot taken before now may still hold a copy, so move to a fresh wallet later if that matters.',
    });
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : String(err));
  }
}

export async function handleWalletExport(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/wallet/export', req, res);
  if (body === null) return;
  const password = passwordOf(body);
  if (password === null) return fail(res, 400, `the password must be at least ${MIN_PASSWORD} characters`);
  const target = typeof body.path === 'string' ? body.path : '';
  if (!path.isAbsolute(target)) return fail(res, 400, 'the backup path must be absolute');
  /* The password has to open the LIVE keystore before it is used to write a backup, and the
     check is unconditional. It used to fall through when the wallet happened to be unlocked
     already, which was the bug this route exists to avoid: exportTo encrypts under whatever
     password it is handed, so a typo produced a perfectly valid backup that opens only with the
     typo. The owner would find out the day they needed it. */
  const opened = await ctx.keystore.unlock(password);
  if (!opened.ok) {
    ctx.audit.append('approve_attempt_rejected', `backup refused: ${opened.error}`, { error: opened.error });
    return sendJson(res, 200, { ok: false, error: opened.error, ...(opened.retryInSec !== undefined ? { retryInSec: opened.retryInSec } : {}) });
  }
  try {
    await ctx.keystore.exportTo(target, password);
    ctx.audit.append('app_start', 'an encrypted backup of the wallet was written', { to: target });
    sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : String(err));
  }
}

// ---------- reveal ----------

/* Two requests, and the split is the point. The POST proves the password again, which is what
   stops an unattended unlocked window from being a key dump; it hands back a nonce and no
   material. The GET spends that nonce once and the material travels on a response nobody asked
   for by URL, so it never sits in a history entry, a log line or a retry.
   The nonce is 32 random bytes: the GET carries no token because it is the redemption half of
   a handshake the POST already authorised, and an unguessable one-shot secret is the
   authorisation. It still needs a matching Origin, so no page can spend it. */
export async function handleRevealStart(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/wallet/reveal', req, res);
  if (body === null) return;
  const what = body.what === 'keys' ? 'keys' : 'mnemonic';
  const password = typeof body.password === 'string' ? body.password : '';
  if (password === '') return sendJson(res, 200, { ok: false, error: 'wrong_password' });

  // Re-entering the password is the control, so it is checked against the file rather than
  // against the fact that the wallet happens to be open.
  const opened = await ctx.keystore.unlock(password);
  if (!opened.ok && opened.error !== 'no_wallet') {
    ctx.audit.append('approve_attempt_rejected', `reveal refused: ${opened.error}`, { error: opened.error, what });
    return sendJson(res, 200, { ok: false, error: opened.error });
  }
  if (ctx.keystore.state() !== 'unlocked') return sendJson(res, 200, { ok: false, error: 'no_wallet' });
  if (what === 'mnemonic' && ctx.keystore.header()?.hasMnemonic !== true) {
    return sendJson(res, 200, { ok: false, error: 'no_mnemonic' });
  }

  // Nonces that were issued and never spent are dropped here rather than by a timer, because
  // the only thing that can add one is this line, so this is the only place the map can grow.
  const at = Date.now();
  for (const [key, held] of [...pending]) if (at > held.expires) pending.delete(key);

  const nonce = crypto.randomBytes(32).toString('hex');
  pending.set(nonce, { what, expires: at + REVEAL_TTL_MS });
  // The log records that somebody asked to see the key, which is exactly the event an owner
  // reading this file later wants to find. It records nothing about what they saw.
  ctx.audit.append('app_start', `the window asked to reveal the ${what === 'keys' ? 'private keys' : 'recovery phrase'}`, { what });
  ctx.session.touch();
  sendJson(res, 200, { ok: true, nonce, expiresInSec: REVEAL_TTL_MS / 1000 });
}

/* A browser does not send Origin on a same-origin GET, so sameOrigin() can never pass here and
   this route was unreachable from the window it exists for. It is checked with the fetch
   metadata headers instead, which is what they are for:

     Sec-Fetch-Site: same-origin   the request came from this app's own page
     Sec-Fetch-Mode: not navigate  it is a fetch, not a tab opened at this URL

   The second half is the one that matters. A cross-site fetch cannot read this response anyway,
   because nothing here sends CORS headers, so the material cannot reach an attacker's script.
   What it CAN do is open the URL as a top-level navigation and render the JSON in a tab, and
   that is what refusing `navigate` closes. A matching Origin is still accepted, so a caller that
   does send one keeps working.

   The nonce remains the credential: 32 random bytes, spent on sight, and dead in sixty seconds. */
function revealSameOrigin(req: http.IncomingMessage): boolean {
  if (sameOrigin(req)) return true;
  const site = req.headers['sec-fetch-site'];
  const mode = req.headers['sec-fetch-mode'];
  if (site !== 'same-origin') return false;
  return mode !== 'navigate';
}

export function handleRevealFetch(ctx: Ctx, nonce: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!revealSameOrigin(req)) return fail(res, 403, 'cross-origin request');
  const held = pending.get(nonce);
  // Spent on sight, before anything can go wrong further down: a nonce that survives a failed
  // read is a nonce that can be retried.
  pending.delete(nonce);
  if (held === undefined) return fail(res, 404, 'that reveal has already been used, or was never issued');
  if (Date.now() > held.expires) return fail(res, 410, 'that reveal expired. Ask again.');
  if (!ctx.keystore.isUnlocked()) return fail(res, 409, 'the wallet locked before the reveal was read');

  const secret = ctx.keystore.reveal();
  if (held.what === 'mnemonic') {
    if (secret.mnemonic === null) return fail(res, 404, 'this wallet has no recovery phrase');
    return sendJson(res, 200, { ok: true, what: 'mnemonic', mnemonic: secret.mnemonic.split(' ') });
  }
  sendJson(res, 200, {
    ok: true,
    what: 'keys',
    keys: {
      evm: secret.keys.evm?.privateKey ?? null,
      solana: secret.keys.solana?.secretKey ?? null,
      near: secret.keys.near?.secretKey ?? null,
    },
  });
}

// ---------- receive ----------

const CHAIN_NAMES: Array<{ id: string; name: string; of: 'evm' | 'solana' | 'near'; warning: string }> = [
  { id: 'eth', name: 'Ethereum', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. Send only what the network you picked supports.' },
  { id: 'base', name: 'Base', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. Send only what the network you picked supports.' },
  { id: 'arb', name: 'Arbitrum', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. Send only what the network you picked supports.' },
  { id: 'sol', name: 'Solana', of: 'solana', warning: 'Solana only. Anything sent here from another network is lost.' },
  { id: 'near', name: 'NEAR', of: 'near', warning: 'NEAR only. This account exists once something is sent to it.' },
];

// Works while locked, and that is the feature: money arriving is the one thing a person should
// never have to unlock for. The addresses come from the keystore's plaintext header.
export function handleReceive(ctx: Ctx, res: http.ServerResponse): void {
  const addresses = ctx.keystore.addresses();
  const chains = CHAIN_NAMES.filter((c) => addresses[c.of] !== null).map((c) => ({
    id: c.id,
    name: c.name,
    address: addresses[c.of],
    warning: c.warning,
  }));
  sendJson(res, 200, { chains, state: ctx.keystore.state() });
}
