// Behavioural probe: does an Aave v3 PoolAddressesProvider live at these testnet addresses,
// and does the Pool it names actually hold a USDC reserve with an aToken?
// Nothing here signs. eth_call and eth_getCode only.
import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const CHAINS = {
  'arb-sepolia': { id: 421614, rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  'base-sepolia': { id: 84532, rpc: 'https://sepolia.base.org' },
  'eth-sepolia': { id: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
};

// Candidates from aave-address-book AaveV3ArbitrumSepolia / AaveV3BaseSepolia / AaveV3Sepolia.
// Every one of these is UNVERIFIED until this script proves it by behaviour.
const CANDIDATES = {
  'arb-sepolia': {
    provider: '0xB25a5D144626a0D488e52AE717A051a2E9997076',
    pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    dataProvider: '0x6bA6cE2d7469Ac8Ca5D8Ee69b0B7fCD9d8bB4a8B',
    faucet: '0x8e6DEbcB63a3fe5A7aC1Bf4d3d4bd6b0d0d0aA5A',
  },
  'base-sepolia': {
    provider: '0xd449FeD49d9C443688d6816fE6872F21402e41de',
    pool: '0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b',
    dataProvider: '0x9B0c1b2056e7A1a2A62e5cA4Bb27bF3E4d1F1B0A',
    faucet: '0x0f74A6E97D5B2E5A0B1D50a6cBBd0Cc85B7c8e1F',
  },
  'eth-sepolia': {
    provider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
    pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    dataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
    faucet: '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D',
  },
};

const PROVIDER_ABI = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getMarketId() view returns (string)',
]);
const POOL_ABI = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
]);
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const RAY = 10n ** 27n;
const apyFromRay = (rate) => (Number(rate) / Number(RAY)) * 100;

for (const [name, chain] of Object.entries(CHAINS)) {
  const c = createPublicClient({ transport: http(chain.rpc, { timeout: 20000, retryCount: 2 }) });
  const cand = CANDIDATES[name];
  console.log(`\n================ ${name} (chainId ${chain.id}) ================`);
  try {
    const id = await c.getChainId();
    if (id !== chain.id) { console.log(`  RPC chainId mismatch: ${id}`); continue; }
  } catch (e) { console.log(`  RPC dead: ${String(e).slice(0, 120)}`); continue; }

  let pool = null;
  try {
    const code = await c.getBytecode({ address: getAddress(cand.provider) });
    console.log(`  provider ${cand.provider} code=${code ? code.length / 2 - 1 : 0}B`);
    if (code) {
      pool = await c.readContract({ address: getAddress(cand.provider), abi: PROVIDER_ABI, functionName: 'getPool' });
      const marketId = await c.readContract({ address: getAddress(cand.provider), abi: PROVIDER_ABI, functionName: 'getMarketId' }).catch(() => '(none)');
      console.log(`  provider.getPool() -> ${pool}   marketId="${marketId}"`);
      console.log(`  matches candidate pool? ${pool.toLowerCase() === cand.pool.toLowerCase()}`);
    }
  } catch (e) { console.log(`  provider probe failed: ${String(e).slice(0, 160)}`); }

  if (!pool) continue;
  try {
    const reserves = await c.readContract({ address: pool, abi: POOL_ABI, functionName: 'getReservesList' });
    console.log(`  reserves: ${reserves.length}`);
    for (const asset of reserves) {
      let sym = '?', dec = 0;
      try {
        [sym, dec] = await Promise.all([
          c.readContract({ address: asset, abi: ERC20_ABI, functionName: 'symbol' }),
          c.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' }),
        ]);
      } catch {}
      if (!/usd|dai/i.test(sym)) continue;
      const d = await c.readContract({ address: pool, abi: POOL_ABI, functionName: 'getReserveData', args: [asset] });
      const aSupply = await c.readContract({ address: d.aTokenAddress, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => 0n);
      let aSym = '?';
      try { aSym = await c.readContract({ address: d.aTokenAddress, abi: ERC20_ABI, functionName: 'symbol' }); } catch {}
      console.log(
        `   * ${sym.padEnd(8)} ${asset} dec=${dec}\n` +
        `       aToken ${aSym} ${d.aTokenAddress}\n` +
        `       supplyAPY=${apyFromRay(d.currentLiquidityRate).toFixed(4)}%  borrowAPY=${apyFromRay(d.currentVariableBorrowRate).toFixed(4)}%\n` +
        `       liquidityIndex=${d.liquidityIndex}  aTokenTotalSupply=${Number(aSupply) / 10 ** Number(dec)}`
      );
    }
  } catch (e) { console.log(`  pool probe failed: ${String(e).slice(0, 200)}`); }
}
