// The one place Phosphor signs and broadcasts a NEAR transaction.
//
// Same rule as src/chain/evm.ts and for the same reason: signing is where a bug loses funds
// rather than throwing an error, so it lives in a single reviewable module and every rail
// calls into it. Before this file existed the app held a NEAR key that nothing could use.
// scripts/keygen.ts has minted an ed25519 keypair since v0.1, ledger/near.ts has read
// balances with it, and every write path dead-ended in the same sentence: "Phosphor holds an
// EVM key only and this call is a NEAR transaction."
//
// Why this hand-rolls borsh where evm.ts reached for viem. The keccak trap that justified a
// dependency there does not exist here, and the failure modes are opposites:
//
//   - keccak256 is NOT node's 'sha3-256'. Get it wrong and you derive an address nobody
//     holds the key to, the send succeeds, and the funds are gone with nothing looking
//     wrong. Silent, unrecoverable, invisible to tests that never leave the happy path.
//   - A NEAR transaction is sha256 (node:crypto has it, one algorithm, no variants) over a
//     borsh struct, signed with ed25519 (node:crypto has that too). Get the borsh wrong and
//     the signature does not verify against the serialized body, so the RPC rejects the
//     transaction and nothing moves. Loud, free, and caught by the first real send.
//
// So the dangerous primitives are both stdlib, and the part written here fails closed. That
// is a different trade from the keccak one, and it is why the answer comes out differently.
// selfCheck() below runs published vectors over every primitive before anything is signed,
// the same way scripts/keygen.ts guards key derivation.
//
// What is deliberately NOT here: any notion of a rail, a venue, a quote or a policy. This
// module takes an account, a receiver and a list of actions, and returns what the chain
// said. Deciding what to send is the rails' job.

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Network } from '../types.ts';

// ---------- chain identity ----------

export type NearChainSpec = {
  rpcUrl: string;
  explorerTx: string; // prefix; a rail returns explorerTx + hash as its evidence
};

// rpc.testnet.near.org and rpc.mainnet.near.org are DEPRECATED and now answer -429 with
// "STOP USING IT NOW" rather than data, which is why the ledger's NEAR column was going
// stale. FastNEAR is the replacement NEAR's own docs point at, and it needs no API key.
const NEAR_CHAINS: Record<Network, NearChainSpec> = {
  testnet: {
    rpcUrl: 'https://test.rpc.fastnear.com',
    explorerTx: 'https://testnet.nearblocks.io/txns/',
  },
  mainnet: {
    rpcUrl: 'https://free.rpc.fastnear.com',
    explorerTx: 'https://nearblocks.io/txns/',
  },
};

export function nearChainSpec(network: Network): NearChainSpec {
  return NEAR_CHAINS[network];
}

// One NEAR is 10^24 yoctoNEAR. Every amount below the API boundary is a bigint of yocto:
// a double cannot hold 24 decimals, and rounding a balance silently is how a transfer of
// "all of it" leaves dust behind or overdraws.
export const YOCTO_PER_NEAR = 10n ** 24n;

// Gas is a u64 of gas units. 1 TGas = 10^12. These are prepaid ceilings, not spend: the
// unburnt remainder is refunded, so the cost of being generous is a temporarily larger
// balance reservation and the cost of being stingy is a failed call.
export const TGAS = 10n ** 12n;
export const MAX_GAS = 300n * TGAS; // protocol ceiling for one transaction

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

// ---------- borsh ----------
//
// Borsh is the NEAR serialization format: little-endian integers, length-prefixed
// collections, no field names, no padding. Only the subset a transaction needs is here.

class Borsh {
  private parts: Uint8Array[] = [];

  u8(value: number): this {
    this.parts.push(Uint8Array.of(value & 0xff));
    return this;
  }

  // Every multi-byte integer is little-endian, which is the single easiest thing to get
  // backwards, so all three widths go through one function.
  private uint(value: bigint, bytes: number): this {
    if (value < 0n) throw new Error(`borsh: unsigned field cannot be negative (got ${value})`);
    const limit = 1n << BigInt(bytes * 8);
    if (value >= limit) throw new Error(`borsh: value ${value} does not fit in u${bytes * 8}`);
    const out = new Uint8Array(bytes);
    let rest = value;
    for (let i = 0; i < bytes; i += 1) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    this.parts.push(out);
    return this;
  }

