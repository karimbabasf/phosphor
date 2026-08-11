// NEAR balance reads over the public JSON-RPC. ft_balance_of is a contract view call whose
// return value comes back as a byte array (UTF-8 JSON, per NEAR's u128-as-string convention);
// native balance comes from view_account.
import type { ChainId, Holding } from '../types.ts';

async function rpcQuery(
  rpcUrl: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }),
  });
  if (!res.ok) throw new Error(`near query http ${res.status}`);
  const body = (await res.json()) as { result?: any; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'near rpc error');
  return body.result;
}

function decodeFtBalance(result: { result: number[] }): bigint {
  const text = Buffer.from(Uint8Array.from(result.result)).toString('utf8');
  const parsed = JSON.parse(text); // contract returns a JSON string, e.g. "950000000"
  return BigInt(parsed);
}

export async function fetchHoldings(
  chain: ChainId,
  rpcUrl: string,
  address: string,
  tokens: Record<string, { tokenId: string; decimals: number }>,
  fetchImpl: typeof fetch,
): Promise<Holding[]> {
  const argsBase64 = Buffer.from(JSON.stringify({ account_id: address })).toString('base64');

  const tokenHoldings = await Promise.all(
    Object.entries(tokens).map(async ([symbol, { tokenId, decimals }]) => {
      const result = await rpcQuery(
        rpcUrl,
        {
          request_type: 'call_function',
          finality: 'final',
          account_id: tokenId,
          method_name: 'ft_balance_of',
          args_base64: argsBase64,
        },
        fetchImpl,
      );
      const amount = Number(decodeFtBalance(result)) / 10 ** decimals;
      const holding: Holding = { chain, address, symbol, tokenId, amount, usd: amount, native: false };
      return holding;
    }),
  );

  const accountResult = (await rpcQuery(
    rpcUrl,
    { request_type: 'view_account', finality: 'final', account_id: address },
    fetchImpl,
  )) as { amount: string };
  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'NEAR',
    tokenId: 'native',
    amount: Number(accountResult.amount ?? '0') / 1e24,
    usd: 0, // priced by the caller
    native: true,
  };

  return [...tokenHoldings, nativeHolding];
}
