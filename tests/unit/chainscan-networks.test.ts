// The shapes a chain lookup accepts, and the links it builds only from a value that passed.
// Refusals are the point: a repaired address is an address nobody typed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAIN_NETWORKS, HOSTS, NETWORKS, explorerAddressUrl, explorerTxUrl, isChainNetwork, validateAddress, validateHash } from '../../src/chainscan/networks.ts';

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('the network enum is closed and every network names one host on the allowlist', () => {
  assert.deepEqual([...CHAIN_NETWORKS], ['ethereum', 'base', 'arbitrum', 'solana', 'near', 'bitcoin']);
  for (const network of CHAIN_NETWORKS) {
    assert.ok(isChainNetwork(network));
    assert.ok(HOSTS.has(NETWORKS[network].api), `${network} host is not on the allowlist`);
    assert.match(NETWORKS[network].explorerAddress, /^https:\/\//);
    assert.match(NETWORKS[network].explorerTx, /^https:\/\//);
  }
  for (const not of ['eth', 'ETHEREUM', 'polygon', '', 42, null, undefined]) assert.equal(isChainNetwork(not), false, String(not));
  assert.equal(HOSTS.size, 7);
});

test('an EVM address with a valid EIP-55 checksum passes as valid, lowercase passes as unchecked', () => {
  const mixed = validateAddress('ethereum', VITALIK);
  assert.deepEqual(mixed, { ok: true, normalized: VITALIK, checksum: 'valid' });
  const lower = validateAddress('base', VITALIK.toLowerCase());
  assert.deepEqual(lower, { ok: true, normalized: VITALIK, checksum: 'lowercase' });
});

test('an EVM address with a wrong EIP-55 checksum is refused, not repaired', () => {
  // One capital moved: the same 40 hex digits, a checksum that no longer matches.
  const wrong = VITALIK.slice(0, 2) + VITALIK.slice(2).replace('d8dA', 'D8da');
  const check = validateAddress('ethereum', wrong);
  assert.equal(check.ok, false);
  assert.match((check as { reason: string }).reason, /checksum/);
  for (const bad of ['0x1234', VITALIK + '0', VITALIK.slice(1), 'd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '']) {
    assert.equal(validateAddress('arbitrum', bad).ok, false, bad);
  }
});

test('a Solana address must be base58 and decode to exactly 32 bytes', () => {
  assert.deepEqual(validateAddress('solana', SOL_USDC), { ok: true, normalized: SOL_USDC });
  // 31 bytes: the wrapped SOL mint with one character dropped keeps the alphabet and breaks
  // the length (the same fixture tests/unit/config-schema.test.ts uses).
  assert.equal(validateAddress('solana', 'So11111111111111111111111111111111111111112').ok, true);
  assert.equal(validateAddress('solana', 'So1111111111111111111111111111111111111111').ok, false);
  // Base58 has no 0, O, I or l.
  assert.equal(validateAddress('solana', SOL_USDC.replace('E', '0')).ok, false);
  assert.equal(validateAddress('solana', VITALIK).ok, false);
  // 44 characters of base58 that decode to 33 bytes.
  assert.equal(validateAddress('solana', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').ok, false);
});

test('a NEAR account id is a lowercase name or an implicit id, and an EVM address is lowercased into one', () => {
  assert.deepEqual(validateAddress('near', 'intents.near'), { ok: true, normalized: 'intents.near' });
  assert.deepEqual(validateAddress('near', 'karim-demo.near'), { ok: true, normalized: 'karim-demo.near' });
  assert.deepEqual(validateAddress('near', VITALIK), { ok: true, normalized: VITALIK.toLowerCase() });
  assert.deepEqual(validateAddress('near', 'a'.repeat(64)), { ok: true, normalized: 'a'.repeat(64) });
  for (const bad of ['Intents.near', 'a', 'a'.repeat(65), 'has space.near', 'double..dot', '.near', 'near.', '-lead.near']) {
    assert.equal(validateAddress('near', bad).ok, false, bad);
  }
});

test('a Bitcoin address is checked for format only, bech32 or base58check', () => {
  assert.equal(validateAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').ok, true);
  assert.equal(validateAddress('bitcoin', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').ok, true);
  assert.equal(validateAddress('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy').ok, true);
  for (const bad of ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq!', '2N...', VITALIK, SOL_USDC, '']) {
    assert.equal(validateAddress('bitcoin', bad).ok, false, bad);
  }
});

test('transaction hashes are checked per network and hex ones are lowercased', () => {
  const evm = '0x5C504ED432CB51138BCF09AA5E8A410DD4A1E204EF84BFED1BE16DFBA1B22060';
  assert.deepEqual(validateHash('ethereum', evm), { ok: true, normalized: evm.toLowerCase() });
  assert.equal(validateHash('ethereum', evm.slice(0, 65)).ok, false);
  const sig = '2ApT' + '1'.repeat(84);
  assert.deepEqual(validateHash('solana', sig), { ok: true, normalized: sig });
  assert.equal(validateHash('solana', evm).ok, false);
  assert.deepEqual(validateHash('near', 'GU64UecpKZXhvpFZQKJDg2iU7wVNsdsbDSRLfamPE1VU'), { ok: true, normalized: 'GU64UecpKZXhvpFZQKJDg2iU7wVNsdsbDSRLfamPE1VU' });
  assert.equal(validateHash('near', sig).ok, false);
  const btc = 'A6494142E2E565B5E672D41A37A3EAFEC2FE5594F22EFBB07F421A6CEDF473C5';
  assert.deepEqual(validateHash('bitcoin', btc), { ok: true, normalized: btc.toLowerCase() });
  assert.equal(validateHash('bitcoin', evm).ok, false);
});

test('explorer links are built only from a value that passed, on the network\'s own explorer', () => {
  assert.equal(explorerAddressUrl('ethereum', VITALIK.toLowerCase()), `https://etherscan.io/address/${VITALIK}`);
  assert.equal(explorerAddressUrl('base', VITALIK), `https://basescan.org/address/${VITALIK}`);
  assert.equal(explorerAddressUrl('solana', SOL_USDC), `https://solscan.io/account/${SOL_USDC}`);
  assert.equal(explorerAddressUrl('near', 'intents.near'), 'https://nearblocks.io/address/intents.near');
  assert.equal(explorerTxUrl('bitcoin', 'a'.repeat(64)), `https://mempool.space/tx/${'a'.repeat(64)}`);
  // A string that fails its shape gets no link at all, whatever it contains.
  assert.equal(explorerAddressUrl('ethereum', 'https://evil.tld/?x='), null);
  assert.equal(explorerAddressUrl('near', 'evil.tld/../x'), null);
  assert.equal(explorerTxUrl('ethereum', '<script>'), null);
});
