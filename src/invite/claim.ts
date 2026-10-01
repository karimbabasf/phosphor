// The claim: an invite code's money, moved into this wallet. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The claim, step by step" and
// "Plan B: the 1Click route". The routes are src/http/invite.ts.
//
// THE SEQUENCE, one signature per route, and the person's own key never signs anything:
//   1. parse the code (src/invite/code.ts) and derive its key and its account;
//   2. read the account: it must hold USDC, and NEAR Intents must not have locked it;
//   3. read current_salt and the final block, and build the V1 nonce and a deadline two minutes
//      past the CHAIN's clock;
//   4. one `transfer` of everything the code holds to the wallet's DECRYPTED address, built and
//      read back as a stranger would (src/invite/payload.ts);
//   5. sign with the code's key, then simulate_intents, a free view: any refusal stops here and
//      nothing is sent;
//   6. the pending record goes to disk (src/invite/store.ts), and only then the publish to the
//      solver relay with an empty quote_hashes: the identical bytes once more on no reply, never
//      a second signature;
//   7. the watch, until the deadline plus 30 s on the chain's clock (src/relay/fate.ts).
//      PROOF IS THE NONCE PLUS THE CODE'S BALANCE: is_nonce_used must read true and the code's
//      USDC must have fallen by the signed amount. Never the relay's status word, and never the
//      wallet's balance, which a deposit landing at the same moment would fool;
//   8. the audit line, the record marked done, refreshLedger, the frame, the key dropped.
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
// input. One claim runs at a time.

import crypto from 'node:crypto';

import type { Audit } from '../audit.ts';
import type { LockState } from '../keystore/index.ts';
import type { AddressReport } from '../keystore/store.ts';
import { ERC191_STANDARD } from '../intents-sign.ts';
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
import { RELAY_DEADLINE_GRACE_MS, transferFate } from '../relay/fate.ts';
import type { FateReads } from '../relay/fate.ts';
import { liveVerifier } from '../relay/verifier.ts';
import type { VerifierPort } from '../relay/verifier.ts';
import { codeAddress, parseCode } from './code.ts';
import {
  CLAIM_DEADLINE_MS,
  INVITE_ASSET_DECIMALS,
  INVITE_ASSET_ID,
  INVITE_ASSET_SYMBOL,
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
  firstPollMs?: number;
  pollMs?: number;
  watchCapMs?: number;
};

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
  // The deposit watch's hold (src/vault/watch.ts), so a claim is never reported as a deposit.
  hold?: (assetId: string) => (proven: bigint | null) => void;
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
type Failed = { kind: 'failed'; reason: FailReason; detail: string; final: boolean };
type Outcome = Landed | Failed | { kind: 'fallback'; detail: string };
type Verdict = Landed | Failed | { kind: 'waiting' };

