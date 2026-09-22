// The POA bridge deposit address: what a person sends money to so the verifier credits it.
//
// Every test here mocks fetch. Nothing in this file reaches the bridge, because a test that
// needs a network is a test that fails for a reason it is not about.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POA_BRIDGE_RPC,
  POA_NETWORK,
  RECEIVE_NETWORKS,
  bridgeKeyOf,
  humanAmount,
  intentsDepositAddress,
  parsePoaToken,
  poaRecentDeposits,
  poaSupportedTokens,
  receiveNetworkOf,
  spendNetworkOf,
} from '../../src/rails/intents-address.ts';

type Call = { url: string; method: string; params: unknown[] };

function replying(payload: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: { body?: string } = {}) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: unknown[] };
    calls.push({ url: String(url), method: body.method, params: body.params });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// The bridge names networks with the defuse prefix and answers a bare 'eth' with "Network not
// supported". Getting this mapping wrong prints an address belonging to another chain, and money
// sent to the wrong chain is not recoverable, so it is asserted rather than trusted.
test('each chain is asked for under its defuse network id, never its short name', async () => {
  for (const [chain, network] of Object.entries(POA_NETWORK)) {
    const { fetchImpl, calls } = replying({ result: { address: '0xabc', chain: network } });
    const got = await intentsDepositAddress('0xDEAD', chain as keyof typeof POA_NETWORK, fetchImpl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, POA_BRIDGE_RPC);
    assert.equal(calls[0]!.method, 'deposit_address');
    assert.deepEqual(calls[0]!.params, [{ account_id: '0xdead', chain: network }]);
    assert.equal(got.network, network);
    assert.equal(got.chain, chain);
  }
});

// The verifier keys balances by the lowercased EVM address, and every other read in this app
// lowercases before it asks. The bridge happens to be case insensitive, which is exactly why
// this is asserted here: a difference that does not bite today is the one that bites later.
// The five the app is typed on are a view of the registry, so the two can never disagree.
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

test('any registry id or raw key is asked for under the bridge key, and an unknown one is refused before any call', async () => {
  const known = replying({ result: { address: 'bc1qabc' } });
  const got = await intentsDepositAddress('0xABC', 'btc', known.fetchImpl);
  assert.deepEqual(known.calls[0]!.params, [{ account_id: '0xabc', chain: 'btc:mainnet' }]);
  assert.equal(got.chain, 'btc');
  assert.equal(got.network, 'btc:mainnet');

  const raw = replying({ result: { address: '0xabc' } });
  assert.equal((await intentsDepositAddress('0xABC', 'eth:56', raw.fetchImpl)).network, 'eth:56');

  const never = replying({ result: { address: '0xabc' } });
  await assert.rejects(() => intentsDepositAddress('0xABC', 'bitcoin', never.fetchImpl), /no bridge network is mapped for bitcoin/);
  assert.equal(never.calls.length, 0);
});

/* Stellar, live on 2026-09-16: the plain ask is refused with "Deposit mode MEMO is required for
   this chain", and the memo-mode ask answers with one address for everybody plus the memo that
   says whose the deposit is. The memo is half the destination, so it is asked for and carried
   rather than the row going grey. */
test('a chain that routes by memo is asked again in memo mode and the memo is carried', async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = (async (_url: unknown, init: { body?: string } = {}) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: Array<Record<string, unknown>> };
    calls.push(body);
    const payload = body.params[0]?.deposit_mode === 'MEMO'
      ? { result: { address: 'GDJ4Jshared', chain: 'stellar:mainnet', memo: '177237517' } }
      : { error: 'Deposit mode MEMO is required for this chain' };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;

  const got = await intentsDepositAddress('0xABC', 'stellar', fetchImpl);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.params, [{ account_id: '0xabc', chain: 'stellar:mainnet' }]);
  assert.deepEqual(calls[1]!.params, [{ account_id: '0xabc', chain: 'stellar:mainnet', deposit_mode: 'MEMO' }]);
  assert.equal(got.address, 'GDJ4Jshared');
  assert.equal(got.memo, '177237517');

  // Any other refusal is still a refusal, asked once.
  const other = replying({ error: 'Network not supported' });
  await assert.rejects(() => intentsDepositAddress('0xABC', 'stellar', other.fetchImpl), /refused stellar:mainnet.*Network not supported/);
  assert.equal(other.calls.length, 1);
});

test('the account id is lowercased before it is sent', async () => {
  const { fetchImpl, calls } = replying({ result: { address: '0xabc' } });
  await intentsDepositAddress('0xB583F41992CD21B2F2345E194A36D33684BB5DB0', 'eth', fetchImpl);
  const sent = calls[0]!.params[0] as { account_id: string };
  assert.equal(sent.account_id, '0xb583f41992cd21b2f2345e194a36d33684bb5db0');
});

test('an error from the bridge names the network and what it said', async () => {
  const { fetchImpl } = replying({ error: 'Invalid Account ID' });
  await assert.rejects(
    () => intentsDepositAddress('0x0', 'eth', fetchImpl),
    /refused eth:1.*Invalid Account ID/,
  );
});

/* A 200 carrying no address is a failure however cheerful its status code was. This is the one
   that matters most: the alternative is a receive screen telling somebody to send money to an
   empty string under a QR code of nothing. */
test('a response with no usable address is a failure, not an empty address', async () => {
  for (const payload of [{ result: {} }, { result: { address: '' } }, { result: { address: 12 } }, {}]) {
    const { fetchImpl } = replying(payload);
    await assert.rejects(() => intentsDepositAddress('0xabc', 'eth', fetchImpl), /without an address|refused/);
  }
});

