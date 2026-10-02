// Other USDC that reached the treasury T, turned into NEAR USDC, the one asset a code holds
// (src/invite/payload.ts). The app's Send pays out of whichever USDC the wallet holds, so funding T
// with it can land USDC on Base inside NEAR Intents, which a batch cannot pay with: the proof's
// first funding did exactly that (1.00 USDC on Base, no NEAR USDC). `npm run invite -- convert` and
// `node scripts/invite-proof.ts convert` swap every other USDC T holds into NEAR USDC through
// 1Click, signed by T's own key, one move per USDC.
//
// THE QUOTE IS HELD TO WHAT T ASKED FOR, the way the swap rail holds its own: exact in, T's whole
// balance of that USDC, the NEAR USDC credited to T and a refund back to T, both inside NEAR
// Intents. Inside the client (src/intents.ts requestEchoProblems) the request 1Click priced must be
// the request sent, with a fee to 1Click's own account and nobody else; the echo must name T and
// the two assets (quoteEchoProblems), 1Click must have signed the quote, and it may give up at
// most CONVERT_MAX_LOSS_BPS of its value, in base units and by 1Click's own dollar figures. The
// payload 1Click generates is then read back as a stranger would (checkIntentPayload): one
// transfer of exactly that amount of that USDC from T, to the handle of that quote, for three
// minutes.
//
// ONE SIGNATURE THAT CAN RUN, ON DISK BEFORE IT GOES. The steps are the shared spend path
// (src/rails/intents-spend.ts), signed once. Before that signature the move is in the invite file
// with 1Click's handle and the payload's nonce, and the payload is rehearsed (below); after it, the
// signed bytes are in the file before submit-intent sees them. A run that stops anywhere is
// finished by the next one: the same bytes resent while they can still run, never a second
// signature, and nothing new converted while they can.
//
// REHEARSED, NEVER SIMULATED AS ITSELF (scripts/invite/money.ts says why). The rehearsal is
// 1Click's own payload with its deadline cut to one millisecond past a final block, signed and
// simulated at that block. It carries the real payload's nonce, so at most one of the two can ever
// run: a rehearsal a lying RPC ran on a fast Mac is the convert itself, paid to the handle of a
// quote that credits T, and the real signature then dies on the spent nonce.
//
// PROOF IS THE NONCE, THEN 1CLICK'S WORD. A spent nonce is T's transfer to the handle done.
// 1Click's SUCCESS is the NEAR USDC delivered and REFUNDED the USDC back on T, and the next read of
// T shows either. A nonce proven dead on the chain's clock (src/relay/fate.ts) never ran.

import { baseUnits, decimalToBaseUnits, oneLine, quoteEchoProblems } from '../../src/intents.ts';
import type { OneClickQuote, OneClickStatus, QuoteEcho } from '../../src/intents.ts';
import { ERC191_STANDARD } from '../../src/intents-sign.ts';
import { INVITE_ASSET_DECIMALS, INVITE_ASSET_ID, REHEARSAL_LIFE_MS, formatUsdc, intentHashOf, signingDeadline, simulationVerdict } from '../../src/invite/payload.ts';
import { signerPort } from '../../src/invite/signer.ts';
import type { KeySigner } from '../../src/invite/signer.ts';
import {
  INTENTS_API_KEY_ENV,
  QUOTE_SLIPPAGE_BPS,
  SIGNED_DEADLINE_MS,
  checkIntentPayload,
  intentDeadline,
  intentNonce,
  intentsApi,
  shortenDeadline,
} from '../../src/rails/intents-native.ts';
import type { IntentPayloadExpectation, IntentsApiPort } from '../../src/rails/intents-native.ts';
import { spendFromIntents } from '../../src/rails/intents-spend.ts';
import type { IntentsSpendOutcome } from '../../src/rails/intents-spend.ts';
import { submitSignedIntent } from '../../src/rails/intents-submit.ts';
import { FATE_FLOOR_MS, RELAY_DEADLINE_GRACE_MS, transferFate } from '../../src/relay/fate.ts';
import { decodeNonce } from '../../src/relay/payload.ts';
import { pendingMoves } from './book.ts';
import type { Move } from './book.ts';
import { REFUSALS, REHEARSAL_AHEAD_MS, chainClock, fateReads, idOf, nowIso, treasurySigner } from './money.ts';
import type { Io, Ledger, MoneyNet } from './money.ts';
import { asInviteBase, exactDollars, heldList, heldWords, otherUsdc, variantOf } from './usdc.ts';
import type { OtherUsdc } from './usdc.ts';

