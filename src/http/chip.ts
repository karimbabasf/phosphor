// The chip vault's window routes (PHASE2-PLAN.md C9): the paper key, the move to this Mac's Touch
// ID key, the restore on a new Mac, and the gas account's funding. Every one carries the window
// token through guarded(), and none is on /api/mcp: no agent reaches the words, the pins or a
// rekey. The work is src/vault/rekey.ts; this file is the door, the Touch ID for the owner key, and
// the sentences.
//
// THE WORDS. /chip/phrase answers the 24 words once, to the window that asked, and nothing here
// logs, audits or echoes them, a refusal included: a sentence that quoted a mistyped word would put
// part of a paper key in a log. /chip/phrase-proven and /chip/restore take all 24 back and answer
// yes or no.

import type http from 'node:http';

import { sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import type { Ctx } from './context.ts';
import { guarded, knownRefusal, refusal } from './wallet.ts';
import { backupProven } from './vault.ts';
import { settleFor } from './custody.ts';
import { custodyLock } from '../vault/custody-lock.ts';
import { allowanceState } from '../vault/allowance.ts';
import { GAS_FUND_MAX_NEAR, GAS_FUND_MIN_NEAR, fundingNear, gasAccountOf } from '../vault/gas-account.ts';
import { chipSlice, provePaper, showPaper, startRekey } from '../vault/rekey.ts';
import type { ChipFrame, ChipSlice, Refused, RekeyHost } from '../vault/rekey.ts';

/* The rekey's own refusals, said once here. Codes from the vault service, the relay, the submit
   and the gas account keep their sentences in src/http/wallet.ts (REFUSALS). */
const CHIP_WORDS: Record<string, string> = {
  move_not_enclave: 'Only a wallet that opens with Touch ID can move its vault to a Touch ID key.',
  already_moved: 'Your vault already moved to a Touch ID key on this Mac.',
  vault_moved_elsewhere: 'Your vault already answers to other keys, so this Mac cannot move it. Restore it here with your paper key.',
  paper_needed: 'Type your paper key back first, all 24 words.',
  rekey_busy: 'Your vault is moving right now. Wait for it to finish.',
  wrong_words: 'Those words do not match the paper key on screen. Check each word against your paper.',
  wrong_paper: 'Those words are not the paper key you wrote for this move. Type that paper again, or show a new one.',
  phrase_gone: 'There is no paper key waiting to be typed back. Show a new one and write it down: a paper shown before Phosphor restarted opens nothing.',
  bad_paper: 'Those are not the 24 words of a paper key. Check each word against your paper.',
  not_your_paper: 'That paper key is not a key of your vault, so nothing changed.',
  same_paper: 'Write a new paper key for the restore. The paper you restore from stops working once the restore is done.',
  rekey_slow: 'Touch ID took longer than the move can wait, so nothing was sent. Try again.',
  vault_changed: "Your vault's keys changed while it was moving, so nothing was sent. Look at the Vault tab, then try again.",
  vault_json: 'Your vault moved, and Phosphor could not note it on this Mac yet. It tries again on its own while the app is open.',
  vault_other_keys: 'Your vault moved, and it also holds a key Phosphor did not add. Look at the Vault tab before you move anything else.',
  fund_amount: `Add between ${GAS_FUND_MIN_NEAR} and ${GAS_FUND_MAX_NEAR} NEAR to the gas account.`,
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
      return { ok: false as const, code: 'vault_bundle', detail: err instanceof Error ? err.message : String(err) };
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

// POST /api/vault/chip/phrase-proven {words[24]} -> {ok, recovery}: the paper typed back whole.
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

/* POST /api/vault/gas/fund {near} -> {ok, proposal}: NEAR paid out on the NEAR chain to the gas
   account, the R4 route. The receiver is the derived id and nothing from the body; the proposal
   waits for a click and a Touch ID that names the receiver, as every payout does. */
export async function handleGasFund(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/gas/fund', req, res);
  if (body === null) return;
  const near = fundingNear(body.near);
  if (near === null) return sendJson(res, 200, chipRefusal('fund_amount'));
  const gas = gasAccountOf(ctx.keystore);
  if (gas === null) return sendJson(res, 200, refusal('wallet_locked'));
  const proposal = await ctx.proposals.proposeSend({ to: gas, symbol: 'NEAR', amount: near, where: 'near' });
  ctx.audit.append('app_start', `the window asked to pay ${near} NEAR to the gas account`, { gas, proposal: proposal.id, status: proposal.status });
  ctx.session.touch();
  sendJson(res, 200, { ok: true, proposal: { id: proposal.id, status: proposal.status } });
}