const FAIL_SENTENCES: Record<FailReason, string> = {
  offline: 'the network did not answer, so nothing was sent.',
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
    if (balance <= 0n) return no('empty');
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
      // From here the key lives in the signer and the bytes are wiped (src/invite/signer.ts).
      signer = codeSigner(secret);
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
      const release = hold(INVITE_ASSET_ID);
      const own = signer;
      track(
        run(record, own, release).finally(() => {
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

  async function run(record: ClaimRecord, signer: KeySigner, release: (proven: bigint | null) => void): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = relayRefused ? { kind: 'fallback', detail: 'the relay turned an earlier claim away' } : await relayRoute(record, signer);
      if (outcome.kind === 'fallback') {
        relayRefused = true;
        outcome = await oneclickRoute(record, signer, outcome.detail);
      }
    } catch (err) {
      outcome = failed(record.attempts.length > 0 ? 'unconfirmed' : 'refused', `the claim stopped: ${errText(err)}`, false);
    } finally {
      signer.drop();
    }
    settle(record, outcome.kind === 'fallback' ? failed('refused', outcome.detail, false) : outcome, release, true);
  }

  // Steps 3 to 7 on the relay. Returns the outcome, or a fallback before anything was taken.
  async function relayRoute(record: ClaimRecord, signer: KeySigner): Promise<Outcome> {
    const [salt, block] = await Promise.all([
      verifier.currentSalt().catch(() => null),
      verifier.finalBlock === undefined ? Promise.resolve(null) : verifier.finalBlock().catch(() => null),
    ]);
    if (salt === null || block === null) return failed('offline', 'the verifier did not answer with its salt and its clock, so nothing was signed', true);

    const amount = BigInt(record.amountBase);
    const legs = [{ receiverId: record.receiver, amountBase: amount }];
    const deadline = signingDeadline(block.atMs);
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
    if (problems.length > 0) return failed('refused', `refusing to sign the claim this app built: ${problems[0]}`, true);

    const signature = await signer.sign(payload);
    const signed = { standard: ERC191_STANDARD, payload, signature };
    const sim = verifier.simulate === undefined ? null : await verifier.simulate([signed]).catch(() => null);
    if (sim === null) return failed('offline', 'the verifier did not answer the simulation, so the signed claim was never sent', true);
    if (!sim.ok) {
      const verdict = simulationVerdict(sim.refusal);
      return failed(verdict, `${SIMULATION_SENTENCES[verdict]} The verifier said: ${sim.refusal}. Nothing was sent.`, true);
    }

    const intentHash = intentHashOf(payload);
    record.attempts.push({ route: 'relay', nonce, deadline, intentHash });
    try {
      store.put(record);
    } catch (err) {
      record.attempts.pop();
      return failed('refused', `the claim record could not be written (${errText(err)}), so the signed claim was never sent`, true);
    }

    const sent = await publishWithoutQuote(relay, signed);
    let relayHash: string | null = null;
    if (sent.answered && sent.result.status === 'OK') {
      relayHash = sent.result.intentHash;
    } else {
      // A refusal the relay ANSWERED, never a silence: a publish that got no reply may be live.
      const words = sent.answered ? (sent.result.status === 'FAILED' ? sent.result.reason : '') : sent.error;
      const answered = sent.answered || sent.attempts === 1;
      if (answered && relayRefusalFallsBack(words)) return { kind: 'fallback', detail: `the relay refused the claim: ${oneLine(words, 160)}` };
    }
    return watch(record, relayHash);
  }

  /* Plan B: the same claim through 1Click, as an in-Intents send from the code's account. The
     record gains the attempt, nonce and handle included, before the key signs, or nothing is
     signed. */
  async function oneclickRoute(record: ClaimRecord, signer: KeySigner, why: string): Promise<Outcome> {
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
    const port = signerPort(signer, (payload) => {
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
    const before = record.attempts.length;
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
      if (!spent.signed) return failed('refused', `${why}; 1Click held the claim before anything was signed`, false);
    } catch (err) {
      // Before the signature: this route signed nothing. The relay attempt, if any, is left to
      // the next start's reconcile, which proves it dead.
      if (record.attempts.length > before) record.attempts.length = before;
      return failed(noReply(err) ? 'offline' : 'refused', `${why}; 1Click stopped the claim before signing: ${errText(err)}`, false);
    }
    return watch(record, null);
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

  /* One look at every attempt on the record, newest first. Landed needs the nonce spent AND the
     code's balance down by the signed amount, and on Plan B also 1Click's SUCCESS. Failed needs
     every attempt proved dead by the chain (src/relay/fate.ts), or 1Click's refund. */
  async function judge(record: ClaimRecord): Promise<Verdict> {
    let allDead = record.attempts.length > 0;
    for (const attempt of [...record.attempts].reverse()) {
      const fate = await transferFate(fateReads, { account: record.codeAddress, nonce: attempt.nonce, deadline: attempt.deadline }, now()).catch(() => null);
      if (fate !== null && fate.ran === false && fate.dead !== null) continue;
      allDead = false;
      let ran = fate?.ran === true;
      // A nonce that is not V1 (1Click chooses its own) can still be asked whether it was spent;
      // only its death cannot be proved, so such an attempt never ends a claim as failed.
      if (!ran && fate?.ran === null && fate.why === 'not_the_verifiers') {
        ran = (await verifier.nonceUsed(record.codeAddress, attempt.nonce).catch(() => null)) === true;
      }
      if (!ran) continue;
      const proof = await proveRan(record, attempt);
      if (proof.kind !== 'waiting') return proof;
    }
    if (allDead) return failed('expired', 'every signed claim passed its deadline unspent, on the chain clock and this one', true);
    return { kind: 'waiting' };
  }

  async function proveRan(record: ClaimRecord, attempt: ClaimAttempt): Promise<Verdict> {
    const amount = BigInt(record.amountBase);
    if (attempt.route === 'oneclick') {
      const status = attempt.depositAddress === undefined ? null : await api().status(attempt.depositAddress).catch(() => null);
      if (status?.status === 'REFUNDED' || status?.status === 'FAILED') {
        return failed('refunded', `1Click answered ${status.reported} for handle ${oneLine(attempt.depositAddress, 80)}`, true);
      }
      if (status?.status !== 'SUCCESS') return { kind: 'waiting' };
      if (!(await codeFell(record, amount))) return { kind: 'waiting' };
      let credited = netOnOneClick(amount);
      try {
        if (status.settledAmountOut !== undefined) credited = decimalToBaseUnits(status.settledAmountOut, INVITE_ASSET_DECIMALS);
      } catch {
        // 1Click's figure did not read as a decimal; the estimate stands.
      }
      return { kind: 'landed', route: 'oneclick', credited, intentHash: attempt.intentHash, nearTx: status.nearTxHashes[0] ?? null };
    }
    if (!(await codeFell(record, amount))) return { kind: 'waiting' };
    return { kind: 'landed', route: 'relay', credited: amount, intentHash: attempt.intentHash, nearTx: null };
  }

  /* The code's own USDC, down by the signed amount from what it held when the claim was signed.
     A claim signs the whole balance, so what it held and what it signed are the same figure. */
  async function codeFell(record: ClaimRecord, amount: bigint): Promise<boolean> {
    const before = BigInt(record.amountBase);
    const after = await verifier.balance(record.codeAddress, record.assetId).catch(() => null);
    return after !== null && before - after >= amount;
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

  function settle(record: ClaimRecord, outcome: Landed | Failed, release: (proven: bigint | null) => void, live: boolean): void {
    if (outcome.kind === 'landed') {
      release(outcome.credited);
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
    release(null);
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
    for (const record of store.all()) {
      if (record.status !== 'pending' || record.attempts.length === 0) continue;
      const release = hold(record.assetId);
      track(
        watch(record, null)
          .catch((err: unknown) => failed('unconfirmed', `the reconcile stopped: ${errText(err)}`, false))
          .then((outcome) => settle(record, outcome, release, false)),
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
