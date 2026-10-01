// The claim: an invite code's money, moved into this wallet. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The claim, step by step" and
// "Plan B: the 1Click route". The routes are src/http/invite.ts.
//
// THE SEQUENCE, one signature per route, and the person's own key never signs anything:
//   1. parse the code (src/invite/code.ts) and derive its key and its account;
//   2. read the account: it must hold USDC, and NEAR Intents must not have locked it;
//   3. read current_salt and the final block, refused when the block is stamped more than
//      FATE_AHEAD_MAX_MS ahead of this Mac's clock, and build the V1 nonce and a deadline past
//      the CHAIN's clock;
//   4. one `transfer` of everything the code holds to the wallet's DECRYPTED address, built and
//      read back as a stranger would (src/invite/payload.ts);
//   5. the REHEARSAL, the operator's pattern (scripts/invite/money.ts): that transfer signed with
//      a deadline one millisecond past the final block and simulated AT that block. The verifier
//      answers for the block, and every block that could run the rehearsal is stamped later, so
//      the NEAR RPC, which is someone else's computer, never holds claim bytes that can still run.
//      An RPC that lies about the time can stretch that millisecond to at most FATE_AHEAD_MAX_MS
//      past this Mac's clock, and even then the bytes pay only this wallet. Any refusal stops here;
//   6. the real claim, two minutes past the chain's clock, signed and sent to the solver relay
//      alone with an empty quote_hashes, never to a simulation: the identical bytes once more on
//      no reply, never a second signature. Every attempt, the rehearsals included, is on disk in
//      the pending record (src/invite/store.ts) before the key signs it, so a signature the record
//      does not name never exists, and a claim that stops early stays pending until the next start
//      proves each of them dead or spent;
//   7. the key dropped, since nothing more can be signed, then the watch, until the deadline plus
//      30 s on the chain's clock (src/relay/fate.ts).
//      PROOF IS THE CODE'S NONCE: is_nonce_used reads true at a final block. The verifier commits
//      the nonce in the same call that runs the transfer, and the transfer names this wallet, so
//      a spent nonce is the claim paid (the rule src/proposals/reconcile.ts already holds a relay
//      swap to). Never the relay's status word, never the wallet's balance, which a deposit
//      landing at the same moment would fool, and not the code's balance either: anyone can send
//      dust to a public code address, and a proof that needed the code at zero would call a paid
//      claim failed;
//   8. the audit line, the record marked done, refreshLedger, the frame.
//
// PLAN B, at run time. When the relay turns a claim away for auth or for a missing quote (its
// docs require a JWT it does not enforce today, src/relay/client.ts), the same claim goes
// through 1Click the way an in-Intents send does (src/rails/intents-spend.ts), with the code's
// key in place of the wallet's. It is weaker and is treated so: the receiver is not in the code's
// signature, only in the quote echo, so a claim on this route rests on 1Click delivering; it
// arrives about 0.25 percent short; its refunds go back to the code. Both routes sign a transfer
// of the code's whole balance, so at most one of them can ever execute.
//
// NEVER THE CODE. It is parsed into bytes, the bytes become a key inside a signer, and the bytes
// are wiped. No answer, frame, audit line, record or error carries it, and no reason quotes the
// input. One claim runs at a time. What cannot be wiped: the code as the request carried it and
// the key's hex inside viem's account are JavaScript strings. Nothing holds the code once the
// route has answered, or the key once the claim's last signature is made (seconds, not the
// minutes of the watch), and the runtime reuses their memory when it needs it; until then they sit
// in this process's heap, the same exposure the wallet's own key has while the wallet is open,
// worth at most one code (docs/security-model.md).

import crypto from 'node:crypto';

