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
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { sameOrigin, tokenMatches } from './auth.ts';
import { RECEIVE_NETWORKS, intentsDepositAddress, parsePoaTokens, poaSupportedTokens, receiveNetworkByBridge } from '../rails/intents-address.ts';
import type { PoaToken, ReceiveKind, ReceiveNetwork } from '../rails/intents-address.ts';
import { validateAddress } from '../chainscan/index.ts';
import type { ChainNetwork } from '../chainscan/index.ts';
import { atomicWriteJson } from '../fsatomic.ts';
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
export async function guarded(
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

export function announce(ctx: Ctx): void {
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
  enclave_required: 'This wallet opens with Touch ID, not a password.',
  enclave_unavailable: 'The Secure Enclave is not reachable from this build, so this needs a password.',
  user_cancel: 'You cancelled the Touch ID prompt.',
  foreign: 'This wallet file was made on another Mac. Restore it here from your recovery phrase.',
  not_backed_up: 'Back up your recovery phrase first.',
  no_wallet: 'There is no wallet on this computer yet.',
  no_mnemonic: 'This wallet has no recovery phrase, because it was imported from private keys.',
  damaged: 'The key file on this computer cannot be read. Your recovery words will bring the wallet back.',
  locked_out: 'Too many tries. Wait a moment and try again.',
};

export function refusal(code: string, retryInSec?: number): JsonBody {
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
    // The EVM key alone: it is the intents account and the Hyperliquid signer. The Solana and
    // NEAR keys the file still seals sign nothing in this app, so they are not shown.
    keys: {
      evm: secret.keys.evm?.privateKey ?? null,
    },
  });
}

// ---------- receive ----------