/* How much of its value a convert may give up, fee and price together: one percent, the send
   rail's cap (SEND_MAX_LOSS_BPS). Live dry quotes of USDC on Base to NEAR USDC on 2026-10-01 gave
   up 0.8 to 2.2 basis points ($0.10 to $100), so this refuses only a quote someone changed. */
export const CONVERT_MAX_LOSS_BPS = 100;
// What 1Click is asked to keep its own floor within: the swap rail's half percent.
const CONVERT_SLIPPAGE_BPS = QUOTE_SLIPPAGE_BPS;
/* How long one convert is watched on this Mac's clock: its signed three minutes, the grace
   src/relay/fate.ts gives this clock when the chain's does not answer, and a minute. */
export const CONVERT_WATCH_CAP_MS = SIGNED_DEADLINE_MS + RELAY_DEADLINE_GRACE_MS + 60_000;
const FIRST_POLL_MS = 1_000;
const POLL_MS = 3_000;
/* How far this Mac's clock may run ahead of NEAR's before a convert is refused: a minute, so the
   signed transfer lives at most four minutes on NEAR, inside 1Click's ten-minute quote. */
const CLOCK_AHEAD_MAX_MS = 60_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function moveWords(move: Move): string {
  const variant = variantOf(move.assetId);
  const base = BigInt(move.legs[0]?.amountBase ?? '0');
  return variant === undefined ? `${base} base units of ${oneLine(move.assetId, 80)}` : heldWords({ variant, base });
}

// The least NEAR USDC a convert of `held` may deliver: CONVERT_MAX_LOSS_BPS under what it sends.
export function convertFloor(held: OtherUsdc): bigint {
  return (asInviteBase(held.base, held.variant.decimals) * BigInt(10_000 - CONVERT_MAX_LOSS_BPS)) / 10_000n;
}

/* The convert's own checks on a quote, beside the request echo, the quote echo and the signature:
   T's whole balance in, and at most CONVERT_MAX_LOSS_BPS given up, by the quote's own floor in base
   units and by 1Click's dollar figures, which sit inside its signature where the fee shows even when
   an echo was rewritten to hide its line (src/rails/intents-native.ts swapLossProblem). A side
   1Click prices at nothing is held to the floor alone. */
export function convertQuoteProblems(quote: OneClickQuote, held: OtherUsdc): string[] {
  const problems: string[] = [];
  try {
    if (baseUnits(quote.amountIn, 'amountIn') !== held.base) {
      problems.push(`the quote spends ${oneLine(quote.amountIn, 40)} base units, not the ${held.base} T holds`);
    }
    const floor = convertFloor(held);
    const least = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (least < floor) {
      problems.push(
        `the quote could deliver as little as $${formatUsdc(least)} of NEAR USDC, under the $${formatUsdc(floor)} floor ` +
          `${CONVERT_MAX_LOSS_BPS / 100} percent under what T sends`,
      );
    }
  } catch (err) {
    problems.push(errText(err));
  }
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);
  if (inUsd > 0 && outUsd > 0 && Number.isFinite(inUsd) && Number.isFinite(outUsd)) {
    const lostBps = ((inUsd - outUsd) / inUsd) * 10_000;
    if (lostBps > CONVERT_MAX_LOSS_BPS) {
      problems.push(
        `the quote gives up ${(lostBps / 100).toFixed(1)} percent of its value ($${inUsd.toFixed(2)} in, $${outUsd.toFixed(2)} out ` +
          `by 1Click's own prices), more than the ${CONVERT_MAX_LOSS_BPS / 100} percent a convert may lose`,
      );
    }
  }
  return problems;
}

