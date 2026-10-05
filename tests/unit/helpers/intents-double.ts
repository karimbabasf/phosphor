// The chain double for the chip vault (PHASE2-PLAN U6): intents.near as a vault meets it, the solver
// relay that puts a vault bundle on chain, and the NEAR RPC the old fee account sends its one
// transfer back through.
//
// The verifier runs each payload the way 0.4.4 does (CONTRACTS.md, "Verifier facts (Phase 2)"):
// the signature (erc191 recovered with viem; webauthn held to the same wrapper rules the app holds a
// chip answer to, src/vault/webauthn.ts), the deadline by block time, the signer's key (a 0x
// account's own key counts until it is removed), the V1 nonce (salt valid, payload deadline no later
// than the nonce's, nonce not expired, not used), then the intents a vault signs: add_public_key,
// remove_public_key, set_auth_by_predecessor_id (an event only when the flag changes) and transfer.
// State carries across the payloads of one call, and the whole call runs or none of it does. Events
// are the dip4 EVENT_JSON lines the verifier writes, intents_executed last. simulate answers through
// src/relay/verifier.ts simulationOf, and every view reads at a block hash when given one, from that
// block's own copy of the state.
//
// The relay answers publish_intents and get_status (`relay`, the shape src/relay/client.ts gives
// src/vault/submit.ts). It refuses a bundle the verifier would refuse, as the live relay does, and
// a test scripts what each publish does (`publishes`, the last entry repeating): run and answer OK;
// answer FAILED, run or not; lose the reply, run or not; answer OK and run later; answer OK and
// never run; answer OK and run only the first payloads.
//
// The RPC answers what src/chain/near-tx.ts asks (block, view_account, view_access_key, send_tx,
// tx) and decodes and checks the signed transaction itself: the account key's ed25519 signature,
// its access key nonce, one Transfer. A test scripts what each send does (`sends`, the last entry
// repeating): land and answer; land and time out; land and lose the reply; land and answer
// INVALID_TRANSACTION, as nearcore does for a forwarded copy it re-checks; never land; land later.
// The same bytes sent again run once.
//
// One clock for this Mac and the chain. Every read makes a new final block when the clock moved, so
// a block is stamped with the time it was read at, and near-tx's sleep moves the clock, so a 60
// second submit budget passes at once.

import crypto from 'node:crypto';

import { bytesToHex, hashMessage, hexToBytes, keccak256, recoverPublicKey } from 'viem';

import { base58Decode, base58Encode } from '../../../src/chain/near.ts';
import type { MultiPayload, RelayBundleClient, RelayStatus } from '../../../src/relay/client.ts';
import { decodeNonce } from '../../../src/relay/payload.ts';
import { SPIKED_VERIFIER, simulationOf } from '../../../src/relay/verifier.ts';
import type { ExecutedEntry, FinalBlock, Simulation, SignedIntent, VerifierPort } from '../../../src/relay/verifier.ts';
import { signedIntentHash } from '../../../src/vault/payload.ts';
import { webauthnMultiPayload } from '../../../src/vault/webauthn.ts';

export const START = Date.parse('2026-10-04T20:00:00.000Z');
export const SALT_HEX = '252812b3';
export const SALT = Uint8Array.from(Buffer.from(SALT_HEX, 'hex'));
export const DOUBLE_RPC = 'https://rpc.double.invalid';
const VERIFIER = 'intents.near';
const GAS_PRICE = '100000000';
// What one transfer burns here: about what a NEAR transfer burns at today's gas price.
export const BURNT_YOCTO = 44_600_000_000_000_000_000n;
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

type ChainState = {
  keys: Map<string, Set<string>>;
  implicitRemoved: Set<string>;
  predecessorOff: Set<string>;
  balances: Map<string, Map<string, bigint>>;
  nonces: Map<string, Set<string>>;
  salts: { current: string; valid: Set<string> };
};

type Block = FinalBlock & { height: number; hashBytes: Uint8Array; state: ChainState };

type Gas = { amount: bigint; keyNonce: bigint };

/* What one send_tx does. land: the transaction runs (now, or for `later` once the clock passes
   afterMs); the answer is what the RPC says back. */
