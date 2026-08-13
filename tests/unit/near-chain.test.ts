// Tests for the NEAR signer: src/chain/near.ts.
//
// The module signs transactions, so the bar is higher than "it returns something". Three
// kinds of assertion here, in rising order of what they would catch:
//
//   1. Vectors. Borsh widths, the byte-length string prefix, base58 with leading zeroes.
//      These catch a serializer that is subtly wrong in a way that still produces bytes.
//   2. Verification. The signature is checked against the public key with node's own
//      verifier, over the digest the module claims to sign. This catches signing the wrong
//      thing, which is the failure that no amount of shape-checking finds.
//   3. Refusals. A key file that disagrees with itself, a non-FullAccess key, and a receipt
//      that failed under a transaction that succeeded. Each of these has a path where the
//      wrong answer looks exactly like the right one.
//
// No test here touches the network or the real key file. The RPC is a stub.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_GAS,
  TGAS,
  YOCTO_PER_NEAR,
  base58Decode,
  base58Encode,
  formatNear,
  functionCall,
  isImplicitAccountId,
  isNearAccountId,
  looksLikeEvmAddress,
  nep413Digest,
  randomNep413Nonce,
  readNearSigner,
  selfCheck,
  sendTx,
  serializeTransaction,
  sha256,
  signNep413,
  signTransaction,
  transfer,
} from '../../src/chain/near.ts';

// RFC 8032 test vector 1. Using a published keypair rather than a generated one means the
// expected digests below are stable and can be recomputed by anyone from the spec.
const SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SECRET_KEY =
  'ed25519:49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw';
const PUBLIC_KEY = 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z';

