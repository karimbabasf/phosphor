// What does the app's own EVM address actually hold on Arbitrum Sepolia, and can the
// Aave faucet mint it test USDC? Read-only.
import { createPublicClient, http, parseAbi, getAddress, formatUnits } from 'viem';

const OWNER = getAddress('0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050');
const c = createPublicClient({ transport: http('https://sepolia-rollup.arbitrum.io/rpc', { timeout: 20000, retryCount: 2 }) });
const base = createPublicClient({ transport: http('https://sepolia.base.org', { timeout: 20000, retryCount: 2 }) });

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const TOKENS = {
  'arb-sepolia': [
    ['USDC', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 6],
    ['aArbSepUSDC', '0x460b97BD498E1157530AEb3086301d5225b91216', 6],
    ['WETH', '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', 18],
  ],
  'base-sepolia': [
    ['USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6],
    ['aBasSepUSDC', '0xf53B60F4006cab2b3C4688ce41fD5362427A2A66', 6],
  ],
};

for (const [name, client] of [['arb-sepolia', c], ['base-sepolia', base]]) {
  console.log(`\n=== ${name} : ${OWNER} ===`);
  const eth = await client.getBalance({ address: OWNER });
  console.log(`  native ETH  ${formatUnits(eth, 18)}`);
  for (const [sym, addr, dec] of TOKENS[name]) {
    try {
      const b = await client.readContract({ address: getAddress(addr), abi: ERC20, functionName: 'balanceOf', args: [OWNER] });
      console.log(`  ${sym.padEnd(12)} ${formatUnits(b, dec)}`);
    } catch (e) { console.log(`  ${sym.padEnd(12)} read failed: ${String(e).slice(0, 80)}`); }
  }
}

// Aave testnet faucet: does one exist on arb-sepolia and is USDC mintable through it?
const FAUCET_ABI = parseAbi([
  'function mint(address token, address to, uint256 amount) returns (uint256)',
  'function isPermissioned() view returns (bool)',
  'function owner() view returns (address)',
]);
for (const cand of [
  '0x8e6DEbcB63a3fe5A7aC1Bf4d3d4bd6b0d0d0aA5A',
  '0x22C1a4d5C5c1D1e0c1a8Fb0F76a25e6a58EBB4C4',
]) {
  try {
    const code = await c.getBytecode({ address: getAddress(cand) });
    console.log(`\nfaucet candidate ${cand} code=${code ? code.length / 2 - 1 : 0}B`);
    if (code) {
      const perm = await c.readContract({ address: getAddress(cand), abi: FAUCET_ABI, functionName: 'isPermissioned' }).catch(() => 'n/a');
      console.log(`  isPermissioned=${perm}`);
    }
  } catch (e) { console.log(`faucet ${cand}: ${String(e).slice(0, 80)}`); }
}
