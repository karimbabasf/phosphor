// Sending a vault bundle, and knowing what became of it (PHASE2-PLAN C7; CONTRACTS.md, "Lead's
// call: nonce lifetime and settling a submit").
//
// A vault bundle is one or more signed payloads for one account (at most eight): a top-up the chip
// signed, a rekey's three, a paper key's own move. It goes to the NEAR Intents solver relay in one
// publish_intents call with no quote (src/relay/client.ts), which puts it on chain in one call, in
// order, and pays NEAR's fee, as it does for swaps. The relay can delay a bundle or drop it; it
// cannot change it, because every payload in it is signed. A dropped bundle settles dead after its
// deadline (below), and the move can then be sent again with new nonces. Done is what NEAR's views
// say, never what the relay says.
//
// BEFORE ANYTHING IS SENT the verifier simulates this exact bundle and must report exactly the
// events it has to make (src/vault/payload.ts, expectedEvents), payload by payload. One changed,
// missing or extra event and nothing is sent. Every payload is held first to the app's own rule
// (readVaultPayload: the shape, one account, the seven-day nonce), so nothing built by hand goes out.
//
// EXECUTED IS NOT DONE. Done is what the views say at one final block afterwards: every payload's
// nonce spent, and the caller's own checks there (for a rekey: the chip and the paper key on the
// vault, the old key off, predecessor auth off), with the balances it asked for read at that block.
// A bundle of which only some payloads ran is never done: its other nonces never read spent.
//
// ONE SIGNATURE PER MOVE. A signed bundle that left this Mac can run until its own deadline,
// whatever came back: simulate_intents hands it to the RPC, a FAILED answer from the relay does not
// prove the relay never sent it, and a timeout or a lost reply can hide a copy that ran. So a bundle
// is written down (the journal) before it leaves, and no new signature for that account is asked
// for until every bundle written down for it is settled:
//   ran: every nonce reads spent at one final block. The relay's SETTLED names the NEAR
//     transaction that carried it, a hint for the row; the nonces decide.
//   dead: NEAR's final block and this Mac's clock are both two minutes past the last deadline, and
//     at that one block every nonce reads unspent while its salt is still valid and its own
//     seven-day life runs. The verifier cleans a nonce only once its salt is gone or its life is
//     over, and a cleaned nonce reads unspent even when it ran (garbage_collector.rs), so those two
//     are what make "unspent" mean "never ran".
//   unknown: past the deadline and two minutes, so it can never run again, but whether it ran can
//     no longer be proved: its salt was taken out, or its nonce's own seven-day life is over. It no
//     longer holds other moves back; its own move is never signed again by the app, and the person
//     is told to check the balances first.
//   anything else waits, and nothing is signed.
// A move signed again after `dead` is a new bundle with fresh nonces; the same bundle is never
// signed twice. Nothing here re-signs: the caller's sign() runs at most once per attempt, and only
// when the journal is clear. The journal is crash safety for this app, not a control: a process that
// can write the data folder can delete it.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '../fsatomic.ts';
import type { MultiPayload, RelayBundleClient } from '../relay/client.ts';
import { FATE_AHEAD_MAX_MS } from '../relay/fate.ts';
import { decodeNonce } from '../relay/payload.ts';
import type { FinalBlock, VerifierPort } from '../relay/verifier.ts';
import { oneLine } from '../venue-words.ts';
import { CHIP_PAYLOAD_LIFE_MS } from './chip.ts';
import { eventsMismatch, expectedEvents, readVaultPayload } from './payload.ts';
import type { BundleBefore } from './payload.ts';

/* How far past a bundle's last deadline NEAR's final block and this Mac's clock must both be before
   an unspent nonce counts as never ran (C7: deadline + 2 min). The final block trails real time by
   about 2.6 s; the rest keeps a node a little behind, or a clock a little fast, on the safe side. */
export const VAULT_SETTLE_FLOOR_MS = 2 * 60_000;

/* The furthest past this Mac's clock a deadline of a bundle this app wrote can lie: every vault
   payload is signed to live CHIP_PAYLOAD_LIFE_MS from its own build, and a minute covers a clock
   that moved since. A bundle with a later deadline is not the app's (a journal file someone else
   wrote): its fate is never waited on, so it holds no move and no agent back (audit2 AU2-07). */
