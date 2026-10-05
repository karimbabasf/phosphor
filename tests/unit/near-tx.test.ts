// The gas account's NEAR transaction (src/chain/near-tx.ts). Three kinds of check:
//
//   1. Published vectors. near-api-js's own test values pin the borsh encoder byte for byte and the
//      signing rule to a published signature. A wrong byte here is a transaction the chain refuses.
//   2. The submit against a fake RPC, one answer at a time: executed, failed, a timeout, a rate
//      limit, a lost reply, and every refusal before anything is signed. The rule under test is
//      that after the bytes leave, nothing is re-signed and only the identical bytes go again.
//   3. One live, read-only test of the RPC shapes, only with NEAR_LIVE=1: npm test never needs the
//      network.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { base58Decode, base58Encode } from '../../src/chain/near.ts';
import {
  EXECUTE_INTENTS_GAS,
  GAS_LOW_YOCTO,
  MAX_PAYLOADS,
  MIN_GAS_PURCHASE_PRICE,
  NearTxError,
  SUBMIT_BUDGET_MS,
  TGAS,
  encodeTransaction,
  gasNeededYocto,
  implicitAccountOf,
  readFinalBlock,
  signTransaction,
  submitExecuteIntents,
  viewAccessKey,
  viewAccount,
} from '../../src/chain/near-tx.ts';
import type { MultiPayload, NearTransaction } from '../../src/chain/near-tx.ts';

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest();
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ---------- published vectors ----------
//
// near-api-js, tag @near-js/transactions@1.3.0, packages/transactions/test/serialize.test.ts, and
// test/unit/transactions/data/transaction1.json at commit 2546c853.

const BLOCK_HASH = '244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM';

// "serialize and sign multi-action tx": all eight V0 actions. The key is the public half of the
// test's published secret, the 32 bytes after test.near in the published bytes.
const A_PUBLIC_KEY = '22skMptHjFWNyuEWY22ftn2AbLPSYpmYwGJRGwpNHbTV';
const A_BYTES =
  '09000000746573742e6e656172000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef80100000000000000030000003132330fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef608000000000103000000010203020300000071717103000000010203e80300000000000040420f00000000000000000000000000037b0000000000000000000000000000000440420f00000000000000000000000000000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef805000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef800000000000000000000030000007a7a7a010000000300000077777706000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef80703000000313233';
const A_HASH = 'Fo3MJ9XzKjnKuDuQKhDAC6fra5H2UWawRejFSEpPNk3Y';

// "serialize and sign transfer tx": a transfer of 1 yocto signed with the test's published secret.
const B_PUBLIC_KEY = 'Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC';
const B_SECRET = 'ed25519:3hoMW1HvnRLSFCLZnvPzWeoGwtdHzke34B2cTHM8rhcbG3TbuLKtShTv3DvyejnXKXKBiV7YPkLeqUHN1ghnqpFv';
const B_SIGNATURE = 'lpqDMyGG7pdV5IOTJVJYBuGJo9LSu0tHYOlEQ+l+HE8i3u7wBZqOlxMQDtpuGRRNp+ig735TmyBwi6HY0CG9AQ==';
const B_SIGNED =
  '09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef601000000030100000000000000000000000000000000969a83332186ee9755e4839325525806e189a3d2d2bb4b4760e94443e97e1c4f22deeef0059a8e9713100eda6e19144da7e8a0ef7e539b20708ba1d8d021bd01';

// transaction1.json: one FunctionCall, an empty signer id, published bytes (a round-trip test).
const C_BYTES =
  '0000000000795cb7b5f57222e742d1759092f0e20071a0cd2bf30e1f681d800e67935e168801000000000000001000000073747564696f2d76776375396534316d4def837b838543990f3380af8e2a3817ddf70fe9960135b2add25a679b2a01ed01000000020a0000006164644d6573736167650b0000007b2274657874223a22227d80841e000000000000000000000000000000000000000000';

test('the multi-action vector: the 316 bytes and the hash near-api-js publishes', () => {
  const key = base58Decode(A_PUBLIC_KEY);
  const tx: NearTransaction = {
    signerId: 'test.near',
    publicKey: key,
    nonce: 1n,
    receiverId: '123',
    blockHash: base58Decode(BLOCK_HASH),
    actions: [
      { type: 'createAccount' },
      { type: 'deployContract', code: Uint8Array.of(1, 2, 3) },
      { type: 'functionCall', methodName: 'qqq', args: Uint8Array.of(1, 2, 3), gas: 1000n, deposit: 1_000_000n },
      { type: 'transfer', deposit: 123n },
      { type: 'stake', stake: 1_000_000n, publicKey: key },
      { type: 'addKey', publicKey: key, nonce: 0n, permission: { type: 'functionCall', allowance: null, receiverId: 'zzz', methodNames: ['www'] } },
      { type: 'deleteKey', publicKey: key },
      { type: 'deleteAccount', beneficiaryId: '123' },
    ],
  };
  const bytes = encodeTransaction(tx);
  assert.equal(bytes.length, 316);
  assert.equal(hex(bytes), A_BYTES);
  assert.equal(base58Encode(sha256(bytes)), A_HASH);
});

