// The Aave v3 adapter: supply a stablecoin, read what it has become, take it back out.
//
// Why a lending pool and not the Uniswap v3 rail this repo already has, in one line: a
// range position's value moves with ETH, so over any window short enough to look at, the
// percentage on the screen would mostly be reporting the ETH move rather than the yield.
// The long version is in docs/superpowers/specs/2026-08-20-stablecoin-yield.md.
//
// The property that makes this venue worth the code: the aToken REBASES. balanceOf grows
// every block, denominated in the underlying. So "what is it worth now" is one eth_call and
// "what has it earned" is that minus the cost basis. There is no fee accounting, no
// collect(), no pricing of two tokens, and therefore nothing between the chain and the
// number on the screen that could be wrong.
//
// Every address in DEPLOYMENTS was checked by behaviour on 2026-08-20 and none was taken
// from a documentation page. See the header of the table.

import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import type { Address } from 'viem';
import type { ChainId, Network } from '../types.ts';
import { ERC20, erc20Allowance, reader } from '../chain/evm.ts';
import type { VenueAsset, VenueCall, VenuePosition, VenueRate, YieldVenue } from './venue.ts';
import { RAY, rateFromRay } from './venue.ts';

export const VENUE_ID = 'aave-v3';

// The account that receives the supply and is credited with the position. Always our own
// address: this adapter has no argument that can name a beneficiary, on the same principle
// as every rail in src/rails/. A caller cannot ask for the money to be credited elsewhere
// because there is no way to say it.

export const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
]);

export const ATOKEN_ABI = parseAbi([
  'function balanceOf(address user) view returns (uint256)',
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function symbol() view returns (string)',
]);

type AaveMarket = {
  pool: Address;
  assets: VenueAsset[];
};

// Verified 2026-08-20 by .probe/probe-aave.mjs and .probe/probe-crosscheck.mjs. The check
// for each row was the same one src/rails/uniswap-abi.ts uses: ask the contract to identify
// itself and refuse to believe an address that will not.
//
//   arb testnet   PoolAddressesProvider 0xB25a5D14....getPool() -> 0xBfC91D59...  MATCH
//                 marketId "Aave V3 Arbitrum Sepolia Testnet Market"
//                 aToken.UNDERLYING_ASSET_ADDRESS() -> 0x75faf114...              MATCH
//                 reserve active=1 frozen=0 paused=0, supplyCap 10,500,000 USDC,
//                 5,496,080 supplied, so 5,003,920 of headroom
//                 supply(0.10 USDC) simulated from our own address and reverted with
//                 "ERC20: transfer amount exceeds allowance", which is the ONLY thing
//                 standing between this table and a working deposit
//
//   base testnet  PoolAddressesProvider 0xd449FeD4....getPool() -> 0x07eA79F6...  MATCH
//                 marketId "Aave V3 BASE Testnet Market"
//                 reserve active=1 frozen=0 paused=0, 8,510,288 of headroom
//
// The USDC on arb testnet is the SAME address src/rails/uniswap-abi.ts already lists there.
// That is what makes this feature free to fund: the existing swap rail produces exactly the
// token this one consumes, on the chain the Hyperliquid rail already uses.
//
// Note there are TWO Aave test markets on Base Sepolia, one on Circle's USDC and one on
// Aave's own mock, and both aTokens are called aBasSepUSDC. The Circle one is listed here
// because it is the token the rest of this app already knows. The other market's mock USDC
// is 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f behind pool 0x8bAB6d1b...; it has a
// permissionless faucet, which the Circle one does not, and that is the one reason it might
// be worth adding later.
//
// Ethereum Sepolia was probed and is deliberately ABSENT. Its market reports 57 percent on
// USDC and 71 percent on DAI, which are artefacts of a testnet nobody arbitrages. A window
// whose headline number is 57 percent teaches the reader to distrust every other number in it.
//
// Mainnet is deliberately ABSENT. Adding a row here is the whole change needed to enable it,
// and that is meant to be a decision someone makes on purpose rather than a default they
// inherit.
const DEPLOYMENTS: Record<Network, Partial<Record<ChainId, AaveMarket>>> = {
  testnet: {
    arb: {
      pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
      assets: [
        {
          symbol: 'USDC',
          address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
          decimals: 6,
          receipt: '0x460b97BD498E1157530AEb3086301d5225b91216',
          receiptSymbol: 'aArbSepUSDC',
        },
      ],
    },
    base: {
      pool: '0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b',
      assets: [
        {
          symbol: 'USDC',
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          decimals: 6,
          receipt: '0xf53B60F4006cab2b3C4688ce41fD5362427A2A66',
          receiptSymbol: 'aBasSepUSDC',
        },
      ],
    },
  },
  mainnet: {},
};