export type Send =
  | { kind: 'ok' }
  | { kind: 'timeout'; land: boolean }
  | { kind: 'lost'; land: boolean }
  | { kind: 'invalid'; land: boolean; variant?: unknown }
  | { kind: 'rate_limited' }
  | { kind: 'later'; afterMs: number };

/* What one publish_intents does. ok: the relay runs the bundle in one call and answers OK. failed:
   it answers FAILED, and runs the bundle anyway when `land`. lost: no answer, run or not. later: OK
   now, run once the clock passes afterMs. dropped: OK, and it never runs. part: OK, and only the
   first `count` payloads run, in a call of their own. */
export type Publish =
  | { kind: 'ok' }
  | { kind: 'failed'; land: boolean; reason?: string }
  | { kind: 'lost'; land: boolean }
  | { kind: 'later'; afterMs: number }
  | { kind: 'dropped' }
  | { kind: 'part'; count: number };

type RpcAnswer = { http?: number; body: unknown } | 'network';

const rpcError = (cause: string, data: unknown = 'Server error'): RpcAnswer => ({
  body: { jsonrpc: '2.0', id: 'phosphor', error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } },
});

function sha256(data: Uint8Array | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function event(name: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'dip4', version: '0.4.3', event: name, data })}`;
}

class Panic extends Error {}
const panic = (text: string): never => {
  throw new Panic(text);
};

function addressOf(xy: Uint8Array): string {
  return `0x${keccak256(xy).slice(-40)}`;
}

function hasKey(state: ChainState, account: string, key: string): boolean {
  if (state.keys.get(account)?.has(key)) return true;
  if (!/^0x[0-9a-f]{40}$/.test(account) || !key.startsWith('secp256k1:') || state.implicitRemoved.has(account)) return false;
  try {
    const xy = base58Decode(key.slice('secp256k1:'.length));
    return xy.length === 64 && addressOf(xy) === account;
  } catch {
    return false;
  }
}

// The key that signed a payload, as the verifier names it, or a panic.
async function signerKey(signed: MultiPayload): Promise<string> {
  if (signed.standard === 'erc191') {
    const sig = signed.signature.startsWith('secp256k1:') ? base58Decode(signed.signature.slice('secp256k1:'.length)) : new Uint8Array();
    if (sig.length !== 65 || sig[64]! > 1) panic('invalid signature');
    try {
      const recovered = await recoverPublicKey({ hash: hashMessage(signed.payload), signature: bytesToHex(Uint8Array.from([...sig.subarray(0, 64), sig[64]! + 27])) });
      return `secp256k1:${base58Encode(hexToBytes(recovered).subarray(1))}`;
    } catch {
      return panic('invalid signature');
    }
  }
  if (signed.standard === 'webauthn') {
    try {
      return webauthnMultiPayload({ ...signed }).public_key;
    } catch {
      return panic('invalid signature');
    }
  }
  return panic(`JSON: unknown variant \`${signed.standard}\`, expected one of \`nep413\`, \`erc191\`, \`tip191\`, \`raw_ed25519\`, \`webauthn\`, \`ton_connect\`, \`sep53\``);
}

type Run = { logs: string[]; chainLogs: string[]; executed: ExecutedEntry[]; minDeadline: number };

/* One call of execute_intents (or simulate_intents) on `state`, at block time `atMs`. Changes
   `state` only when every payload runs. */
