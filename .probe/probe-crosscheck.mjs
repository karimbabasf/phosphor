// Cross-check the venue agent's claimed addresses against the chain. Read-only.
// A claimed address that has no code, or whose code does not answer the way an Aave
// contract answers, is a hallucination and gets marked as one.
import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const base = createPublicClient({ transport: http('https://sepolia.base.org', { timeout: 25000, retryCount: 3 }) });
const arb = createPublicClient({ transport: http('https://sepolia-rollup.arbitrum.io/rpc', { timeout: 25000, retryCount: 3 }) });

const ERC20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const ATOKEN = parseAbi(['function UNDERLYING_ASSET_ADDRESS() view returns (address)', 'function symbol() view returns (string)']);
const POOL = parseAbi([
  'function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function getReservesList() view returns (address[])',
]);
const FAUCET = parseAbi(['function isPermissioned() view returns (bool)', 'function owner() view returns (address)']);

const CLAIMS = [
  ['base', 'AGENT pool', '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27'],
  ['base', 'AGENT usdc', '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f'],
  ['base', 'AGENT aToken', '0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC'],
  ['base', 'AGENT faucet', '0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc'],
  ['base', 'AGENT provider', '0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00'],
  ['base', 'AGENT dataProvider', '0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b'],
  ['base', 'MINE pool', '0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b'],
  ['base', 'MINE usdc', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
  ['base', 'MINE aToken', '0xf53B60F4006cab2b3C4688ce41fD5362427A2A66'],
];

const clients = { base, arb };

console.log('===== code presence =====');
for (const [chain, label, addr] of CLAIMS) {
  try {
    const code = await clients[chain].getBytecode({ address: getAddress(addr) });
    const n = code ? code.length / 2 - 1 : 0;
    let extra = '';
    try { extra = ` symbol=${await clients[chain].readContract({ address: getAddress(addr), abi: ERC20, functionName: 'symbol' })}`; } catch {}
    try { extra += ` isPermissioned=${await clients[chain].readContract({ address: getAddress(addr), abi: FAUCET, functionName: 'isPermissioned' })}`; } catch {}
    try { extra += ` underlying=${await clients[chain].readContract({ address: getAddress(addr), abi: ATOKEN, functionName: 'UNDERLYING_ASSET_ADDRESS' })}`; } catch {}
    console.log(`${chain} ${label.padEnd(18)} ${addr} code=${String(n).padStart(6)}B ${n === 0 ? '  <-- NO CODE, DOES NOT EXIST' : ''}${extra}`);
  } catch (e) {
    console.log(`${chain} ${label.padEnd(18)} ${addr} probe failed: ${String(e).slice(0, 90)}`);
  }
}

// Supply cap headroom on the two markets I verified. Aave packs supplyCap at bits 116-151
// of the reserve configuration bitmap, in WHOLE units of the asset.
console.log('\n===== supply cap headroom (my verified markets) =====');
const MARKETS = [
  ['arb', arb, '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 6],
  ['base', base, '0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6],
];
for (const [name, client, pool, asset, dec] of MARKETS) {
  const d = await client.readContract({ address: getAddress(pool), abi: POOL, functionName: 'getReserveData', args: [getAddress(asset)] });
  const cfg = d.configuration;
  const supplyCap = (cfg >> 116n) & ((1n << 36n) - 1n);
  const active = (cfg >> 56n) & 1n, frozen = (cfg >> 57n) & 1n, paused = (cfg >> 60n) & 1n;
  const aSupply = await client.readContract({ address: d.aTokenAddress, abi: ERC20, functionName: 'totalSupply' });
  const supplied = Number(aSupply) / 10 ** dec;
  console.log(
    `${name}: active=${active} frozen=${frozen} paused=${paused}\n` +
    `   supplyCap=${supplyCap === 0n ? 'UNCAPPED' : supplyCap.toString() + ' USDC'}  supplied=${supplied.toFixed(2)} USDC\n` +
    `   headroom=${supplyCap === 0n ? 'unlimited' : (Number(supplyCap) - supplied).toFixed(2) + ' USDC'}`
  );
}

// Can our address actually supply 1 USDC right now? eth_call the Pool as us. Reverts tell us why.
console.log('\n===== simulate supply(1 USDC) from our address =====');
const OWNER = getAddress('0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050');
const POOL_W = parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
for (const [name, client, pool, asset] of MARKETS) {
  try {
    await client.simulateContract({ address: getAddress(pool), abi: POOL_W, functionName: 'supply', args: [getAddress(asset), 1_000_000n, OWNER, 0], account: OWNER });
    console.log(`${name}: supply(1 USDC) simulates OK (would need allowance + balance in reality)`);
  } catch (e) {
    const m = String(e.shortMessage ?? e.message ?? e).split('\n')[0];
    console.log(`${name}: supply(1 USDC) reverts -> ${m.slice(0, 160)}`);
  }
}
