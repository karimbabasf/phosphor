// The one NEAR transaction Phosphor signs: the old fee account's one transfer of its NEAR back to
// the vault.
//
// Until 0.10.18 a small NEAR account derived from the owner key (now the old fee account, an
// implicit account whose id is the hex of its ed25519 public key) put every vault move on chain
// and paid NEAR's fee from what it held. The NEAR Intents relay pays that fee now
// (src/vault/submit.ts), so what a 0.10.16 wallet paid into that account goes back to the vault:
// one Transfer, signed by the account's derived key, to the vault's NEAR deposit address
// (src/vault/gas-account.ts). This module reads what that needs, builds it, signs it and sends it.
// Nothing else here signs, and nothing else in the app sends a NEAR transaction.
//
// Borsh is written by hand, as src/chain/near.ts did until 2026-09-16, for the same reason: sha256
// and ed25519 come from node:crypto, and a wrong byte in the body is a signature the chain refuses,
// so the failure is loud and costs nothing. near-api-js's published vectors pin every byte the
// encoder writes (tests/unit/near-tx.test.ts): the whole V0 action set from its multi-action
// transaction, and the signing rule and the transfer from its signed transfer.
//
// After the bytes leave there are three answers. executed: the transfer's receipt ran. failed: it
// did not and never can (the receipt failed, or the node refused bytes no block will ever take).
// unknown: anything else. A rate limit, a timeout, a lost reply or a refusal that a later block
// could lift is never "failed": the IDENTICAL bytes are sent again, never re-signed, so at most one
// copy can run. send_tx is idempotent on identical bytes and waits for their outcome, which makes a
// resend the poll that also recovers a copy a node dropped.

import crypto from 'node:crypto';

import { READ_TIMEOUT_MS, VENUE_WRITE_TIMEOUT_MS, isTimeout, withTimeout } from '../net.ts';
import { oneLine } from '../venue-words.ts';
import { base58Decode, base58Encode, nearChainSpec } from './near.ts';

// ---------- units and limits ----------

export const YOCTO_PER_NEAR = 10n ** 24n;

/* How long a submit keeps asking after the first send before it answers unknown; no request or
   pause runs past it. send_tx at FINAL answers in a few seconds. */
export const SUBMIT_BUDGET_MS = 60_000;

// ---------- refusals ----------

export type NearTxRefusal = 'invalid_request' | 'rpc_unavailable' | 'gas_empty';

/* A send refused before anything was signed: nothing left this Mac. The code picks the sentence a
   person reads; the message is the log line. */
export class NearTxError extends Error {
  readonly code: NearTxRefusal;
  constructor(code: NearTxRefusal, message: string) {
    super(message);
    this.name = 'NearTxError';
    this.code = code;
  }
}

// ---------- borsh ----------
//
// Little-endian integers, u32 lengths in front of strings and lists, no field names, no padding.

class Borsh {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    return this.uint(BigInt(value), 1);
  }

  u32(value: number): this {
    return this.uint(BigInt(value), 4);
  }

  u64(value: bigint): this {
    return this.uint(value, 8);
  }

  u128(value: bigint): this {
    return this.uint(value, 16);
  }

  // Every width goes through here, so a value that does not fit is refused, never cut.
  private uint(value: bigint, bytes: number): this {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error(`borsh: ${value} does not fit in u${bytes * 8}`);
    const out = new Uint8Array(bytes);
    let rest = value;
    for (let i = 0; i < bytes; i += 1) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    this.parts.push(out);
    return this;
  }

  // The length counts UTF-8 bytes, not characters.
  string(value: string): this {
    return this.bytes(new Uint8Array(Buffer.from(value, 'utf8')));
  }

  bytes(value: Uint8Array): this {
    this.u32(value.length);
    this.parts.push(Uint8Array.from(value));
    return this;
  }

  // A fixed-size array carries no length in front.
  fixed(value: Uint8Array, length: number): this {
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new Error(`borsh: expected ${length} bytes, got ${value instanceof Uint8Array ? value.length : typeof value}`);
    }
    this.parts.push(Uint8Array.from(value));
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

// ---------- transactions ----------

