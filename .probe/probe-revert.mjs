import { createPublicClient, http, parseAbi, getAddress } from 'viem';
const arb = createPublicClient({ transport: http('https://sepolia-rollup.arbitrum.io/rpc', { timeout: 25000, retryCount: 3 }) });
const OWNER = getAddress('0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050');
const POOL = getAddress('0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
const USDC = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
const abi = parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
// 0.1 USDC, which we DO hold (0.117), still with no allowance -> should be an ERC20 failure
for (const [amt, label] of [[100000n, '0.10 USDC (we hold 0.117)'], [1000000n, '1.00 USDC (we do not hold)']]) {
  try {
    await arb.simulateContract({ address: POOL, abi, functionName: 'supply', args: [USDC, amt, OWNER, 0], account: OWNER });
    console.log(`${label}: OK`);
  } catch (e) {
    console.log(`${label}: ${String(e.shortMessage ?? e.message).replace(/\n+/g, ' | ').slice(0, 300)}`);
  }
}
// what allowance do we currently have to the pool?
const erc = parseAbi(['function allowance(address,address) view returns (uint256)','function balanceOf(address) view returns (uint256)']);
console.log('allowance ->', await arb.readContract({ address: USDC, abi: erc, functionName: 'allowance', args: [OWNER, POOL] }));
console.log('balance   ->', await arb.readContract({ address: USDC, abi: erc, functionName: 'balanceOf', args: [OWNER] }));
