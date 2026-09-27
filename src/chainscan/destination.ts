// What a payout needs to know about its receiver on the two ledgers whose accounts carry rules of
// their own: the XRP Ledger and Stellar.
//
// Both ledgers let an account say "a payment to me must carry a memo" (XRPL's RequireDestTag flag,
// Stellar's SEP-29 data entry config.memo_required), both refuse a first payment smaller than the
// reserve that creates the account, and Stellar holds a token only on a trustline the receiver
// opened. A payout from NEAR Intents can carry no memo at all (1Click's quote has no field for
// one), so these are facts a payout is refused on, read before the quote and again before the key
// is touched. Same hosts, same fetch fence and the same shape checks as every other chain read;
// the answer holds booleans and numbers, and a trustline's code and issuer only as identifiers.

import { chainFetch } from './fetch.ts';
import { validateAddress } from './networks.ts';
import type { ChainNetwork } from './networks.ts';
import { api, dataText, idText, list, num, rec } from './common.ts';
import type { ChainDeps } from './common.ts';

export type StellarLine = { code: string; issuer: string; authorized: boolean; balance: string; limit: string };

export type PayTarget =
  | { network: 'xrp'; exists: boolean; requireDestTag: boolean; reserveXrp: number | null }
  | { network: 'stellar'; exists: boolean; memoRequired: boolean; trustlines: StellarLine[] };

// The account flag an XRPL account sets to refuse any payment without a destination tag.
export const LSF_REQUIRE_DEST_TAG = 0x00020000;

function isHttp404(err: unknown): boolean {
  return err instanceof Error && err.message === 'http 404';
}

// The XRP Ledger answers errors inside `result`, the same reading src/chainscan/families.ts does.
async function xrpl(method: string, params: Record<string, unknown>, deps: ChainDeps): Promise<Record<string, unknown>> {
  return rec(rec(await chainFetch(api('xrp', '/'), { method: 'POST', body: JSON.stringify({ method, params: [params] }) }, deps)).result);
}

async function xrpTarget(address: string, deps: ChainDeps): Promise<PayTarget> {
  const [account, server] = await Promise.all([
    xrpl('account_info', { account: address, ledger_index: 'validated' }, deps),
    // The reserve is the ledger's, voted by validators (1 XRP since December 2024), so it is read
    // rather than remembered; a server that will not say leaves it null and the rule says so.
    xrpl('server_info', {}, deps).catch(() => ({})),
  ]);
  const reserve = num(rec(rec(rec(server).info).validated_ledger).reserve_base_xrp);
  const reserveXrp = reserve !== null && reserve > 0 ? reserve : null;
  if (account.error === 'actNotFound') return { network: 'xrp', exists: false, requireDestTag: false, reserveXrp };
  if (account.error !== undefined) throw new Error(`xrpl ${dataText(account.error, 40)}`);
  const flags = num(rec(account.account_data).Flags);
  if (flags === null) throw new Error('the account answer carried no flags');
  return { network: 'xrp', exists: true, requireDestTag: (flags & LSF_REQUIRE_DEST_TAG) !== 0, reserveXrp };
}

async function stellarTarget(address: string, deps: ChainDeps): Promise<PayTarget> {
  let account: Record<string, unknown>;
  try {
    account = rec(await chainFetch(api('stellar', `/accounts/${encodeURIComponent(address)}`), {}, deps));
  } catch (err) {
    // An account that was never sent its base reserve does not exist yet.
    if (isHttp404(err)) return { network: 'stellar', exists: false, memoRequired: false, trustlines: [] };
    throw err;
  }
  // SEP-29: the value is base64, and "1" is the only one that means required.
  const flag = rec(account.data)['config.memo_required'];
  const memoRequired = typeof flag === 'string' && Buffer.from(flag, 'base64').toString('utf8') === '1';
  const trustlines: StellarLine[] = [];
  for (const b of list(account.balances).map(rec)) {
    if (b.asset_type === 'native' || b.asset_type === 'liquidity_pool_shares') continue;
    const code = dataText(b.asset_code, 12);
    const issuer = idText(b.asset_issuer) ?? '';
    const balance = typeof b.balance === 'string' ? b.balance : '0';
    const limit = typeof b.limit === 'string' ? b.limit : '0';
    trustlines.push({ code, issuer, authorized: b.is_authorized !== false, balance, limit });
  }
  return { network: 'stellar', exists: true, memoRequired, trustlines };
}

/* The receiver's rules on a ledger that has them, or null for every other chain. Throws when the
   ledger does not answer: the caller decides what an unanswered rule means, and for a payout it
   means the payout is refused. */
export async function payTarget(network: ChainNetwork, address: string, deps: ChainDeps = {}): Promise<PayTarget | null> {
  if (network !== 'xrp' && network !== 'stellar') return null;
  const checked = validateAddress(network, address);
  if (!checked.ok) throw new Error(checked.reason);
  return network === 'xrp' ? xrpTarget(checked.normalized, deps) : stellarTarget(checked.normalized, deps);
}
