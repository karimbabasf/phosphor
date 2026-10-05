// The chip vault's window routes (PHASE2-PLAN.md C9): the paper key, the move to this Mac's Touch
// ID key, the restore on a new Mac, and the return of the old fee account's NEAR. Every one carries
// the window token through guarded(), and none is on /api/mcp: no agent reaches the words, the
// pins, a rekey or the return. The work is src/vault/rekey.ts and src/vault/gas-account.ts; this
// file is the door, the Touch ID for the owner key, and the sentences.
//
// THE WORDS. /chip/phrase answers the 24 words once, to the window that asked, and nothing here
// logs, audits or echoes them, a refusal included: a sentence that quoted a mistyped word would put
// part of a paper key in a log. /chip/phrase-proven and /chip/restore take all 24 back and answer
// yes or no.

import type http from 'node:http';

import { errText, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import type { Ctx } from './context.ts';
import { depositRoute, guarded, knownRefusal, refusal } from './wallet.ts';
import { backupProven } from './vault.ts';
import { settleFor } from './custody.ts';
import { custodyLock } from '../vault/custody-lock.ts';
import { allowanceState } from '../vault/allowance.ts';
import { returnOldGas } from '../vault/gas-account.ts';
import { chipSlice, chipVaultChain, oldGasReturned, provePaper, showPaper, startRekey } from '../vault/rekey.ts';
import type { ChipFrame, ChipSlice, Refused, RekeyHost } from '../vault/rekey.ts';

/* The rekey's and the return's own refusals, said once here. Codes from the vault service, the
   relay and the submit keep their sentences in src/http/wallet.ts (REFUSALS). */
const CHIP_WORDS: Record<string, string> = {
  move_not_enclave: 'Only a wallet that opens with Touch ID can move its vault to a Touch ID key.',
  already_moved: 'Your vault already moved to a Touch ID key on this Mac.',
  vault_moved_elsewhere: 'Your vault already answers to other keys, so this Mac cannot move it. Restore it here with your paper key.',
  paper_needed: 'Type your paper key back first, all 24 words.',
  rekey_busy: 'Your vault is moving right now. Wait for it to finish.',
  wrong_words: 'Those words do not match the paper key on screen. Check each word against your paper.',
  wrong_paper: 'Those words are not the paper key you wrote for this move. Type that paper again, or show a new one.',
  phrase_gone: 'There is no paper key waiting to be checked. Show a new one and write it down: a paper shown earlier opens nothing.',
  bad_paper: 'Those are not the 24 words of a paper key. Check each word against your paper.',
  not_your_paper: 'That paper key is not on your vault, so nothing changed. Use the paper you wrote when your vault last moved; a paper from before a restore no longer works.',
  same_paper: 'Write a new paper key for the restore. The paper you restore from stops working once the restore is done.',
  rekey_slow: 'Touch ID took longer than the move can wait, so nothing was sent. Try again.',
  vault_changed: "Your vault's keys changed while it was moving, so nothing was sent. Look at the Vault tab, then try again.",
  vault_json: 'Your vault moved, and Phosphor could not note it on this Mac yet. It tries again on its own while the app is open.',
  vault_other_keys: 'Your vault moved, and it also holds a key Phosphor did not add. Look at the Vault tab before you move anything else.',
  gas_empty: 'The old fee account holds no NEAR that can come back to your vault, so nothing was sent.',
  gas_return_failed: 'The NEAR in the old fee account did not come back just now. If the Vault tab still shows it in a minute, try again.',
};

// The sentence for any code a chip route or frame can carry.
export function chipSaid(code: string): string {
  return Object.hasOwn(CHIP_WORDS, code) ? CHIP_WORDS[code]! : (refusal(code).error as string);
}

export function chipRefusal(code: string): JsonBody {
  return Object.hasOwn(CHIP_WORDS, code) || !knownRefusal(code) ? { ok: false, error: chipSaid(code), code } : refusal(code);
}

function answer(res: http.ServerResponse, r: Refused): void {
  sendJson(res, 200, chipRefusal(r.code));
}

/* The owner key for one signature behind its own Touch ID, as an approval's owner touch is asked
   (src/proposals/lifecycle.ts ownerTouchVia): under the custody lock, a staged file a crash left
   settled first, one unwrap with the app's sentence, the key lent to `use` and zeroed after. */
async function ownerTouch<T>(ctx: Ctx, reason: string, use: (key: Buffer) => T | Promise<T>): Promise<{ ok: true; value: T } | Refused> {
  return custodyLock(ctx.keystore).run(async () => {
    await settleFor(ctx);
    const request = ctx.keystore.enclaveRequest();
    if (request === null) return { ok: false as const, code: 'no_wallet', detail: 'the wallet has no Touch ID key to ask' };
    const asked = await ctx.vault.ask({ op: 'unwrap', reason, ...request });
    if (!asked.ok) return { ok: false as const, code: asked.error === 'no_relay' || asked.error === 'helper_missing' ? 'enclave_unavailable' : asked.error, detail: asked.message };
    if (asked.op !== 'unwrap') return { ok: false as const, code: 'garbled', detail: `the relay answered an unwrap with ${asked.op}` };
    try {
      const lent = ctx.keystore.withOwnerKey(asked.dek, use);
      if (!lent.ok) return { ok: false as const, code: lent.error, detail: 'the Touch ID did not open the wallet' };
      return { ok: true as const, value: await lent.value };
    } catch (err) {
      return { ok: false as const, code: 'vault_bundle', detail: errText(err) };
    }
  });
}

export function hostOf(ctx: Ctx): RekeyHost {
  return {
    keystore: ctx.keystore,
    relay: ctx.vault,
    prefs: ctx.vaultPrefs,
    audit: ctx.audit,
    dataDir: ctx.cfg.dataDir,
    // A frame names its reason in words too, so a window opened mid-move can say it.
    frame: (f: ChipFrame) => ctx.sse.broadcast(f.reason === undefined ? f : { ...f, said: chipSaid(f.reason) }),
    changed: () => ctx.sse.broadcastState(),
    backedUp: () => backupProven(ctx).backedUp === true,
    ownerTouch: (reason, use) => ownerTouch(ctx, reason, use),
  };
}

/* The Vault tab's chip slice for /api/state. The allowance's account, size and balance are the
   allowance unit's read (src/vault/allowance.ts): null while the wallet spends from its vault. */
export function chipVaultSlice(ctx: Ctx): ChipSlice & { run: (ChipSlice['run'] & { said: string | null }) | null } {
  const slice = chipSlice(hostOf(ctx), () => allowanceState(ctx));
  return { ...slice, run: slice.run === null ? null : { ...slice.run, said: slice.run.reason === null ? null : chipSaid(slice.run.reason) } };
}

// POST /api/vault/chip/phrase -> {ok, words[24]}: a new paper key, shown once.
export async function handleChipPhrase(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/chip/phrase', req, res);
  if (body === null) return;
  const shown = showPaper(hostOf(ctx));
  if (!shown.ok) return answer(res, shown);
  ctx.session.touch();
  sendJson(res, 200, { ok: true, words: shown.words });
}

// POST /api/vault/chip/phrase-proven {words[24]} -> {ok, recovery}: the paper's 24 words, from the
// window that held them and checked three against the paper (ui/screens/chip.js), or typed whole
// after a restart.
export async function handleChipPhraseProven(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/chip/phrase-proven', req, res);
  if (body === null) return;
  const proven = provePaper(hostOf(ctx), body.words);
  if (!proven.ok) return answer(res, proven);
  ctx.session.touch();
  sendJson(res, 200, { ok: true, recovery: proven.recovery });
}

// POST /api/vault/chip/move -> 202 {ok, run}: the migration, reported in `chip` frames.
export async function handleChipMove(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/chip/move', req, res);
  if (body === null) return;
  const started = startRekey(hostOf(ctx), 'migrate');
  if (!started.ok) return answer(res, started);
  ctx.session.touch();
  sendJson(res, 202, { ok: true, run: started.run });
}

// POST /api/vault/chip/restore {words[24]} -> 202 {ok, run}: the paper brought to a new Mac.
export async function handleChipRestore(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/chip/restore', req, res);
  if (body === null) return;
  const started = startRekey(hostOf(ctx), 'restore', body.words);
  if (!started.ok) return answer(res, started);
  ctx.session.touch();
  sendJson(res, 202, { ok: true, run: started.run });
}

/* The vault's NEAR deposit address as the Receive row shows it (ctx.intentsReceive, the bridge's
   address held to its pin and to whether NEAR Intents takes deposits on NEAR right now), or null:
   no row, no address on it, a memo a transfer cannot carry, or a report for another account. */
async function vaultNearAddress(ctx: Ctx, vault: string): Promise<string | null> {
  const report = await ctx.intentsReceive().catch(() => null);
  if (report === null || report.tampered || report.account?.toLowerCase() !== vault.toLowerCase()) return null;
  const row = report.networks.find((n) => n.id === 'near');
  return row !== undefined && row.address !== null && row.memo === null ? row.address : null;
}

/* POST /api/vault/gas/return {} -> {ok, near, txHash}: what the old fee account holds, less what
   it keeps, back to this wallet's vault in one NEAR transfer signed by the account's derived key.
   The receiver is the vault's NEAR deposit address as the Receive row shows it, found here and never
   read from the body. Window only: no agent tool, MCP tool or proposal reaches it. */
export async function handleGasReturn(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/gas/return', req, res);
  if (body === null) return;
  // The vault this open wallet's own keys name, as the move reads it (src/vault/rekey.ts openVault).
  const report = ctx.keystore.isUnlocked() ? ctx.keystore.addressReport() : null;
  const vault = report !== null && report.verified === true ? report.addresses.evm : null;
  if (vault === null) return sendJson(res, 200, chipRefusal('wallet_locked'));
  // The same gate as every deposit address: NEAR's route must read open by 1Click's own answer
  // before NEAR goes to the bridge's address (review18 M1).
  const gate = await depositRoute(ctx, 'near', vault, '');
  const shut = gate.closed ?? gate.unconfirmed;
  if (shut !== null) {
    ctx.audit.append('app_start', "the old fee account's NEAR did not go back: NEAR Intents is not confirmed open for NEAR deposits", {});
    return sendJson(res, 200, { ...chipRefusal('gas_return_failed'), error: shut });
  }
  const to = await vaultNearAddress(ctx, vault);
  if (to === null) {
    ctx.audit.append('app_start', "the old fee account's NEAR did not go back: the bridge showed no NEAR deposit address for the vault", {});
    return sendJson(res, 200, chipRefusal('gas_return_failed'));
  }
  // Read now, never kept from above: a lock in between zeroes the session's seed.
  let seed: Buffer;
  try {
    seed = ctx.keystore.gasSeed();
  } catch {
    return sendJson(res, 200, chipRefusal('wallet_locked'));
  }
  const back = await returnOldGas({ seed, to }, chipVaultChain()?.near);
  if (!back.ok) {
    ctx.audit.append('app_start', `the old fee account's NEAR did not go back: ${back.detail}`, { code: back.code, to, txHash: back.txHash });
    return sendJson(res, 200, chipRefusal(back.code));
  }
  oldGasReturned(ctx.keystore);
  ctx.audit.append('app_start', `${back.near} NEAR went back from the old fee account to the vault`, { to, txHash: back.txHash });
  ctx.session.touch();
  ctx.sse.broadcastState();
  sendJson(res, 200, { ok: true, near: back.near, txHash: back.txHash });
}