// The one address this app owns, named for each EVM network it is the same string on. It is
// the account id on NEAR Intents and Hyperliquid, which is what the vault screen shows it as;
// money comes in through the bridge address (handleIntentsReceive), never here.
const CHAIN_NAMES: Array<{ id: string; name: string; of: 'evm'; warning: string }> = [
  { id: 'eth', name: 'Ethereum', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. It is your account id, not a deposit address.' },
  { id: 'base', name: 'Base', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. It is your account id, not a deposit address.' },
  { id: 'arb', name: 'Arbitrum', of: 'evm', warning: 'Ethereum, Base and Arbitrum share this address. It is your account id, not a deposit address.' },
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

/* The floor as the window prints it. `shown` is the one decision: a floor worth under a cent is
   "No minimum" rather than a number nobody can type, and where no price is known the same cut is
   made on the amount itself, at a millionth of a unit. The raw floor stays on the token row for
   the developer line. */
export type IntentsReceiveMinimum = {
  shown: boolean;
  // The floor in the token's own unit, the same string as minDepositHuman.
  amount: string;
  // The floor in dollars from the 1Click price list, null when that list has no price for it.
  usd: number | null;
};

export type IntentsReceiveToken = {
  symbol: string;
  // The verifier's id for it (the bridge's intents_token_id), which is what the deposit watch
  // reads the balance of. Empty when the bridge row carried none.
  assetId: string;
  decimals: number;
  // Base units, as the bridge said it. The window never prints this one.
  minDeposit: string;
  // The floor in the token's own unit: "0.001" USDC, "0.0000001" ETH. The one that is printed.
  minDepositHuman: string;
  minimum: IntentsReceiveMinimum;
  // The contract on that chain, spelled the way the chain spells it, null for the chain's own
  // coin. The window copies it, so it is the exact string and never a shortened one.
  contract: string | null;
};

export type IntentsReceiveNetwork = {
  id: string;
  name: string;
  words: string;
  bridge: string;
  kind: ReceiveKind;
  native: string;
  mark: string;
  colour: string;
  popular: boolean;
  address: string | null;
  memo: string | null;
  unavailable: string | null;
  // The ids of the other networks whose address is byte-equal to this one. Computed from what the
  // bridge answered, never assumed from the kind: the EVM chains share one address today, and the
  // day the bridge changes that the list changes with it.
  sharedWith: string[];
  warning: string;
  accepts: IntentsReceiveToken[];
  // The sentence for an address the bridge changed under the pin (pinAddresses below), or null.
  changed: string | null;
};

export type IntentsReceiveReport = {
  account: string | null;
  verified: boolean;
  tampered: boolean;
  networks: IntentsReceiveNetwork[];
  reason?: string;
  note?: string;
};

export async function handleIntentsReceive(ctx: Ctx, res: http.ServerResponse): Promise<void> {
  sendJson(res, 200, await ctx.intentsReceive());
}

/* The bridge's half of the report: one address per registry network and the token list, so
   thirty-six round trips, plus the 1Click price list when the app has one to read. It is what
   the bridge said about an account, and the bridge says the same thing every time (the whole
   point of these addresses is that they do not change), so it is kept for a minute per account.
   The window read it three times for one deposit card and the wizard read it on every step
   change; each read was the whole set again. `verified` and `tampered` are NOT in here: those
   flip when the wallet opens and are read fresh on every call below. A call that came back with
   no addresses or no tokens is not kept, so a bridge that was down a second ago is asked again
   on the next call rather than remembered as down for a minute. */
type BridgeAddress = { net: ReceiveNetwork; got: { address: string; memo: string | null } | null; why: string | null };
type BridgeHalf = { at: number; addresses: BridgeAddress[]; tokens: PoaToken[]; prices: Map<string, number> | null };
const RECEIVE_CACHE_MS = 60_000;
const bridgeCache = new Map<string, BridgeHalf>();

/* The chain whose address rules a bridge address on this network has to pass. The EVM chains
   share one shape, so any of them stands for all; a network this app cannot decode (Litecoin,
   XRP, TON, Stellar and the rest) gets the plain rule below instead of a guess. */
function shapeChainOf(net: ReceiveNetwork): ChainNetwork | null {
  switch (net.kind) {
    case 'evm':
      return 'ethereum';
    case 'sol':
      return 'solana';
    case 'near':
      return 'near';
    case 'other':
      return net.id === 'btc' ? 'bitcoin' : null;
  }
}

/* Why a string the bridge answered with is not an address on this network, or null. The
   deposit address is the one string on the money-in screen this app cannot check against
   anything it holds, and it used to be drawn as any non-empty string: a bridge answering
   "0x1234", a sentence, or an address for another chain went under the QR code as is. The
   decoders in src/chainscan rule where they know the chain; elsewhere an address is at least
   printable, unbroken and of a plausible length. */
export function depositAddressProblem(net: ReceiveNetwork, address: string): string | null {
  const chain = shapeChainOf(net);
  if (chain !== null) {
    const check = validateAddress(chain, address);
    return check.ok ? null : check.reason;
  }
  if (!/^[!-~]{10,128}$/.test(address)) return 'expected 10 to 128 printable characters with no spaces';
  return null;
}

/* One network's address, asked for twice and shown only when both answers agree and the answer
   has the shape of an address on that network. The bridge hands back the same address every
   time by design, so two answers that differ mean a bridge, a proxy or a network path that
   cannot be trusted with a deposit right now, and the row says so rather than drawing either. */
async function askAddress(account: string, net: ReceiveNetwork): Promise<BridgeAddress> {
  try {
    // A registry id, or the raw key of a network the registry does not know: both resolve.
    const [first, second] = await Promise.all([intentsDepositAddress(account, net.id), intentsDepositAddress(account, net.id)]);
    if (first.address !== second.address || first.memo !== second.memo) {
      return { net, got: null, why: 'the bridge answered two different addresses for this network within a second, so neither is shown' };
    }
    const problem = depositAddressProblem(net, first.address);
    if (problem !== null) {
      return { net, got: null, why: `the bridge answered with something that is not an address on ${net.name} (${problem}), so it is not shown` };
    }
    return { net, got: { address: first.address, memo: first.memo }, why: null };
  } catch (err) {
    // One network refusing is not the others failing. The row says why and the rest draw.
    return { net, got: null, why: err instanceof Error ? err.message : String(err) };
  }
}

/* THE PIN: the address last shown for (account, bridge network), kept on disk so a bridge that
   answers a different one later is caught rather than believed. The bridge's addresses are per
   account and per network and never change (every token on a network shares the one address,
   so the asset is not a dimension of it); a change is a substitution somewhere between the
   bridge and this app, or a bridge that broke its own rule, and either way the person needs a
   sentence, not a new QR code. The row keeps drawing the pinned address and carries the change
   as `changed`. Memory would not do: the point is to remember across boots. A pin file that
   cannot be read pins afresh, which is the same trust the first sight had. */
type DepositPin = { address: string; memo: string | null; shownAt: string };
type DepositPins = Record<string, DepositPin>;
const PINS_FILE = 'deposit-addresses.json';

export function depositPinsPath(dataDir: string): string {
  return path.join(dataDir, PINS_FILE);
}

function readPins(dataDir: string): DepositPins {
  try {
    const parsed = JSON.parse(fs.readFileSync(depositPinsPath(dataDir), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DepositPins = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = value as Partial<DepositPin> | null;
      if (row === null || typeof row !== 'object' || typeof row.address !== 'string' || row.address === '') continue;
      out[key] = { address: row.address, memo: typeof row.memo === 'string' ? row.memo : null, shownAt: typeof row.shownAt === 'string' ? row.shownAt : '' };
    }
    return out;
  } catch {
    return {};
  }
}

function tailOf(address: string): string {
  return address.length <= 6 ? address : `...${address.slice(-6)}`;
}

/* Hold every row with an address to its pin: a first sight is pinned, a match is left alone,
   and a change draws NO address, with the sentence beside the empty row. The pin is a
   comparison key and never a destination: a file any process running as this user can write
   must not be able to put an address in front of a person, so a mismatch shows neither the
   bridge's answer nor the pinned one. Returns the rows as the window should draw them. */
function pinAddresses(dataDir: string | null, account: string, networks: IntentsReceiveNetwork[]): IntentsReceiveNetwork[] {
  if (dataDir === null) return networks;
  const pins = readPins(dataDir);
  let dirty = false;
  const now = new Date().toISOString();
  const out = networks.map((row) => {
    if (row.address === null) return row;
    const key = `${account.toLowerCase()}|${row.bridge}`;
    const held = pins[key];
    if (held === undefined) {
      pins[key] = { address: row.address, memo: row.memo, shownAt: now };
      dirty = true;
      return row;
    }
    if (held.address === row.address && held.memo === row.memo) return row;
    return {
      ...row,
      address: null,
      memo: null,
      changed:
        `The bridge now answers a different address for ${row.name} (ending ${tailOf(row.address)}) than the one shown before (ending ${tailOf(held.address)}). ` +
        'A bridge address does not change on its own, so no address is shown: do not send anything until you know why this one did.',
    };
  });
  if (dirty) {
    try {
      atomicWriteJson(depositPinsPath(dataDir), pins);
    } catch {
      // A pin that could not be written is a first sight again next time, never a blank card.
    }
  }
  return out;
}

/* A network the bridge lists that the registry does not know. Shown under the bridge's own key
   rather than a name made up here: the key is the one true thing known about it. Its coin is the
   symbol of the row with no contract, when the list has one. */
function unknownNetwork(bridge: string, tokens: PoaToken[]): ReceiveNetwork {
  const native = tokens.find((t) => t.network === bridge && t.contract === null)?.symbol ?? '';
  return { id: bridge, name: bridge, words: bridge, bridge, kind: 'other', native, mark: native, colour: '#8A8F98', popular: false };
}

/* The 1Click price list, as assetId -> dollars, through the seam main.ts wires. A report never
   fails for want of a price: no seam, or a seam that throws, is null, and every floor is then
   printed in the token's own unit alone. */
async function readPrices(ctx: Ctx): Promise<Map<string, number> | null> {
  if (ctx.intentsPrices === undefined) return null;
  try {
    return await ctx.intentsPrices();
  } catch {
    return null;
  }
}

async function readBridge(ctx: Ctx, account: string, force: boolean): Promise<BridgeHalf> {
  const held = bridgeCache.get(account);
  if (!force && held !== undefined && Date.now() - held.at < RECEIVE_CACHE_MS) return held;

  const fixture = ctx.cfg.mode === 'demo' ? demoFixture() : null;
  let addresses: BridgeAddress[];
  let tokens: PoaToken[];
  let prices: Map<string, number> | null;
  if (fixture !== null) {
    ({ addresses, tokens, prices } = fixture);
  } else {
    [addresses, tokens, prices] = await Promise.all([
      Promise.all(RECEIVE_NETWORKS.map((n) => askAddress(account, n))),
      poaSupportedTokens(),
      readPrices(ctx),
    ]);
    /* A prefix the bridge added since the registry was written. One more round of asks, only
       when there is something to ask about, so a new network is a row with an address rather
       than a row with an excuse. */
    const strangers = [...new Set(tokens.map((t) => t.network))].filter((key) => receiveNetworkByBridge(key) === undefined);
    if (strangers.length > 0) {
      addresses = addresses.concat(await Promise.all(strangers.map((key) => askAddress(account, unknownNetwork(key, tokens)))));
    }
  }

  const half: BridgeHalf = { at: Date.now(), addresses, tokens, prices };
  if (tokens.length > 0 && addresses.some((row) => row.got !== null)) bridgeCache.set(account, half);
  return half;
}

/* PHOSPHOR_DEMO_RECEIVE: a JSON file that stands in for the bridge in demo mode, for a proof
   run on a machine that cannot reach it. Shape: { "addresses": { "eth": "0x..", "sol": "..",
   ... }, "tokens": [ bridge rows as supported_tokens returns them ], "prices": { "<intents
   token id>": dollars } }. Addresses are keyed by registry id and may name only some networks;
   the rest are rows that say so. Prices are optional. Demo mode without the file still asks the
   real bridge, as it always did. Never read in live mode. */
function demoFixture(): { addresses: BridgeAddress[]; tokens: PoaToken[]; prices: Map<string, number> | null } | null {
  const file = process.env.PHOSPHOR_DEMO_RECEIVE;
  if (file === undefined || file === '') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      addresses?: Record<string, unknown>;
      tokens?: unknown;
      prices?: Record<string, unknown>;
    };
    const book = parsed.addresses ?? {};
    const addresses = RECEIVE_NETWORKS.map((n): BridgeAddress => {
      const address = book[n.id];
      return typeof address === 'string' && address !== ''
        ? { net: n, got: { address, memo: null }, why: null }
        : { net: n, got: null, why: 'not in the demo fixture' };
    });
    const prices = new Map<string, number>();
    for (const [assetId, price] of Object.entries(parsed.prices ?? {})) {
      if (typeof price === 'number' && Number.isFinite(price)) prices.set(assetId, price);
    }
    return { addresses, tokens: parsePoaTokens(parsed.tokens), prices: prices.size > 0 ? prices : null };
  } catch (err) {
    console.error(`phosphor: PHOSPHOR_DEMO_RECEIVE could not be read: ${errText(err)}`);
    return null;
  }
}

/* The token rows for one network: what the bridge credits there, one row per (symbol, contract).
   The live list carries BTC twice on Bitcoin (two NEAR tokens for one coin); a person sending
   BTC sees one row, and it carries the higher of the two floors, because the lower one is a
   promise only one of the two paths keeps. */
function acceptsOn(bridge: string, tokens: PoaToken[], prices: Map<string, number> | null): IntentsReceiveToken[] {
  const rows = new Map<string, IntentsReceiveToken>();
  for (const t of tokens) {
    if (t.network !== bridge) continue;
    const key = `${t.symbol}|${t.contract ?? ''}`;
    const held = rows.get(key);
    if (held !== undefined && !floorAbove(t.minDeposit, held.minDeposit)) continue;
    const price = prices?.get(t.intentsAssetId);
    rows.set(key, {
      symbol: t.symbol,
      assetId: t.intentsAssetId,
      decimals: t.decimals,
      minDeposit: t.minDeposit,
      minDepositHuman: t.minDepositHuman,
      minimum: minimumOf(t.minDepositHuman, typeof price === 'number' && Number.isFinite(price) ? price : null),
      contract: t.contract,
    });
  }
  return [...rows.values()];
}

// Base units against base units, exactly. A floor that is not a whole number never wins.
function floorAbove(a: string, b: string): boolean {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  return BigInt(a) > BigInt(b);
}

function minimumOf(amount: string, price: number | null): IntentsReceiveMinimum {
  const human = Number(amount);
  const known = Number.isFinite(human);
  const usd = price !== null && known ? human * price : null;
  /* Shown when EITHER rule says so: a floor of a millionth of the coin or more is shown whatever
     the price says, and a price only ever adds a floor that the unit rule would have called
     dust. A wrong price from 1Click (it is a read, not a fact) can therefore reveal a floor,
     never hide one: hiding XRP's 2 or Tron USDT's 1 behind "No minimum" is the loss this row
     exists to prevent (security review, 2026-09-16). */
  const shown = (known && human >= 1e-6) || (usd !== null && usd >= 0.01);
  return { shown, amount, usd: usd === null ? null : Math.round(usd * 10_000) / 10_000 };
}

/* Which other networks answered with the very same address. Byte equality on the string the
   bridge sent, so two spellings of one address are two addresses here, which is the safe way
   round: the warning then says "only", and "only" is never wrong. */
function sharedWithOf(row: BridgeAddress, all: BridgeAddress[]): string[] {
  if (row.got === null) return [];
  const address = row.got.address;
  return all.filter((other) => other !== row && other.got !== null && other.got.address === address).map((other) => other.net.id);
}

function warningOf(net: ReceiveNetwork, shared: string[], nets: Map<string, ReceiveNetwork>): string {
  if (shared.length === 0) return `${net.name} only. Anything sent here from another network is lost.`;
  // The popular ones by name, in registry order, then how many more: sixteen names is a
  // paragraph, and the point is the last clause.
  const named = shared.map((id) => nets.get(id)).filter((n): n is ReceiveNetwork => n !== undefined && n.popular).map((n) => n.name);
  const rest = shared.length - named.length;
  const listed = named.length === 0 ? `${rest} other networks` : rest === 0 ? named.join(', ') : `${named.join(', ')} and ${rest} more`;
  return `${net.name} shares this address with ${listed}, but send only on "${net.words}", and only an asset it credits.`;
}

/* The bridge addresses and what each network credits, as one report. The route above serves
   it to the window whole; the `deposit` read tool serves the agent one network of it with the
   address reduced to a fingerprint, because the window is where an address is read from.
   `force` skips the minute's cache, for a caller that has a reason to believe the bridge
   changed its answer; nothing in the app needs it today. */
export async function intentsReceiveReport(ctx: Ctx, opts: { force?: boolean } = {}): Promise<IntentsReceiveReport> {
  const report = ctx.keystore.addressReport();
  const account = report.addresses.evm;

  /* No EVM address is not an empty list, it is a different sentence. The verifier keys balances
     by this id, so without it there is no account to deposit into and a screen showing a row
     of blank tiles would imply otherwise. */
  if (account === null) {
    return {
      account: null,
      verified: report.verified,
      tampered: report.tampered,
      networks: [],
      reason: report.tampered
        ? 'the keystore header was edited, so no address here can be trusted'
        : 'no wallet yet, so there is no intents account to deposit into',
    };
  }

  const { addresses, tokens, prices } = await readBridge(ctx, account, opts.force === true);
  const nets = new Map(addresses.map((row) => [row.net.id, row.net]));

  const networks: IntentsReceiveNetwork[] = addresses.map((row) => {
    const shared = sharedWithOf(row, addresses);
    return {
      id: row.net.id,
      name: row.net.name,
      words: row.net.words,
      bridge: row.net.bridge,
      kind: row.net.kind,
      native: row.net.native,
      mark: row.net.mark,
      colour: row.net.colour,
      popular: row.net.popular,
      address: row.got?.address ?? null,
      memo: row.got?.memo ?? null,
      unavailable: row.why,
      sharedWith: shared,
      warning: warningOf(row.net, shared, nets),
      /* What the bridge will credit on this network. An asset that is not on this list is not
         credited and is not refunded, which is the one loss this screen exists to prevent, so
         the list is shown rather than left to the address to imply. */
      accepts: acceptsOn(row.net.bridge, tokens, prices),
      changed: null,
    };
  });

  // The six quick tiles first, in the registry's order, then everything else by name.
  const order = new Map(RECEIVE_NETWORKS.map((n, i) => [n.id, i]));
  networks.sort((a, b) => {
    if (a.popular !== b.popular) return a.popular ? -1 : 1;
    if (a.popular) return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    return a.name.localeCompare(b.name, 'en');
  });

  return {
    account,
    verified: report.verified,
    tampered: report.tampered,
    networks: pinAddresses(typeof ctx.cfg.dataDir === 'string' && ctx.cfg.dataDir !== '' ? ctx.cfg.dataDir : null, account, networks),
    // Said plainly, because it is the one thing about this screen that surprises people: the
    // address is not ours, it is a bridge address that forwards.
    note: 'These addresses belong to the NEAR Intents bridge. It forwards what it receives to your intents balance.',
  };
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
