// Moving the vault to this Mac's Touch ID key and a paper key, and restoring it on a new Mac
// (PHASE2-PLAN.md P2.7, contract C7, section 7's crash matrix).
//
// ONE REKEY CORE, TWO OLD SIGNERS. A migration and a restore build the same bundle, one
// execute_intents call that lands whole or not at all:
//   P_a, the old signer: add CHIP, add RECOVERY, remove every old key, set_auth_by_predecessor_id
//        {enabled:false};
//   P_c, the new paper key (RECOVERY): no intents, the proof the paper signs;
//   P_b, the chip key (CHIP): no intents, the proof the chip signs ("confirm this Mac's Touch ID
//        key for your vault").
// A migration's old signer is the owner key (OLD), behind a Touch ID of its own whose sentence is
// MOVE_VAULT_REASON; the old keys are OLD and anything public_keys_of lists. A restore's old signer
// is the paper the person brings, typed in; the old keys are every key public_keys_of lists (the old
// chips, that paper) and OLD when has_public_key still names it. The predecessor door (plan2-review
// F1): the owner key drives the 0x account's NEAR wallet contract, and auth by predecessor id lets
// that account act on the vault with no signed intent, so P_a turns it off in the same call.
//
// NOTHING IS SENT unless the verifier's dry run reports exactly the events built here from the
// plan (rekeyEvents), payload by payload: the key events and the predecessor event on P_a's hash,
// the predecessor event only when the flag read true before signing (a second false emits
// nothing), then intents_executed naming the three payloads (src/vault/submit.ts sends it).
// DONE IS WHAT THE CHAIN SAYS afterwards, at one final block: the chip and the new paper on the
// vault, OLD and every removed key off it, predecessor auth off. Only then are vault.json's chip
// entry written, the owner key dropped from the session and the rails switched to the allowance.
//
// THE PAPER'S WORDS NEVER TOUCH DISK (src/vault/phrase24.ts). The run record beside vault.json
// (chip-run.json) holds public facts only: the vault, the new paper's public key, the owner key's
// public key, the chip key. It is what a restart finds, with the chip service's markers and the
// vault move journal (src/vault/submit.ts), to finish or resume a move a crash cut short:
//   a phrase shown and never proven: that paper is void, a new one is shown;
//   a paper proven, nothing made: the same paper typed again, checked against its public key;
//   a chip made, never committed: a new chip, and the orphan is swept after ten minutes;
//   a chip committed, nothing sent: the same chip, the paper typed again must match its pin;
//   a bundle written down: nothing is signed again until it is settled, and it runs or dies;
//   a call that ran: the views say done, and vault.json is written at the next start.
// Every signature still goes through the vault move journal, so a bundle that left this Mac is
// never signed twice and a move is never signed again while an earlier bundle may still run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';

import type { MultiPayload, NearRpcDeps } from '../chain/near-tx.ts';
import { atomicWrite } from '../fsatomic.ts';
import { ERC191_STANDARD, erc191SignatureField } from '../intents-sign.ts';
import type { Keystore } from '../keystore/index.ts';
import type { VerifierEvent, VerifierPort } from '../relay/verifier.ts';
import { oneLine } from '../venue-words.ts';
import type { AccountsPort, ChipStatus } from './accounts.ts';
import { CHIP_PAYLOAD_LIFE_MS, chipSign, commitChip, createChip, isChipPublicKey, sweepChips } from './chip.ts';
import { gasAccountOf, nearText, readGas } from './gas-account.ts';
import { buildVaultPayload, eventsMismatch, expectedEvents, readVaultPayload, signedIntentHash } from './payload.ts';
import type { VaultIntent } from './payload.ts';
import { isPaperPhrase, newPaperPhrase, paperKeyOf, phraseDigest, phraseOf, verifierKeyOf, wipeKey } from './phrase24.ts';
import type { VaultPrefs } from './prefs.ts';
import { MOVE_VAULT_REASON, RESTORE_VAULT_REASON } from './reason.ts';
import type { VaultRelay } from './relay.ts';
import { gasReady, rekeyViews } from './submit.ts';
import type { VaultResult, VaultSubmitter, ViewCheck } from './submit.ts';

// How long the window may take to have the 24 words written down and typed back. What is held
// meanwhile is a hash of the phrase, which reveals nothing.
export const PHRASE_HOLD_MS = 60 * 60_000;
// How long a proven paper key waits for its move. A lock wipes it sooner.
export const PAPER_HOLD_MS = 30 * 60_000;
/* The least time every payload must still have to run when the bundle goes to the verifier: the
   dry run, the send and the final block fit in it. A Touch ID slower than its payload's life less
   this sends nothing, and the move is asked again with fresh payloads. */
export const SUBMIT_MARGIN_MS = 15_000;
// How old the chain facts on the Vault tab may be before a read of the state asks again.
export const VIEW_FRESH_MS = 60_000;
// How often a move whose call is out but not yet confirmed is checked again.
export const RESUME_POLL_MS = 15_000;

export const RUN_FILE = 'chip-run.json';

export type RekeyKind = 'migrate' | 'restore';
export type RunStatus = 'creating' | 'touch_old' | 'touch_chip' | 'simulating' | 'submitting' | 'checking' | 'done' | 'failed';
// The frame the window draws a move from (PHASE2-PLAN.md C9).
export type ChipFrame = { type: 'chip'; kind: 'chip'; run: string; status: RunStatus; reason?: string };

export type Refused = { ok: false; code: string; detail: string };

function refused(code: string, detail: string): Refused {
  return { ok: false, code, detail };
}

// ---------- what the app installs ----------

/* The chain side, installed once by src/main.ts (a test installs its doubles): the verifier, the
   one vault move submitter the app shares with the allowance, the accounts the rails read, NEAR's
   RPC for the gas account, the clock. `newPhrase` is a test's fixed paper; the app draws one.
   `reads` lets a state read ask the chain for the Vault tab's facts. */
