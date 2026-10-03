// Custody on this Mac: how a new version 2 key file is written, proven and put in place, how a
// device-bound wallet is bound to Phosphor, and how a crash in the middle of either is finished.
//
// ONE SHAPE FOR EVERY NEW FILE. Create, restore, the move from a password and the bind all write
// the new file to the staged path (keys.enc.json.bind) and leave the live file alone. The enclave
// is asked to open exactly the bytes written (the one Touch ID), the file is committed on a build
// with a keychain home (the service's marker holds its pin), and only then do the bytes replace
// the live file, in one rename. The proof and the commit are built from the bytes this process
// holds and never from a read of the disk: a file swapped in between is not what gets proven or
// pinned. Until the rename the live file is the old one, whole, and a failed step changes nothing.
//
// WHAT A CRASH LEAVES, and the rule for each (settleStaged). It is asked again at the start of
// every custody step and once the shell's first probe answers, by the service's answer about the
// staged file (status, no dialog) and nothing else:
// - staged, not committed: no marker holds its pin. It is shredded. The live file is untouched and
//   opens as before; the key the staged file was wrapped to is swept once it is past its minutes.
// - committed, not renamed: the marker for its key holds its pin. It is put in place, and the open
//   that found it goes on with it: a device-bound file is refused on a Mac that holds a marker.
// - renamed: no staged file, or one equal to the live file byte for byte, which is removed. The
//   first open of the bound file goes through the pin check like every open after it.
// No answer (no shell, a keychain the service cannot read) means nothing is touched, and nothing
// that would write the staged path again runs until there is one. A build with no keychain home
// can commit nothing, so it leaves a staged file where it is and may write over it.

import fs from 'node:fs';
import path from 'node:path';

import type { JsonBody } from './respond.ts';
import type { Ctx } from './context.ts';
import { announce, refusal } from './wallet.ts';
import type { Audit } from '../audit.ts';
import type { EnclaveRef, Keystore, StagedFile } from '../keystore/store.ts';
import { shredFile } from '../keystore/store.ts';
import type { VaultRelay, VaultResult } from '../vault/relay.ts';
import { custodyLock } from '../vault/custody-lock.ts';
import { BIND_REASON } from '../vault/reason.ts';

export function enclaveRefusal(result: Extract<VaultResult, { ok: false }>): JsonBody {
  const code = result.error === 'user_cancel' ? 'user_cancel' : result.error === 'no_relay' || result.error === 'helper_missing' ? 'enclave_unavailable' : result.error;
  const known = refusal(code);
  return known.code === code && known.error !== 'That did not work.' ? known : { ok: false, error: result.message, code };
}

/* A fresh enclave key. No dialog: making a key needs no presence. */
export async function newEnclaveKey(ctx: Pick<Ctx, 'vault'>): Promise<{ key: EnclaveRef } | { refused: JsonBody }> {
  if (!ctx.vault.enclaveReady()) return { refused: refusal('enclave_unavailable') };
  const made = await ctx.vault.ask({ op: 'create' });
  if (!made.ok) return { refused: enclaveRefusal(made) };
  if (made.op !== 'create') return { refused: { ok: false, error: 'the enclave answered the wrong thing', code: 'garbled' } };
  return { key: made.enclave };
}

const keychainHome = (vault: VaultRelay): boolean => vault.capability()?.keychainHome === true;

// ---------- what a crash left ----------

export type Settled = 'none' | 'dropped' | 'installed' | 'undecided' | 'kept' | 'unreadable';

type SettleDeps = { keystore: Keystore; vault: VaultRelay; audit: Audit; announce?: () => void };

/* Run with the custody lock held. 'undecided' is the one answer that must stop a new staged file
   from being written: the one on disk may be the only file that opens. */
export async function settleStaged(deps: SettleDeps): Promise<Settled> {
  const found = deps.keystore.stagedOnDisk();
  if (found === null) return 'none';
  // Never delete what cannot be read. It cannot be a committed file this app could put in place.
  if (found === 'unreadable') return 'unreadable';
  if (found.installed) {
    deps.keystore.dropStaged();
    return 'dropped';
  }
  if (!keychainHome(deps.vault)) return 'kept';
  const asked = deps.vault.attached() ? await deps.vault.ask({ op: 'status', ...found.staged.request }) : null;
  if (asked === null || !asked.ok || asked.op !== 'status' || !asked.status.keychainHome) return 'undecided';
  if (asked.status.pinMatches === true) {
    const put = deps.keystore.installStaged(found.staged, null, 'keep');
    if (!put.ok) return 'undecided';
    deps.audit.append('app_start', 'a wallet file that was committed before Phosphor stopped is now in place', { finished: 'committed' });
    deps.announce?.();
    return 'installed';
  }
  deps.keystore.dropStaged();
  deps.audit.append('app_start', 'a new wallet file that was never committed was removed; the wallet file in place is untouched', { finished: 'staged' });
  deps.announce?.();
  return 'dropped';
}

export function settleFor(ctx: Ctx): Promise<Settled> {
  return settleStaged({ keystore: ctx.keystore, vault: ctx.vault, audit: ctx.audit, announce: () => announce(ctx) });
}