test('the signing rule: ed25519 over sha256 of the body gives the published signature and signed bytes', () => {
  const secret = base58Decode(B_SECRET.slice('ed25519:'.length));
  assert.equal(secret.length, 64);
  const seed = secret.subarray(0, 32);
  const tx: NearTransaction = {
    signerId: 'test.near',
    publicKey: base58Decode(B_PUBLIC_KEY),
    nonce: 1n,
    receiverId: 'whatever.near',
    blockHash: base58Decode(BLOCK_HASH),
    actions: [{ type: 'transfer', deposit: 1n }],
  };
  const signed = signTransaction(tx, seed);
  assert.equal(Buffer.from(signed.signature).toString('base64'), B_SIGNATURE);
  assert.equal(hex(signed.bytes), B_SIGNED);
  assert.equal(signed.base64, Buffer.from(B_SIGNED, 'hex').toString('base64'));
  // The hash is the transaction's id: sha256 of the body, which is the signed bytes less 0 and the signature.
  assert.equal(signed.hash, base58Encode(sha256(signed.bytes.subarray(0, signed.bytes.length - 65))));
  // The seed derives the published public key, so the secret's two halves agree.
  assert.equal(implicitAccountOf(seed).publicKey, `ed25519:${B_PUBLIC_KEY}`);
});

test('the one-FunctionCall vector re-encodes byte for byte', () => {
  const tx: NearTransaction = {
    signerId: '',
    publicKey: base58Decode('9AkLDhntwj9cGSwFPr1XtMFwP1aUFCVLNQXaKQZ3kN9m'),
    nonce: 1n,
    receiverId: 'studio-vwcu9e41m',
    blockHash: base58Decode('6FEDkKHW44kiRP7JtDeARhQhz6343rGKeRa2fq47d8qr'),
    actions: [{ type: 'functionCall', methodName: 'addMessage', args: new Uint8Array(Buffer.from('{"text":""}')), gas: 2_000_000n, deposit: 0n }],
  };
  assert.equal(hex(encodeTransaction(tx)), C_BYTES);
});

test('an implicit account is the hex of its ed25519 public key (RFC 8032 test 1)', () => {
  const account = implicitAccountOf(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
  assert.equal(account.accountId, 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(account.publicKey, `ed25519:${base58Encode(Buffer.from(account.accountId, 'hex'))}`);
});

// ---------- the encoder's refusals ----------

function transferTx(over: Partial<NearTransaction> = {}): NearTransaction {
  return {
    signerId: 'a.near',
    publicKey: new Uint8Array(32).fill(1),
    nonce: 1n,
    receiverId: 'b.near',
    blockHash: new Uint8Array(32).fill(2),
    actions: [{ type: 'transfer', deposit: 1n }],
    ...over,
  };
}

test('a string is prefixed with its UTF-8 byte length, not its character count', () => {
  const bytes = encodeTransaction(transferTx({ actions: [{ type: 'functionCall', methodName: 'é!', args: new Uint8Array(), gas: 1n, deposit: 0n }] }));
  assert.ok(hex(bytes).includes('03000000c3a921'), 'two characters, three bytes');
});

test('a value too large or negative for its field is refused, never cut', () => {
  assert.throws(() => encodeTransaction(transferTx({ nonce: 2n ** 64n })), /does not fit in u64/);
  assert.throws(() => encodeTransaction(transferTx({ nonce: -1n })), /does not fit in u64/);
  assert.throws(() => encodeTransaction(transferTx({ actions: [{ type: 'transfer', deposit: 2n ** 128n }] })), /does not fit in u128/);
  assert.equal(encodeTransaction(transferTx({ nonce: 2n ** 64n - 1n })).length, encodeTransaction(transferTx()).length);
});

test('a block hash or a key of the wrong length is refused', () => {
  assert.throws(() => encodeTransaction(transferTx({ blockHash: new Uint8Array(31) })), /expected 32 bytes, got 31/);
  assert.throws(() => encodeTransaction(transferTx({ publicKey: new Uint8Array(33) })), /expected 32 bytes, got 33/);
  assert.throws(() => encodeTransaction(transferTx({ actions: [{ type: 'deleteKey', publicKey: new Uint8Array(64) }] })), /expected 32 bytes, got 64/);
});

test('an action outside the V0 set is refused', () => {
  const tx = transferTx({ actions: [{ type: 'delegate' } as unknown as NearTransaction['actions'][number]] });
  assert.throws(() => encodeTransaction(tx), /no action of type "delegate"/);
});

test('the signature verifies against the key over sha256 of the body, and a wrong seed is refused', () => {
  const seed = new Uint8Array(32).fill(9);
  const account = implicitAccountOf(seed);
  const tx = transferTx({ publicKey: account.publicKeyBytes });
  const signed = signTransaction(tx, seed);
  const body = encodeTransaction(tx);
  assert.deepEqual(Buffer.from(signed.bytes.subarray(0, body.length)), Buffer.from(body));
  assert.equal(signed.bytes[body.length], 0, 'the signature is tagged ed25519');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), account.publicKeyBytes]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, sha256(body), key, signed.signature), 'over the hash');
  assert.ok(!crypto.verify(null, body, key, signed.signature), 'never over the body itself');
  assert.throws(() => signTransaction(tx, new Uint8Array(32).fill(8)), /not the key this transaction names/);
  assert.throws(() => signTransaction(tx, new Uint8Array(31)), /32 bytes/);
});

