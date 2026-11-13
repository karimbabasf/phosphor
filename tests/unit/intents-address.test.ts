// The receive registry: which networks money comes in on, the key NEAR Intents names each by, the
// name 1Click's token list gives each, and the coin list read off 1Click's /v0/tokens.
//
// The POA bridge's JSON-RPC (deposit_address, supported_tokens, recent_deposits) is gone from this
// app: NEAR Intents is closing it, and a deposit address is a one-time 1Click quote now
// (tests/unit/intents-receive-report.test.ts holds the card). Nothing here touches a network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POA_NETWORK,
  RECEIVE_NETWORKS,
  bridgeKeyOf,
  humanAmount,
  parsePoaToken,
  currentSymbol,
  receiveNetworkOf,
  spendNetworkOf,
  tokensFromOneClick,
} from '../../src/rails/intents-address.ts';
import type { OneClickToken } from '../../src/intents.ts';

/* ---------- tokensFromOneClick: the coin list the receive report reads ---------- */

const BASE_USDC: OneClickToken = {
  assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  decimals: 6,
  blockchain: 'base',
  symbol: 'USDC',
  contractAddress: ' 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 ',
};

/* A row is keyed by the network's bridge key, which is what the report and Activity name networks
   by. The floor is not on 1Click's list: it comes with the minted address, so the row carries the
   empty string, and a window that printed it would print nothing rather than a made-up number. */
