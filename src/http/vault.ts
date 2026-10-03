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

import { errText, fail, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { sameOrigin } from './auth.ts';
import type { Ctx } from './context.ts';
import { announce, depositRoute, guarded, refusal } from './wallet.ts';
import type { IntentsReceiveToken } from './wallet.ts';
import { afterBoundOpen, bindWallet, enclaveRefusal, newEnclaveKey, openableHere, proveAndInstall, settleFor, sweepSoon } from './custody.ts';
import { currentSymbol, receiveNetworkOf } from '../rails/intents-address.ts';
import { mnemonicProblem, normaliseMnemonic, walletFromMnemonic } from '../keystore/derive.ts';
import type { StagedFile } from '../keystore/store.ts';
import { custodyLock } from '../vault/custody-lock.ts';
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
      // 'device': a blob any process on this Mac can load behind its own dialog, which every
      // wallet made before the keychain home is. 'app': a key in Phosphor's keychain home, which
      // only Phosphor's signed vault service can reach, made by create or by POST /api/vault/bind.
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

/* What a custody step answers: a body for the window, or an HTTP refusal. Built inside the custody
   lock, sent after it. */
type Reply = { json: JsonBody } | { fail: number; error: string };

function reply(res: http.ServerResponse, r: Reply): void {
  if ('fail' in r) fail(res, r.fail, r.error);
  else sendJson(res, 200, r.json);
}

/* One Touch ID with the given reason, and what `use` makes of the data key it releases, all under
   the custody lock (src/vault/custody-lock.ts): the file the enclave was asked about is the file
   `use` opens, and no bind replaces it in between. A staged file a crash left is settled first
   (src/http/custody.ts), so the touch is asked about the file really in place. What the key is
   used for is the caller's: an unlock opens the wallet with it, and every other verb reads with it
   and leaves the lock where it was (Keystore.readWithDataKey). */
async function unwrapThroughEnclave<T extends { ok: boolean }>(ctx: Ctx, reason: string, use: (dek: Buffer) => T): Promise<{ value: T } | { refused: JsonBody }> {
  return custodyLock(ctx.keystore).run(async () => {
    await settleFor(ctx);
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
    const value = use(answer.dek);
    if (value.ok) afterBoundOpen(ctx, request.keyBlob);
    return { value };
  });
}

/* Open through the enclave with the given reason: the one way a version 2 wallet opens. */
async function openThroughEnclave(ctx: Ctx, reason: string): Promise<JsonBody> {
  const got = await unwrapThroughEnclave(ctx, reason, (dek) => ctx.keystore.unlockWithDataKey(dek));
  if ('refused' in got) return got.refused;
  if (!got.value.ok) return refusal(got.value.error, got.value.retryInSec);
  return { ok: true };
}

/* Create, enclave style: one click brought the person here, one Touch ID proves the enclave opens
   the wallet it just wrapped, the wallet is committed to its key on a build with a keychain home,
   and only then is it written in place and reported as made (src/http/custody.ts). The phrase is
   not returned: it is revealed later, behind its own Touch ID, and proven by typing three words
   back. */
export async function handleVaultCreate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/create', req, res);
  if (body === null) return;
  reply(
    res,
    await custodyLock(ctx.keystore).run(async (): Promise<Reply> => {
      if ((await settleFor(ctx)) === 'undecided') return { json: refusal('keychain_unavailable') };
      if (ctx.keystore.state() !== 'no_wallet') return { fail: 409, error: 'this app already holds a wallet' };
      const fresh = await newEnclaveKey(ctx);
      if ('refused' in fresh) return { json: fresh.refused };
      let staged: StagedFile;
      try {
        staged = ctx.keystore.stageNew(fresh.key);
      } catch (err) {
        return { fail: 409, error: errText(err) };
      }
      const made = await proveAndInstall(ctx, staged, CREATE_REASON, 'open');
      if ('refused' in made) {
        /* The enclave would not open what it just wrapped, the person cancelled, or the commit did
           not land. A wallet nobody can open must not exist, and none does: the staged file is
           shredded, no live file was written, and the person starts again. */
        const pending = made.refused.code === 'install_pending';
        ctx.audit.append(
          'app_start',
          pending ? 'a new enclave wallet was made and committed; its file is put in place at the next start' : 'a new enclave wallet was discarded: the first Touch ID did not open it',
          { code: made.refused.code },
        );
        announce(ctx);
        return { json: made.refused };
      }
      ctx.vaultPrefs.clearBackedUp();
      ctx.audit.append('app_start', 'a new wallet was created behind the Secure Enclave', { evm: staged.addresses.evm });
      ctx.session.touch();
      announce(ctx);
      sweepSoon(ctx);
      return { json: { ok: true, addresses: staged.addresses, custody: 'secure-enclave' } };
    }),
  );
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
    const got = await unwrapThroughEnclave(ctx, ADDRESS_REASON, (dek) => ctx.keystore.readWithDataKey(dek, () => true));
    if ('refused' in got) return sendJson(res, 200, got.refused);
    const read = got.value;
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
  const got = await unwrapThroughEnclave(ctx, REVEAL_REASON, (dek) => ctx.keystore.readWithDataKey(dek, (payload) => (typeof payload.mnemonic === 'string' ? payload.mnemonic : null)));
  if ('refused' in got) return sendJson(res, 200, got.refused);
  const read = got.value;
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
   open the file. Any one of them false means nothing is lost by replacing the file. "Can still
   open" asks the service: a file it refuses before any Touch ID (an older device-bound copy on a
   Mac that has bound a wallet, a file that is not the committed one) opens nothing here.
   The restored wallet is staged, proven and committed before it replaces the file in place, so a
   cancelled touch leaves the wallet that was here exactly as it was. */
