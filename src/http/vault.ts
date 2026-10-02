// The vault routes: the two the shell's relay uses, and the wallet verbs of an enclave wallet.
//
// Every route here carries the window token through guarded(), like every custody route in
// wallet.ts. The relay's two routes are token-gated for the same reason approve is: they are
// how the enclave's answers reach this process, and the only two holders of the token are the
// window the shell opened and the shell itself.
//
// WHAT AN ENCLAVE VERB LOOKS LIKE. Each one asks the relay for something (a fresh enclave key,
// a data key unwrapped after a Touch ID, a presence check), waits for the shell to answer, and
// only then touches the keystore. The request carries a reason composed here, in this file, so
// the sentence in the system dialog is the app's and not the caller's: the page can choose
// WHICH verb, never what the dialog says.

import http from 'node:http';

import { fail, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { sameOrigin } from './auth.ts';
import type { Ctx } from './context.ts';
import { announce, depositRoute, guarded, refusal } from './wallet.ts';
import type { IntentsReceiveToken } from './wallet.ts';
import { currentSymbol, receiveNetworkOf } from '../rails/intents-address.ts';
import { mnemonicProblem, normaliseMnemonic, walletFromMnemonic } from '../keystore/derive.ts';
import type { EnclaveRef } from '../keystore/store.ts';
import type { VaultResult } from '../vault/relay.ts';
import { checkPhrase, forgetPhrase, rememberPhrase } from '../vault/phrase-proof.ts';
import {
  ADDRESS_REASON,
  CREATE_REASON,
  FORGET_REASON,
  MIGRATE_REASON,
  RESTORE_REASON,
  REVEAL_REASON,
  UNLOCK_REASON,
} from '../vault/reason.ts';

/* Set when an unwrap failed inside the enclave itself (not a cancel, not a timeout): the key
   blob in this file was not made by this Mac's enclave, which is what a wallet file carried over
   by Migration Assistant looks like. The window offers Restore instead of a Touch ID that will
   never work. Cleared by anything that writes a new file. */
let foreign = false;

// ---------- the relay's two routes ----------

/* The relay's own gate: same origin, and the relay secret rather than the window token. The
   page holds the token and must not be able to stand where the shell stands; the shell holds
   this and nothing the page can read. A refusal is audited like every other knock. */
async function relayGuarded(ctx: Ctx, route: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<JsonBody | null> {
  const parsed = await readBody(req);
  if (!parsed.ok) {
    fail(res, parsed.status, parsed.error);
    return null;
  }
  const body = parsed.value;
  const reason = !sameOrigin(req) ? 'cross-origin request' : !ctx.vault.authenticate(body.relay) ? 'the relay secret is missing or wrong' : null;
  if (reason !== null) {
    ctx.audit.append('approve_attempt_rejected', `POST ${route} rejected: ${reason}`, { route, reason, origin: req.headers.origin ?? '(absent)' });
    fail(res, 403, reason);
    return null;
  }
  return body;
}

export async function handleVaultPending(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await relayGuarded(ctx, '/api/vault/pending', req, res);
  if (body === null) return;
  const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? body.waitMs : 0;
  const request = await ctx.vault.next(waitMs);
  sendJson(res, 200, { request });
}

export async function handleVaultAnswer(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await relayGuarded(ctx, '/api/vault/answer', req, res);
  if (body === null) return;
  const taken = ctx.vault.answer(body);
  if (!taken.ok) return fail(res, 409, taken.error);
  sendJson(res, 200, { ok: true });
}

// ---------- what the window reads ----------

export function vaultStatus(ctx: Ctx): JsonBody {
  const prefs = ctx.vaultPrefs.get();
  const enclave = ctx.keystore.enclave();
  return {
    custody: ctx.keystore.custody(),
    state: ctx.keystore.state(),
    enclave: {
      attached: ctx.vault.attached(),
      ready: ctx.vault.enclaveReady(),
      capability: ctx.vault.capability(),
      keyMadeAt: enclave?.createdAt ?? null,
      // A device-bound blob on every build so far, Developer ID included: the keychain home needs
      // the keychain-access-groups entitlement, which no build carries yet. A key made by a build
      // that has it lives in the keychain, bound to Phosphor's signature. The window says which.
      binding: enclave === null ? null : enclave.keyBlob.startsWith('keychain:') ? 'app' : 'device',
    },
    foreign,
    waiting: ctx.vault.waiting(),
    backedUp: prefs.backedUp,
    backedUpAt: prefs.backedUpAt,
    idleMinutes: prefs.idleMinutes,
    hasMnemonic: ctx.keystore.header()?.hasMnemonic ?? false,
  };
}

export function handleVaultStatus(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, vaultStatus(ctx));
}

// ---------- the enclave verbs ----------

function enclaveRefusal(result: Extract<VaultResult, { ok: false }>): JsonBody {
  const code = result.error === 'user_cancel' ? 'user_cancel' : result.error === 'no_relay' || result.error === 'helper_missing' ? 'enclave_unavailable' : result.error;
  const known = refusal(code);
  return known.code === code && known.error !== 'That did not work.' ? known : { ok: false, error: result.message, code };
}

/* A fresh enclave key. No dialog: making a key needs no presence. */
async function newEnclaveKey(ctx: Ctx): Promise<{ key: EnclaveRef } | { refused: JsonBody }> {
  if (!ctx.vault.enclaveReady()) return { refused: refusal('enclave_unavailable') };
  const made = await ctx.vault.ask({ op: 'create' });
  if (!made.ok) return { refused: enclaveRefusal(made) };
  if (made.op !== 'create') return { refused: { ok: false, error: 'the enclave answered the wrong thing', code: 'garbled' } };
  return { key: made.enclave };
}

/* One Touch ID with the given reason, and the data key it releases. What the key is then used
   for is the caller's: an unlock opens the wallet with it, and every other verb reads with it
   and leaves the lock where it was (Keystore.readWithDataKey). */
async function unwrapThroughEnclave(ctx: Ctx, reason: string): Promise<{ dek: Buffer } | { refused: JsonBody }> {
  const request = ctx.keystore.enclaveRequest();
  if (request === null) return { refused: refusal('no_wallet') };
  const answer = await ctx.vault.ask({ op: 'unwrap', reason, ...request });
  if (!answer.ok) {
    if (answer.error === 'foreign_key') {
      foreign = true;
      return { refused: refusal('foreign') };
    }
    // The enclave loaded its key and the wrap still did not open: the file's header or wrap was
    // edited or damaged on this Mac. Restore from the phrase is the way back, and the sentence
    // says so; it is a different sentence from the other Mac's file.
    if (answer.error === 'crypto_failed') return { refused: refusal('damaged') };
    return { refused: enclaveRefusal(answer) };
  }
  if (answer.op !== 'unwrap') return { refused: { ok: false, error: 'the enclave answered the wrong thing', code: 'garbled' } };
  foreign = false;
  return { dek: answer.dek };
}

/* Lock, then open through the enclave with the given reason. The one way a version 2 wallet
   opens, and the way every verb below proves the file it just wrote can be opened again. */
async function openThroughEnclave(ctx: Ctx, reason: string): Promise<JsonBody> {
  const got = await unwrapThroughEnclave(ctx, reason);
  if ('refused' in got) return got.refused;
  const opened = ctx.keystore.unlockWithDataKey(got.dek);
  if (!opened.ok) return refusal(opened.error, opened.retryInSec);
  return { ok: true };
}

/* Create, enclave style: one click brought the person here, one Touch ID proves the wallet the
   enclave just wrapped can be opened by it, and only then is it reported as made. The phrase
   is not returned: it is revealed later, behind its own Touch ID, and proven by typing three
   words back. */
export async function handleVaultCreate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/create', req, res);
  if (body === null) return;
  if (ctx.keystore.state() !== 'no_wallet') return fail(res, 409, 'this app already holds a wallet');
  const fresh = await newEnclaveKey(ctx);
  if ('refused' in fresh) return sendJson(res, 200, fresh.refused);
  let made: { addresses: unknown };
  try {
    made = ctx.keystore.createWithEnclave(fresh.key);
  } catch (err) {
    return fail(res, 409, err instanceof Error ? err.message : String(err));
  }
  ctx.keystore.lock();
  const proven = await openThroughEnclave(ctx, CREATE_REASON);
  if (proven.ok !== true) {
    /* The enclave would not open what it just wrapped, or the person cancelled. Either way a
       wallet nobody can open must not exist: it is shredded, and the person starts again. */
    ctx.keystore.forget();
    ctx.audit.append('app_start', 'a new enclave wallet was discarded: the first Touch ID did not open it', { code: proven.code });
    announce(ctx);
    return sendJson(res, 200, proven);
  }
  ctx.vaultPrefs.clearBackedUp();
  ctx.audit.append('app_start', 'a new wallet was created behind the Secure Enclave', { evm: (made.addresses as { evm?: string }).evm });
  ctx.session.touch();
  announce(ctx);
  sendJson(res, 200, { ok: true, addresses: made.addresses, custody: 'secure-enclave' });
}