test('a 1Click row is keyed by the bridge key of its chain, carries no floor, and keeps its contract as written', () => {
  const [usdc, ...rest] = tokensFromOneClick([BASE_USDC]);
  assert.equal(rest.length, 0);
  assert.equal(usdc!.network, 'eth:8453');
  assert.equal(usdc!.symbol, 'USDC');
  assert.equal(usdc!.decimals, 6);
  assert.equal(usdc!.minDeposit, '', 'the floor is the quote\'s, never the list\'s');
  assert.equal(usdc!.minDepositHuman, '');
  assert.equal(usdc!.contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'trimmed, checksum case kept');
  assert.equal(usdc!.intentsAssetId, BASE_USDC.assetId, 'the verifier reads the balance under this id');
  assert.equal(usdc!.nearTokenId, 'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near');

  // No contract, or a blank one, is the chain's own coin.
  const eth = tokensFromOneClick([{ assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH' }])[0]!;
  assert.equal(eth.contract, null);
  assert.equal(eth.network, 'eth:1');
  const blank = tokensFromOneClick([{ assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', contractAddress: '  ' }])[0]!;
  assert.equal(blank.contract, null);
});

/* The three chains 1Click spells differently land on the registry's own rows. A name read as our
   id would key Polygon USDC under no network, or worse under a different one. */
test('1Click\'s pol, bsc and hood land on Polygon, BNB Smart Chain and Robinhood Chain, in any case', () => {
  const rows = tokensFromOneClick([
    { assetId: 'nep141:pol-usdc', decimals: 6, blockchain: 'pol', symbol: 'USDC', contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
    { assetId: 'nep141:bsc-usdt', decimals: 18, blockchain: 'BSC', symbol: 'USDT', contractAddress: '0x55d398326f99059ff775485246999027b3197955' },
    { assetId: 'nep141:hood-eth', decimals: 18, blockchain: 'hood', symbol: 'ETH' },
  ]);
  assert.deepEqual(rows.map((r) => r.network), ['eth:137', 'eth:56', 'eth:4663']);
});

/* A coin on a chain the registry has no row for has no name, no address rule and no words for an
   exchange's withdraw screen, so it is left out rather than shown under a guess. Abstract is a
   spend-only chain: money can be swapped into it, never deposited from it. A row that cannot be
   read whole is dropped, and one assetId is one row. */
test('a coin on a chain with no receive row, a row that cannot be read, and a repeated assetId are all left out', () => {
  const rows = tokensFromOneClick([
    { assetId: 'nep141:abs-eth', decimals: 18, blockchain: 'abs', symbol: 'ETH' },
    { assetId: 'nep141:new-coin', decimals: 6, blockchain: 'newchain', symbol: 'NEW' },
    { assetId: 'nep141:no-chain', decimals: 6, symbol: 'X' } as unknown as OneClickToken,
    { decimals: 6, blockchain: 'base', symbol: 'USDC' } as unknown as OneClickToken,
    { assetId: 'nep141:frac', decimals: 6.5, blockchain: 'base', symbol: 'FRAC' },
    { assetId: 'nep141:neg', decimals: -1, blockchain: 'base', symbol: 'NEG' },
    { assetId: 'nep141:str', decimals: '6', blockchain: 'base', symbol: 'STR' } as unknown as OneClickToken,
    { assetId: 'nep141:nosym', decimals: 6, blockchain: 'base' } as unknown as OneClickToken,
    null as unknown as OneClickToken,
    BASE_USDC,
    { ...BASE_USDC, symbol: 'USDC2', contractAddress: '0xdead' },
  ]);
  assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => r.symbol)));
  assert.equal(rows[0]!.symbol, 'USDC', 'the first row for an assetId wins');
  assert.equal(rows[0]!.contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
});

/* Toncoin is Gram since 2026-06-15; 1Click may still list it as TON. On NEAR every coin 1Click
   takes is a token with a contract (wNEAR is wrap.near), which is what the card's NEAR warning
   rests on: plain NEAR is not on the list. */
test('TON on TON reads GRAM, and NEAR\'s coins all carry a contract', () => {
  const rows = tokensFromOneClick([
    { assetId: 'nep245:v2_1.omni.hot.tg:1117_', decimals: 9, blockchain: 'ton', symbol: 'TON' },
    { assetId: 'nep245:v2_1.omni.hot.tg:1117_usdt', decimals: 6, blockchain: 'ton', symbol: 'USDT', contractAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
    { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', contractAddress: 'wrap.near' },
  ]);
  assert.deepEqual(rows.map((r) => `${r.network} ${r.symbol}`), ['ton:mainnet GRAM', 'ton:mainnet USDT', 'near:mainnet wNEAR']);
  assert.equal(rows[2]!.contract, 'wrap.near');
  assert.equal(rows[2]!.nearTokenId, 'wrap.near');
  // A nep245 id is not stripped like a nep141 one: it is kept whole.
  assert.equal(rows[0]!.nearTokenId, 'nep245:v2_1.omni.hot.tg:1117_');
});

test('an empty list is an empty list', () => {
  assert.deepEqual(tokensFromOneClick([]), []);
});

/* ---------- the registry ---------- */

// The five chains the app is typed on are a view of the registry, so the two can never disagree.
test('POA_NETWORK is the registry\'s five, and every registry id resolves to its bridge key', () => {
  for (const [id, bridge] of Object.entries(POA_NETWORK)) {
    assert.equal(receiveNetworkOf(id)?.bridge, bridge);
    assert.equal(bridgeKeyOf(id), bridge);
  }
  for (const n of RECEIVE_NETWORKS) assert.equal(bridgeKeyOf(n.id), n.bridge, n.id);
  assert.equal(bridgeKeyOf('btc'), 'btc:mainnet');
  assert.equal(bridgeKeyOf('bnb'), 'eth:56');
  assert.equal(bridgeKeyOf('hypercore'), 'hypercore:mainnet');
});

// A raw key is the bridge's own spelling and passes through; a name, a typo or an injection
// shaped like a key does not become one.
test('bridgeKeyOf takes a raw bridge key through untouched and answers undefined for anything else', () => {
  assert.equal(bridgeKeyOf('eth:56'), 'eth:56');
  assert.equal(bridgeKeyOf('newchain:mainnet'), 'newchain:mainnet');
  for (const bad of ['bitcoin', 'ETH', 'eth:', ':1', 'eth:1:0xabc', 'eth 1', '', 'Eth:1', 'eth:1\n']) {
    assert.equal(bridgeKeyOf(bad), undefined, JSON.stringify(bad));
  }
});

/* The live list spells a chain's own coin 'eth:8453:native' with origin_chain_address 'native',
   and the old reading put the word native in the contract field, where the window would have
   offered it to copy. The contract is the chain's own spelling (checksummed on EVM) when the
   row carries one, the identifier's tail when it does not, and null for the coin itself. */
test('the contract is origin_chain_address as the chain spells it, the identifier tail without one, and never the word native', () => {
  const evm = parsePoaToken({
    defuse_asset_identifier: 'eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    origin_chain_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    near_token_id: 'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    asset_name: 'USDC',
    decimals: 6,
    min_deposit_amount: '150000',
    intents_token_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  });
  assert.equal(evm?.contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(evm?.nearTokenId, 'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near');
  assert.equal(evm?.minDepositHuman, '0.15');

  for (const row of [
    { defuse_asset_identifier: 'eth:8453:native', origin_chain_address: 'native', asset_name: 'ETH', decimals: 18, min_deposit_amount: '1' },
    { defuse_asset_identifier: 'btc:mainnet:native', origin_chain_address: 'native', asset_name: 'BTC', decimals: 8, min_deposit_amount: '5000' },
    { defuse_asset_identifier: 'eth:1', origin_chain_address: '', asset_name: 'ETH', decimals: 18, min_deposit_amount: '1' },
    { defuse_asset_identifier: 'sol:mainnet:native', asset_name: 'SOL', decimals: 9, min_deposit_amount: '1' },
  ]) {
    assert.equal(parsePoaToken(row)?.contract, null, row.defuse_asset_identifier);
  }

  // The two Move chains say native in the address and carry the coin's type in the identifier;
  // the type is what an explorer takes, so it is kept.
  const apt = parsePoaToken({ defuse_asset_identifier: 'aptos:mainnet:0x1::aptos_coin::AptosCoin', origin_chain_address: 'native', asset_name: 'APT', decimals: 8, min_deposit_amount: '1' });
  assert.equal(apt?.contract, '0x1::aptos_coin::AptosCoin');
  assert.equal(apt?.network, 'aptos:mainnet');
  // A Stellar asset carries a colon of its own; the tail is kept whole.
  const xlm = parsePoaToken({ defuse_asset_identifier: 'stellar:mainnet:USDC:GA5ZSEJYB37J', origin_chain_address: 'GA5ZSEJYB37J', asset_name: 'USDC', decimals: 7, min_deposit_amount: '1' });
  assert.equal(xlm?.contract, 'GA5ZSEJYB37J');
  assert.equal(parsePoaToken({ defuse_asset_identifier: 'sui:mainnet:0x2::sui::SUI', asset_name: 'SUI', decimals: 9, min_deposit_amount: '1' })?.contract, '0x2::sui::SUI');
  assert.equal(parsePoaToken({ defuse_asset_identifier: 'eth:1:native', asset_name: 'ETH', decimals: 18 })?.nearTokenId, '');
});

// The minimum is a number a person compares against the amount they are about to type, so it
// is printed in the token's unit and never in base units: "Minimum 1000 USDC" was a thousand
// dollars on screen for a floor of a tenth of a cent.
test('base units become the number a person reads, by string arithmetic, with no float in it', () => {
  assert.equal(humanAmount('100000000000', 18), '0.0000001');
  assert.equal(humanAmount('1000', 6), '0.001');
  assert.equal(humanAmount('1000000', 6), '1');
  assert.equal(humanAmount('1500000', 6), '1.5');
  assert.equal(humanAmount('0', 6), '0');
  assert.equal(humanAmount('123456789012345678901234567890', 18), '123456789012.34567890123456789', 'past 2^53 a float would round');
  assert.equal(humanAmount('42', 0), '42');
  assert.equal(humanAmount('0000100', 3), '0.1', 'leading zeros are not digits');
  assert.equal(humanAmount('abc', 6), 'abc', 'a value that is not base units comes back as it arrived');
  assert.equal(humanAmount('1000', -1), '1000');
});

/* The venue's name for a chain is not the registry's id on three rows, and a mapping derived by
   lowercasing the id would send a quote to the wrong chain on every one of them. Checked against
   the live token list on 2026-09-22. */
test('the three chains the venue spells differently carry their own venue name', () => {
  assert.equal(spendNetworkOf('polygon')?.venue, 'pol');
  assert.equal(spendNetworkOf('bnb')?.venue, 'bsc');
  assert.equal(spendNetworkOf('robinhood')?.venue, 'hood');
});

test('every venue name is unique, so a venue name maps back to one chain', () => {
  const venues = RECEIVE_NETWORKS.map((n) => n.venue).filter((v): v is string => v !== null);
  assert.equal(new Set(venues).size, venues.length);
});

test('a chain this app can pay out names the decoder family that validates its addresses', () => {
  assert.equal(spendNetworkOf('base')?.pay, 'evm');
  assert.equal(spendNetworkOf('op')?.pay, 'evm');
  assert.equal(spendNetworkOf('fogo')?.pay, 'sol');
  assert.equal(spendNetworkOf('near')?.pay, 'near');
});

/* A chain the app does not pay out on is pay: null and not a missing field, so the refusal can say
   "this app cannot check a Zcash address yet" rather than "unknown chain". Every other chain the
   deposit card lists pays out since 2026-09-26. */
test('Zcash and Aleo are explicitly unpayable, and the rest name their decoder', () => {
  assert.equal(spendNetworkOf('zec')?.pay, null);
  assert.equal(spendNetworkOf('aleo')?.pay, null);
  assert.equal(spendNetworkOf('ton')?.pay, 'ton');
  assert.equal(spendNetworkOf('tron')?.pay, 'tron');
  assert.equal(spendNetworkOf('xrp')?.pay, 'xrp');
  assert.equal(spendNetworkOf('sui')?.pay, 'move');
});

test('the ton row names the coin by the ticker the venue uses', () => {
  assert.equal(spendNetworkOf('ton')?.native, 'GRAM');
});

test('the bridge still lists Toncoin as TON; the coin reads GRAM, and TON typed on TON finds it', () => {
  const coin = parsePoaToken({ defuse_asset_identifier: 'ton:mainnet:native', origin_chain_address: 'native', decimals: 9, asset_name: 'TON', min_deposit_amount: '10000000', intents_token_id: 'nep245:v2_1.omni.hot.tg:1117_' });
  assert.equal(coin?.symbol, 'GRAM');
  const usdt = parsePoaToken({ defuse_asset_identifier: 'ton:mainnet:EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', origin_chain_address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6, asset_name: 'USDT', min_deposit_amount: '1000' });
  assert.equal(usdt?.symbol, 'USDT');
  assert.equal(currentSymbol('ton', 'TON'), 'GRAM');
  assert.equal(currentSymbol('ton', 'USDT'), 'USDT');
  assert.equal(currentSymbol('eth', 'TON'), 'TON');
});
