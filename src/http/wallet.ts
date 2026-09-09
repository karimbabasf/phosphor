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
import { POA_NETWORK, intentsDepositAddress, poaSupportedTokens } from '../rails/intents-address.ts';
import type { ChainId } from '../types.ts';
import { errText, fail, readBody, sendJson } from './respond.ts';
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

/* A REFUSAL SAYS SO IN ENGLISH, and carries the code beside it.
   These routes answered `{ ok: false, error: 'wrong_password' }` with HTTP 200: a machine code in
   the one field every other route on this surface fills with a human sentence via fail(). A
   client switching on `error` printed "wrong_password" at a person, and one switching on the HTTP
   status read a refusal as a success. The status stays 200 because these are answers rather than
   errors (the window renders them into its own screen, and a 4xx would send it down the network
   failure path), so the shape is what has to be unambiguous: `ok` is the answer, `error` is the
   sentence, `code` is for anything that wants to branch. */
const REFUSALS: Record<string, string> = {
  wrong_password: 'That password is wrong.',
  no_wallet: 'There is no wallet on this computer yet.',
  no_mnemonic: 'This wallet has no recovery phrase, because it was imported from private keys.',
  damaged: 'The key file on this computer cannot be read. Your recovery words will bring the wallet back.',
  locked_out: 'Too many tries. Wait a moment and try again.',
};

function refusal(code: string, retryInSec?: number): JsonBody {
  const wait =
    code === 'locked_out' && typeof retryInSec === 'number' && retryInSec > 0
      ? `Too many tries. Wait ${retryInSec} ${retryInSec === 1 ? 'second' : 'seconds'} and try again.`
      : undefined;
  return {
    ok: false,
    error: wait ?? REFUSALS[code] ?? 'That did not work.',
    code,
    ...(retryInSec !== undefined ? { retryInSec } : {}),
  };
}

// ---------- unlock and lock ----------

/* ONE UNLOCK AT A TIME, and the second caller is handed the first one's answer.
   The request does not return until the queue has been released, and releasing a queue means
   sending every rail that was waiting, so this route can legitimately take a minute. The window
   disables the button for that whole time, but a disabled button is a courtesy and not a
   control: anything holding the window token can post twice. So the promise is the control.
   Sharing the answer regardless of which password the second request carried is deliberate.
   The wallet is one keystore, so once the first request has opened it the honest answer to the
   second is that it is open, and that is what GET /api/state already says. No password is held
   here to compare against, which is the property this file is built on. */
let unlocking: Promise<JsonBody> | null = null;

async function unlockOnce(ctx: Ctx, password: string): Promise<JsonBody> {
  const out = await ctx.keystore.unlock(password);
  if (!out.ok) {
    // The reason is logged, the attempt is not counted in a way that could be mistaken for a
    // decision, and the password is nowhere near this line.
    ctx.audit.append('approve_attempt_rejected', `unlock refused: ${out.error}`, { error: out.error });
    return refusal(out.error, out.retryInSec);
  }
  ctx.audit.append('app_start', 'the wallet was unlocked in the window');
  ctx.session.touch();
  announce(ctx);
  // Anything an agent proposed while the wallet was locked is re-decided now, under the
  // policy as it stands at this moment rather than as it stood when the agent asked.
  const released = await ctx.releaseQueued();
  return { ok: true, released };
}