function echoFor(t: string, held: OtherUsdc): QuoteEcho {
  return {
    recipient: t,
    recipientVerb: 'credit',
    recipientNoun: 'treasury',
    recipientType: 'INTENTS',
    recipientTypeWhy: 'a convert credits T inside NEAR Intents, never a chain address',
    depositType: 'INTENTS',
    refundType: 'INTENTS',
    refundTypeWhy: 'back to T inside NEAR Intents',
    refundTo: t,
    originAsset: held.variant.assetId,
    destinationAsset: INVITE_ASSET_ID,
    amount: held.base.toString(),
    noEcho:
      "nothing ties T's transfer to T. T signs a transfer to a 1Click handle that does not name T, so without the echo " +
      'the convert cannot be checked and nothing is signed.',
  };
}

function quoteParams(t: string, held: OtherUsdc, dry: boolean) {
  return {
    dry,
    originAsset: held.variant.assetId,
    destinationAsset: INVITE_ASSET_ID,
    amount: held.base.toString(),
    account: t,
    recipient: t,
    recipientType: 'INTENTS' as const,
    slippageToleranceBps: CONVERT_SLIPPAGE_BPS,
  };
}

type Planned = { held: OtherUsdc; quotedOut: bigint; minOut: bigint };

/* A dry quote for each, held to every check the live one will be, so the list shown before
   anything is signed is a list 1Click would honour. */
async function priceAll(t: string, held: OtherUsdc[], api: IntentsApiPort, io: Io): Promise<Planned[]> {
  const plan: Planned[] = [];
  for (const h of held) {
    let answer: { quote: OneClickQuote; raw: unknown };
    try {
      answer = await api.quote(quoteParams(t, h, true));
    } catch (err) {
      io.say(`${heldWords(h)}: 1Click would not price it, so it stays as it is. ${errText(err)}`);
      continue;
    }
    const problems = [...convertQuoteProblems(answer.quote, h), ...quoteEchoProblems(answer.raw, echoFor(t, h))];
    let quotedOut = 0n;
    try {
      quotedOut = baseUnits(answer.quote.amountOut, 'amountOut');
    } catch (err) {
      problems.push(errText(err));
    }
    if (problems.length > 0) {
      io.say(`${heldWords(h)}: 1Click's price is refused, so it stays as it is: ${problems.join('; ')}.`);
      continue;
    }
    plan.push({ held: h, quotedOut, minOut: baseUnits(answer.quote.minAmountOut, 'minAmountOut') });
  }
  return plan;
}

type Verdict =
  | { kind: 'done'; credited: bigint | null }
  | { kind: 'refunded' }
  | { kind: 'dead' }
  | { kind: 'lapsed' } // can never run now, and nothing can say whether it did
  | { kind: 'running'; said: string } // T's transfer ran; 1Click has not finished
  | { kind: 'open' }; // the signed bytes can still run

/* What 1Click says it credited, never more than went in: its status is unsigned, and a convert of
   USDC cannot bring more NEAR USDC than the USDC it sent (the claim's Plan B caps the same way). */
function creditedOf(status: OneClickStatus, move: Move): bigint | null {
  try {
    if (status.settledAmountOut === undefined) return null;
    const credited = decimalToBaseUnits(status.settledAmountOut, INVITE_ASSET_DECIMALS);
    const sent = asInviteBase(BigInt(move.legs[0]?.amountBase ?? '0'), variantOf(move.assetId)?.decimals ?? INVITE_ASSET_DECIMALS);
    return credited > sent ? sent : credited;
  } catch {
    return null;
  }
}

/* A refund closes a convert only once it shows on T, never on 1Click's unsigned word alone (the
   claim's rule, src/invite/claim.ts): a status that lied about a refund would otherwise close a
   convert 1Click is still delivering, and the proof's sweep would call T empty. */
async function refundShows(move: Move, status: OneClickStatus, net: MoneyNet): Promise<boolean> {
  const variant = variantOf(move.assetId);
  if (variant === undefined || status.refundedAmount === undefined) return false;
  let refunded: bigint;
  try {
    refunded = decimalToBaseUnits(status.refundedAmount, variant.decimals);
  } catch {
    return false;
  }
  const held = refunded > 0n ? await net.verifier.balance(move.signer, variant.assetId).catch(() => null) : null;
  return held !== null && held >= refunded;
}

