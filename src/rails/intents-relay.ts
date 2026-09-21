// The relay swap rail: one atomic token_diff through the solver relay, signed with the EVM key
// over a balance that already sits inside intents.near. Spec: docs/superpowers/specs/2026-09-20-swap-relay-design.md.
//
// WHY THIS RAIL AND NOT THE 1CLICK ONE. The 1Click rail (./intents-native.ts) signs a `transfer`
// that hands the input to the solver's handle; the output arrives later as a separate
// settlement, and between those two moments the money is the solver's. A `token_diff` says
// "minus X of this, plus Y of that" on our account, the solver signs the mirror, and the
// verifier executes both in one call or neither. The diff we sign IS the price: a solver can
// give exactly Y or the call reverts, and less than Y is impossible.
//
// THE SEQUENCE, one signature, nothing sent on any chain by us:
//   1. quote: every solver answers inside 3 s; the largest amount_out whose amount_in equals
//      ours to the unit and whose expiry is at least 15 s ahead is the one. None at or above the
//      floor: refuse (simulate) or hold (execute), nothing signed.
//   2. balance: mt_batch_balance_of for the input asset; below amountIn refuses, nothing signed.
//   3. the payload is built here from the draft, the chosen quote and the app's own key and
//      clock, serialised once, read back by checkTokenDiffPayload as a stranger would, and only
//      then signed. The nonce is the verifier's versioned V1 shape and carries the contract's
//      current salt, read a moment before (src/relay/payload.ts).
//   4. the executor hears the nonce, the deadline and the quote hash BEFORE publish, so a
//      process that dies after the signature can be reconciled from the nonce alone.
//   5. publish_intent, once, with the one safe retry: identical bytes, once, only on no reply.
//   6. the executor hears the intent hash, then get_status every 3 s for 3 minutes. PENDING and
//      TX_BROADCASTED go on the row as the relay spells them; a word this app does not know is
//      never terminal.
//   7. SETTLED and the output balance rose by the signed diff (at most 1 pip under, the spec's
//      allowance for the protocol fee): executed. SETTLED and the balance has not shown it:
//      settling, the executor's needs_reconciliation path. Anything else: unconfirmed, hash and
//      nonce on the row, and no second signature.
//
// TWO PHASES, TWO CONTRACTS, the rule at the top of ./intents-spend.ts: before the signature
// every problem throws and the executor records the reason; after it nothing throws, every
// outcome returns, and the key is never used again for this move.
//
// FEES. The relay charges no app fee, keyed or not; the protocol fee stays; this rail adds none.
// There is no size floor of the 1Click kind because there is no flat routing fee. Where the
// protocol fee comes out, per the contract source (near/intents, contracts/defuse/core/src/
// intents/token_diff.rs, read 2026-09-20): the signer's account gets exactly the deltas it
// signed, and the fee is taken on the negative side at the supply level, so the solver's mirror
// covers it and our positive delta lands in full. The one-pip tolerance below is the spec's
// allowance, kept as a guard; the live proof pins whether it ever comes into play.

import { formatUnits } from 'viem';

import type { Rail, RailHooks, RailResult, SimulationResult, SwapDraft, SwapSimulation } from '../types.ts';
import type { OneClickClient, OneClickToken, TokensFile } from '../intents.ts';
import { oneClickClient, oneLine, resolveAsset, truncateToBaseUnits } from '../intents.ts';
import { INTENTS_VERIFIER } from '../ledger/intents.ts';
import { INTENTS_SETTLE, SETTLING_SENTENCE, watchRise } from '../ledger/settle.ts';
import type { RiseSchedule } from '../ledger/settle.ts';
import { nearChainSpec } from '../chain/near.ts';
import { ERC191_STANDARD, liveIntentsSigner } from '../intents-sign.ts';
import type { IntentsSignerPort } from '../intents-sign.ts';
import { relayClient } from '../relay/client.ts';
import type { RelayClient, RelayPublishResult, RelayQuote, RelayStatus } from '../relay/client.ts';
import { MAX_DEADLINE_MS, NONCE_RANDOM_BYTES, buildNonce, buildTokenDiffPayload, checkTokenDiffPayload, deadlineFor, pickQuote } from '../relay/payload.ts';
import { liveVerifier } from '../relay/verifier.ts';
import type { VerifierPort } from '../relay/verifier.ts';
import { MAX_SLIPPAGE_BPS, floorTooLow } from './slippage.ts';
import { noReply } from './intents-submit.ts';

