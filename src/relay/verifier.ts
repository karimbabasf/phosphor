// The verifier contract, read for the relay swap rail: the balance an intent would spend, the
// salt a nonce has to carry, and whether a nonce has been spent. Three view calls and the chain's
// own clock, no signing, nothing here can move money.
//
// Why a nonce needs the salt: the verifier's nonce format is versioned (contracts/defuse/README.md
// in near/intents, "Nonces", read 2026-09-20). A legacy nonce of 32 random bytes still passes
// today and is announced as going away; the versioned V1 nonce carries the contract's current
// 4-byte salt and an expiry, and both `current_salt` and `is_nonce_used` answered live on
// 2026-09-20 (salt "252812b3", an unspent nonce false). Building V1 now is what stops the rail
// from dying the day the legacy shape is refused, and the same nonce is what reconciliation asks
// the contract by after a crash.
//
// Every read answers null when the contract or the RPC did not answer. Null is never zero, never
// false and never "unspent": each caller says what it does without the read.

import { nearChainSpec } from '../chain/near.ts';
import { INTENTS_VERIFIER, fetchIntentsAssetBalance } from '../ledger/intents.ts';
import { readTimeout } from '../net.ts';

/* NEAR's newest final block: its hash, and its own timestamp in whole milliseconds, rounded down
   so it never reads later than the block is. That timestamp is the clock intents.near judges a
   signed intent's deadline by (src/relay/fate.ts), and the hash is what lets the reads after it
   be taken at that same block: `query` takes a `block_id` in place of `finality` (both answered
   live on 2026-09-25, the final block about 2.6 s behind this Mac's clock). */
export type FinalBlock = { hash: string; atMs: number };

export type VerifierPort = {
  // What the account holds of one asset, in base units. Null when the read failed.
  balance(accountId: string, assetId: string): Promise<bigint | null>;
  // The contract's current 4-byte salt. Null when the read failed or the answer was not 4 bytes.
  currentSalt(): Promise<Uint8Array | null>;
  /* Whether the verifier has committed this nonce for this account. Null when the read failed.
     `at` is a block hash to read at instead of the newest final block. */
  nonceUsed(accountId: string, nonce: string, at?: string): Promise<boolean | null>;
  /* Whether a salt is still one the verifier accepts. A nonce whose salt was rotated out is
     cleanable even when spent (contracts/defuse/src/contract/garbage_collector.rs), so past
     that point "unspent" says nothing about whether the swap executed. Null when the read
     failed. Optional the safe way round: a port without it reads as "no answer", and no failed
     verdict is written on an unspent nonce without one. The live port always has it. */
  isValidSalt?(salt: Uint8Array, at?: string): Promise<boolean | null>;
  // The newest final block and its time. Null when the read failed. Optional the same safe way:
  // without it the deadline is judged by this Mac's clock and the grace (src/relay/fate.ts).
  finalBlock?(): Promise<FinalBlock | null>;
};

type ViewResult = { result: number[] };

// The same call the ledger makes (src/ledger/intents.ts view), for the two methods it does not
// expose. Throws on any answer that is not a view result; the port above turns that into null.
// `at` reads at that block hash rather than at the newest final block.
async function view(methodName: string, args: Record<string, unknown>, fetchImpl: typeof fetch, at?: string): Promise<unknown> {
  const res = await fetchImpl(nearChainSpec().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        ...(at === undefined ? { finality: 'final' } : { block_id: at }),
        account_id: INTENTS_VERIFIER,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`intents ${methodName} http ${res.status}`);
  const body = (await res.json()) as { result?: ViewResult; error?: { cause?: { name?: string } } };
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`intents ${methodName} failed: ${body.error?.cause?.name ?? 'no result'}`);
  }
  // NEAR returns view output as a byte array of UTF-8 JSON.
  return JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8'));
}

// The salt comes back as a JSON string of 8 hex characters ("252812b3"), which is the 4 bytes
// in order. Anything else is not a salt and is refused as null rather than padded or cut.
export function saltBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{8}$/.test(raw)) return null;
  return Uint8Array.from(Buffer.from(raw, 'hex'));
}

/* A block header's hash and time, or null for anything else. The time is `timestamp_nanosec`, the
   exact nanoseconds as a string (read live 2026-09-25 off the RPC below, beside `timestamp`, the
   same figure as a JSON number that has lost its last digits and is not read), cut down to the
   millisecond so a block a fraction of a millisecond past a deadline reads as not past it yet. */
export function finalBlockOf(header: unknown): FinalBlock | null {
  if (header === null || typeof header !== 'object') return null;
  const h = header as { hash?: unknown; timestamp_nanosec?: unknown };
  if (typeof h.hash !== 'string' || h.hash === '') return null;
  if (typeof h.timestamp_nanosec !== 'string' || !/^\d{1,30}$/.test(h.timestamp_nanosec)) return null;
  const atMs = Number(BigInt(h.timestamp_nanosec) / 1_000_000n);
  return Number.isSafeInteger(atMs) && atMs > 0 ? { hash: h.hash, atMs } : null;
}

export function liveVerifier(fetchImpl: typeof fetch = fetch): VerifierPort {
  return {
    balance: (accountId, assetId) =>
      fetchIntentsAssetBalance({ accountId, assetId, rpcUrl: nearChainSpec().rpcUrl, fetchImpl }),
    async currentSalt() {
      try {
        return saltBytes(await view('current_salt', {}, fetchImpl));
      } catch {
        return null;
      }
    },
    async nonceUsed(accountId, nonce, at) {
      try {
        const answer = await view('is_nonce_used', { account_id: accountId.toLowerCase(), nonce }, fetchImpl, at);
        return typeof answer === 'boolean' ? answer : null;
      } catch {
        return null;
      }
    },
    async isValidSalt(salt, at) {
      if (salt.length !== 4) return null;
      try {
        // The contract reads a salt as its 8 hex characters, the way current_salt prints it.
        const answer = await view('is_valid_salt', { salt: Buffer.from(salt).toString('hex') }, fetchImpl, at);
        return typeof answer === 'boolean' ? answer : null;
      } catch {
        return null;
      }
    },
    async finalBlock() {
      try {
        const res = await fetchImpl(nearChainSpec().rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }),
          signal: readTimeout(),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { result?: { header?: unknown } };
        return finalBlockOf(body.result?.header);
      } catch {
        return null;
      }
    },
  };
}
