// A deposit address for the NEAR Intents balance: the plain "here is where to send it" that
// every wallet has and this app did not.
//
// WHY THIS AND NOT THE 1CLICK ADDRESS THE DEPOSIT RAIL ALREADY MINTS. src/rails/intents-deposit.ts
// asks 1Click for a quote and sends to the address that quote mints. That address belongs to one
// quote, one asset and one amount, and it stops working at the quote's deadline, which the API
// documents as "the time when the deposit address becomes inactive and funds may be lost". It is
// a swap deposit, and it is the right shape when the app is the one spending.
//
// This is the other question: a person, or an exchange withdrawal, sending money in from outside.
// Nothing here quotes, nothing here has an amount, and nothing here expires. The POA bridge hands
// back one address per (account, network) and hands back the SAME address every time, so it can
// be drawn once, put behind a QR code, saved in an exchange's address book, and used again next
// month. That is what a person means by a deposit address.
//
// WHAT IT IS, precisely: an address the bridge controls, which forwards what it receives to the
// verifier and credits it to our account id. Phosphor never holds it and never sends to it, so it
// is deliberately NOT on the policy allowlist and does not belong there: the allowlist governs
// what this app may send to, and this is an address other people send to. Reading it is a read.
//
// THE ACCOUNT ID IS THE EVM ADDRESS, lowercased, which is the same id the verifier keys balances
// by and the same one src/ledger/intents.ts reads with. Probed against the live bridge: it is
// case insensitive on the account id, it returns one address for all three EVM networks, and it
// refuses an account id it cannot parse rather than inventing one.

import type { ChainId } from '../types.ts';
import { readTimeout } from '../net.ts';

export const POA_BRIDGE_RPC = 'https://bridge.chaindefuser.com/rpc';

/* The bridge names networks with the defuse asset identifier prefix, not the short name this app
   uses everywhere else. A bare 'eth' is answered with "Network not supported", so the mapping is
   explicit rather than derived: a wrong network id here would print an address that belongs to a
   different chain, and money sent to it is not recoverable. */
export const POA_NETWORK: Record<ChainId, string> = {
  eth: 'eth:1',
  base: 'eth:8453',
  arb: 'eth:42161',
  sol: 'sol:mainnet',
  near: 'near:mainnet',
};

export type PoaDepositAddress = {
  chain: ChainId;
  network: string;
  address: string;
  // Set only on the chains that route by memo. None of the five this app knows do, so this is
  // null in practice and carried anyway: a memo silently dropped is a lost deposit, so the field
  // exists to be rendered rather than to be assumed absent.
  memo: string | null;
};

type RpcResult = { result?: { address?: unknown; chain?: unknown; memo?: unknown }; error?: unknown };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function rpc(method: string, params: unknown[], fetchImpl: typeof fetch): Promise<RpcResult> {
  const res = await fetchImpl(POA_BRIDGE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'phosphor', jsonrpc: '2.0', method, params }),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`poa bridge ${method} http ${res.status}`);
  return (await res.json()) as RpcResult;
}

/* One address for one account on one network.
 *
 * Throws rather than returning null, because every failure here has a different answer for the
 * person reading the screen: an unsupported network is a permanent no, a rejected account id is
 * a bug in what we sent, and a timeout is "try again". A single null would flatten the three into
 * one blank box beside a QR code, and a blank box next to the words "deposit address" is the
 * worst thing this module could produce.
 */
export async function intentsDepositAddress(
  accountId: string,
  chain: ChainId,
  fetchImpl: typeof fetch = fetch,
): Promise<PoaDepositAddress> {
  const network = POA_NETWORK[chain];
  if (network === undefined) throw new Error(`no bridge network is mapped for ${chain}`);

  let body: RpcResult;
  try {
    body = await rpc('deposit_address', [{ account_id: accountId.toLowerCase(), chain: network }], fetchImpl);
  } catch (err) {
    throw new Error(`the bridge did not answer for ${network}: ${errText(err)}`);
  }

  if (body.error !== undefined) {
    const said = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    throw new Error(`the bridge refused ${network}: ${said}`);
  }

  const address = body.result?.address;
  /* An address is the whole answer, so a response that does not carry one as a non-empty string
     is a failure however cheerful its status code was. Rendering an empty string under a QR code
     would be a receive screen that tells somebody to send money nowhere. */
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error(`the bridge answered for ${network} without an address`);
  }

  const memo = body.result?.memo;
  return {
    chain,
    network,
    address: address.trim(),
    memo: typeof memo === 'string' && memo.trim() !== '' ? memo.trim() : null,
  };
}

export type PoaToken = {
  network: string;
  symbol: string;
  decimals: number;
  minDeposit: string;
  intentsAssetId: string;
};

/* What the bridge will actually accept, per network. This is the half of a receive screen that
   stops a loss: an asset the bridge does not list for that network is not credited and is not
   refunded, so the screen names what may be sent rather than leaving a person to guess from the
   address alone. Never throws; an unreadable list costs the guidance, not the address. */
export async function poaSupportedTokens(fetchImpl: typeof fetch = fetch): Promise<PoaToken[]> {
  try {
    const body = (await rpc('supported_tokens', [{}], fetchImpl)) as { result?: { tokens?: unknown } };
    const rows = body.result?.tokens;
    if (!Array.isArray(rows)) return [];
    const out: PoaToken[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const id = r.defuse_asset_identifier;
      const symbol = r.asset_name;
      const decimals = r.decimals;
      const min = r.min_deposit_amount;
      const assetId = r.intents_token_id;
      if (typeof id !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number') continue;
      out.push({
        // 'eth:1:0xa0b8...' or 'eth:1' for a native asset: the network is the first two segments.
        network: id.split(':').slice(0, 2).join(':'),
        symbol,
        decimals,
        minDeposit: typeof min === 'string' ? min : String(min ?? '0'),
        intentsAssetId: typeof assetId === 'string' ? assetId : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

export type PoaDeposit = { txHash: string; amount: string; status: string; asset: string };

/* What the bridge has SEEN, which is not the same question as what the verifier has CREDITED.
   The settled truth is mt_batch_balance_of in src/ledger/intents.ts, and that is what the wallet
   reports. This exists to answer the ten minutes in between, when a person has sent money and the
   balance has not moved yet, so the screen can say "seen, not credited" instead of nothing. Never
   throws: this is a nicety on top of a balance that is read elsewhere. */
export async function poaRecentDeposits(
  accountId: string,
  chain: ChainId,
  fetchImpl: typeof fetch = fetch,
  limit = 10,
): Promise<PoaDeposit[]> {
  const network = POA_NETWORK[chain];
  if (network === undefined) return [];
  try {
    const body = (await rpc(
      'recent_deposits',
      [{ account_id: accountId.toLowerCase(), chain: network, limit }],
      fetchImpl,
    )) as { result?: { deposits?: unknown } };
    const rows = body.result?.deposits;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        txHash: typeof r.tx_hash === 'string' ? r.tx_hash : '',
        amount: typeof r.amount === 'string' ? r.amount : String(r.amount ?? ''),
        status: typeof r.status === 'string' ? r.status : 'unknown',
        asset: typeof r.defuse_asset_identifier === 'string' ? r.defuse_asset_identifier : '',
      };
    });
  } catch {
    return [];
  }
}