export type NearAccessKeyPermission =
  | { type: 'fullAccess' }
  | { type: 'functionCall'; allowance: bigint | null; receiverId: string; methodNames: string[] };

/* The V0 action set, in nearcore's order, which is the borsh tag: CreateAccount 0 to DeleteAccount 7.
   All eight are here so the published multi-action vector checks every byte the encoder writes;
   the one transaction this app builds is a single Transfer (transferAll). Public keys are ed25519,
   32 raw bytes. */
export type NearAction =
  | { type: 'createAccount' }
  | { type: 'deployContract'; code: Uint8Array }
  | { type: 'functionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: 'transfer'; deposit: bigint }
  | { type: 'stake'; stake: bigint; publicKey: Uint8Array }
  | { type: 'addKey'; publicKey: Uint8Array; nonce: bigint; permission: NearAccessKeyPermission }
  | { type: 'deleteKey'; publicKey: Uint8Array }
  | { type: 'deleteAccount'; beneficiaryId: string };

export type NearTransaction = {
  signerId: string;
  publicKey: Uint8Array; // ed25519, 32 bytes
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array; // 32 bytes
  actions: NearAction[];
};

// PublicKey is a key type byte (0 is ed25519) and the 32 raw bytes.
function writeKey(w: Borsh, key: Uint8Array): void {
  w.u8(0).fixed(key, 32);
}

function writePermission(w: Borsh, permission: NearAccessKeyPermission): void {
  if (permission.type === 'fullAccess') {
    w.u8(1);
    return;
  }
  w.u8(0);
  // Option<u128>: 0 for None, 1 and the value for Some.
  if (permission.allowance === null) w.u8(0);
  else w.u8(1).u128(permission.allowance);
  w.string(permission.receiverId).u32(permission.methodNames.length);
  for (const name of permission.methodNames) w.string(name);
}

function writeAction(w: Borsh, action: NearAction): void {
  switch (action.type) {
    case 'createAccount':
      w.u8(0);
      return;
    case 'deployContract':
      w.u8(1).bytes(action.code);
      return;
    case 'functionCall':
      w.u8(2).string(action.methodName).bytes(action.args).u64(action.gas).u128(action.deposit);
      return;
    case 'transfer':
      w.u8(3).u128(action.deposit);
      return;
    case 'stake':
      w.u8(4).u128(action.stake);
      writeKey(w, action.publicKey);
      return;
    case 'addKey':
      w.u8(5);
      writeKey(w, action.publicKey);
      w.u64(action.nonce);
      writePermission(w, action.permission);
      return;
    case 'deleteKey':
      w.u8(6);
      writeKey(w, action.publicKey);
      return;
    case 'deleteAccount':
      w.u8(7).string(action.beneficiaryId);
      return;
    default:
      throw new Error(`borsh: no action of type ${JSON.stringify((action as { type?: unknown }).type)}`);
  }
}

// Transaction (V0): signer_id, public_key, nonce u64, receiver_id, block_hash [32], actions.
export function encodeTransaction(tx: NearTransaction): Uint8Array {
  const w = new Borsh().string(tx.signerId);
  writeKey(w, tx.publicKey);
  w.u64(tx.nonce).string(tx.receiverId).fixed(tx.blockHash, 32).u32(tx.actions.length);
  for (const action of tx.actions) writeAction(w, action);
  return w.finish();
}

// ---------- keys and signing ----------

// node reads an ed25519 seed only inside the fixed PKCS8 prefix for ed25519 (RFC 8410). The copy
// that holds the seed is zeroed once parsed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyOf(seed: Uint8Array): crypto.KeyObject {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('an ed25519 seed is 32 bytes');
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

function publicKeyOf(key: crypto.KeyObject): Uint8Array {
  const x = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const bytes = typeof x === 'string' ? new Uint8Array(Buffer.from(x, 'base64url')) : new Uint8Array();
  if (bytes.length !== 32) throw new Error('the ed25519 public key did not export as 32 bytes');
  return bytes;
}

export type ImplicitAccount = { accountId: string; publicKey: string; publicKeyBytes: Uint8Array };

// The account a seed controls with nobody creating it: its id is the hex of its public key.
export function implicitAccountOf(seed: Uint8Array): ImplicitAccount {
  return accountOfKey(publicKeyOf(privateKeyOf(seed)));
}

function accountOfKey(bytes: Uint8Array): ImplicitAccount {
  return { accountId: Buffer.from(bytes).toString('hex'), publicKey: `ed25519:${base58Encode(bytes)}`, publicKeyBytes: bytes };
}

export type SignedNearTransaction = {
  bytes: Uint8Array; // borsh SignedTransaction: the transaction, 0 for ed25519, the 64-byte signature
  base64: string; // what send_tx carries
  hash: string; // base58 of sha256(transaction): the id the chain and the explorer know it by
  signature: Uint8Array;
};

export function signTransaction(tx: NearTransaction, seed: Uint8Array): SignedNearTransaction {
  return signWith(tx, privateKeyOf(seed));
}

function signWith(tx: NearTransaction, key: crypto.KeyObject): SignedNearTransaction {
  // A seed that is not the transaction's key signs bytes the chain refuses with a message about
  // access keys; this names the cause instead.
  if (!Buffer.from(publicKeyOf(key)).equals(Buffer.from(tx.publicKey))) throw new Error('the seed is not the key this transaction names');
  const body = encodeTransaction(tx);
  // ed25519 signs the 32-byte hash of the body, not the body. The same hash is the transaction's id.
  const digest = new Uint8Array(crypto.createHash('sha256').update(body).digest());
  const signature = new Uint8Array(crypto.sign(null, digest, key));
  if (signature.length !== 64) throw new Error(`an ed25519 signature is 64 bytes, this one is ${signature.length}`);
  const bytes = new Uint8Array(Buffer.concat([body, Uint8Array.of(0), signature]));
  return { bytes, base64: Buffer.from(bytes).toString('base64'), hash: base58Encode(digest), signature };
}

// ---------- RPC ----------

export type NearRpcDeps = {
  fetchImpl?: typeof fetch;
  rpcUrl?: string;
  sleep?: (ms: number) => Promise<void>;
};

export type SubmitDeps = NearRpcDeps & { now?: () => number; budgetMs?: number };

type Deps = Required<SubmitDeps>;

function withDefaults(deps: SubmitDeps): Deps {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    rpcUrl: deps.rpcUrl ?? nearChainSpec().rpcUrl,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    // A monotonic clock, so a wall clock moved backwards cannot stretch the budget.
    now: deps.now ?? (() => performance.now()),
    budgetMs: deps.budgetMs ?? SUBMIT_BUDGET_MS,
  };
}