export type ChipVaultChain = {
  verifier: VerifierPort;
  submitter: VaultSubmitter;
  accounts: Pick<AccountsPort, 'accounts' | 'refresh'>;
  near?: NearRpcDeps;
  now?: () => number;
  newPhrase?: () => string;
  reads?: boolean;
  // How often an unconfirmed move is checked again; RESUME_POLL_MS unless a test says.
  pollMs?: number;
};

let installed: ChipVaultChain | null = null;

export function useChipVault(chain: ChipVaultChain | null): void {
  installed = chain;
}

export function chipVaultChain(): ChipVaultChain | null {
  return installed;
}

/* The app side, from the HTTP context (src/http/chip.ts): the keystore, the relay to the vault
   service, vault.json, the audit log, the data folder, the window's two pushes, whether the backup
   is proven, and the owner key's Touch ID (one unwrap under the custody lock, the key lent to `use`
   and zeroed after). */
export type RekeyHost = {
  keystore: Keystore;
  relay: VaultRelay;
  prefs: VaultPrefs;
  audit: { append(type: 'app_start' | 'error', msg: string, data?: Record<string, unknown>): unknown };
  dataDir: string;
  frame(frame: ChipFrame): void;
  changed(): void;
  backedUp(): boolean;
  ownerTouch<T>(reason: string, use: (key: Buffer) => T | Promise<T>): Promise<{ ok: true; value: T } | Refused>;
};

// ---------- the bundle, as a plan ----------

/* What one rekey signs: the vault, the new chip key and paper key, the keys it takes off, and the
   predecessor flag as read before signing. */
export type RekeyPlan = { vault: string; chip: string; recovery: string; remove: string[]; predecessorAuth: boolean };

export function rekeyIntents(plan: RekeyPlan): VaultIntent[] {
  return [
    { intent: 'add_public_key', public_key: plan.chip },
    { intent: 'add_public_key', public_key: plan.recovery },
    ...plan.remove.map((k): VaultIntent => ({ intent: 'remove_public_key', public_key: k })),
    { intent: 'set_auth_by_predecessor_id', enabled: false },
  ];
}

/* The events the verifier must report for [P_a, P_c, P_b], built from the plan and not read off
   the bundle, so a builder that signed something else is caught: every key event and the
   predecessor event on P_a's hash, the predecessor event only when the flag read true, then
   intents_executed with the three payloads in order. A migration of a vault nobody else touched
   is C7's five: added CHIP, added RECOVERY, removed OLD, set_auth false, intents_executed (3). */
export function rekeyEvents(plan: RekeyPlan, bundle: readonly MultiPayload[]): VerifierEvent[] {
  const hashes = bundle.map((s) => signedIntentHash(s));
  const account_id = plan.vault;
  const key = (event: 'public_key_added' | 'public_key_removed', public_key: string): VerifierEvent => ({ event, data: { intent_hash: hashes[0]!, account_id, public_key } });
  return [
    key('public_key_added', plan.chip),
    key('public_key_added', plan.recovery),
    ...plan.remove.map((k) => key('public_key_removed', k)),
    ...(plan.predecessorAuth ? [{ event: 'set_auth_by_predecessor_id' as const, data: { intent_hash: hashes[0]!, account_id, enabled: false } }] : []),
    { event: 'intents_executed', data: bundle.map((s, i) => ({ intent_hash: hashes[i]!, account_id, nonce: readVaultPayload(s.payload).nonce })) },
  ];
}

// The views done waits for: C7's four, and every other key the bundle took off reads off.
export function rekeyChecks(plan: RekeyPlan, old: string): ViewCheck[] {
  return [
    ...rekeyViews({ vault: plan.vault, chip: plan.chip, recovery: plan.recovery, old }),
    ...plan.remove.filter((k) => k !== old).map((k): ViewCheck => ({ view: 'hasPublicKey', account: plan.vault, publicKey: k, is: false })),
  ];
}

export async function erc191Signed(key: Uint8Array, payload: string): Promise<MultiPayload> {
  const account = privateKeyToAccount(`0x${Buffer.from(key).toString('hex')}`);
  return { standard: ERC191_STANDARD, payload, signature: erc191SignatureField(await account.signMessage({ message: payload })) };
}

/* The three signers of one bundle, in the order they are asked: the old signer (OLD behind its
   Touch ID, or the paper brought to a restore), the chip behind its Touch ID, then the new paper.
   Each builds nothing: it signs what it is handed. */
export type RekeySigners = {
  old(payload: string): Promise<MultiPayload | Refused>;
  chip(payload: string): Promise<MultiPayload | Refused>;
  paper(payload: string): Promise<MultiPayload | Refused>;
};

function isRefused(x: MultiPayload | Refused): x is Refused {
  return (x as Refused).ok === false;
}

/* Signs one bundle for a plan: P_a and P_b are built back to back (a payload the chip signs lives
   CHIP_PAYLOAD_LIFE_MS, the grammar's two minutes less ten seconds), P_c after the chip's Touch ID.
   Before anything leaves, every payload must still have SUBMIT_MARGIN_MS to run and the bundle's
   own events must equal the plan's. `said` reports each Touch ID as it is asked. */
export async function signRekey(
  plan: RekeyPlan,
  signers: RekeySigners,
  opts: { salt: Uint8Array; now: () => number; said?: (status: 'touch_old' | 'touch_chip') => void; oldTouches?: boolean },
): Promise<{ ok: true; bundle: MultiPayload[] } | Refused> {
  const build = (intents: VaultIntent[]): string => buildVaultPayload({ signerId: plan.vault, intents, deadlineMs: opts.now() + CHIP_PAYLOAD_LIFE_MS, salt: opts.salt });
  if (opts.oldTouches !== false) opts.said?.('touch_old');
  const pa = await signers.old(build(rekeyIntents(plan)));
  if (isRefused(pa)) return pa;
  const proof = build([]);
  opts.said?.('touch_chip');
  const pb = await signers.chip(proof);
  if (isRefused(pb)) return pb;
  const pc = await signers.paper(build([]));
  if (isRefused(pc)) return pc;
  const bundle = [pa, pc, pb];
  const soonest = Math.min(...bundle.map((s) => Date.parse(readVaultPayload(s.payload).deadline)));
  if (soonest - opts.now() < SUBMIT_MARGIN_MS) return refused('rekey_slow', `a payload has ${Math.max(0, soonest - opts.now())} ms left to run, under the ${SUBMIT_MARGIN_MS} ms a send needs`);
  const mismatch = eventsMismatch(expectedEvents(bundle, { predecessorAuth: plan.predecessorAuth }), rekeyEvents(plan, bundle));
  if (mismatch !== null) return refused('vault_bundle', `the signed bundle is not the planned rekey: ${mismatch}`);
  return { ok: true, bundle };
}

