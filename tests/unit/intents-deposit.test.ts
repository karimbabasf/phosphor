// The intents-deposit rail, tested against a mocked API and a mocked chain. Nothing here
// touches the network and nothing here reads a key: both ports are stubbed, so no test can
// reach a real RPC or a real signer by forgetting to override something.
//
// What this suite is about. The oneclick rail moves ERC-20 tokens, so the asset it spends and
// the asset it pays gas with are different balances and a bug can only cost the amount. This
// rail sends the gas asset itself, which adds one failure mode the repo has never had: a
// deposit large enough to leave nothing behind bricks the wallet, and the funds that would
// rescue it are the ones that just left. Most of what follows is about that, and about the
// account id being credited, which is the other thing here that cannot be undone.
//
// Run: node --test tests/unit/intents-deposit.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';

import type { IntentsDepositDraft, Network } from '../../src/types.ts';
import type { OneClickClient, OneClickQuote, OneClickToken, TokensFile } from '../../src/intents.ts';
import type { SendParams } from '../../src/chain/evm.ts';
import {
  DEPOSIT_MAX_LOSS_BPS,
  INTENTS_DEPOSIT_COUNTERPARTY,
  NATIVE_GAS_RESERVE_FLOOR_WEI,
  NATIVE_GAS_RESERVE_MULTIPLE,
  intentsDepositRail,
  minCreditedFor,
} from '../../src/rails/intents-deposit.ts';
import type { DepositEvmPort } from '../../src/rails/intents-deposit.ts';

// ---------- fixtures ----------

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const DEPOSIT_ADDRESS = getAddress('0x097917BE02B57a7a8EB08BDB65fcEA7D0bAd496b');

// The real ids from the live 1Click token list, checked 2026-08-13. Native ETH on ethereum
// carries NO contractAddress field, which is the whole reason nativeAssetIdFor exists.
const ETH_ASSET = 'nep141:eth.omft.near';
const USDC_ASSET = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

