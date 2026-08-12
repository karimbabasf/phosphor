import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';

import { hlDepositRail, hlSpec, toUnits, MIN_DEPOSIT_USDC } from '../../src/rails/hyperliquid-deposit.ts';
import type { HlEvmPort } from '../../src/rails/hyperliquid-deposit.ts';
import type { SendOutcome, SendParams } from '../../src/chain/evm.ts';
import type { HlDepositDraft } from '../../src/types.ts';

// The two BRIDGE addresses are real, because the whole safety case is about which of them
// is which and a placeholder would test nothing. The wallet is deliberately NOT real: which
// wallet sends is irrelevant to every assertion here, and hardcoding the app's own address
// puts an identifying value in a public repo for no test value. The secret sweep catches it.
// Distinct from the 0x1111... signer used in the from-mismatch test, which needs the two
// to differ for the refusal to fire at all.
const WALLET = '0x2222222222222222222222222222222222222222';
const TESTNET_BRIDGE = '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89';
const MAINNET_BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
const USDC2 = '0x1baAbB04529D43a73232B713C0FE471f7c7334d5';
const MAINNET_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const KEYS = '/nowhere/keys.json'; // never read: the port stands in for the signer

type PortOverrides = {
  code?: Record<string, Hex>; // lowercased address -> eth_getCode result
  balance?: bigint;
  gas?: bigint;
  signer?: string;
  outcome?: SendOutcome;
  throwOnRead?: string;
};

// Chain as it really is on Arbitrum Sepolia: both the testnet bridge and USDC2 carry code,
// the mainnet bridge address carries none.
const REAL_CODE: Record<string, Hex> = {
  [TESTNET_BRIDGE.toLowerCase()]: '0x60806040523480156100',
  [USDC2.toLowerCase()]: '0x608060405234801561001',
  [MAINNET_BRIDGE.toLowerCase()]: '0x',
  [MAINNET_USDC.toLowerCase()]: '0x60806040523480156100',
};

function fakePort(over: PortOverrides = {}): { port: HlEvmPort; sent: SendParams[] } {
  const sent: SendParams[] = [];
  const codes = over.code ?? REAL_CODE;
  const port: HlEvmPort = {
    async code(_network, _chain, address) {
      if (over.throwOnRead) throw new Error(over.throwOnRead);
      return codes[address.toLowerCase()] ?? '0x';
    },
    async erc20Balance() {
      if (over.throwOnRead) throw new Error(over.throwOnRead);
      return over.balance ?? 1_000_000_000n; // 1,000 USDC2
    },
    async nativeBalance() {
      if (over.throwOnRead) throw new Error(over.throwOnRead);
      return over.gas ?? 10_000_000_000_000_000n; // 0.01 ETH
    },
    signerAddress() {
      return (over.signer ?? WALLET) as Address;
    },
    async send(params) {
      sent.push(params);
      return over.outcome ?? { ok: true, hash: '0xabc123', explorer: 'https://sepolia.arbiscan.io/tx/0xabc123', gasUsed: '52000' };
    },
  };
  return { port, sent };
}

function draft(patch: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    chain: 'arb',
    symbol: 'USDC',
    amount: 10,
    amountUsd: 10,
    from: WALLET,
    bridge: TESTNET_BRIDGE,
    ...patch,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

// ---------- the four refusals ----------

test('REFUSAL 1: testnet deposit pointed at the MAINNET bridge address', async () => {
  const { port, sent } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ bridge: MAINNET_BRIDGE }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /MAINNET bridge/);
  assert.match(result.error ?? '', /no contract on Arbitrum Sepolia/i);
  assert.match(result.error ?? '', /unrecoverable/);
  assert.ok((result.error ?? '').includes(TESTNET_BRIDGE), 'the refusal names the address that would have been correct');
  assert.equal(sent.length, 0);
});

test('REFUSAL 1 (vice versa): mainnet deposit pointed at the TESTNET bridge address', async () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'mainnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ bridge: TESTNET_BRIDGE }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /TESTNET bridge/);
  assert.ok((result.error ?? '').includes(MAINNET_BRIDGE));
});

test('REFUSAL 2: amount below the 5 USDC minimum, which is not credited and is lost forever', async () => {
  const { port, sent } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ amount: 4.999999, amountUsd: 5 }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /below the 5 USDC minimum/);
  assert.match(result.error ?? '', /lost forever/);
  assert.equal(sent.length, 0);

  // Exactly the minimum is allowed: the docs say "less than this", not "at most this".
  const atMin = await rail.simulate(draft({ amount: MIN_DEPOSIT_USDC }));
  assert.equal(atMin.ok, true, atMin.error ?? '');
});

test('REFUSAL 3: the destination address has no code on the target chain', async () => {
  // The right bridge address, but the chain says there is no contract there: a wrong RPC,
  // a wrong chain id, or a bridge that has been removed. Sending anyway burns the tokens.
  const { port, sent } = fakePort({ code: { ...REAL_CODE, [TESTNET_BRIDGE.toLowerCase()]: '0x' } });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft());

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /has NO CONTRACT on Arbitrum Sepolia/);
  assert.match(result.error ?? '', /eth_getCode returns 0x/);
  assert.equal(sent.length, 0);
});