  u32(value: number | bigint): this {
    return this.uint(BigInt(value), 4);
  }

  u64(value: bigint): this {
    return this.uint(value, 8);
  }

  u128(value: bigint): this {
    return this.uint(value, 16);
  }

  // A borsh string is a u32 length followed by UTF-8 bytes. The length counts BYTES, not
  // characters: a non-ASCII account id or memo would otherwise serialize short and the
  // signature would cover a different body than the one sent.
  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    this.u32(bytes.length);
    this.parts.push(new Uint8Array(bytes));
    return this;
  }

  // A fixed-size array carries NO length prefix. block_hash and the 32-byte key are fixed;
  // writing a length in front of either is the classic borsh mistake.
  fixed(bytes: Uint8Array, expectedLength: number): this {
    if (bytes.length !== expectedLength) {
      throw new Error(`borsh: expected ${expectedLength} bytes, got ${bytes.length}`);
    }
    this.parts.push(bytes);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.u32(value.length);
    this.parts.push(value);
    return this;
  }

  raw(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

// ---------- actions ----------
//
// The enum index is the borsh discriminant and comes from the declaration order in nearcore:
// CreateAccount 0, DeployContract 1, FunctionCall 2, Transfer 3, Stake 4, AddKey 5,
// DeleteKey 6, DeleteAccount 7. Only the two Phosphor needs are implemented; the rest would
// be a new capability, not a missing line, and each deserves its own review.

export type NearAction =
  | { type: 'transfer'; deposit: bigint }
  | { type: 'functionCall'; methodName: string; args: unknown; gas: bigint; deposit: bigint };

export function transfer(deposit: bigint): NearAction {
  return { type: 'transfer', deposit };
}

export function functionCall(
  methodName: string,
  args: unknown,
  gas: bigint,
  deposit: bigint,
): NearAction {
  return { type: 'functionCall', methodName, args, gas, deposit };
}

function writeAction(w: Borsh, action: NearAction): void {
  if (action.type === 'transfer') {
    w.u8(3).u128(action.deposit);
    return;
  }
  w.u8(2)
    .string(action.methodName)
    .bytes(new Uint8Array(Buffer.from(JSON.stringify(action.args), 'utf8')))
    .u64(action.gas)
    .u128(action.deposit);
}

// A one-line description of what an action does, for the audit log and the approval gate.
// Deliberately not JSON.stringify of the whole thing: a human reading a log line needs the
// destination and the amount, not an args blob.
export function describeAction(action: NearAction, receiverId: string): string {
  if (action.type === 'transfer') {
    return `transfer ${formatNear(action.deposit)} NEAR to ${receiverId}`;
  }
  const attached = action.deposit > 0n ? `, attaching ${action.deposit} yocto` : '';
  return `call ${action.methodName} on ${receiverId}${attached}`;
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

// ---------- keys ----------

type NearKeyEntry = { accountId?: string; publicKey?: string; secretKey?: string };
type KeysFile = { near?: NearKeyEntry; [k: string]: unknown };

export type NearSigner = {
  accountId: string;
  publicKey: string; // 'ed25519:' + base58, the form the RPC and the access key list use
  publicKeyBytes: Uint8Array;
  privateKey: crypto.KeyObject;
};

// Node has no "load an ed25519 seed" API, so wrap the 32-byte seed in the fixed PKCS8 DER
// prefix for ed25519 and let the standard parser take it. scripts/keygen.ts uses the same
// sixteen bytes on the way out, which is what makes the round trip exact.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seed: Uint8Array): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyFromPrivate(privateKey: crypto.KeyObject): Uint8Array {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('ed25519 public key export produced no x');
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

// Read the key only at the moment it is needed and never hold it in module state, so a heap
// dump of a long-running process is less likely to carry it. Same posture as evm.ts.
export function readNearSigner(keysPath: string): NearSigner {
  if (!fs.existsSync(keysPath)) {
    throw new Error(`no keys file at ${keysPath}. Run: npm run keygen`);
  }
  const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysFile;
  const entry = parsed.near;
  if (entry === undefined) throw new Error(`keys file at ${keysPath} has no near entry`);

  const accountId = entry.accountId;
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error(`keys file at ${keysPath} has no near.accountId`);
  }
  const secret = entry.secretKey;
  if (typeof secret !== 'string' || !secret.startsWith('ed25519:')) {
    throw new Error(`keys file at ${keysPath} has no ed25519 near.secretKey`);
  }

  // NEAR's secret key format is base58 of seed(32) || publicKey(32). The trailing copy of
  // the public key is what makes the consistency check below possible.
  const material = base58Decode(secret.slice('ed25519:'.length));
  if (material.length !== 64) {
    throw new Error(`near.secretKey decodes to ${material.length} bytes, expected 64 (seed + public key)`);
  }

  const privateKey = privateKeyFromSeed(material.subarray(0, 32));
  const derived = publicKeyFromPrivate(privateKey);
  const trailing = material.subarray(32);

  // Three values have to agree: the seed, the public half baked into the secret key, and the
  // publicKey field. They disagree when a key file has been hand-edited or half-replaced, and
  // the failure that follows is a signature the network rejects with a message about access
  // keys that says nothing about the real cause. Checking here names it exactly once.
  if (Buffer.compare(Buffer.from(derived), Buffer.from(trailing)) !== 0) {
    throw new Error('near.secretKey is inconsistent: its public half does not match its own seed');
  }
  const publicKey = 'ed25519:' + base58Encode(derived);
  if (typeof entry.publicKey === 'string' && entry.publicKey !== publicKey) {
    throw new Error(
      `near.publicKey (${entry.publicKey}) does not match the key derived from near.secretKey (${publicKey}); ` +
        'refusing to sign with a key file that disagrees with itself',
    );
  }

  return { accountId, publicKey, publicKeyBytes: derived, privateKey };
}

// The account id alone, for callers that need the address without touching key material.
export function nearAccountId(keysPath: string): string {
  return readNearSigner(keysPath).accountId;
}

// ---------- signing ----------

export type NearTransaction = {
  signerId: string;
  publicKeyBytes: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array; // 32 bytes
  actions: NearAction[];
};

// Transaction {
//   signer_id: AccountId, public_key: PublicKey, nonce: u64,
//   receiver_id: AccountId, block_hash: CryptoHash, actions: Vec<Action>
// }
// PublicKey is a u8 key type (0 = ed25519) followed by the 32 raw bytes.
export function serializeTransaction(tx: NearTransaction): Uint8Array {
  const w = new Borsh();
  w.string(tx.signerId)
    .u8(0)
    .fixed(tx.publicKeyBytes, 32)
    .u64(tx.nonce)
    .string(tx.receiverId)
    .fixed(tx.blockHash, 32)
    .u32(tx.actions.length);
  for (const action of tx.actions) writeAction(w, action);
  return w.finish();
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash('sha256').update(bytes).digest());
}

