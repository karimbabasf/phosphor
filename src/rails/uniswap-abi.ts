// Uniswap v3: deployment addresses and function shapes, kept apart from the rail logic so
// the two things that must never drift (what a function looks like, and the address it is
// sent to) sit on one screen.
//
// Nothing here was taken on trust. Every address was confirmed to hold bytecode on the
// chain it is listed for, and every function shape below was confirmed to appear in that
// bytecode's dispatch table before this file was written. That check caught one real trap:
// SwapRouter02's exactInputSingle takes NO deadline (selector 0x04e45aaf), where the older
// SwapRouter's does (0x414bf389). The deployed router answers only to the first.
//
// Selectors are never computed at runtime. parseAbi derives them from these strings with
// viem's audited keccak; node's crypto ships sha3-256, which is a different hash and would
// produce a plausible-looking selector that no contract answers to.

import { parseAbi } from 'viem';
import type { Address } from 'viem';
import type { ChainId, Network } from '../types.ts';

// ---------- deployments ----------

export type UniswapDeployment = {
  factory: Address;
  positionManager: Address; // NonfungiblePositionManager, "NPM" below
  quoter: Address; // QuoterV2
  router: Address; // SwapRouter02
  ethUsdFeed: Address; // Chainlink, 8 decimals, used to price the USD column
};

// Base only. The other EVM chains in this app have Uniswap deployments too, but none of
// them were verified here, and an unverified address in this table is how a rail sends
// money to a contract that is not what its name says. `deploymentFor` throws instead.
//
// Verified 2026-08-12 by eth_getCode plus an identity check on each side:
//   testnet  NPM.factory() -> 0x4752ba5D...  (matches), factory tick spacings 1/10/60/200
//   mainnet  NPM.factory() -> 0x33128a8f...  (matches)
// Note 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 is Base Sepolia's factory AND Base
// mainnet's SwapRouter02: same deployer and nonce on two chains. Addresses do not mean
// the same contract across chains, which is why each row was checked by behaviour.
const DEPLOYMENTS: Record<Network, Partial<Record<ChainId, UniswapDeployment>>> = {
  testnet: {
    base: {
      factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      positionManager: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
      quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
      router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
      ethUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    },
  },
  mainnet: {
    base: {
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      ethUsdFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    },
  },
};

export function deploymentFor(network: Network, chain: ChainId): UniswapDeployment {
  const found = DEPLOYMENTS[network][chain];
  if (found === undefined) {
    const known = Object.keys(DEPLOYMENTS[network]).join(', ') || 'none';
    throw new Error(`uniswap-v3 has no verified deployment for ${chain} on ${network} (verified: ${known})`);
  }
  return found;
}

// ---------- tokens ----------

export type TokenInfo = { symbol: string; address: Address; decimals: number };

// The venue's own registry rather than data/tokens.json, because an LP rail needs the two
// things that file does not carry: testnet addresses, and WETH. Symbols are matched
// case-insensitively by tokenFor().
const TOKENS: Record<Network, Partial<Record<ChainId, TokenInfo[]>>> = {
  testnet: {
    base: [
      { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    ],
  },
  mainnet: {
    base: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    ],
  },
};

export function tokensFor(network: Network, chain: ChainId): TokenInfo[] {
  return TOKENS[network][chain] ?? [];
}

// 'ETH' is deliberately NOT an alias for WETH. This rail moves the ERC-20; it does not
// wrap. Silently swapping one for the other produces "insufficient balance" against a
// wallet that visibly holds ETH, which is the most confusing error this rail could give.
export function tokenFor(network: Network, chain: ChainId, symbol: string): TokenInfo {
  const list = tokensFor(network, chain);
  const found = list.find(t => t.symbol.toLowerCase() === symbol.toLowerCase());
  if (found === undefined) {
    const known = list.map(t => t.symbol).join(', ') || 'none';
    const hint = symbol.toLowerCase() === 'eth' ? ' Native ETH must be wrapped to WETH first; this rail does not wrap.' : '';
    throw new Error(`uniswap-v3 does not know token ${symbol} on ${chain} ${network} (known: ${known}).${hint}`);
  }
  return found;
}

// ---------- fee tiers ----------

// Read live from factory.feeAmountTickSpacing on 2026-08-12 and matching the canonical
// v3 values, so a tick can be checked for alignment without an extra round trip.
export const FEE_TIERS: number[] = [100, 500, 3000, 10000];

const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export function tickSpacingFor(fee: number): number {
  const spacing = TICK_SPACING[fee];
  if (spacing === undefined) throw new Error(`unknown uniswap-v3 fee tier ${fee} (known: ${FEE_TIERS.join(', ')})`);
  return spacing;
}

// ---------- ABIs ----------

// SwapRouter02. exactInputSingle carries no deadline: that moved to multicall in 02.
export const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

// QuoterV2. Not a view function: it swaps and reverts, catching its own revert to return
// the number. eth_call runs it without persisting anything, which is why simulate() can
// use it without a key. Field order differs from QuoterV1: amountIn comes before fee.
export const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);

export const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
]);

export const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

// NonfungiblePositionManager. Every LP argument is a static ABI type, so a struct is just
// its fields concatenated as 32-byte words. multicall(bytes[]) is the one dynamic call
// here, and it is what makes decrease+collect a single atomic transaction.
export const NPM_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);

// Chainlink. `answer` is int256 and signed: decoding it as a uint turns a negative feed
// into an astronomically large price rather than an obvious error.
export const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
]);