export const FOREIGN_DEADLINE_MS = CHIP_PAYLOAD_LIFE_MS + 60_000;

export function foreignBundle(entry: Pick<JournalEntry, 'signed'>, nowMs: number): boolean {
  return entry.signed.some((s) => {
    try {
      return Date.parse(String((JSON.parse(s.payload) as { deadline?: unknown }).deadline)) > nowMs + FOREIGN_DEADLINE_MS;
    } catch {
      return false;
    }
  });
}

// The most payloads one bundle carries: a rekey's three is the most a vault move signs.
const MAX_PAYLOADS = 8;

/* After the relay took a bundle: how long it is watched for, first a quarter second after the
   publish, doubling to three seconds apart. A relay call lands in a block or two; past a minute the
   payloads are near their own deadline and the nonces settle it. */
const LAND_FIRST_MS = 250;
const LAND_PAUSE_MS = 3_000;
const LAND_WAIT_MS = 60_000;

// After every nonce read spent, how often and how long the views are read before the window is told
// to keep checking: a load-balanced RPC can answer from a node a block or two behind.
const CONFIRM_TRIES = 4;
const CONFIRM_PAUSE_MS = 1500;

// How long a bundle that is settled but not done (it ran unconfirmed, ran in part, or its fate is
// unknown) stays written down for its move to come back to.
const SETTLED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- what a move is checked against ----------

/* A view read at the block that shows the bundle ran. `is` is what it must read; anything else
   stops the window short of done. */
export type ViewCheck =
  | { view: 'hasPublicKey'; account: string; publicKey: string; is: boolean }
  | { view: 'predecessorAuth'; account: string; is: boolean };

export type BalanceRead = { account: string; asset: string };
export type BalanceSeen = BalanceRead & { amount: bigint | null };

/* C7's rekey views: the chip and the paper key on the vault, the old key off it, and predecessor
   auth off (risk 1, F1). The old key is asked by name: public_keys_of never lists a 0x account's
   own key. */
export function rekeyViews(keys: { vault: string; chip: string; recovery: string; old: string }): ViewCheck[] {
  return [
    { view: 'hasPublicKey', account: keys.vault, publicKey: keys.chip, is: true },
    { view: 'hasPublicKey', account: keys.vault, publicKey: keys.recovery, is: true },
    { view: 'hasPublicKey', account: keys.vault, publicKey: keys.old, is: false },
    { view: 'predecessorAuth', account: keys.vault, is: false },
  ];
}

// ---------- results ----------

/* `code` has a sentence in src/http/wallet.ts REFUSALS; `detail` is the log line. `released` says
   whether the signed bundle left this Mac (it did once simulate was asked), which is why a refusal
   can still be written down and settled. */
export type VaultResult =
  | { state: 'refused'; code: string; detail: string; released: boolean }
  | { state: 'settling'; code: 'vault_settling'; detail: string; notBefore: number | null }
  | { state: 'sent'; code: 'vault_pending'; txHash: string | null; detail: string }
  | { state: 'checking'; code: 'vault_checking'; txHash: string | null; detail: string }
  | { state: 'mismatch'; code: 'vault_mismatch'; txHash: string | null; detail: string }
  | { state: 'unknown'; code: 'vault_unknown'; txHash: string | null; detail: string }
  | { state: 'done'; txHash: string | null; block: FinalBlock; balances: BalanceSeen[] };

// ---------- the journal ----------

/* `released`: it left this Mac (simulate was asked) and did not reach the relay. `sent`: it was
   handed to the relay, with no final answer that it ran. `executed`: it ran, and its move has not
   seen the views say done. `partial`: some of its payloads ran and the rest never can. `unknown`: it
   can never run again and whether it ran cannot be proved. Only `released` and `sent` hold a new
   signature back. An entry 0.10.16 wrote carries `gas` (the old fee account, which sent it then)
   and that account's own transactions in `txHashes`, and settles by its nonces like any other. */
export type JournalEntry = {
  id: string; // the move's own id: a proposal id, a rekey run
  account: string; // the signer, lowercase
  signed: MultiPayload[]; // exactly as signed
  intentHashes?: string[]; // the relay's hash for each payload, once it took the bundle
  txHashes: string[]; // the NEAR transaction that carried it, once known
  gas?: string; // 0.10.16 only: the old fee account that sent it
  state: 'released' | 'sent' | 'executed' | 'partial' | 'unknown';
  at: number; // when it was written down
  settledAt?: number; // when it became executed, partial or unknown
  why?: string; // for `unknown`: what made its fate unprovable
};

