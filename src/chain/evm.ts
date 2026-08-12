// The one place Phosphor signs and broadcasts an EVM transaction.
//
// Deliberately not spread across the rails. Signing is where a bug loses funds rather
// than throwing an error, so it lives in a single reviewable module and every rail
// calls into it. viem carries the dangerous parts (keccak256, secp256k1, RLP, EIP-1559
// encoding, address derivation) on audited @noble primitives.
//
// Why viem at all, in a repo that was proudly near-zero-dependency: keccak256 is NOT
// node's 'sha3-256'. Different padding, different digest, wrong addresses and wrong
// function selectors. Two independent researchers hit this in one session and one of
// them wrote a keccak by hand that failed its own test vector. Hand-rolling the one
// thing that must never be wrong is a bad trade for a dependency count.

import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type { ChainId, Network } from '../types.ts';

// Chain identity per network. Kept here rather than in the rails so a rail cannot
// quietly point itself at the wrong world.
export type EvmChainSpec = {
  chainId: number;
  rpcUrl: string;
  explorerTx: string; // prefix; a rail returns explorerTx + hash as its evidence
};

const EVM_CHAINS: Record<Network, Partial<Record<ChainId, EvmChainSpec>>> = {
  testnet: {
    base: { chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorerTx: 'https://sepolia.basescan.org/tx/' },
    arb: { chainId: 421614, rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc', explorerTx: 'https://sepolia.arbiscan.io/tx/' },
    eth: { chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorerTx: 'https://sepolia.etherscan.io/tx/' },
  },
  mainnet: {
    base: { chainId: 8453, rpcUrl: 'https://base-rpc.publicnode.com', explorerTx: 'https://basescan.org/tx/' },
    arb: { chainId: 42161, rpcUrl: 'https://arbitrum-one-rpc.publicnode.com', explorerTx: 'https://arbiscan.io/tx/' },
    eth: { chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/' },
  },
};

export function chainSpec(network: Network, chain: ChainId): EvmChainSpec {
  const spec = EVM_CHAINS[network][chain];
  if (spec === undefined) throw new Error(`no EVM chain spec for ${chain} on ${network}`);
  return spec;
}

// ---------- keys ----------

type KeysFile = { evm?: { privateKey?: string }; [k: string]: unknown };

// Read the key only at the moment it is needed and never hold it in module state, so a
// heap dump of a long-running process is less likely to carry it.
function readEvmKey(keysPath: string): Hex {
  if (!fs.existsSync(keysPath)) {
    throw new Error(`no keys file at ${keysPath}. Run: npm run keygen`);
  }
  const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysFile;
  const key = parsed.evm?.privateKey;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`keys file at ${keysPath} has no valid evm.privateKey`);
  }
  return key as Hex;
}

export function evmAddress(keysPath: string): Address {
  return privateKeyToAccount(readEvmKey(keysPath)).address;
}

// ---------- clients ----------

// sepolia.base.org rate-limits hard and answers with an HTML error page rather than
// JSON when it does, which makes JSON.parse throw something unrelated to the real
// problem. Retrying on that is the difference between a readable error and a mystery.
function rpcTransport(url: string) {
  return http(url, { retryCount: 3, retryDelay: 400, timeout: 20_000 });
}

export function reader(network: Network, chain: ChainId): PublicClient {
  const spec = chainSpec(network, chain);
  return createPublicClient({ transport: rpcTransport(spec.rpcUrl) }) as PublicClient;
}

function writer(network: Network, chain: ChainId, keysPath: string): { client: WalletClient; account: ReturnType<typeof privateKeyToAccount>; spec: EvmChainSpec } {
  const spec = chainSpec(network, chain);
  const account = privateKeyToAccount(readEvmKey(keysPath));
  const client = createWalletClient({ account, transport: rpcTransport(spec.rpcUrl) });
  return { client, account, spec };
}

// ---------- the write path ----------

export type SendParams = {
  network: Network;
  chain: ChainId;
  keysPath: string;
  to: Address;
  data: Hex;
  value?: bigint;
};

export type SendOutcome = { ok: boolean; hash?: string; explorer?: string; gasUsed?: string; error?: string };

// Simulate, send, wait for the receipt, and report what actually happened. A rail never
// broadcasts directly: it hands calldata here.
export async function sendTx(params: SendParams): Promise<SendOutcome> {
  const { network, chain, keysPath, to, data } = params;
  const spec = chainSpec(network, chain);
  const { client, account } = writer(network, chain, keysPath);
  const pub = reader(network, chain);

  try {
    // Estimate first. A revert here costs nothing and produces the real reason string,
    // where a broadcast revert costs gas and produces a receipt with status 0 and no why.
    const gas = await pub.estimateGas({ account, to, data, value: params.value ?? 0n });

    const hash = await client.sendTransaction({
      account,
      chain: null,
      to,
      data,
      value: params.value ?? 0n,
      gas: (gas * 12n) / 10n, // 20% headroom: estimation is a lower bound, not a promise
    });

    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') {
      return { ok: false, hash, explorer: spec.explorerTx + hash, error: 'transaction reverted on chain' };
    }
    return { ok: true, hash, explorer: spec.explorerTx + hash, gasUsed: receipt.gasUsed.toString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- ERC-20, the shared subset every rail needs ----------

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);

export async function erc20Balance(network: Network, chain: ChainId, token: Address, owner: Address): Promise<bigint> {
  return (await reader(network, chain).readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [owner] })) as bigint;
}

export async function erc20Allowance(network: Network, chain: ChainId, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await reader(network, chain).readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [owner, spender] })) as bigint;
}

export function erc20TransferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] });
}

export function erc20ApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] });
}

// Approve only when the current allowance is short. An unconditional approve costs a
// transaction every time and, at max uint, quietly widens what a spender may take.
export async function ensureAllowance(args: {
  network: Network;
  chain: ChainId;
  keysPath: string;
  token: Address;
  spender: Address;
  needed: bigint;
}): Promise<SendOutcome | null> {
  const owner = evmAddress(args.keysPath);
  const current = await erc20Allowance(args.network, args.chain, args.token, owner, args.spender);
  if (current >= args.needed) return null;
  return sendTx({
    network: args.network,
    chain: args.chain,
    keysPath: args.keysPath,
    to: args.token,
    data: erc20ApproveData(args.spender, args.needed),
  });
}

export { ERC20 };
