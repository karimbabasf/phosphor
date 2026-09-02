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

import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmPrivateKey, walletAddresses } from '../keystore/index.ts';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type { ChainId } from '../types.ts';

// Chain identity. Kept here rather than in the rails so a rail cannot quietly point
// itself at the wrong chain.
export type EvmChainSpec = {
  chainId: number;
  rpcUrl: string;
  explorerTx: string; // prefix; a rail returns explorerTx + hash as its evidence
};

const EVM_CHAINS: Partial<Record<ChainId, EvmChainSpec>> = {
  base: { chainId: 8453, rpcUrl: 'https://base-rpc.publicnode.com', explorerTx: 'https://basescan.org/tx/' },
  arb: { chainId: 42161, rpcUrl: 'https://arbitrum-one-rpc.publicnode.com', explorerTx: 'https://arbiscan.io/tx/' },
  eth: { chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com', explorerTx: 'https://etherscan.io/tx/' },
};

export function chainSpec(chain: ChainId): EvmChainSpec {
  const spec = EVM_CHAINS[chain];
  if (spec === undefined) throw new Error(`no EVM chain spec for ${chain}`);
  return spec;
}

// ---------- keys ----------

// SIGNING material, from the keystore. It is asked for at the moment it is needed and never
// held in module state, so a heap dump of a long-running process is less likely to carry it,
// and while the wallet is locked this throws by name rather than returning a key.
function readEvmKey(keysPath: string): Hex {
  return evmPrivateKey(keysPath);
}

/* The ADDRESS, which is not signing material and must not behave like it. Every balance read
   in this app ends here, and a locked wallet still has balances: the address comes from the
   keystore's plaintext header, so the whole read surface works while locked. The derivation
   below is the fallback for an install that has not migrated yet and has no header. */
export function evmAddress(keysPath: string): Address {
  const fromHeader = walletAddresses().evm;
  if (fromHeader !== null) return fromHeader as Address;
  return privateKeyToAccount(readEvmKey(keysPath)).address;
}

// ---------- clients ----------

// A rate-limited public RPC answers with an HTML error page rather than JSON, which
// makes JSON.parse throw something unrelated to the real problem. Retrying on that is
// the difference between a readable error and a mystery.
function rpcTransport(url: string) {
  return http(url, { retryCount: 3, retryDelay: 400, timeout: 20_000 });
}

export function reader(chain: ChainId): PublicClient {
  const spec = chainSpec(chain);
  return createPublicClient({ transport: rpcTransport(spec.rpcUrl) }) as PublicClient;
}

function writer(chain: ChainId, keysPath: string): { client: WalletClient; account: ReturnType<typeof privateKeyToAccount>; spec: EvmChainSpec } {
  const spec = chainSpec(chain);
  const account = privateKeyToAccount(readEvmKey(keysPath));
  const client = createWalletClient({ account, transport: rpcTransport(spec.rpcUrl) });
  return { client, account, spec };
}

// ---------- the write path ----------

export type SendParams = {
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
  const { chain, keysPath, to, data } = params;
  const spec = chainSpec(chain);
  const { client, account } = writer(chain, keysPath);
  const pub = reader(chain);

  /* Hoisted, and this is the whole of the fix.
     `hash` used to be declared inside the try, so every post-broadcast error returned
     `{ ok: false }` with no hash in it: a receipt wait that times out (120s, below), an archive
     node refusing, a 5xx after three transport retries. All three report a transaction that IS
     ON CHAIN as a clean failure with nothing to look it up by. This is the live Arbitrum
     incident written up in rails/hypercore-deposit.ts, and the recovery branch there
     (`if (sent.hash !== undefined)`) was dead code because sendTx could never populate it. */
  let hash: `0x${string}` | undefined;

  try {
    // Estimate first. A revert here costs nothing and produces the real reason string,
    // where a broadcast revert costs gas and produces a receipt with status 0 and no why.
    const gas = await pub.estimateGas({ account, to, data, value: params.value ?? 0n });

    hash = await client.sendTransaction({
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
    // The hash if we have one. A caller that reads no hash here may state that nothing was
    // broadcast; a caller that reads one may not.
    const error = err instanceof Error ? err.message : String(err);
    if (hash === undefined) return { ok: false, error };
    return { ok: false, hash, explorer: spec.explorerTx + hash, error };
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

export async function erc20Balance(chain: ChainId, token: Address, owner: Address): Promise<bigint> {
  return (await reader(chain).readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [owner] })) as bigint;
}

export async function erc20Allowance(chain: ChainId, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await reader(chain).readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [owner, spender] })) as bigint;
}

export function erc20TransferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] });
}

function erc20ApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] });
}

// Approve only when the current allowance is short. An unconditional approve costs a
// transaction every time and, at max uint, quietly widens what a spender may take.
export async function ensureAllowance(args: {
  chain: ChainId;
  keysPath: string;
  token: Address;
  spender: Address;
  needed: bigint;
}): Promise<SendOutcome | null> {
  const owner = evmAddress(args.keysPath);
  const current = await erc20Allowance(args.chain, args.token, owner, args.spender);
  if (current >= args.needed) return null;
  return sendTx({
    chain: args.chain,
    keysPath: args.keysPath,
    to: args.token,
    data: erc20ApproveData(args.spender, args.needed),
  });
}

export { ERC20 };
