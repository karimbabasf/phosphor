// What happens to a proposal the app was in the middle of executing when it died.
//
// `executing` is written before the rail is called and overwritten after it answers. Kill the
// process in between and the row stays `executing` forever, which is the worst of the three
// possible states: `requirePending` refuses to approve, refuse or retry it, so it is
// unactionable, and `sessionSpentUsd` counts it against the 24h cap for the whole window, so one
// crash eats the day's spend budget. Nothing on any surface said the money might have moved.
//
// Boot rewrites every such row to `needs_reconciliation`: not executed, not failed, and honest
// about which. It carries whatever hashes were recorded, it is excluded from the spend cap, and
// the window renders it as "this may or may not have sent".
//
// `reconcile` is the way out. It takes the hashes and asks the chain. It never guesses: a hash
// that cannot be looked up leaves the proposal exactly where it was, with a sentence saying why.

import type { ChainId, Proposal, WriteDraft } from '../types.ts';
import { errText, nowIso, persist } from './lifecycle.ts';
import type { PCtx } from './lifecycle.ts';

// What the chain says about one hash. `unknown` is a real answer and the most important one:
// it means this app cannot check that chain, which is different from the transaction not being
// there. Reporting `absent` for a chain we never asked would be a lie that reads as "no funds
// left the wallet".
export type TxState = 'confirmed' | 'reverted' | 'pending' | 'absent' | 'unknown';
export type TxLookup = (chain: ChainId, hash: string) => Promise<TxState>;

const EVM_CHAINS: ChainId[] = ['eth', 'base', 'arb'];

// Which chains a draft's origin transaction could be on. Consolidate and transfer name their
// legs; every rail draft carries the origin chain in `chain`. Nothing here guesses beyond what
// the draft says, so a hash with no candidate chain reads as unknown rather than absent.
export function chainsOf(draft: WriteDraft): ChainId[] {
  if (draft.kind === 'consolidate') return [...new Set(draft.legs.map(l => l.fromChain))];
  if (draft.kind === 'transfer') return [draft.leg.fromChain];
  if (draft.kind === 'policy_change') return [];
  const chain = (draft as { chain?: ChainId }).chain;
  return chain === undefined ? [] : [chain];
}

export function looksLikeEvmHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

// The default reader. viem's public client per chain, which the rails already use, so this adds
// no dependency and no second view of the chain. Non-EVM chains answer `unknown` rather than
// pretending: NEAR and Solana hashes are base58 and the receipt read for each is a different
// shape, which is a second piece of work and not a silent one.
export function chainTxLookup(): TxLookup {
  return async function lookup(chain: ChainId, hash: string): Promise<TxState> {
    if (!EVM_CHAINS.includes(chain)) return 'unknown';
    if (!looksLikeEvmHash(hash)) return 'unknown';
    const { reader } = await import('../chain/evm.ts');
    const client = reader(chain);
    try {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      return receipt.status === 'success' ? 'confirmed' : 'reverted';
    } catch {
      // No receipt. Either it is still in the mempool or it never existed, and those are two
      // very different sentences to show someone who is asking whether their money moved.
      try {
        await client.getTransaction({ hash: hash as `0x${string}` });
        return 'pending';
      } catch {
        return 'absent';
      }
    }
  };
}

/* Boot sweep. Runs once, before the port opens, so no surface ever renders an `executing` row
   left by a process that is gone. Returns what it changed, for the audit line and the tests. */
export function reconcileOnBoot(ctx: PCtx): Proposal[] {
  const stranded = ctx.store.list().filter(p => p.status === 'executing');
  const moved: Proposal[] = [];
  for (const p of stranded) {
    const txids = p.result?.txids ?? [];
    const detail =
      txids.length > 0
        ? `Phosphor stopped while this was executing. ${txids.length} transaction hash(es) were recorded, so it may already have sent.`
        : 'Phosphor stopped while this was executing and no transaction hash was recorded, so it may or may not have sent.';
    moved.push(
      persist(ctx, {
        ...p,
        status: 'needs_reconciliation',
        result: { ok: false, detail, txids },
      }),
    );
  }
  if (moved.length > 0) {
    ctx.audit.append(
      'error',
      `${moved.length} proposal(s) were mid-execution when Phosphor last stopped and are now waiting to be reconciled`,
      { ids: moved.map(p => p.id) },
    );
  }
  return moved;
}