// What ed25519 signs is the 32-byte sha256 of the serialized body, not the body itself, and
// that same hash IS the transaction hash the explorer shows. Signing the body directly
// produces a signature the network rejects.
export function signTransaction(
  tx: NearTransaction,
  privateKey: crypto.KeyObject,
): { signedTxBase64: string; hash: string } {
  const body = serializeTransaction(tx);
  const digest = sha256(body);
  const signature = new Uint8Array(crypto.sign(null, digest, privateKey));
  if (signature.length !== 64) throw new Error(`ed25519 signature is ${signature.length} bytes, expected 64`);

  const signed = new Borsh().raw(body).u8(0).fixed(signature, 64).finish();
  return { signedTxBase64: Buffer.from(signed).toString('base64'), hash: base58Encode(digest) };
}

// ---------- NEP-413, signing a message rather than a transaction ----------

export type Nep413Payload = {
  message: string;
  // Exactly 32 bytes, unpredictable, and used once. The nonce is the ONLY thing standing
  // between a released signature and a replay of it: nothing else in the payload is unique
  // per signing. Build it with randomNep413Nonce() rather than a counter, a timestamp or a
  // zero buffer, all three of which an attacker can predict and none of which this module
  // can detect from 32 bytes that arrive already chosen.
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
};

// A CSPRNG nonce, which is the only kind that is safe here. Exported so no caller has to
// decide how to make one, because the tempting wrong answers (Date.now, an incrementing
// counter, a reused buffer) all look like they work.
export function randomNep413Nonce(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(32));
}