import type { Audit } from '../audit.ts';
import type { LockState } from '../keystore/index.ts';
import type { AddressReport } from '../keystore/store.ts';
import { ERC191_STANDARD } from '../intents-sign.ts';
import type { IntentsSignerPort } from '../intents-sign.ts';
import { baseUnits, decimalToBaseUnits, oneLine } from '../intents.ts';
import type { OneClickQuote, QuoteEcho } from '../intents.ts';
import { INTENTS_API_KEY_ENV, SIGNED_DEADLINE_MS, intentDeadline, intentNonce, intentsApi } from '../rails/intents-native.ts';
import type { IntentsApiPort } from '../rails/intents-native.ts';
import { spendFromIntents } from '../rails/intents-spend.ts';
import { SEND_MAX_LOSS_BPS, SEND_SLIPPAGE_BPS } from '../rails/intents-send.ts';
import { noReply } from '../rails/intents-submit.ts';
import { FIRST_POLL_MS } from '../rails/watch.ts';
import { relayClient } from '../relay/client.ts';
import type { RelayClient } from '../relay/client.ts';
import { FATE_AHEAD_MAX_MS, RELAY_DEADLINE_GRACE_MS, transferFate } from '../relay/fate.ts';
import type { FateReads } from '../relay/fate.ts';
import { liveVerifier } from '../relay/verifier.ts';
import type { FinalBlock, SignedIntent, VerifierPort } from '../relay/verifier.ts';
import { codeAddress, parseCode } from './code.ts';
import {
  CLAIM_DEADLINE_MS,
  INVITE_ASSET_DECIMALS,
  INVITE_ASSET_ID,
  INVITE_ASSET_SYMBOL,
  REHEARSAL_LIFE_MS,
  SIMULATION_SENTENCES,
  buildTransfersPayload,
  checkTransfersPayload,
  claimNonce,
  formatUsdc,
  intentHashOf,
  publishWithoutQuote,
  signingDeadline,
  simulationVerdict,
} from './payload.ts';
import { codeSigner, signerPort } from './signer.ts';
import type { KeySigner } from './signer.ts';
import { createClaimStore } from './store.ts';
import type { ClaimAttempt, ClaimRecord, ClaimRoute, ClaimStore } from './store.ts';

// The answers the two routes give, as CONTRACTS.md spells them.
export type InviteReason = 'typo' | 'empty' | 'offline' | 'locked' | 'busy' | 'wallet-locked';
export type CheckAnswer =
  | { ok: true; amount: string; asset: string; route: ClaimRoute; net: string }
  | { ok: false; reason: InviteReason };
export type ClaimAnswer = { ok: true; claim: string } | { ok: false; reason: InviteReason };

export type InviteStatus = 'running' | 'landed' | 'failed';
// The latest claim, for /api/state: never the code.
export type InviteState = { claim: string; status: InviteStatus; amount: string };

// Why a claim that was accepted did not land, one word, for the audit line and the record.
export type FailReason = 'offline' | 'empty' | 'locked' | 'expired' | 'refused' | 'refunded' | 'unconfirmed';

export const INVITE_FRAME = 'invite';

// 1Click's fee on a same-asset intents move, measured 2026-09-16 (src/rails/intents-send.ts): what
// the check step takes off when it says what lands on Plan B.
export const ONECLICK_FEE_BPS = 25n;

/* How long one watch may run on this Mac's clock before it says it could not tell. With a chain
   that answers, the watch ends well inside this, at the deadline plus 30 s; this bounds the case
   where the RPC does not answer at all: the longest signed deadline (Plan B's three minutes),
   then the grace src/relay/fate.ts gives this Mac's clock, then a minute. */
export const WATCH_CAP_MS = SIGNED_DEADLINE_MS + RELAY_DEADLINE_GRACE_MS + 60_000;

export type InviteNet = {
  verifier?: VerifierPort;
  relay?: RelayClient;
  oneclick?: IntentsApiPort;
  apiKey?: string;
  quoteKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: (bytes: number) => Uint8Array;
  // The signer a code's secret turns into: codeSigner (src/invite/signer.ts) unless a test watches it.
  signerOf?: (secret: Uint8Array) => KeySigner | null;
  firstPollMs?: number;
  pollMs?: number;
  watchCapMs?: number;
};

// The least a code must hold to be worth a claim: one cent. Dust sent to a used code's public
// address is not an invite.
export const MIN_CLAIM_BASE = 10_000n;

export type InviteDeps = InviteNet & {
  dataDir: string;
  // Demo mode moves nothing, anywhere, ever (docs/reference.md): a claim there is refused before
  // any read. A check is a read and still answers.
  movesMoney: boolean;
  audit: Pick<Audit, 'append'>;
  keystore: { state(): LockState; addressReport(): AddressReport };
  broadcast: (frame: unknown) => void;
  broadcastState: () => void;
  // The one refresh seam (refreshNow in src/main.ts), so the ring shows the money at once.
  refreshLedger: () => Promise<void>;
  /* The deposit watch's hold (src/vault/watch.ts), so a claim is never reported as a deposit.
     Opened right before the claim is sent, with the wallet's balance read a moment earlier. */
  hold?: (assetId: string, walletBefore: bigint | null) => (proven: bigint | null) => void;
  store?: ClaimStore;
};

export type InviteService = {
  check(code: unknown): Promise<CheckAnswer>;
  claim(code: unknown): Promise<ClaimAnswer>;
  state(): InviteState | null;
  // Moves whenever state() does, for the /api/state cache key.
  revision(): number;
  // The claims that landed, for Activity (src/transactions.ts).
  landed(): ClaimRecord[];
  // At boot: every claim still pending is watched to its end with the same proof.
  reconcile(): void;
  // Resolves once no claim and no reconcile is running. Tests, and nothing else, wait on it.
  idle(): Promise<void>;
};

