// Solana balance reads over the public JSON-RPC. One getTokenAccountsByOwner call per mint
// (summed across any duplicate token accounts) plus one getBalance call for native SOL.
import type { ChainId, Holding } from '../types.ts';
import { readTimeout } from '../net.ts';

// The shape a jsonParsed reply is SUPPOSED to have. Kept as documentation and deliberately not
// used as a cast: casting an unknown RPC answer to this type is precisely how five levels of
// property access came to be walked unguarded. tokenAmountOf below checks each level instead.
// type TokenAccountsResult = {
//   value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }>;
// };

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
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`${method} http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} rpc error`);
  return body.result;
}

/* What an RPC answer looks like, for an error message. Never the answer itself: a node can echo
   an address back and the log is not the place for one. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value !== 'object') return typeof value;
  return `an object with keys ${Object.keys(value).slice(0, 6).join(', ') || '(none)'}`;
}

/* Five levels of property access, each one of them checked.
   `result.value[].account.data.parsed.info.tokenAmount.uiAmount` was walked unguarded, so a node
   answering base64 instead of jsonParsed threw a TypeError five frames deep, index.ts caught it,
   and the whole Solana chain went stale for a reason no message named. Each level is now its own
   sentence, and a shape that does not match is a READ FAILURE rather than a balance. */
function tokenAmountOf(result: unknown, symbol: string): number {
  const accounts = (result as { value?: unknown } | null)?.value;
  if (accounts === undefined || accounts === null) return 0; // no account for this mint: really zero
  if (!Array.isArray(accounts)) {
    throw new Error(`solana getTokenAccountsByOwner for ${symbol} returned ${describeShape(accounts)}, not a list`);
  }
  let total = 0;
  for (const entry of accounts) {
    const parsed = (entry as { account?: { data?: { parsed?: { info?: { tokenAmount?: unknown } } } } } | null)?.account
      ?.data?.parsed?.info?.tokenAmount;
    if (parsed === undefined || parsed === null) {
      throw new Error(`solana ${symbol} account is not jsonParsed (got ${describeShape(entry)})`);
    }
    const ui = (parsed as { uiAmount?: unknown }).uiAmount;
    // A genuinely empty account answers null here, which IS zero. Anything else is a shape we
    // do not understand and must not average into a balance.
    if (ui === null) continue;
    if (typeof ui !== 'number' || !Number.isFinite(ui) || ui < 0) {
      throw new Error(`solana ${symbol} reports a uiAmount of ${describeShape(ui)}, which is not an amount`);
    }
    total += ui;
  }
  return total;
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
      )) as unknown;
      const holding: Holding = { chain, address, symbol, tokenId, amount: tokenAmountOf(result, symbol), usd: 0, native: false };
      holding.usd = holding.amount; // a dollar stable is priced at a dollar; the caller re-prices the rest
      return holding;
    }),
  );

  const balanceResult = await rpcCall(rpcUrl, 'getBalance', [address], fetchImpl);
  const lamports = (balanceResult as { value?: unknown } | null)?.value;
  if (typeof lamports !== 'number' || !Number.isFinite(lamports) || lamports < 0) {
    /* `?? 0` here used to report ZERO SOL for any answer that was not the shape expected. A node
       replying base64 instead of jsonParsed, a proxy returning an error envelope, a field
       renamed: all of them read as an empty wallet, and index.ts's catch then marked the chain
       stale AFTER the zero had already been produced. A missing figure is not a figure of zero,
       and on a balance the difference is the whole point. */
    throw new Error(`solana getBalance returned no usable value (got ${describeShape(balanceResult)})`);
  }
  const nativeHolding: Holding = {
    chain,
    address,
    symbol: 'SOL',
    tokenId: 'native',
    amount: lamports / 1e9,
    usd: 0, // priced by the caller
    native: true,
  };

  return [...tokenHoldings.filter(h => h.amount > 0), nativeHolding];
}
