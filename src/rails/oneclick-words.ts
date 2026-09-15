// The sentences every rail that goes through 1Click says about the same facts, in one place.
//
// Six rails watch the same status endpoint and used to describe its answers in six wordings,
// and three of them promised a refund the API had not reported. A human and an agent read
// these sentences to decide whether to move the money again, so the words are held to one
// rule: nothing is asserted that the code did not observe. A figure from a quote is called
// quoted, a move the venue has not confirmed is called unconfirmed, and a refund is named
// only with the amount the API reported.

import type { RailResult } from '../types.ts';
import { oneLine } from '../intents.ts';

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
