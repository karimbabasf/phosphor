// What this app holds INSIDE the intents.near verifier. A deposit through the
// intents-deposit rail leaves the wallet and becomes a balance the verifier tracks on its
// own ledger, keyed by an account id. No block explorer shows it against any address, and
// before this module the wallet panel could not see it either: money went in and the app
// reported a smaller wallet with nothing to say about the difference.
//
// scripts/intents-balance.ts proved this read against the live contract and stayed a
// script. This is the same two view calls wired into the refresh loop, so the panel that
// claims to show everything held actually does.
//
// Three decisions carried over from that script and from the rails:
//
//   - The account id comes from the KEY, never from config. For an erc191 signer it is the
//     EVM address lowercased, which is exactly the id src/rails/intents-deposit.ts credits
//     and src/rails/intents-native.ts spends. A stale config could otherwise point this at
//     an account this app cannot spend and report a stranger's balance as ours.
//   - Holdings are DISCOVERED with mt_tokens_for_owner rather than probed against a fixed
//     list, so an asset that arrived as the output of a swap shows up without anyone
//     registering it first. Probing all 186 listed assets every 30s would be the same
//     answer for far more work.
//   - The verifier is mainnet only. intents.near has never been deployed on testnet (the
//     RPC answers UNKNOWN_ACCOUNT there), so on testnet this reads nothing and says so
//     rather than inventing a zero.
//
// Read only. Two view calls, no signing, nothing here can move money.

import type { OneClickToken } from '../intents.ts';

export const INTENTS_VERIFIER = 'intents.near';

// A page of enumeration, and a ceiling on how many pages we will walk. An account holding
// more than this is not a case this app can produce, and an unbounded loop against a
// remote list is a hang waiting to happen.
const PAGE_SIZE = 250;
const MAX_PAGES = 8;

export type IntentsHolding = {
  accountId: string; // who the verifier credits: our own address, lowercased
  assetId: string; // 'nep141:eth.omft.near'
  symbol: string; // 'ETH', 'USDC', ...
  originChain: string; // which chain the asset came from, for the row label only
  amount: number; // UI units
  decimals: number;
};

export type IntentsRead = {
  holdings: IntentsHolding[];
  ok: boolean;
  fetchedAt: string;
  error?: string;
};

type ViewResult = { result: number[] };

async function view(
  rpcUrl: string,
  methodName: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: INTENTS_VERIFIER,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  if (!res.ok) throw new Error(`intents ${methodName} http ${res.status}`);
  const body = (await res.json()) as { result?: ViewResult; error?: { cause?: { name?: string } } };
  if (body.error !== undefined || body.result === undefined) {
    const cause = body.error?.cause?.name ?? 'no result';
    throw new Error(`intents ${methodName} failed: ${cause}`);
  }
  // NEAR returns view output as a byte array of UTF-8 JSON.
  return JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8'));
}

// Which assets the verifier holds for this account. An account it has never seen answers
// with an empty list rather than an error, so "nothing deposited yet" and "no such account"
// are the same harmless answer and neither is a failure.
async function tokensForOwner(rpcUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = (await view(
      rpcUrl,
      'mt_tokens_for_owner',
      { account_id: accountId, from_index: String(page * PAGE_SIZE), limit: PAGE_SIZE },
      fetchImpl,
    )) as Array<{ token_id?: unknown }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (typeof row?.token_id === 'string' && row.token_id !== '') ids.push(row.token_id);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return [...new Set(ids)];
}

// Symbol and decimals come from the 1Click token list, which is the same source the rails
// already match asset ids against. This is a display path: it scales a number a human
// reads and never a number that authorises a spend, so an unlisted asset is shown by its
// raw id at 0 decimals rather than dropped, and a wrong guess here cannot move money.
function describe(assetId: string, list: OneClickToken[]): { symbol: string; decimals: number; originChain: string } {
  const meta = list.find((t) => t.assetId === assetId);
  if (meta === undefined) return { symbol: assetId, decimals: 0, originChain: 'intents' };
  return { symbol: meta.symbol, decimals: meta.decimals, originChain: meta.blockchain };
}

export type IntentsBalanceDeps = {
  rpcUrl: string;
  accountId: string;
  tokenList: () => Promise<OneClickToken[]>;
  fetchImpl: typeof fetch;
};

// Two round trips in the common case, one when the account holds nothing. Never throws:
// the caller folds this into a refresh where a verifier problem must not blank the chains.
export async function fetchIntentsHoldings(deps: IntentsBalanceDeps): Promise<IntentsRead> {
  const fetchedAt = new Date().toISOString();
  const accountId = deps.accountId.toLowerCase();
  try {
    const assetIds = await tokensForOwner(deps.rpcUrl, accountId, deps.fetchImpl);
    if (assetIds.length === 0) return { holdings: [], ok: true, fetchedAt };

    const [amounts, list] = await Promise.all([
      view(deps.rpcUrl, 'mt_batch_balance_of', { account_id: accountId, token_ids: assetIds }, deps.fetchImpl) as Promise<
        string[]
      >,
      // A token list that fails to load costs us the labels, not the balances.
      deps.tokenList().catch(() => [] as OneClickToken[]),
    ]);

    const holdings: IntentsHolding[] = [];
    for (const [i, assetId] of assetIds.entries()) {
      const raw = BigInt(amounts[i] ?? '0');
      if (raw <= 0n) continue; // enumerated but emptied since: not a holding
      const { symbol, decimals, originChain } = describe(assetId, list);
      holdings.push({
        accountId,
        assetId,
        symbol,
        originChain,
        amount: Number(raw) / 10 ** decimals,
        decimals,
      });
    }
    return { holdings, ok: true, fetchedAt };
  } catch (err) {
    return {
      holdings: [],
      ok: false,
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
