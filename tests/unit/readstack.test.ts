// Task B read stack: ledger (evm/solana/near/demo/index), composition, cost.
// Fixture-driven only; every fetchImpl here is a mock, no network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { AppConfig, RiskRow, TransferLeg } from '../../src/types.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { fetchHoldings as evmFetchHoldings, fetchGasPriceWei } from '../../src/ledger/evm.ts';
import { fetchHoldings as solanaFetchHoldings } from '../../src/ledger/solana.ts';
import { fetchHoldings as nearFetchHoldings } from '../../src/ledger/near.ts';
import { classify } from '../../src/composition.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

const demoConfig: AppConfig = {
  mode: 'demo',
  network: 'testnet',
  tradingNetwork: 'testnet',
  approvalGate: true,
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: { evm: [], solana: [], near: [] },
  economicTransferUsd: 10,
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

function closeTo(actual: number, expected: number, tolerance: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    msg ?? `expected ${actual} within ${tolerance} of ${expected}`,
  );
}

// ---------- demo.ts + composition.ts + cost.ts, against real data/*.json ----------

test('demo snapshot totals the fixture stable usd (re-derived: 49878.15, not the plan draft 49878.25 -- see task report)', () => {
  const snap = loadDemoLedger();
  const totalUsd = snap.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalUsd, 49878.15, 0.01);
});

test('demo snapshot has all five chains ok and every ChainId present', () => {
  const snap = loadDemoLedger();
  for (const chain of ['eth', 'base', 'arb', 'sol', 'near'] as const) {
    assert.equal(snap.chainStatus[chain].ok, true);
  }
});

test('composition: Circle share is 0.5553 +- 0.001', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  closeTo(comp.byIssuer['Circle'], 0.5553, 0.001);
});

test('composition: freezable share is >= 0.96', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  assert.ok(comp.freezableShare >= 0.96, `freezableShare ${comp.freezableShare} should be >= 0.96`);
});

test('composition: XUSD is unclassified and counts as freezable (pessimistic default)', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  assert.ok(comp.unclassified.includes('XUSD'));
  const xusdRow = comp.rows.find(r => r.symbol === 'XUSD' && r.chain === 'arb');
  assert.ok(xusdRow);
  assert.equal(xusdRow!.freezable, true);
  assert.equal(xusdRow!.classified, false);
  assert.equal(xusdRow!.issuer, 'unclassified');
});

test('composition: rows are sorted by share descending', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  for (let i = 1; i < comp.rows.length; i++) {
    assert.ok(comp.rows[i - 1].share >= comp.rows[i].share);
  }
});

// ---------- ledger/index.ts: demo-mode wiring + applyDemoTransfer ----------

test('createLedger demo mode: snapshot matches loadDemoLedger totals', () => {
  const ledger = createLedger(demoConfig);
  const snap = ledger.snapshot();
  const totalUsd = snap.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalUsd, 49878.15, 0.01);
  assert.equal(snap.mode, 'demo');
});

test('createLedger demo mode: refresh() resolves without changing balances', async () => {
  const ledger = createLedger(demoConfig);
  const before = ledger.snapshot();
  const after = await ledger.refresh();
  const totalBefore = before.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  const totalAfter = after.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalAfter, totalBefore, 0.0001);
});

test('applyDemoTransfer moves balance from source chain to destination chain, net of gas', () => {
  const ledger = createLedger(demoConfig);
  const before = ledger.snapshot();
  const nearUsdtBefore = before.holdings.find(h => h.chain === 'near' && h.symbol === 'USDT')!.amount;
  const ethUsdtBefore = before.holdings.find(h => h.chain === 'eth' && h.symbol === 'USDT')!.amount;
  const nearNativeBefore = before.holdings.find(h => h.chain === 'near' && h.native)!.amount;

  const leg: TransferLeg = {
    fromChain: 'near',
    toChain: 'eth',
    symbol: 'USDT',
    amount: nearUsdtBefore,
    amountUsd: nearUsdtBefore,
    from: 'karim-demo.near',
    to: '0x1111111111111111111111111111111111111111',
    quote: { amountOut: 949.5, feeUsd: 0.5, timeEstimateSec: 8 },
    gasNativeUsd: before.gas.near.transferCostUsd,
  };
  ledger.applyDemoTransfer(leg);
  const after = ledger.snapshot();

  closeTo(after.holdings.find(h => h.chain === 'near' && h.symbol === 'USDT')!.amount, 0, 1e-9);
  closeTo(
    after.holdings.find(h => h.chain === 'eth' && h.symbol === 'USDT')!.amount,
    ethUsdtBefore + 949.5,
    1e-9,
  );
  assert.ok(after.holdings.find(h => h.chain === 'near' && h.native)!.amount < nearNativeBefore);
});