export async function handleVaultRestore(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/restore', req, res);
  if (body === null) return;
  const raw = typeof body.mnemonic === 'string' ? body.mnemonic : '';
  const problem = mnemonicProblem(raw);
  if (problem !== null) return sendJson(res, 200, { ok: false, error: problem, code: 'bad_phrase' });
  const phrase = normaliseMnemonic(raw);

  reply(
    res,
    await custodyLock(ctx.keystore).run(async (): Promise<Reply> => {
      if ((await settleFor(ctx)) === 'undecided') return { json: refusal('keychain_unavailable') };
      if (ctx.keystore.state() !== 'no_wallet') {
        const incoming = walletFromMnemonic(phrase).addresses;
        const current = ctx.keystore.addressReport().addresses;
        const same = current.evm !== null && current.evm.toLowerCase() === incoming.evm.toLowerCase();
        const openable = ctx.keystore.custody() === 'secure-enclave' && !foreign && (await openableHere(ctx));
        if (!ctx.vaultPrefs.get().backedUp && !same && openable) return { json: refusal('not_backed_up') };
      }

      const fresh = await newEnclaveKey(ctx);
      if ('refused' in fresh) return { json: fresh.refused };
      let staged: StagedFile;
      try {
        staged = ctx.keystore.stageImport(fresh.key, { mnemonic: phrase });
      } catch (err) {
        return { fail: 409, error: errText(err) };
      }
      const restored = await proveAndInstall(ctx, staged, RESTORE_REASON, 'open');
      if ('refused' in restored) {
        announce(ctx);
        return { json: restored.refused };
      }
      foreign = false;
      // A phrase the person just typed from their own record is, by that act, backed up.
      ctx.vaultPrefs.markBackedUp();
      ctx.audit.append('app_start', 'a wallet was restored from its recovery phrase behind the Secure Enclave', { evm: staged.addresses.evm });
      ctx.session.touch();
      announce(ctx);
      sweepSoon(ctx);
      return { json: { ok: true, addresses: staged.addresses, custody: 'secure-enclave' } };
    }),
  );
}