/* The enclave unlock. `reason` picks between the two sentences the app owns for it; nothing
   the caller sends reaches the dialog. Queued proposals are released the way a password unlock
   releases them, under releaseQueued's own rules. */
export async function handleVaultUnlock(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/unlock', req, res);
  if (body === null) return;
  if (ctx.keystore.custody() !== 'secure-enclave') return sendJson(res, 200, refusal('wrong_password'));
  /* "Show your deposit address" does what it says and nothing more. The touch's data key reads
     the payload once and is wiped (Keystore.readWithDataKey): the addresses come out derived and
     verified, which is what the card needed, and the wallet stays exactly as it was, so no session
     starts, no plan re-arms and nothing queued is released. It used to open the wallet and lock it
     again, and the open had already reached every listener: a locked plan re-armed and its runner
     took the trading key for a fresh session before the lock. A dialog that named less than the
     touch did would be the one dishonest sentence in the product. */
  if (body.purpose === 'address') {
    const got = await unwrapThroughEnclave(ctx, ADDRESS_REASON);
    if ('refused' in got) return sendJson(res, 200, got.refused);
    const read = ctx.keystore.readWithDataKey(got.dek, () => true);
    if (!read.ok) return sendJson(res, 200, refusal(read.error, read.retryInSec));
    ctx.audit.append('app_start', 'the addresses were verified with Touch ID; the wallet stays as it was', { purpose: 'address' });
    announce(ctx);
    return sendJson(res, 200, { ok: true, released: 0, verified: true });
  }
  const opened = await openThroughEnclave(ctx, UNLOCK_REASON);
  if (opened.ok !== true) return sendJson(res, 200, opened);
  ctx.audit.append('app_start', 'the wallet was opened with Touch ID', { purpose: 'unlock' });
  ctx.session.touch();
  announce(ctx);
  const released = await ctx.releaseQueued();
  sendJson(res, 200, { ok: true, released });
}

