// The verifier balance read. This is the number that used to be invisible: money that
// left the wallet on a deposit and sits inside intents.near, which no chain read returns
// and no explorer shows against an address.
//
// The cases that matter are the ones where being wrong is expensive or silent: a failed
// read must not look like an empty account, an emptied asset must not linger as a row, and
// the account id asked about must be the one the rails credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIntentsHoldings } from '../../src/ledger/intents.ts';
import type { OneClickToken } from '../../src/intents.ts';

const LIST: OneClickToken[] = [
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
  { assetId: 'nep141:base-0xusdc.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC' },
];

// NEAR returns view output as a byte array of UTF-8 JSON.
function viewResult(value: unknown) {
  const bytes = [...Buffer.from(JSON.stringify(value), 'utf8')];
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: bytes } }), { status: 200 });
}

type Call = { method: string; args: any };

// Answers the two view methods and records what was asked, so a test can assert both the
// decoded result and the shape of the question.
function mockRpc(answers: { owned?: unknown; balances?: unknown; fail?: 'http' | 'rpc' }) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const method = body.params.method_name;
    const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8'));
    calls.push({ method, args });

    if (answers.fail === 'http') return new Response('nope', { status: 503 });
    if (answers.fail === 'rpc') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }),
        { status: 200 },
      );
    }
    if (method === 'mt_tokens_for_owner') return viewResult(answers.owned ?? []);
    if (method === 'mt_batch_balance_of') return viewResult(answers.balances ?? []);
    throw new Error(`unexpected view method ${method}`);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function deps(mock: ReturnType<typeof mockRpc>, accountId = '0xABCDEF0000000000000000000000000000000001') {
  return {
    rpcUrl: 'https://rpc.example',
    accountId,
    tokenList: async () => LIST,
    fetchImpl: mock.fetchImpl,
  };
}

test('a deposited balance becomes a holding, named and scaled from the token list', async () => {
  const mock = mockRpc({
    owned: [{ token_id: 'nep141:eth.omft.near' }],
    balances: ['1590208200000000'],
  });

  const read = await fetchIntentsHoldings(deps(mock));

  assert.equal(read.ok, true);
  assert.equal(read.holdings.length, 1);
  const held = read.holdings[0];
  assert.equal(held.symbol, 'ETH');
  assert.equal(held.assetId, 'nep141:eth.omft.near');
  assert.equal(held.originChain, 'eth');
  assert.equal(held.amount, 0.0015902082); // 18 decimals, the live figure this was built against
});

test('the account asked about is the one the rails credit: lowercased, never as typed', async () => {
  const mock = mockRpc({ owned: [] });
  await fetchIntentsHoldings(deps(mock, '0xABCDEF0000000000000000000000000000000001'));

  assert.equal(mock.calls[0].args.account_id, '0xabcdef0000000000000000000000000000000001');
});

test('an account holding nothing costs one call and reports empty, not failed', async () => {
  const mock = mockRpc({ owned: [] });
  const read = await fetchIntentsHoldings(deps(mock));

  assert.deepEqual(read.holdings, []);
  assert.equal(read.ok, true, 'nothing deposited is a successful read of an empty account');
  assert.equal(mock.calls.length, 1, 'no point asking for balances of nothing');
});

test('an asset enumerated but since emptied is not a row', async () => {
  const mock = mockRpc({
    owned: [{ token_id: 'nep141:eth.omft.near' }, { token_id: 'nep141:base-0xusdc.omft.near' }],
    balances: ['0', '5000000'],
  });

  const read = await fetchIntentsHoldings(deps(mock));

  assert.equal(read.holdings.length, 1);
  assert.equal(read.holdings[0].symbol, 'USDC');
  assert.equal(read.holdings[0].amount, 5);
});

test('balances are matched to the ids that were asked for, in order', async () => {
  const mock = mockRpc({
    owned: [{ token_id: 'nep141:base-0xusdc.omft.near' }, { token_id: 'nep141:eth.omft.near' }],
    balances: ['2000000', '1000000000000000000'],
  });

  const read = await fetchIntentsHoldings(deps(mock));

  const usdc = read.holdings.find(h => h.symbol === 'USDC');
  const eth = read.holdings.find(h => h.symbol === 'ETH');
  assert.equal(usdc?.amount, 2, 'the 6-decimal asset must not be scaled by 18');
  assert.equal(eth?.amount, 1);
});

test('an asset the token list does not name keeps its id and is not silently dropped', async () => {
  const mock = mockRpc({
    owned: [{ token_id: 'nep141:mystery.omft.near' }],
    balances: ['42'],
  });

  const read = await fetchIntentsHoldings(deps(mock));

  assert.equal(read.holdings.length, 1, 'an unnamed asset is still money held');
  assert.equal(read.holdings[0].symbol, 'nep141:mystery.omft.near');
  assert.equal(read.holdings[0].amount, 42, 'no decimals known means no scaling invented');
});

test('a failed read says so instead of reporting an empty account', async () => {
  for (const fail of ['http', 'rpc'] as const) {
    const read = await fetchIntentsHoldings(deps(mockRpc({ fail })));
    assert.equal(read.ok, false, `${fail} failure must not read as ok`);
    assert.deepEqual(read.holdings, []);
    assert.ok((read.error ?? '').length > 0, 'a failure carries a reason');
  }
});

test('a read never throws, because a verifier outage must not blank the chains', async () => {
  const boom = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const read = await fetchIntentsHoldings({
    rpcUrl: 'https://rpc.example',
    accountId: '0xabc',
    tokenList: async () => LIST,
    fetchImpl: boom,
  });

  assert.equal(read.ok, false);
  assert.match(read.error ?? '', /network down/);
});

test('a token list that fails to load costs labels, not balances', async () => {
  const mock = mockRpc({
    owned: [{ token_id: 'nep141:eth.omft.near' }],
    balances: ['1000000000000000000'],
  });

  const read = await fetchIntentsHoldings({
    rpcUrl: 'https://rpc.example',
    accountId: '0xabc',
    tokenList: async () => {
      throw new Error('1click down');
    },
    fetchImpl: mock.fetchImpl,
  });

  assert.equal(read.ok, true, 'the balance was read; only its label was missing');
  assert.equal(read.holdings.length, 1);
  assert.equal(read.holdings[0].amount, 1e18, 'unscaled, because the decimals were unknown');
});
