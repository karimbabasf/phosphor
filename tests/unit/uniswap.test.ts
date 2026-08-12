// Uniswap v3 rail. Everything here runs offline: the encoders are checked against calldata
// assembled by hand from the ABI spec rather than against viem, which would only prove
// viem agrees with itself, and the pool maths is checked against an independent oracle.
//
// The live half of the proof (real quoter response, real position decode) is a separate
// read-only script; it needs a network and so has no business in the test run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  amountsForLiquidity,
  collectCalldata,
  decimalString,
  decreaseLiquidityCalldata,
  fromBaseUnits,
  increaseLiquidityCalldata,
  liquidityForAmounts,
  mintCalldata,
  readPositions,
  removeAndCollectCalldata,
  sqrtRatioAtTick,
  swapCalldata,
  toBaseUnits,
  uniswapLpAddRail,
  uniswapLpRemoveRail,
  uniswapSwapRail,
} from '../../src/rails/uniswap.ts';
import { chainsWithDeployment, deploymentFor, tickSpacingFor, tokenFor } from '../../src/rails/uniswap-abi.ts';
import type { AppConfig, LpAddDraft, LpRemoveDraft, SwapDraft } from '../../src/types.ts';

// ---------- hand-built calldata ----------

const MASK = (1n << 256n) - 1n;

// One 32-byte ABI word. Negative values wrap, which is two's complement sign extension:
// the thing an int24 tick needs and the thing a 3-byte truncation would get wrong.
function word(value: bigint): string {
  return (value & MASK).toString(16).padStart(64, '0');
}

function addressWord(value: string): string {
  return word(BigInt(value));
}

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH = '0x4200000000000000000000000000000000000006';
const WALLET = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4'; // Base Sepolia SwapRouter02
const NPM = '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2'; // Base Sepolia position manager

test('swapCalldata is SwapRouter02 exactInputSingle: selector 0x04e45aaf and seven static words, no deadline', () => {
  const data = swapCalldata({
    tokenIn: USDC,
    tokenOut: WETH,
    fee: 3000,
    recipient: WALLET,
    amountIn: 100_000000n,
    amountOutMinimum: 500_000000000000000n,
  });

  const expected =
    '0x04e45aaf' +
    addressWord(USDC) +
    addressWord(WETH) +
    word(3000n) +
    addressWord(WALLET) +
    word(100_000000n) +
    word(500_000000000000000n) +
    word(0n); // sqrtPriceLimitX96: no price limit, amountOutMinimum is the only floor

  assert.equal(data.toLowerCase(), expected.toLowerCase());
  // 4 + 7*32. The older SwapRouter takes a deadline too and would be 4 + 8*32.
  assert.equal((data.length - 2) / 2, 4 + 7 * 32);
});

test('mintCalldata sign-extends negative ticks across the full 32-byte word', () => {
  const data = mintCalldata({
    token0: USDC,
    token1: WETH,
    fee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired: 1_000000n,
    amount1Desired: 5_000000000000000n,
    amount0Min: 990000n,
    amount1Min: 4_950000000000000n,
    recipient: WALLET,
    deadline: 1786500000n,
  });

  const expected =
    '0x88316456' +
    addressWord(USDC) +
    addressWord(WETH) +
    word(3000n) +
    word(-887220n) +
    word(887220n) +
    word(1_000000n) +
    word(5_000000000000000n) +
    word(990000n) +
    word(4_950000000000000n) +
    addressWord(WALLET) +
    word(1786500000n);

  assert.equal(data.toLowerCase(), expected.toLowerCase());
  assert.equal((data.length - 2) / 2, 4 + 11 * 32);
  // The negative tick is 0xffff...-padded, not truncated to three bytes.
  assert.ok(data.toLowerCase().includes('f'.repeat(50)), 'tickLower should be sign-extended with leading f');
});

