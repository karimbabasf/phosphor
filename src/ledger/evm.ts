// EVM balance reads over public JSON-RPC. Used for eth, base, arb (same shape, different rpcUrl
// and token registry per chain). Native gas asset on all three is ETH.
import type { ChainId, Holding } from '../types.ts';

const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} rpc error`);
  return body.result;
}

type RpcRequest = { method: string; params: unknown[] };

// One HTTP request for every read this chain needs, instead of one per read.
//
// Measured against ethereum-rpc.publicnode.com 2026-08-13, six balanceOf calls plus a
// native balance plus a gas price: 416ms as separate requests, 114ms as one batch. The
// old code paid that on every chain of every refresh, and the tail is worse than the mean
// because a public node queues concurrent requests from one caller.
//
// JSON-RPC batching is optional in the spec and some nodes refuse it, so a response that
// is not an array falls back to individual calls rather than failing the chain. Results
// are matched by id and never by position: a node is allowed to answer out of order, and
// reading balances positionally out of a reordered batch would report one token's balance
// under another token's name.
async function rpcBatch(rpcUrl: string, requests: RpcRequest[], fetchImpl: typeof fetch): Promise<unknown[]> {
  if (requests.length === 0) return [];

  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requests.map((r, id) => ({ jsonrpc: '2.0', id, method: r.method, params: r.params }))),
  });
  if (!res.ok) throw new Error(`batch http ${res.status}`);

  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    return Promise.all(requests.map(r => rpcCall(rpcUrl, r.method, r.params, fetchImpl)));
  }

  const byId = new Map<number, { result?: unknown; error?: { message?: string } }>();
  for (const entry of body as Array<{ id?: unknown; result?: unknown; error?: { message?: string } }>) {
    if (typeof entry?.id === 'number') byId.set(entry.id, entry);
  }

  return requests.map((r, id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`${r.method} missing from batch response`);
    if (entry.error) throw new Error(entry.error.message ?? `${r.method} rpc error`);
    return entry.result;
  });
}

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function hexToNumber(hex: string | undefined, decimals: number): number {
  if (!hex || hex === '0x') return 0;
  return Number(BigInt(hex)) / 10 ** decimals;
}

// Every token balance, the native balance and the gas price for one address, in one round
// trip. The gas price rides along because it is a per-chain read the caller needed anyway
// and a batch of eight costs the same as a batch of seven.
export async function fetchChainState(
  chain: ChainId,
  rpcUrl: string,
  address: string,
  tokens: Record<string, { tokenId: string; decimals: number }>,
  fetchImpl: typeof fetch,
): Promise<{ holdings: Holding[]; gasPriceWei: bigint }> {
  const entries = Object.entries(tokens);
  const requests: RpcRequest[] = [
    ...entries.map(([, { tokenId }]) => ({
      method: 'eth_call',
      params: [{ to: tokenId, data: BALANCE_OF_SELECTOR + padAddress(address) }, 'latest'],
    })),
    { method: 'eth_getBalance', params: [address, 'latest'] },
    { method: 'eth_gasPrice', params: [] },
  ];

  const results = await rpcBatch(rpcUrl, requests, fetchImpl);

  const tokenHoldings: Holding[] = entries.map(([symbol, { tokenId, decimals }], i) => ({
    chain,
    address,
    symbol,
    tokenId,
    amount: hexToNumber(results[i] as string, decimals),
    usd: hexToNumber(results[i] as string, decimals),
    native: false,
  }));

  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'ETH',
    tokenId: 'native',
    amount: hexToNumber(results[entries.length] as string, 18),
    usd: 0, // priced by the caller, which holds the current spot map
    native: true,
  };

  const gasHex = results[entries.length + 1] as string;
  return {
    holdings: [...tokenHoldings, nativeHolding],
    gasPriceWei: gasHex && gasHex !== '0x' ? BigInt(gasHex) : 0n,
  };
}

export async function fetchHoldings(
  chain: ChainId,
  rpcUrl: string,
  address: string,
  tokens: Record<string, { tokenId: string; decimals: number }>,
  fetchImpl: typeof fetch,
): Promise<Holding[]> {
  return (await fetchChainState(chain, rpcUrl, address, tokens, fetchImpl)).holdings;
}

export async function fetchGasPriceWei(rpcUrl: string, fetchImpl: typeof fetch): Promise<bigint> {
  const hex = (await rpcCall(rpcUrl, 'eth_gasPrice', [], fetchImpl)) as string;
  return hex && hex !== '0x' ? BigInt(hex) : 0n;
}