// ---------- ledger/index.ts: live mode failure handling ----------

const liveConfig: AppConfig = {
  mode: 'live',
  network: 'testnet',
  tradingNetwork: 'testnet',
  approvalGate: true,
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: {
    evm: ['0x1111111111111111111111111111111111111111'],
    solana: ['11111111111111111111111111111111'],
    near: ['karim-demo.near'],
  },
  economicTransferUsd: 10,
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

test('createLedger live mode: a failing fetchImpl marks every configured chain ok:false with an error, holdings empty, and does not throw', async () => {
  const failFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const ledger = createLedger(liveConfig, { fetchImpl: failFetch });
  const snap = await ledger.refresh();

  for (const chain of ['eth', 'base', 'arb', 'sol', 'near'] as const) {
    assert.equal(snap.chainStatus[chain].ok, false, `${chain} should be ok:false`);
    assert.ok(snap.chainStatus[chain].error && snap.chainStatus[chain].error!.length > 0, `${chain} should carry an error message`);
  }
  assert.deepEqual(snap.holdings, []);
});

test('createLedger live mode: chains with no configured addresses report ok:true with empty holdings', async () => {
  const emptyAddrConfig: AppConfig = {
    ...liveConfig,
    addresses: { evm: [], solana: [], near: [] },
  };
  const okFetch = (async () =>
    new Response(JSON.stringify([[0, 0, 0, 0, 100, 0]]), { status: 200 })) as typeof fetch;

  const ledger = createLedger(emptyAddrConfig, { fetchImpl: okFetch });
  const snap = await ledger.refresh();

  for (const chain of ['eth', 'base', 'arb', 'sol', 'near'] as const) {
    assert.equal(snap.chainStatus[chain].ok, true, `${chain} should be ok:true when unconfigured`);
  }
  assert.deepEqual(snap.holdings, []);
});

// ---------- ledger/evm.ts ----------

test('evm.fetchHoldings decodes balanceOf hex and pads the address correctly', async () => {
  // The reads go out as one JSON-RPC batch, so the mock answers an array of requests with
  // an array of results keyed by id. `calls` is flattened to the individual requests: what
  // this test is about is the encoding of each call, which the batching did not change.
  const calls: any[] = [];
  const answer = (req: any) => {
    if (req.method === 'eth_call') return '0x2540be400';
    if (req.method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (req.method === 'eth_gasPrice') return '0x4a817c800';
    throw new Error('unexpected method ' + req.method);
  };
  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const batch = Array.isArray(body) ? body : [body];
    for (const req of batch) calls.push(req);
    const results = batch.map(req => ({ jsonrpc: '2.0', id: req.id, result: answer(req) }));
    return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { status: 200 });
  }) as typeof fetch;

  const address = '0x1111111111111111111111111111111111111111';
  const holdings = await evmFetchHoldings(
    'eth',
    'https://rpc.example',
    address,
    { USDC: { tokenId: '0xUSDCcontract', decimals: 6 } },
    mockFetch,
  );

  const usdc = holdings.find(h => h.symbol === 'USDC');
  assert.ok(usdc);
  assert.equal(usdc!.amount, 10000);
  assert.equal(usdc!.usd, 10000);
  assert.equal(usdc!.native, false);

  const native = holdings.find(h => h.native);
  assert.ok(native);
  assert.equal(native!.amount, 1);
  assert.equal(native!.symbol, 'ETH');
  assert.equal(native!.tokenId, 'native');

  const callBody = calls.find(c => c.method === 'eth_call');
  assert.equal(callBody.params[0].to, '0xUSDCcontract');
  assert.equal(callBody.params[0].data.slice(0, 10), '0x70a08231');
  assert.equal(callBody.params[0].data.length, 10 + 64); // selector + 32-byte padded address, no extra 0x
  assert.equal(callBody.params[0].data.slice(-40), address.slice(2).toLowerCase());
});

test('evm.fetchGasPriceWei decodes eth_gasPrice hex to a bigint', async () => {
  const mockFetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x4a817c800' }), { status: 200 })) as typeof fetch;
  const price = await fetchGasPriceWei('https://rpc.example', mockFetch);
  assert.equal(price, 20n * 10n ** 9n);
});

test('evm.fetchHoldings throws when the RPC call fails (caller marks the chain stale)', async () => {
  const failFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  await assert.rejects(() =>
    evmFetchHoldings('eth', 'https://rpc.example', '0x1111111111111111111111111111111111111111', {}, failFetch),
  );
});

// ---------- ledger/solana.ts ----------

