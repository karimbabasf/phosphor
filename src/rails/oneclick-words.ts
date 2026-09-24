// The sentences every rail that goes through 1Click says about the same facts, in one place.
//
// Six rails watch the same status endpoint and used to describe its answers in six wordings,
// and three of them promised a refund the API had not reported. A human and an agent read
// these sentences to decide whether to move the money again, so the words are held to one
// rule: nothing is asserted that the code did not observe. A figure from a quote is called
// quoted, a move the venue has not confirmed is called unconfirmed, and a refund is named
// only with the amount the API reported.

import type { Preflight, RailEvidence, RailHooks, RailResult } from '../types.ts';
import { oneLine } from '../intents.ts';
import type { OneClickStatus } from '../intents.ts';
import type { QuoteRecord } from '../quote-signature.ts';

// A hook is the executor's business. Whatever it does with the evidence, it must not turn a
// transfer that is already on the wire into a thrown "nothing happened".
export function tell(hooks: RailHooks | undefined, evidence: Parameters<NonNullable<RailHooks['onEvidence']>>[0]): void {
  try {
    hooks?.onEvidence?.(evidence);
  } catch {
    // reported by the executor's own persistence, not by this rail
  }
}

// The same answer with the signed quote on its evidence. Every answer a rail gives after the
// quote was verified carries it, whatever the venue then said, because the dispute a signed
// quote settles is most likely on exactly the answers that were not a clean success.
export function withQuote(result: RailResult, quote: QuoteRecord): RailResult {
  return { ...result, evidence: { ...result.evidence, quote } };
}

// The hashes a row keeps, in the order they were learned, with none repeated. The primary
// one is what this app produced (an intent hash, a chain transaction, a ledger hash); the rest
// are what 1Click reported around it.
export function uniqueTxids(primary: string, status: OneClickStatus): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [primary, ...status.originTxHashes, ...status.destinationTxHashes, ...status.nearTxHashes]) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// The figure a success sentence reports for what arrived. The API's settled amount when it
// gave one; otherwise the quote, and then the word quoted goes in front, because a quote is
// the solver's promise and every rail used to print it as the delivery.
export function deliveredAmount(status: OneClickStatus, quotedOut: unknown): string {
  return status.settledAmountOut !== undefined ? status.settledAmountOut : `a quoted ${oneLine(quotedOut, 40)}`;
}

// The half sentence that says which of the two the figure is.
export function deliveredNote(status: OneClickStatus): string {
  return status.settledAmountOut !== undefined
    ? 'the amount 1click reported settled'
    : '1click reported no settled amount, so that figure is the quote';
}

export function settledEvidence(status: OneClickStatus, handle: string): RailEvidence {
  return {
    handle: oneLine(handle, 80),
    ...(status.settledAmountOut !== undefined ? { settledAmountOut: status.settledAmountOut } : {}),
  };
}

// What a rail says about the same order in its own words: the asset that went in, where a
// refund of it lands, and the evidence line it has already built.
export type RefundWords = {
  symbol: string;
  refundTarget: string; // where a refund of the input lands, as the rail would name it
  evidence: string;
  primaryTxid: string;
  // The rail moved the input itself and holds the hash of that transfer (a venue send it
  // broadcast), so the input has left whatever the venue did with it afterwards.
  inputSent?: boolean;
};

/* The balance the move spent, read by the rail either side of it, in base units. Null is a read
   that failed, never a balance of zero. */
export type InputRead = { before: bigint | null; after: bigint | null; amountBase: bigint; decimals: number };

/* WHETHER THE INPUT LEFT THE BALANCE, from what was observed and nothing else.
   'yes': the rail sent the input itself, a FAILED order carrying any transfer hash (for a move out
   of the intents balance, the funding transfer having run), or a REFUNDED order whose balance has
   not climbed back. 'no': both reads answered and the balance is not below where it started, so
   nothing is missing from it (a refund that already came back reads the same way). A FAILED order
   whose balance fell with no hash is 'unknown': another move spending the same coin in the same
   minute reads exactly the same. */
export function inputMoved(status: OneClickStatus, read?: InputRead, sent = false): 'yes' | 'no' | 'unknown' {
  const hashes = status.nearTxHashes.length + status.originTxHashes.length + status.destinationTxHashes.length;
  if (sent) return 'yes';
  if (status.status === 'FAILED' && hashes > 0) return 'yes';
  if (read !== undefined && read.before !== null && read.after !== null) {
    if (read.after >= read.before) return 'no';
    return status.status === 'FAILED' ? 'unknown' : 'yes';
  }
  return hashes > 0 ? 'yes' : 'unknown';
}

