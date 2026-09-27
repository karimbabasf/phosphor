// The address and hash decoders for every network past the first six. The fixtures are real
// mainnet addresses (the live POA bridge's deposit addresses for one account, and addresses seen
// in blocks on 2026-09-26); the refusals are the near misses a paste produces: one character
// changed, a checksum that does not match, an address for another chain or another network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAIN_NETWORKS, NETWORKS, explorerAddressUrl, explorerTxUrl, scanNetworkOf, validateAddress, validateAddressForFamily, validateHash } from '../../src/chainscan/networks.ts';
import type { ChainNetwork } from '../../src/chainscan/networks.ts';
import { base58Check, base58Decode, crc16 } from '../../src/chainscan/codec.ts';
import { depositAddressProblem } from '../../src/http/wallet.ts';
import { RECEIVE_NETWORKS, receiveNetworkByBridge } from '../../src/rails/intents-address.ts';
import { POA_DEPOSIT } from '../fixtures/poa-deposit-addresses.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XRP_B58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// The character at `at` replaced by the next one in the format's own alphabet: still a string
// the format could hold, and exactly what a mistyped or misread character looks like.
function changed(address: string, at: number, alphabet: string): string {
  const next = alphabet[(alphabet.indexOf(address[at]) + 1) % alphabet.length];
  return address.slice(0, at) + next + address.slice(at + 1);
}

const networkOf = (bridge: string): ChainNetwork => scanNetworkOf(receiveNetworkByBridge(bridge)?.id ?? '') as ChainNetwork;

// ---------- real addresses pass ----------

test('every real POA bridge deposit address passes its own network\'s decoder, with its checksum checked where the format has one', () => {
  const checksummed = new Set(['bch:mainnet', 'ltc:mainnet', 'doge:mainnet', 'dash:mainnet', 'zec:mainnet', 'xrp:mainnet', 'ton:mainnet', 'tron:mainnet', 'cardano:mainnet', 'stellar:mainnet', 'aleo:mainnet', 'eth:1', 'hypercore:mainnet']);
  for (const [bridge, address] of Object.entries(POA_DEPOSIT)) {
    const network = networkOf(bridge);
    assert.ok(network !== null, `${bridge} maps to no network`);
    const check = validateAddress(network, address);
    assert.equal(check.ok, true, `${bridge}: ${JSON.stringify(check)}`);
    if (checksummed.has(bridge)) assert.equal((check as { checksum?: string }).checksum, 'valid', bridge);
  }
});