/* After the shell's first probe: a crashed create leaves no live file at all, so without this the
   window would offer a new wallet over one the service already committed. */
export function settleAtStart(deps: SettleDeps): void {
  if (!keychainHome(deps.vault)) return;
  void custodyLock(deps.keystore)
    .run(() => settleStaged(deps))
    .catch(() => undefined);
}

// ---------- prove, commit, put in place ----------

/* Whether the commit landed. Its answer can be lost on the way back (a relay that timed out) while
   the marker was written, so a failure asks the service what is true before anything is dropped. */
async function commitStaged(ctx: Pick<Ctx, 'vault'>, staged: StagedFile): Promise<{ landed: 'yes' | 'no' | 'unknown'; refused: JsonBody }> {
  const answer = await ctx.vault.ask({ op: 'commit', ...staged.request });
  if (answer.ok && answer.op === 'commit') return { landed: 'yes', refused: {} };
  // A code with a sentence of its own says it; anything else (a relay that timed out) is said as
  // the keychain not answering, never as the relay's own message.
  const refused = !answer.ok && refusal(answer.error).error !== 'That did not work.' ? refusal(answer.error) : refusal('keychain_unavailable');
  const asked = await ctx.vault.ask({ op: 'status', ...staged.request });
  if (!asked.ok || asked.op !== 'status' || !asked.status.keychainHome) return { landed: 'unknown', refused: refusal('keychain_unavailable') };
  return { landed: asked.status.pinMatches === true ? 'yes' : 'no', refused };
}

/* The one Touch ID on the staged bytes, the commit, the rename. Run with the custody lock held. On
   a refusal before the commit the staged file is shredded and the live file was never touched; a
   commit whose outcome is unknown leaves the staged file for settleStaged. */
export async function proveAndInstall(ctx: Ctx, staged: StagedFile, reason: string, after: 'open' | 'keep'): Promise<{ ok: true } | { refused: JsonBody }> {
  const answer = await ctx.vault.ask({ op: 'unwrap', reason, ...staged.request });
  if (!answer.ok || answer.op !== 'unwrap') {
    ctx.keystore.dropStaged();
    if (answer.ok) return { refused: refusal('garbled') };
    return { refused: answer.error === 'crypto_failed' ? refusal('damaged') : enclaveRefusal(answer) };
  }
  const dek = answer.dek;
  if (!ctx.keystore.proveStaged(staged, dek)) {
    dek.fill(0);
    ctx.keystore.dropStaged();
    return { refused: refusal('damaged') };
  }
  if (staged.request.keyBlob.startsWith('keychain:') && keychainHome(ctx.vault)) {
    const committed = await commitStaged(ctx, staged);
    if (committed.landed !== 'yes') {
      dek.fill(0);
      if (committed.landed === 'no') ctx.keystore.dropStaged();
      return { refused: committed.refused };
    }
  }
  const put = ctx.keystore.installStaged(staged, dek, after);
  // The marker is written and the staged file is the committed one: the next start puts it in place.
  if (!put.ok) return { refused: refusal('install_pending') };
  return { ok: true };
}

/* Keys no wallet uses, deleted in the background: no dialog, never a marked key, never one still
   in its first minutes, so it cannot race a create in flight (src-tauri/se-helper/main.swift). */
export function sweepSoon(ctx: Pick<Ctx, 'vault' | 'audit'>): void {
  if (!keychainHome(ctx.vault)) return;
  void ctx.vault.ask({ op: 'sweep' }).then(
    (swept) => {
      if (swept.ok && swept.op === 'sweep' && swept.deleted > 0) {
        ctx.audit.append('app_start', `${swept.deleted} vault ${swept.deleted === 1 ? 'key' : 'keys'} no wallet uses ${swept.deleted === 1 ? 'was' : 'were'} deleted from Phosphor's keychain`, { deleted: swept.deleted });
      }
    },
    () => undefined,
  );
}

// ---------- after the first open of a bound file ----------

/* The copies of the key file this app itself can leave beside it: a write cut short between its
   temp file and the rename (src/fsatomic.ts names them .<file>.<pid>.<8 hex>.tmp), for the live
   file and for the staged one. A copy made by anything else (an export the person saved, a Time
   Machine snapshot, a sync folder) is not this app's to delete; docs/security-model.md says what
   stays openable. A temp file whose process is still alive is mid-write and left alone. */
const APP_COPY = /^\.keys\.enc\.json(?:\.bind)?\.(\d+)\.[0-9a-f]{8}\.tmp$/;

function alive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function removeAppCopies(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = APP_COPY.exec(name);
    if (match === null || alive(Number(match[1]))) continue;
    try {
      if (shredFile(path.join(dir, name))) removed.push(name);
    } catch {
      // Left for the next open.
    }
  }
  return removed;
}

const tidied = new WeakSet<object>();

/* Once per start, after an open of a bound file succeeded: that open went through the pin check,
   so the bound file is proven to open the way every later open will. Only then are the app's own
   leftover copies removed, and unused keys swept. */