export function marketFor(network: Network, chain: ChainId): AaveMarket {
  const found = DEPLOYMENTS[network][chain];
  if (found === undefined) {
    const known = Object.keys(DEPLOYMENTS[network]).join(', ') || 'none';
    throw new Error(`aave-v3 has no verified deployment for ${chain} on ${network} (verified: ${known})`);
  }
  return found;
}

export function aaveChains(network: Network): ChainId[] {
  return Object.keys(DEPLOYMENTS[network]) as ChainId[];
}

export function aaveAsset(network: Network, chain: ChainId, symbol: string): VenueAsset | null {
  const market = DEPLOYMENTS[network][chain];
  if (market === undefined) return null;
  return market.assets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
}

function requireAsset(network: Network, chain: ChainId, symbol: string): { market: AaveMarket; asset: VenueAsset } {
  const market = marketFor(network, chain);
  const asset = market.assets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
  if (asset === undefined) {
    const known = market.assets.map((a) => a.symbol).join(', ') || 'none';
    throw new Error(`aave-v3 on ${chain} ${network} does not take ${symbol} (takes: ${known})`);
  }
  return { market, asset };
}

// ---------- reads ----------

export async function aaveRate(network: Network, chain: ChainId, symbol: string): Promise<VenueRate> {
  const { market, asset } = requireAsset(network, chain, symbol);
  const data = await reader(network, chain).readContract({
    address: market.pool,
    abi: POOL_ABI,
    functionName: 'getReserveData',
    args: [getAddress(asset.address)],
  });
  return rateFromRay(data.currentLiquidityRate);
}

// The reserve's own health, read rather than assumed. A frozen or paused reserve still
// answers getReserveData and still reports a rate, so a rail that only read the rate would
// quote a number and then fail at signing time with a bare revert code. Reading the flags
// lets the refusal say which flag it was.
//
// Bit positions are from the Aave v3 ReserveConfiguration bitmap and are checked in
// tests/unit/aave-config.test.ts against the live reserves.
export type ReserveHealth = {
  active: boolean;
  frozen: boolean;
  paused: boolean;
  supplyCapUnits: bigint; // whole units of the asset; 0 means uncapped
};

export function decodeReserveHealth(configuration: bigint): ReserveHealth {
  return {
    active: ((configuration >> 56n) & 1n) === 1n,
    frozen: ((configuration >> 57n) & 1n) === 1n,
    paused: ((configuration >> 60n) & 1n) === 1n,
    supplyCapUnits: (configuration >> 116n) & ((1n << 36n) - 1n),
  };
}

export async function aaveHealth(network: Network, chain: ChainId, symbol: string): Promise<ReserveHealth> {
  const { market, asset } = requireAsset(network, chain, symbol);
  const data = await reader(network, chain).readContract({
    address: market.pool,
    abi: POOL_ABI,
    functionName: 'getReserveData',
    args: [getAddress(asset.address)],
  });
  return decodeReserveHealth(data.configuration);
}

export async function aavePosition(network: Network, chain: ChainId, symbol: string, owner: string): Promise<VenuePosition> {
  const { market, asset } = requireAsset(network, chain, symbol);
  const client = reader(network, chain);
  const who = getAddress(owner);
  const [balanceBase, scaledBase, indexRay] = await Promise.all([
    client.readContract({ address: getAddress(asset.receipt), abi: ATOKEN_ABI, functionName: 'balanceOf', args: [who] }),
    client.readContract({ address: getAddress(asset.receipt), abi: ATOKEN_ABI, functionName: 'scaledBalanceOf', args: [who] }),
    client.readContract({ address: market.pool, abi: POOL_ABI, functionName: 'getReserveNormalizedIncome', args: [getAddress(asset.address)] }),
  ]);
  return { balanceBase, scaledBase, indexRay };
}