/* The recovery phrase, behind its own Touch ID every time, open wallet or not. Returned once,
   in this response, to the window that asked. No nonce and no second GET: the touch that just
   happened is the proof. The touch reads the phrase and opens nothing: a wallet that was locked
   stays locked (Keystore.readWithDataKey). It used to stay open for signing until the idle lock,
   unannounced, on a dialog that named only the reveal. */
export async function handleVaultReveal(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/reveal', req, res);
  if (body === null) return;
  if (ctx.keystore.custody() !== 'secure-enclave') return sendJson(res, 200, refusal('wrong_password'));
  const got = await unwrapThroughEnclave(ctx, REVEAL_REASON);
  if ('refused' in got) return sendJson(res, 200, got.refused);
  const read = ctx.keystore.readWithDataKey(got.dek, (payload) => (typeof payload.mnemonic === 'string' ? payload.mnemonic : null));
  if (!read.ok) return sendJson(res, 200, refusal(read.error, read.retryInSec));
  if (read.value === null) return sendJson(res, 200, refusal('no_mnemonic'));
  const words = read.value.split(' ');
  const wallet = ctx.keystore.addresses().evm;
  const prove = wallet === null ? [] : rememberPhrase(words, wallet, ctx.keystore.kdfParams());
  ctx.audit.append('app_start', 'the recovery phrase was revealed in the window after a Touch ID; the wallet stays as it was', {});
  ctx.session.touch();
  sendJson(res, 200, {
    ok: true,
    words,
    // Stated beside the words so a person checking them in another wallet knows where to look.
    paths: { evm: "m/44'/60'/0'/0/0" },
    // The three positions Prove it asks for (src/vault/phrase-proof.ts).
    prove,
  });
}