// ---------- what this process holds, per wallet keystore ----------

type HeldPhrase = { wallet: string; digest: Buffer; until: number };
type HeldPaper = { wallet: string; key: Buffer; publicKey: string; until: number };
type RunState = { id: string; kind: RekeyKind; status: RunStatus; reason?: string; at: number };

type ChipView = {
  vault: string | null;
  at: number;
  recovery: boolean | null;
  old: boolean | null;
  predecessor: boolean | null;
  gas: { account: string; amount: bigint | null; low: boolean | null } | null;
};

type Box = {
  phrase: HeldPhrase | null;
  paper: HeldPaper | null;
  run: RunState | null;
  view: ChipView;
  refreshing: Promise<void> | null;
  // When the chain was last asked for the slice; 0 asks at the next read of the state.
  askedAt: number;
  poll: NodeJS.Timeout | null;
  // The owner key's public half per vault, learned from an open session that held it.
  olds: Map<string, string>;
};

const boxes = new WeakMap<object, Box>();

function boxOf(host: RekeyHost): Box {
  const known = boxes.get(host.keystore);
  if (known !== undefined) return known;
  const box: Box = { phrase: null, paper: null, run: null, view: emptyView(), refreshing: null, askedAt: 0, poll: null, olds: new Map() };
  boxes.set(host.keystore, box);
  // A lock is someone stepping away: a proven paper key goes with it, and is typed again.
  host.keystore.onChange((state) => {
    if (state !== 'unlocked') wipePaper(box);
  });
  return box;
}

function emptyView(): ChipView {
  return { vault: null, at: 0, recovery: null, old: null, predecessor: null, gas: null };
}

function wipePaper(box: Box): void {
  if (box.paper !== null) wipeKey(box.paper.key);
  box.paper = null;
}

function clock(): number {
  return (installed?.now ?? Date.now)();
}

function active(run: RunState | null): boolean {
  return run !== null && run.status !== 'done' && run.status !== 'failed';
}

// ---------- the run record ----------

type RunRecord = {
  v: 1;
  vault: string;
  kind: RekeyKind | null;
  phraseAt: string | null;
  recovery: string | null;
  old: string | null;
  chip: { keyRef: string; publicKey: string } | null;
  status: 'phrase' | 'proven' | 'moving' | 'done' | 'failed';
  at: string;
};

const SECP_KEY = /^secp256k1:[1-9A-HJ-NP-Za-km-z]{60,100}$/;

function recordPath(dataDir: string): string {
  return path.join(dataDir, RUN_FILE);
}

// The record for this vault, or null: a file that does not read, or names another vault, is none.
function readRecord(dataDir: string, vault: string): RunRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(dataDir), 'utf8')) as Record<string, unknown>;
    const chip = r.chip as Record<string, unknown> | null;
    const ok =
      r.v === 1 &&
      typeof r.vault === 'string' &&
      (r.kind === null || r.kind === 'migrate' || r.kind === 'restore') &&
      (r.phraseAt === null || typeof r.phraseAt === 'string') &&
      (r.recovery === null || (typeof r.recovery === 'string' && SECP_KEY.test(r.recovery))) &&
      (r.old === null || (typeof r.old === 'string' && SECP_KEY.test(r.old))) &&
      (chip === null || (chip !== undefined && typeof chip === 'object' && typeof chip.keyRef === 'string' && isChipPublicKey(chip.publicKey))) &&
      ['phrase', 'proven', 'moving', 'done', 'failed'].includes(String(r.status)) &&
      typeof r.at === 'string';
    if (!ok || r.vault !== vault) return null;
    return r as unknown as RunRecord;
  } catch {
    return null;
  }
}