// NEP-413 exists so a wallet can sign an off-chain message without that signature ever being
// replayable as a transaction. The prefix is what guarantees it: 2^31 + 413 as a borsh u32
// sits where a transaction's signer_id length would be, and no account id is 2.1 billion
// bytes long, so a signed message can never be parsed as a transaction and the reverse holds
// too. This is the standard NEAR Intents accepts as `nep413`.
export const NEP413_PREFIX = 2 ** 31 + 413; // 2147484061

export function nep413Digest(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== 32) {
    throw new Error(`nep413 nonce must be 32 bytes, got ${payload.nonce.length}`);
  }
  const w = new Borsh()
    .u32(NEP413_PREFIX)
    .string(payload.message)
    .fixed(payload.nonce, 32)
    .string(payload.recipient);
  // Option<String>: a 0 byte for None, a 1 byte followed by the string for Some.
  if (payload.callbackUrl === undefined) w.u8(0);
  else w.u8(1).string(payload.callbackUrl);
  return sha256(w.finish());
}

// Returns the signature in the 'ed25519:base58' form the Intents message bus expects.
export function signNep413(payload: Nep413Payload, privateKey: crypto.KeyObject): string {
  const signature = new Uint8Array(crypto.sign(null, nep413Digest(payload), privateKey));
  return 'ed25519:' + base58Encode(signature);
}

// ---------- RPC ----------

// 'final' is the honest default for anything a human reads: it cannot be rolled back.
//
// 'optimistic' exists for one specific job, and it was learned the expensive way. sendTx
// returns at EXECUTED_OPTIMISTIC, which is a block or two ahead of finality, so a read at
// 'final' taken immediately afterwards returns the state from BEFORE the transaction. The
// first live wrap on testnet reported success and then showed a zero balance, which reads
// exactly like a silent failure and is not one. Any read that verifies the effect of a send
// that just returned has to ask for 'optimistic' or wait.
export type NearFinality = 'final' | 'optimistic';

export type NearRpcOptions = { fetchImpl?: typeof fetch; finality?: NearFinality };

// NEAR reports the useful discriminator in error.cause.name and leaves error.message as a
// generic string, the same shape src/ledger/near.ts already branches on.
export class NearRpcError extends Error {
  readonly causeName: string;
  constructor(causeName: string, message: string) {
    super(message);
    this.name = 'NearRpcError';
    this.causeName = causeName;
  }
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'phosphor', method, params }),
  });
  if (!res.ok) throw new Error(`near ${method} http ${res.status}`);
  const body = (await res.json()) as {
    result?: any;
    error?: { message?: string; cause?: { name?: string }; data?: unknown };
  };
  if (body.error) {
    const causeName = body.error.cause?.name ?? 'UNKNOWN';
    const detail = body.error.data !== undefined ? ` ${JSON.stringify(body.error.data).slice(0, 200)}` : '';
    throw new NearRpcError(causeName, `near ${method} failed: ${causeName} (${body.error.message ?? 'no message'})${detail}`);
  }
  return body.result;
}

// The nonce is per (account, access key) and must be strictly greater than the last one that
// access key used. Read it, add a step.
//
// The finality here is 'optimistic' and that is not a preference, it is the fix for a real
// collision. sendTx returns at EXECUTED_OPTIMISTIC, which is ahead of finality by a block or
// two. A second send issued in that window and reading at 'final' sees the nonce from BEFORE
// the first one, adds 1, and produces a value the first transaction already spent. The chain
// answers InvalidNonce with ak_nonce and tx_nonce equal, which reads like a bug in the
// serializer and is not one. Two sends in a row is the normal case for a rail (approve then
// transfer, wrap then swap), so reading final state here breaks the common path, not an
// exotic one. Caught by scripts/near-prove.ts on the third step of its first real run.
async function nextNonce(
  spec: NearChainSpec,
  accountId: string,
  publicKey: string,
  fetchImpl: typeof fetch,
  step: bigint,
): Promise<bigint> {
  const result = await rpc(
    spec.rpcUrl,
    'query',
    { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey },
    fetchImpl,
  );
  if (result?.permission !== 'FullAccess') {
    // A function-call access key can only call one contract and cannot attach a deposit, so a
    // rail signing with one would fail deep inside execution rather than here.
    throw new Error(
      `access key ${publicKey} on ${accountId} is not a FullAccess key, so it cannot sign transfers or attach deposits`,
    );
  }
  return BigInt(result.nonce) + step;
}