test('gas: 50 TGas attached and 8 for fees, bought at the NEP-642 floor, plus 0.002 NEAR of storage is 0.06 NEAR; a dearer block raises it', () => {
  assert.equal(EXECUTE_INTENTS_GAS, 50n * TGAS);
  assert.equal(MIN_GAS_PURCHASE_PRICE, 1_000_000_000n);
  assert.equal(GAS_LOW_YOCTO, 6n * 10n ** 22n);
  assert.equal(gasNeededYocto(100_000_000n), GAS_LOW_YOCTO, 'the burn price today sits under the floor');
  assert.equal(gasNeededYocto(2_000_000_000n), 58n * TGAS * 2_000_000_000n + 2n * 10n ** 21n);
});

// ---------- the submit, against a fake RPC ----------

const SEED = new Uint8Array(32).fill(7);
const GAS = implicitAccountOf(SEED);
const AK_NONCE = 151978851747358;
const HEADER = { hash: '9UQGhJRgCL2HauggBvANk2uY2LbaJQnSGM9FjW6rvoRM', height: 218538133, gas_price: '100000000', timestamp_nanosec: '1791140970971750457' };
const HALF_NEAR = '500000000000000000000000';

const ONE: MultiPayload[] = [{ standard: 'erc191', payload: '{"signer_id":"0x00"}', signature: 'secp256k1:sig' }];

// Event lines shaped as intents.near writes them (dip4, the verifier's own version), plus lines
// that are not events and an event from another contract: only intents.near's events come back.
const LOGS = [
  'EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"public_key_added","data":{"intent_hash":"H5kqrmnzGJxhW1YGFWS17ukfPgxBmWYp6xd81FrhhrGx","account_id":"0x29ddfeb866653829534bed7173c7af10ce713c41","public_key":"p256:key"}}',
  'not an event',
  'EVENT_JSON:{"standard":"dip4"',
  'EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"intents_executed","data":[{"intent_hash":"H5kqrmnzGJxhW1YGFWS17ukfPgxBmWYp6xd81FrhhrGx","account_id":"0x29ddfeb866653829534bed7173c7af10ce713c41","nonce":"Vij2xgAlKBKzgNGobK9T3Bi6/V3DUga5ICfeSXspWEY="}]}',
];
const OTHER_LOGS = ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}'];

const GAS_TX = 311464827482n;
const GAS_MAIN = 8705507179296n;
const GAS_REFUND = 223182562500n;

type Call = { method: string; params: Record<string, unknown> };
type Answer = { http?: number; body: unknown } | 'network' | 'timeout';
type Script = Answer | ((params: Record<string, unknown>) => Answer);

const rpcError = (cause: string, data: unknown = 'Server error'): Answer => ({
  body: { jsonrpc: '2.0', id: 'phosphor', error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } },
});
const RATE_LIMITED: Answer = { body: { jsonrpc: '2.0', id: 'phosphor', error: { code: -429, message: 'Rate limits exceeded' } } };
const HTTP_429: Answer = { http: 429, body: { message: 'Too Many Requests' } };
// nearcore answers a tx poll at FINAL on a hash it never saw with TIMEOUT_ERROR, not UNKNOWN_TRANSACTION.
const TIMEOUT_ERROR = rpcError('TIMEOUT_ERROR', 'Timeout');
const UNKNOWN_TRANSACTION = rpcError('UNKNOWN_TRANSACTION', "Transaction doesn't exist");
// INVALID_TRANSACTION carries its variant in data, as nearcore 2.13.4 serializes InvalidTxError.
const invalidTx = (variant: unknown): Answer => rpcError('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: variant } });
const INVALID_SIGNATURE = invalidTx('InvalidSignature');
const TOO_BIG = invalidTx({ TransactionSizeExceeded: { size: 2_000_000, limit: 1_572_864 } });
const PARSE_ERROR: Answer = {
  body: { jsonrpc: '2.0', id: 'phosphor', error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: { error_message: 'bad' } }, code: -32700, message: 'Parse error', data: 'bad' } },
};
const EXPIRED = invalidTx('Expired');
const SIGNER_MISSING = invalidTx({ SignerDoesNotExist: { signer_id: 'gas' } });
const KEY_NOT_FOUND = invalidTx({ InvalidAccessKeyError: { AccessKeyNotFound: { account_id: 'gas', public_key: 'ed25519:key' } } });
const INVALID_NONCE = invalidTx({ InvalidNonce: { tx_nonce: AK_NONCE + 1, ak_nonce: AK_NONCE + 1 } });
const SHARD_CONGESTED = invalidTx({ ShardCongested: { shard_id: 6, congestion_level: 1 } });
const NOT_ENOUGH_BALANCE = invalidTx({ NotEnoughBalance: { signer_id: 'gas', balance: '1', cost: '2' } });
const NOT_ENOUGH_ALLOWANCE = invalidTx({ InvalidAccessKeyError: { NotEnoughAllowance: { account_id: 'gas', public_key: 'ed25519:key', allowance: '1', cost: '2' } } });