test('REFUSAL 4: the wallet USDC2 balance is short', async () => {
  const { port, sent } = fakePort({ balance: 9_999_999n }); // 9.999999, one unit short of 10
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ amount: 10 }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /wallet holds 9\.999999 USDC2/);
  assert.match(result.error ?? '', /needs 10/);
  assert.equal(sent.length, 0);
});

// ---------- the rest of the safety case ----------

test('simulate refuses a deposit whose from address is not the wallet that will sign', async () => {
  const { port } = fakePort({ signer: '0x1111111111111111111111111111111111111111' });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ from: WALLET }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Bridge2 credits the sending address/);
  assert.match(result.error ?? '', /hold no key for/);
});

test('simulate refuses a token the bridge does not accept', async () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ symbol: 'USDT' }));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not the token Bridge2 accepts/);

  // 'USDC2' and 'USDC' both name the same testnet token, so neither is an error.
  assert.equal((await rail.simulate(draft({ symbol: 'USDC2' }))).ok, true);
  assert.equal((await rail.simulate(draft({ symbol: 'usdc' }))).ok, true);
});

test('simulate refuses a chain other than the one the bridge lives on', async () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ chain: 'base' }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /draft rides chain base/);
});

test('simulate refuses an amount that needs more precision than the token has', async () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ amount: 10.0000005 }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /needs more than 6 decimals/);
});

test('simulate refuses when the wallet cannot pay gas', async () => {
  const { port } = fakePort({ gas: 0n });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no ETH on Arbitrum Sepolia/);
});

test('simulate refuses rather than assumes when the chain cannot be read', async () => {
  const { port } = fakePort({ throwOnRead: 'rpc 429 rate limited' });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /could not read Arbitrum Sepolia: rpc 429 rate limited/);
});

test('simulate collects every failing check rather than only the first', async () => {
  const { port } = fakePort({ balance: 0n, gas: 0n });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /wallet holds 0 USDC2/);
  assert.match(result.error ?? '', /no ETH/);
});

// ---------- the happy path ----------

test('simulate accepts a well-formed deposit and describes the exact call', async () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.simulate(draft({ amount: 10 }));

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.ok(result.summary.includes(`${USDC2}.transfer(${TESTNET_BRIDGE}, 10000000)`), result.summary);
  assert.match(result.summary, /10 USDC2/);
});

test('execute sends the exact calldata of a real testnet deposit', async () => {
  const { port, sent } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.execute(draft({ amount: 10 }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.txids, ['0xabc123']);
  assert.match(result.detail, /sepolia\.arbiscan\.io\/tx\/0xabc123/);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, USDC2, 'the tx goes to the token, never to the bridge');
  assert.equal(sent[0].chain, 'arb');
  assert.equal(sent[0].network, 'testnet');
  assert.equal(sent[0].keysPath, KEYS);
  // Byte for byte the input of tx 0xd5a06833...15c03, the verified 10 USDC2 testnet deposit.
  assert.equal(
    sent[0].data,
    '0xa9059cbb' + '000000000000000000000000' + TESTNET_BRIDGE.slice(2).toLowerCase() + '989680'.padStart(64, '0'),
  );
});

test('execute re-simulates and sends nothing when the draft is refused', async () => {
  const { port, sent } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.execute(draft({ bridge: MAINNET_BRIDGE }));

  assert.equal(result.ok, false);
  assert.match(result.detail, /MAINNET bridge/);
  assert.equal(sent.length, 0, 'a refused draft must never reach the signer');
});

test('execute reports a failed broadcast rather than claiming success', async () => {
  const { port } = fakePort({ outcome: { ok: false, error: 'transaction reverted on chain', hash: '0xdead' } });
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  const result = await rail.execute(draft());
  assert.equal(result.ok, false);
  assert.match(result.detail, /deposit failed: transaction reverted on chain/);
});

// ---------- table, units, value ----------

test('the network table gives each network its own bridge, token and info url', () => {
  const testnet = hlSpec('testnet');
  const mainnet = hlSpec('mainnet');

  assert.equal(testnet.bridge, TESTNET_BRIDGE);
  assert.equal(testnet.usdc, USDC2);
  assert.equal(testnet.symbol, 'USDC2');
  assert.equal(testnet.infoUrl, 'https://api.hyperliquid-testnet.xyz/info');
  assert.equal(mainnet.bridge, MAINNET_BRIDGE);
  assert.equal(mainnet.usdc, MAINNET_USDC);
  assert.equal(mainnet.infoUrl, 'https://api.hyperliquid.xyz/info');
  assert.notEqual(testnet.bridge, mainnet.bridge);
  assert.notEqual(testnet.usdc, mainnet.usdc);

  assert.throws(() => hlSpec('devnet' as never), /no Hyperliquid spec for network/);
});