async function oneclickSays(move: Move, api: IntentsApiPort, net: MoneyNet): Promise<Verdict | null> {
  const status = await api.status(move.handle ?? '').catch(() => null);
  if (status?.status === 'SUCCESS') return { kind: 'done', credited: creditedOf(status, move) };
  if (status?.status === 'REFUNDED' && (await refundShows(move, status, net))) return { kind: 'refunded' };
  return status === null ? null : { kind: 'running', said: status.status };
}

// NEAR Intents' answers that will never become a proof: a nonce that is not V1, its life over,
// its salt retired. A read that failed (no answer, the salt unanswered) is asked again instead.
const NEVER_PROVEN: ReadonlySet<string> = new Set(['not_the_verifiers', 'nonce_life_over', 'salt_retired']);

/* One look: the nonce first, then 1Click. A spent nonce is T's transfer done, and 1Click says how
   the far side ended. A read that failed is no answer and the convert stays open (review N1: one
   failed read once closed a convert 1Click was still delivering). Only a nonce NEAR Intents can
   never answer for goes to 1Click: SUCCESS or REFUNDED closes it, a deposit 1Click has seen keeps
   it pending without holding up the next convert, and a deposit 1Click never saw lapses once its
   latest deadline is RELAY_DEADLINE_GRACE_MS behind this Mac's clock (the rule src/relay/fate.ts
   falls back on), because no block can run it after that. */
async function judge(move: Move, net: MoneyNet, api: IntentsApiPort): Promise<Verdict> {
  const deadline = move.signed?.deadline ?? move.rehearsalDeadline;
  const fate = await transferFate(fateReads(net), { account: move.signer, nonce: move.nonce ?? '', deadline }, net.now()).catch(() => null);
  if (fate?.ran === false) return fate.dead !== null ? { kind: 'dead' } : { kind: 'open' };
  let ran = fate?.ran === true;
  // A nonce that is not V1 can still be asked whether it was spent, as the claim's Plan B asks it.
  if (fate?.ran === null && fate.why === 'not_the_verifiers') ran = (await net.verifier.nonceUsed(move.signer, move.nonce ?? '').catch(() => null)) === true;
  if (ran) return (await oneclickSays(move, api, net)) ?? { kind: 'running', said: 'nothing' };
  if (fate === null || fate.ran !== null || !NEVER_PROVEN.has(fate.why)) return { kind: 'open' };
  const said = await oneclickSays(move, api, net);
  if (said !== null && (said.kind !== 'running' || said.said !== 'PENDING_DEPOSIT')) return said;
  return net.now() > Date.parse(deadline ?? '') + RELAY_DEADLINE_GRACE_MS ? { kind: 'lapsed' } : { kind: 'open' };
}

async function watch(move: Move, net: MoneyNet, api: IntentsApiPort): Promise<Verdict> {
  const started = net.now();
  let delay = net.firstPollMs ?? FIRST_POLL_MS;
  for (;;) {
    const verdict = await judge(move, net, api);
    if (verdict.kind !== 'open' && verdict.kind !== 'running') return verdict;
    if (net.now() - started >= CONVERT_WATCH_CAP_MS) return verdict;
    await net.sleep(delay);
    delay = Math.min(delay * 2, net.pollMs ?? POLL_MS);
  }
}

function trySave(ledger: Ledger): void {
  try {
    ledger.save();
  } catch {
    // The bytes are out already; the next run reads the chain, not this write.
  }
}

/* The verdict into the book and one line. `open` keeps every new convert waiting; `running` (T's
   side ran, 1Click is still working) does not, since those bytes can never run again. */
