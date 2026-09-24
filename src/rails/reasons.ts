// Why a move stopped or ended, as one code from one list.
//
// The rails, the draft builder and the executor name the code; the sentence a person reads for
// it lives in one place, the proposal view (src/proposals/view.ts), so the card and the agent
// can only ever say the same thing about the same row. A code names the CAUSE, never the status:
// a row refused because nobody quoted a price and a row refused by the person's own cap are both
// `policy_refused`, and the card blamed "a rule you set" for both (2026-09-23).

export const REASON_CODES = [
  // Waiting for the person's click. Not a failure; the plain state is needs_you.
  'needs_approval',
  // The person's own rules.
  'over_trade_cap',
  'over_daily_cap',
  'kill_switch',
  'policy_rule',
  'rules_unreadable',
  // What the app found before anything was signed.
  'unpriced',
  'no_price',
  'price_moved',
  'insufficient_balance',
  'balance_unread',
  'below_minimum',
  'unsupported_asset',
  'ambiguous_asset',
  'simulation_failed',
  'invalid_request',
  'not_available',
  'plan_exists',
  // A person said no.
  'declined',
  // After the click.
  'not_sent',
  'venue_failed_nothing_moved',
  'venue_failed_refund_pending',
  'refunded',
  'short_fill',
  'stuck_unknown',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(REASON_CODES);

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && KNOWN.has(value);
}

/* A refusal that knows its cause. Thrown before anything is signed, so the message is the
   engineer's line for the log and the details fold; the code is what picks the sentence. */
export class ReasonError extends Error {
  readonly reason: ReasonCode;
  constructor(reason: ReasonCode, message: string) {
    super(message);
    this.name = 'ReasonError';
    this.reason = reason;
  }
}

// The code an error carries, or undefined for an error that does not know its cause.
export function reasonOf(err: unknown): ReasonCode | undefined {
  const code = (err as { reason?: unknown } | null)?.reason;
  return isReasonCode(code) ? code : undefined;
}

/* What a quote refusal from the swap service means. Its 400s carry a sentence and no code, so
   the sentence is the only signal: "No liquidity available" is nobody selling, "Amount is too low
   for bridge, try at least N" is a minimum. Anything else is a check that did not pass. */
export function quoteRefusalReason(message: string): ReasonCode {
  if (/no liquidity/i.test(message)) return 'no_price';
  if (/amount is too low|too low for bridge|at least \d/i.test(message)) return 'below_minimum';
  return 'simulation_failed';
}