export function afterBoundOpen(ctx: Pick<Ctx, 'keystore' | 'vault' | 'audit'>, keyBlob: string): void {
  if (!keyBlob.startsWith('keychain:') || !keychainHome(ctx.vault) || tidied.has(ctx.keystore)) return;
  tidied.add(ctx.keystore);
  const removed = removeAppCopies(path.dirname(ctx.keystore.path()));
  if (removed.length > 0) {
    ctx.audit.append('app_start', `${removed.length} leftover ${removed.length === 1 ? 'copy' : 'copies'} of the wallet file that Phosphor wrote ${removed.length === 1 ? 'was' : 'were'} shredded after the bound file opened`, { removed: removed.length });
  }
  sweepSoon(ctx);
}

// ---------- the bind ----------

const binding = new WeakSet<object>();

/* A device-bound wallet moves into Phosphor's keychain home, with one Touch ID. The wallet must be
   open (its payload is resealed from memory under a fresh data key, so nothing in it changes) and
   its backup proven, because from the commit on, the old file and every copy of it stop opening in
   Phosphor on this Mac, and the key now lives in one keychain item. A second bind while one runs is
   refused rather than queued: it would only ever find the wallet bound, or ask a second touch the
   person did not expect. */
export async function bindWallet(ctx: Ctx, backedUp: () => boolean): Promise<JsonBody> {
  if (binding.has(ctx.keystore)) return refusal('bind_busy');
  binding.add(ctx.keystore);
  try {
    return await custodyLock(ctx.keystore).run(() => bindNow(ctx, backedUp));
  } finally {
    binding.delete(ctx.keystore);
  }
}

async function bindNow(ctx: Ctx, backedUp: () => boolean): Promise<JsonBody> {
  if ((await settleFor(ctx)) === 'undecided') return refusal('keychain_unavailable');
  if (ctx.keystore.custody() !== 'secure-enclave') return refusal('not_enclave');
  if (!ctx.vault.enclaveReady()) return refusal('enclave_unavailable');
  if (!keychainHome(ctx.vault)) return refusal('no_keychain_home');
  const live = ctx.keystore.enclaveRequest();
  if (live === null) return refusal('no_wallet');
  if (live.keyBlob.startsWith('keychain:')) {
    const asked = await ctx.vault.ask({ op: 'status', ...live });
    if (asked.ok && asked.op === 'status' && asked.status.pinMatches === true) return { ok: true, binding: 'app' };
  }
  if (!ctx.keystore.isUnlocked()) return refusal('wallet_locked');
  if (!backedUp()) return refusal('not_backed_up');
  // An approval's data key is on its way to open the live file; replacing the file under it would
  // send that move back to pending for nothing.
  if (ctx.store.list().some((p) => p.status === 'awaiting_touch')) return refusal('touch_waiting');

  const fresh = await newEnclaveKey(ctx);
  if ('refused' in fresh) return fresh.refused;
  // A build with a keychain home never makes a blob; a blob here is a build that cannot bind.
  if (!fresh.key.keyBlob.startsWith('keychain:')) return refusal('no_keychain_home');
  let staged: StagedFile;
  try {
    staged = ctx.keystore.stageRewrap(fresh.key);
  } catch {
    return refusal('wallet_locked');
  }
  const done = await proveAndInstall(ctx, staged, BIND_REASON, 'keep');
  if ('refused' in done) {
    ctx.audit.append('app_start', `the wallet was not bound to Phosphor: ${String(done.refused.code ?? 'refused')}; the wallet file in place is unchanged`, { code: done.refused.code });
    announce(ctx);
    return done.refused;
  }
  ctx.audit.append('app_start', "the wallet was bound to Phosphor on this Mac: its key now lives in Phosphor's keychain, and older copies of the wallet file no longer open in Phosphor here", {});
  ctx.session.touch();
  announce(ctx);
  sweepSoon(ctx);
  return { ok: true, binding: 'app' };
}

// ---------- the restore guard ----------

/* Whether this Mac would open the live wallet file, asked without a dialog. A file the service
   refuses before any Touch ID (a device-bound file on a Mac that has bound a wallet, a file that is
   not the one committed for its key, a key past its minutes with no marker) opens nothing here, so
   replacing it loses nothing this app could open. The same rules as the service's admit(), read off
   status. With no answer it counts as openable: the guard then asks for the backup, the side that
   cannot lose a wallet. */
export async function openableHere(ctx: Pick<Ctx, 'keystore' | 'vault'>): Promise<boolean> {
  if (!keychainHome(ctx.vault)) return true;
  const live = ctx.keystore.enclaveRequest();
  if (live === null) return false;
  const asked = await ctx.vault.ask({ op: 'status', ...live });
  if (!asked.ok || asked.op !== 'status') return true;
  const s = asked.status;
  if (!live.keyBlob.startsWith('keychain:')) return !s.bound;
  if (s.key === null || !s.key.present) return false;
  if (s.marker !== null) return s.pinMatches === true;
  return !s.bound || s.key.fresh;
}
