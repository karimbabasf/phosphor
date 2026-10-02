// The NEAR Intents solver relay's words this app knows, in one place: its status words, the one-word
// reasons a publish fails with, and the verifier's refusals a failed publish or a status detail
// carries, each with the sentence an agent reads in its place (src/venue-words.ts).
//
// Sources, read 2026-10-02: docs.near-intents.org integration/market-makers/message-bus/rpc; the
// relay client in github.com/defuse-protocol/sdk-monorepo (getStatus.ts, parseFailedPublishError.ts,
// publishIntents.ts); the verifier's errors in github.com/near/intents contracts/defuse/core/src/
// error.rs. Left out on purpose: a verifier error that names an account, a public key or a token
// ("account '...' not found", "invariant violated: ..."), so it stays quoted.

import type { VenueVocabulary } from '../venue-words.ts';

export const RELAY_STATUS_WORDS: readonly string[] = ['PENDING', 'TX_BROADCASTED', 'SETTLED', 'NOT_FOUND_OR_NOT_VALID'];

export const SOLVER_RELAY: VenueVocabulary = {
  names: ['The solver relay'],
  // A status; a publish's FAILED reason; a status detail.
  words: [...RELAY_STATUS_WORDS, 'expired', 'internal', 'FAILED'],
  refusals: [
    { said: 'deadline has expired', means: () => 'The solver relay refused the intent because its deadline had passed' },
    { said: 'insufficient balance or overflow', means: () => 'The solver relay refused the intent because the balance inside NEAR Intents does not cover it' },
    { said: 'invalid signature', means: () => 'The solver relay refused the intent because its signature did not check out' },
    { said: 'nonce was already used', means: () => 'The solver relay refused the intent because its nonce was already used' },
    { said: 'nonce was already expired', means: () => 'The solver relay refused the intent because its nonce had expired' },
    { said: 'invalid nonce', means: () => 'The solver relay refused the intent because its nonce is not valid' },
    { said: 'invalid salt', means: () => 'The solver relay refused the intent because the salt it was signed with is no longer current' },
    { said: 'already processed', means: () => 'The solver relay says this intent was already processed' },
    { said: 'Settled in block {block:int}', means: (p) => `The solver relay reports it settled in block ${p.block}` },
  ],
};
