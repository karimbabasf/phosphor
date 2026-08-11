// Solana balance reads over the public JSON-RPC. One getTokenAccountsByOwner call per mint
// (summed across any duplicate token accounts) plus one getBalance call for native SOL.
import type { ChainId, Holding } from '../types.ts';

type TokenAccountsResult = {
  value: Array<{
    account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } };
  }>;
};

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

export async function fetchHoldings(
  chain: ChainId,
  rpcUrl: string,
  address: string,
  tokens: Record<string, { tokenId: string; decimals: number }>,
  fetchImpl: typeof fetch,
): Promise<Holding[]> {
  const tokenHoldings = await Promise.all(
    Object.entries(tokens).map(async ([symbol, { tokenId }]) => {
      const result = (await rpcCall(
        rpcUrl,
        'getTokenAccountsByOwner',
        [address, { mint: tokenId }, { encoding: 'jsonParsed' }],
        fetchImpl,
      )) as TokenAccountsResult;
      const amount = (result.value ?? []).reduce(
        (sum, acc) => sum + (acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
        0,
      );
      const holding: Holding = { chain, address, symbol, tokenId, amount, usd: amount, native: false };
      return holding;
    }),
  );

  const balanceResult = (await rpcCall(rpcUrl, 'getBalance', [address], fetchImpl)) as { value: number };
  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'SOL',
    tokenId: 'native',
    amount: (balanceResult.value ?? 0) / 1e9,
    usd: 0, // priced by the caller
    native: true,
  };

  return [...tokenHoldings.filter(h => h.amount > 0), nativeHolding];
}