function close(ledger: Ledger, move: Move, verdict: Verdict, net: MoneyNet, io: Io): Verdict['kind'] {
  const what = moveWords(move);
  if (verdict.kind === 'done') {
    move.state = 'done';
    move.settledAt = nowIso(net);
    move.oneclickSaid = 'SUCCESS';
    if (verdict.credited !== null) move.creditedOut = verdict.credited.toString();
    trySave(ledger);
    const credited = verdict.credited === null ? '' : `, $${exactDollars(verdict.credited)} of NEAR USDC credited to T`;
    io.say(`${what}: converted. 1Click says SUCCESS${credited} (intent ${move.signed?.intentHash ?? 'unknown'}).`);
  } else if (verdict.kind === 'refunded' || verdict.kind === 'dead' || verdict.kind === 'lapsed') {
    move.state = 'failed';
    move.settledAt = nowIso(net);
    if (verdict.kind === 'refunded') move.oneclickSaid = 'REFUNDED';
    const signed = move.signed === undefined ? 'Only its rehearsal was signed, and that' : 'The signed convert';
    move.detail =
      verdict.kind === 'refunded'
        ? '1Click refunded it to T as the same USDC. Run convert again to try once more.'
        : verdict.kind === 'dead'
          ? `${signed} passed its deadline with its nonce unspent, on the chain clock: it never ran and never can. T still holds that USDC.`
          : `${signed} can never run now: its deadline passed long ago. NEAR Intents can no longer say whether its nonce was spent and 1Click did not say, so T's balances show what happened; convert reads them again.`;
    trySave(ledger);
    io.say(`${what}: not converted. ${move.detail}`);
  } else if (verdict.kind === 'running') {
    move.oneclickSaid = verdict.said;
    trySave(ledger);
    io.say(
      verdict.said === 'REFUNDED'
        ? `${what}: 1Click says it refunded it, and the refund does not show on T yet. Run convert again in a few minutes.`
        : `${what}: T's transfer to 1Click ran, and 1Click says ${verdict.said}, not done yet. Run convert again in a few minutes to see it land.`,
    );
  } else {
    trySave(ledger);
    io.say(`${what}: NEAR Intents has not answered either way yet, so the signed convert may still run. Run convert again in a few minutes; nothing new is converted until it ends.`);
  }
  return verdict.kind;
}

/* A convert an earlier run left pending. Nothing signed at all (a run stopped between writing it
   down and its rehearsal): nothing that can run exists. Only rehearsals signed: they share the
   convert's nonce and die a millisecond past their block, so they are judged once, never resent and
   never hold up a new convert. Signed and not proven: the same bytes go to 1Click again while
   they can still run, then the watch. 'open' only when signed bytes may still run. */
async function finish(ledger: Ledger, move: Move, net: MoneyNet, api: IntentsApiPort, io: Io): Promise<Verdict['kind']> {
  const signed = move.signed;
  if (signed === undefined && move.rehearsalDeadline === undefined) {
    move.state = 'failed';
    move.settledAt = nowIso(net);
    move.detail = 'Never signed: the run stopped before anything was signed. Nothing moved.';
    trySave(ledger);
    io.say(`${moveWords(move)}: ${move.detail}`);
    return 'dead';
  }
  if (signed === undefined) {
    const verdict = await judge(move, net, api);
    if (verdict.kind !== 'open' && verdict.kind !== 'running') return close(ledger, move, verdict, net, io);
    io.say(`${moveWords(move)}: only its rehearsal was signed, and NEAR Intents cannot show yet that it never ran. It is asked again at the next convert.`);
    return 'running';
  }
  let verdict = await judge(move, net, api);
  if (verdict.kind === 'open' && Date.parse(signed.deadline) > net.now()) {
    io.say('Signed in an earlier run and not proven either way yet: sending the same bytes to 1Click again. It is never signed twice.');
    const sent = await submitSignedIntent(api, { payload: signed.payload, signature: signed.signature });
    if (!sent.submitted) io.say(`1Click did not take them: ${oneLine(sent.error, 160)}. Waiting for NEAR Intents to say whether they ran.`);
  }
  if (verdict.kind === 'open' || verdict.kind === 'running') verdict = await watch(move, net, api);
  return close(ledger, move, verdict, net, io);
}

/* The rehearsal (see the header): 1Click's payload with its deadline cut to one millisecond past a
   final block, read back, written down, signed, and simulated at that block. A node a block behind
   cannot answer for a block it has not seen, so up to three blocks are tried. Null when NEAR
   Intents would run it; else the sentence that stops the convert before its real signature. */