const apiTokens: OneClickToken[] = [
  { assetId: ETH_ASSET, decimals: 18, blockchain: 'eth', symbol: 'ETH' },
  {
    assetId: USDC_ASSET,
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
];

const tokensFixture: TokensFile = {
  eth: { USDC: { tokenId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 } },
  base: {},
  arb: {},
  sol: {},
  near: {},
};

// $10 of ETH at the price the live quote was taken against.
const AMOUNT = 0.005319120642975303;
const AMOUNT_WEI = 5319120642975303n;

const NOW = Date.parse('2026-08-13T03:00:00.000Z');

function draftOf(over: Partial<IntentsDepositDraft> = {}): IntentsDepositDraft {
  return {
    kind: 'intents_deposit',
    chain: 'eth',
    symbol: 'ETH',
    tokenId: 'native',
    amount: AMOUNT,
    amountUsd: 10,
    minCredited: minCreditedFor(AMOUNT),
    from: OWNER,
    intentsAccount: OWNER.toLowerCase(),
    counterparty: INTENTS_DEPOSIT_COUNTERPARTY,
    ...over,
  };
}

// The numbers the live API actually returned for this deposit, so the fixture cannot be
// quietly friendlier than the real thing.
function quoteOf(over: Record<string, unknown> = {}): OneClickQuote {
  return {
    amountIn: AMOUNT_WEI.toString(),
    amountInFormatted: '0.005319120642975303',
    amountInUsd: '10.005212738230',
    minAmountIn: AMOUNT_WEI.toString(),
    amountOut: '5313801522332327',
    amountOutFormatted: '0.005313801522332327',
    amountOutUsd: '9.995207525492',
    minAmountOut: '5260663507109003',
    timeEstimate: 45,
    depositAddress: DEPOSIT_ADDRESS,
    ...over,
  } as OneClickQuote;
}

type Harness = {
  client: OneClickClient;
  evm: DepositEvmPort;
  quotes: Array<Record<string, unknown>>;
  sends: SendParams[];
  balance: bigint;
  gasCost: bigint;
};

function harness(
  options: {
    quote?: OneClickQuote;
    balance?: bigint;
    gasCost?: bigint;
    sendOk?: boolean;
    statuses?: string[];
  } = {},
): Harness {
  const quotes: Array<Record<string, unknown>> = [];
  const sends: SendParams[] = [];
  const statuses = options.statuses ?? ['SUCCESS'];
  let statusCalls = 0;

  const h: Harness = {
    quotes,
    sends,
    balance: options.balance ?? 7737010954683496n, // the real mainnet balance, ~$14.55
    gasCost: options.gasCost ?? 1890000000000n, // 21000 gas at 0.09 gwei
    client: {
      async tokens() {
        return apiTokens;
      },
      async quote(params) {
        quotes.push(params as unknown as Record<string, unknown>);
        return { quote: options.quote ?? quoteOf(), raw: {} };
      },
      async submitDeposit() {
        return { ok: true, detail: 'deposit notified' };
      },
      async status() {
        const name = statuses[Math.min(statusCalls, statuses.length - 1)];
        statusCalls += 1;
        return {
          found: true,
          status: name as never,
          reported: name,
          originTxHashes: [],
          destinationTxHashes: [],
        };
      },
    },
    evm: {
      signerAddress: () => OWNER,
      async send(params) {
        sends.push(params);
        return options.sendOk === false
          ? { ok: false, error: 'insufficient funds for gas * price + value' }
          : { ok: true, hash: '0xdeadbeef', explorer: 'https://etherscan.io/tx/0xdeadbeef', gasUsed: '21000' };
      },
      async nativeBalance() {
        return h.balance;
      },
      async estimateNativeSendGas() {
        return h.gasCost;
      },
    },
  };
  return h;
}

function railOf(h: Harness, network: Network = 'mainnet') {
  return intentsDepositRail({
    network,
    keysPath: '/nonexistent/keys.json', // never read: the evm port is stubbed
    tokens: tokensFixture,
    client: h.client,
    evm: h.evm,
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
  });
}

// ---------- the routing fields, which are what make this a deposit at all ----------

test('the quote asks for an INTENTS recipient and the same asset on both sides', async () => {
  const h = harness();
  const result = await railOf(h).simulate(draftOf());

  assert.equal(result.ok, true, result.summary);
  assert.equal(h.quotes.length, 1);
  const q = h.quotes[0];
  assert.equal(q.recipientType, 'INTENTS');
  assert.equal(q.recipient, OWNER.toLowerCase());
  // A deposit does not change the asset. If these ever differ it is a swap wearing a
  // deposit's name, and the amount checks would not catch it.
  assert.equal(q.originAsset, ETH_ASSET);
  assert.equal(q.destinationAsset, ETH_ASSET);
  // The funds arrive by ordinary transfer, which is what keeps this key-free.
  assert.equal(q.depositType, 'ORIGIN_CHAIN');
  assert.equal(q.refundType, 'ORIGIN_CHAIN');
  assert.equal(q.refundTo, OWNER);
  // simulate must never mint a deposit address.
  assert.equal(q.dry, true);
});

test('the credited account is the wallet lowercased, which is what the verifier derives', async () => {
  const h = harness();
  await railOf(h).execute(draftOf());
  assert.equal(h.quotes.at(-1)?.recipient, OWNER.toLowerCase());
});

// ---------- the native gas reserve: the failure this rail invented ----------

test('a deposit that would leave no gas behind is refused, and says how much would fit', async () => {
  // Balance barely above the deposit: enough to pay for this one send and nothing after it.
  const h = harness({ balance: AMOUNT_WEI + 1000n, gasCost: 1890000000000n });
  const result = await railOf(h).simulate(draftOf());

  assert.equal(result.ok, false);
  assert.match(result.summary, /without enough of its own gas asset/);
  assert.match(result.summary, /Deposit at most/);
  // Refused before anything was signed.
  assert.equal(h.sends.length, 0);
});

test('when gas is expensive the reserve scales with it, not merely one send of it', async () => {
  // High enough that the multiple beats the absolute floor: 5 * 1e15 > 0.00126 ETH.
  const gasCost = 1_000_000_000_000_000n;
  assert.ok(gasCost * NATIVE_GAS_RESERVE_MULTIPLE > (NATIVE_GAS_RESERVE_FLOOR_WEI.eth as bigint));

  // Exactly one gas cost of headroom. A 1x reserve would allow this; the point is that a
  // wallet which can pay for the transfer it just made and nothing after it is still bricked.
  const tight = harness({ balance: AMOUNT_WEI + gasCost, gasCost });
  assert.equal(await railOf(tight).simulate(draftOf()).then((r) => r.ok), false);

  // Exactly the reserve is the boundary, and it passes.
  const ok = harness({ balance: AMOUNT_WEI + gasCost * NATIVE_GAS_RESERVE_MULTIPLE, gasCost });
  assert.equal(await railOf(ok).simulate(draftOf()).then((r) => r.ok), true);
});

test('when gas is absurdly cheap the absolute floor takes over, so the guard still guards', async () => {
  // The real mainnet gas price on 2026-08-13: 0.09 gwei, so a send cost 0.0000019 ETH and
  // five of them come to about a third of a cent. Without a floor, a deposit could take all
  // but $0.02 of the wallet and this check would call it safe.
  const gasCost = 1_890_000_000_000n;
  const floor = NATIVE_GAS_RESERVE_FLOOR_WEI.eth as bigint;
  assert.ok(gasCost * NATIVE_GAS_RESERVE_MULTIPLE < floor, 'this test is pointless unless the floor dominates');

  const justUnder = harness({ balance: AMOUNT_WEI + floor - 1n, gasCost });
  assert.equal(await railOf(justUnder).simulate(draftOf()).then((r) => r.ok), false);

  const atFloor = harness({ balance: AMOUNT_WEI + floor, gasCost });
  assert.equal(await railOf(atFloor).simulate(draftOf()).then((r) => r.ok), true);
});

test('the real balance leaves room for a $10 deposit but not for the whole wallet', async () => {
  // The live numbers on 2026-08-13: 0.00773701 ETH held, ~$1880 an ETH.
  const balance = 7737010954683496n;
  const gasCost = 1_890_000_000_000n;

  const ten = harness({ balance, gasCost });
  assert.equal(await railOf(ten).simulate(draftOf()).then((r) => r.ok), true);

  // Nearly the whole balance. This is the case the floor exists for: it passed before the
  // floor was added, because five times a 0.09 gwei send is not a reserve.
  const nearlyAll = harness({
    balance,
    gasCost,
    quote: quoteOf({ amountIn: '7700000000000000', minAmountOut: '7615377000000000' }),
  });
  const result = await railOf(nearlyAll).simulate(
    draftOf({ amount: 0.0077, minCredited: minCreditedFor(0.0077) }),
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /without enough of its own gas asset/);
});

test('execute re-checks the reserve against the real deposit address before signing', async () => {
  const h = harness();
  // Simulate passes, then the balance moves under us before execution.
  assert.equal(await railOf(h).simulate(draftOf()).then((r) => r.ok), true);
  h.balance = AMOUNT_WEI;

  await assert.rejects(() => railOf(h).execute(draftOf()), /without enough of its own gas asset/);
  assert.equal(h.sends.length, 0);
});

test('an ERC-20 deposit is not held to the native reserve, because it does not spend gas', async () => {
  const h = harness({
    balance: 0n, // no ETH at all, which would refuse a native deposit outright
    quote: quoteOf({ amountIn: '10000000', minAmountOut: '9900000', amountOutFormatted: '9.9' }),
  });
  const draft = draftOf({
    symbol: 'USDC',
    tokenId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    amount: 10,
    minCredited: minCreditedFor(10),
  });

  const result = await railOf(h).simulate(draft);
  assert.equal(result.ok, true, result.summary);
});

// ---------- what actually gets signed ----------

test('a native deposit sends value with empty calldata, never an erc20 transfer', async () => {
  const h = harness();
  const result = await railOf(h).execute(draftOf());

  assert.equal(result.ok, true, result.detail);
  assert.equal(h.sends.length, 1);
  const sent = h.sends[0];
  assert.equal(sent.to, DEPOSIT_ADDRESS);
  assert.equal(sent.value, AMOUNT_WEI);
  // The distinction that matters: calldata here would make this a contract call, and a
  // transfer() selector aimed at an EOA moves nothing while the value field is ignored.
  assert.equal(sent.data, '0x');
});

test('an erc20 deposit sends transfer calldata to the token, with no value', async () => {
  const h = harness({ quote: quoteOf({ amountIn: '10000000', minAmountOut: '9900000' }) });
  const draft = draftOf({
    symbol: 'USDC',
    tokenId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    amount: 10,
    minCredited: minCreditedFor(10),
  });

  await railOf(h).execute(draft);
  const sent = h.sends[0];
  assert.equal(sent.to, getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'));
  assert.equal(sent.value, undefined);
  assert.match(sent.data, /^0xa9059cbb/); // transfer(address,uint256)
  assert.ok(sent.data.toLowerCase().includes(DEPOSIT_ADDRESS.slice(2).toLowerCase()));
});

// ---------- refusing a quote that does not match what was approved ----------

test('a quote for a different amount is refused', async () => {
  const h = harness({ quote: quoteOf({ amountIn: '9999999999999999' }) });
  const result = await railOf(h).simulate(draftOf());

  assert.equal(result.ok, false);
  assert.match(result.summary, /not the .* the draft names/);
  await assert.rejects(() => railOf(h).execute(draftOf()), /does not match the approved draft/);
});

test('a solver floor below the draft floor is refused, so a one-wei credit cannot pass', async () => {
  const h = harness({ quote: quoteOf({ minAmountOut: '1' }) });
  const result = await railOf(h).simulate(draftOf());

  assert.equal(result.ok, false);
  assert.match(result.summary, /below the .* floor the draft names/);
});

test('the draft floor is derived from the app, and 200bps clears a real quote', async () => {
  // The live quote's own floor sits 1.096% under the input. A 100bps draft floor would
  // refuse every honest deposit, which is why the constant is not simply the slippage.
  const real = 5260663507109003n;
  const floorAt = (bps: number) => BigInt(Math.round(AMOUNT * (1 - bps / 10_000) * 1e18));
  assert.ok(floorAt(100) > real, 'a 100bps floor would refuse the real quote');
  assert.ok(floorAt(DEPOSIT_MAX_LOSS_BPS) < real, 'the shipped floor must clear the real quote');
});

test('a quote demanding a memo is refused, because an EVM transfer cannot carry one', async () => {
  const h = harness({ quote: quoteOf({ depositMemo: 'memo-required' }) });
  await assert.rejects(() => railOf(h).execute(draftOf()), /deposit memo/);
  assert.equal(h.sends.length, 0);
});

test('a deposit address that is not an address is refused', async () => {
  const h = harness({ quote: quoteOf({ depositAddress: 'not-an-address' }) });
  await assert.rejects(() => railOf(h).execute(draftOf()), /no usable deposit address/);
  assert.equal(h.sends.length, 0);
});

// ---------- the draft's own claims ----------

test('a draft crediting an account we cannot spend is refused before anything is sent', async () => {
  const h = harness();
  // A real balance, credited to an id this app holds no key for, is unrecoverable: it is not
  // lost on chain, it is owned by somebody else inside the verifier.
  const draft = draftOf({ intentsAccount: '0x4444444444444444444444444444444444444444' });

  await assert.rejects(() => railOf(h).execute(draft), /unrecoverable/);
  assert.equal(h.sends.length, 0);
});

test('a draft authored for another wallet is refused', async () => {
  const h = harness();
  const other = getAddress('0x2222222222222222222222222222222222222222');
  await assert.rejects(
    () => railOf(h).execute(draftOf({ from: other, intentsAccount: other.toLowerCase() })),
    /but the configured key is/,
  );
  assert.equal(h.sends.length, 0);
});

test('a draft naming another counterparty is refused', async () => {
  const h = harness();
  const result = await railOf(h).simulate(draftOf({ counterparty: 'intents.near' }));
  assert.equal(result.ok, false);
  assert.match(result.summary, /must name/);
});

test('a chain this app cannot sign for is refused, naming why', async () => {
  const h = harness();
  const result = await railOf(h).simulate(draftOf({ chain: 'sol', symbol: 'SOL' }));
  assert.equal(result.ok, false);
  assert.match(result.summary, /signs EVM transfers only/);
});

test('a draft claiming the wrong gas asset for its chain is refused', async () => {
  const h = harness();
  const result = await railOf(h).simulate(draftOf({ symbol: 'SOL' }));
  assert.equal(result.ok, false);
  assert.match(result.summary, /gas asset of eth is ETH/);
});

// ---------- network guard ----------

test('testnet refuses before any network call, and simulate says so before a human clicks', async () => {
  const h = harness();
  await assert.rejects(() => railOf(h, 'testnet').execute(draftOf()), /no testnet/i);
  assert.equal(h.quotes.length, 0);
  assert.equal(h.sends.length, 0);

  const result = await railOf(h, 'testnet').simulate(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.summary, /CANNOT EXECUTE on testnet/);
});

// ---------- reporting, where a wrong word costs a second deposit ----------

test('a poll timeout says the funds were sent, not that the deposit failed', async () => {
  const h = harness({ statuses: ['PENDING_DEPOSIT'] });
  const result = await railOf(h).execute(draftOf());

  assert.equal(result.ok, false);
  // The transfer confirmed, so the money is gone. Reporting this as a plain failure is how
  // someone sends the same amount twice.
  assert.match(result.detail, /THE FUNDS WERE SENT/);
  assert.ok(result.txids?.includes('0xdeadbeef'));
});

test('a failed transfer says plainly that nothing left the wallet', async () => {
  const h = harness({ sendOk: false });
  const result = await railOf(h).execute(draftOf());

  assert.equal(result.ok, false);
  assert.match(result.detail, /No funds left the wallet/);
});

test('success names the account credited and that the funds are no longer in the wallet', async () => {
  const h = harness();
  const result = await railOf(h).execute(draftOf());

  assert.equal(result.ok, true);
  assert.match(result.detail, new RegExp(OWNER.toLowerCase()));
  assert.match(result.detail, /intents\.near/);
});

test('simulate warns that credited funds are not in the wallet any more', async () => {
  const h = harness();
  const result = await railOf(h).simulate(draftOf());
  assert.match(result.summary, /NOT in this wallet/);
});