// The hash of whatever the call is about: the sent bytes for send_tx, the asked hash for tx.
function hashOf(params: Record<string, unknown>): string {
  if (typeof params.tx_hash === 'string') return params.tx_hash;
  const bytes = Buffer.from(String(params.signed_tx_base64), 'base64');
  return base58Encode(sha256(bytes.subarray(0, bytes.length - 65)));
}

// A FINAL answer shaped as nearcore 2.13.4 returns it (read live 2026-10-04): the transaction
// becomes receipt R1 on intents.near, and R2 is the refund to the signer.
function final(main: Record<string, unknown>, logs: string[] = LOGS, status = 'FINAL') {
  return (params: Record<string, unknown>): Answer => {
    const txHash = hashOf(params);
    return {
      body: {
        jsonrpc: '2.0',
        id: 'phosphor',
        result: {
          final_execution_status: status,
          status: 'Failure' in main ? main : { SuccessValue: '' },
          transaction: { hash: txHash, signer_id: GAS.accountId, receiver_id: 'intents.near', priority_fee: 0 },
          transaction_outcome: {
            id: txHash,
            outcome: { executor_id: GAS.accountId, gas_burnt: Number(GAS_TX), tokens_burnt: '31146482748200000000', logs: [], receipt_ids: ['R1'], status: { SuccessReceiptId: 'R1' } },
          },
          receipts_outcome: [
            { id: 'R1', outcome: { executor_id: 'intents.near', gas_burnt: Number(GAS_MAIN), tokens_burnt: '870550717929600000000', logs: 'Failure' in main ? [] : logs, receipt_ids: ['R2', 'R3'], status: main } },
            { id: 'R3', outcome: { executor_id: 'wrap.near', gas_burnt: 0, tokens_burnt: '0', logs: OTHER_LOGS, receipt_ids: [], status: { SuccessValue: '' } } },
            { id: 'R2', outcome: { executor_id: GAS.accountId, gas_burnt: Number(GAS_REFUND), tokens_burnt: '0', logs: [], receipt_ids: [], status: { SuccessValue: '' } } },
          ],
        },
      },
    };
  };
}
const EXECUTED = final({ SuccessValue: '' });
const NOT_FINAL_YET = final({ SuccessValue: '' }, LOGS, 'EXECUTED_OPTIMISTIC');
const PANICKED = final({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: invalid signature' } } } } });

type ChainOptions = {
  amount?: string;
  gasPrice?: string;
  account?: 'missing';
  accessKey?: 'missing' | { permission: unknown };
  block?: Script[];
  sends?: Script[];
  polls?: Script[];
};

/* The chain double. Each list answers in order and its last entry repeats. Every request must carry
   a deadline, and a transaction that reaches an outcome moves the key's nonce on once, the way the
   chain does. */
function fakeChain(o: ChainOptions = {}) {
  const calls: Call[] = [];
  const landed = new Set<string>();
  let nonce = AK_NONCE;
  const queues = { block: [...(o.block ?? [])], send: [...(o.sends ?? [EXECUTED])], poll: [...(o.polls ?? [TIMEOUT_ERROR])] };
  const next = (list: Script[], params: Record<string, unknown>): Answer => {
    const script = list.length > 1 ? list.shift()! : list[0];
    return typeof script === 'function' ? script(params) : script;
  };
  const answer = (method: string, params: Record<string, unknown>): Answer => {
    if (method === 'block') {
      if (queues.block.length > 0) return next(queues.block, params);
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { header: { ...HEADER, gas_price: o.gasPrice ?? HEADER.gas_price } } } };
    }
    if (method === 'query' && params.request_type === 'view_account') {
      if (o.account === 'missing') return rpcError('UNKNOWN_ACCOUNT', `account ${String(params.account_id)} does not exist while viewing`);
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { amount: o.amount ?? HALF_NEAR, locked: '0', storage_usage: 182, storage_paid_at: 0, code_hash: '11111111111111111111111111111111', block_hash: HEADER.hash, block_height: HEADER.height } } };
    }
    if (method === 'query' && params.request_type === 'view_access_key') {
      if (o.account === 'missing' || o.accessKey === 'missing') {
        return { body: { jsonrpc: '2.0', id: 'phosphor', result: { block_hash: HEADER.hash, block_height: HEADER.height, error: `access key ${String(params.public_key)} does not exist while viewing`, logs: [] } } };
      }
      return { body: { jsonrpc: '2.0', id: 'phosphor', result: { nonce, permission: o.accessKey?.permission ?? 'FullAccess', block_hash: HEADER.hash, block_height: HEADER.height + 2 } } };
    }
    if (method === 'send_tx') {
      const reply = next(queues.send, params);
      const hash = hashOf(params);
      if (typeof reply === 'object' && 'result' in (reply.body as object) && !landed.has(hash)) {
        landed.add(hash);
        nonce += 1;
      }
      return reply;
    }
    if (method === 'tx') return next(queues.poll, params);
    throw new Error(`the double does not answer ${method}`);
  };
  const fetchImpl = (async (_url: string, init: { body: string; signal?: unknown }) => {
    assert.ok(init.signal instanceof AbortSignal, 'every request carries a deadline');
    const { method, params } = JSON.parse(init.body) as Call;
    calls.push({ method, params });
    const reply = answer(method, params);
    if (reply === 'network') throw new TypeError('fetch failed');
    if (reply === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return new Response(JSON.stringify(reply.body), { status: reply.http ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// A clock that moves only when the code under test sleeps. It starts off a whole millisecond, as
// performance.now() does, so every budget sum the code makes is fractional.
function fakeClock() {
  const start = 1000.25;
  let at = start;
  return { now: () => at, sleep: async (ms: number) => void (at += ms), elapsed: () => at - start };
}

const sends = (calls: Call[]) => calls.filter((c) => c.method === 'send_tx').map((c) => String(c.params.signed_tx_base64));
const polls = (calls: Call[]) => calls.filter((c) => c.method === 'tx');

function deps(chain: ReturnType<typeof fakeChain>, clock = fakeClock()) {
  return { fetchImpl: chain.fetchImpl, now: clock.now, sleep: clock.sleep };
}

// Little-endian borsh pieces written with Buffer's own methods, apart from the encoder under test.
function le32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function le64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([le32(b.length), b]);
}

test('executed: one execute_intents call on intents.near, 50 TGas, no deposit, the next nonce, signed by the gas key', async () => {
  const signed: MultiPayload[] = [
    { standard: 'erc191', payload: '{"signer_id":"0x00","intents":[]}', signature: 'secp256k1:one' },
    { standard: 'webauthn', payload: '{"intents":[]}', public_key: 'p256:pk', signature: 'p256:two', client_data_json: '{}', authenticator_data: 'AA' },
  ];
  const chain = fakeChain();
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed }, deps(chain));

  assert.equal(outcome.status, 'executed');
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.gasBurnt, GAS_TX + GAS_MAIN + GAS_REFUND);
  assert.equal(outcome.tokensBurnt, 31146482748200000000n + 870550717929600000000n);
  assert.deepEqual(
    outcome.events.map((e) => [e.standard, e.version, e.event]),
    [['dip4', '0.4.3', 'public_key_added'], ['dip4', '0.4.3', 'intents_executed']],
    'every event intents.near logged, in order, and nothing from another contract',
  );

  const [sent, ...more] = sends(chain.calls);
  assert.equal(more.length, 0, 'one send');
  assert.equal(polls(chain.calls).length, 0, 'nothing to ask after a FINAL answer');
  const args = Buffer.from(JSON.stringify({ signed }), 'utf8');
  const body = Buffer.concat([
    str(GAS.accountId), Buffer.of(0), GAS.publicKeyBytes, le64(BigInt(AK_NONCE) + 1n), str('intents.near'), base58Decode(HEADER.hash),
    le32(1), Buffer.of(2), str('execute_intents'), le32(args.length), args, le64(50n * 10n ** 12n), Buffer.alloc(16),
  ]);
  const bytes = Buffer.from(sent, 'base64');
  assert.deepEqual(bytes.subarray(0, body.length), body, 'the body, written here with Buffer alone');
  assert.equal(bytes.length, body.length + 65);
  assert.equal(bytes[body.length], 0);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), GAS.publicKeyBytes]);
  assert.ok(crypto.verify(null, sha256(body), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), bytes.subarray(body.length + 1)));
  assert.equal(outcome.txHash, base58Encode(sha256(body)));

  const send = chain.calls.find((c) => c.method === 'send_tx');
  assert.equal(send?.params.wait_until, 'FINAL');
  const keyRead = chain.calls.find((c) => c.params.request_type === 'view_access_key');
  assert.deepEqual(keyRead?.params, { request_type: 'view_access_key', finality: 'optimistic', account_id: GAS.accountId, public_key: GAS.publicKey });
});