async function runIntents(state: ChainState, signed: readonly MultiPayload[], atMs: number): Promise<Run> {
  const work = structuredClone(state);
  const logs: string[] = [];
  const chainLogs: string[] = [];
  const executed: ExecutedEntry[] = [];
  let minDeadline = Number.POSITIVE_INFINITY;
  for (const s of signed) {
    const key = await signerKey(s);
    const intentHash = signedIntentHash(s);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(s.payload) as Record<string, unknown>;
    } catch {
      return panic('JSON: the payload is not JSON');
    }
    if (body.verifying_contract !== VERIFIER) panic('wrong verifying_contract');
    const deadlineMs = Date.parse(String(body.deadline));
    if (!Number.isFinite(deadlineMs)) panic('JSON: invalid deadline');
    if (atMs > deadlineMs) panic('deadline has expired');
    minDeadline = Math.min(minDeadline, deadlineMs);
    const account = String(body.signer_id);
    if (!hasKey(work, account, key)) panic(`public key '${key}' doesn't exist for account '${account}'`);
    const nonce = String(body.nonce);
    const parts = decodeNonce(nonce);
    if (parts !== null) {
      if (!work.salts.valid.has(Buffer.from(parts.salt).toString('hex'))) panic('invalid salt');
      if (deadlineMs > parts.deadlineMs) panic('deadline is greater than nonce');
      if (parts.deadlineMs < atMs) panic('nonce was already expired');
    }
    const used = work.nonces.get(account) ?? new Set<string>();
    if (used.has(nonce)) panic('nonce was already used');
    used.add(nonce);
    work.nonces.set(account, used);
    for (const raw of Array.isArray(body.intents) ? (body.intents as Record<string, unknown>[]) : []) {
      const kind = raw.intent;
      if (kind === 'add_public_key' || kind === 'remove_public_key') {
        const publicKey = String(raw.public_key);
        const keys = work.keys.get(account) ?? new Set<string>();
        if (kind === 'add_public_key') {
          if (hasKey(work, account, publicKey)) panic(`public key '${publicKey}' already exists for account '${account}'`);
          keys.add(publicKey);
        } else if (keys.has(publicKey)) keys.delete(publicKey);
        else if (hasKey(work, account, publicKey)) work.implicitRemoved.add(account);
        else panic(`public key '${publicKey}' doesn't exist for account '${account}'`);
        work.keys.set(account, keys);
        logs.push(event(kind === 'add_public_key' ? 'public_key_added' : 'public_key_removed', { intent_hash: intentHash, account_id: account, public_key: publicKey }));
      } else if (kind === 'set_auth_by_predecessor_id') {
        const enabled = raw.enabled === true;
        const was = !work.predecessorOff.has(account);
        if (enabled !== was) {
          if (enabled) work.predecessorOff.delete(account);
          else work.predecessorOff.add(account);
          logs.push(event('set_auth_by_predecessor_id', { intent_hash: intentHash, account_id: account, enabled }));
        }
      } else if (kind === 'transfer') {
        const receiver = String(raw.receiver_id).toLowerCase();
        const tokens = (raw.tokens ?? {}) as Record<string, string>;
        for (const [asset, amountText] of Object.entries(tokens)) {
          const amount = BigInt(amountText);
          const from = work.balances.get(account) ?? new Map<string, bigint>();
          const have = from.get(asset) ?? 0n;
          if (amount <= 0n || have < amount) panic('insufficient balance or overflow');
          from.set(asset, have - amount);
          work.balances.set(account, from);
          const to = work.balances.get(receiver) ?? new Map<string, bigint>();
          to.set(asset, (to.get(asset) ?? 0n) + amount);
          work.balances.set(receiver, to);
        }
        logs.push(event('transfer', [{ intent_hash: intentHash, account_id: account, receiver_id: receiver, tokens }]));
        // On chain a token move also logs NEP-245's own event; a simulation does not.
        chainLogs.push(`EVENT_JSON:${JSON.stringify({ standard: 'nep245', version: '1.0.0', event: 'mt_transfer', data: [{ old_owner_id: account, new_owner_id: receiver, token_ids: Object.keys(tokens), amounts: Object.values(tokens) }] })}`);
      } else {
        panic(`JSON: unknown variant \`${String(kind)}\``);
      }
    }
    executed.push({ intent_hash: intentHash, account_id: account, nonce });
  }
  logs.push(event('intents_executed', executed));
  Object.assign(state, work);
  return { logs, chainLogs, executed, minDeadline };
}

// ---------- the signed transaction, read back ----------

class Reader {
  at = 0;
  readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }
  u8(): number {
    return this.bytes[this.at++]!;
  }
  u32(): number {
    const v = this.bytes.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  u64(): bigint {
    const v = this.bytes.readBigUInt64LE(this.at);
    this.at += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    return (this.u64() << 64n) + lo;
  }
  take(n: number): Buffer {
    const out = this.bytes.subarray(this.at, this.at + n);
    if (out.length !== n) throw new Error('short transaction');
    this.at += n;
    return out;
  }
  string(): string {
    return this.take(this.u32()).toString('utf8');
  }
}

type DecodedTx = { body: Buffer; hash: string; signerId: string; publicKey: Buffer; nonce: bigint; receiverId: string; blockHash: Buffer; deposit: bigint; signature: Buffer; actions: number };

