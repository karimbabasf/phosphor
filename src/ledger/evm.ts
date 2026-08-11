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

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function hexToNumber(hex: string | undefined, decimals: number): number {
  if (!hex || hex === '0x') return 0;
  return Number(BigInt(hex)) / 10 ** decimals;
}

export async function fetchHoldings(
  chain: ChainId,
  rpcUrl: string,
  address: string,
  tokens: Record<string, { tokenId: string; decimals: number }>,
  fetchImpl: typeof fetch,
): Promise<Holding[]> {
  const tokenHoldings = await Promise.all(
    Object.entries(tokens).map(async ([symbol, { tokenId, decimals }]) => {
      const result = (await rpcCall(
        rpcUrl,
        'eth_call',
        [{ to: tokenId, data: BALANCE_OF_SELECTOR + padAddress(address) }, 'latest'],
        fetchImpl,
      )) as string;
      const amount = hexToNumber(result, decimals);
      const holding: Holding = { chain, address, symbol, tokenId, amount, usd: amount, native: false };
      return holding;
    }),
  );

  const balanceHex = (await rpcCall(rpcUrl, 'eth_getBalance', [address, 'latest'], fetchImpl)) as string;
  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'ETH',
    tokenId: 'native',
    amount: hexToNumber(balanceHex, 18),
    usd: 0, // priced by the caller, which holds the current spot map
    native: true,
  };

  return [...tokenHoldings, nativeHolding];
}

export async function fetchGasPriceWei(rpcUrl: string, fetchImpl: typeof fetch): Promise<bigint> {
  const hex = (await rpcCall(rpcUrl, 'eth_gasPrice', [], fetchImpl)) as string;
  return hex && hex !== '0x' ? BigInt(hex) : 0n;
}