function summarise(states: Array<{ hash: string; state: TxState }>): { status: Proposal['status']; detail: string } {
  const by = (s: TxState): string[] => states.filter(x => x.state === s).map(x => x.hash);
  const reverted = by('reverted');
  const pending = by('pending');
  const unknown = by('unknown');
  const absent = by('absent');
  const confirmed = by('confirmed');

  if (reverted.length > 0) {
    return { status: 'failed', detail: `the chain rejected ${reverted.join(', ')}, so nothing moved on that transaction` };
  }
  if (pending.length > 0) {
    return {
      status: 'needs_reconciliation',
      detail: `${pending.join(', ')} is broadcast and not yet included in a block. Check again shortly.`,
    };
  }
  if (unknown.length > 0) {
    return {
      status: 'needs_reconciliation',
      detail: `Phosphor cannot read that chain's transactions, so ${unknown.join(', ')} has to be checked in a block explorer by hand.`,
    };
  }
  if (absent.length > 0 && confirmed.length === 0) {
    return { status: 'failed', detail: `no transaction with hash ${absent.join(', ')} exists on chain, so nothing was sent` };
  }
  if (absent.length > 0) {
    return {
      status: 'needs_reconciliation',
      detail: `${confirmed.length} transaction(s) confirmed and ${absent.length} cannot be found, so this move is part done`,
    };
  }
  return { status: 'executed', detail: `confirmed on chain: ${confirmed.join(', ')}` };
}

/* Ask the chain what happened. Only reachable for a row the boot sweep created, because
   re-checking anything else would be re-deciding a proposal that already has an answer. */
export async function reconcileProposal(ctx: PCtx, id: string): Promise<Proposal> {
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'needs_reconciliation') {
    throw new Error(`proposal ${id} is ${p.status}, and only a proposal waiting to be reconciled can be re-checked`);
  }

  const txids = p.result?.txids ?? [];
  if (txids.length === 0) {
    // Nothing to look up. Say so and change nothing: an app that cleared this row would be
    // asserting that no funds moved, which is exactly what it does not know.
    const detail =
      'No transaction hash was recorded, so there is nothing to look up on chain. ' +
      'Compare the balances before and after on the receipt, or search the wallet address in a block explorer.';
    ctx.audit.append('error', `${id}: reconcile found no hash to check`, { id });
    return persist(ctx, { ...p, result: { ok: false, detail, txids } });
  }

  const chains = chainsOf(p.draft);
  const states: Array<{ hash: string; state: TxState }> = [];
  for (const hash of txids) {
    let best: TxState = 'unknown';
    for (const chain of chains) {
      let state: TxState;
      try {
        state = await ctx.txLookup(chain, hash);
      } catch (err) {
        ctx.audit.append('error', `${id}: reading ${chain} for ${hash} failed: ${errText(err)}`, { id, chain, hash });
        state = 'unknown';
      }
      // A definite answer on any candidate chain beats an absence on the others: a hash only
      // exists on the one chain it was broadcast to.
      if (state === 'confirmed' || state === 'reverted' || state === 'pending') {
        best = state;
        break;
      }
      if (state === 'absent' && best === 'unknown') best = 'absent';
    }
    states.push({ hash, state: best });
  }

  const outcome = summarise(states);
  ctx.audit.append(
    outcome.status === 'executed' ? 'executed' : 'error',
    `${id} reconciled: ${outcome.status}. ${outcome.detail}`,
    { id, states },
  );
  return persist(ctx, {
    ...p,
    status: outcome.status,
    decidedAt: p.decidedAt ?? nowIso(),
    result: { ok: outcome.status === 'executed', detail: outcome.detail, txids },
  });
}