/* A password wallet moves behind the enclave. The password opens it once; a fresh enclave key
   wraps a fresh data key into the staged file; a Touch ID proves the enclave opens it; on a build
   with a keychain home it is committed; and only then does it replace the password file. Every
   failure before that leaves the password file exactly as it was, and says so. Rewriting in place
   first would leave, on a failed commit, a file that stops opening ten minutes later on any Mac
   that holds a marker, with the password wrap already gone. */
export async function handleVaultMigrate(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/migrate', req, res);
  if (body === null) return;
  const password = typeof body.password === 'string' ? body.password : '';
  reply(
    res,
    await custodyLock(ctx.keystore).run(async (): Promise<Reply> => {
      if ((await settleFor(ctx)) === 'undecided') return { json: refusal('keychain_unavailable') };
      if (ctx.keystore.custody() !== 'software' || ctx.keystore.state() === 'needs_migration') {
        return { json: { ok: false, error: 'Only an encrypted password wallet can move behind the enclave.', code: 'not_password' } };
      }
      const verified = await ctx.keystore.verify(password);
      if (!verified.ok) return { json: refusal(verified.error, verified.retryInSec) };
      const fresh = await newEnclaveKey(ctx);
      if ('refused' in fresh) return { json: fresh.refused };
      const staged = await ctx.keystore.stageFromPassword(password, fresh.key);
      if (!staged.ok) return { json: refusal(staged.error, staged.retryInSec) };
      const moved = await proveAndInstall(ctx, staged.staged, MIGRATE_REASON, 'open');
      if ('refused' in moved) {
        ctx.audit.append('app_start', 'the wallet did not move behind the enclave: the proving Touch ID did not complete, and the password file is unchanged', { code: moved.refused.code });
        announce(ctx);
        return { json: moved.refused };
      }
      ctx.audit.append('app_start', 'the wallet moved behind the Secure Enclave; the password wrap is gone', {});
      ctx.session.touch();
      announce(ctx);
      sweepSoon(ctx);
      return { json: { ok: true, custody: 'secure-enclave' } };
    }),
  );
}

/* Bind: a wallet whose key is a device-bound blob moves into Phosphor's keychain home, with one
   Touch ID (src/http/custody.ts, bindWallet). Window only, never an MCP op. */
export async function handleVaultBind(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/bind', req, res);
  if (body === null) return;
  sendJson(res, 200, await bindWallet(ctx, () => ctx.vaultPrefs.get().backedUp));
}

/* Forget: typed confirmation, proven backup, a Touch ID, then the file is shredded, and a staged
   file beside it with it. */
export async function handleVaultForget(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/forget', req, res);
  if (body === null) return;
  if (body.confirm !== 'FORGET') return fail(res, 400, 'type FORGET to confirm');
  reply(
    res,
    await custodyLock(ctx.keystore).run(async (): Promise<Reply> => {
      await settleFor(ctx);
      if (ctx.keystore.state() === 'no_wallet') return { json: refusal('no_wallet') };
      if (!ctx.vaultPrefs.get().backedUp && !foreign) return { json: refusal('not_backed_up') };
      if (ctx.vault.enclaveReady()) {
        const present = await ctx.vault.ask({ op: 'presence', reason: FORGET_REASON });
        if (!present.ok) return { json: enclaveRefusal(present) };
      }
      let gone: { destroyed: string };
      try {
        gone = ctx.keystore.forget();
      } catch (err) {
        return { fail: 409, error: errText(err) };
      }
      ctx.keystore.dropStaged();
      foreign = false;
      ctx.vaultPrefs.clearBackedUp();
      ctx.audit.append('app_start', 'the wallet on this Mac was forgotten: the key file was shredded', { file: gone.destroyed });
      announce(ctx);
      return { json: { ok: true } };
    }),
  );
}

export async function handleVaultPrefs(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/prefs', req, res);
  if (body === null) return;
  try {
    if (typeof body.idleMinutes === 'number') ctx.vaultPrefs.setIdleMinutes(body.idleMinutes);
  } catch (err) {
    return fail(res, 400, errText(err));
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