test('failed: the verifier refused the intents, so nothing ran, and its words are the reason', async () => {
  const chain = fakeChain({ sends: [PANICKED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason ?? '', /the verifier refused the intents: Smart contract panicked: invalid signature/);
  assert.equal(outcome.gasBurnt, GAS_TX + GAS_MAIN + GAS_REFUND, 'the gas burnt is still read');
  assert.deepEqual(outcome.events, []);
  assert.equal(sends(chain.calls).length, 1);
});

test('failed: bytes every node refuses on their own (a bad signature, an oversize transaction, unparsable bytes) are not sent again', async () => {
  for (const [refusal, words] of [[INVALID_SIGNATURE, /INVALID_TRANSACTION .*InvalidSignature/], [TOO_BIG, /INVALID_TRANSACTION .*TransactionSizeExceeded/], [PARSE_ERROR, /PARSE_ERROR/]] as const) {
    const chain = fakeChain({ sends: [refusal] });
    const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /the chain refused the transaction: /);
    assert.match(outcome.reason ?? '', words);
    assert.equal(outcome.gasBurnt, null);
    assert.equal(sends(chain.calls).length, 1);
    assert.equal(polls(chain.calls).length, 0);
  }
});

test('a refusal that depends on one node\'s view of the chain is never failed: the identical bytes go again', async () => {
  // Congestion, balance and allowance, a nonce, and what a node behind the chain says: Expired for a
  // block it has not seen, SignerDoesNotExist or AccessKeyNotFound for an account it has not seen.
  for (const refusal of [SHARD_CONGESTED, NOT_ENOUGH_BALANCE, NOT_ENOUGH_ALLOWANCE, INVALID_NONCE, EXPIRED, SIGNER_MISSING, KEY_NOT_FOUND]) {
    const lifted = fakeChain({ sends: [refusal, EXECUTED] });
    const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(lifted));
    assert.equal(outcome.status, 'executed');
    assert.equal(sends(lifted.calls).length, 2);
    assert.equal(new Set(sends(lifted.calls)).size, 1);

    const stuck = fakeChain({ sends: [refusal] });
    const end = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(stuck));
    assert.equal(end.status, 'unknown', 'refused to the end of the budget is still unknown');
    assert.match(end.reason ?? '', /INVALID_TRANSACTION/);
  }
});