// SwapDraft.venue for this rail. Kind 'swap' is shared with the 1Click rail; the venue routes.
export const INTENTS_RELAY_VENUE = 'intents-relay';

// The counterparty stays the verifier account, the same allowlist entry the 1Click rail uses:
// one fixed value for every swap forever, never a handle a quote minted.
export const INTENTS_RELAY_COUNTERPARTY = INTENTS_VERIFIER;

// A quote expiring sooner than this is not worth a signature: by the time it is signed and
// published it may be gone, and a dead publish is a signature released for nothing.
export const RELAY_MIN_QUOTE_AHEAD_MS = 15_000;

// The status poll: three seconds apart, three minutes at most (spec, "The sequence", 6).
export const RELAY_POLL_INTERVAL_MS = 3_000;
export const RELAY_POLL_TIMEOUT_MS = 180_000;

// The relay's two ending words. The other two (PENDING, TX_BROADCASTED) and anything this app
// has never seen keep the poll going: an unknown word is never terminal.
export const RELAY_TERMINAL: readonly string[] = ['SETTLED', 'NOT_FOUND_OR_NOT_VALID'];

/* How long the nonce outlives the intent's deadline. The nonce is what reconciliation asks the
   verifier by after a crash (is_nonce_used), and the contract may prune a nonce once ITS
   deadline has passed, after which a spent nonce reads as unspent. A nonce that lives as long as
   the reconcile sweep re-checks rows (seven days, src/proposals/reconcile.ts) keeps that answer
   true for every row the sweep can still ask about. A longer nonce life extends nothing about
   the intent: the intent's own deadline, two minutes at most, is what the contract executes by. */
export const NONCE_LIFE_AFTER_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

// The protocol fee's size, in basis points, and the most the settled balance may fall short of
// the signed diff and still count as the swap that was signed. The spec pins this at one pip.
export const PROTOCOL_FEE_BPS = 1n;

// A relay status word may not be one this app can print, and a poll that answered nothing has
// no word at all.
const NOT_POLLED = 'not polled';

export type IntentsRelayRailDeps = {
  keysPath: string;
  tokens: TokensFile;
  apiKey?: string;
  signer?: IntentsSignerPort;
  relay?: RelayClient;
  // The 1Click token list: asset ids and decimals for resolveAsset, prices for the fee line.
  // The registry hands every rail the same client so the list is fetched once.
  client?: OneClickClient;
  verifier?: VerifierPort;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  // The app's own randomness for the nonce; a test hands a fixed one to pin the bytes.
  random?: (bytes: number) => Uint8Array;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
  minQuoteAheadMs?: number;
  settleSchedule?: RiseSchedule;
};