function units(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, '0');
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${digits.slice(0, digits.length - decimals)}${frac === '' ? '' : `.${frac}`}`;
}

// REFUNDED and FAILED are two facts and get two sentences, each built from a field the API
// returned and from the balance the rail read, when it read one. Nothing here says where the
// input sits unless something showed it: "held by 1Click under handle" was printed over three
// FAILED swaps whose input never left the balance (2026-09-23), and "a refund is credited back"
// over FAILED orders that refunded nothing (2026-09-15). `reason` is the code the card reads.
export function describeRefund(status: OneClickStatus, handle: string, words: RefundWords, read?: InputRead): RailResult {
  const shortHandle = oneLine(handle, 80);
  const amount = status.refundedAmount;
  const zero = amount === undefined || Number(amount) === 0;
  const evidence: RailEvidence = {
    handle: shortHandle,
    refundedAmount: amount ?? '0',
    ...(status.refundReason !== undefined ? { refundReason: status.refundReason } : {}),
  };
  const txids = uniqueTxids(words.primaryTxid, status);
  const moved = inputMoved(status, read, words.inputSent === true);
  const reading =
    read !== undefined && read.before !== null && read.after !== null
      ? `the ${words.symbol} balance reads ${units(read.after, read.decimals)} against ${units(read.before, read.decimals)} before the swap`
      : `the ${words.symbol} balance was not read either side`;

  if (status.status === 'REFUNDED') {
    if (moved === 'no') {
      return {
        ok: false,
        reason: 'refunded',
        detail: `1click reported REFUNDED${zero ? '' : ` ${amount} ${words.symbol}`} and ${reading}, so it is back; ${words.evidence}.`,
        txids,
        evidence,
      };
    }
    return {
      ok: false,
      reason: zero ? 'stuck_unknown' : 'venue_failed_refund_pending',
      detail: zero
        ? `1click reported REFUNDED and named no refunded amount; whether the ${words.symbol} is back at ` +
          `${words.refundTarget} is unconfirmed until a read shows it; ${reading}; ${words.evidence}.`
        : `1click reported REFUNDED: ${amount} ${words.symbol} went back to ${words.refundTarget}, and ${reading}; ${words.evidence}. ` +
          'It settles when the balance shows it.',
      txids,
      evidence,
    };
  }

  const why = status.refundReason ?? 'not given';
  if (moved === 'no') {
    return {
      ok: false,
      reason: 'venue_failed_nothing_moved',
      detail: `1click reported FAILED (reason ${why}) and nothing left the balance: ${reading}; ${words.evidence}.`,
      txids,
      evidence,
    };
  }
  if (moved === 'yes') {
    return {
      ok: false,
      reason: 'venue_failed_refund_pending',
      detail:
        `1click reported FAILED and refunded ${amount ?? '0'} ${words.symbol} so far; the ${words.symbol} left the balance for ` +
        `the swap service's handle ${shortHandle} and is not back yet; reason ${why}; ${reading}; ${words.evidence}. ` +
        (zero ? 'It settles when a refund shows in the balance.' : `That refund goes to ${words.refundTarget}.`),
      txids,
      evidence,
    };
  }
  return {
    ok: false,
    reason: 'stuck_unknown',
    detail:
      `1click reported FAILED and refunded ${amount ?? '0'} ${words.symbol} so far; whether the ${words.symbol} left the balance ` +
      `is not confirmed, because ${reading} and 1click reports no transfer hash; reason ${why}; ${words.evidence}. ` +
      'The app keeps checking; read the balance before trying again.',
    txids,
    evidence,
  };
}

// The deposit arrived short of the quote. This app sends exactly once, so nothing it does
// afterwards completes the order; 1Click's documented behaviour is to refund a short deposit
// at the quote deadline, and until that shows the money is neither here nor delivered.
export function describeIncompleteDeposit(status: OneClickStatus, handle: string, words: RefundWords & { quotedIn: string }): RailResult {
  const shortHandle = oneLine(handle, 80);
  const seen = status.depositedAmount !== undefined ? `${status.depositedAmount} ${words.symbol}` : `less than the quoted amount of ${words.symbol}`;
  return {
    ok: false,
    reason: 'venue_failed_refund_pending',
    detail:
      `1click reported INCOMPLETE_DEPOSIT: it saw ${seen} arrive against a quoted ${words.quotedIn} ${words.symbol}, ` +
      `so the order does not run; 1Click's documented behaviour is to refund a short deposit to ${words.refundTarget} at the ` +
      `quote deadline, and that refund is unconfirmed until it shows there; ${words.evidence}. Nothing more is sent to handle ${shortHandle}.`,
    txids: uniqueTxids(words.primaryTxid, status),
    evidence: { handle: shortHandle },
  };
}

// The signature was released and the submit call did not answer, or answered with an error.
// The intent may be live at 1Click until its deadline, so this is unconfirmed rather than
// failed, and the handle is what a later check asks about.
export function describeUnconfirmedSubmit(args: { error: string; handle: string; deadline: string }): RailResult {
  const handle = oneLine(args.handle, 80);
  return {
    ok: false,
    reason: 'stuck_unknown',
    detail:
      `the intent was signed and its submission is unconfirmed (${oneLine(args.error, 160)}); ` +
      `handle ${handle}, deadline ${oneLine(args.deadline, 40)}. The intent may still be accepted until that deadline. ` +
      'Read the balance and the 1Click status for the handle before signing another.',
    txids: [],
    evidence: { handle, deadline: oneLine(args.deadline, 40) },
  };
}

// The preflight said hold or fail, and nothing was generated or signed. A hold is the
// executor's to retry (src/proposals/execute.ts); a fail stops with the reason. Either way the
// checks ride on the result so the row and the receipt can draw them.
export function describeHeld(preflight: Preflight): RailResult {
  const reason = preflight.holdReason ?? 'the preflight did not pass';
  const failing = preflight.checks.filter((c) => c.state === 'fail').map((c) => `${c.label}: ${c.detail}`);
  return {
    ok: false,
    held: preflight.verdict === 'hold',
    detail: `${reason}. Nothing was signed. ${failing.join(' ')}`.trim(),
    preflight,
  };
}