test('unknown: a timeout sends the identical bytes again until the budget runs out, never a new signature and never past the budget', async () => {
  const clock = fakeClock();
  const chain = fakeChain({ sends: [TIMEOUT_ERROR] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain, clock));
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.gasBurnt, null);
  assert.match(outcome.reason ?? '', /TIMEOUT_ERROR/);
  const sent = sends(chain.calls);
  assert.ok(sent.length >= 3, `${sent.length} sends`);
  assert.equal(new Set(sent).size, 1, 'every send carried the identical bytes');
  assert.equal(outcome.txHash, hashOf({ signed_tx_base64: sent[0] }));
  assert.ok(Math.abs(clock.elapsed() - SUBMIT_BUDGET_MS) < 1e-6, `the last pause stops at the budget (${clock.elapsed()} ms)`);
});

test('on the real clock a send really leaves: every request deadline is a whole number of milliseconds', async () => {
  // performance.now() is fractional, and AbortSignal.timeout refuses a fractional delay: a deadline
  // computed from it unrounded threw before the request was made, on every send.
  const chain = fakeChain();
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, { fetchImpl: chain.fetchImpl, budgetMs: 3000 });
  assert.equal(outcome.status, 'executed', outcome.reason ?? '');
  assert.equal(sends(chain.calls).length, 1);
});

test('reads that take half the budget refuse before anything is signed', async () => {
  const chain = fakeChain({ block: [RATE_LIMITED, RATE_LIMITED, { body: { jsonrpc: '2.0', id: 'phosphor', result: { header: HEADER } } }] });
  const clock = fakeClock();
  await assert.rejects(
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, { ...deps(chain, clock), budgetMs: 4000 }),
    (err: unknown) => err instanceof NearTxError && err.code === 'rpc_unavailable' && /nothing was signed/.test(err.message),
  );
  assert.equal(chain.calls.filter((c) => c.method === 'block').length, 3, 'the block read answered on its third try');
  assert.equal(sends(chain.calls).length, 0);
});