/* Backed up means proven: three words, by position, typed back, checked against what the last
   reveal of this wallet left behind (src/vault/phrase-proof.ts), never echoed. It used to read the
   phrase off the open wallet, which is why a reveal had to leave the wallet open. Wrong words
   clear nothing and reveal nothing about which was wrong. */
export async function handleVaultBackupProven(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/backup-proven', req, res);
  if (body === null) return;
  const raw = Array.isArray(body.words) ? (body.words as unknown[]) : [];
  const answers = raw.filter((a): a is { index: number; word: string } => {
    if (typeof a !== 'object' || a === null) return false;
    const { index, word } = a as { index?: unknown; word?: unknown };
    return typeof index === 'number' && typeof word === 'string';
  });
  const checked = raw.length < 3 || answers.length !== raw.length ? 'mismatch' : await checkPhrase(answers, ctx.keystore.addresses().evm);
  if (checked === 'none') {
    return sendJson(res, 200, { ok: false, error: 'Show your words once more with Back it up, then type three of them back.', code: 'reveal_again' });
  }
  if (checked === 'mismatch') {
    return sendJson(res, 200, { ok: false, error: 'Those words do not match. Look again.', code: 'wrong_words' });
  }
  forgetPhrase();
  const prefs = ctx.vaultPrefs.markBackedUp();
  ctx.audit.append('app_start', 'the recovery phrase was proven backed up: three words typed back', {});
  announce(ctx);
  sendJson(res, 200, { ok: true, backedUpAt: prefs.backedUpAt });
}

/* Restore from a phrase, behind the enclave. Refused only when all three are true: the wallet
   here is not proven backed up, the phrase derives different addresses, and this Mac can still
   open the file. Any one of them false means nothing is lost by replacing the file. */
export async function handleVaultRestore(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/restore', req, res);
  if (body === null) return;
  const raw = typeof body.mnemonic === 'string' ? body.mnemonic : '';
  const problem = mnemonicProblem(raw);
  if (problem !== null) return sendJson(res, 200, { ok: false, error: problem, code: 'bad_phrase' });
  const phrase = normaliseMnemonic(raw);

  if (ctx.keystore.state() !== 'no_wallet') {
    const incoming = walletFromMnemonic(phrase).addresses;
    const current = ctx.keystore.addressReport().addresses;
    const same = current.evm !== null && current.evm.toLowerCase() === incoming.evm.toLowerCase();
    const openable = ctx.keystore.custody() === 'secure-enclave' && !foreign;
    if (!ctx.vaultPrefs.get().backedUp && !same && openable) return sendJson(res, 200, refusal('not_backed_up'));
  }

  const fresh = await newEnclaveKey(ctx);
  if ('refused' in fresh) return sendJson(res, 200, fresh.refused);
  if (ctx.keystore.state() !== 'no_wallet') ctx.keystore.forget();
  let restored: { addresses: unknown };
  try {
    restored = ctx.keystore.importWithEnclave(fresh.key, { mnemonic: phrase });
  } catch (err) {
    return fail(res, 409, err instanceof Error ? err.message : String(err));
  }
  ctx.keystore.lock();
  const proven = await openThroughEnclave(ctx, RESTORE_REASON);
  if (proven.ok !== true) {
    ctx.keystore.forget();
    announce(ctx);
    return sendJson(res, 200, proven);
  }
  foreign = false;
  // A phrase the person just typed from their own record is, by that act, backed up.
  ctx.vaultPrefs.markBackedUp();
  ctx.audit.append('app_start', 'a wallet was restored from its recovery phrase behind the Secure Enclave', { evm: (restored.addresses as { evm?: string }).evm });
  ctx.session.touch();
  announce(ctx);
  sendJson(res, 200, { ok: true, addresses: restored.addresses, custody: 'secure-enclave' });
}

