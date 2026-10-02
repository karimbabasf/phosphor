// 1Click's words this app knows, in one place: the statuses and refund reasons its status endpoint
// answers with, and the refusals its quote endpoint writes, each with the sentence an agent reads
// in its place (src/venue-words.ts). A refusal is matched whole; a part that changes is a number.
//
// Sources, read 2026-10-02: GetExecutionStatusResponse in 1click.chaindefuser.com/docs/v0/
// openapi.yaml; the refundReason known values in explorer.near-intents.org/api/v0/openapi.yaml;
// 400 bodies quoted live in public wallet repos (oisy-wallet, cowswap, trezu, sip-protocol,
// quantus-apps) and in this code (src/rails/intents-pay.ts, src/preflight/route-health.ts,
// src/rails/intents-native.ts). Left out on purpose: a refusal that echoes an asset id or a chain
// name back ("... is not supported as origin asset", "Cant withdraw to exchange on ..."), so it
// stays quoted.

import type { VenueVocabulary } from '../venue-words.ts';

// What a swap's status reads as it moves. The swap service's stage (src/venue-words.ts) is one of these too.
export const ONECLICK_STATUS_WORDS: readonly string[] = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];

export const ONECLICK: VenueVocabulary = {
  names: ['1Click'],
  words: [
    ...ONECLICK_STATUS_WORDS,
    // Why a swap was refunded.
    'PARTIAL_DEPOSIT', 'AMOUNT_LESS_THAN_MIN_AMOUNT_OUT', 'AMOUNT_MORE_THAN_BALANCE', 'INTENT_SUBMIT_FAILED',
    'CIRCUIT_BREAKER_BLOCKED', 'FEE_ESTIMATION_FAILED', 'NO_LIQUIDITY', 'AMOUNT_LESS_THAN_MIN_WITHDRAWABLE',
    'INSUFFICIENT_BALANCE', 'REFUND_ADD_FAILED', 'UNKNOWN',
    // A quote request's own settings, which its echo repeats (QuoteRequest's enums).
    'SIMPLE', 'MEMO', 'EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT', 'ORIGIN_CHAIN', 'INTENTS',
    'CONFIDENTIAL_INTENTS', 'DESTINATION_CHAIN',
  ],
  refusals: [
    { said: 'Amount is too low for bridge, try at least {least:int}', means: (p) => `1Click refused the amount because it is under this route's minimum of ${p.least} in the smallest unit of the coin sent` },
    { said: 'Temporary swap limits: minimum swap amount is ${least:usd}', means: (p) => `1Click refused the quote because this route has a temporary minimum of $${p.least}` },
    { said: 'No liquidity available', means: () => '1Click found nobody to quote this swap right now' },
    { said: 'Quoting for this pair is not available', means: () => '1Click does not quote this pair right now' },
    { said: 'tokenIn is not valid', means: () => '1Click does not take the coin being sent on this route' },
    { said: 'tokenOut is not valid', means: () => '1Click does not deliver the coin asked for on this route' },
    { said: 'recipient is not valid', means: () => '1Click refused the receiving address for this route' },
    { said: 'refundTo is not valid', means: () => '1Click refused the refund address for this route' },
    // Its answer to generate-intent for an argument it would not take (live 2026-08-13).
    { said: 'Internal error generating intent', means: () => '1Click could not build the intent for this move' },
  ],
};