async function rehearse(
  ledger: Ledger,
  move: Move,
  raw: string,
  signer: KeySigner,
  net: MoneyNet,
  expect: Omit<IntentPayloadExpectation, 'now'>,
): Promise<string | null> {
  const simulateAt = net.simulateAt;
  if (simulateAt === undefined) return 'this network cannot simulate at a fixed block, so nothing was signed';
  for (let tries = 0; tries < 3; tries += 1) {
    if (tries > 0) await net.sleep(1_000);
    const clock = await chainClock(net, REHEARSAL_AHEAD_MS);
    if (typeof clock === 'string') return `${clock}, so nothing was signed`;
    const deadline = signingDeadline(clock.block.atMs, REHEARSAL_LIFE_MS);
    const bytes = shortenDeadline(raw, Date.parse(deadline));
    if (intentDeadline(bytes) !== deadline) return "1Click's payload carries no one deadline to cut, so it was not rehearsed and nothing was signed";
    const problems = checkIntentPayload(bytes, { ...expect, now: clock.block.atMs });
    if (problems.length > 0) return `the rehearsal failed its own check, so nothing was signed: ${problems[0]}`;
    move.rehearsalDeadline = deadline;
    try {
      ledger.save();
    } catch (err) {
      return `the invite file could not be written (${errText(err)}), so nothing was signed`;
    }
    const sim = await simulateAt([{ standard: ERC191_STANDARD, payload: bytes, signature: await signer.sign(bytes) }], clock.block.hash).catch(() => null);
    if (sim === null) continue;
    if (!sim.ok) return `${REFUSALS[simulationVerdict(sim.refusal)]} The verifier said: ${oneLine(sim.refusal, 160)}. Only a rehearsal was signed`;
    return null;
  }
  return 'the verifier did not answer the rehearsal at three blocks in a row, so only rehearsals were signed';
}

/* One USDC to NEAR USDC: the shared spend path with the move written down and rehearsed before its
   one signature, and the signed bytes written down before submit-intent. True once it landed. */