/* A password wallet moves behind the enclave. The password opens it once; a fresh enclave key
   wraps a fresh data key; the file is rewritten; a Touch ID proves the rewrite opens. If that
   last step fails the old file is already gone, so the rewrite is verified BEFORE the password
   wrap is dropped: rewrapToEnclave writes atomically, and a failed proof here puts nothing at
   risk that a restore from the phrase would not recover. The audit line says which happened. */
export async function handleVaultMigrate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/migrate', req, res);
  if (body === null) return;
  if (ctx.keystore.custody() !== 'software' || ctx.keystore.state() === 'needs_migration') {
    return sendJson(res, 200, { ok: false, error: 'Only an encrypted password wallet can move behind the enclave.', code: 'not_password' });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const verified = await ctx.keystore.verify(password);
  if (!verified.ok) return sendJson(res, 200, refusal(verified.error, verified.retryInSec));
  const fresh = await newEnclaveKey(ctx);
  if ('refused' in fresh) return sendJson(res, 200, fresh.refused);
  const moved = await ctx.keystore.rewrapToEnclave(password, fresh.key);
  if (!moved.ok) return sendJson(res, 200, refusal(moved.error, moved.retryInSec));
  ctx.keystore.lock();
  const proven = await openThroughEnclave(ctx, MIGRATE_REASON);
  if (proven.ok !== true) {
    ctx.audit.append('app_start', 'the wallet moved behind the enclave but the proving Touch ID did not complete; the file is enclave-wrapped and will open on the next Touch ID', { code: proven.code });
    announce(ctx);
    return sendJson(res, 200, { ...proven, moved: true });
  }
  ctx.audit.append('app_start', 'the wallet moved behind the Secure Enclave; the password wrap is gone', {});
  ctx.session.touch();
  announce(ctx);
  sendJson(res, 200, { ok: true, custody: 'secure-enclave' });
}

/* Forget: typed confirmation, proven backup, a Touch ID, then the file is shredded. */
export async function handleVaultForget(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/forget', req, res);
  if (body === null) return;
  if (body.confirm !== 'FORGET') return fail(res, 400, 'type FORGET to confirm');
  if (ctx.keystore.state() === 'no_wallet') return sendJson(res, 200, refusal('no_wallet'));
  if (!ctx.vaultPrefs.get().backedUp && !foreign) return sendJson(res, 200, refusal('not_backed_up'));
  if (ctx.vault.enclaveReady()) {
    const present = await ctx.vault.ask({ op: 'presence', reason: FORGET_REASON });
    if (!present.ok) return sendJson(res, 200, enclaveRefusal(present));
  }
  let gone: { destroyed: string };
  try {
    gone = ctx.keystore.forget();
  } catch (err) {
    return fail(res, 409, err instanceof Error ? err.message : String(err));
  }
  foreign = false;
  ctx.vaultPrefs.clearBackedUp();
  ctx.audit.append('app_start', 'the wallet on this Mac was forgotten: the key file was shredded', { file: gone.destroyed });
  announce(ctx);
  sendJson(res, 200, { ok: true });
}

export async function handleVaultPrefs(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/prefs', req, res);
  if (body === null) return;
  try {
    if (typeof body.idleMinutes === 'number') ctx.vaultPrefs.setIdleMinutes(body.idleMinutes);
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : String(err));
  }
  ctx.sse.broadcastState();
  sendJson(res, 200, { ok: true, ...ctx.vaultPrefs.get() });
}

// ---------- the deposit card ----------

/* The address the watcher carries is the bridge's, read here from the bridge for this wallet's
   account, never taken from the body: the window asks for a chain and an asset and gets back
   what the app resolved, so nothing that holds the window token can make the card show an
   address the app did not derive. */
