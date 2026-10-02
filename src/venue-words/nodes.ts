// The chain nodes' words this app knows, in one place: the error names a NEAR node answers with, and
// the read errors an EVM node or its provider writes, each with the sentence an agent reads in its
// place (src/venue-words.ts). Only reads: this app's own node calls are balance, nonce, code,
// block and transaction lookups (src/chainscan), and the verifier views (src/ledger/intents.ts).
//
// Sources, read 2026-10-02: nearcore chain/jsonrpc-primitives/src/errors.rs and types/query.rs (the
// cause names); go-ethereum rpc/errors.go, eth/api_backend.go and eth/state_accessor.go; public
// provider answers quoted in public issues (the Base and OP Stack endpoints' -32016, Infura's -32005).
// Left out on purpose: a revert reason, which any contract author writes, and an error that names
// an account or an address, so it stays quoted.

import type { VenueVocabulary } from '../venue-words.ts';

export const NODES: VenueVocabulary = {
  names: ['The node', 'The NEAR RPC'],
  // A NEAR node's error.name and error.cause.name.
  words: [
    'HANDLER_ERROR', 'REQUEST_VALIDATION_ERROR', 'INTERNAL_ERROR', 'PARSE_ERROR', 'METHOD_NOT_FOUND', 'TIMEOUT_ERROR',
    'NO_SYNCED_BLOCKS', 'UNAVAILABLE_SHARD', 'GARBAGE_COLLECTED_BLOCK', 'UNKNOWN_BLOCK', 'INVALID_ACCOUNT', 'UNKNOWN_ACCOUNT',
    'NO_CONTRACT_CODE', 'TOO_LARGE_CONTRACT_STATE', 'UNKNOWN_ACCESS_KEY', 'UNKNOWN_GAS_KEY', 'TOO_MANY_ACCESS_KEYS',
    'CONTRACT_EXECUTION_ERROR', 'NO_GLOBAL_CONTRACT_CODE',
  ],
  refusals: [
    { said: 'header not found', means: () => 'The node does not have that block yet' },
    { said: 'historical state is not available', means: () => 'The node no longer keeps state that old' },
    { said: 'request timed out', means: () => 'The node timed out' },
    { said: 'Method not found', means: () => 'The node does not offer that read' },
    { said: 'over rate limit', means: () => 'The node is limiting requests right now' },
    { said: 'daily request count exceeded, request rate limited', means: () => 'The node is limiting requests right now' },
  ],
};