test('the other spellings each format allows pass too: segwit and P2SH Litecoin, a bare CashAddr, bounceable and raw TON', () => {
  assert.deepEqual(validateAddress('litecoin', 'ltc1qmqv07m9f3twuwjx22fut4nwp830cg73je8mwk8'), { ok: true, normalized: 'ltc1qmqv07m9f3twuwjx22fut4nwp830cg73je8mwk8', checksum: 'valid' });
  assert.equal(validateAddress('litecoin', 'MRUHW6a1xDpmxRnsjtUYU8Qc1W2fUS2r3x').ok, true);
  // A CashAddr without its prefix, or in capitals, is the same address and is spelled one way.
  const bch = POA_DEPOSIT['bch:mainnet'];
  assert.deepEqual(validateAddress('bitcoincash', bch.slice('bitcoincash:'.length)), { ok: true, normalized: bch, checksum: 'valid' });
  assert.deepEqual(validateAddress('bitcoincash', bch.toUpperCase()), { ok: true, normalized: bch, checksum: 'valid' });
  // The TON Foundation's wallet, bounceable (EQ) and not (UQ), and the raw form under both.
  for (const friendly of ['EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI']) {
    assert.deepEqual(validateAddress('ton', friendly), { ok: true, normalized: friendly, checksum: 'valid' }, friendly);
  }
  const raw = `0:${Buffer.from('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', 'base64url').subarray(2, 34).toString('hex')}`;
  assert.deepEqual(validateAddress('ton', raw.toUpperCase()), { ok: true, normalized: raw });
  assert.equal(validateAddress('ton', `-1:${'3'.repeat(64)}`).ok, true, 'the masterchain workchain');
  // A Cardano base address carries a stake part and is 57 bytes.
  assert.equal(validateAddress('cardano', 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x').ok, true);
});

test('a Starknet address is one number however many leading zeros it is written with, and is spelled out to 64 digits', () => {
  const full = POA_DEPOSIT['starknet:mainnet'];
  const short = `0x${full.slice(3)}`;
  assert.deepEqual(validateAddress('starknet', short), { ok: true, normalized: full });
  assert.deepEqual(validateAddress('starknet', full.toUpperCase().replace('0X', '0x')), { ok: true, normalized: full });
  assert.equal(validateAddress('starknet', '0x0').ok, false, 'zero is no account');
  assert.match((validateAddress('starknet', `0x${'f'.repeat(64)}`) as { reason: string }).reason, /outside the field/);
});

// ---------- near misses fail ----------

test('one character changed in a checksummed address is refused as a checksum mismatch, never repaired', () => {
  const cases: Array<[ChainNetwork, string, number, string]> = [
    ['tron', POA_DEPOSIT['tron:mainnet'], 10, B58],
    ['xrp', POA_DEPOSIT['xrp:mainnet'], 10, XRP_B58],
    ['litecoin', POA_DEPOSIT['ltc:mainnet'], 10, B58],
    ['dogecoin', POA_DEPOSIT['doge:mainnet'], 10, B58],
    ['dash', POA_DEPOSIT['dash:mainnet'], 10, B58],
    ['zcash', POA_DEPOSIT['zec:mainnet'], 10, B58],
    ['bitcoincash', POA_DEPOSIT['bch:mainnet'], 20, BECH32],
    ['ton', POA_DEPOSIT['ton:mainnet'], 10, BASE64URL],
    ['stellar', POA_DEPOSIT['stellar:mainnet'], 10, BASE32],
    ['cardano', POA_DEPOSIT['cardano:mainnet'], 20, BECH32],
    ['aleo', POA_DEPOSIT['aleo:mainnet'], 20, BECH32],
    ['litecoin', 'ltc1qmqv07m9f3twuwjx22fut4nwp830cg73je8mwk8', 12, BECH32],
  ];
  for (const [network, address, at, alphabet] of cases) {
    const typo = changed(address, at, alphabet);
    assert.notEqual(typo, address);
    const check = validateAddress(network, typo);
    assert.equal(check.ok, false, `${network} accepted ${typo}`);
    assert.match((check as { reason: string }).reason, /checksum/, `${network}: ${JSON.stringify(check)}`);
  }
});

test('an address that is one character short or long, or has a character outside the format, is refused', () => {
  for (const network of ['tron', 'xrp', 'stellar', 'sui', 'aptos', 'movement', 'aleo', 'ton', 'cardano', 'dogecoin'] as const) {
    const bridge = RECEIVE_NETWORKS.find((n) => scanNetworkOf(n.id) === network)?.bridge ?? '';
    const address = POA_DEPOSIT[bridge];
    assert.ok(address !== undefined, network);
    for (const bad of [address.slice(0, -1), `${address}q`, `${address.slice(0, -1)}!`, ` ${address} x`]) {
      assert.equal(validateAddress(network, bad).ok, false, `${network} accepted ${JSON.stringify(bad)}`);
    }
  }
  // Move chains take the full 64 hex digits: a shortened spelling is not padded.
  assert.equal(validateAddress('aptos', '0x1').ok, false);
  assert.equal(validateAddress('sui', `0x${'g'.repeat(64)}`).ok, false);
});

test('an address for another chain is refused even when its own checksum is good', () => {
  const refusals: Array<[ChainNetwork, string]> = [
    ['xrp', POA_DEPOSIT['tron:mainnet']],
    ['tron', POA_DEPOSIT['xrp:mainnet']],
    ['dogecoin', POA_DEPOSIT['ltc:mainnet']],
    ['dash', POA_DEPOSIT['doge:mainnet']],
    ['litecoin', POA_DEPOSIT['dash:mainnet']],
    ['zcash', POA_DEPOSIT['ltc:mainnet']],
    ['litecoin', POA_DEPOSIT['bch:mainnet']],
    ['bitcoincash', POA_DEPOSIT['ltc:mainnet']],
    ['stellar', POA_DEPOSIT['ton:mainnet']],
    ['ton', POA_DEPOSIT['stellar:mainnet']],
    ['cardano', POA_DEPOSIT['aleo:mainnet']],
    ['aleo', POA_DEPOSIT['cardano:mainnet']],
    ['sui', POA_DEPOSIT['eth:1']],
    ['optimism', POA_DEPOSIT['sui:mainnet']],
    ['bitcoin', POA_DEPOSIT['zec:mainnet']],
    ['starknet', POA_DEPOSIT['stellar:mainnet']],
  ];
  for (const [network, address] of refusals) assert.equal(validateAddress(network, address).ok, false, `${network} accepted ${address}`);
  // Same checksum family, another chain's version byte: named as such.
  assert.match((validateAddress('dogecoin', POA_DEPOSIT['ltc:mainnet']) as { reason: string }).reason, /another chain/);
});

test('an address for another network of the same chain is refused: TON testnet, Cardano testnet and stake keys, Stellar secret seeds', () => {
  // The same TON account with the testnet flag set and a checksum recomputed to match.
  const bytes = Buffer.from(POA_DEPOSIT['ton:mainnet'], 'base64url');
  bytes[0] |= 0x80;
  bytes.writeUInt16BE(crc16(bytes.subarray(0, 34)), 34);
  const testnet = bytes.toString('base64url');
  assert.match((validateAddress('ton', testnet) as { reason: string }).reason, /another network/);
  assert.equal(validateAddress('cardano', 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz').ok, false);
  assert.equal(validateAddress('cardano', 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw').ok, false);
  // An S... seed is a secret key, not an account, and is refused before anything decodes it.
  assert.equal(validateAddress('stellar', 'SDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK').ok, false);
  // A shielded Zcash address has no public balance to read and is refused as not transparent.
  assert.match((validateAddress('zcash', 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly') as { reason: string }).reason, /transparent/);
  // Mixed case is not a CashAddr spelling.
  const bch = POA_DEPOSIT['bch:mainnet'];
  assert.equal(validateAddress('bitcoincash', bch.slice(0, 20) + bch.slice(20).toUpperCase()).ok, false);
});

test('the codecs agree with the formats: a base58check tail is four bytes, and base58 counts leading ones as zero bytes', () => {
  assert.equal(base58Check(POA_DEPOSIT['tron:mainnet'])?.length, 21);
  assert.equal(base58Check(POA_DEPOSIT['tron:mainnet'].slice(0, -1)), null);
  assert.deepEqual([...(base58Decode('11') ?? [])], [0, 0]);
  assert.equal(base58Decode('0OIl'), null);
  assert.equal(crc16(new Uint8Array(0)), 0);
  // CRC-16/XMODEM of "123456789" is 0x31c3.
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x31c3);
});

// ---------- hashes ----------

test('transaction ids are checked per network and normalised to the one spelling their source takes', () => {
  const hex = '5D5A9D1667B84D5F2D457392781CB5974736D16CCEAF2B428AA02D55AC9DF282';
  assert.deepEqual(validateHash('tron', hex), { ok: true, normalized: hex.toLowerCase() });
  assert.deepEqual(validateHash('xrp', hex.toLowerCase()), { ok: true, normalized: hex }, 'the ledger spells hashes in capitals');
  assert.equal(validateHash('cardano', `0x${hex}`).ok, false);
  // TON: the same 32 bytes in base64 and in hex are one transaction.
  const b64 = 'cieoCGqvUTuB6ra6D9OJRM+h6SnGOgBsZtmqC5K0me8=';
  const asHex = '7227a8086aaf513b81eab6ba0fd38944cfa1e929c63a006c66d9aa0b92b499ef';
  assert.deepEqual(validateHash('ton', b64), { ok: true, normalized: asHex });
  assert.deepEqual(validateHash('ton', b64.replace(/\+/g, '-').replace(/\//g, '_').replace('=', '')), { ok: true, normalized: asHex });
  assert.deepEqual(validateHash('ton', asHex.toUpperCase()), { ok: true, normalized: asHex });
  assert.deepEqual(validateHash('sui', '2UmbBfjRa9aPr1B9qpB9TteYmP9H6rMf968DTSphjvAw'), { ok: true, normalized: '2UmbBfjRa9aPr1B9qpB9TteYmP9H6rMf968DTSphjvAw' });
  assert.equal(validateHash('sui', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').ok, false, 'decodes to 33 bytes');
  assert.deepEqual(validateHash('aptos', `0x${hex}`), { ok: true, normalized: `0x${hex.toLowerCase()}` });
  assert.match((validateHash('hypercore', hex) as { reason: string }).reason, /0x followed by 64 hex/);
  assert.deepEqual(validateHash('starknet', '0x492e0d1794ac2f17437c82fabf003674f5e2ed8ab8248d0fee74f78ab4d6d15'), { ok: true, normalized: '0x0492e0d1794ac2f17437c82fabf003674f5e2ed8ab8248d0fee74f78ab4d6d15' });
  const aleo = 'at1slsjfd5pdpyksvzd0y7n3zs9g2lxgh86rmvtk7xuzzcatlz0ssrsg4t2gv';
  assert.deepEqual(validateHash('aleo', aleo), { ok: true, normalized: aleo });
  assert.equal(validateHash('aleo', changed(aleo, 20, BECH32)).ok, false, 'a changed character fails the bech32m checksum');
  // The first six keep their exact refusals.
  assert.match((validateHash('ethereum', hex) as { reason: string }).reason, /^not an EVM transaction hash/);
});

// ---------- the registry and the links ----------

test('every registry id the deposit card or the venue names maps to a network, and the first six map as before', () => {
  for (const net of RECEIVE_NETWORKS) assert.ok(scanNetworkOf(net.id) !== null, `${net.id} has no network`);
  assert.equal(scanNetworkOf('abs'), 'abstract');
  assert.deepEqual(['eth', 'base', 'arb', 'sol', 'near', 'btc'].map(scanNetworkOf), ['ethereum', 'base', 'arbitrum', 'solana', 'near', 'bitcoin']);
  assert.equal(scanNetworkOf('op'), 'optimism');
  assert.equal(scanNetworkOf('nope'), null);
  // Each network's registry id is unique and points back at it.
  for (const network of CHAIN_NETWORKS) assert.equal(scanNetworkOf(NETWORKS[network].id), network);
});

test('explorer links on the new networks are built only from a value that passed', () => {
  assert.equal(explorerAddressUrl('tron', POA_DEPOSIT['tron:mainnet']), `https://tronscan.org/#/address/${POA_DEPOSIT['tron:mainnet']}`);
  assert.equal(explorerAddressUrl('bitcoincash', 'qr9976ncxz2msd97ghn726kupk20m2wdmyn0fers4g'), `https://blockchair.com/bitcoin-cash/address/${encodeURIComponent(POA_DEPOSIT['bch:mainnet'])}`);
  assert.equal(explorerTxUrl('xrp', '007db4da82228d6fedd94c72e736d6b49cdaa63b3b316a57a5cc82c17accc700'), 'https://livenet.xrpl.org/transactions/007DB4DA82228D6FEDD94C72E736D6B49CDAA63B3B316A57A5CC82C17ACCC700');
  assert.equal(explorerAddressUrl('tron', changed(POA_DEPOSIT['tron:mainnet'], 10, B58)), null);
  assert.equal(explorerAddressUrl('ton', 'https://evil.tld/?x='), null);
  assert.equal(explorerTxUrl('aleo', '<script>'), null);
});

// ---------- the pay rail's decoder ----------

test('validateAddressForFamily decodes every family by name, and the three a payout uses keep their answers', () => {
  assert.equal(validateAddressForFamily('tron', POA_DEPOSIT['tron:mainnet'], 'Tron').ok, true);
  assert.equal(validateAddressForFamily('ton', POA_DEPOSIT['ton:mainnet']).ok, true);
  assert.equal(validateAddressForFamily('xrp', changed(POA_DEPOSIT['xrp:mainnet'], 10, XRP_B58)).ok, false);
  assert.match((validateAddressForFamily('move', '0x1', 'Aptos') as { reason: string }).reason, /not an address on Aptos/);
  assert.deepEqual(validateAddressForFamily('sol', POA_DEPOSIT['sol:mainnet']), { ok: true, normalized: POA_DEPOSIT['sol:mainnet'] });
  assert.deepEqual(validateAddressForFamily('near', POA_DEPOSIT['near:mainnet']), { ok: true, normalized: POA_DEPOSIT['near:mainnet'] });
  assert.deepEqual(validateAddressForFamily('evm', POA_DEPOSIT['eth:1'].toLowerCase()), { ok: true, normalized: POA_DEPOSIT['eth:1'], checksum: 'lowercase' });
});

// ---------- the deposit card ----------

test('a bridge deposit address on a network that now decodes gets its real check, and every real one passes', () => {
  for (const net of RECEIVE_NETWORKS) {
    const address = POA_DEPOSIT[net.bridge] ?? (net.kind === 'evm' ? POA_DEPOSIT['eth:1'] : undefined);
    if (address === undefined) continue;
    assert.equal(depositAddressProblem(net, address), null, `${net.id}: ${depositAddressProblem(net, address)}`);
  }
  const ton = RECEIVE_NETWORKS.find((n) => n.id === 'ton');
  const xrp = RECEIVE_NETWORKS.find((n) => n.id === 'xrp');
  const tron = RECEIVE_NETWORKS.find((n) => n.id === 'tron');
  assert.ok(ton && xrp && tron);
  assert.match(String(depositAddressProblem(ton, changed(POA_DEPOSIT['ton:mainnet'], 10, BASE64URL))), /checksum/);
  assert.match(String(depositAddressProblem(tron, POA_DEPOSIT['xrp:mainnet'])), /not a Tron address/);
  // The plain rule still speaks first, in the words it always used.
  assert.match(String(depositAddressProblem(xrp, 'send it here please')), /no spaces/);
  // A bridge key the registry does not know has no decoder and keeps the plain rule alone.
  const unknown = { ...xrp, id: 'newchain:mainnet', bridge: 'newchain:mainnet' };
  assert.equal(depositAddressProblem(unknown, 'addr-for-newchain:mainnet'), null);
});