/* One network and one asset as the report resolves them, and the route for that exact asset: the
   question both doors below ask before an address may be on screen. A refusal is the status and
   the sentence; a closed route's refusal carries `route` and the status page, so the window can
   draw Paused rather than a bare error. */
type Resolved =
  | { ok: false; status: number; error: string; extra?: JsonBody }
  | { ok: true; chain: string; want: string; address: string; accepted: IntentsReceiveToken; notice: string | null; statusLink: string | null };

async function resolveDeposit(ctx: Ctx, chainRaw: unknown, symbolRaw: unknown): Promise<Resolved> {
  // Any network the registry knows, by its short id. The report below is what says whether the
  // bridge answered for it.
  const chain = typeof chainRaw === 'string' && receiveNetworkOf(chainRaw) !== undefined ? chainRaw : null;
  const symbol = typeof symbolRaw === 'string' ? symbolRaw.trim().toUpperCase() : '';
  if (chain === null || symbol === '' || symbol.length > 12) return { ok: false, status: 400, error: 'chain and symbol are required' };
  const report = await ctx.intentsReceive();
  const network = report.networks.find((n) => n.id === chain);
  if (report.account === null || network === undefined || network.address === null) {
    const closed = network?.route === 'closed' ? { route: 'closed', statusLink: network.statusLink } : undefined;
    return { ok: false, status: 409, error: network?.unavailable ?? report.reason ?? `no deposit address for ${chain} right now`, ...(closed === undefined ? {} : { extra: closed }) };
  }
  const want = currentSymbol(chain, symbol);
  const accepted = network.accepts.find((a) => a.symbol.toUpperCase() === want);
  if (accepted === undefined) {
    return { ok: false, status: 409, error: `${symbol} is not credited on ${network.name}; accepted: ${network.accepts.map((a) => a.symbol).join(', ') || 'nothing'}` };
  }
  // The route for this exact asset, the same question the agent's deposit tool asks first.
  const route = await depositRoute(ctx, chain, report.account, accepted.assetId);
  if (route.closed !== null) return { ok: false, status: 409, error: route.closed, extra: { route: 'closed', statusLink: route.link } };
  const notice = route.notice ?? network.notice;
  return { ok: true, chain, want, address: network.address, accepted, notice, statusLink: notice === null ? null : (route.link ?? network.statusLink) };
}

export async function handleDepositShow(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/deposit/show', req, res);
  if (body === null) return;
  const got = await resolveDeposit(ctx, body.chain, body.symbol);
  if (!got.ok) return fail(res, got.status, got.error, got.extra);
  // The token as the bridge lists it, so the watch reads that one balance and matches the
  // bridge's own rows for it, instead of guessing from the symbol.
  const { accepted } = got;
  const token = { assetId: accepted.assetId, decimals: accepted.decimals, contract: accepted.contract };
  sendJson(res, 200, { ok: true, deposit: ctx.deposits.show(got.chain, got.want, got.address, token), ...(got.notice === null ? {} : { notice: got.notice, statusLink: got.statusLink }) });
}

/* Whether an address may be drawn for this network and this asset right now, asked by the window
   before it draws one: the report's row was asked about the network's own coin, and TON USDT is
   its own question. Read only, no watch started; the same refusal /api/deposit/show would give. */
export async function handleDepositRoute(ctx: Ctx, url: URL, res: http.ServerResponse): Promise<void> {
  const got = await resolveDeposit(ctx, url.searchParams.get('chain'), url.searchParams.get('symbol'));
  if (!got.ok) return fail(res, got.status, got.error, got.extra);
  sendJson(res, 200, { ok: true, chain: got.chain, symbol: got.want, notice: got.notice, statusLink: got.statusLink });
}

export function handleDepositStatus(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, { deposit: ctx.deposits.current() });
}

export async function handleDepositStop(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/deposit/stop', req, res);
  if (body === null) return;
  ctx.deposits.stop();
  sendJson(res, 200, { ok: true });
}
