// The sentences every rail that goes through 1Click says about the same facts, in one place.
//
// Six rails watch the same status endpoint and used to describe its answers in six wordings,
// and three of them promised a refund the API had not reported. A human and an agent read
// these sentences to decide whether to move the money again, so the words are held to one
// rule: nothing is asserted that the code did not observe. A figure from a quote is called
// quoted, a move the venue has not confirmed is called unconfirmed, and a refund is named
// only with the amount the API reported.

import type { RailEvidence, RailResult } from '../types.ts';
import { oneLine } from '../intents.ts';
import type { OneClickStatus } from '../intents.ts';

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

// What a rail says about the same order in its own words: the asset that went in, where a
// refund of it lands, and the evidence line it has already built.
export type RefundWords = {
  symbol: string;
  refundTarget: string; // where a refund of the input lands, as the rail would name it
  evidence: string;
  primaryTxid: string;
};

// REFUNDED and FAILED are two facts and get two sentences, each built from a field the API
// returned. REFUNDED names the amount that went back. FAILED names what was refunded so far,
// which can be nothing, and says where the input sits: the incident this replaces had three
// rails announce "a refund is credited back to your balance" over a FAILED with refundedAmount
// 0, while the money sat with 1Click under the handle.
export function describeRefund(status: OneClickStatus, handle: string, words: RefundWords): RailResult {
  const shortHandle = oneLine(handle, 80);
  const amount = status.refundedAmount;
  const zero = amount === undefined || Number(amount) === 0;
  const evidence: RailEvidence = {
    handle: shortHandle,
    refundedAmount: amount ?? '0',
    ...(status.refundReason !== undefined ? { refundReason: status.refundReason } : {}),
  };
  const txids = uniqueTxids(words.primaryTxid, status);

  if (status.status === 'REFUNDED') {
    return {
      ok: false,
      detail: zero
        ? `1click reported REFUNDED and named no refunded amount; whether the ${words.symbol} is back at ` +
          `${words.refundTarget} is unconfirmed until a read shows it; ${words.evidence}.`
        : `1click reported REFUNDED: ${amount} ${words.symbol} went back to ${words.refundTarget}; ${words.evidence}. ` +
          'Read the balance before signing another.',
      txids,
      evidence,
    };
  }

  const reason = status.refundReason ?? 'not given';
  return {
    ok: false,
    detail:
      `1click reported FAILED and refunded ${amount ?? '0'} ${words.symbol} so far; the input is held by 1Click ` +
      `under handle ${shortHandle}; reason ${reason}; ${words.evidence}. ` +
      (zero
        ? 'Nothing is back in your balance until a refund shows there.'
        : `Only that refund is back at ${words.refundTarget}; read it before signing another.`),
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
    detail:
      `1click reported INCOMPLETE_DEPOSIT: it saw ${seen} arrive against a quoted ${words.quotedIn} ${words.symbol}, ` +
      `so the order does not run; 1Click's documented behaviour is to refund a short deposit to ${words.refundTarget} at the ` +
      `quote deadline, and that refund is unconfirmed until it shows there; ${words.evidence}. Do not send more to handle ${shortHandle}.`,
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
    detail:
      `the intent was signed and its submission is unconfirmed (${oneLine(args.error, 160)}); ` +
      `handle ${handle}, deadline ${oneLine(args.deadline, 40)}. The intent may still be accepted until that deadline. ` +
      'Read the balance and the 1Click status for the handle before signing another.',
    txids: [],
    evidence: { handle, deadline: oneLine(args.deadline, 40) },
  };
}