test('increaseLiquidity, decreaseLiquidity and collect encode to their verified selectors and word counts', () => {
  const increase = increaseLiquidityCalldata({
    tokenId: 81547n,
    amount0Desired: 1_000000n,
    amount1Desired: 2n,
    amount0Min: 3n,
    amount1Min: 4n,
    deadline: 1786500000n,
  });
  assert.equal(
    increase.toLowerCase(),
    ('0x219f5d17' + word(81547n) + word(1_000000n) + word(2n) + word(3n) + word(4n) + word(1786500000n)).toLowerCase(),
  );

  const decrease = decreaseLiquidityCalldata({ tokenId: 81547n, liquidity: 123456789n, amount0Min: 1n, amount1Min: 2n, deadline: 1786500000n });
  assert.equal(
    decrease.toLowerCase(),
    ('0x0c49ccbe' + word(81547n) + word(123456789n) + word(1n) + word(2n) + word(1786500000n)).toLowerCase(),
  );

  const max128 = (1n << 128n) - 1n;
  const collect = collectCalldata({ tokenId: 81547n, recipient: WALLET, amount0Max: max128, amount1Max: max128 });
  assert.equal(collect.toLowerCase(), ('0xfc6f7865' + word(81547n) + addressWord(WALLET) + word(max128) + word(max128)).toLowerCase());
  assert.equal((collect.length - 2) / 2, 4 + 4 * 32);
});

test('removeAndCollectCalldata wraps decrease then collect in one multicall(bytes[])', () => {
  const decrease = decreaseLiquidityCalldata({ tokenId: 7n, liquidity: 500n, amount0Min: 1n, amount1Min: 2n, deadline: 99n });
  const max128 = (1n << 128n) - 1n;
  const collect = collectCalldata({ tokenId: 7n, recipient: WALLET, amount0Max: max128, amount1Max: max128 });

  const data = removeAndCollectCalldata({ tokenId: 7n, liquidity: 500n, amount0Min: 1n, amount1Min: 2n, recipient: WALLET, deadline: 99n });

  // multicall(bytes[]) is the one dynamic encode on this path: head offset, array length,
  // one offset per element, then each element as length plus right-padded bytes.
  const decreaseBody = decrease.slice(2);
  const collectBody = collect.slice(2);
  const pad = (hex: string): string => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const expected =
    '0xac9650d8' +
    word(0x20n) + // offset to the array
    word(2n) + // two calls
    word(0x40n) + // offset of element 0, relative to the start of the array data
    word(BigInt(0x40 + 32 + pad(decreaseBody).length / 2)) + // offset of element 1
    word(BigInt(decreaseBody.length / 2)) +
    pad(decreaseBody) +
    word(BigInt(collectBody.length / 2)) +
    pad(collectBody);

  assert.equal(data.toLowerCase(), expected.toLowerCase());
  // Order matters: decreasing without collecting leaves the principal stuck in the NFT.
  assert.ok(data.toLowerCase().indexOf('0c49ccbe') < data.toLowerCase().indexOf('fc6f7865'));
});

// ---------- base units ----------

test('toBaseUnits keeps 18-decimal amounts exact where the float route invents digits', () => {
  // The case that bites. Math.round(12345.678 * 1e18) is 12345678000000000327680:
  // 327680 base units nobody typed, because the product is far past MAX_SAFE_INTEGER.
  assert.equal(toBaseUnits(12345.678, 18), 12345678000000000000000n);
  assert.notEqual(toBaseUnits(12345.678, 18), BigInt(Math.round(12345.678 * 10 ** 18)));

  assert.equal(toBaseUnits(1234.5678901234567, 18), 1234567890123456700000n);
  assert.equal(toBaseUnits(0.3, 18), 300000000000000000n);
  assert.equal(toBaseUnits(0.1, 18), 100000000000000000n);
  assert.equal(toBaseUnits(1, 18), 10n ** 18n);
  assert.equal(toBaseUnits(0, 18), 0n);
  assert.equal(toBaseUnits(100, 6), 100_000000n);
  assert.equal(toBaseUnits(0.000001, 6), 1n);
});

test('decimalString expands the exponential notation parseUnits cannot read', () => {
  assert.equal(decimalString(1e-7), '0.0000001');
  assert.equal(decimalString(1e-18), '0.000000000000000001');
  assert.equal(decimalString(1e21), '1000000000000000000000');
  assert.equal(decimalString(1.5e-8), '0.000000015');
  assert.equal(decimalString(0.3), '0.3');
  assert.equal(toBaseUnits(1e-18, 18), 1n);
  assert.equal(toBaseUnits(1e21, 18), 10n ** 39n);
});

test('toBaseUnits refuses amounts it cannot represent instead of silently sending zero', () => {
  // 1e-7 USDC is a tenth of a base unit. Rounding it to 0 would broadcast a transaction
  // that moves nothing while the proposal claims it moved something.
  assert.throws(() => toBaseUnits(1e-7, 6), /smaller than one base unit/);
  assert.throws(() => toBaseUnits(-1, 18), /negative/);
  assert.throws(() => toBaseUnits(Number.NaN, 18), /finite/);
  assert.throws(() => toBaseUnits(Number.POSITIVE_INFINITY, 18), /finite/);
});