/* One JSON-RPC exchange, sorted into what the callers branch on. `rate_limited` is FastNEAR's free
   tier saying no, as HTTP 429 or as code -429 in the body: the request was not taken. `no_answer` is
   a failure to hear back, which for a send is not a failure to send. `cause` is nearcore's own name
   for an error (error.cause.name, else error.name), and `data` its detail as sent. */
type Reply =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; cause: string; detail: string; data: unknown }
  | { kind: 'rate_limited' }
  | { kind: 'no_answer'; why: string };

type RpcBody = { result?: unknown; error?: { name?: unknown; code?: unknown; message?: unknown; data?: unknown; cause?: { name?: unknown; info?: unknown } } };

async function exchange(method: string, params: unknown, deps: Deps, timeoutMs: number): Promise<Reply> {
  const { fetchImpl } = deps;
  let res: Response;
  try {
    res = await fetchImpl(deps.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'phosphor', method, params }),
      signal: withTimeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'no_answer', why: isTimeout(err) ? 'timed out' : oneLine(err instanceof Error ? err.message : err, 160) };
  }
  if (res.status === 429) return { kind: 'rate_limited' };
  let body: RpcBody | null;
  try {
    body = (await res.json()) as RpcBody | null;
  } catch (err) {
    return { kind: 'no_answer', why: isTimeout(err) ? 'timed out' : `http ${res.status} with no JSON` };
  }
  const error = body?.error;
  if (error !== undefined && error !== null) {
    if (typeof error !== 'object') return { kind: 'error', cause: 'UNKNOWN', detail: oneLine(error, 200), data: error };
    if (error.code === -429) return { kind: 'rate_limited' };
    const cause = typeof error.cause?.name === 'string' ? error.cause.name : typeof error.name === 'string' ? error.name : 'UNKNOWN';
    return { kind: 'error', cause, detail: oneLine(error.data ?? error.message ?? '', 200), data: error.data };
  }
  if (!res.ok || body === null || typeof body !== 'object' || !('result' in body)) return { kind: 'no_answer', why: `http ${res.status} with no result` };
  return { kind: 'result', result: body.result };
}