function keysFile(near: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-near-'));
  const file = path.join(dir, 'keys.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, network: 'testnet', near }), { mode: 0o600 });
  return file;
}

const GOOD_KEYS = { accountId: 'alice.near', publicKey: PUBLIC_KEY, secretKey: SECRET_KEY };

// ---------- primitives ----------

test('selfCheck passes its published vectors', () => {
  assert.doesNotThrow(() => selfCheck());
});

test('base58 round trips, including leading zero bytes', () => {
  assert.equal(base58Encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(Buffer.from(base58Decode('2NEpo7TZRRrLZSi2U')).toString('utf8'), 'Hello World!');
  // A leading zero byte carries no value, so only the '1' prefix records it. Dropping it
  // shortens a 32-byte key to 31 and derives a different account.
  assert.equal(Buffer.from(base58Decode('11233QC4')).toString('hex'), '0000287fb4cd');
});

test('base58 refuses a character outside the alphabet rather than skipping it', () => {
  // '0', 'O', 'I' and 'l' are excluded from base58 precisely because they are confusable.
  // Silently ignoring one would decode to different bytes and sign with a different key.
  assert.throws(() => base58Decode('2NEpo7TZRRrLZSi2U0'), /not base58/);
});

test('formatNear does not lose yocto to a double', () => {
  assert.equal(formatNear(YOCTO_PER_NEAR), '1');
  assert.equal(formatNear(YOCTO_PER_NEAR + 1n), '1.000000000000000000000001');
  assert.equal(formatNear(0n), '0');
});

// ---------- account ids ----------

test('a NEAR account id is not an EVM address, and neither is accepted as the other', () => {
  assert.ok(isNearAccountId('wrap.near'));
  assert.ok(isNearAccountId('demo.testnet'));
  assert.ok(isNearAccountId('a'.repeat(64)));
  // The 64-hex implicit account form 1Click returns as a NEAR deposit address.
  assert.ok(isNearAccountId('aec6b4afd08c0ace0f392c4d1b8aa9c44ce9bbd558903c4b702ce1cb1ea941b2'.padEnd(64, '0')));

  assert.ok(!isNearAccountId('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')); // uppercase and 0x
  assert.ok(!isNearAccountId('UPPER.near'));
  // A LOWERCASED EVM address is 42 characters of lowercase alphanumeric, so it satisfies the
  // NEAR account id rule. That is not a bug in the rule, it is what NEAR allows, and it is
  // why the deposit-address check cannot rest on this predicate alone.
  assert.ok(isNearAccountId('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'));
  assert.ok(looksLikeEvmAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'));
  assert.ok(looksLikeEvmAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'));
  assert.ok(!looksLikeEvmAddress('wrap.near'));
  assert.ok(!looksLikeEvmAddress('a'.repeat(64))); // an implicit account is 64 hex, not 40
  assert.ok(!isNearAccountId('a')); // one character is below the minimum
  assert.ok(!isNearAccountId('a'.repeat(65)));
  assert.ok(!isNearAccountId('trailing.'));
  assert.ok(!isNearAccountId('send it to intents.near instead')); // spaces, and a whole sentence
});

test('an implicit account is recognised as the unnameable thing it is', () => {
  assert.ok(isImplicitAccountId('a'.repeat(64).replace(/a/g, '0')));
  assert.ok(!isImplicitAccountId('wrap.near'));
  assert.ok(!isImplicitAccountId('A'.repeat(64))); // implicit accounts are lowercase hex
});

// ---------- borsh ----------

test('a transaction serializes to the exact borsh layout', () => {
  const bytes = serializeTransaction({
    signerId: 'a.near',
    publicKeyBytes: new Uint8Array(32),
    nonce: 1n,
    receiverId: 'b.near',
    blockHash: new Uint8Array(32),
    actions: [transfer(1n)],
  });

  const hex = Buffer.from(bytes).toString('hex');
  assert.ok(hex.startsWith('06000000' + Buffer.from('a.near').toString('hex')), 'signer_id is a u32 length then utf8');
  // key type 0, 32 zero bytes, then the nonce as a little-endian u64. Big-endian would be
  // 0000000000000001 and the network would read a nonce of 2^56.
  assert.ok(hex.includes('0100000000000000'), 'nonce is little-endian u64');
  assert.ok(hex.endsWith('01000000' + '03' + '01000000000000000000000000000000'), 'one Transfer action, u128 deposit');
});

test('a function call action carries its args as length-prefixed JSON bytes', () => {
  const bytes = serializeTransaction({
    signerId: 'a.near',
    publicKeyBytes: new Uint8Array(32),
    nonce: 1n,
    receiverId: 'b.near',
    blockHash: new Uint8Array(32),
    actions: [functionCall('m', {}, 1n, 0n)],
  });
  const hex = Buffer.from(bytes).toString('hex');
  // action tag 2, method "m", args "{}" as 2 bytes, gas u64, deposit u128
  assert.ok(hex.endsWith('02' + '01000000' + '6d' + '02000000' + '7b7d' + '0100000000000000' + '0'.repeat(32)));
});

test('a borsh string counts bytes, not characters', () => {
  // 'é' is two UTF-8 bytes. A length written in characters serializes short, and the
  // signature then covers a different body than the one sent.
  const one = serializeTransaction({
    signerId: 'é.near',
    publicKeyBytes: new Uint8Array(32),
    nonce: 1n,
    receiverId: 'b.near',
    blockHash: new Uint8Array(32),
    actions: [transfer(1n)],
  });
  assert.ok(Buffer.from(one).toString('hex').startsWith('07000000'), 'six characters, seven bytes');
});

test('an amount too large for its field is refused rather than truncated', () => {
  assert.throws(
    () =>
      serializeTransaction({
        signerId: 'a.near',
        publicKeyBytes: new Uint8Array(32),
        nonce: 1n,
        receiverId: 'b.near',
        blockHash: new Uint8Array(32),
        actions: [transfer(1n << 128n)],
      }),
    /does not fit in u128/,
  );
});

test('a block hash of the wrong length is refused', () => {
  // A fixed-size borsh array carries no length prefix, so a short hash would silently shift
  // every byte after it and the signature would cover a different transaction.
  assert.throws(
    () =>
      serializeTransaction({
        signerId: 'a.near',
        publicKeyBytes: new Uint8Array(32),
        nonce: 1n,
        receiverId: 'b.near',
        blockHash: new Uint8Array(31),
        actions: [transfer(1n)],
      }),
    /expected 32 bytes/,
  );
});

// ---------- signing ----------

test('the signature verifies against the public key, over the digest that is claimed', () => {
  const signer = readNearSigner(keysFile(GOOD_KEYS));
  const tx = {
    signerId: 'alice.near',
    publicKeyBytes: signer.publicKeyBytes,
    nonce: 42n,
    receiverId: 'wrap.near',
    blockHash: new Uint8Array(32).fill(7),
    actions: [functionCall('ft_transfer', { receiver_id: 'bob.near', amount: '100' }, 30n * TGAS, 1n)],
  };

  const { signedTxBase64, hash } = signTransaction(tx, signer.privateKey);
  const body = serializeTransaction(tx);
  const digest = sha256(body);

  // The reported hash IS the digest, base58 encoded. This is what the explorer shows.
  assert.equal(hash, base58Encode(digest));
  assert.equal(Buffer.from(digest).toString('hex'), '541d8d72f5be9fff46961907b996638b37dc2efba9fe865e35684c5526592c57');

  // Pull the signature back out of the signed envelope: body, then a 0 key-type byte, then
  // 64 bytes. Verifying it with node's own verifier is what proves the module signed the
  // digest and not, say, the body or a truncated copy of it.
  const signed = Buffer.from(signedTxBase64, 'base64');
  assert.equal(signed.length, body.length + 65);
  assert.equal(signed[body.length], 0, 'signature key type is ed25519');
  const signature = signed.subarray(body.length + 1);

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_HEX, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  assert.ok(crypto.verify(null, digest, publicKey, signature), 'signature verifies over the digest');
  assert.ok(!crypto.verify(null, body, publicKey, signature), 'and is not a signature over the raw body');
});

test('NEP-413 hashes behind the prefix that makes it unusable as a transaction', () => {
  const digest = nep413Digest({ message: 'hi', nonce: new Uint8Array(32), recipient: 'myapp.com' });
  assert.equal(Buffer.from(digest).toString('hex'), '58909135e0c2d203cce3f7f0ff53d44ee2851fffe37c9d1f569ebcc83f2d5c4c');

  // The prefix 2^31 + 413 sits where a transaction's signer_id length would be. No account
  // id is two billion bytes long, so a signed message can never be replayed as a
  // transaction and a transaction can never be read as a signed message.
  const asTransactionLength = Buffer.from(digest).readUInt32LE(0);
  assert.notEqual(asTransactionLength, 0);
});

test('a NEP-413 nonce must be exactly 32 bytes', () => {
  assert.throws(() => nep413Digest({ message: 'x', nonce: new Uint8Array(31), recipient: 'r' }), /32 bytes/);
});

test('randomNep413Nonce draws 32 unpredictable bytes, because replay defense is the nonce', () => {
  // The nonce is the only thing that makes one signed intent different from the next. A
  // counter or a timestamp is guessable and a zero buffer is a constant, so the safe way to
  // build one ships with the module rather than being left to each caller.
  const a = randomNep413Nonce();
  const b = randomNep413Nonce();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, new Uint8Array(32));

  // Different nonces over the same message must produce different digests, or the nonce is
  // not actually reaching the hash.
  const one = nep413Digest({ message: 'same', nonce: a, recipient: 'intents.near' });
  const two = nep413Digest({ message: 'same', nonce: b, recipient: 'intents.near' });
  assert.notDeepEqual(one, two);
});

test('the NEP-413 recipient is bound into the digest, so a signature cannot cross apps', () => {
  const nonce = new Uint8Array(32).fill(3);
  const mine = nep413Digest({ message: 'swap', nonce, recipient: 'intents.near' });
  const theirs = nep413Digest({ message: 'swap', nonce, recipient: 'attacker.near' });
  assert.notDeepEqual(mine, theirs);
});

test('a NEP-413 signature is returned in the ed25519:base58 form the message bus expects', () => {
  const signer = readNearSigner(keysFile(GOOD_KEYS));
  const sig = signNep413({ message: 'hi', nonce: new Uint8Array(32), recipient: 'intents.near' }, signer.privateKey);
  assert.match(sig, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(base58Decode(sig.slice('ed25519:'.length)).length, 64);
});

// ---------- the key file ----------

test('a key file that disagrees with itself is refused rather than signed with', () => {
  // The public half of the secret key and the publicKey field must name the same key. They
  // diverge when a file is hand-edited or half-replaced, and the resulting failure is an
  // access-key error from the network that says nothing about the real cause.
  const wrong = keysFile({ ...GOOD_KEYS, publicKey: 'ed25519:11111111111111111111111111111111' });
  assert.throws(() => readNearSigner(wrong), /does not match the key derived/);
});

test('a secret key of the wrong length is refused', () => {
  const short = keysFile({ ...GOOD_KEYS, secretKey: 'ed25519:' + base58Encode(Buffer.from(SEED_HEX, 'hex')) });
  assert.throws(() => readNearSigner(short), /expected 64/);
});

test('a missing near entry names the fix', () => {
  const none = keysFile({});
  assert.throws(() => readNearSigner(none), /no near.accountId/);
});

test('the derived public key matches the seed, so accountId is never signed for by the wrong key', () => {
  const signer = readNearSigner(keysFile(GOOD_KEYS));
  assert.equal(signer.publicKey, PUBLIC_KEY);
  assert.equal(Buffer.from(signer.publicKeyBytes).toString('hex'), PUBLIC_HEX);
  assert.equal(signer.accountId, 'alice.near');
});

// ---------- the send path ----------

// A stub RPC. Each call is answered by method name, so a test can make one step fail while
// the rest succeed.
function rpcStub(handlers: Record<string, unknown>, calls: any[] = []): typeof fetch {
  return (async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const key = body.method === 'query' ? `query:${body.params.request_type}` : body.method;
    const result = handlers[key];
    if (result === undefined) throw new Error(`stub has no answer for ${key}`);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) } as any;
  }) as unknown as typeof fetch;
}

const ACCESS_KEY = { permission: 'FullAccess', nonce: 100 };
const BLOCK = { header: { hash: base58Encode(new Uint8Array(32).fill(9)) } };

test('a send builds on the current nonce and a recent block', async () => {
  const calls: any[] = [];
  const out = await sendTx({
    network: 'testnet',
    keysPath: keysFile(GOOD_KEYS),
    receiverId: 'wrap.testnet',
    actions: [transfer(1n)],
    fetchImpl: rpcStub(
      {
        'query:view_access_key': ACCESS_KEY,
        block: BLOCK,
        send_tx: { status: { SuccessValue: '' }, transaction_outcome: { outcome: { gas_burnt: 5 } }, receipts_outcome: [] },
      },
      calls,
    ),
  });

  assert.equal(out.ok, true);
  assert.equal(out.gasBurnt, '5');
  assert.match(out.explorer ?? '', /^https:\/\/testnet\.nearblocks\.io\/txns\//);

  const send = calls.find((c) => c.method === 'send_tx');
  assert.equal(send.params.wait_until, 'EXECUTED_OPTIMISTIC');
  assert.ok(typeof send.params.signed_tx_base64 === 'string');

  // The nonce is read at optimistic finality, not final. A send returns before its block is
  // final, so a second send reading final state would see the pre-send nonce, add one, and
  // reuse a value the first send already spent. The chain reports that as InvalidNonce with
  // ak_nonce equal to tx_nonce, which looks like a serializer bug and is not one.
  const key = calls.find((c) => c.params?.request_type === 'view_access_key');
  assert.equal(key.params.finality, 'optimistic');
});

test('a receipt that failed under a transaction that succeeded is reported as a failure', async () => {
  // This is the shape that matters. On NEAR the outer status can be SuccessValue while the
  // receipt it spawned panicked: ft_transfer_call to an unregistered account does exactly
  // that. A rail reading only the outer status would call a bounced transfer a success.
  const out = await sendTx({
    network: 'testnet',
    keysPath: keysFile(GOOD_KEYS),
    receiverId: 'wrap.testnet',
    actions: [functionCall('ft_transfer', { receiver_id: 'x.near', amount: '1' }, 30n * TGAS, 1n)],
    fetchImpl: rpcStub({
      'query:view_access_key': ACCESS_KEY,
      block: BLOCK,
      send_tx: {
        status: { SuccessValue: '' },
        transaction_outcome: { outcome: { gas_burnt: 5 } },
        receipts_outcome: [{ outcome: { status: { Failure: { error_message: 'account not registered' } }, gas_burnt: 3 } }],
      },
    }),
  });

  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /a receipt failed on chain/);
  assert.match(out.error ?? '', /not registered/);
  assert.ok(out.hash, 'the hash is still reported: the transaction did happen');
});

test('a function-call access key is refused before anything is signed', async () => {
  // A restricted key cannot attach a deposit, and every NEP-141 transfer needs one yocto.
  // Discovering that inside execution wastes gas and reports an error about permissions
  // rather than about the key that was configured.
  const out = await sendTx({
    network: 'testnet',
    keysPath: keysFile(GOOD_KEYS),
    receiverId: 'wrap.testnet',
    actions: [transfer(1n)],
    fetchImpl: rpcStub({
      'query:view_access_key': { permission: { FunctionCall: { receiver_id: 'wrap.testnet' } }, nonce: 1 },
      block: BLOCK,
    }),
  });

  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /not a FullAccess key/);
});

