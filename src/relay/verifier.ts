// The verifier contract, read for the relay swap rail: the balance an intent would spend, the
// salt a nonce has to carry, and whether a nonce has been spent. Three view calls, no signing,
// nothing here can move money.
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

export type VerifierPort = {
  // What the account holds of one asset, in base units. Null when the read failed.
  balance(accountId: string, assetId: string): Promise<bigint | null>;
  // The contract's current 4-byte salt. Null when the read failed or the answer was not 4 bytes.
  currentSalt(): Promise<Uint8Array | null>;
  // Whether the verifier has committed this nonce for this account. Null when the read failed.
  nonceUsed(accountId: string, nonce: string): Promise<boolean | null>;
};

type ViewResult = { result: number[] };

// The same call the ledger makes (src/ledger/intents.ts view), for the two methods it does not
// expose. Throws on any answer that is not a view result; the port above turns that into null.
async function view(methodName: string, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(nearChainSpec().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
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
    async nonceUsed(accountId, nonce) {
      try {
        const answer = await view('is_nonce_used', { account_id: accountId.toLowerCase(), nonce }, fetchImpl);
        return typeof answer === 'boolean' ? answer : null;
      } catch {
        return null;
      }
    },
  };
}