// ---------- writes, as calldata only ----------

export async function aaveDepositCalls(args: {
  network: Network;
  chain: ChainId;
  symbol: string;
  owner: string;
  amountBase: bigint;
}): Promise<VenueCall[]> {
  const { market, asset } = requireAsset(args.network, args.chain, args.symbol);
  if (args.amountBase <= 0n) throw new Error('aave-v3 deposit amount must be above zero');

  const calls: VenueCall[] = [];
  const allowance = await erc20Allowance(args.network, args.chain, getAddress(asset.address), getAddress(args.owner), market.pool);

  // Approve the exact amount, not the unlimited approval most front ends default to.
  //
  // 1inch's Aqua docs are candid that their dApp sets type(uint256).max and that the real
  // cap is then the wallet balance, so a compromised signer reaches everything rather than
  // a deposited slice. This app holds the key that would be compromised, so it pays the
  // extra approval transaction per deposit and keeps the blast radius at one deposit.
  if (allowance < args.amountBase) {
    calls.push({
      to: getAddress(asset.address),
      data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [market.pool, args.amountBase] }),
      label: `approve Aave v3 pool for ${args.symbol}`,
    });
  }

  calls.push({
    to: market.pool,
    data: encodeFunctionData({
      abi: POOL_ABI,
      functionName: 'supply',
      // onBehalfOf is our own address and referralCode is 0. Neither is reachable from a
      // caller: there is no argument here that can redirect the credit.
      args: [getAddress(asset.address), args.amountBase, getAddress(args.owner), 0],
    }),
    label: `supply ${args.symbol} to Aave v3`,
  });

  return calls;
}

// Passing max means "everything, including whatever arrived while this was in flight".
//
// On a rebasing token the balance is different by the time the transaction lands, and a
// withdrawal of a number read a block ago leaves dust behind every single time. Aave reads
// max as the full balance at execution, so the sentinel is the only way to actually empty a
// position. This is why withdrawCalls takes null rather than making the caller compute it.
const MAX_UINT256 = (1n << 256n) - 1n;

export async function aaveWithdrawCalls(args: {
  network: Network;
  chain: ChainId;
  symbol: string;
  owner: string;
  amountBase: bigint | null;
}): Promise<VenueCall[]> {
  const { market, asset } = requireAsset(args.network, args.chain, args.symbol);
  const amount = args.amountBase === null ? MAX_UINT256 : args.amountBase;
  if (args.amountBase !== null && args.amountBase <= 0n) {
    throw new Error('aave-v3 withdraw amount must be above zero, or null for everything');
  }
  return [
    {
      to: market.pool,
      data: encodeFunctionData({
        abi: POOL_ABI,
        functionName: 'withdraw',
        // `to` is our own address, derived from the key this app holds. Same rule as every
        // rail: the destination is not an argument, so it cannot be talked into a change.
        args: [getAddress(asset.address), amount, getAddress(args.owner)],
      }),
      label: args.amountBase === null ? `withdraw all ${args.symbol} from Aave v3` : `withdraw ${args.symbol} from Aave v3`,
    },
  ];
}

export function aaveVenue(): YieldVenue {
  return {
    id: VENUE_ID,
    chains: aaveChains,
    asset: aaveAsset,
    rate: aaveRate,
    position: aavePosition,
    depositCalls: aaveDepositCalls,
    withdrawCalls: aaveWithdrawCalls,
  };
}

// The pool address is what the policy allowlist has to contain for this venue to be usable.
// Same contract as src/rails/index.ts venueAllowlist: the addresses come from the verified
// table above and from nowhere else, so no agent input can reach this list.
export function aaveCounterparties(network: Network): string[] {
  return aaveChains(network).map((chain) => marketFor(network, chain).pool.toLowerCase());
}

export { RAY };