test('fromBaseUnits inverts toBaseUnits for amounts a UI can produce', () => {
  for (const amount of [0.3, 1, 12345.678, 0.000001, 1234.5678901234567]) {
    assert.equal(fromBaseUnits(toBaseUnits(amount, 18), 18), amount);
  }
  assert.equal(fromBaseUnits(100_000000n, 6), 100);
});

// ---------- TickMath ----------

test('sqrtRatioAtTick matches sqrt(1.0001^t) * 2^96 across the whole tick range', () => {
  let worst = 0;
  let worstTick = 0;
  for (let tick = -887272; tick <= 887272; tick += 1013) {
    const got = Number(sqrtRatioAtTick(tick));
    const want = Math.sqrt(1.0001 ** tick) * 2 ** 96;
    const relative = Math.abs(got - want) / want;
    if (relative > worst) {
      worst = relative;
      worstTick = tick;
    }
  }
  // A single wrong hex digit in any of the twenty constants moves the result by orders of
  // magnitude, not by 1e-9. This tolerance is float noise, nothing else.
  assert.ok(worst < 1e-8, `worst relative error ${worst} at tick ${worstTick}`);
});

test('sqrtRatioAtTick hits the published boundary constants exactly', () => {
  assert.equal(sqrtRatioAtTick(0), 1n << 96n);
  assert.equal(sqrtRatioAtTick(-887272), 4295128739n);
  assert.equal(sqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342n);
});

test('sqrtRatioAtTick is strictly increasing and brackets a live pool reading', () => {
  let previous = 0n;
  for (let tick = -600; tick <= 600; tick += 3) {
    const value = sqrtRatioAtTick(tick);
    assert.ok(value > previous, `tick ${tick} did not increase`);
    previous = value;
  }
  // Base Sepolia USDC/WETH 0.3%, pool 0x46880b40..., read 2026-08-12: slot0 gave
  // tick 225120 with this sqrtPriceX96. The tick a pool reports must bracket its own price.
  const sqrtPriceX96 = 6124269831589200400359265589722818n;
  assert.ok(sqrtRatioAtTick(225120) <= sqrtPriceX96);
  assert.ok(sqrtPriceX96 < sqrtRatioAtTick(225121));
});

test('sqrtRatioAtTick refuses ticks outside the representable range', () => {
  assert.throws(() => sqrtRatioAtTick(887273), /outside/);
  assert.throws(() => sqrtRatioAtTick(-887273), /outside/);
  assert.throws(() => sqrtRatioAtTick(1.5), /outside/);
});

// ---------- LiquidityAmounts ----------

test('amountsForLiquidity puts a position entirely on one side when the price is outside its range', () => {
  const lower = sqrtRatioAtTick(-60);
  const upper = sqrtRatioAtTick(60);
  const liquidity = 10n ** 18n;

  const below = amountsForLiquidity(sqrtRatioAtTick(-120), lower, upper, liquidity);
  assert.ok(below.amount0 > 0n);
  assert.equal(below.amount1, 0n);

  const above = amountsForLiquidity(sqrtRatioAtTick(120), lower, upper, liquidity);
  assert.equal(above.amount0, 0n);
  assert.ok(above.amount1 > 0n);

  const inside = amountsForLiquidity(sqrtRatioAtTick(0), lower, upper, liquidity);
  assert.ok(inside.amount0 > 0n && inside.amount1 > 0n);
});

test('liquidityForAmounts round-trips through amountsForLiquidity without ever over-reporting', () => {
  const lower = sqrtRatioAtTick(-6000);
  const upper = sqrtRatioAtTick(6000);
  const cases = [
    { sqrtP: sqrtRatioAtTick(0), amount0: 1000_000000n, amount1: 5_000000000000000000n },
    { sqrtP: sqrtRatioAtTick(-9000), amount0: 1000_000000n, amount1: 5_000000000000000000n },
    { sqrtP: sqrtRatioAtTick(9000), amount0: 1000_000000n, amount1: 5_000000000000000000n },
  ];
  for (const c of cases) {
    const liquidity = liquidityForAmounts(c.sqrtP, lower, upper, c.amount0, c.amount1);
    assert.ok(liquidity > 0n);
    const back = amountsForLiquidity(c.sqrtP, lower, upper, liquidity);
    // Integer division rounds down, so the amounts needed never exceed the amounts offered.
    // The other direction would make every mint revert on its own slippage check.
    assert.ok(back.amount0 <= c.amount0, `amount0 ${back.amount0} exceeded ${c.amount0}`);
    assert.ok(back.amount1 <= c.amount1, `amount1 ${back.amount1} exceeded ${c.amount1}`);
  }
});