function decodeSignedTx(bytes: Buffer): DecodedTx {
  const r = new Reader(bytes);
  const signerId = r.string();
  if (r.u8() !== 0) throw new Error('not an ed25519 key');
  const publicKey = r.take(32);
  const nonce = r.u64();
  const receiverId = r.string();
  const blockHash = r.take(32);
  const actions = r.u32();
  if (r.u8() !== 3) throw new Error('not a Transfer');
  const deposit = r.u128();
  const body = bytes.subarray(0, r.at);
  if (r.u8() !== 0) throw new Error('not an ed25519 signature');
  const signature = r.take(64);
  if (r.at !== bytes.length) throw new Error('bytes after the signature');
  return { body, hash: base58Encode(sha256(body)), signerId, publicKey, nonce, receiverId, blockHash, deposit, signature, actions };
}

// ---------- the double ----------

export type IntentsDouble = ReturnType<typeof createIntentsDouble>;

export function createIntentsDouble(opts: { start?: number } = {}) {
  let wall = opts.start ?? START;
  const state: ChainState = {
    keys: new Map(),
    implicitRemoved: new Set(),
    predecessorOff: new Set(),
    balances: new Map(),
    nonces: new Map(),
    salts: { current: SALT_HEX, valid: new Set([SALT_HEX]) },
  };
  const blocks: Block[] = [];
  const gasAccounts = new Map<string, Gas>();
  const outcomes = new Map<string, unknown>();
  const later: { at: number; tx: DecodedTx }[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const sends: Send[] = [];
  let sendCount = 0;
  let executions = 0;
  // NEAR that transfers carried to accounts the double does not hold (a deposit address).
  const received = new Map<string, bigint>();
  // The relay: what each intent hash it took became, and the bundles it runs later.
  const relayed = new Map<string, { status: 'PENDING' | 'SETTLED' | 'NOT_FOUND_OR_NOT_VALID'; txHash: string | null }>();
  const relayLater: { at: number; signed: MultiPayload[]; hashes: string[] }[] = [];
  const publishes: Publish[] = [];
  let publishCount = 0;
  // A test sets these to make the verifier's reads fail, or to change what simulate reports.
  const faults = { reads: false, simulate: null as null | ((sim: Simulation) => Simulation) };

  function produce(): Block {
    const height = (blocks.at(-1)?.height ?? 120_000_000) + 1;
    const hashBytes = sha256(`double block ${height}`);
    const block: Block = { height, hash: base58Encode(hashBytes), hashBytes, atMs: wall, state: structuredClone(state) };
    blocks.push(block);
    if (blocks.length > 4000) blocks.splice(0, 1000);
    return block;
  }

  // Lands every transaction and relayed bundle whose time has come. Every read asks first.
  async function due(): Promise<void> {
    for (const ready of later.filter((l) => l.at <= wall)) {
      later.splice(later.indexOf(ready), 1);
      await land(ready.tx);
    }
    for (const ready of relayLater.filter((l) => l.at <= wall)) {
      relayLater.splice(relayLater.indexOf(ready), 1);
      await runRelayed(ready.signed, ready.hashes);
    }
  }

  /* The relay's own call of execute_intents: the bundle runs whole or not at all, and every intent
     hash in it reads SETTLED with the call's hash, or NOT_FOUND_OR_NOT_VALID when it did not run. */
  async function runRelayed(signed: MultiPayload[], hashes: string[]): Promise<boolean> {
    try {
      await runIntents(state, signed, wall);
    } catch {
      for (const h of hashes) relayed.set(h, { status: 'NOT_FOUND_OR_NOT_VALID', txHash: null });
      return false;
    }
    executions += 1;
    const txHash = base58Encode(sha256(`relay ${hashes.join(',')}`));
    for (const h of hashes) relayed.set(h, { status: 'SETTLED', txHash });
    produce();
    return true;
  }

  const relay: RelayBundleClient = {
    async publishIntents(signedIn) {
      const signed = signedIn.map((x) => ({ ...x }));
      calls.push({ method: 'publish_intents', params: { quote_hashes: [], signed_datas: signed } });
      await due();
      const script = publishes.length > 1 ? publishes.shift()! : (publishes[0] ?? { kind: 'ok' });
      publishCount += 1;
      const hashes = signed.map((x) => signedIntentHash(x));
      const unheld = (from: number) => hashes.slice(from).forEach((h) => relayed.set(h, { status: 'NOT_FOUND_OR_NOT_VALID', txHash: null }));
      // The live relay checks a bundle against the verifier before it takes it.
      if (script.kind !== 'failed' && script.kind !== 'lost') {
        try {
          await runIntents(structuredClone(state), signed, wall);
        } catch (err) {
          unheld(0);
          return { status: 'FAILED', reason: err instanceof Error ? err.message : String(err) };
        }
      }
      switch (script.kind) {
        case 'ok':
          await runRelayed(signed, hashes);
          return { status: 'OK', intentHashes: hashes };
        case 'failed':
          if (script.land) await runRelayed(signed, hashes);
          else unheld(0);
          return { status: 'FAILED', reason: script.reason ?? 'internal' };
        case 'lost':
          if (script.land) await runRelayed(signed, hashes);
          throw new Error('relay publish_intents failed: fetch failed');
        case 'later':
          for (const h of hashes) relayed.set(h, { status: 'PENDING', txHash: null });
          relayLater.push({ at: wall + script.afterMs, signed, hashes });
          return { status: 'OK', intentHashes: hashes };
        case 'dropped':
          unheld(0);
          return { status: 'OK', intentHashes: hashes };
        case 'part':
          await runRelayed(signed.slice(0, script.count), hashes.slice(0, script.count));
          unheld(script.count);
          return { status: 'OK', intentHashes: hashes };
      }
    },
    async status(intentHash): Promise<RelayStatus> {
      calls.push({ method: 'get_status', params: { intent_hash: intentHash } });
      await due();
      const r = relayed.get(intentHash);
      return { intentHash, status: r?.status ?? 'NOT_FOUND_OR_NOT_VALID', statusDetails: null, nearTxHash: r?.txHash ?? null, filledAmounts: [] };
    },
  };

  // The newest final block, a new one when the clock moved since the last.
  function head(): Block {
    const last = blocks.at(-1);
    return last !== undefined && last.atMs >= wall ? last : produce();
  }

  function stateAt(at?: string): ChainState {
    if (faults.reads) throw new Error('the double is not answering');
    if (at === undefined) return state;
    const block = blocks.find((b) => b.hash === at);
    if (block === undefined) throw new Error(`no block ${at}`);
    return block.state;
  }

  async function land(tx: DecodedTx): Promise<void> {
    if (outcomes.has(tx.hash)) return;
    const from = gasAccounts.get(tx.signerId)!;
    from.keyNonce = tx.nonce;
    from.amount -= BURNT_YOCTO + tx.deposit;
    received.set(tx.receiverId, (received.get(tx.receiverId) ?? 0n) + tx.deposit);
    executions += 1;
    const main = `R1${tx.hash.slice(0, 8)}`;
    outcomes.set(tx.hash, {
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      transaction: { hash: tx.hash, signer_id: tx.signerId, receiver_id: tx.receiverId, priority_fee: 0 },
      transaction_outcome: { id: tx.hash, outcome: { executor_id: tx.signerId, gas_burnt: 223182562500, tokens_burnt: '22318256250000000000', logs: [], receipt_ids: [main], status: { SuccessReceiptId: main } } },
      receipts_outcome: [{ id: main, outcome: { executor_id: tx.receiverId, gas_burnt: 223182562500, tokens_burnt: '22318256250000000000', logs: [], receipt_ids: [], status: { SuccessValue: '' } } }],
    });
    produce();
  }

  function from(tx: DecodedTx): Gas {
    return gasAccounts.get(tx.signerId)!;
  }

  function checkTx(tx: DecodedTx): string | null {
    const gas = gasAccounts.get(tx.signerId);
    if (gas === undefined) return 'SignerDoesNotExist';
    if (tx.publicKey.toString('hex') !== tx.signerId) return 'InvalidAccessKeyError';
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, tx.publicKey]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, sha256(tx.body), key, tx.signature)) return 'InvalidSignature';
    if (tx.deposit <= 0n || tx.actions !== 1) return 'ActionsValidation';
    if (!outcomes.has(tx.hash) && from(tx).amount < tx.deposit + BURNT_YOCTO) return 'NotEnoughBalance';
    if (!outcomes.has(tx.hash) && tx.nonce <= gas.keyNonce) return 'InvalidNonce';
    if (!blocks.some((b) => Buffer.from(b.hashBytes).equals(tx.blockHash))) return 'Expired';
    return null;
  }

  async function sendTx(params: Record<string, unknown>): Promise<RpcAnswer> {
    let tx: DecodedTx;
    try {
      tx = decodeSignedTx(Buffer.from(String(params.signed_tx_base64), 'base64'));
    } catch {
      return { body: { jsonrpc: '2.0', id: 'phosphor', error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: {} }, code: -32700, message: 'Parse error', data: 'bad' } } };
    }
    const script = sends.length > 1 ? sends.shift()! : (sends[0] ?? { kind: 'ok' });
    sendCount += 1;
    if (script.kind === 'rate_limited') return { body: { jsonrpc: '2.0', id: 'phosphor', error: { code: -429, message: 'Rate limits exceeded' } } };
    const invalid = checkTx(tx);
    if (invalid !== null) return rpcError('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: invalid } });
    switch (script.kind) {
      case 'ok':
        await land(tx);
        return { body: { jsonrpc: '2.0', id: 'phosphor', result: outcomes.get(tx.hash) } };
      case 'timeout':
        if (script.land) await land(tx);
        return rpcError('TIMEOUT_ERROR', 'Timeout');
      case 'lost':
        if (script.land) await land(tx);
        return 'network';
      case 'invalid':
        if (script.land) await land(tx);
        return rpcError('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: script.variant ?? { ShardCongested: { shard_id: 6, congestion_level: 1 } } } });
      case 'later':
        if (!outcomes.has(tx.hash) && !later.some((l) => l.tx.hash === tx.hash)) later.push({ at: wall + script.afterMs, tx });
        return rpcError('TIMEOUT_ERROR', 'Timeout');
    }
  }

  async function answer(method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
    await due();
    const block = head();
    const at = { block_hash: block.hash, block_height: block.height };
    if (method === 'block') {
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { header: { hash: block.hash, height: block.height, gas_price: GAS_PRICE, timestamp_nanosec: (BigInt(block.atMs) * 1_000_000n).toString() } } } };
    }
    if (method === 'query' && params.request_type === 'view_account') {
      const gas = gasAccounts.get(String(params.account_id));
      if (gas === undefined) return rpcError('UNKNOWN_ACCOUNT', `account ${String(params.account_id)} does not exist while viewing`);
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { amount: gas.amount.toString(), locked: '0', storage_usage: 182, storage_paid_at: 0, code_hash: '11111111111111111111111111111111', ...at } } };
    }
    if (method === 'query' && params.request_type === 'view_access_key') {
      const account = String(params.account_id);
      const gas = gasAccounts.get(account);
      const own = `ed25519:${base58Encode(Buffer.from(account, 'hex'))}`;
      if (gas === undefined || params.public_key !== own) {
        return { body: { jsonrpc: '2.0', id: 'phosphor', result: { ...at, error: `access key ${String(params.public_key)} does not exist while viewing`, logs: [] } } };
      }
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { nonce: Number(gas.keyNonce), permission: 'FullAccess', ...at } } };
    }
    if (method === 'send_tx') return sendTx(params);
    if (method === 'tx') {
      const outcome = outcomes.get(String(params.tx_hash));
      if (outcome !== undefined) return { body: { jsonrpc: '2.0', id: 'phosphor', result: outcome } };
      return params.wait_until === 'NONE' ? rpcError('UNKNOWN_TRANSACTION', "Transaction doesn't exist") : rpcError('TIMEOUT_ERROR', 'Timeout');
    }
    throw new Error(`the double does not answer ${method}`);
  }

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    calls.push({ method, params });
    const reply = await answer(method, params);
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body), { status: reply.http ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const verifier: Required<VerifierPort> = {
    async balance(accountId, assetId, at) {
      await due();
      return stateAt(at).balances.get(accountId.toLowerCase())?.get(assetId) ?? 0n;
    },
    async currentSalt() {
      await due();
      return Uint8Array.from(Buffer.from(stateAt().salts.current, 'hex'));
    },
    async nonceUsed(accountId, nonce, at) {
      await due();
      return stateAt(at).nonces.get(accountId.toLowerCase())?.has(nonce) ?? false;
    },
    async isValidSalt(salt, at) {
      await due();
      return stateAt(at).salts.valid.has(Buffer.from(salt).toString('hex'));
    },
    async finalBlock() {
      await due();
      if (faults.reads) throw new Error('the double is not answering');
      const block = head();
      return { hash: block.hash, atMs: block.atMs };
    },
    async accountLocked() {
      return false;
    },
    async simulate(signed: SignedIntent[], at?: string) {
      await due();
      const base = stateAt(at);
      const atMs = at === undefined ? wall : blocks.find((b) => b.hash === at)!.atMs;
      let sim: Simulation;
      try {
        const run = await runIntents(structuredClone(base), signed as MultiPayload[], atMs);
        sim = simulationOf(
          { intents_executed: run.executed, logs: run.logs, min_deadline: new Date(run.minDeadline).toISOString(), state: { fee: 1, current_salt: base.salts.current } },
          signed.length,
        );
      } catch (err) {
        sim = { ok: false, refusal: err instanceof Panic ? err.message : String(err) };
      }
      return faults.simulate === null ? sim : faults.simulate(sim);
    },
    async hasPublicKey(accountId, publicKey, at) {
      await due();
      return hasKey(stateAt(at), accountId.toLowerCase(), publicKey);
    },
    async publicKeysOf(accountId, at) {
      await due();
      return [...(stateAt(at).keys.get(accountId.toLowerCase()) ?? [])];
    },
    async isAuthByPredecessorIdEnabled(accountId, at) {
      await due();
      return !stateAt(at).predecessorOff.has(accountId.toLowerCase());
    },
    async sourceMetadata() {
      return { version: SPIKED_VERIFIER.version, link: null, codeHash: SPIKED_VERIFIER.codeHash };
    },
  };

  produce();

  return {
    verifier,
    // What src/vault/submit.ts takes as its relay.
    relay,
    publishes,
    publishCount: () => publishCount,
    // What near-tx's transfer and the old fee account's reads take as their RPC.
    near: { fetchImpl, rpcUrl: DOUBLE_RPC, now: () => wall, sleep: async (ms: number) => void (wall += Math.max(0, Math.ceil(ms))) },
    now: () => wall,
    advance(ms: number): void {
      wall += ms;
    },
    sends,
    faults,
    calls,
    sendCount: () => sendCount,
    executions: () => executions,
    fund(account: string, asset: string, amount: bigint): void {
      const held = state.balances.get(account.toLowerCase()) ?? new Map<string, bigint>();
      held.set(asset, (held.get(asset) ?? 0n) + amount);
      state.balances.set(account.toLowerCase(), held);
      produce();
    },
    balanceOf: (account: string, asset: string): bigint => state.balances.get(account.toLowerCase())?.get(asset) ?? 0n,
    addKey(account: string, publicKey: string): void {
      const keys = state.keys.get(account.toLowerCase()) ?? new Set<string>();
      keys.add(publicKey);
      state.keys.set(account.toLowerCase(), keys);
      produce();
    },
    hasKey: (account: string, publicKey: string): boolean => hasKey(state, account.toLowerCase(), publicKey),
    predecessorAuth: (account: string): boolean => !state.predecessorOff.has(account.toLowerCase()),
    // The verifier's salt managers taking a salt out; when it is the current one, a fresh one takes
    // its place first, as a rotation does.
    retireSalt(hex: string): void {
      if (state.salts.current === hex) {
        state.salts.current = crypto.randomBytes(4).toString('hex');
        state.salts.valid.add(state.salts.current);
      }
      state.salts.valid.delete(hex);
      produce();
    },
    fundGas(accountId: string, yocto: bigint): void {
      gasAccounts.set(accountId, { amount: yocto, keyNonce: 151_978_851_747_358n });
      produce();
    },
    gasAmount: (accountId: string): bigint | null => gasAccounts.get(accountId)?.amount ?? null,
    // NEAR a transfer carried to an account the double does not hold, such as a deposit address.
    nearReceived: (accountId: string): bigint => received.get(accountId) ?? 0n,
    // Someone holding the signed intents runs them in a call of their own (they left this Mac).
    async runAsStranger(signed: readonly MultiPayload[]): Promise<{ ok: boolean; panic?: string }> {
      try {
        await runIntents(state, signed, wall);
        executions += 1;
        produce();
        return { ok: true };
      } catch (err) {
        return { ok: false, panic: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