function writeRecord(host: RekeyHost, record: Omit<RunRecord, 'v' | 'at'>): void {
  const body: RunRecord = { v: 1, ...record, at: new Date(clock()).toISOString() };
  atomicWrite(recordPath(host.dataDir), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

// ---------- the wallet and its keys ----------

// The open wallet's vault account, lowercase, read from keys this process decrypted.
function openVault(host: RekeyHost): string | null {
  if (!host.keystore.isUnlocked()) return null;
  const report = host.keystore.addressReport();
  return report.verified === true && report.addresses.evm !== null ? report.addresses.evm.toLowerCase() : null;
}

/* The owner key's verifier name for this vault, from the open session when it holds the key (kind
   key), else from what this process or the run record learned before. Null when neither knows. */
function knownOld(host: RekeyHost, box: Box, vault: string): string | null {
  const known = box.olds.get(vault);
  if (known !== undefined) return known;
  try {
    const hex = host.keystore.evmPrivateKey();
    const key = Buffer.from(hex.slice(2), 'hex');
    const name = verifierKeyOf(key);
    const address = privateKeyToAccount(hex).address.toLowerCase();
    key.fill(0);
    if (address === vault) {
      box.olds.set(vault, name);
      return name;
    }
  } catch {
    // Locked, or the owner key is out of the session.
  }
  const fromRecord = readRecord(host.dataDir, vault)?.old ?? null;
  if (fromRecord !== null) box.olds.set(vault, fromRecord);
  return fromRecord;
}

// ---------- the paper key ----------

/* A new paper key, shown once. Showing one voids any paper proven before it that no move used:
   the person is writing a new one. */
export function showPaper(host: RekeyHost): { ok: true; words: string[] } | Refused {
  const box = boxOf(host);
  const vault = openVault(host);
  if (vault === null) return refused('wallet_locked', 'the paper key is made for an open wallet');
  if (active(box.run)) return refused('rekey_busy', 'a move of the vault is under way');
  const phrase = (installed?.newPhrase ?? newPaperPhrase)();
  if (!isPaperPhrase(phrase)) return refused('invalid_request', 'the new paper key is not 24 words with a checksum');
  wipePaper(box);
  box.phrase = { wallet: vault, digest: phraseDigest(phrase), until: clock() + PHRASE_HOLD_MS };
  const before = readRecord(host.dataDir, vault);
  writeRecord(host, { vault, kind: null, phraseAt: new Date(clock()).toISOString(), recovery: null, old: before?.old ?? null, chip: null, status: 'phrase' });
  host.audit.append('app_start', 'a new paper key was shown in the window; Phosphor keeps none of its words', {});
  host.changed();
  return { ok: true, words: phrase.split(' ') };
}

/* All 24 words typed back. Against the phrase on screen while it is held; after a restart, against
   the public key the run record kept for the paper that was proven before it. Either way the
   answer is yes or no, never which word. */
export function provePaper(host: RekeyHost, words: unknown): { ok: true; recovery: string } | Refused {
  const box = boxOf(host);
  const vault = openVault(host);
  if (vault === null) return refused('wallet_locked', 'the paper key is proven for an open wallet');
  if (active(box.run)) return refused('rekey_busy', 'a move of the vault is under way');
  const phrase = phraseOf(words);
  if (phrase === null || !isPaperPhrase(phrase)) return refused('bad_paper', 'not 24 words of a paper key');
  const held = box.phrase !== null && box.phrase.wallet === vault && clock() <= box.phrase.until ? box.phrase : null;
  const record = readRecord(host.dataDir, vault);
  if (held !== null) {
    if (!crypto.timingSafeEqual(phraseDigest(phrase), held.digest)) return refused('wrong_words', 'the words typed back are not the words shown');
  } else if (record?.recovery == null) {
    return refused('phrase_gone', 'no paper key on screen, and none proven before a restart');
  }
  const paper = paperKeyOf(phrase);
  if (held === null && paper.publicKey !== record?.recovery) {
    wipeKey(paper.key);
    return refused('wrong_paper', 'the words typed are not the paper proven for this move');
  }
  box.phrase = null;
  wipePaper(box);
  box.paper = { wallet: vault, key: paper.key, publicKey: paper.publicKey, until: clock() + PAPER_HOLD_MS };
  writeRecord(host, {
    vault,
    kind: record?.kind ?? null,
    phraseAt: record?.phraseAt ?? null,
    recovery: paper.publicKey,
    old: record?.old ?? null,
    chip: record?.recovery === paper.publicKey ? (record?.chip ?? null) : null,
    status: record?.status === 'moving' && record.recovery === paper.publicKey ? 'moving' : 'proven',
  });
  host.audit.append('app_start', 'the paper key was typed back in full; its key is held until the move signs with it', { recovery: paper.publicKey });
  host.changed();
  return { ok: true, recovery: paper.publicKey };
}

function heldPaper(box: Box, vault: string): HeldPaper | null {
  if (box.paper === null) return null;
  if (box.paper.wallet !== vault || clock() > box.paper.until) {
    wipePaper(box);
    return null;
  }
  return box.paper;
}

// ---------- the chain, read at one block ----------

type VaultRead = { block: string; has: Map<string, boolean>; listed: string[]; predecessorAuth: boolean };

async function readVault(verifier: VerifierPort, vault: string, keys: string[]): Promise<VaultRead | null> {
  const block = verifier.finalBlock === undefined ? null : await verifier.finalBlock().catch(() => null);
  if (block === null || verifier.publicKeysOf === undefined || verifier.isAuthByPredecessorIdEnabled === undefined || verifier.hasPublicKey === undefined) return null;
  const at = block.hash;
  const [listed, predecessorAuth, ...seen] = await Promise.all([
    verifier.publicKeysOf(vault, at).catch(() => null),
    verifier.isAuthByPredecessorIdEnabled(vault, at).catch(() => null),
    ...keys.map((k) => verifier.hasPublicKey!(vault, k, at).catch(() => null)),
  ]);
  if (listed === null || typeof predecessorAuth !== 'boolean' || seen.some((s) => typeof s !== 'boolean')) return null;
  return { block: at, has: new Map(keys.map((k, i) => [k, seen[i] as boolean])), listed: listed as string[], predecessorAuth };
}

async function chipStatusAll(relay: VaultRelay): Promise<ChipStatus | Refused> {
  const answer = await relay.ask({ op: 'chipStatus' });
  if (!answer.ok) return refused(answer.error, answer.message);
  if (answer.op !== 'chipStatus') return refused('garbled', `the relay answered a chip status with ${answer.op}`);
  if (!answer.status.keychainHome) return refused('keychain_unavailable', 'the service read no keychain home');
  return answer.status;
}

// ---------- the move ----------

type Plan = {
  kind: RekeyKind;
  run: string;
  vault: string;
  allowance: string;
  gas: string;
  old: string | null;
  recovery: string;
  // A restore's old signer: the paper the person brought, typed in.
  oldPaper: { key: Buffer; publicKey: string } | null;
};

/* Starts a migration or a restore. Everything that can be checked without the network is checked
   here, so the window hears a refusal at once; the rest runs in the background and reports in
   frames. `oldWords` is the paper a restore brings. */
export function startRekey(host: RekeyHost, kind: RekeyKind, oldWords?: unknown): { ok: true; run: string } | Refused {
  const chain = installed;
  if (chain === null) return refused('chip_unsupported', 'this backend has no chip vault installed');
  const box = boxOf(host);
  if (active(box.run)) return refused('rekey_busy', 'a move of the vault is under way');
  const vault = openVault(host);
  if (vault === null) return refused('wallet_locked', 'a move needs the wallet open');
  if (host.keystore.custody() !== 'secure-enclave') return refused('move_not_enclave', 'the wallet does not open with Touch ID');
  if (!host.relay.enclaveReady()) return refused('enclave_unavailable', 'the shell reports no enclave to ask');
  if (!host.backedUp()) return refused('not_backed_up', 'the key backup is not proven');
  const derived = host.keystore.derivedAccounts();
  if (derived === null) return refused('wallet_locked', 'the allowance and gas accounts are not derived yet');
  const paper = heldPaper(box, vault);
  if (paper === null) return refused('paper_needed', 'no paper key typed back for this wallet');
  let oldPaper: Plan['oldPaper'] = null;
  if (kind === 'migrate') {
    if (host.prefs.get().chip !== null) return refused('already_moved', 'vault.json already names a chip for a vault');
  } else {
    const phrase = phraseOf(oldWords);
    if (phrase === null || !isPaperPhrase(phrase)) return refused('bad_paper', 'not 24 words of a paper key');
    const brought = paperKeyOf(phrase);
    if (brought.publicKey === paper.publicKey) {
      wipeKey(brought.key);
      return refused('same_paper', 'the restore needs a new paper key beside the one it retires');
    }
    oldPaper = { key: brought.key, publicKey: brought.publicKey };
  }
  const old = knownOld(host, box, vault);
  if (kind === 'migrate' && old === null) {
    // An open session with no owner key: the gate says this vault moved, whatever vault.json says.
    return refused('already_moved', 'the owner key is out of the session');
  }
  const run = crypto.randomBytes(8).toString('hex');
  box.run = { id: run, kind, status: 'creating', at: clock() };
  host.frame({ type: 'chip', kind: 'chip', run, status: 'creating' });
  host.changed();
  const plan: Plan = { kind, run, vault, allowance: derived.allowance.toLowerCase(), gas: derived.gas, old, recovery: paper.publicKey, oldPaper };
  void moveVault(host, chain, plan).catch((err: unknown) => {
    host.audit.append('error', `the vault move stopped: ${oneLine(err instanceof Error ? err.message : err, 200)}`, { run });
    say(host, run, 'failed', 'vault_bundle');
  });
  return { ok: true, run };
}

function say(host: RekeyHost, run: string, status: RunStatus, reason?: string): void {
  const box = boxOf(host);
  if (box.run === null || box.run.id !== run) return;
  // A reason belongs to the status it came with: done after checking carries none.
  box.run = { id: box.run.id, kind: box.run.kind, status, ...(reason === undefined ? {} : { reason }), at: clock() };
  // A move that ended changes what the chain shows: the next read of the state asks it again.
  if (status === 'done' || status === 'failed') box.askedAt = 0;
  host.frame({ type: 'chip', kind: 'chip', run, status, ...(reason === undefined ? {} : { reason }) });
  host.changed();
}

// What the vault's keys were when the move was planned: a change before the signatures stops it.
function keysOf(read: VaultRead, owner: string, oldPaper: string | null): string {
  return JSON.stringify({ listed: [...read.listed].sort(), owner: read.has.get(owner) ?? null, paper: oldPaper === null ? null : (read.has.get(oldPaper) ?? null) });
}

async function moveVault(host: RekeyHost, chain: ChipVaultChain, plan: Plan): Promise<void> {
  const box = boxOf(host);
  const fail = (code: string, detail: string): void => {
    host.audit.append('app_start', `the vault did not move: ${oneLine(detail, 200)}`, { run: plan.run, code });
    say(host, plan.run, 'failed', code);
  };
  try {
    // A move that already ran with this paper, a crash ago, is finished rather than made again.
    await resumeChip(host, false);
    const resumed = readRecord(host.dataDir, plan.vault);
    if (host.prefs.get().chip !== null && resumed?.status === 'done' && resumed.recovery === plan.recovery) {
      wipePaper(box);
      say(host, plan.run, 'done');
      return;
    }
    if (plan.kind === 'migrate' && host.prefs.get().chip !== null) return fail('already_moved', 'vault.json names a chip for this vault');

    const owner = plan.old ?? (await learnOld(host, plan));
    if (typeof owner !== 'string') return fail(owner.code, owner.detail);
    const paperKey = plan.oldPaper === null ? null : plan.oldPaper.publicKey;
    const before = await readVault(chain.verifier, plan.vault, [owner, plan.recovery, ...(paperKey === null ? [] : [paperKey])]);
    if (before === null) return fail('rpc_unavailable', 'NEAR did not answer the reads of the vault');
    if (before.has.get(plan.recovery) === true) return fail('vault_changed', 'the new paper key is already on the vault');
    if (plan.kind === 'migrate' && before.has.get(owner) !== true) return fail('vault_moved_elsewhere', 'the owner key is no longer a key of the vault');
    if (paperKey !== null && before.has.get(paperKey) !== true) return fail('not_your_paper', 'the paper brought to the restore is not a key of the vault');

    // Before any key is made or any Touch ID asked: a gas account that cannot send would waste both.
    const gas = await gasReady(plan.gas, chain.near);
    if (gas !== null) return fail(gas.code, gas.detail);

    // What an earlier try left in the journal is settled first, so a chip whose bundle can never be
    // proved dead is not asked to sign again (chipFor).
    await chain.submitter.settle(plan.vault).catch(() => undefined);
    const chip = await chipFor(host, chain, plan);
    if (!('keyRef' in chip)) return fail(chip.code, chip.detail);
    writeRecord(host, { vault: plan.vault, kind: plan.kind, phraseAt: readRecord(host.dataDir, plan.vault)?.phraseAt ?? null, recovery: plan.recovery, old: owner, chip, status: 'moving' });

    // Every key the vault answers to now goes: the owner key while it is still on, and every key
    // the verifier lists (an old chip, the paper a restore retires, a key nobody here added).
    const remove = [...(before.has.get(owner) === true ? [owner] : []), ...before.listed.filter((k) => k !== owner)];
    if (paperKey !== null && !remove.includes(paperKey)) remove.push(paperKey);
    const planned = keysOf(before, owner, paperKey);

    const result = await chain.submitter.move({
      id: `rekey:${chip.keyRef}`,
      account: plan.vault,
      sign: async () => {
        // The facts the bundle is built on, read again right before the signatures.
        const salt = await chain.verifier.currentSalt().catch(() => null);
        const now = await readVault(chain.verifier, plan.vault, [owner, chip.publicKey, plan.recovery, ...(paperKey === null ? [] : [paperKey])]);
        if (salt === null || now === null) return refused('rpc_unavailable', 'NEAR did not answer the reads before signing');
        if (now.has.get(chip.publicKey) !== false || now.has.get(plan.recovery) !== false || keysOf(now, owner, paperKey) !== planned) {
          return refused('vault_changed', 'the keys on the vault changed between the first read and the signatures');
        }
        const rekey: RekeyPlan = { vault: plan.vault, chip: chip.publicKey, recovery: plan.recovery, remove, predecessorAuth: now.predecessorAuth };
        const signed = await signRekey(rekey, signersFor(host, box, plan, chip, owner), {
          salt,
          now: clock,
          said: (status) => say(host, plan.run, status),
          oldTouches: plan.oldPaper === null,
        });
        if (!signed.ok) return signed;
        say(host, plan.run, 'simulating');
        return { ok: true, bundle: signed.bundle, before: { predecessorAuth: now.predecessorAuth } };
      },
      views: rekeyChecks({ vault: plan.vault, chip: chip.publicKey, recovery: plan.recovery, remove, predecessorAuth: false }, owner),
    });
    await afterSubmit(host, chain, plan, chip, result);
  } finally {
    if (plan.oldPaper !== null) wipeKey(plan.oldPaper.key);
  }
}

/* The owner key's public half when the session does not hold it: one Touch ID reads it, and the
   key is zeroed as the read returns. Only a restore on a Mac whose session keeps the owner key out
   gets here. */
async function learnOld(host: RekeyHost, plan: Plan): Promise<string | Refused> {
  say(host, plan.run, 'touch_old');
  const read = await host.ownerTouch(RESTORE_VAULT_REASON, (key) => ({ name: verifierKeyOf(key), address: privateKeyToAccount(`0x${key.toString('hex')}`).address.toLowerCase() }));
  if (!read.ok) return read;
  if (read.value.address !== plan.vault) return refused('vault_changed', "the owner key opened is not this vault's");
  boxOf(host).olds.set(plan.vault, read.value.name);
  return read.value.name;
}

/* The chip for this move: one this Mac already committed for this vault, its allowance and this
   paper (a move a crash stopped after the commit), or a new one, made and committed. Chips no
   marker names are swept first: a move that stopped between making and committing leaves one. */
async function chipFor(host: RekeyHost, chain: ChipVaultChain, plan: Plan): Promise<{ keyRef: string; publicKey: string } | Refused> {
  const status = await chipStatusAll(host.relay);
  if ('code' in status) return status;
  /* A chip whose bundle settled as unknown (its salt taken out, or its nonces past their life) is
     never signed for again under the same move: that bundle can no longer run, and the views say
     it did not, so the move goes on with a new chip. */
  const stuck = new Set(chain.submitter.pending(plan.vault).filter((e) => e.state === 'unknown').map((e) => e.id));
  const same = status.chips.find(
    (c) =>
      c.marker !== null &&
      c.publicKey !== '' &&
      !stuck.has(`rekey:${c.keyRef}`) &&
      c.marker.account.toLowerCase() === plan.vault &&
      c.marker.allowance.toLowerCase() === plan.allowance &&
      c.marker.recovery === plan.recovery,
  );
  if (same !== undefined) return { keyRef: same.keyRef, publicKey: same.publicKey };
  await sweepChips(host.relay).catch(() => undefined);
  const made = await createChip(host.relay);
  if (!made.ok) return made;
  const committed = await commitChip(host.relay, { keyRef: made.keyRef, account: plan.vault, allowance: plan.allowance, recovery: plan.recovery });
  if (!committed.ok) return committed;
  host.audit.append('app_start', 'a Touch ID key for the vault was made and pinned to the vault, its allowance and the paper key', { chip: made.publicKey, recovery: plan.recovery });
  return { keyRef: made.keyRef, publicKey: made.publicKey };
}

function signersFor(host: RekeyHost, box: Box, plan: Plan, chip: { keyRef: string; publicKey: string }, owner: string): RekeySigners {
  return {
    async old(payload) {
      if (plan.oldPaper !== null) return erc191Signed(plan.oldPaper.key, payload);
      const touched = await host.ownerTouch(MOVE_VAULT_REASON, (key) => {
        if (verifierKeyOf(key) !== owner) throw new Error('the owner key opened is not the one this move was planned for');
        return erc191Signed(key, payload);
      });
      return touched.ok ? touched.value : touched;
    },
    async chip(payload) {
      const signed = await chipSign(host.relay, { keyRef: chip.keyRef, publicKey: chip.publicKey, account: plan.vault }, payload);
      return signed.ok ? signed.signed : refused(signed.code, signed.detail);
    },
    async paper(payload) {
      const paper = heldPaper(box, plan.vault);
      if (paper === null || paper.publicKey !== plan.recovery) return refused('paper_needed', 'the paper key was wiped before it signed');
      try {
        return await erc191Signed(paper.key, payload);
      } finally {
        // The paper key signs once per move and is gone: a move asked again types it again.
        wipePaper(box);
      }
    },
  };
}

async function afterSubmit(host: RekeyHost, chain: ChipVaultChain, plan: Plan, chip: { keyRef: string; publicKey: string }, result: VaultResult): Promise<void> {
  switch (result.state) {
    case 'done':
      try {
        await finish(host, chain, plan.vault, chip, plan.recovery, plan.kind);
      } catch (err) {
        // The vault moved and vault.json was not written: the check below writes it when it can.
        host.audit.append('error', `the vault moved and vault.json was not written: ${oneLine(err instanceof Error ? err.message : err, 200)}`, { run: plan.run });
        say(host, plan.run, 'failed', 'vault_json');
        keepChecking(host);
        return;
      }
      say(host, plan.run, 'done');
      return;
    case 'refused':
      host.audit.append('app_start', `the vault did not move: ${oneLine(result.detail, 200)}`, { run: plan.run, code: result.code, released: result.released });
      say(host, plan.run, 'failed', result.code);
      if (result.released) keepChecking(host);
      return;
    case 'settling':
      // An earlier bundle can still run: nothing was signed, and the check finishes it if it lands.
      say(host, plan.run, 'failed', result.code);
      keepChecking(host);
      return;
    case 'sent':
    case 'checking':
      host.audit.append('app_start', `the vault move was sent and is not confirmed yet: ${oneLine(result.detail, 200)}`, { run: plan.run, state: result.state });
      say(host, plan.run, 'checking', result.code);
      keepChecking(host);
      return;
    case 'mismatch':
    case 'unknown':
      // The call may have run: whatever the chain shows, the check below finishes.
      host.audit.append('app_start', `the vault move ran or may have run, and the chain does not read as planned: ${oneLine(result.detail, 200)}`, { run: plan.run, state: result.state });
      say(host, plan.run, 'failed', result.code);
      await resumeChip(host, false).catch(() => undefined);
      return;
  }
}

/* The vault moved, by the chain's word: vault.json names the chip, the session lets go of the owner
   key at once, and the rails read the accounts again (the allowance from here on). */
async function finish(host: RekeyHost, chain: ChipVaultChain, vault: string, chip: { keyRef: string; publicKey: string }, recovery: string, kind: RekeyKind | null): Promise<void> {
  host.prefs.setChip({ keyRef: chip.keyRef, publicKey: chip.publicKey, account: vault });
  host.keystore.dropOwnerKey();
  await chain.accounts.refresh().catch(() => undefined);
  const record = readRecord(host.dataDir, vault);
  writeRecord(host, { vault, kind: kind ?? record?.kind ?? null, phraseAt: record?.phraseAt ?? null, recovery, old: record?.old ?? boxOf(host).olds.get(vault) ?? null, chip, status: 'done' });
  host.audit.append('app_start', "the vault moved to this Mac's Touch ID key and the paper key; the owner key is out of the session", { chip: chip.publicKey, recovery });
  boxOf(host).askedAt = 0;
  host.changed();
}

// ---------- after a crash ----------

/* Finishes a move that ran while this process was not there to see it: a chip this Mac committed
   for the vault is on it on chain beside its pinned paper key, so vault.json names that chip. The
   journal is settled first. Nothing is signed here. `report` tells a run in progress how it ended:
   done when the chain also reads the owner key off and predecessor auth off. */
export async function resumeChip(host: RekeyHost, report = true): Promise<'done' | 'moving' | 'none'> {
  const chain = installed;
  if (chain === null) return 'none';
  const vault = host.keystore.addresses().evm?.toLowerCase() ?? null;
  if (vault === null) return 'none';
  const box = boxOf(host);
  const record = readRecord(host.dataDir, vault);
  const current = host.prefs.get().chip;
  const named = current !== null && current.account === vault;
  // The common cases ask nothing: a vault that moved, or one with no move of it under way and no
  // chip of this Mac's pinned to it.
  if (named && record?.status !== 'moving') return 'done';
  if (record?.status !== 'moving' && host.relay.chipMarkers(vault).length === 0) return named ? 'done' : 'none';
  await chain.submitter.settle(vault).catch(() => undefined);
  const status = await chipStatusAll(host.relay);
  if ('code' in status) return named ? 'done' : record?.status === 'moving' ? 'moving' : 'none';
  const old = knownOld(host, box, vault);
  for (const c of status.chips) {
    if (c.marker === null || c.publicKey === '' || c.marker.account.toLowerCase() !== vault) continue;
    const recovery = c.marker.recovery;
    const read = await readVault(chain.verifier, vault, [c.publicKey, recovery, ...(old === null ? [] : [old])]);
    if (read === null || read.has.get(c.publicKey) !== true || read.has.get(recovery) !== true) continue;
    // The chip vault.json names is still on the vault: look on for a newer one a restore put there,
    // unless the record shows a move to this very chip that a crash left open.
    const closes = record?.status === 'moving' && record.chip?.keyRef === c.keyRef;
    if (named && current.keyRef === c.keyRef && !closes) continue;
    // This chip and its paper are on the vault: it is the vault's chip now.
    await finish(host, chain, vault, { keyRef: c.keyRef, publicKey: c.publicKey }, recovery, record?.kind ?? null);
    const confirmed = read.predecessorAuth === false && (old === null || read.has.get(old) === false);
    if (report && box.run !== null && active(box.run)) say(host, box.run.id, confirmed ? 'done' : 'failed', confirmed ? undefined : 'vault_mismatch');
    return 'done';
  }
  if (chain.submitter.pending(vault).some((e) => e.state === 'released' || e.state === 'sent')) keepChecking(host);
  if (named) return 'done';
  return record !== null && (record.status === 'moving' || record.status === 'proven') ? 'moving' : 'none';
}

// A move whose call is out and unconfirmed is checked again, in the background, until it settles.
function keepChecking(host: RekeyHost): void {
  const box = boxOf(host);
  if (box.poll !== null) return;
  box.poll = setTimeout(() => {
    box.poll = null;
    void resumeChip(host)
      .then(() => {
        const vault = host.keystore.addresses().evm?.toLowerCase();
        const waiting = vault !== undefined && installed !== null && installed.submitter.pending(vault).some((e) => e.state === 'released' || e.state === 'sent');
        if (waiting) keepChecking(host);
        else if (box.run !== null && box.run.status === 'checking') say(host, box.run.id, 'failed', 'vault_settling');
      })
      .catch(() => undefined);
  }, installed?.pollMs ?? RESUME_POLL_MS);
  box.poll.unref?.();
}

// ---------- what the Vault tab shows ----------

export type ChipSlice = {
  state: 'none' | 'ready' | 'moving' | 'done' | 'broken';
  recoveryOnChain: boolean | null;
  oldOnChain: boolean | null;
  predecessorAuth: boolean | null;
  allowance: { account: string; sizeUsd: number; balanceUsd: number | null } | null;
  gas: { account: string; near: string | null; low: boolean | null } | null;
  // What the move still needs before it can start: an open wallet, Touch ID, Phosphor's keychain,
  // a proven backup, NEAR in the gas account.
  needs: string[];
  // Where the paper step is: none, shown (waiting for the type-back), proven, retype (proven before
  // a restart: type it again), void (shown before a restart and never proven: it opens nothing).
  paper: 'none' | 'shown' | 'proven' | 'retype' | 'void';
  run: { id: string; kind: RekeyKind; status: RunStatus; reason: string | null } | null;
  // What the vault's Touch ID key pins, for the done screen: all public.
  pins: { vault: string; allowance: string | null; recovery: string } | null;
};

/* The slice for /api/state (src/http/state.ts). Synchronous: it reads what was last read from the
   chain, and asks again in the background when that is older than VIEW_FRESH_MS. */
export function chipSlice(host: RekeyHost, allowance: (accounts: { allowance: string | null }) => ChipSlice['allowance']): ChipSlice {
  const chain = installed;
  const vault = host.keystore.addresses().evm?.toLowerCase() ?? null;
  const prefs = host.prefs.get();
  const moved = vault !== null && prefs.chip !== null && (prefs.chip.account === '' || prefs.chip.account === vault);
  const box = boxOf(host);
  if (chain === null || vault === null) {
    return { state: moved ? 'done' : 'none', recoveryOnChain: null, oldOnChain: null, predecessorAuth: null, allowance: null, gas: null, needs: [], paper: 'none', run: null, pins: null };
  }
  if (chain.reads === true && box.refreshing === null && (box.view.vault !== vault || box.askedAt === 0 || clock() - box.askedAt > VIEW_FRESH_MS)) {
    box.askedAt = clock();
    box.refreshing = refreshView(host, chain, vault)
      .catch(() => undefined)
      .finally(() => {
        box.refreshing = null;
      });
  }
  const view = box.view.vault === vault ? box.view : emptyView();
  const accounts = chain.accounts.accounts();
  const record = readRecord(host.dataDir, vault);
  const needs: string[] = [];
  if (!host.keystore.isUnlocked()) needs.push('open');
  if (host.keystore.custody() !== 'secure-enclave' || !host.relay.enclaveReady()) needs.push('touch_id');
  if (host.relay.capability()?.keychainHome !== true) needs.push('keychain');
  if (!host.backedUp()) needs.push('backup');
  if (view.gas === null || view.gas.low !== false) needs.push('gas');
  let state: ChipSlice['state'];
  if (accounts.kind === 'chip') state = 'done';
  else if (accounts.kind === 'broken') state = 'broken';
  else if (active(box.run) || record?.status === 'moving') state = 'moving';
  else if (view.old === false) state = 'broken';
  else state = needs.length === 0 ? 'ready' : 'none';
  const paper: ChipSlice['paper'] =
    box.paper !== null && box.paper.wallet === vault
      ? 'proven'
      : box.phrase !== null && box.phrase.wallet === vault
        ? 'shown'
        : record !== null && record.recovery !== null && (record.status === 'proven' || record.status === 'moving')
          ? 'retype'
          : record !== null && record.phraseAt !== null && record.recovery === null
            ? 'void'
            : 'none';
  return {
    state,
    recoveryOnChain: view.recovery,
    oldOnChain: view.old,
    predecessorAuth: view.predecessor,
    allowance: accounts.allowance === null ? null : allowance({ allowance: accounts.allowance }),
    gas: view.gas === null ? null : { account: view.gas.account, near: view.gas.amount === null ? null : nearText(view.gas.amount), low: view.gas.low },
    needs,
    paper,
    run: box.run === null ? null : { id: box.run.id, kind: box.run.kind, status: box.run.status, reason: box.run.reason ?? null },
    pins: record !== null && record.status === 'done' && record.recovery !== null ? { vault, allowance: accounts.allowance, recovery: record.recovery } : null,
  };
}

// The chain facts the slice shows, read at one block, and the gas account's balance.
async function refreshView(host: RekeyHost, chain: ChipVaultChain, vault: string): Promise<void> {
  const box = boxOf(host);
  if (!active(box.run)) await resumeChip(host).catch(() => undefined);
  const record = readRecord(host.dataDir, vault);
  const prefs = host.prefs.get();
  const pinned = prefs.chip === null ? null : (host.relay.chipMarkers(vault).find((m) => m.publicKey === prefs.chip?.publicKey)?.recovery ?? null);
  const recovery = pinned ?? (record?.status === 'done' ? record.recovery : null);
  const old = knownOld(host, box, vault);
  const keys = [...(recovery === null ? [] : [recovery]), ...(old === null ? [] : [old])];
  const read = await readVault(chain.verifier, vault, keys);
  const gasAccount = gasAccountOf(host.keystore);
  const gas = gasAccount === null ? null : { account: gasAccount, ...(await readGas(gasAccount, chain.near)) };
  const next: ChipView = {
    vault,
    at: clock(),
    recovery: recovery === null || read === null ? null : (read.has.get(recovery) ?? null),
    old: old === null || read === null ? null : (read.has.get(old) ?? null),
    predecessor: read === null ? null : read.predecessorAuth,
    gas,
  };
  const before = JSON.stringify(box.view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  box.view = next;
  if (JSON.stringify(next, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== before) host.changed();
}

/* For a test: whether the paper key held right now is zeroed later, without handing the key out.
   The probe keeps the buffer it saw and answers only whether every byte of it is zero. */
export function paperProbe(keystore: object): (() => boolean) | null {
  const key = boxes.get(keystore)?.paper?.key ?? null;
  return key === null ? null : () => key.every((b) => b === 0);
}