test('liquidityForAmounts is bounded by the scarcer side inside the range', () => {
  const lower = sqrtRatioAtTick(-6000);
  const upper = sqrtRatioAtTick(6000);
  const sqrtP = sqrtRatioAtTick(0);
  const balanced = liquidityForAmounts(sqrtP, lower, upper, 1000_000000n, 5_000000000000000000n);
  const starvedOnSide0 = liquidityForAmounts(sqrtP, lower, upper, 1_000000n, 5_000000000000000000n);
  assert.ok(starvedOnSide0 < balanced);
});

// ---------- deployment and registry ----------

test('deploymentFor only answers for chains with a verified deployment', () => {
  assert.equal(deploymentFor('testnet', 'base').positionManager, NPM);
  assert.equal(deploymentFor('testnet', 'arb').positionManager, '0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65');
  assert.equal(deploymentFor('mainnet', 'base').positionManager, '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1');
  assert.throws(() => deploymentFor('testnet', 'eth'), /no verified deployment/);
  assert.throws(() => deploymentFor('testnet', 'near'), /no verified deployment/);
  assert.throws(() => deploymentFor('mainnet', 'arb'), /no verified deployment/);
  assert.deepEqual(chainsWithDeployment('testnet').sort(), ['arb', 'base']);
});

test('the token registry keeps the two testnet chains apart', () => {
  assert.equal(tokenFor('testnet', 'base', 'USDC').address, USDC);
  assert.equal(tokenFor('testnet', 'arb', 'USDC').address, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
  assert.equal(tokenFor('testnet', 'arb', 'WETH').address, '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73');
  // token0 must be the lower address or mint reverts, on both chains.
  assert.ok(BigInt(tokenFor('testnet', 'arb', 'USDC').address) < BigInt(tokenFor('testnet', 'arb', 'WETH').address));
  assert.ok(BigInt(tokenFor('testnet', 'base', 'USDC').address) < BigInt(tokenFor('testnet', 'base', 'WETH').address));
});

test('tickSpacingFor carries the canonical spacings and rejects invented tiers', () => {
  assert.equal(tickSpacingFor(100), 1);
  assert.equal(tickSpacingFor(500), 10);
  assert.equal(tickSpacingFor(3000), 60);
  assert.equal(tickSpacingFor(10000), 200);
  assert.throws(() => tickSpacingFor(2500), /unknown uniswap-v3 fee tier/);
});

test('tokenFor will not pass native ETH off as WETH', () => {
  assert.equal(tokenFor('testnet', 'base', 'usdc').decimals, 6);
  assert.equal(tokenFor('testnet', 'base', 'WETH').address, '0x4200000000000000000000000000000000000006');
  assert.throws(() => tokenFor('testnet', 'base', 'ETH'), /must be wrapped to WETH/);
});

// ---------- rail validation, all offline ----------

const cfg: AppConfig = {
  mode: 'live',
  network: 'testnet',
  approvalGate: true,
  port: 4177,
  addresses: { evm: [WALLET], solana: [], near: [] },
  economicTransferUsd: 10,
  candleProducts: [],
  dataDir: '/tmp/phosphor-test',
  keysPath: '/tmp/phosphor-test-keys.json',
};

function swapDraft(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'uniswap-v3',
    chain: 'base',
    toChain: 'base',
    fromSymbol: 'USDC',
    toSymbol: 'WETH',
    amountIn: 100,
    amountUsd: 100,
    minAmountOut: 0.5,
    from: WALLET,
    to: WALLET,
    counterparty: ROUTER,
    quote: null,
    ...over,
  };
}

