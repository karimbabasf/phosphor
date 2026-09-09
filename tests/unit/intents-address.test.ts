// The POA bridge deposit address: what a person sends money to so the verifier credits it.
//
// Every test here mocks fetch. Nothing in this file reaches the bridge, because a test that
// needs a network is a test that fails for a reason it is not about.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POA_BRIDGE_RPC,
  POA_NETWORK,
  intentsDepositAddress,
  poaRecentDeposits,
  poaSupportedTokens,
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
test('the account id is lowercased before it is sent', async () => {
  const { fetchImpl, calls } = replying({ result: { address: '0xabc' } });
  await intentsDepositAddress('0xD7B2DE5862008D949DD6E5D70D4C68AD1D4D5050', 'eth', fetchImpl);
  const sent = calls[0]!.params[0] as { account_id: string };
  assert.equal(sent.account_id, '0xd7b2de5862008d949dd6e5d70d4c68ad1d4d5050');
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
  assert.equal(tokens[0]!.minDeposit, '1000');
  assert.equal(tokens[1]!.network, 'eth:1', 'a native asset id is already just the network');
});

// Same contract as the token list, for the same reason: this is the "seen, not yet credited"
// line. The settled balance is read from the verifier elsewhere and is never this.
test('recent deposits never throws and never invents a row', async () => {
  for (const payload of [{ result: { deposits: [] } }, { result: {} }, { error: 'down' }]) {
    const { fetchImpl } = replying(payload);
    assert.deepEqual(await poaRecentDeposits('0xabc', 'eth', fetchImpl), []);
  }
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