async function convertOne(ledger: Ledger, plan: Planned, net: MoneyNet, api: IntentsApiPort, io: Io): Promise<boolean> {
  const book = ledger.book;
  const t = book.treasury.address;
  const held = plan.held;
  const floor = convertFloor(held);
  const expect = { signerId: t, originAsset: held.variant.assetId, destinationAsset: INVITE_ASSET_ID, amountBase: held.base, minOutBase: floor, maxDeadlineMs: SIGNED_DEADLINE_MS };
  const signer = treasurySigner(book, net);
  let move: Move | null = null;
  let generated: { handle: string; payload: string } | null = null;
  let quoted: OneClickQuote | null = null;

  const tracked: IntentsApiPort = {
    ...api,
    async generateIntent(params) {
      const answer = await api.generateIntent(params);
      generated = typeof answer.payload === 'string' ? { handle: params.depositAddress, payload: answer.payload } : null;
      return answer;
    },
  };

  const beforeSign = async (): Promise<string | null> => {
    const g = generated;
    const nonce = g === null ? undefined : intentNonce(g.payload);
    if (g === null || nonce === undefined) return "1Click's payload carries no nonce to prove the convert by, so nothing was signed";
    /* A V1 nonce must live past the signed deadline and the proof's floor, so a later run can prove
       the convert ran or never can. One that is not V1 is no proof either way, and judge falls back
       on 1Click's word and the deadline for it. */
    const parts = decodeNonce(nonce);
    if (parts !== null && parts.deadlineMs <= net.now() + SIGNED_DEADLINE_MS + FATE_FLOOR_MS) {
      return "1Click's payload carries a nonce whose life ends before NEAR Intents could prove the convert spent or dead, so nothing was signed";
    }
    const fresh: Move = {
      id: idOf(net),
      kind: 'convert',
      signer: t,
      legs: [{ receiverId: g.handle, amountBase: held.base.toString() }],
      state: 'pending',
      createdAt: nowIso(net),
      assetId: held.variant.assetId,
      handle: g.handle,
      nonce,
    };
    const q: OneClickQuote | null = quoted;
    if (q !== null) Object.assign(fresh, { quotedOut: baseUnits(q.amountOut, 'amountOut').toString(), minOut: baseUnits(q.minAmountOut, 'minAmountOut').toString() });
    book.moves.push(fresh);
    try {
      ledger.save();
    } catch (err) {
      book.moves.pop();
      return `the invite file could not be written (${errText(err)}), so nothing was signed`;
    }
    move = fresh;
    return rehearse(ledger, fresh, g.payload, signer, net, { ...expect, depositAddress: g.handle });
  };

  // The one signature: of the payload written down and rehearsed, and in the file before it is sent.
  const port = signerPort(
    signer,
    (payload) => {
      const m: Move | null = move;
      const deadline = Date.parse(intentDeadline(payload) ?? '');
      if (m === null || intentNonce(payload) !== m.nonce || !Number.isFinite(deadline)) throw new Error('the payload to sign is not the one written down and rehearsed');
      /* The deadline was cut on this Mac's clock (src/rails/intents-spend.ts), the rehearsal's on
         NEAR's: a Mac running fast would sign bytes that live past 1Click's ten-minute quote. */
      const ahead = deadline - Date.parse(m.rehearsalDeadline ?? '') - SIGNED_DEADLINE_MS;
      if (!(ahead <= CLOCK_AHEAD_MAX_MS)) {
        throw new Error(`this Mac's clock is ${Math.round(ahead / 1000)} s ahead of NEAR's final block, so three minutes on it is longer on NEAR; set the clock to automatic. Nothing that can run was signed`);
      }
    },
    (payload, signature) => {
      const m = move as Move;
      m.signed = { payload, signature, nonce: m.nonce!, deadline: intentDeadline(payload)!, intentHash: intentHashOf(payload) };
      try {
        ledger.save();
      } catch (err) {
        delete m.signed;
        throw new Error(`the invite file could not be written (${errText(err)}), so the signed convert was never sent`);
      }
    },
  );

  let outcome: IntentsSpendOutcome | null = null;
  let stop: string | null = null;
  try {
    outcome = await spendFromIntents(
      {
        api: tracked,
        signer: port,
        now: net.now,
        sleep: net.sleep,
        pollIntervalMs: net.pollMs ?? POLL_MS,
        pollTimeoutMs: SIGNED_DEADLINE_MS,
        firstPollMs: net.firstPollMs ?? FIRST_POLL_MS,
        maxDeadlineMs: SIGNED_DEADLINE_MS,
        signedDeadlineMs: SIGNED_DEADLINE_MS,
        beforeSign,
        ...(net.quoteKey === undefined ? {} : { quoteKey: net.quoteKey }),
      },
      {
        owner: t,
        originAsset: held.variant.assetId,
        destinationAsset: INVITE_ASSET_ID,
        amountBase: held.base,
        minOutBase: floor,
        recipient: t,
        recipientType: 'INTENTS',
        slippageToleranceBps: CONVERT_SLIPPAGE_BPS,
        echo: echoFor(t, held),
        checkQuote: (quote) => {
          quoted = quote;
          return convertQuoteProblems(quote, held);
        },
      },
    );
  } catch (err) {
    stop = errText(err);
  } finally {
    signer.drop();
  }

  // Assigned inside the hooks above, so read through a cast: TypeScript does not follow callbacks.
  const m = move as Move | null;
  if (m === null || m.signed === undefined) {
    // Nothing that can run left this Mac: a rehearsal at most, which dies a millisecond past its block.
    const why = stop ?? '1Click held it before anything was signed';
    const nothing = `${heldWords(held)}: not converted, and nothing that can run left this Mac: ${why}.`;
    if (m === null || m.rehearsalDeadline === undefined) {
      if (m !== null) {
        m.state = 'failed';
        m.settledAt = nowIso(net);
        m.detail = `Nothing that can run was sent: ${oneLine(why, 300)}`;
        trySave(ledger);
      }
      io.say(nothing);
      return false;
    }
    /* A rehearsal shares the convert's nonce, and an RPC that lies on a fast Mac could have run one:
       asked once now, and again at the next convert while it cannot be told. */
    m.detail = `Nothing that can run was sent: ${oneLine(why, 300)}`;
    const verdict = await judge(m, net, api);
    if (verdict.kind === 'open') {
      trySave(ledger);
      io.say(nothing);
      return false;
    }
    const ran = verdict.kind === 'done' || verdict.kind === 'running';
    io.say(ran ? `${heldWords(held)}: the convert itself was never signed (${why}), but NEAR Intents ran its rehearsal, which pays the same quote.` : nothing);
    return close(ledger, m, verdict, net, io) === 'done';
  }
  if (outcome?.signed === true && outcome.submitted) {
    io.say(`${heldWords(held)}: signed once and handed to 1Click (intent ${m.signed.intentHash}). Waiting for NEAR Intents and 1Click.`);
  } else {
    const said = outcome?.signed === true && !outcome.submitted ? outcome.error : (stop ?? 'no answer');
    io.say(`${heldWords(held)}: signed once, and 1Click did not take it: ${oneLine(said, 160)}. The signed bytes are in the invite file; waiting for NEAR Intents to say whether they ran.`);
  }
  return close(ledger, m, await watch(m, net, api), net, io) === 'done';
}

