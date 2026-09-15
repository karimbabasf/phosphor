// A 1Click quote signer for the rail tests.
//
// Every rail verifies the signature on a live quote before it trusts the deposit address
// (src/quote-signature.ts), so a fake API that answers an unsigned quote is refused the way a
// tampered one is. The fakes sign what they answer with this key, and the rails under test are
// told to trust it through their `quoteKey` dependency. The pair is minted per process and never
// written anywhere: a build cannot carry it, so nothing this signs verifies against the key the
// app ships with, which tests/unit/quote-signature.test.ts asserts.

import crypto from 'node:crypto';

import { base58Encode } from '../../../src/chain/near.ts';
import { quoteHash } from '../../../src/quote-signature.ts';

const pair = crypto.generateKeyPairSync('ed25519');

// The raw 32 bytes sit at the end of the SPKI encoding, after the twelve-byte DER head.
const rawPublic = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

export const TEST_QUOTE_KEY = `ed25519:${base58Encode(new Uint8Array(rawPublic))}`;

let sequence = 0;

/* A quote response 1Click would have signed, given the quote and its echoed request. The id and
   the stamp are filled unless the caller set them, and the signature is made last, over exactly
   what the response carries, so a test that wants a tampered quote changes it AFTER signing. */
export function signQuote(raw: Record<string, unknown>): Record<string, unknown> {
  sequence += 1;
  const stamped: Record<string, unknown> = {
    correlationId: `test-quote-${sequence}`,
    timestamp: new Date(1_786_492_800_000 + sequence).toISOString(),
    ...raw,
  };
  delete stamped['signature'];
  const signature = crypto.sign(null, Buffer.from(quoteHash(stamped), 'utf8'), pair.privateKey);
  return { ...stamped, signature: `ed25519:${base58Encode(new Uint8Array(signature))}` };
}
