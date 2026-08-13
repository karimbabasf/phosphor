// NEAR balance reads over the public JSON-RPC. ft_balance_of is a contract view call whose
// return value comes back as a byte array (UTF-8 JSON, per NEAR's u128-as-string convention);
// native balance comes from view_account.
import type { ChainId, Holding } from '../types.ts';

// NEAR puts the useful discriminator in error.cause.name (UNKNOWN_ACCOUNT, UNAVAILABLE_SHARD,
// and so on) and leaves error.message as the generic "Server error". Deciding anything off
// message means deciding off a string written for a log line, so the cause is carried out
// here and every caller branches on that instead.
class NearRpcError extends Error {
  readonly causeName: string;
  constructor(causeName: string, message: string) {
    super(message);
    this.name = 'NearRpcError';
    this.causeName = causeName;
  }
}

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
  const body = (await res.json()) as {
    result?: any;
    error?: { message?: string; cause?: { name?: string } };
  };
  if (body.error) {
    const causeName = body.error.cause?.name ?? 'UNKNOWN';
    throw new NearRpcError(causeName, `near query failed: ${causeName} (${body.error.message ?? 'no message'})`);
  }
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

  // An implicit account (the 64-hex kind keygen produces) does not exist on chain until
  // something funds it, and the RPC answers UNKNOWN_ACCOUNT. That is the read succeeding with
  // an answer of zero, not the read failing: letting it throw marks the whole chain stale, hides
  // that the address is merely unfunded, and leaves the gas-floor rule judging a chain the app
  // believes it cannot see. Every other cause is a genuine failure and still propagates.
  let nativeAmount = 0;
  try {
    const accountResult = (await rpcQuery(
      rpcUrl,
      { request_type: 'view_account', finality: 'final', account_id: address },
      fetchImpl,
    )) as { amount: string };
    nativeAmount = Number(accountResult.amount ?? '0') / 1e24;
  } catch (err) {
    if (!(err instanceof NearRpcError) || err.causeName !== 'UNKNOWN_ACCOUNT') throw err;
  }
  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'NEAR',
    tokenId: 'native',
    amount: nativeAmount,
    usd: 0, // priced by the caller
    native: true,
  };

  return [...tokenHoldings, nativeHolding];
}