test('a timeout, then the identical bytes again: send_tx answers the transaction it already took with its FINAL outcome', async () => {
  const chain = fakeChain({ sends: [TIMEOUT_ERROR, EXECUTED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'executed');
  assert.equal(sends(chain.calls).length, 2);
  assert.equal(new Set(sends(chain.calls)).size, 1);
});

test('a lost reply (the fetch itself failed or timed out) is never failed: the identical bytes go again', async () => {
  for (const lost of ['network', 'timeout'] as const) {
    const chain = fakeChain({ sends: [lost, EXECUTED] });
    const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
    assert.equal(outcome.status, 'executed', lost);
    assert.equal(new Set(sends(chain.calls)).size, 1, lost);
  }
});

test('an answer short of FINAL is asked for by hash, and a poll that times out sends the identical bytes again', async () => {
  const chain = fakeChain({ sends: [NOT_FINAL_YET, EXECUTED], polls: [TIMEOUT_ERROR] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'executed');
  assert.deepEqual(chain.calls.filter((c) => c.method === 'send_tx' || c.method === 'tx').map((c) => c.method), ['send_tx', 'tx', 'send_tx']);
  const [poll] = polls(chain.calls);
  assert.deepEqual(poll.params, { tx_hash: outcome.txHash, sender_account_id: GAS.accountId, wait_until: 'FINAL' });
  assert.equal(new Set(sends(chain.calls)).size, 1);
});

test('a rate-limited poll is asked again as a poll', async () => {
  const chain = fakeChain({ sends: [NOT_FINAL_YET], polls: [RATE_LIMITED, EXECUTED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'executed');
  assert.deepEqual(chain.calls.filter((c) => c.method === 'send_tx' || c.method === 'tx').map((c) => c.method), ['send_tx', 'tx', 'tx']);
});

test('bytes refused after an earlier copy may have landed are asked for by hash: the earlier copy ran', async () => {
  const chain = fakeChain({ sends: [TIMEOUT_ERROR, INVALID_SIGNATURE], polls: [EXECUTED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'executed');
  assert.deepEqual(chain.calls.filter((c) => c.method === 'send_tx' || c.method === 'tx').map((c) => c.method), ['send_tx', 'send_tx', 'tx']);
  assert.equal(new Set(sends(chain.calls)).size, 1);
});

test('-429 and HTTP 429: not taken, so the identical bytes go again after a pause', async () => {
  const clock = fakeClock();
  const chain = fakeChain({ sends: [RATE_LIMITED, HTTP_429, EXECUTED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain, clock));
  assert.equal(outcome.status, 'executed');
  const sent = sends(chain.calls);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 1);
  assert.equal(polls(chain.calls).length, 0, 'a rate limit is an answer: nothing to ask about');
  assert.equal(clock.elapsed(), 1000 + 2000);
});

test('an error the RPC does not explain (internal, routed, not even an object) may hide a copy: never failed', async () => {
  for (const odd of [rpcError('INTERNAL_ERROR'), rpcError('REQUEST_ROUTED'), UNKNOWN_TRANSACTION, { body: { jsonrpc: '2.0', id: 'phosphor', error: 'boom' } }]) {
    const chain = fakeChain({ sends: [odd] });
    const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
    assert.equal(outcome.status, 'unknown');
    assert.ok(sends(chain.calls).length >= 2);
    assert.equal(new Set(sends(chain.calls)).size, 1);
  }
});

test('rate-limited to the end of the budget is unknown, never failed', async () => {
  const chain = fakeChain({ sends: [RATE_LIMITED] });
  const outcome = await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain));
  assert.equal(outcome.status, 'unknown');
  assert.match(outcome.reason ?? '', /rate-limited/);
  assert.equal(new Set(sends(chain.calls)).size, 1);
});

test('gas_low: under 0.06 NEAR nothing is signed or sent, and exactly 0.06 is enough', async () => {
  const low = fakeChain({ amount: '59999999999999999999999' });
  await assert.rejects(
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(low)),
    (err: unknown) => err instanceof NearTxError && err.code === 'gas_low' && /holds 0\.059999 NEAR and a submit needs 0\.06 NEAR/.test(err.message),
  );
  assert.equal(sends(low.calls).length, 0);

  const enough = fakeChain({ amount: '60000000000000000000000' });
  assert.equal((await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(enough))).status, 'executed');
});

test('gas_low follows the block gas price once it passes the purchase floor', async () => {
  const chain = fakeChain({ amount: '100000000000000000000000', gasPrice: '2000000000' });
  await assert.rejects(
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
    (err: unknown) => err instanceof NearTxError && err.code === 'gas_low' && /needs 0\.118 NEAR: 58 TGas bought upfront/.test(err.message),
  );
  assert.equal(sends(chain.calls).length, 0);
});

test('no account yet: view_access_key says the key does not exist, and view_account tells why', async () => {
  const chain = fakeChain({ account: 'missing' });
  await assert.rejects(
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
    (err: unknown) => err instanceof NearTxError && err.code === 'gas_unfunded',
  );
  assert.equal(sends(chain.calls).length, 0);
});

test('an account without this key, or with a key that cannot call execute_intents, is refused', async () => {
  for (const accessKey of ['missing', { permission: { FunctionCall: { allowance: null, receiver_id: 'wrap.near', method_names: [] } } }] as const) {
    const chain = fakeChain({ accessKey });
    await assert.rejects(
      submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
      (err: unknown) => err instanceof NearTxError && err.code === 'gas_key_missing',
    );
    assert.equal(sends(chain.calls).length, 0);
  }
  const callKey = fakeChain({ accessKey: { permission: { FunctionCall: { allowance: '250000000000000000000000', receiver_id: 'intents.near', method_names: ['execute_intents'] } } } });
  assert.equal((await submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(callKey))).status, 'executed');
});

test('a read the RPC will not answer refuses before signing, after three tries', async () => {
  const chain = fakeChain({ block: [RATE_LIMITED] });
  await assert.rejects(
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
    (err: unknown) => err instanceof NearTxError && err.code === 'rpc_unavailable' && /NEAR block did not answer: rate limited/.test(err.message),
  );
  assert.equal(chain.calls.filter((c) => c.method === 'block').length, 3);
  assert.equal(sends(chain.calls).length, 0);
});

test('bad input is refused before any request', async () => {
  const chain = fakeChain();
  const cases: unknown[] = [
    [],
    Array.from({ length: MAX_PAYLOADS + 1 }, () => ONE[0]),
    [{ standard: 'erc191', payload: 'x', signature: 5 }],
    [{ standard: 'erc191', payload: 'x' }],
    [new (class { standard = 'erc191'; payload = 'x'; signature = 'y'; })()],
    'not a list',
  ];
  for (const signed of cases) {
    await assert.rejects(
      submitExecuteIntents({ gasSeed: SEED, signed: signed as MultiPayload[] }, deps(chain)),
      (err: unknown) => err instanceof NearTxError && err.code === 'invalid_request',
      JSON.stringify(signed),
    );
  }
  await assert.rejects(
    submitExecuteIntents({ gasSeed: new Uint8Array(31), signed: ONE }, deps(chain)),
    (err: unknown) => err instanceof NearTxError && err.code === 'invalid_request',
  );
  assert.equal(chain.calls.length, 0);
});

test('two submits from one gas account run one after the other, each on the nonce the last one left', async () => {
  const chain = fakeChain();
  const [a, b] = await Promise.all([
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
    submitExecuteIntents({ gasSeed: SEED, signed: ONE }, deps(chain)),
  ]);
  assert.equal(a.status, 'executed');
  assert.equal(b.status, 'executed');
  assert.deepEqual(chain.calls.map((c) => c.method), ['block', 'query', 'query', 'send_tx', 'block', 'query', 'query', 'send_tx']);
  // The nonce sits after the signer id (4 + 64 bytes) and the key (1 + 32).
  const nonces = sends(chain.calls).map((s) => Buffer.from(s, 'base64').readBigUInt64LE(101));
  assert.deepEqual(nonces, [BigInt(AK_NONCE) + 1n, BigInt(AK_NONCE) + 2n]);
});

// ---------- live, read-only ----------

test(
  'live, read-only: the final block, an existing access key, and a missing account read as missing',
  { skip: process.env.NEAR_LIVE === '1' ? false : 'set NEAR_LIVE=1 to read the live NEAR RPC' },
  async () => {
    const block = await readFinalBlock();
    assert.equal(block.hashBytes.length, 32);
    assert.ok(block.height > 218_000_000, `height ${block.height}`);
    assert.ok(block.gasPrice > 0n && Date.now() - block.timestampMs < 120_000, `gas price ${block.gasPrice}, ${Date.now() - block.timestampMs} ms old`);

    // A key intents.near holds today, read here so the test does not depend on one key staying.
    const list = await fetch('https://free.rpc.fastnear.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'live', method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: 'intents.near' } }),
      signal: AbortSignal.timeout(10_000),
    });
    const keys = ((await list.json()) as { result: { keys: { public_key: string }[] } }).result.keys;
    const existing = await viewAccessKey('intents.near', keys[0].public_key);
    assert.equal(existing.found, true);
    if (existing.found) assert.ok(existing.nonce > 0n && existing.blockHeight >= block.height - 5, `nonce ${existing.nonce}`);

    const fresh = implicitAccountOf(crypto.randomBytes(32));
    assert.deepEqual(await viewAccessKey(fresh.accountId, fresh.publicKey), { found: false });
    assert.deepEqual(await viewAccount(fresh.accountId), { found: false });
    const verifier = await viewAccount('intents.near');
    assert.ok(verifier.found && verifier.amount > 0n);

    // The price the gas floor rests on: still NEP-642's 0.001 NEAR per TGas.
    const cfg = await fetch('https://free.rpc.fastnear.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'live', method: 'EXPERIMENTAL_protocol_config', params: { finality: 'final' } }),
      signal: AbortSignal.timeout(10_000),
    });
    const config = ((await cfg.json()) as { result: { runtime_config: { min_gas_purchase_price: string } } }).result;
    assert.equal(BigInt(config.runtime_config.min_gas_purchase_price), MIN_GAS_PURCHASE_PRICE);
  },
);