// A transaction is only valid on top of a recent block, which is also what bounds how long a
// signed transaction can sit around before it can no longer be replayed.
async function recentBlockHash(spec: NearChainSpec, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const result = await rpc(spec.rpcUrl, 'block', { finality: 'final' }, fetchImpl);
  const hash = result?.header?.hash;
  if (typeof hash !== 'string') throw new Error('near block query returned no header hash');
  const bytes = base58Decode(hash);
  if (bytes.length !== 32) throw new Error(`near block hash decoded to ${bytes.length} bytes, expected 32`);
  return bytes;
}

export type NearSendParams = {
  network: Network;
  keysPath: string;
  receiverId: string;
  actions: NearAction[];
  fetchImpl?: typeof fetch;
  nonceStep?: bigint;
};

export type NearSendOutcome = {
  ok: boolean;
  hash?: string;
  explorer?: string;
  gasBurnt?: string;
  error?: string;
};

// Reads the failure out of an execution status, or null when it succeeded.
function failureOf(status: unknown): string | null {
  if (status === null || typeof status !== 'object') return 'execution status missing';
  const record = status as Record<string, unknown>;
  if ('Failure' in record) return JSON.stringify(record.Failure).slice(0, 300);
  if ('SuccessValue' in record || 'SuccessReceiptId' in record) return null;
  return `unrecognised execution status ${JSON.stringify(record).slice(0, 120)}`;
}