export type IntentsRelayRail = Rail<SwapDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A hook is the executor's business; whatever it does with the evidence, it must not turn a
// signature that is already released into a thrown "nothing happened".
function tell(hooks: RailHooks | undefined, evidence: Parameters<NonNullable<RailHooks['onEvidence']>>[0]): void {
  try {
    hooks?.onEvidence?.(evidence);
  } catch {
    // reported by the executor's own persistence, not by this rail
  }
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// The most the settled balance may fall short of the signed diff: one pip of it, cut toward
// zero, so the tolerance never rounds up into a second pip.
export function settleTolerance(amountOut: bigint): bigint {
  return (amountOut * PROTOCOL_FEE_BPS) / 10_000n;
}

// A publish with the one retry that is safe after the signature is released: the same bytes
// again, once, and only when the first call got no reply at all. An answer of any kind, OK,
// FAILED or an error the relay wrote, is never resent (the rule in ./intents-submit.ts).
export async function publishOnce(
  relay: RelayClient,
  req: Parameters<RelayClient['publishIntent']>[0],
): Promise<{ answered: true; result: RelayPublishResult; attempts: number } | { answered: false; error: string; attempts: number }> {
  let attempts = 0;
  let lastError = '';
  while (attempts < 2) {
    attempts += 1;
    try {
      const result = await relay.publishIntent(req);
      return { answered: true, result, attempts };
    } catch (err) {
      lastError = errText(err);
      if (!noReply(err)) break;
    }
  }
  return { answered: false, error: lastError, attempts };
}

export function intentsRelayRail(deps: IntentsRelayRailDeps): IntentsRelayRail {
  const { keysPath, tokens } = deps;
  const signer = deps.signer ?? liveIntentsSigner;
  const relay = deps.relay ?? relayClient({ fetchImpl: deps.fetchImpl, ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }) });
  const client = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });
  const verifier = deps.verifier ?? liveVerifier(deps.fetchImpl ?? fetch);
  /* The two verifier reads that run after the signature, wrapped so a port that throws (the
     live one never does) cannot turn a released signature into a thrown "nothing happened".
     Null is the answer the rail already knows how to hold: unread, never zero, never unspent. */
  const readBalance = (account: string, asset: string): Promise<bigint | null> => verifier.balance(account, asset).catch(() => null);
  const readNonceUsed = (account: string, nonce: string): Promise<boolean | null> => verifier.nonceUsed(account, nonce).catch(() => null);
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? randomBytes;
  const pollIntervalMs = deps.pollIntervalMs ?? RELAY_POLL_INTERVAL_MS;
  const pollTimeoutMs = deps.pollTimeoutMs ?? RELAY_POLL_TIMEOUT_MS;
  const maxDeadlineMs = deps.maxDeadlineMs ?? MAX_DEADLINE_MS;
  const minQuoteAheadMs = deps.minQuoteAheadMs ?? RELAY_MIN_QUOTE_AHEAD_MS;
  const settleSchedule = deps.settleSchedule ?? INTENTS_SETTLE;

  // Every nonce this rail has signed, for as long as the process lives. A payload naming one
  // of these is refused before the key is touched: one signature per move, ever.
  const signedNonces = new Set<string>();

  type Plan = {
    assetIn: string;
    assetOut: string;
    inDecimals: number;
    outDecimals: number;
    amountBase: bigint;
    minOutBase: bigint;
    list: OneClickToken[];
  };

  function requireVenue(draft: SwapDraft): void {
    if (draft.venue !== INTENTS_RELAY_VENUE) {
      throw new Error(`intents-relay rail received a ${oneLine(draft.venue, 30)} draft; kind 'swap' is shared, venue is not`);
    }
    // Fixed and hardcoded. A draft naming anything else is either built against the wrong rail
    // or built by something choosing where the money goes.
    if (draft.counterparty !== INTENTS_RELAY_COUNTERPARTY) {
      throw new Error(
        `intents-relay drafts must name ${INTENTS_RELAY_COUNTERPARTY} as the counterparty (got ${oneLine(draft.counterparty, 60)}); ` +
          'the verifier account is fixed and never comes from a quote',
      );
    }
    // Both legs stay inside the verifier on our own account. Checked without reading the key
    // so simulate stays key-free; execute checks both against the real signer address.
    if (draft.from.toLowerCase() !== draft.to.toLowerCase()) {
      throw new Error(`intents-relay credits the proceeds to our own account inside the verifier, so a draft cannot send them from ${oneLine(draft.from, 50)} to ${oneLine(draft.to, 50)}`);
    }
  }

  async function plan(draft: SwapDraft): Promise<Plan> {
    requireVenue(draft);
    /* A floor of zero is not a floor. minOutBase is the number the payload is checked against
       and the number the balance read-back is judged by; against zero every payload passes. */
    if (!(draft.minAmountOut > 0)) throw new Error('minAmountOut is 0: refusing to swap with no slippage floor');

    // The same registry the 1Click rail reads (resolveAsset): the asset ids are pinned into
    // the plan here at propose time and compared again against the quote before signing.
    const list = await client.tokens();
    const origin = resolveAsset(draft.chain, draft.fromSymbol, tokens, list);
    const dest = resolveAsset(draft.toChain, draft.toSymbol, tokens, list);
    if (origin.assetId === dest.assetId) {
      throw new Error(`${draft.fromSymbol} on ${draft.chain} and ${draft.toSymbol} on ${draft.toChain} are the same asset inside the verifier`);
    }
    // Both money figures cut toward zero, never rounded: what is signed is at most what was
    // approved, and the floor held is at most the floor approved (frozen rule 2).
    return {
      assetIn: origin.assetId,
      assetOut: dest.assetId,
      inDecimals: origin.decimals,
      outDecimals: dest.decimals,
      amountBase: truncateToBaseUnits(draft.amountIn, origin.decimals),
      minOutBase: truncateToBaseUnits(draft.minAmountOut, dest.decimals),
      list,
    };
  }

  async function bestQuote(p: Plan): Promise<ReturnType<typeof pickQuote>> {
    const quotes = await relay.quote({ assetIn: p.assetIn, assetOut: p.assetOut, exactAmountIn: p.amountBase.toString() });
    return pickQuote(quotes, { assetIn: p.assetIn, assetOut: p.assetOut, amountIn: p.amountBase, now: now(), minAheadMs: minQuoteAheadMs });
  }

  function out(p: Plan, base: bigint): string {
    return formatUnits(base, p.outDecimals);
  }

  // The dollar price 1Click's list carries for an asset id, or null. A display figure for the
  // fee line, never a number that authorises anything.
  function priceOf(p: Plan, assetId: string): number | null {
    const row = p.list.find((t) => t.assetId === assetId);
    return row !== undefined && typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null;
  }

  // The fee as the quote against the draft's USD: what leaves, priced by the app, minus what
  // arrives, priced by the list. Null when the output has no price; never below zero, because a
  // stale price on one side is not a rebate on the other.
  function feeUsd(draft: SwapDraft, p: Plan, quote: RelayQuote): number | null {
    const price = priceOf(p, p.assetOut);
    if (price === null || !Number.isFinite(draft.amountUsd)) return null;
    const outUsd = Number(out(p, BigInt(quote.amountOut))) * price;
    return Math.max(0, Math.round((draft.amountUsd - outUsd) * 10_000) / 10_000);
  }

  function goodForSec(quote: RelayQuote): number {
    return Math.max(0, Math.round((Date.parse(quote.expirationTime) - now()) / 1000));
  }

  /* The same figures as fields, for the decision card: what arrives at this price, the floor
     the human approves (the draft's own, since on this rail the floor is ours and not a
     solver's), the fee, and how long the price is good for. The card says the last one as
     "price good for about a minute, re-quoted at your click". */
  function swapFacts(draft: SwapDraft, p: Plan, quote: RelayQuote): SwapSimulation {
    return {
      receives: out(p, BigInt(quote.amountOut)),
      receivesAtLeast: out(p, p.minOutBase),
      feeUsd: feeUsd(draft, p, quote),
      etaSeconds: null,
      priceGoodForSec: goodForSec(quote),
    };
  }

  function priceLines(draft: SwapDraft, p: Plan, quote: RelayQuote): string[] {
    const fee = feeUsd(draft, p, quote);
    return [
      `intents-relay: ${draft.amountIn} ${draft.fromSymbol} -> ${out(p, BigInt(quote.amountOut))} ${draft.toSymbol}, one atomic swap inside ${INTENTS_VERIFIER}`,
      `fee ${fee === null ? 'unknown' : '$' + fee.toFixed(4)}, price good for ${goodForSec(quote)}s and re-quoted at your click, ` +
        `floor ${draft.minAmountOut} ${draft.toSymbol} (${p.minOutBase.toString()} base units)`,
    ];
  }

  function floorSentence(draft: SwapDraft, p: Plan, quote: RelayQuote): string {
    return `best price is ${out(p, BigInt(quote.amountOut))} ${draft.toSymbol}, your floor is ${draft.minAmountOut} ${draft.toSymbol}`;
  }

  function noPriceSentence(draft: SwapDraft): string {
    return `no solver offered a price for ${draft.amountIn} ${draft.fromSymbol} to ${draft.toSymbol} right now`;
  }

  function valueUsd(draft: SwapDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: SwapDraft): Promise<SimulationResult> {
    try {
      const p = await plan(draft);
      const pick = await bestQuote(p);
      if (pick.chosen === null) {
        const why = [noPriceSentence(draft), ...pick.passed].join('; ');
        return { ok: false, summary: `REFUSED: ${why}`, error: why };
      }
      const quote = pick.chosen;
      const swap = swapFacts(draft, p, quote);
      const lines = priceLines(draft, p, quote);
      const amountOut = BigInt(quote.amountOut);
      // The quote is the gate on which price is accepted, not a floor the venue may fill down
      // to: a quote under the floor is never signed, and at simulate time that is a refusal.
      if (amountOut < p.minOutBase) {
        const why = floorSentence(draft, p, quote);
        return { ok: false, summary: [`REFUSED: ${why}`, ...lines].join('\n'), error: why, swap };
      }
      if (floorTooLow(amountOut, p.minOutBase, MAX_SLIPPAGE_BPS)) {
        const why =
          `the draft floor of ${draft.minAmountOut} ${draft.toSymbol} is more than ${MAX_SLIPPAGE_BPS / 100}% below the ` +
          `${out(p, amountOut)} ${draft.toSymbol} this swap quotes: a floor that low is an invitation to a sandwich, not slippage protection`;
        return { ok: false, summary: [`REFUSED: ${why}`, ...lines].join('\n'), error: why, swap };
      }
      lines.push(`execution signs one token_diff with the EVM key and transfers nothing; the verifier moves both sides in one call or neither`);
      return { ok: true, summary: lines.join('\n'), swap };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents-relay simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: SwapDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    const p = await plan(draft);

    // The draft names the account a human approved, and the account id inside the verifier IS
    // this address: a different key would be swapping somebody else's balance.
    const owner = signer.address(keysPath);
    const account = owner.toLowerCase();
    if (draft.from.toLowerCase() !== account) {
      throw new Error(`draft is authored for ${draft.from} but the configured key is ${owner}`);
    }

    /* THE LIVE QUOTE. A relay quote lives about a minute, so a swap that waited for a click is
       priced again here. At or above the floor: sign. Below, or no price at all: hold, with
       both numbers in the sentence, and the executor tries again in a while. Nothing is signed
       on a hold. */
    const pick = await bestQuote(p);
    if (pick.chosen === null) {
      // Every answer the relay gave and why it was passed over rides in the sentence, the same
      // words simulate uses: a hold that says only "no price" hides a relay that did answer.
      return {
        ok: false,
        held: true,
        detail: `${[noPriceSentence(draft), ...pick.passed].join('; ')}. Nothing was signed; the price is asked for again in a while.`,
      };
    }
    const quote = pick.chosen;
    const amountOut = BigInt(quote.amountOut);
    if (amountOut < p.minOutBase) {
      return { ok: false, held: true, detail: `${floorSentence(draft, p, quote)}. Nothing was signed; the price is asked for again in a while.` };
    }
    if (floorTooLow(amountOut, p.minOutBase, MAX_SLIPPAGE_BPS)) {
      throw new Error(
        `the draft floor of ${draft.minAmountOut} ${draft.toSymbol} is more than ${MAX_SLIPPAGE_BPS / 100}% below the ` +
          `${out(p, amountOut)} ${draft.toSymbol} this swap quotes; refusing to sign against a floor that low`,
      );
    }

    /* THREE READS BEFORE THE KEY: the input balance, the output balance and the salt. The
       input read refuses only where it is certain: a balance the verifier reports as short is a
       refusal, a read that did not answer is not a balance of zero and lets the contract answer
       (a short balance fails the relay's own simulation with nothing executed). The output read
       is what the settle check subtracts from. The salt is what the nonce has to carry, and
       without it no nonce the contract would accept can be made, so that read failing refuses. */
    const [held, beforeBase, salt] = await Promise.all([
      verifier.balance(account, p.assetIn),
      verifier.balance(account, p.assetOut),
      verifier.currentSalt(),
    ]);
    if (held !== null && held < p.amountBase) {
      throw new Error(
        `the balance inside ${INTENTS_VERIFIER} holds ${formatUnits(held, p.inDecimals)} ${draft.fromSymbol}, less than the ` +
          `${draft.amountIn} ${draft.fromSymbol} this swap spends; nothing was signed`,
      );
    }
    if (salt === null) {
      throw new Error(`the verifier did not answer with its current salt, so no nonce it would accept could be made; nothing was signed`);
    }

    const signedAt = now();
    const deadline = deadlineFor(quote.expirationTime, signedAt, maxDeadlineMs);
    const nonce = buildNonce({ salt, deadlineMs: Date.parse(deadline) + NONCE_LIFE_AFTER_DEADLINE_MS, random: random(NONCE_RANDOM_BYTES) });
    const payload = buildTokenDiffPayload({
      signerId: account,
      assetIn: p.assetIn,
      assetOut: p.assetOut,
      amountIn: p.amountBase,
      amountOut,
      deadline,
      nonce,
    });

    // The second reader, on the string that is about to be signed, with no access to how it
    // was built. A payload it refuses is a builder that changed, and nothing is signed.
    const problems = checkTokenDiffPayload(payload, {
      signerId: account,
      assetIn: p.assetIn,
      assetOut: p.assetOut,
      amountIn: p.amountBase,
      minOut: p.minOutBase,
      quoteOut: amountOut,
      now: signedAt,
      maxDeadlineMs,
      usedNonces: signedNonces,
      salt,
    });
    if (problems.length > 0) throw new Error(`refusing to sign the payload this app built: ${problems.join('; ')}`);

    // Signed exactly as built: the string above is the string sent, byte for byte.
    const signature = await signer.signErc191(keysPath, payload);
    signedNonces.add(nonce);
    const relayQuote = { quoteHash: quote.quoteHash, amountIn: quote.amountIn, amountOut: quote.amountOut, expiration: quote.expirationTime };
    tell(hooks, { nonce, deadline, relayQuote });

    /* Nothing throws from here on, and the key is never used again for this move. A publish
       with no reply may be an intent the relay took; the executor hears that as a fact about the
       money rather than as a rail that threw. */
    const facts = `quote ${quote.quoteHash}, nonce ${nonce}, deadline ${deadline}`;
    const sent = await publishOnce(relay, { quoteHashes: [quote.quoteHash], standard: ERC191_STANDARD, payload, signature });
    if (!sent.answered) {
      return {
        ok: false,
        detail:
          `the intent was signed and sent to the relay, and the relay did not answer (${oneLine(sent.error, 80)}); ${facts}. ` +
          `THE INTENT IS SIGNED and may still execute until its deadline, so nothing more will be signed: the verifier is asked ` +
          'by the nonce on the next check.',
        evidence: { nonce, deadline, relayQuote },
      };
    }
    if (sent.result.status === 'FAILED') {
      /* The relay answered that it did not take the intent, which in its own status words is
         NOT_FOUND_OR_NOT_VALID: the stage the card reads. The nonce stays on the row from the
         hook above, so the row is unconfirmed underneath and the sweep proves it dead once the
         deadline has passed (is_nonce_used false), rather than this app taking the relay's word
         for what the verifier did. */
      return {
        ok: false,
        detail: `the relay refused the intent: ${sent.result.reason}. Nothing was executed and nothing more will be signed; ${facts}.`,
        evidence: { nonce, deadline, relayQuote, providerStage: 'NOT_FOUND_OR_NOT_VALID' },
      };
    }
    const intentHash = sent.result.intentHash;
    tell(hooks, { txids: [intentHash], handle: intentHash, nonce, deadline, relayQuote });
    const evidence = `intent ${intentHash}, ${facts}`;

    const watch = await watchStatus(intentHash, hooks);
    const nearTx = watch.last.nearTxHash;
    const txids = nearTx === null ? [intentHash] : [intentHash, nearTx];
    const explorerUrl = nearTx === null ? undefined : `${nearChainSpec().explorerTx}${nearTx}`;
    const railEvidence = {
      handle: intentHash,
      nonce,
      deadline,
      relayQuote,
      providerStage: watch.last.status,
      ...(explorerUrl === undefined ? {} : { explorerUrl }),
    };
    const pocketOf = (after: bigint | null) =>
      beforeBase === null
        ? undefined
        : {
            venue: 'intents' as const,
            account,
            assetId: p.assetOut,
            symbol: draft.toSymbol,
            decimals: p.outDecimals,
            before: beforeBase.toString(),
            after: after === null ? null : after.toString(),
            // The signed diff less one pip: what the balance has to rise by for this to be the
            // swap that was signed. The executor re-judges a settling row against this.
            floor: (amountOut - settleTolerance(amountOut)).toString(),
          };

    if (watch.last.status === 'SETTLED') {
      /* SETTLED is the contract's word: the diff executed in one call. What arrived is still
         read back, because the row's "done" is a balance and not a status, and the verifier read
         asks NEAR at finality final, a block or two behind the relay. Read until it shows. */
      const tolerance = settleTolerance(amountOut);
      const settle =
        beforeBase === null
          ? { last: await readBalance(account, p.assetOut), rose: false, reads: 1, waitedMs: 0 }
          : await watchRise({
              read: () => readBalance(account, p.assetOut),
              rose: (after) => after - beforeBase >= amountOut - tolerance,
              schedule: settleSchedule,
              sleep,
              now,
            });
      const afterBase = settle.last;
      const pocket = pocketOf(afterBase);
      if (beforeBase !== null && afterBase !== null) {
        const delta = afterBase - beforeBase;
        // What THIS swap credited: the diff is atomic, so a rise past it is another credit
        // landing in the same window and not a bigger fill.
        const credited = delta > amountOut ? amountOut : delta;
        if (delta < amountOut - tolerance) {
          // Not shown inside the window, or short of the diff by more than the protocol fee.
          // The contract's word stands and the one thing that must not happen now is a second
          // signature; the next balance read that shows the diff settles the row.
          return {
            ok: false,
            settling: true,
            detail:
              `${SETTLING_SENTENCE} Watched ${draft.toSymbol} for ${account} inside ${INTENTS_VERIFIER} for ` +
              `${Math.round(settle.waitedMs / 1000)}s over ${settle.reads} reads and it rose by ${out(p, delta)} against a signed ` +
              `${out(p, amountOut)}; ${evidence}.`,
            txids,
            pocket,
            evidence: railEvidence,
          };
        }
        return {
          ok: true,
          detail:
            `swapped ${draft.amountIn} ${draft.fromSymbol} for ${out(p, credited)} ${draft.toSymbol} inside ${INTENTS_VERIFIER}, ` +
            `read back from the verifier and matching the signed diff of ${out(p, amountOut)} ${draft.toSymbol} ` +
            `${credited === amountOut ? 'to the unit' : `less the protocol fee (${out(p, amountOut - credited)} ${draft.toSymbol})`}; ${evidence}. ` +
            `Nothing was transferred on any chain and the proceeds are credited to ${account} inside the verifier.`,
          txids,
          pocket,
          evidence: { ...railEvidence, settledAmountOut: out(p, credited) },
        };
      }
      /* This app could not read the balance either side, so the relay's word is checked against
         the chain instead: the nonce is committed in the same call that applies the diff, and a
         spent nonce IS the swap having executed. A success then says which half is measured and
         which is the chain's word; anything less is unconfirmed, never a success on the relay's
         word alone, and the sweep asks the verifier again. */
      const spent = await readNonceUsed(account, nonce);
      if (spent === true) {
        return {
          ok: true,
          detail:
            `swapped ${draft.amountIn} ${draft.fromSymbol} for the signed ${out(p, amountOut)} ${draft.toSymbol} inside ${INTENTS_VERIFIER}; ${evidence}. ` +
            `The relay reports it settled on NEAR and the verifier shows the nonce spent; the balance could not be read back, so the amount out is ` +
            'the signed diff rather than an observed figure. Nothing was transferred on any chain.',
          txids,
          ...(pocket === undefined ? {} : { pocket }),
          evidence: railEvidence,
        };
      }
      return {
        ok: false,
        settling: true,
        detail:
          `the relay reports the swap settled on NEAR and the verifier has not shown the nonce spent${spent === null ? ' (it did not answer)' : ''}; ` +
          `the balance could not be read back either; ${evidence}. Nothing more will be signed; the verifier is asked again on the next check.`,
        txids,
        ...(pocket === undefined ? {} : { pocket }),
        evidence: railEvidence,
      };
    }

    if (watch.last.status === 'NOT_FOUND_OR_NOT_VALID') {
      return {
        ok: false,
        detail:
          `the relay reports the intent as not found or not valid (${oneLine(watch.last.statusDetails ?? 'no detail', 120)}) after ` +
          `${Math.round(watch.waitedMs / 1000)}s; ${evidence}. Nothing more will be signed: the verifier is asked by the nonce once the deadline has passed.`,
        txids,
        evidence: railEvidence,
      };
    }

    // Timed out, or a word this app does not know. The signature is released and the intent is
    // with the relay, so the swap may still complete: unconfirmed, never failed, with the hash
    // and the nonce on the row for the sweep.
    return {
      ok: false,
      detail:
        `the intent was published and the relay had not settled it within ${Math.round(pollTimeoutMs / 1000)}s ` +
        `(last status ${oneLine(watch.last.status, 40)}); ${evidence}. THE INTENT IS SIGNED AND PUBLISHED and may still ` +
        `complete until its deadline, so it is unconfirmed: nothing more will be signed, and the verifier is asked by the nonce on the next check.`,
      txids,
      evidence: railEvidence,
    };
  }

  /* Polls until the relay says an ending word, or the window is spent. Never throws once the
     intent is published. Every poll tells the executor which word the relay used, as the relay
     spells it, and hands over the NEAR hash the moment there is one. Bounded by the clock AND
     by the waits it asked for, so a frozen test clock still ends it. */
  async function watchStatus(intentHash: string, hooks?: RailHooks): Promise<{ last: RelayStatus; waitedMs: number }> {
    const deadline = now() + pollTimeoutMs;
    let last: RelayStatus = { intentHash, status: NOT_POLLED, statusDetails: null, nearTxHash: null, filledAmounts: [] };
    let toldHash = false;
    let waited = 0;
    for (;;) {
      try {
        last = await relay.status(intentHash);
        if (last.nearTxHash !== null && !toldHash) {
          toldHash = true;
          tell(hooks, {
            providerStage: last.status,
            txids: [intentHash, last.nearTxHash],
            explorerUrl: `${nearChainSpec().explorerTx}${last.nearTxHash}`,
          });
        } else {
          tell(hooks, { providerStage: last.status });
        }
        if (RELAY_TERMINAL.includes(last.status)) return { last, waitedMs: waited };
      } catch (err) {
        last = { ...last, statusDetails: `status check failed: ${oneLine(errText(err), 80)}` };
      }
      if (now() + pollIntervalMs > deadline || waited + pollIntervalMs > pollTimeoutMs) return { last, waitedMs: waited };
      await sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  }

  return { kind: 'swap', valueUsd, simulate, execute };
}
