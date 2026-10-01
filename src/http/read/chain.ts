// The chain reads: public data about any address or transaction on a network this app knows,
// and the intents ledger of an account. Four more answers that come from off the machine, and
// the same three things make that safe enough that make research safe: the hosts are fixed in
// src/chainscan/networks.ts and checked by exact match, the agent supplies a network from a
// closed enum plus an address or a hash that has to pass its shape before a URL exists, and
// every string in the answer is stripped, capped and labelled as data. The agent's arguments
// are in the audit log already: every read is written there before dispatch.
//
// A shape that fails is a 400 with the reason. A source that fails is a 200 with `ok: false`
// and the failure named, the way research names a dead feed: the lookup happened, and the
// answer is that nothing could be read, which is different from having asked wrongly.

import { fail, intParam, sendJson } from '../respond.ts';
import { evmAddress } from '../../keystore/index.ts';
import { addressSummary, CHAIN_NETWORKS, DEFAULT_LIMIT, intentsActivity, isChainNetwork, MAX_LIMIT, transaction, transactions, validateAddress, validateHash } from '../../chainscan/index.ts';
import type { ChainDeps, IntentsRow } from '../../chainscan/index.ts';
import { LOG_LIMIT_MAX } from '../context.ts';
import type { Ctx, ReadTable } from '../context.ts';

// Our own intents account id: the EVM address, lowercased, read off the keystore header the
// way the ledger names it. The config address book is the fallback for an install that only
// reads, and null is an install with neither, which the tool then says out loud.
function ownAccount(ctx: Ctx): string | null {
  try {
    return evmAddress(ctx.cfg.keysPath).toLowerCase();
  } catch {
    const configured = ctx.cfg.addresses.evm;
    return typeof configured === 'string' && configured.trim() !== '' ? configured.trim().toLowerCase() : null;
  }
}

const NETWORK_HINT = `network must be one of ${CHAIN_NETWORKS.join(', ')}`;

export const INVITE_COUNTERPARTY_LABEL = 'Phosphor invite';

/* A transfer from an invite code's account reads as a bare 0x on NearBlocks. The code accounts
   this app claimed from are in its own audit log (invite_claimed, src/invite/claim.ts), so a row
   whose counterparty is one of them says what it was. The address is public; the code never is. */
function labelInvites(ctx: Ctx, rows: IntentsRow[]): IntentsRow[] {
  const codes = new Set<string>();
  // A context built by hand for one read may carry no audit log; then nothing is labelled.
  for (const event of ctx.audit?.tail(LOG_LIMIT_MAX) ?? []) {
    if (event.type !== 'invite_claimed') continue;
    const address = (event.data as { codeAddress?: unknown } | undefined)?.codeAddress;
    if (typeof address === 'string') codes.add(address.toLowerCase());
  }
  if (codes.size === 0) return rows;
  return rows.map((row) => (row.counterparty !== null && codes.has(row.counterparty.toLowerCase()) ? { ...row, counterpartyLabel: INVITE_COUNTERPARTY_LABEL } : row));
}

// Built over injectable deps so a test can hand in a fetch and a reader; the keys come from
// config on every call rather than being captured, because the table is built at import time.
export function chainReadsWith(deps: ChainDeps = {}): ReadTable {
  const depsFor = (ctx: Ctx): ChainDeps => ({ ...deps, keys: deps.keys ?? ctx.cfg.chainscan });
  return {
    chain_address: async (ctx, _body, args, res) => {
      if (!isChainNetwork(args.network)) return fail(res, 400, NETWORK_HINT);
      const check = validateAddress(args.network, String(args.address ?? ''));
      if (!check.ok) return fail(res, 400, check.reason);
      sendJson(res, 200, await addressSummary(args.network, check.normalized, depsFor(ctx)));
    },
    chain_transactions: async (ctx, _body, args, res) => {
      if (!isChainNetwork(args.network)) return fail(res, 400, NETWORK_HINT);
      const check = validateAddress(args.network, String(args.address ?? ''));
      if (!check.ok) return fail(res, 400, check.reason);
      sendJson(res, 200, await transactions(args.network, check.normalized, intParam(args.limit, DEFAULT_LIMIT, MAX_LIMIT), depsFor(ctx)));
    },
    chain_transaction: async (ctx, _body, args, res) => {
      if (!isChainNetwork(args.network)) return fail(res, 400, NETWORK_HINT);
      const check = validateHash(args.network, String(args.hash ?? ''));
      if (!check.ok) return fail(res, 400, check.reason);
      sendJson(res, 200, await transaction(args.network, check.normalized, depsFor(ctx)));
    },
    intents_activity: async (ctx, _body, args, res) => {
      const own = ownAccount(ctx);
      const given = typeof args.account === 'string' ? args.account.trim() : '';
      const account = given !== '' ? given : own;
      if (account === null) return fail(res, 400, 'no account: this app has no wallet address yet, and none was given');
      const check = validateAddress('near', account);
      if (!check.ok) return fail(res, 400, check.reason);
      const answer = await intentsActivity(check.normalized, intParam(args.limit, DEFAULT_LIMIT, MAX_LIMIT), depsFor(ctx));
      // Whether this is the app's own ledger, so an agent never mistakes a stranger's for ours.
      sendJson(res, 200, { ...answer, rows: labelInvites(ctx, answer.rows), own: check.normalized === own });
    },
  };
}

export const chainReads: ReadTable = chainReadsWith();