// A read asks up to three times, a second and then two apart, while the RPC rate-limits or does not answer.
async function read(method: string, params: unknown, deps: Deps): Promise<Reply> {
  let reply = await exchange(method, params, deps, READ_TIMEOUT_MS);
  for (let attempt = 1; attempt < 3 && (reply.kind === 'rate_limited' || reply.kind === 'no_answer'); attempt += 1) {
    await deps.sleep(1000 * attempt);
    reply = await exchange(method, params, deps, READ_TIMEOUT_MS);
  }
  return reply;
}

function unavailable(what: string, reply: Reply): NearTxError {
  const why =
    reply.kind === 'rate_limited' ? 'rate limited' :
    reply.kind === 'no_answer' ? reply.why :
    reply.kind === 'error' ? `${reply.cause} ${reply.detail}` :
    'an answer of the wrong shape';
  return new NearTxError('rpc_unavailable', `NEAR ${what} did not answer: ${why}`);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// An unsigned integer as nearcore writes it: a JSON number for gas and nonces, a digit string for balances.
function uint(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^\d{1,40}$/.test(value)) return BigInt(value);
  return null;
}

// ---------- reads ----------

export type FinalBlockHeader = { hash: string; hashBytes: Uint8Array; height: number; gasPrice: bigint; timestampMs: number };

// The newest final block: the hash a transaction is built on, and the gas price it is bought at.
export async function readFinalBlock(deps: NearRpcDeps = {}): Promise<FinalBlockHeader> {
  const reply = await read('block', { finality: 'final' }, withDefaults(deps));
  const header = reply.kind === 'result' ? headerOf(record(record(reply.result).header)) : null;
  if (header === null) throw unavailable('block', reply);
  return header;
}

function headerOf(h: Record<string, unknown>): FinalBlockHeader | null {
  if (typeof h.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h.hash)) return null;
  const hashBytes = base58Decode(h.hash);
  const height = uint(h.height);
  const gasPrice = uint(h.gas_price);
  const nanos = uint(h.timestamp_nanosec);
  if (hashBytes.length !== 32 || height === null || height === 0n || gasPrice === null || nanos === null) return null;
  return { hash: h.hash, hashBytes, height: Number(height), gasPrice, timestampMs: Number(nanos / 1_000_000n) };
}

export type AccessKeyView =
  | { found: true; nonce: bigint; permission: NearAccessKeyPermission; blockHash: string; blockHeight: number }
  | { found: false };

/* nearcore 2.13.4 answers a key it cannot find inside `result`, as this flat error string with
   HTTP 200 (read live 2026-10-04), whether or not the account exists. Only view_account tells "no
   account yet" from "no such key". The error forms on nearcore master (UNKNOWN_ACCESS_KEY,
   UNKNOWN_ACCOUNT) are read the same way for the day the RPC moves to them. */
const MISSING_KEY = /^access key \S+ does not exist while viewing$/;

export async function viewAccessKey(
  accountId: string,
  publicKey: string,
  deps: NearRpcDeps & { finality?: 'final' | 'optimistic' } = {},
): Promise<AccessKeyView> {
  const reply = await read(
    'query',
    { request_type: 'view_access_key', finality: deps.finality ?? 'final', account_id: accountId, public_key: publicKey },
    withDefaults(deps),
  );
  if (reply.kind === 'error' && (reply.cause === 'UNKNOWN_ACCESS_KEY' || reply.cause === 'UNKNOWN_ACCOUNT')) return { found: false };
  if (reply.kind === 'result') {
    const r = record(reply.result);
    if (typeof r.error === 'string' && MISSING_KEY.test(r.error)) return { found: false };
    if (typeof r.error === 'string') throw new NearTxError('rpc_unavailable', `NEAR view_access_key answered: ${oneLine(r.error, 200)}`);
    const nonce = uint(r.nonce);
    const permission = permissionOf(r.permission);
    const blockHeight = uint(r.block_height);
    if (nonce !== null && permission !== null && typeof r.block_hash === 'string' && blockHeight !== null) {
      return { found: true, nonce, permission, blockHash: r.block_hash, blockHeight: Number(blockHeight) };
    }
  }
  throw unavailable('view_access_key', reply);
}

