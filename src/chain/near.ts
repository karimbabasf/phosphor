// NEAR, as this app still needs it: the RPC the verifier is read through, base58 for the
// keystore and the 1Click quote signature, and the account id rules a send has to check.
//
// Nothing here signs. The NEAR key this app used to mint (scripts/keygen.ts, since v0.1)
// signed exactly one thing, a deposit into the verifier from a NEAR wallet, and money reaches
// the verifier through the POA deposit address now (src/rails/intents-address.ts). The borsh
// serializer, the ed25519 signer, NEP-413 and the transaction sender went with it (2026-09-16);
// the intents rails sign ERC-191 with the EVM key and nothing else.

// ---------- chain identity ----------

export type NearChainSpec = {
  rpcUrl: string;
  explorerTx: string; // prefix; a receipt links explorerTx + hash
};

// rpc.mainnet.near.org is DEPRECATED and now answers -429 with "STOP USING IT NOW"
// rather than data, which is why the ledger's NEAR column was going stale. FastNEAR is
// the replacement NEAR's own docs point at, and it needs no API key.
const NEAR_CHAIN: NearChainSpec = {
  rpcUrl: 'https://free.rpc.fastnear.com',
  explorerTx: 'https://nearblocks.io/txns/',
};

export function nearChainSpec(): NearChainSpec {
  return NEAR_CHAIN;
}

// ---------- base58 ----------
//
// NEAR spells keys, signatures and transaction hashes in base58. scripts/keygen.ts vendors
// the encoder; decoding is needed here to read the key back, so both live together and both
// are covered by selfCheck().

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) | BigInt(byte);
  let out = '';
  while (acc > 0n) {
    out = B58_ALPHABET[Number(acc % 58n)] + out;
    acc /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

export function base58Decode(text: string): Uint8Array {
  let acc = 0n;
  for (const ch of text) {
    const index = B58_ALPHABET.indexOf(ch);
    // A single bad character means the whole string is not the key we think it is. Guessing
    // past it would decode to different bytes and sign with a key nobody expects.
    if (index < 0) throw new Error(`not base58: character ${JSON.stringify(ch)}`);
    acc = acc * 58n + BigInt(index);
  }
  const digits: number[] = [];
  while (acc > 0n) {
    digits.unshift(Number(acc % 256n));
    acc /= 256n;
  }
  // Every leading '1' is one leading zero byte; the bigint loop cannot represent them.
  for (const ch of text) {
    if (ch !== '1') break;
    digits.unshift(0);
  }
  return Uint8Array.from(digits);
}

// ---------- account ids ----------

// The NEAR account id rules, which matter here because a deposit address on a NEAR-origin
// swap is an account id chosen by a remote API. It arrives as a 64-character hex implicit
// account, and viem's isAddress refuses it correctly: it is not an EVM address and must not
// be validated as one. This is the check that replaces it, not a relaxation of it.
//
// Rules: 2-64 characters, lowercase; parts of [a-z0-9_-] separated by single dots; must
// start and end alphanumeric. A 64-char hex string satisfies these and is also the implicit
// account form, so one predicate covers both.
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

export function isNearAccountId(value: unknown): value is string {
  return typeof value === 'string' && NEAR_ACCOUNT_ID.test(value);
}

// The two shapes a NEAR account id that anything can SETTLE to takes: a named account under
// the .near top-level account, or a 64-character implicit account, which is the hex of an
// ed25519 public key. Stricter than isNearAccountId above, which answers the different question
// of whether a string is a structurally valid account id at all.
//
// The difference is the whole of the distance between "well formed" and "exists on the network
// this app runs against". A .testnet account satisfies the structural rule and satisfies nothing
// else: it is not on mainnet, so a payout to it can only stall or refund. Three callers need
// that answer, the HyperCore rail, the 1Click swap rail's destination check and the config
// loader, so it lives here with the rule it refines rather than inside any one of them.
export function isSettlableNearAccount(raw: string): boolean {
  const id = raw.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return /^(?:[a-z0-9_-]+\.)+near$/.test(id);
}

// An EVM address, lowercased, is 42 characters of [0-9a-fx] and therefore a STRUCTURALLY
// VALID NEAR account id. That is not a flaw in the rule above, it is what NEAR allows, and
// it means the account-id check alone cannot tell the two families apart: '0xd8da6bf...' in
// its checksummed form is refused only because it has capitals in it.
//
// Which matters at exactly one place: the deposit address on a NEAR-origin swap, chosen by a
// remote API. A wrong-family address there would be an ft_transfer to an account that does
// not exist, and the storage check catches that, but leaning on a downstream check to
// enforce an upstream guarantee is how the guarantee quietly stops being true. So the shape
// is refused here, where the claim is made.
export function looksLikeEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// A 64-character hex account id is the hash of a public key and nothing else: no contract,
// no name, no owner we can look up. 1Click mints deposit addresses in exactly this form.
export function isImplicitAccountId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