export type VaultJournal = {
  list(): JournalEntry[];
  put(entry: JournalEntry): void;
  drop(id: string): void;
};

export function memoryJournal(): VaultJournal {
  const entries = new Map<string, JournalEntry>();
  return {
    list: () => [...entries.values()].map((e) => structuredClone(e)),
    put: (entry) => void entries.set(entry.id, structuredClone(entry)),
    drop: (id) => void entries.delete(id),
  };
}

function isEntry(raw: unknown): raw is JournalEntry {
  if (raw === null || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const signed = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((s) => s !== null && typeof s === 'object' && !Array.isArray(s) && Object.values(s as object).every((x) => typeof x === 'string') && typeof (s as MultiPayload).payload === 'string');
  return (
    typeof e.id === 'string' &&
    typeof e.account === 'string' &&
    (e.gas === undefined || typeof e.gas === 'string') &&
    signed(e.signed) &&
    (e.intentHashes === undefined || strings(e.intentHashes)) &&
    strings(e.txHashes) &&
    (e.state === 'released' || e.state === 'sent' || e.state === 'executed' || e.state === 'partial' || e.state === 'unknown') &&
    typeof e.at === 'number' &&
    (e.settledAt === undefined || typeof e.settledAt === 'number') &&
    (e.why === undefined || typeof e.why === 'string')
  );
}

/* The journal on disk (state/vault-moves.json beside vault.json), written whole on every change. A
   file it cannot read reads as empty: it is crash safety for an honest process, and a process that
   can damage it can as well delete it. */
export function fileJournal(file: string): VaultJournal {
  function read(): JournalEntry[] {
    try {
      const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; entries?: unknown };
      return body.v === 1 && Array.isArray(body.entries) ? body.entries.filter(isEntry) : [];
    } catch {
      return [];
    }
  }
  function write(entries: JournalEntry[]): void {
    atomicWrite(file, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  }
  return {
    list: read,
    put(entry) {
      write([...read().filter((e) => e.id !== entry.id), entry]);
    },
    drop(id) {
      const entries = read();
      if (entries.some((e) => e.id === id)) write(entries.filter((e) => e.id !== id));
    },
  };
}

export function journalPathFor(dataDir: string): string {
  return path.join(dataDir, 'vault-moves.json');
}

// ---------- the relay's word ----------

export type RelayWord = { txHash: string | null; dropped: boolean };

/* What the relay says about the intents of a bundle it took: the NEAR transaction that carried them
   once one is SETTLED, and whether it says NOT_FOUND_OR_NOT_VALID for one. A hint and nothing more:
   no answer is no word, and what ran is what the nonces say. */
export async function relayWord(relay: Pick<RelayBundleClient, 'status'> | undefined, intentHashes: readonly string[] | undefined): Promise<RelayWord> {
  const word: RelayWord = { txHash: null, dropped: false };
  if (relay === undefined) return word;
  for (const hash of intentHashes ?? []) {
    const s = await relay.status(hash).catch(() => null);
    if (s === null) continue;
    if (s.status === 'SETTLED' && s.nearTxHash !== null) word.txHash ??= s.nearTxHash;
    if (s.status === 'NOT_FOUND_OR_NOT_VALID') word.dropped = true;
  }
  return word;
}

// ---------- settling what was written down ----------

export type Settlement =
  // `txHash`: the NEAR transaction the relay says carried it, when it said so.
  | { verdict: 'ran'; txHash?: string }
  | { verdict: 'dead'; block: FinalBlock }
  // Some payloads ran and the rest never can: a relay that ran only part of the bundle, or someone
  // running part of it on their own. Never a done; the views say what the account is now.
  | { verdict: 'partial' }
  // Past the deadline and two minutes, so it can never run again, and nothing can prove whether it
  // ran: a salt taken out or a nonce past its own life (a cleaned nonce reads unspent either way).
  | { verdict: 'unknown'; why: string }
  | { verdict: 'wait'; why: string; notBefore: number | null };

type Part = { nonce: string; deadlineMs: number; nonceDeadlineMs: number; salt: Uint8Array };

function partsOf(entry: JournalEntry): Part[] | null {
  const parts: Part[] = [];
  for (const s of entry.signed) {
    let body: { nonce: string; deadline: string };
    try {
      body = JSON.parse(s.payload) as { nonce: string; deadline: string };
    } catch {
      return null;
    }
    const nonce = decodeNonce(body.nonce);
    const deadlineMs = Date.parse(body.deadline);
    if (nonce === null || !Number.isFinite(deadlineMs)) return null;
    parts.push({ nonce: body.nonce, deadlineMs, nonceDeadlineMs: nonce.deadlineMs, salt: nonce.salt });
  }
  return parts;
}

export type SettleDeps = {
  verifier: VerifierPort;
  relay?: Pick<RelayBundleClient, 'status'>;
  now?: () => number;
};

/* What became of one bundle written down. The order is the lead's: the relay's word on each intent
   first (a hint), then the nonces at one final block, which decide, and "never ran" only past the
   deadline, with every salt valid and every nonce inside its own life at that same block. */
export async function settleEntry(entry: JournalEntry, deps: SettleDeps): Promise<Settlement> {
  const wait = (why: string, notBefore: number | null = null): Settlement => ({ verdict: 'wait', why, notBefore });
  if (entry.state === 'executed') return { verdict: 'ran' };
  if (entry.state === 'partial') return { verdict: 'partial' };
  if (entry.state === 'unknown') return { verdict: 'unknown', why: entry.why ?? 'its fate could not be proved' };
  const parts = partsOf(entry);
  // Not a bundle this app wrote down: nothing to wait for.
  if (parts === null) return { verdict: 'unknown', why: 'the bundle written down does not read as vault payloads' };
  if (foreignBundle(entry, (deps.now ?? Date.now)())) return { verdict: 'unknown', why: 'a deadline lies further ahead than any bundle this app writes, so the bundle is not the app\'s' };
  const hint = entry.txHashes.length === 0 ? await relayWord(deps.relay, entry.intentHashes) : { txHash: null, dropped: false };
  const { verifier } = deps;
  const now = (deps.now ?? Date.now)();
  const block = verifier.finalBlock === undefined ? null : await verifier.finalBlock().catch(() => null);
  if (block === null) return wait('NEAR did not say which block is final');
  if (block.atMs > now + FATE_AHEAD_MAX_MS) return wait('the final block is stamped too far ahead of this clock to be believed');
  const used = await Promise.all(parts.map((p) => verifier.nonceUsed(entry.account, p.nonce, block.hash).catch(() => null)));
  if (used.some((u) => u === null)) return wait('the verifier did not say whether every nonce is spent');
  if (used.every((u) => u === true)) return hint.txHash === null ? { verdict: 'ran' } : { verdict: 'ran', txHash: hint.txHash };
  const notBefore = Math.max(...parts.map((p) => p.deadlineMs)) + VAULT_SETTLE_FLOOR_MS;
  if (block.atMs <= notBefore || now < notBefore) {
    return wait(hint.txHash === null ? 'the bundle can still run: its deadline and two minutes have not passed' : 'the relay says it settled, and NEAR does not show every nonce spent yet', notBefore);
  }
  for (const [i, p] of parts.entries()) {
    if (used[i]) continue;
    if (block.atMs > p.nonceDeadlineMs) return { verdict: 'unknown', why: 'a nonce is past its own life, so unspent no longer means never ran' };
    const salt = verifier.isValidSalt === undefined ? null : await verifier.isValidSalt(p.salt, block.hash).catch(() => null);
    if (salt === false) return { verdict: 'unknown', why: 'a nonce salt was taken out, so unspent no longer means never ran' };
    if (salt !== true) return wait('the verifier did not say whether a nonce salt is valid');
  }
  return used.some((u) => u === true) ? { verdict: 'partial' } : { verdict: 'dead', block };
}

// ---------- the submitter ----------

export type VaultMove = {
  id: string; // stable across tries: the same move asked again is settled, never signed again while it may run
  account: string; // whose signatures the bundle carries
  /* Builds the payloads (fresh nonces, src/vault/payload.ts) and gets every signature, Touch IDs
     included. Called at most once per call of move(), and only when nothing written down for the
     account can still run. `before` is what was read before signing (the predecessor flag, when the
     bundle sets it). */
  sign(): Promise<{ ok: true; bundle: MultiPayload[]; before: BundleBefore } | { ok: false; code: string; detail: string }>;
  views?: ViewCheck[];
  balances?: BalanceRead[];
};

export type VaultSubmitDeps = {
  verifier: VerifierPort;
  // The solver relay: publish_intents for the bundle, get_status for its intents.
  relay: RelayBundleClient;
  journal: VaultJournal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type VaultSubmitter = {
  // One move: settle what earlier tries left, then sign at most once and send.
  move(move: VaultMove): Promise<VaultResult>;
  // Settles what is written down for an account (or all of them) without signing anything.
  settle(account?: string): Promise<{ id: string; settlement: Settlement }[]>;
  pending(account?: string): JournalEntry[];
};

export function createVaultSubmitter(deps: VaultSubmitDeps): VaultSubmitter {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { verifier, relay, journal } = deps;
  const settleDeps: SettleDeps = { verifier, relay, now };

  // One move at a time per account, so two windows cannot both find the journal clear.
  const turns = new Map<string, Promise<unknown>>();
  function exclusive<T>(account: string, run: () => Promise<T>): Promise<T> {
    const before = turns.get(account) ?? Promise.resolve();
    const mine = before.then(run, run);
    const tail = mine.catch(() => undefined);
    turns.set(account, tail);
    void tail.then(() => {
      if (turns.get(account) === tail) turns.delete(account);
    });
    return mine;
  }

  async function readView(check: ViewCheck, at: string): Promise<boolean | null> {
    const read =
      check.view === 'hasPublicKey'
        ? verifier.hasPublicKey?.(check.account, check.publicKey, at)
        : verifier.isAuthByPredecessorIdEnabled?.(check.account, at);
    return read === undefined ? null : read.catch(() => null);
  }

  /* After the call ran: the views at one final block, read again a few times while a node a block
     behind answers. Every nonce must read spent at that block before any view there is believed.
     Only done lets the entry go: a mismatch or a check still under way keeps it, so the same move
     asked again reads the views again and is never signed again. */
  async function confirm(entry: JournalEntry, move: VaultMove, txHash: string | null): Promise<VaultResult> {
    const parts = partsOf(entry) ?? [];
    let last = 'NEAR did not answer the reads';
    for (let attempt = 0; attempt < CONFIRM_TRIES; attempt += 1) {
      if (attempt > 0) await sleep(CONFIRM_PAUSE_MS);
      const block = verifier.finalBlock === undefined ? null : await verifier.finalBlock().catch(() => null);
      if (block === null) continue;
      const spent = await Promise.all(parts.map((p) => verifier.nonceUsed(entry.account, p.nonce, block.hash).catch(() => null)));
      if (spent.length === 0 || spent.some((s) => s !== true)) {
        last = 'the verifier does not yet show every nonce spent';
        continue;
      }
      const checks = move.views ?? [];
      const seen = await Promise.all(checks.map((c) => readView(c, block.hash)));
      if (seen.some((s) => s === null)) {
        last = 'a view did not answer';
        continue;
      }
      const wrong = checks.findIndex((c, i) => seen[i] !== c.is);
      if (wrong !== -1) {
        const c = checks[wrong]!;
        const what = c.view === 'hasPublicKey' ? `has_public_key ${c.publicKey} on ${c.account}` : `is_auth_by_predecessor_id_enabled on ${c.account}`;
        return { state: 'mismatch', code: 'vault_mismatch', txHash, detail: `the call ran, but ${what} reads ${seen[wrong]} where ${c.is} was expected` };
      }
      const balances = await Promise.all(
        (move.balances ?? []).map(async (b) => ({ ...b, amount: await verifier.balance(b.account, b.asset, block.hash).catch(() => null) })),
      );
      journal.drop(entry.id);
      return { state: 'done', txHash, block, balances };
    }
    return { state: 'checking', code: 'vault_checking', txHash, detail: last };
  }

  /* After the relay took the bundle: NEAR's final block, read again until every nonce in it reads
     spent there, the relay's word riding along (SETTLED names the transaction for the row,
     NOT_FOUND_OR_NOT_VALID ends the wait early). Only the nonces move the entry to executed; with
     none of that inside the wait the move stays sent, held back until its nonces settle it. */
  async function land(entry: JournalEntry, move: VaultMove): Promise<VaultResult> {
    const parts = partsOf(entry) ?? [];
    let txHash: string | null = null;
    let last = 'the relay took the move, and NEAR does not show it yet';
    const started = now();
    for (let round = 0; now() - started < LAND_WAIT_MS; round += 1) {
      await sleep(Math.min(LAND_FIRST_MS * 2 ** round, LAND_PAUSE_MS));
      // Once the relay named the transaction, only the nonces are left to read.
      const word: RelayWord = txHash === null ? await relayWord(relay, entry.intentHashes) : { txHash, dropped: false };
      txHash = word.txHash;
      const block = verifier.finalBlock === undefined ? null : await verifier.finalBlock().catch(() => null);
      const spent = block === null ? [] : await Promise.all(parts.map((p) => verifier.nonceUsed(entry.account, p.nonce, block.hash).catch(() => null)));
      if (parts.length > 0 && spent.length === parts.length && spent.every((s) => s === true)) {
        entry.state = 'executed';
        entry.settledAt = now();
        if (txHash !== null) entry.txHashes.push(txHash);
        try {
          journal.put(entry);
        } catch {
          // The entry as it was put still holds every new signature back until it is settled.
        }
        return confirm(entry, move, txHash);
      }
      if (word.dropped) {
        last = 'the relay says it does not hold the move; NEAR settles it by its nonces once its deadline has passed';
        break;
      }
    }
    return { state: 'sent', code: 'vault_pending', txHash, detail: last };
  }

  /* The gate before the send, then the send. The entry is written down before simulate is asked,
     because simulate already hands the signed bundle to the RPC. `retired` holds the nonces of this
     move's earlier bundle, proved dead a moment ago, so a move signed again is held to fresh ones. */
  async function send(move: VaultMove, account: string, given: MultiPayload[], before: BundleBefore, retired: ReadonlySet<string>): Promise<VaultResult> {
    // One frozen copy is checked, written down, simulated and sent: nothing can change in between.
    const signed: MultiPayload[] = given.map((s) => Object.freeze({ ...s }));
    let expected;
    try {
      if (signed.length === 0 || signed.length > MAX_PAYLOADS) throw new Error(`a vault bundle carries 1 to ${MAX_PAYLOADS} payloads, not ${signed.length}`);
      const seen = new Set([...retired, ...journal.list().flatMap((e) => (partsOf(e) ?? []).map((p) => p.nonce))]);
      for (const s of signed) {
        const body = readVaultPayload(s.payload);
        if (body.signer_id !== account) throw new Error('a payload signs for another account than the move');
        if (seen.has(body.nonce)) throw new Error('a payload reuses a nonce already signed: a move signed again gets fresh nonces');
        seen.add(body.nonce);
      }
      expected = expectedEvents(signed, before);
    } catch (err) {
      return { state: 'refused', code: 'vault_bundle', detail: oneLine(err instanceof Error ? err.message : err, 300), released: false };
    }
    if (verifier.simulate === undefined) return { state: 'refused', code: 'simulate_unavailable', detail: 'this verifier port cannot simulate', released: false };
    const entry: JournalEntry = { id: move.id, account, signed, txHashes: [], state: 'released', at: now() };
    try {
      journal.put(entry);
    } catch (err) {
      return { state: 'refused', code: 'vault_journal', detail: oneLine(err instanceof Error ? err.message : err, 200), released: false };
    }

    const sim = await verifier.simulate(signed).catch(() => null);
    if (sim === null) return { state: 'refused', code: 'simulate_unavailable', detail: 'the verifier did not answer the simulation', released: true };
    if (!sim.ok) return { state: 'refused', code: 'simulate_refused', detail: sim.refusal, released: true };
    const mismatch = eventsMismatch(sim.events, expected);
    if (mismatch !== null) return { state: 'refused', code: 'events_mismatch', detail: mismatch, released: true };

    // One publish, in the bundle's order, never again: a FAILED answer or none at all does not
    // prove the relay never sent it, so the nonces settle it either way.
    let published: { ok: true; intentHashes: string[] } | { ok: false; why: string };
    try {
      const answer = await relay.publishIntents(signed);
      published = answer.status === 'OK' ? { ok: true, intentHashes: answer.intentHashes } : { ok: false, why: `the relay did not take the move: ${answer.reason}` };
    } catch (err) {
      published = { ok: false, why: `the relay did not answer the publish: ${oneLine(err instanceof Error ? err.message : err, 200)}` };
    }
    entry.state = 'sent';
    if (published.ok) entry.intentHashes = published.intentHashes;
    // A write that fails here leaves the entry as it was put before the bundle left, which still
    // holds every new signature back until it is settled by its nonces.
    try {
      journal.put(entry);
    } catch {
      // The answer below is what happened; the earlier entry keeps the account safe.
    }
    if (!published.ok) return { state: 'sent', code: 'vault_pending', txHash: null, detail: published.why };
    return land(entry, move);
  }

  /* Settles what is written down: a bundle that ran becomes `executed`, part of one `partial`, one
     whose fate cannot be proved `unknown`, and a dead one is let go. A settled one whose move has
     not come back a week after it settled is let go. */
  async function settleAccount(account: string | undefined): Promise<{ entry: JournalEntry; settlement: Settlement }[]> {
    const out: { entry: JournalEntry; settlement: Settlement }[] = [];
    for (const entry of journal.list()) {
      if (account !== undefined && entry.account !== account) continue;
      if ((entry.state === 'executed' || entry.state === 'partial' || entry.state === 'unknown') && now() - (entry.settledAt ?? entry.at) > SETTLED_KEPT_MS) {
        journal.drop(entry.id);
        continue;
      }
      const settlement = await settleEntry(entry, settleDeps);
      if (settlement.verdict === 'ran' && entry.state !== 'executed') {
        if (settlement.txHash !== undefined) entry.txHashes = [settlement.txHash];
        journal.put({ ...entry, state: 'executed', settledAt: now() });
      }
      if (settlement.verdict === 'partial' && entry.state !== 'partial') journal.put({ ...entry, state: 'partial', settledAt: now() });
      if (settlement.verdict === 'unknown' && entry.state !== 'unknown') journal.put({ ...entry, state: 'unknown', settledAt: now(), why: settlement.why });
      if (settlement.verdict === 'dead') journal.drop(entry.id);
      out.push({ entry, settlement });
    }
    return out;
  }

  async function move(spec: VaultMove): Promise<VaultResult> {
    const account = spec.account.toLowerCase();
    const retired = new Set<string>();
    const settled = await settleAccount(account);
    // This move's own bundle first: what it says is the answer, and nothing is signed again.
    const own = settled.find((s) => s.entry.id === spec.id);
    if (own !== undefined) {
      const { entry, settlement } = own;
      const txHash = entry.txHashes.at(-1) ?? null;
      if (settlement.verdict === 'ran') return confirm(entry, spec, txHash);
      if (settlement.verdict === 'partial') return { state: 'mismatch', code: 'vault_mismatch', txHash, detail: 'only part of this move ran, and the rest never can' };
      if (settlement.verdict === 'unknown') return { state: 'unknown', code: 'vault_unknown', txHash, detail: settlement.why };
      if (settlement.verdict === 'wait') return { state: 'settling', code: 'vault_settling', detail: `this move: ${settlement.why}`, notBefore: settlement.notBefore };
      // Dead: it never ran and never can, so the move may be signed again, with fresh nonces.
      for (const p of partsOf(entry) ?? []) retired.add(p.nonce);
    }
    const waiting = settled.find((s) => s.settlement.verdict === 'wait');
    if (waiting !== undefined && waiting.settlement.verdict === 'wait') {
      return { state: 'settling', code: 'vault_settling', detail: `an earlier vault move: ${waiting.settlement.why}`, notBefore: waiting.settlement.notBefore };
    }
    // A sign() that throws signed nothing that left this Mac.
    const signing = await spec.sign().catch((err: unknown) => ({ ok: false as const, code: 'vault_bundle', detail: oneLine(err instanceof Error ? err.message : err, 200) }));
    if (!signing.ok) return { state: 'refused', code: signing.code, detail: signing.detail, released: false };
    return send(spec, account, signing.bundle, signing.before, retired);
  }

  return {
    move: (spec) => exclusive(spec.account.toLowerCase(), () => move(spec)),
    async settle(account) {
      const settled = await settleAccount(account?.toLowerCase());
      return settled.map(({ entry, settlement }) => ({ id: entry.id, settlement }));
    },
    pending: (account) => journal.list().filter((e) => account === undefined || e.account === account.toLowerCase()),
  };
}