export async function handleUnlock(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/unlock', req, res);
  if (body === null) return;
  const password = typeof body.password === 'string' ? body.password : '';
  if (password === '') return sendJson(res, 200, refusal('wrong_password'));

  if (unlocking !== null) return sendJson(res, 200, await unlocking);

  const job = unlockOnce(ctx, password);
  unlocking = job;
  try {
    sendJson(res, 200, await job);
  } finally {
    if (unlocking === job) unlocking = null;
  }
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
  /* Refused outright in demo mode, before the password is even looked at. This route shreds a
     plaintext key file and every backup beside it, and a demo backend is by definition a
     throwaway instance: it has no business destroying anything. The keystore refuses the same
     call from underneath, and the key path is scoped by the data directory so there is normally
     nothing real in reach. Three locks, because the failure here is irreversible. */
  if (ctx.cfg.mode === 'demo') {
    return fail(res, 403, 'demo mode never migrates a wallet, because migrating destroys a plaintext key file. Start Phosphor in live mode to do this.');
  }
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
     typo. The owner would find out the day they needed it.
     VERIFY, not unlock. Proving the password is the whole of what this route needs, and it used
     to prove it by opening the wallet and then saying nothing: the window kept drawing the lock
     screen, the idle timer kept counting from the last human action, and anything queued in
     pending_unlock stayed queued. Writing a backup is not a reason to open a wallet. */
  const opened = await ctx.keystore.verify(password);
  if (!opened.ok) {
    ctx.audit.append('approve_attempt_rejected', `backup refused: ${opened.error}`, { error: opened.error });
    return sendJson(res, 200, refusal(opened.error, opened.retryInSec));
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
  if (password === '') return sendJson(res, 200, refusal('wrong_password'));

  // Re-entering the password is the control, so it is checked against the file rather than
  // against the fact that the wallet happens to be open.
  //
  // This one DOES unlock, unlike the backup above, and it has to: the second half of the
  // handshake reads material off an open wallet, thirty seconds later, with no password in
  // hand. What was missing is that the app never noticed. So the unlock is announced below,
  // exactly as pressing Unlock would be.
  const wasShut = ctx.keystore.state() === 'locked';
  const opened = await ctx.keystore.unlock(password);
  if (!opened.ok && opened.error !== 'no_wallet') {
    ctx.audit.append('approve_attempt_rejected', `reveal refused: ${opened.error}`, { error: opened.error, what });
    return sendJson(res, 200, refusal(opened.error, opened.retryInSec));
  }
  if (ctx.keystore.state() !== 'unlocked') return sendJson(res, 200, refusal('no_wallet'));

  if (wasShut) {
    /* The wallet is open now and everything that watches it has to be told: the window draws a
       whole screen off the lock frame, and the queue behind the lock is waiting on exactly this.
       The queue is released in the BACKGROUND rather than awaited, because this response carries
       a nonce that dies in thirty seconds and releasing a queue means sending a rail apiece. */
    ctx.audit.append('app_start', 'the wallet was unlocked by the reveal handshake');
    announce(ctx);
    void ctx.releaseQueued().catch((err: unknown) => {
      ctx.audit.append('error', `releasing the queue after a reveal failed: ${errText(err)}`);
    });
  }
  if (what === 'mnemonic' && ctx.keystore.header()?.hasMnemonic !== true) {
    return sendJson(res, 200, refusal('no_mnemonic'));
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

/* Works while locked, and that is the feature: money arriving is the one thing a person should
   never have to unlock for.

   `verified` is the fact this route used to leave out, and leaving it out is what made the
   locked case dangerous. An open wallet serves addresses derived from the keys themselves and
   this is true. A wallet this process has never opened serves the plaintext header, which
   nothing authenticates, and this is false: the window says so rather than implying an
   assurance the file cannot give. `tampered` is the third case, where a correct password has
   proved the header was edited; the address list is empty there, on purpose. */
// ---------- receive into the verifier ----------

/* The other receive. handleReceive above answers "where do I send money so THIS WALLET holds
   it"; this answers "where do I send money so NEAR INTENTS holds it", which after the cut to two
   venues is where the money actually lives.

   Different address, different owner, and the difference matters enough to be two routes rather
   than a flag. The addresses above are ours, derived from our own keys. The addresses below
   belong to the POA bridge and forward to the verifier under our account id, which is the EVM
   address lowercased. Phosphor never sends to them and they are deliberately not on the policy
   allowlist: the allowlist governs where this app may send, and nothing here is a destination
   this app chooses.

   Works while locked, for the same reason the wallet one does. It reads the account id out of
   the keystore's address report rather than out of an unlocked key, so money arriving never
   waits on a password. */
const INTENTS_NETWORKS: Array<{ id: ChainId; name: string }> = [
  { id: 'eth', name: 'Ethereum' },
  { id: 'base', name: 'Base' },
  { id: 'arb', name: 'Arbitrum' },
  { id: 'sol', name: 'Solana' },
  { id: 'near', name: 'NEAR' },
];

export async function handleIntentsReceive(ctx: Ctx, res: http.ServerResponse): Promise<void> {
  const report = ctx.keystore.addressReport();
  const account = report.addresses.evm;

  /* No EVM address is not an empty list, it is a different sentence. The verifier keys balances
     by this id, so without it there is no account to deposit into and a screen showing five
     blank cards would imply otherwise. */
  if (account === null) {
    sendJson(res, 200, {
      account: null,
      verified: report.verified,
      tampered: report.tampered,
      networks: [],
      reason: report.tampered
        ? 'the keystore header was edited, so no address here can be trusted'
        : 'no wallet yet, so there is no intents account to deposit into',
    });
    return;
  }

  const [addresses, tokens] = await Promise.all([
    Promise.all(
      INTENTS_NETWORKS.map(async (n) => {
        try {
          return { net: n, got: await intentsDepositAddress(account, n.id), why: null as string | null };
        } catch (err) {
          // One network refusing is not the others failing. The row says why and the rest draw.
          return { net: n, got: null, why: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
    poaSupportedTokens(),
  ]);

  const networks = addresses.map((row) => {
    const network = POA_NETWORK[row.net.id];
    const accepts = tokens.filter((t) => t.network === network);
    return {
      id: row.net.id,
      name: row.net.name,
      address: row.got?.address ?? null,
      memo: row.got?.memo ?? null,
      unavailable: row.why,
      /* What the bridge will credit on this network. An asset that is not on this list is not
         credited and is not refunded, which is the one loss this screen exists to prevent, so
         the list is shown rather than left to the address to imply. */
      accepts: accepts.map((t) => ({ symbol: t.symbol, minDeposit: t.minDeposit, decimals: t.decimals })),
      warning:
        row.net.id === 'sol'
          ? 'Solana only. Anything sent here from another network is lost.'
          : row.net.id === 'near'
            ? 'NEAR only. Anything sent here from another network is lost.'
            : 'Ethereum, Base and Arbitrum share this address, but send only on the network you picked.',
    };
  });

  sendJson(res, 200, {
    account,
    verified: report.verified,
    tampered: report.tampered,
    networks,
    // Said plainly, because it is the one thing about this screen that surprises people: the
    // address is not ours, it is a bridge address that forwards.
    note: 'These addresses belong to the NEAR Intents bridge. It forwards what it receives to your intents balance.',
  });
}

export function handleReceive(ctx: Ctx, res: http.ServerResponse): void {
  const report = ctx.keystore.addressReport();
  const chains = CHAIN_NAMES.filter((c) => report.addresses[c.of] !== null).map((c) => ({
    id: c.id,
    name: c.name,
    address: report.addresses[c.of],
    warning: c.warning,
  }));
  sendJson(res, 200, { chains, state: ctx.keystore.state(), verified: report.verified, tampered: report.tampered });
}