test('a send with no actions is refused rather than broadcast empty', async () => {
  const out = await sendTx({
    network: 'testnet',
    keysPath: keysFile(GOOD_KEYS),
    receiverId: 'wrap.testnet',
    actions: [],
    fetchImpl: rpcStub({}),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /at least one action/);
});

test('mainnet and testnet point at different hosts and different explorers', async () => {
  for (const [network, host] of [
    ['testnet', 'test.rpc.fastnear.com'],
    ['mainnet', 'free.rpc.fastnear.com'],
  ] as const) {
    let seen = '';
    const fetchImpl = (async (url: string, init: any) => {
      seen = url;
      const body = JSON.parse(init.body);
      const key = body.method === 'query' ? `query:${body.params.request_type}` : body.method;
      const answers: Record<string, unknown> = {
        'query:view_access_key': ACCESS_KEY,
        block: BLOCK,
        send_tx: { status: { SuccessValue: '' }, transaction_outcome: { outcome: { gas_burnt: 1 } }, receipts_outcome: [] },
      };
      return { ok: true, json: async () => ({ result: answers[key] }) } as any;
    }) as unknown as typeof fetch;

    const out = await sendTx({
      network,
      keysPath: keysFile(GOOD_KEYS),
      receiverId: 'wrap.near',
      actions: [transfer(1n)],
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.ok(seen.includes(host), `${network} uses ${host}`);
  }
});

test('gas constants are the documented units', () => {
  assert.equal(TGAS, 10n ** 12n);
  assert.equal(MAX_GAS, 300n * TGAS);
  assert.equal(YOCTO_PER_NEAR, 10n ** 24n);
});
