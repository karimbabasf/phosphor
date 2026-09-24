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
// Read only. Two view calls, no signing, nothing here can move money.

import type { OneClickToken } from '../intents.ts';
import { READ_TIMEOUT_MS, readTimeout } from '../net.ts';

export const INTENTS_VERIFIER = 'intents.near';

// The ledger's idle cadence (src/main.ts polls on it), kept beside the one rule that depends on
// it: how old a verifier read may be before the wallet report calls it unread. Two idle periods
// plus one read budget, so a second attempt still in flight does not turn a single miss into a
// warning on the screen.
export const REFRESH_PERIOD_MS = 15_000;
export const INTENTS_UNREAD_AFTER_MS = REFRESH_PERIOD_MS * 2 + READ_TIMEOUT_MS;

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
  // The verifier's own integer, as a decimal string. A floor decision (did this swap credit
  // what it was approved with) compares this and never `amount` multiplied back up. Optional
  // only for the hand-built rows in tests; every row this module returns carries it.
  amountBase?: string;
  decimals: number;
  /* 1Click's own USD price for this asset, off the token list it was labelled from, and when that
     list was fetched. The price of last resort: read only where no other source prices the coin
     (src/proposals/draft.ts priceOf, src/wallet.ts). Null when 1Click lists no price either, which
     stays unknown and never becomes zero. */
  priceUsd?: number | null;
  priceAsOf?: number;
};

export type IntentsRead = {
  holdings: IntentsHolding[];
  ok: boolean;
  // When the holdings above were read. A failed read that kept the last good holdings keeps
  // their stamp too, so this always says how old the numbers on screen are.
  fetchedAt: string;
  error?: string;
  // Failed reads in a row, 0 after a good one. Optional only for hand-built reads in tests;
  // the ledger always writes it. See intentsUnreadWhy for what the count buys.
  failures?: number;
};

/* Why the wallet report should say the verifier could not be checked, or null while there is
   nothing worth saying. One miss is a miss: the ledger is read every few seconds, a public RPC
   drops one call in twenty on a bad afternoon, and a warning that follows every single miss
   flashes on and off over a balance that is perfectly readable (the Money card, 2026-09-16).
   Two misses in a row are a pattern. So are holdings nobody has re-read for two idle periods,
   whatever the last read said: a number nobody is refreshing is not a number to act on. A stamp
   the reader cannot parse says nothing about age, so only the count can mark it. */
export function intentsUnreadWhy(read: IntentsRead, now: number = Date.now()): string | null {
  const failures = read.failures ?? (read.ok ? 0 : 1);
  if (failures >= 2) return read.error ?? 'the verifier did not answer twice in a row';
  const at = Date.parse(read.fetchedAt);
  if (Number.isFinite(at) && now - at > INTENTS_UNREAD_AFTER_MS) return `last read ${Math.round((now - at) / 1000)} s ago`;
  return null;
}

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
    signal: readTimeout(),
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
function describe(assetId: string, list: OneClickToken[]): { symbol: string; decimals: number; originChain: string; priceUsd: number | null } {
  const meta = list.find((t) => t.assetId === assetId);
  if (meta === undefined) return { symbol: assetId, decimals: 0, originChain: 'intents', priceUsd: null };
  const price = typeof meta.price === 'number' && Number.isFinite(meta.price) && meta.price > 0 ? meta.price : null;
  return { symbol: meta.symbol, decimals: meta.decimals, originChain: meta.blockchain, priceUsd: price };
}

export type IntentsBalanceDeps = {
  rpcUrl: string;
  accountId: string;
  tokenList: () => Promise<OneClickToken[]>;
  // When the list tokenList answers with was fetched; the stamp its prices are aged by.
  listedAt?: () => number | null;
  fetchImpl: typeof fetch;
};

export type IntentsAssetBalanceDeps = {
  rpcUrl: string;
  accountId: string;
  assetId: string;
  fetchImpl: typeof fetch;
};

/* One asset, one round trip, for a caller that already knows which asset it is moving.
   fetchIntentsHoldings enumerates first because the wallet panel does not know what it will
   find. A swap does know, so mt_batch_balance_of over a one-element list answers it without
   the enumeration, and the balance floor a swap checks costs one view call instead of two.

   It also returns the verifier's own integer. Reading a base-unit floor off the panel's UI
   amount meant multiplying a float back up by the decimals, and that round trip is not a
   thing to do to a number that decides whether a swap is reported as short.

   Never throws. null means the verifier would not answer, which every caller reads as "no
   check was made" and never as a zero balance. */
export async function fetchIntentsAssetBalance(deps: IntentsAssetBalanceDeps): Promise<bigint | null> {
  try {
    const amounts = (await view(
      deps.rpcUrl,
      'mt_batch_balance_of',
      { account_id: deps.accountId.toLowerCase(), token_ids: [deps.assetId] },
      deps.fetchImpl,
    )) as unknown;
    if (!Array.isArray(amounts) || amounts.length !== 1) return null;
    const raw = amounts[0] as unknown;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}

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

    /* mt_batch_balance_of answers POSITIONALLY: amounts[i] is the balance of assetIds[i] and
       nothing in the response says so. A short array silently dropped holdings and a reordered
       one attributed the wrong balance to the wrong asset, which is worse than a read failure
       because it produces a number that looks right. */
    if (!Array.isArray(amounts) || amounts.length !== assetIds.length) {
      throw new Error(
        `the verifier returned ${Array.isArray(amounts) ? String(amounts.length) : 'a non-list of'} balances for ` +
          `${assetIds.length} assets, and they are matched by position`,
      );
    }

    const listedAt = deps.listedAt?.() ?? null;
    const holdings: IntentsHolding[] = [];
    for (const [i, assetId] of assetIds.entries()) {
      const raw = BigInt(amounts[i] ?? '0');
      if (raw <= 0n) continue; // enumerated but emptied since: not a holding
      const { symbol, decimals, originChain, priceUsd } = describe(assetId, list);
      holdings.push({
        accountId,
        assetId,
        symbol,
        originChain,
        amount: Number(raw) / 10 ** decimals,
        amountBase: raw.toString(),
        decimals,
        priceUsd,
        ...(listedAt === null ? {} : { priceAsOf: listedAt }),
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