test('solana.fetchHoldings sums jsonParsed token accounts and reads native lamports', async () => {
  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === 'getTokenAccountsByOwner') {
      return new Response(
        JSON.stringify({
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 4100 } } } } } },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (body.method === 'getBalance') {
      return new Response(JSON.stringify({ result: { value: 1200000000 } }), { status: 200 });
    }
    throw new Error('unexpected method ' + body.method);
  }) as typeof fetch;

  const holdings = await solanaFetchHoldings(
    'sol',
    'https://rpc.example',
    '11111111111111111111111111111111',
    { USDC: { tokenId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } },
    mockFetch,
  );

  const usdc = holdings.find(h => h.symbol === 'USDC');
  assert.ok(usdc);
  assert.equal(usdc!.amount, 4100);
  assert.equal(usdc!.usd, 4100);

  const native = holdings.find(h => h.native);
  assert.ok(native);
  closeTo(native!.amount, 1.2, 1e-9);
  assert.equal(native!.symbol, 'SOL');
});

// ---------- ledger/near.ts ----------

test('near.fetchHoldings decodes ft_balance_of byte-array response and view_account native balance', async () => {
  const ftBalanceBytes = Array.from(Buffer.from(JSON.stringify('950000000'))); // raw units, decimals 6 -> 950
  const oneNearYocto = (10n ** 24n).toString();

  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.params?.method_name === 'ft_balance_of') {
      return new Response(JSON.stringify({ result: { result: ftBalanceBytes } }), { status: 200 });
    }
    if (body.params?.request_type === 'view_account') {
      return new Response(JSON.stringify({ result: { amount: oneNearYocto } }), { status: 200 });
    }
    throw new Error('unexpected near query');
  }) as typeof fetch;

  const holdings = await nearFetchHoldings(
    'near',
    'https://rpc.example',
    'karim-demo.near',
    { USDT: { tokenId: 'usdt.tether-token.near', decimals: 6 } },
    mockFetch,
  );

  const usdt = holdings.find(h => h.symbol === 'USDT');
  assert.ok(usdt);
  assert.equal(usdt!.amount, 950);

  const native = holdings.find(h => h.native);
  assert.ok(native);
  closeTo(native!.amount, 1, 1e-9);
  assert.equal(native!.symbol, 'NEAR');
});

// An implicit NEAR account does not exist on chain until something funds it, and the RPC says so
// with cause.name UNKNOWN_ACCOUNT while leaving message as the generic "Server error". That is a
// definitive answer (the balance is zero), not a failed read, and reporting it as a failure marks
// the whole chain stale and blames the wrong thing.
test('near.fetchHoldings reads an account that does not exist as zero, not as a failed chain', async () => {
  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.params?.request_type === 'view_account') {
      return new Response(
        JSON.stringify({
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' },
        }),
        { status: 200 },
      );
    }
    throw new Error('unexpected near query');
  }) as typeof fetch;

  const holdings = await nearFetchHoldings('near', 'https://rpc.example', 'never-funded.testnet', {}, mockFetch);

  const native = holdings.find(h => h.native);
  assert.ok(native, 'a nonexistent account still reports a NEAR row');
  assert.equal(native!.amount, 0);
});

test('near.fetchHoldings still throws on a real rpc failure, and names the cause instead of "Server error"', async () => {
  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.params?.request_type === 'view_account') {
      return new Response(
        JSON.stringify({
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNAVAILABLE_SHARD', info: {} }, code: -32000, message: 'Server error' },
        }),
        { status: 200 },
      );
    }
    throw new Error('unexpected near query');
  }) as typeof fetch;

  await assert.rejects(
    () => nearFetchHoldings('near', 'https://rpc.example', 'karim-demo.near', {}, mockFetch),
    (err: Error) => err.message.includes('UNAVAILABLE_SHARD'),
  );
});

// A missing token CONTRACT is a bad token table, not an empty wallet, so it must stay loud.
test('near.fetchHoldings does not swallow UNKNOWN_ACCOUNT raised by a missing token contract', async () => {
  const mockFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.params?.method_name === 'ft_balance_of') {
      return new Response(
        JSON.stringify({
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' },
        }),
        { status: 200 },
      );
    }
    if (body.params?.request_type === 'view_account') {
      return new Response(JSON.stringify({ result: { amount: (10n ** 24n).toString() } }), { status: 200 });
    }
    throw new Error('unexpected near query');
  }) as typeof fetch;

  await assert.rejects(() =>
    nearFetchHoldings('near', 'https://rpc.example', 'karim-demo.near', { USDC: { tokenId: 'nope.testnet', decimals: 6 } }, mockFetch),
  );
});