test('toUnits converts through a decimal string and refuses what it cannot represent', () => {
  assert.equal(toUnits(10, 6), 10_000_000n);
  assert.equal(toUnits(5, 6), 5_000_000n);
  assert.equal(toUnits(0.1, 6), 100_000n);
  assert.equal(toUnits(21.785851, 6), 21_785_851n);
  assert.throws(() => toUnits(0, 6), /must be positive/);
  assert.throws(() => toUnits(-5, 6), /must be positive/);
  assert.throws(() => toUnits(Number.NaN, 6), /not a finite number/);
  assert.throws(() => toUnits(Number.POSITIVE_INFINITY, 6), /not a finite number/);
  assert.throws(() => toUnits(1e21, 6), /out of range/);
});

test('valueUsd reads the larger of amountUsd and amount, so an under-reported draft cannot duck a budget', () => {
  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port });

  assert.equal(rail.valueUsd(draft({ amount: 100, amountUsd: 100 })), 100);
  assert.equal(rail.valueUsd(draft({ amount: 100, amountUsd: 0 })), 100);
  assert.equal(rail.valueUsd(draft({ amount: 100, amountUsd: 101 })), 101);
});

// ---------- accountState ----------

// Verbatim from the live testnet endpoint, 2026-08-11.
const FUNDED_PERP = {
  marginSummary: { accountValue: '1426.041001', totalNtlPos: '0.0', totalRawUsd: '1426.041001', totalMarginUsed: '0.0' },
  crossMarginSummary: { accountValue: '1426.041001', totalNtlPos: '0.0', totalRawUsd: '1426.041001', totalMarginUsed: '0.0' },
  crossMaintenanceMarginUsed: '0.0',
  withdrawable: '1426.041001',
  assetPositions: [],
  time: 1786500239903,
};

const FUNDED_SPOT = {
  balances: [
    { coin: 'USDC', token: 0, total: '1312.59246254', hold: '0.0', entryNtl: '0.0' },
    { coin: 'HYPE', token: 1105, total: '0.52210001', hold: '0.0', entryNtl: '46.03393535' },
  ],
};

const EMPTY_PERP = {
  marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
  crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
  crossMaintenanceMarginUsed: '0.0',
  withdrawable: '0.0',
  assetPositions: [],
  time: 1786500321442,
};

test('accountState posts both reads to the testnet info endpoint and summarises them', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.type === 'clearinghouseState') return jsonResponse(FUNDED_PERP);
    if (body.type === 'spotClearinghouseState') return jsonResponse(FUNDED_SPOT);
    throw new Error(`unexpected info type ${String(body.type)}`);
  };

  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port, fetchImpl });
  const state = await rail.accountState('0x0000000000000000000000000000000000000001');

  assert.deepEqual(new Set(urls), new Set(['https://api.hyperliquid-testnet.xyz/info']));
  assert.deepEqual(bodies.find((b) => b.type === 'clearinghouseState'), {
    type: 'clearinghouseState',
    user: '0x0000000000000000000000000000000000000001',
    dex: '',
  });
  assert.deepEqual(bodies.find((b) => b.type === 'spotClearinghouseState'), {
    type: 'spotClearinghouseState',
    user: '0x0000000000000000000000000000000000000001',
  });

  assert.equal(state.network, 'testnet');
  assert.equal(state.accountValueUsd, 1426.041001);
  assert.equal(state.withdrawableUsd, 1426.041001);
  assert.equal(state.marginUsedUsd, 0);
  assert.equal(state.openPositions, 0);
  assert.equal(state.funded, true);
  assert.deepEqual(state.spot, [
    { coin: 'USDC', token: 0, total: 1312.59246254, hold: 0 },
    { coin: 'HYPE', token: 1105, total: 0.52210001, hold: 0 },
  ]);
});

test('accountState reads an unfunded address as zeros, since the endpoint answers 200 and not 404', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { type: string };
    return jsonResponse(body.type === 'clearinghouseState' ? EMPTY_PERP : { balances: [] });
  };

  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'testnet', keysPath: KEYS, evm: port, fetchImpl });
  const state = await rail.accountState(WALLET);

  assert.equal(state.accountValueUsd, 0);
  assert.equal(state.funded, false);
  assert.deepEqual(state.spot, []);
});

test('accountState uses the mainnet info endpoint when the app is on mainnet', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { type: string };
    return jsonResponse(body.type === 'clearinghouseState' ? EMPTY_PERP : { balances: [] });
  };

  const { port } = fakePort();
  const rail = hlDepositRail({ network: 'mainnet', keysPath: KEYS, evm: port, fetchImpl });
  await rail.accountState(WALLET);

  assert.deepEqual(new Set(urls), new Set(['https://api.hyperliquid.xyz/info']));
});

test('accountState throws on a non-address and on a failed request', async () => {
  const { port } = fakePort();
  const failing = hlDepositRail({
    network: 'testnet',
    keysPath: KEYS,
    evm: port,
    fetchImpl: async () => jsonResponse({ error: 'nope' }, false, 500),
  });

  await assert.rejects(() => failing.accountState('not-an-address'), /is not an address/);
  await assert.rejects(() => failing.accountState(WALLET), /hyperliquid clearinghouseState failed: 500/);
});