function permissionOf(raw: unknown): NearAccessKeyPermission | null {
  if (raw === 'FullAccess') return { type: 'fullAccess' };
  const call = record(record(raw).FunctionCall);
  const names = call.method_names;
  if (typeof call.receiver_id !== 'string' || !Array.isArray(names) || !names.every((n) => typeof n === 'string')) return null;
  const allowance = call.allowance === null || call.allowance === undefined ? null : uint(call.allowance);
  if (allowance === null && call.allowance !== null && call.allowance !== undefined) return null;
  return { type: 'functionCall', allowance, receiverId: call.receiver_id, methodNames: [...names] };
}

export type AccountView = { found: true; amount: bigint; locked: bigint; storageUsage: number; blockHeight: number } | { found: false };

export async function viewAccount(accountId: string, deps: NearRpcDeps = {}): Promise<AccountView> {
  const reply = await read('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, withDefaults(deps));
  if (reply.kind === 'error' && reply.cause === 'UNKNOWN_ACCOUNT') return { found: false };
  if (reply.kind === 'result') {
    const r = record(reply.result);
    const amount = uint(r.amount);
    const locked = uint(r.locked);
    const storage = uint(r.storage_usage);
    const blockHeight = uint(r.block_height);
    if (amount !== null && locked !== null && storage !== null && blockHeight !== null) {
      return { found: true, amount, locked, storageUsage: Number(storage), blockHeight: Number(blockHeight) };
    }
  }
  throw unavailable('view_account', reply);
}

// ---------- the transfer ----------

export type TransferOutcome = {
  status: 'executed' | 'failed' | 'unknown';
  txHash: string;
  amount: bigint; // what the transfer carries, in yoctoNEAR
  reason?: string; // the log line when not executed
};

// The one transaction this app builds: a single Transfer of `deposit` yoctoNEAR.
export function transferTransaction(tx: Omit<NearTransaction, 'actions'> & { deposit: bigint }): NearTransaction {
  return { signerId: tx.signerId, publicKey: tx.publicKey, nonce: tx.nonce, receiverId: tx.receiverId, blockHash: tx.blockHash, actions: [{ type: 'transfer', deposit: tx.deposit }] };
}

/* Sends everything the seed's implicit account holds above `keep` to `receiverId`, in one Transfer
   signed by that seed, at FINAL. Throws NearTxError only before anything is signed: `gas_empty`
   when the account does not exist or holds less than `least` above `keep`. Once signed it always
   answers a TransferOutcome. */
export async function transferAll(
  request: { seed: Uint8Array; receiverId: string; keep: bigint; least: bigint },
  deps: SubmitDeps = {},
): Promise<TransferOutcome> {
  if (!(request.seed instanceof Uint8Array) || request.seed.length !== 32) throw new NearTxError('invalid_request', 'the seed is not 32 bytes');
  if (typeof request.receiverId !== 'string' || request.receiverId === '') throw new NearTxError('invalid_request', 'the transfer names no receiver');
  // The key is parsed now: the caller may wipe its seed while this waits its turn.
  const key = privateKeyOf(request.seed);
  const from = accountOfKey(publicKeyOf(key));
  return exclusive(from.accountId, () => transferAs(from, key, request, withDefaults(deps)));
}

/* One send at a time per account in this process: two at once would read the same access key
   nonce and one would be refused. */
const turns = new Map<string, Promise<void>>();

async function exclusive<T>(account: string, run: () => Promise<T>): Promise<T> {
  const before = turns.get(account) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const tail = before.then(() => mine);
  turns.set(account, tail);
  try {
    await before;
    return await run();
  } finally {
    done();
    if (turns.get(account) === tail) turns.delete(account);
  }
}

function nearText(yocto: bigint): string {
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
  return fraction === '' ? `${yocto / YOCTO_PER_NEAR}` : `${yocto / YOCTO_PER_NEAR}.${fraction}`;
}

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 8)}...${id.slice(-8)}` : id;
}

async function transferAs(from: ImplicitAccount, key: crypto.KeyObject, request: { receiverId: string; keep: bigint; least: bigint }, d: Deps): Promise<TransferOutcome> {
  /* Three reads, then the refusals, then the one signature. The key's nonce is read at optimistic:
     a transaction that ran a block ago is already counted there and not yet at final, and a nonce
     the chain has seen is refused. The budget runs from here, so slow reads shorten the sending. */
  const started = d.now();
  const [block, account, accessKey] = await Promise.all([
    readFinalBlock(d),
    viewAccount(from.accountId, d),
    viewAccessKey(from.accountId, from.publicKey, { ...d, finality: 'optimistic' }),
  ]);
  if (!account.found) throw new NearTxError('gas_empty', `the account ${shortId(from.accountId)} does not exist: no NEAR was ever paid into it`);
  const amount = account.amount - request.keep;
  if (amount < request.least) {
    throw new NearTxError('gas_empty', `the account ${shortId(from.accountId)} holds ${nearText(account.amount)} NEAR, under the ${nearText(request.keep + request.least)} a return needs`);
  }
  if (!accessKey.found || accessKey.permission.type !== 'fullAccess') {
    throw new NearTxError('invalid_request', `the account ${shortId(from.accountId)} does not carry the key this app derives for it`);
  }
  // Reads that ate half the budget mean an RPC in trouble: stop while nothing is signed, so a send
  // always keeps at least half.
  if (d.now() - started >= d.budgetMs / 2) {
    throw new NearTxError('rpc_unavailable', `NEAR took ${Math.round(d.now() - started)} ms to answer the reads before signing; nothing was signed`);
  }
  const signed = signWith(
    transferTransaction({ signerId: from.accountId, publicKey: from.publicKeyBytes, nonce: accessKey.nonce + 1n, receiverId: request.receiverId, blockHash: block.hashBytes, deposit: amount }),
    key,
  );
  return { ...(await deliver(signed, from.accountId, request.receiverId, d, started)), amount };
}

/* Refusals the bytes alone decide, with no chain state read: every node says the same about them,
   so no block will ever take the transaction, wherever a copy went. Every other refusal can come
   from one node's view and lift on the next. nearcore says them even about a copy it already took:
   send_tx forwards the transaction, then re-checks it against newer state while waiting and answers
   INVALID_TRANSACTION for a congested shard or a gas price that rose, with the forwarded copy still
   able to run (chain/jsonrpc/src/lib.rs, tx_status_fetch, nearcore 2.13.4). A node behind the block
   the transaction names answers Expired, and one behind the account answers SignerDoesNotExist or
   AccessKeyNotFound. nearcore's check that a used nonce went to this very transaction can miss a copy
   its view has not indexed yet, so InvalidNonce stays out too. */
const NEVER_VALID = new Set(['InvalidSignature', 'InvalidSignerId', 'InvalidReceiverId', 'TransactionSizeExceeded', 'ActionsValidation', 'InvalidTransactionVersion']);

function neverValid(reply: { cause: string; data: unknown }): boolean {
  if (reply.cause === 'PARSE_ERROR' || reply.cause === 'REQUEST_VALIDATION_ERROR') return true;
  if (reply.cause !== 'INVALID_TRANSACTION') return false;
  // data is {"TxExecutionError":{"InvalidTxError":<variant>}}: a unit variant is a string, any other
  // an object with one key.
  const variant = record(record(reply.data).TxExecutionError).InvalidTxError;
  const name = typeof variant === 'string' ? variant : Object.keys(record(variant))[0];
  return name !== undefined && NEVER_VALID.has(name);
}

type Delivered = Omit<TransferOutcome, 'amount'>;

async function deliver(signed: SignedNearTransaction, sender: string, receiver: string, d: Deps, started: number): Promise<Delivered> {
  const left = () => d.budgetMs - (d.now() - started);
  // Whether any copy sent so far may have been taken. Until one may, a refusal of the bytes is final.
  let mayHaveLanded = false;
  let ask: 'send' | 'poll' = 'send';
  let last = '';
  for (let round = 0; ; round += 1) {
    if (round > 0 && left() <= 0) return settled('unknown', signed.hash, last);
    // A whole number of milliseconds, at least one: AbortSignal.timeout refuses anything else.
    const timeoutMs = Math.max(1, Math.floor(Math.min(VENUE_WRITE_TIMEOUT_MS, left())));
    const sent: boolean = ask === 'send';
    const reply = sent
      ? await exchange('send_tx', { signed_tx_base64: signed.base64, wait_until: 'FINAL' }, d, timeoutMs)
      : await exchange('tx', { tx_hash: signed.hash, sender_account_id: sender, wait_until: 'FINAL' }, d, timeoutMs);
    // Unless an answer says otherwise, the identical bytes go again: send_tx takes a copy it already
    // has as the same transaction and waits for its outcome, and takes a dropped one afresh. A tx poll
    // at FINAL on a hash the node never saw only times out, so it cannot tell a dropped copy apart.
    ask = 'send';
    if (reply.kind === 'result') {
      const outcome = outcomeOf(reply.result, signed.hash, receiver);
      if (outcome !== null) return outcome;
      mayHaveLanded = true;
      ask = 'poll';
      last = 'the RPC answered without a final outcome for it';
    } else if (reply.kind === 'rate_limited') {
      // Not taken: the same request again.
      ask = sent ? 'send' : 'poll';
      last = 'the RPC rate-limited the request';
    } else if (reply.kind === 'error' && neverValid(reply)) {
      if (!mayHaveLanded) return settled('failed', signed.hash, `the chain refused the transaction: ${reply.cause} ${reply.detail}`);
      // An earlier copy may have run before these bytes became unacceptable: ask for it by hash.
      ask = 'poll';
      last = `${reply.cause} ${reply.detail}`;
    } else {
      // TIMEOUT_ERROR, a refusal that can lift, an internal error, a routed request, a lost reply.
      if (sent) mayHaveLanded = true;
      last = reply.kind === 'no_answer' ? reply.why : `${reply.cause} ${reply.detail}`;
    }
    if (left() <= 0) return settled('unknown', signed.hash, last);
    await d.sleep(Math.min(1000 * 2 ** round, 8000, left()));
  }
}

function settled(status: 'failed' | 'unknown', txHash: string, reason: string): Delivered {
  return { status, txHash, reason: oneLine(reason, 300) };
}

/* A FINAL outcome, or null when the answer cannot decide it. The transfer ran exactly when the
   receipt the transaction became, executed by the receiver, succeeded: a failed receipt there
   refunds the deposit. */
function outcomeOf(result: unknown, txHash: string, receiver: string): Delivered | null {
  const r = record(result);
  if (r.final_execution_status !== 'FINAL' || record(r.transaction).hash !== txHash) return null;
  const txOutcome = record(record(r.transaction_outcome).outcome);
  const receipts = (Array.isArray(r.receipts_outcome) ? r.receipts_outcome : []).map((x) => ({ id: record(x).id, outcome: record(record(x).outcome) }));
  const txStatus = record(txOutcome.status);
  if ('Failure' in txStatus) return { status: 'failed', txHash, reason: `the transaction failed before its receipt ran: ${failureText(txStatus.Failure)}` };
  const mainId = Array.isArray(txOutcome.receipt_ids) ? txOutcome.receipt_ids[0] : undefined;
  const main = receipts.find((x) => typeof mainId === 'string' && x.id === mainId);
  if (main === undefined || main.outcome.executor_id !== receiver) return null;
  const status = record(main.outcome.status);
  if ('Failure' in status) return { status: 'failed', txHash, reason: `the transfer's receipt failed: ${failureText(status.Failure)}` };
  if ('SuccessValue' in status || 'SuccessReceiptId' in status) return { status: 'executed', txHash };
  return null;
}

// What a failure said, as one line.
function failureText(failure: unknown): string {
  return oneLine(failure, 200);
}