async function sayNearUsdc(net: MoneyNet, t: string, io: Io): Promise<void> {
  const now = await net.verifier.balance(t, INVITE_ASSET_ID).catch(() => null);
  io.say(now === null ? "Couldn't read T's NEAR USDC just now; `npm run invite -- status` shows it." : `T holds $${exactDollars(now)} of NEAR USDC now, the USDC a batch pays codes with.`);
}

/* Every other USDC T holds, to NEAR USDC. Converts an earlier run left are finished first, and
   while one of them can still run nothing new is signed. Then T is read live, each USDC holding a
   cent or more is priced, the list and what it should bring are shown, and after a yes each is
   converted in turn. 0 when nothing is left to convert or wait for. */
export async function convertTreasury(ledger: Ledger, net: MoneyNet, io: Io): Promise<number> {
  const book = ledger.book;
  const t = book.treasury.address;
  const api = net.oneclick ?? intentsApi({ apiKey: process.env[INTENTS_API_KEY_ENV] ?? '' });

  let open = false;
  for (const move of pendingMoves(book, 'convert')) {
    io.say(`Finishing the convert of ${moveWords(move)} from an earlier run.`);
    if ((await finish(ledger, move, net, api, io)) === 'open') open = true;
  }
  if (open) {
    io.say('A convert signed in an earlier run can still run, so nothing new was signed. Run convert again in a few minutes.');
    return 1;
  }

  const { held, unread } = await otherUsdc(net, t);
  for (const v of unread) io.say(`Couldn't read what T holds of USDC on ${v.chain}, so it is left for the next run.`);
  if (held.length === 0) {
    io.say(unread.length === 0 ? 'T holds no USDC but NEAR USDC. Nothing to convert.' : 'Nothing else to convert.');
    await sayNearUsdc(net, t, io);
    return unread.length === 0 && pendingMoves(book, 'convert').length === 0 ? 0 : 1;
  }

  io.say(`T holds ${heldList(held)} inside NEAR Intents. A code holds NEAR USDC only, so 1Click converts each:`);
  const plan = await priceAll(t, held, api, io);
  for (const p of plan) io.say(`  ${heldWords(p.held)} to about $${exactDollars(p.quotedOut)} of NEAR USDC, at least $${formatUsdc(p.minOut)}`);
  if (plan.length === 0) {
    io.say('Nothing was signed.');
    return 1;
  }
  const expected = plan.reduce((sum, p) => sum + p.quotedOut, 0n);
  const ok = await io.confirm(
    `Convert ${plan.length === 1 ? 'it' : `these ${plan.length}`} into about $${exactDollars(expected)} of NEAR USDC for T, with one signature from T for each?`,
  );
  if (!ok) {
    io.say('Stopped. Nothing was signed.');
    return 1;
  }

  let failures = unread.length;
  for (const p of plan) {
    if (!(await convertOne(ledger, p, net, api, io))) failures += 1;
  }
  await sayNearUsdc(net, t, io);
  return failures === 0 && plan.length === held.length && pendingMoves(book, 'convert').length === 0 ? 0 : 1;
}

/* A convert for a report: what went in and came out, and how it ended. No key, no payload. */
export function convertSummary(move: Move): Record<string, unknown> {
  return {
    asset: move.assetId,
    sent: moveWords(move),
    amountBase: move.legs[0]?.amountBase ?? null,
    quotedOut: move.quotedOut ?? null,
    minOut: move.minOut ?? null,
    creditedOut: move.creditedOut ?? null,
    handle: move.handle ?? null,
    nonce: move.nonce ?? null,
    intentHash: move.signed?.intentHash ?? null,
    deadline: move.signed?.deadline ?? null,
    state: move.state,
    oneclick: move.oneclickSaid ?? null,
    detail: move.detail ?? null,
    createdAt: move.createdAt,
    settledAt: move.settledAt ?? null,
  };
}