test('the swap rail refuses a draft with no slippage floor, before any network call', async () => {
  const result = await uniswapSwapRail(cfg).simulate(swapDraft({ minAmountOut: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.summary, /no slippage floor/);
});

test('the swap rail refuses another venue, a cross-chain draft and an unknown token', async () => {
  const rail = uniswapSwapRail(cfg);

  const wrongVenue = await rail.simulate(swapDraft({ venue: 'oneclick' }));
  assert.equal(wrongVenue.ok, false);
  assert.match(wrongVenue.summary, /this rail is uniswap-v3/);

  const crossChain = await rail.simulate(swapDraft({ toChain: 'arb' }));
  assert.equal(crossChain.ok, false);
  assert.match(crossChain.summary, /same-chain venue/);

  const unknown = await rail.simulate(swapDraft({ toSymbol: 'WBTC' }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /does not know token WBTC/);
});

test('rail.valueUsd is the draft amount the policy budgets read', () => {
  assert.equal(uniswapSwapRail(cfg).valueUsd(swapDraft({ amountUsd: 250 })), 250);
  assert.equal(uniswapSwapRail(cfg).valueUsd(swapDraft({ amountUsd: Number.NaN })), 0);
  assert.equal(uniswapSwapRail(cfg).kind, 'swap');
  assert.equal(uniswapLpAddRail(cfg).kind, 'lp_add');
  assert.equal(uniswapLpRemoveRail(cfg).kind, 'lp_remove');
});

function addDraft(over: Partial<LpAddDraft> = {}): LpAddDraft {
  return {
    kind: 'lp_add',
    chain: 'base',
    venue: 'uniswap-v3',
    poolId: '0x46880b404CD35c165EDdefF7421019F8dD25F4Ad',
    token0: { symbol: 'USDC', tokenId: USDC, amount: 100, decimals: 6 },
    token1: { symbol: 'WETH', tokenId: WETH, amount: 0.5, decimals: 18 },
    feeTier: 3000,
    tickLower: 224940,
    tickUpper: 225300,
    amountUsd: 200,
    from: WALLET,
    counterparty: NPM,
    ...over,
  };
}

test('the lp_add rail rejects a reversed pair and says how to fix the range', async () => {
  const reversed = addDraft({
    token0: { symbol: 'WETH', tokenId: WETH, amount: 0.5, decimals: 18 },
    token1: { symbol: 'USDC', tokenId: USDC, amount: 100, decimals: 6 },
  });
  const result = await uniswapLpAddRail(cfg).simulate(reversed);
  assert.equal(result.ok, false);
  assert.match(result.summary, /must sort below/);
  // The advice has to invert the range, not just swap the pair: ticks are token1 per token0.
  assert.match(result.summary, /\[-225300, -224940\]/);
});

test('the lp_add rail rejects ticks off the tier spacing and an upside-down range', async () => {
  const rail = uniswapLpAddRail(cfg);

  const misaligned = await rail.simulate(addDraft({ tickLower: 224941 }));
  assert.equal(misaligned.ok, false);
  assert.match(misaligned.summary, /multiples of 60/);

  const inverted = await rail.simulate(addDraft({ tickLower: 225300, tickUpper: 224940 }));
  assert.equal(inverted.ok, false);
  assert.match(inverted.summary, /must be below/);

  const wrongVenue = await rail.simulate(addDraft({ venue: 'ref-finance' }));
  assert.equal(wrongVenue.ok, false);
  assert.match(wrongVenue.summary, /this rail is uniswap-v3/);
});

function removeDraft(over: Partial<LpRemoveDraft> = {}): LpRemoveDraft {
  return { kind: 'lp_remove', chain: 'base', venue: 'uniswap-v3', positionId: '81547', liquidityPct: 0.5, amountUsd: 100, from: WALLET, counterparty: NPM, ...over };
}

test('the lp_remove rail rejects a percentage outside (0, 1] and a non-numeric position id', async () => {
  const rail = uniswapLpRemoveRail(cfg);

  for (const pct of [0, -0.1, 1.5, 100]) {
    const result = await rail.simulate(removeDraft({ liquidityPct: pct }));
    assert.equal(result.ok, false, `liquidityPct ${pct} should be refused`);
    assert.match(result.summary, /liquidityPct must be in/);
  }

  const badId = await rail.simulate(removeDraft({ positionId: '0xdeadbeef' }));
  assert.equal(badId.ok, false);
  assert.match(badId.summary, /is not a token id/);
});

test('readPositions reports a bad owner through onError and returns an empty list, never a throw', async () => {
  const errors: string[] = [];
  const positions = await readPositions('testnet', 'not-an-address', { onError: m => errors.push(m) });
  assert.deepEqual(positions, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid address/);
});