type Landed = { kind: 'landed'; route: ClaimRoute; credited: bigint; intentHash: string; nearTx: string | null };
// The deposit watch's hold, opened once per claim right before the first send.
type HoldSlot = { release: ((proven: bigint | null) => void) | null };
type Failed = { kind: 'failed'; reason: FailReason; detail: string; final: boolean };
type Outcome = Landed | Failed | { kind: 'fallback'; detail: string };
type Verdict = Landed | Failed | { kind: 'waiting' };
type Clock = { kind: 'clock'; salt: Uint8Array; block: FinalBlock };
type Signed = { kind: 'signed'; signed: SignedIntent };

// How many final blocks a rehearsal tries before it gives up: a node a block behind the one it was
// asked about cannot answer for it.
const REHEARSAL_TRIES = 3;

const FAIL_SENTENCES: Record<FailReason, string> = {
  offline: 'the network did not answer, so the claim was never sent.',
  empty: 'the code holds nothing now: it was used, or reclaimed, a moment ago.',
  locked: "NEAR Intents has locked the code's account, so it cannot pay out.",
  expired: 'the signed claim passed its deadline unspent. Nothing moved, and the money is still on the code.',
  refused: 'the claim was refused before anything moved.',
  refunded: '1Click refunded the claim to the code, so the money is back on it.',
  unconfirmed: 'the network stopped answering before the claim could be proven. It is checked again at the next start.',
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function no(reason: InviteReason): { ok: false; reason: InviteReason } {
  return { ok: false, reason };
}

function failed(reason: FailReason, detail: string, final: boolean): Failed {
  return { kind: 'failed', reason, detail, final };
}

/* A relay refusal that Plan B answers: auth (the JWT the docs require, a key, a 401 or 403) or a
   missing quote. Anything else the relay says is not a reason to sign a second time. */
export function relayRefusalFallsBack(words: string): boolean {
  return /\b40[13]\b|unauthori[sz]ed|forbidden|\bjwt\b|bearer|api[\s_-]?key|\bauth/i.test(words) || /\bquote/i.test(words);
}

export function netOnOneClick(amount: bigint): bigint {
  return (amount * (10_000n - ONECLICK_FEE_BPS)) / 10_000n;
}

export function createInviteService(deps: InviteDeps): InviteService {
  const verifier = deps.verifier ?? liveVerifier(deps.fetchImpl ?? fetch);
  const relay = deps.relay ?? relayClient({ fetchImpl: deps.fetchImpl, ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }) });
  let oneclick: IntentsApiPort | null = deps.oneclick ?? null;
  const api = (): IntentsApiPort =>
    (oneclick ??= intentsApi({ apiKey: deps.apiKey ?? process.env[INTENTS_API_KEY_ENV] ?? '', fetchImpl: deps.fetchImpl }));
  const store = deps.store ?? createClaimStore(deps.dataDir);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? ((n: number) => crypto.randomBytes(n));
  const firstPollMs = deps.firstPollMs ?? FIRST_POLL_MS;
  const pollMs = deps.pollMs ?? 3_000;
  const watchCapMs = deps.watchCapMs ?? WATCH_CAP_MS;
  const hold = deps.hold ?? (() => () => {});

  const fateReads: FateReads = {
    nonceUsed: (account, nonce, at) => verifier.nonceUsed(account, nonce, at),
    ...(verifier.finalBlock === undefined ? {} : { finalBlock: () => verifier.finalBlock!() }),
    ...(verifier.isValidSalt === undefined ? {} : { saltValid: (salt: Uint8Array, at?: string) => verifier.isValidSalt!(salt, at) }),
  };

  let busy = false;
  // Set the first time the relay turns a claim away for auth or a missing quote: from then on the
  // check says Plan B's figure and a claim goes straight to it.
  let relayRefused = false;
  let latest: InviteState | null = null;
  let rev = 0;
  const jobs = new Set<Promise<void>>();

  function track(job: Promise<void>): void {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  }

  function announce(next: InviteState): void {
    latest = next;
    rev += 1;
    try {
      deps.broadcast({ type: INVITE_FRAME, kind: INVITE_FRAME, ...next, asset: INVITE_ASSET_SYMBOL });
      deps.broadcastState();
    } catch {
      // The frame is a nudge; /api/state carries the same fact.
    }
  }

  /* The receiver: the wallet's decrypted address, from a wallet that is open, never from the
     plaintext header (src/keystore/store.ts addressReport). Null is "unlock first". */
  function verifiedReceiver(): string | null {
    if (deps.keystore.state() !== 'unlocked') return null;
    const report = deps.keystore.addressReport();
    const evm = report.addresses.evm;
    if (!report.verified || report.tampered || typeof evm !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(evm)) return null;
    return evm.toLowerCase();
  }

  async function readAccount(address: string): Promise<{ ok: true; balance: bigint } | { ok: false; reason: InviteReason }> {
    const [balance, locked] = await Promise.all([
      verifier.balance(address, INVITE_ASSET_ID).catch(() => null),
      verifier.accountLocked === undefined ? Promise.resolve(null) : verifier.accountLocked(address).catch(() => null),
    ]);
    if (balance === null) return no('offline');
    if (balance < MIN_CLAIM_BASE) return no('empty');
    if (locked === null) return no('offline');
    if (locked) return no('locked');
    return { ok: true, balance };
  }

  async function check(input: unknown): Promise<CheckAnswer> {
    let secret: Uint8Array | null = null;
    try {
      if (busy) return no('busy');
      const parsed = parseCode(input);
      if (!parsed.ok) return no('typo');
      secret = parsed.secret;
      const address = codeAddress(secret);
      secret.fill(0);
      if (address === null) return no('empty');
      const read = await readAccount(address);
      if (!read.ok) return read;
      const route: ClaimRoute = relayRefused ? 'oneclick' : 'relay';
      const net = route === 'relay' ? read.balance : netOnOneClick(read.balance);
      return { ok: true, amount: formatUsdc(read.balance), asset: INVITE_ASSET_SYMBOL, route, net: formatUsdc(net) };
    } catch {
      return no('offline');
    } finally {
      secret?.fill(0);
    }
  }

  async function claim(input: unknown): Promise<ClaimAnswer> {
    if (busy) return no('busy');
    busy = true;
    let secret: Uint8Array | null = null;
    let signer: KeySigner | null = null;
    let started = false;
    try {
      const parsed = parseCode(input);
      if (!parsed.ok) return no('typo');
      secret = parsed.secret;
      const receiver = verifiedReceiver();
      if (receiver === null) return no('wallet-locked');
      if (!deps.movesMoney) return no('offline');
      /* From here the key lives in the signer and the bytes are wiped (src/invite/signer.ts). The
         signer is dropped once nothing more can be signed: after the relay's answer, or after
         Plan B's one signature, so the watch runs without it. */
      signer = (deps.signerOf ?? codeSigner)(secret);
      if (signer === null || signer.address === receiver) return no('empty');
      const read = await readAccount(signer.address);
      if (!read.ok) return read;
      // The wallet may have locked during the reads; the receiver is asked for again.
      if (verifiedReceiver() !== receiver) return no('wallet-locked');

      const id = crypto.randomBytes(8).toString('hex');
      const record: ClaimRecord = {
        claim: id,
        status: 'pending',
        codeAddress: signer.address,
        receiver,
        assetId: INVITE_ASSET_ID,
        amountBase: read.balance.toString(),
        attempts: [],
        startedAt: new Date(now()).toISOString(),
      };
      announce({ claim: id, status: 'running', amount: formatUsdc(read.balance) });
      const own = signer;
      track(
        run(record, own).finally(() => {
          busy = false;
        }),
      );
      started = true;
      return { ok: true, claim: id };
    } catch {
      return no('offline');
    } finally {
      secret?.fill(0);
      if (!started) {
        busy = false;
        signer?.drop();
      }
    }
  }

  async function run(record: ClaimRecord, signer: KeySigner): Promise<void> {
    const slot: HoldSlot = { release: null };
    let outcome: Outcome;
    try {
      outcome = relayRefused ? { kind: 'fallback', detail: 'the relay turned an earlier claim away' } : await relayRoute(record, signer, slot);
      if (outcome.kind === 'fallback') {
        relayRefused = true;
        outcome = await oneclickRoute(record, signer, slot, outcome.detail);
      }
    } catch (err) {
      outcome = failed(record.attempts.length > 0 ? 'unconfirmed' : 'refused', `the claim stopped: ${errText(err)}`, record.attempts.length === 0);
    } finally {
      signer.drop();
    }
    settle(record, outcome.kind === 'fallback' ? failed('refused', outcome.detail, false) : outcome, slot, true);
  }

  /* The deposit watch's hold, opened once, right before anything can credit the wallet, with the
     wallet's USDC read a moment before: a baseline the watch knows holds no part of the claim. */
  async function openHold(record: ClaimRecord, slot: HoldSlot): Promise<void> {
    if (slot.release !== null) return;
    const before = await verifier.balance(record.receiver, record.assetId).catch(() => null);
    slot.release = hold(record.assetId, before);
  }

  /* A stop before a signature. Over for good when nothing was ever signed for this claim; with a
     rehearsal or an attempt already signed, the record stays pending, and the next start proves
     each of them spent or dead before it calls the claim failed. */
  function stopped(record: ClaimRecord, reason: FailReason, detail: string): Failed {
    return failed(reason, detail, record.attempts.length === 0);
  }

  /* The chain's salt and final block, read together. A block stamped more than FATE_AHEAD_MAX_MS
     ahead of this Mac's clock is a clock far behind or an RPC that is not telling the time: a
     deadline built off it would outlive anything the watch can prove (src/relay/fate.ts stops
     believing such a block), so nothing is signed on it. */
  async function chainClock(record: ClaimRecord): Promise<Clock | Failed> {
    const [salt, block] = await Promise.all([
      verifier.currentSalt().catch(() => null),
      verifier.finalBlock === undefined ? Promise.resolve(null) : verifier.finalBlock().catch(() => null),
    ]);
    if (salt === null || block === null) return stopped(record, 'offline', 'the verifier did not answer with its salt and its clock, so the claim was never signed');
    const ahead = block.atMs - now();
    if (ahead > FATE_AHEAD_MAX_MS) {
      return stopped(record, 'refused', `NEAR's final block is stamped ${Math.round(ahead / 1000)} s ahead of this Mac's clock, so the claim was never signed: this clock is behind, or the RPC is not telling the time`);
    }
    return { kind: 'clock', salt, block };
  }

  /* The claim's one transfer, its deadline `lifeMs` past the chain's final block, read back as a
     stranger would, and its attempt written to the record before the key signs it. */
  async function signClaim(record: ClaimRecord, signer: KeySigner, clock: Clock, lifeMs: number, rehearsal: boolean): Promise<Signed | Failed> {
    const { salt, block } = clock;
    const legs = [{ receiverId: record.receiver, amountBase: BigInt(record.amountBase) }];
    const deadline = signingDeadline(block.atMs, lifeMs);
    const nonce = claimNonce(salt, deadline, random);
    const payload = buildTransfersPayload({ signerId: record.codeAddress, assetId: record.assetId, deadline, nonce, transfers: legs });
    const problems = checkTransfersPayload(payload, {
      signerId: record.codeAddress,
      assetId: record.assetId,
      transfers: legs,
      salt,
      now: block.atMs,
      maxDeadlineMs: CLAIM_DEADLINE_MS,
    });
    if (problems.length > 0) return stopped(record, 'refused', `refusing to sign the claim this app built: ${problems[0]}`);
    record.attempts.push({ route: 'relay', nonce, deadline, intentHash: intentHashOf(payload), ...(rehearsal ? { rehearsal: true as const } : {}) });
    try {
      store.put(record);
    } catch (err) {
      record.attempts.pop();
      return stopped(record, 'refused', `the claim record could not be written (${errText(err)}), so the claim was never signed`);
    }
    return { kind: 'signed', signed: { standard: ERC191_STANDARD, payload, signature: await signer.sign(payload) } };
  }

  /* Step 5: the rehearsal, on disk before it is signed and simulated at the block its millisecond
     is counted from. The chain's clock it passed at, which the claim itself is then signed off, so
     the claim costs no extra read. A refusal, or a verifier silent at REHEARSAL_TRIES blocks, ends
     the claim without its real signature; the rehearsals stay on the pending record for the next
     start to prove dead. */
  async function rehearse(record: ClaimRecord, signer: KeySigner): Promise<Clock | Failed> {
    if (verifier.simulate === undefined) return stopped(record, 'offline', 'the verifier cannot simulate, so the claim was never signed');
    for (let tries = 0; tries < REHEARSAL_TRIES; tries += 1) {
      if (tries > 0) await sleep(1_000);
      const clock = await chainClock(record);
      if (clock.kind === 'failed') return clock;
      const built = await signClaim(record, signer, clock, REHEARSAL_LIFE_MS, true);
      if (built.kind === 'failed') return built;
      const sim = await verifier.simulate([built.signed], clock.block.hash).catch(() => null);
      if (sim === null) continue;
      if (sim.ok) return clock;
      const verdict = simulationVerdict(sim.refusal);
      return stopped(record, verdict, `${SIMULATION_SENTENCES[verdict]} The verifier said: ${sim.refusal}. The claim itself was never signed.`);
    }
    return stopped(record, 'offline', `the verifier did not answer the rehearsal at ${REHEARSAL_TRIES} blocks in a row, so the claim itself was never signed`);
  }

  // Steps 3 to 7 on the relay. Returns the outcome, or a fallback before anything was taken.
  async function relayRoute(record: ClaimRecord, signer: KeySigner, slot: HoldSlot): Promise<Outcome> {
    const clock = await rehearse(record, signer);
    if (clock.kind === 'failed') return clock;
    const built = await signClaim(record, signer, clock, CLAIM_DEADLINE_MS, false);
    if (built.kind === 'failed') return built;

    await openHold(record, slot);
    const sent = await publishWithoutQuote(relay, built.signed);
    let relayHash: string | null = null;
    if (sent.answered && sent.result.status === 'OK') {
      relayHash = sent.result.intentHash;
    } else {
      /* Plan B only on a refusal to the FIRST send. A first send that got no reply may be live at
         the relay whatever the resend is told, and a second signature then is a second claim on
         the same money waiting to race the first. */
      const words = sent.answered ? (sent.result.status === 'FAILED' ? sent.result.reason : '') : sent.error;
      if (sent.attempts === 1 && relayRefusalFallsBack(words)) return { kind: 'fallback', detail: `the relay refused the claim: ${oneLine(words, 160)}` };
    }
    // Nothing more can be signed on this route, so the key goes before the watch, not after it.
    signer.drop();
    return watch(record, relayHash);
  }

  /* Plan B: the same claim through 1Click, as an in-Intents send from the code's account. The
     record gains the attempt, nonce and handle included, before the key signs, or nothing is
     signed. Plan B signs once, so the key is dropped the moment that signature is made, before
     1Click's watch and the claim's own. */
  async function oneclickRoute(record: ClaimRecord, signer: KeySigner, slot: HoldSlot, why: string): Promise<Outcome> {
    const amount = BigInt(record.amountBase);
    const floor = (amount * BigInt(10_000 - SEND_MAX_LOSS_BPS)) / 10_000n;
    let handle: string | null = null;
    const base = api();
    const tracked: IntentsApiPort = {
      ...base,
      generateIntent: (params) => {
        handle = params.depositAddress;
        return base.generateIntent(params);
      },
    };
    const recorded = signerPort(signer, (payload) => {
      const nonce = intentNonce(payload);
      const deadline = intentDeadline(payload);
      if (nonce === undefined || deadline === undefined || handle === null) {
        throw new Error('the 1Click intent carries no nonce, deadline or handle to prove it by');
      }
      const attempt: ClaimAttempt = { route: 'oneclick', nonce, deadline, intentHash: intentHashOf(payload), depositAddress: handle };
      record.attempts.push(attempt);
      try {
        store.put(record);
      } catch (err) {
        record.attempts.pop();
        throw new Error(`the claim record could not be written (${errText(err)})`);
      }
    });
    const port: IntentsSignerPort = {
      ...recorded,
      async signErc191(keysPath, payload) {
        try {
          return await recorded.signErc191(keysPath, payload);
        } finally {
          signer.drop();
        }
      },
    };
    const before = record.attempts.length;
    await openHold(record, slot);
    let early: { detail: string; reason: FailReason } | null = null;
    try {
      const spent = await spendFromIntents(
        {
          api: tracked,
          signer: port,
          keysPath: '',
          now,
          sleep,
          pollIntervalMs: pollMs,
          pollTimeoutMs: SIGNED_DEADLINE_MS,
          firstPollMs,
          maxDeadlineMs: SIGNED_DEADLINE_MS,
          signedDeadlineMs: SIGNED_DEADLINE_MS,
          ...(deps.quoteKey === undefined ? {} : { quoteKey: deps.quoteKey }),
        },
        {
          owner: record.codeAddress,
          originAsset: record.assetId,
          destinationAsset: record.assetId,
          amountBase: amount,
          minOutBase: floor,
          recipient: record.receiver,
          recipientType: 'INTENTS',
          slippageToleranceBps: SEND_SLIPPAGE_BPS,
          echo: echoFor(record),
          checkQuote: (quote) => quoteProblems(quote, amount, floor),
        },
      );
      if (!spent.signed) early = { detail: `${why}; 1Click held the claim before anything was signed`, reason: 'refused' };
    } catch (err) {
      if (record.attempts.length > before) record.attempts.length = before;
      early = { detail: `${why}; 1Click stopped the claim before signing: ${errText(err)}`, reason: noReply(err) ? 'offline' : 'refused' };
    }
    // Signed or not, Plan B is over: nothing more can be signed, so no watch below holds the key.
    signer.drop();
    return early === null ? watch(record, null) : beforeSigning(record, early.detail, early.reason);
  }

  /* Plan B stopped before its signature. A relay attempt the relay refused is still watched to
     its end, so the claim closes on proof rather than on the relay's word; with none, nothing was
     signed anywhere and the claim is over. */
  async function beforeSigning(record: ClaimRecord, detail: string, reason: FailReason): Promise<Landed | Failed> {
    if (record.attempts.length === 0) return failed(reason, detail, true);
    const outcome = await watch(record, null);
    return outcome.kind === 'failed' && outcome.final ? failed(outcome.reason, `${detail}; ${outcome.detail}`, true) : outcome;
  }

  function echoFor(record: ClaimRecord): QuoteEcho {
    return {
      recipient: record.receiver,
      recipientVerb: 'credit',
      recipientNoun: 'intents account',
      recipientType: 'INTENTS',
      recipientTypeWhy: 'an invite pays into the new wallet inside NEAR Intents, never to a chain address',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to the code, where the claim can be tried again',
      refundTo: record.codeAddress,
      originAsset: record.assetId,
      destinationAsset: record.assetId,
      amount: record.amountBase,
      noEcho:
        'there is nothing tying the claim to this wallet. The code signs a transfer to a 1Click handle that does not name ' +
        'the wallet, so without the echo the claim cannot be checked and nothing is signed.',
    };
  }

  function quoteProblems(quote: OneClickQuote, amount: bigint, floor: bigint): string[] {
    const problems: string[] = [];
    if (baseUnits(quote.amountIn, 'amountIn') !== amount) problems.push(`the quote spends ${oneLine(quote.amountIn, 40)} base units, not the ${amount.toString()} the code holds`);
    if (baseUnits(quote.minAmountOut, 'minAmountOut') < floor) {
      problems.push(`the quote could credit as little as ${oneLine(quote.minAmountOut, 40)} base units, under the ${floor.toString()} floor`);
    }
    return problems;
  }

  /* One look at every attempt on the record, newest first. Landed: an attempt's nonce spent,
     and on Plan B 1Click's SUCCESS too, because there the code paid 1Click's handle and not the
     wallet. Failed: every attempt over, each proved dead on the chain (src/relay/fate.ts) or, on
     Plan B, refunded with the refund back on the code. Anything else is still open. */
  async function judge(record: ClaimRecord): Promise<Verdict> {
    if (record.attempts.length === 0) return failed('refused', 'nothing was signed', true);
    let open = false;
    let refunded = false;
    for (const attempt of [...record.attempts].reverse()) {
      const fate = await transferFate(fateReads, { account: record.codeAddress, nonce: attempt.nonce, deadline: attempt.deadline }, now()).catch(() => null);
      if (fate !== null && fate.ran === false && fate.dead !== null) continue;
      let ran = fate?.ran === true;
      // A nonce that is not V1 (1Click chooses its own) can still be asked whether it was spent;
      // only its death cannot be proved, so such an attempt never ends a claim as failed.
      if (!ran && fate?.ran === null && fate.why === 'not_the_verifiers') {
        ran = (await verifier.nonceUsed(record.codeAddress, attempt.nonce).catch(() => null)) === true;
      }
      const proof = ran ? await proveRan(record, attempt) : 'open';
      if (proof === 'refunded') refunded = true;
      else if (proof === 'open') open = true;
      else return proof;
    }
    if (open) return { kind: 'waiting' };
    return refunded
      ? failed('refunded', 'the claim went to 1Click, and 1Click refunded it to the code, where the refund now shows', true)
      : failed('expired', 'every signed claim passed its deadline unspent, on the chain clock and this one', true);
  }

  async function proveRan(record: ClaimRecord, attempt: ClaimAttempt): Promise<Landed | 'open' | 'refunded'> {
    const amount = BigInt(record.amountBase);
    if (attempt.route === 'relay') return { kind: 'landed', route: 'relay', credited: amount, intentHash: attempt.intentHash, nearTx: null };
    const status = attempt.depositAddress === undefined ? null : await api().status(attempt.depositAddress).catch(() => null);
    if (status?.status === 'SUCCESS') {
      let credited = netOnOneClick(amount);
      try {
        // 1Click's own figure, never more than the code held: a claim cannot land more than it moved.
        if (status.settledAmountOut !== undefined) credited = decimalToBaseUnits(status.settledAmountOut, INVITE_ASSET_DECIMALS);
        if (credited > amount) credited = amount;
      } catch {
        // 1Click's figure did not read as a decimal; the estimate stands.
      }
      return { kind: 'landed', route: 'oneclick', credited, intentHash: attempt.intentHash, nearTx: status.nearTxHashes[0] ?? null };
    }
    // A refund closes the claim only once it shows on the code, never on 1Click's word alone, and
    // FAILED is a refund still on its way (src/rails/oneclick-words.ts says the same of a swap).
    if (status?.status === 'REFUNDED' && status.refundedAmount !== undefined) {
      let refundedBase = 0n;
      try {
        refundedBase = decimalToBaseUnits(status.refundedAmount, INVITE_ASSET_DECIMALS);
      } catch {
        // not a figure; the refund is not shown yet
      }
      const held = refundedBase > 0n ? await verifier.balance(record.codeAddress, record.assetId).catch(() => null) : null;
      if (held !== null && held >= refundedBase) return 'refunded';
    }
    return 'open';
  }

  async function watch(record: ClaimRecord, relayHash: string | null): Promise<Landed | Failed> {
    const started = now();
    let delay = firstPollMs;
    let nearTx: string | null = null;
    for (;;) {
      if (relayHash !== null && nearTx === null) {
        const status = await relay.status(relayHash).catch(() => null);
        if (status?.nearTxHash) nearTx = status.nearTxHash;
      }
      const verdict = await judge(record);
      if (verdict.kind === 'landed') return { ...verdict, intentHash: relayHash ?? verdict.intentHash, nearTx: verdict.nearTx ?? nearTx };
      if (verdict.kind === 'failed') return verdict;
      if (now() - started >= watchCapMs) return failed('unconfirmed', `no proof either way after ${Math.round(watchCapMs / 1000)} s of watching`, false);
      await sleep(delay);
      delay = Math.min(delay * 2, pollMs);
    }
  }

  function settle(record: ClaimRecord, outcome: Landed | Failed, slot: HoldSlot, live: boolean): void {
    if (outcome.kind === 'landed') {
      slot.release?.(outcome.credited);
      slot.release = null;
      const amount = formatUsdc(outcome.credited);
      try {
        deps.audit.append('invite_claimed', `An invite code paid ${amount} USDC into this wallet${outcome.route === 'oneclick' ? ', through 1Click' : ''}.`, {
          claim: record.claim,
          codeAddress: record.codeAddress,
          receiver: record.receiver,
          asset: INVITE_ASSET_SYMBOL,
          amount,
          intentHash: outcome.intentHash,
          route: outcome.route,
        });
      } catch {
        // The record below is the durable copy.
      }
      record.status = 'done';
      record.settledAt = new Date(now()).toISOString();
      record.route = outcome.route;
      record.creditedBase = outcome.credited.toString();
      record.intentHash = outcome.intentHash;
      if (outcome.nearTx !== null) record.nearTx = outcome.nearTx;
      try {
        store.put(record);
      } catch {
        // The audit line stands; the next boot proves the claim again from the pending record.
      }
      void deps.refreshLedger().catch(() => undefined);
      announce({ claim: record.claim, status: 'landed', amount });
      return;
    }
    /* Proved over: the hold ends with nothing to add. Not proved (the network stopped answering):
       the hold stays for the rest of this run, because the claim may still land, and a release
       now would show it as a deposit when it does. */
    if (outcome.final) {
      slot.release?.(null);
      slot.release = null;
    }
    /* A reconcile that learned nothing new says nothing: the record stays pending for the next
       start. One that proved a claim dead writes the line and the record, and sends no frame: a
       toast at launch about a claim from an earlier session would only alarm. */
    if (!live && !outcome.final) return;
    try {
      deps.audit.append('invite_failed', `An invite claim did not land: ${FAIL_SENTENCES[outcome.reason]}`, {
        claim: record.claim,
        codeAddress: record.codeAddress,
        reason: outcome.reason,
        detail: oneLine(outcome.detail, 300),
      });
    } catch {
      // as above
    }
    if (record.attempts.length > 0 && outcome.final) {
      record.status = 'failed';
      record.settledAt = new Date(now()).toISOString();
      record.reason = outcome.reason;
      try {
        store.put(record);
      } catch {
        // the record stays pending and the next start asks again
      }
    }
    if (live) announce({ claim: record.claim, status: 'failed', amount: formatUsdc(BigInt(record.amountBase)) });
  }

  function reconcile(): void {
    /* Only this wallet's claims. The record file is not authenticated (like terms.json), and a
       record naming another receiver is either a wallet this data directory no longer holds or an
       edit: neither may write "paid into this wallet". The address may be the header's here, at
       boot with the wallet shut; that is enough to tell this wallet's records from others. */
    const wallet = deps.keystore.addressReport().addresses.evm?.toLowerCase() ?? null;
    for (const record of store.all()) {
      if (record.status !== 'pending' || record.attempts.length === 0 || record.receiver !== wallet) continue;
      /* Held only while an attempt can still run. Past that, whatever the claim did it did before
         this start, every balance read from now on already holds it, and there is nothing to keep
         off a deposit card. */
      const last = Math.max(...record.attempts.map((a) => Date.parse(a.deadline)).filter((t) => Number.isFinite(t)));
      const slot: HoldSlot = { release: Number.isFinite(last) && now() < last + RELAY_DEADLINE_GRACE_MS ? hold(record.assetId, null) : null };
      track(
        watch(record, null)
          .catch((err: unknown) => failed('unconfirmed', `the reconcile stopped: ${errText(err)}`, false))
          .then((outcome) => settle(record, outcome, slot, false)),
      );
    }
  }

  async function idle(): Promise<void> {
    while (jobs.size > 0) await Promise.allSettled([...jobs]);
  }

  return {
    check,
    claim,
    state: () => latest,
    revision: () => rev,
    landed: () => store.all().filter((r) => r.status === 'done'),
    reconcile,
    idle,
  };
}