test('a non-200 from the bridge is a failure that names the status', async () => {
  const { fetchImpl } = replying({ result: { address: '0xabc' } }, 503);
  await assert.rejects(() => intentsDepositAddress('0xabc', 'eth', fetchImpl), /did not answer.*503/);
});

test('a memo is carried when the bridge sends one and is null when it does not', async () => {
  const withMemo = replying({ result: { address: '0xabc', memo: '  hello ' } });
  assert.equal((await intentsDepositAddress('0xa', 'near', withMemo.fetchImpl)).memo, 'hello');

  const without = replying({ result: { address: '0xabc', memo: '   ' } });
  assert.equal((await intentsDepositAddress('0xa', 'near', without.fetchImpl)).memo, null);
});

// The token list is guidance printed beside the address. Losing it costs the guidance and must
// never cost the address, so it swallows everything and answers with an empty list.
test('an unreadable token list is an empty list, never a throw', async () => {
  for (const payload of [{ result: {} }, { result: { tokens: 'nope' } }, { error: 'down' }]) {
    const { fetchImpl } = replying(payload);
    assert.deepEqual(await poaSupportedTokens(fetchImpl), []);
  }
});

test('the token list keeps only rows it can actually read, and cuts the network off the asset id', async () => {
  const { fetchImpl } = replying({
    result: {
      tokens: [
        {
          defuse_asset_identifier: 'eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          asset_name: 'USDC',
          decimals: 6,
          min_deposit_amount: '1000',
          intents_token_id: 'nep141:eth-0xa0b8.omft.near',
        },
        { defuse_asset_identifier: 'eth:1', asset_name: 'ETH', decimals: 18, min_deposit_amount: '100000000000' },
        { asset_name: 'BROKEN', decimals: 6 },
        { defuse_asset_identifier: 'sol:mainnet', asset_name: 'SOL', decimals: 'nine' },
      ],
    },
  });

  const tokens = await poaSupportedTokens(fetchImpl);
  assert.equal(tokens.length, 2, 'the two unreadable rows are dropped rather than half-read');
  assert.equal(tokens[0]!.network, 'eth:1');
  assert.equal(tokens[0]!.symbol, 'USDC');
  assert.equal(tokens[0]!.minDeposit, '1000', 'the raw base units are kept as the bridge sent them');
  assert.equal(tokens[0]!.minDepositHuman, '0.001', 'the floor is not in the unit a person reads');
  assert.equal(tokens[0]!.contract, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'the contract is cut off the asset id');
  assert.equal(tokens[1]!.network, 'eth:1', 'a native asset id is already just the network');
  assert.equal(tokens[1]!.minDepositHuman, '0.0000001', '18 decimals printed as a float would be 1e-7');
  assert.equal(tokens[1]!.contract, null, 'the chain\'s own coin has no contract');
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

// Same contract as the token list, for the same reason: this is the "seen, not yet credited"
// line. The settled balance is read from the verifier elsewhere and is never this.
test('recent deposits never throws and never invents a row', async () => {
  for (const payload of [{ result: { deposits: [] } }, { result: {} }, { error: 'down' }]) {
    const { fetchImpl } = replying(payload);
    assert.deepEqual(await poaRecentDeposits('0xabc', 'eth', fetchImpl), []);
  }
});

test('recent deposits resolve a registry id or a raw key to the bridge key, and an unknown chain is an empty list with no call', async () => {
  const btc = replying({ result: { deposits: [{ tx_hash: 'abc', amount: '5000', status: 'PENDING', defuse_asset_identifier: 'btc:mainnet:native' }] } });
  const rows = await poaRecentDeposits('0xABC', 'btc', btc.fetchImpl);
  assert.deepEqual(btc.calls[0]!.params, [{ account_id: '0xabc', chain: 'btc:mainnet', limit: 10 }]);
  assert.equal(rows[0]!.status, 'PENDING');

  const raw = replying({ result: { deposits: [] } });
  await poaRecentDeposits('0xABC', 'eth:56', raw.fetchImpl);
  assert.deepEqual(raw.calls[0]!.params, [{ account_id: '0xabc', chain: 'eth:56', limit: 10 }]);

  const unknown = replying({ result: { deposits: [{ tx_hash: 'x' }] } });
  assert.deepEqual(await poaRecentDeposits('0xABC', 'bitcoin', unknown.fetchImpl), []);
  assert.equal(unknown.calls.length, 0);
});

test('a deposit row is read with its hash, amount and status', async () => {
  const { fetchImpl, calls } = replying({
    result: {
      deposits: [{ tx_hash: '0xfeed', amount: '5000000', status: 'COMPLETED', defuse_asset_identifier: 'eth:1' }],
    },
  });
  const rows = await poaRecentDeposits('0xABC', 'arb', fetchImpl, 3);

  assert.deepEqual(calls[0]!.params, [{ account_id: '0xabc', chain: 'eth:42161', limit: 3 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.txHash, '0xfeed');
  assert.equal(rows[0]!.amount, '5000000');
  assert.equal(rows[0]!.status, 'COMPLETED');
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

/* A chain with no decoder is pay: null and not a missing field, so the refusal can say "this app
   cannot check a TON address yet" rather than "unknown chain". */
test('a chain with no address decoder is explicitly unpayable', () => {
  assert.equal(spendNetworkOf('ton')?.pay, null);
  assert.equal(spendNetworkOf('tron')?.pay, null);
  assert.equal(spendNetworkOf('xrp')?.pay, null);
});

test('the ton row names the coin by the ticker the venue uses', () => {
  assert.equal(spendNetworkOf('ton')?.native, 'GRAM');
});