// Build, sign, broadcast, and report what actually happened. A rail never broadcasts
// directly: it hands actions here.
//
// The subtlety that a naive version gets wrong: on NEAR a transaction can report success at
// the top level while the receipt it spawned fails. ft_transfer_call is exactly that shape,
// so a rail trusting only the outer status would call a failed token transfer a success.
// Every receipt outcome is checked, not just the transaction's own.
export async function sendTx(params: NearSendParams): Promise<NearSendOutcome> {
  const spec = nearChainSpec(params.network);
  const fetchImpl = params.fetchImpl ?? fetch;

  try {
    if (params.actions.length === 0) throw new Error('a transaction needs at least one action');
    const signer = readNearSigner(params.keysPath);
    const [nonce, blockHash] = await Promise.all([
      nextNonce(spec, signer.accountId, signer.publicKey, fetchImpl, params.nonceStep ?? 1n),
      recentBlockHash(spec, fetchImpl),
    ]);

    const { signedTxBase64, hash } = signTransaction(
      {
        signerId: signer.accountId,
        publicKeyBytes: signer.publicKeyBytes,
        nonce,
        receiverId: params.receiverId,
        blockHash,
        actions: params.actions,
      },
      signer.privateKey,
    );

    // EXECUTED_OPTIMISTIC waits for the transaction and its receipts to execute in a block
    // that is not yet final. Waiting for FINAL costs another ~2s per send for a guarantee a
    // testnet rail does not need; NONE would return before the outcome is known at all,
    // which is the one thing a rail reporting "ok" must never do.
    const result = await rpc(
      spec.rpcUrl,
      'send_tx',
      { signed_tx_base64: signedTxBase64, wait_until: 'EXECUTED_OPTIMISTIC' },
      fetchImpl,
    );

    const explorer = spec.explorerTx + hash;
    const outer = failureOf(result?.status);
    if (outer !== null) return { ok: false, hash, explorer, error: `transaction failed on chain: ${outer}` };

    const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
    for (const receipt of receipts) {
      const failed = failureOf(receipt?.outcome?.status);
      if (failed !== null) {
        return { ok: false, hash, explorer, error: `a receipt failed on chain: ${failed}` };
      }
    }

    let gasBurnt = BigInt(result?.transaction_outcome?.outcome?.gas_burnt ?? 0);
    for (const receipt of receipts) gasBurnt += BigInt(receipt?.outcome?.gas_burnt ?? 0);

    return { ok: true, hash, explorer, gasBurnt: gasBurnt.toString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- reads a rail needs before it signs ----------

export async function viewCall(
  network: Network,
  contractId: string,
  method: string,
  args: unknown,
  options: NearRpcOptions = {},
): Promise<unknown> {
  const spec = nearChainSpec(network);
  const result = await rpc(
    spec.rpcUrl,
    'query',
    {
      request_type: 'call_function',
      finality: options.finality ?? 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    },
    options.fetchImpl ?? fetch,
  );
  const bytes = (result as { result?: number[] })?.result;
  if (!Array.isArray(bytes)) throw new Error(`near view call ${method} returned no result bytes`);
  return JSON.parse(Buffer.from(Uint8Array.from(bytes)).toString('utf8'));
}

// Native yoctoNEAR held by an account. UNKNOWN_ACCOUNT is a balance of zero rather than a
// failed read, the same call ledger/near.ts already makes.
export async function nativeBalance(
  network: Network,
  accountId: string,
  options: NearRpcOptions = {},
): Promise<bigint> {
  const spec = nearChainSpec(network);
  try {
    const result = await rpc(
      spec.rpcUrl,
      'query',
      { request_type: 'view_account', finality: options.finality ?? 'final', account_id: accountId },
      options.fetchImpl ?? fetch,
    );
    return BigInt((result as { amount?: string })?.amount ?? '0');
  } catch (err) {
    if (err instanceof NearRpcError && err.causeName === 'UNKNOWN_ACCOUNT') return 0n;
    throw err;
  }
}

// NEP-141 balance, as a bigint of base units.
export async function ftBalance(
  network: Network,
  tokenId: string,
  accountId: string,
  options: NearRpcOptions = {},
): Promise<bigint> {
  const raw = await viewCall(network, tokenId, 'ft_balance_of', { account_id: accountId }, options);
  return BigInt(String(raw));
}

// Whether a NEP-141 contract already holds a storage deposit for this account. A token
// transfer to an account with no storage registered fails, and the failure happens inside a
// receipt where it is easy to misread as a transfer problem.
export async function ftStorageRegistered(
  network: Network,
  tokenId: string,
  accountId: string,
  options: NearRpcOptions = {},
): Promise<boolean> {
  const raw = await viewCall(network, tokenId, 'storage_balance_of', { account_id: accountId }, options);
  return raw !== null && raw !== undefined;
}

// ---------- self check ----------

function expect(label: string, got: string, want: string): void {
  if (got !== want) throw new Error(`near self check failed: ${label}\n  got  ${got}\n  want ${want}`);
}

// Published vectors over every primitive this module signs with. Runs before the first
// signature of a process, so a broken primitive stops the program rather than producing a
// transaction that spends from the wrong account or cannot be verified.
let checked = false;

export function selfCheck(): void {
  if (checked) return;

  expect('base58 encode', base58Encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  expect('base58 encode leading zeroes', base58Encode(Buffer.from('0000287fb4cd', 'hex')), '11233QC4');
  expect('base58 decode', Buffer.from(base58Decode('2NEpo7TZRRrLZSi2U')).toString('utf8'), 'Hello World!');
  expect(
    'base58 decode leading zeroes',
    Buffer.from(base58Decode('11233QC4')).toString('hex'),
    '0000287fb4cd',
  );

  // NIST: sha256 of the empty string.
  expect(
    'sha256 empty',
    Buffer.from(sha256(new Uint8Array())).toString('hex'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );

  // Borsh little-endian widths and the byte-length string prefix.
  expect('borsh u32', Buffer.from(new Borsh().u32(1).finish()).toString('hex'), '01000000');
  expect('borsh u64', Buffer.from(new Borsh().u64(1n).finish()).toString('hex'), '0100000000000000');
  expect(
    'borsh u128',
    Buffer.from(new Borsh().u128(1n).finish()).toString('hex'),
    '01000000000000000000000000000000',
  );
  expect('borsh string', Buffer.from(new Borsh().string('ab').finish()).toString('hex'), '020000006162');
  // A two-character string whose UTF-8 is three bytes: the prefix must count bytes.
  expect('borsh string utf8 length', Buffer.from(new Borsh().string('é!').finish()).toString('hex'), '03000000c3a921');

  // RFC 8032 test vector 1: seed to public key, and the signature over an empty message.
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const key = privateKeyFromSeed(seed);
  expect(
    'ed25519 rfc8032 public key',
    Buffer.from(publicKeyFromPrivate(key)).toString('hex'),
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  );
  expect(
    'ed25519 rfc8032 signature',
    Buffer.from(crypto.sign(null, Buffer.alloc(0), key)).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );

  checked = true;
}

selfCheck();
