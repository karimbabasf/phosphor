// Drafting: how a symbol is priced, the shared tail every rail draft ends in, and the one draft
// that is not rail-backed (a policy change). The rail drafts themselves are in rails.ts.
//
// Every dollar figure here is derived rather than taken from the agent: a draft that could name
// its own dollar value could name a small one, and amountUsd is what every budget reads.

import type {
  ClientKey,
  LedgerSnapshot,
  PolicyPatch,
  Proposal,
  SimulationResult,
  WriteDraft,
} from '../types.ts';
import { evaluate } from '../policy/engine.ts';
import { loadPolicy } from '../policy/file.ts';
import { renderSentences } from '../policy/render.ts';
import type { RailDraft, RailKind } from '../rails/index.ts';
import { buildCtx, errText, mergePatch, newProposal, ownBook } from './lifecycle.ts';
import { land } from './execute.ts';
import type { PCtx } from './lifecycle.ts';

/* How old a spot price may be before this app stops sizing money against it.

   Two minutes, and the shape of the failure decides the number rather than taste. Prices come
   from one endpoint on a one-minute candle, so a reading inside two minutes is at worst one
   candle behind and a reading past it means the fetch has failed at least once and the value is
   being reused. The old loader reused it forever: on failure it wrote back the last known price
   with no timestamp, so a degraded endpoint during a real move meant every cap was measured
   against a price that no longer existed and nothing anywhere could tell.

   An expired price behaves exactly like an absent one, which already means priceOf returns null,
   usdOf returns Infinity and the engine refuses as invalid_amount. That path was built for the
   cold start and was already correct; this only widens what reaches it. Refusing beats guessing:
   a cap decided on a price this app cannot vouch for is not a cap. */
export const PRICE_STALENESS_MS = 120_000;

/* Whether the price for a symbol is one this app is still willing to govern against.

   A snapshot with no priceAsOf map is a demo or fixture snapshot, whose prices are a static
   table rather than a reading off a wire: there is no fetch time and nothing to be stale. A
   snapshot that HAS the map and no entry for this symbol is the opposite case, a live snapshot
   that cannot say when this number was read, and an unknown age is not a fresh one. */
function priceIsFresh(snapshot: LedgerSnapshot, symbol: string): boolean {
  const stamps = snapshot.priceAsOf;
  if (stamps === undefined) return true;
  const asOf = stamps[symbol];
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return false;
  return Date.now() - asOf <= PRICE_STALENESS_MS;
}

// What one unit of a symbol is worth, from what the app already knows: the risk table
// (stables are 1.0 everywhere in this app), then the ledger's own holdings, then the
// native spot table. null means this app cannot honestly price it.
export function priceOf(ctx: PCtx, symbol: string, snapshot: LedgerSnapshot): number | null {
  const upper = symbol.toUpperCase();
  if (ctx.stables.has(upper)) return 1;

  // Spot comes BEFORE the holdings table, and the order is the whole point.
  //
  // A holding's `usd` field carries this app's original stablecoin assumption: the EVM
  // reader sets usd = amount for every non-native token (ledger/evm.ts), which is right
  // for USDC and wrong for everything else. Reading it back as a price returns 1.0 for
  // any ERC-20 that is not a stable. That is not cosmetic: amountUsd is the number every
  // budget in the engine reads, so a WETH swap priced at its token count made the caps
  // meaningless. Observed live 2026-08-12: a 0.01 WETH swap (~$18.80) was governed as
  // $0.01, meaning 10 WETH (~$18,800) would have passed a $10,000 per-transaction cap.
  //
  // WETH is ETH wrapped: one dollar value, two contracts.
  const key = upper === 'WETH' ? 'ETH' : upper;
  const spot = snapshot.prices[key];
  if (typeof spot === 'number' && Number.isFinite(spot) && spot > 0) {
    return priceIsFresh(snapshot, key) ? spot : null;
  }

  // Fall back to the holdings table only for something we already treat as a dollar.
  // For anything else, return null: usdOf turns that into Infinity and the engine refuses
  // it as invalid_amount. A token the app cannot price is a token it cannot govern, and
  // refusing beats guessing 1.0 and letting an unbounded amount through.
  return null;
}

// USD the draft moves, which is the number every budget in the engine reads. Deliberately
// derived here rather than taken from the agent: a draft that could name its own dollar
// value could name a small one. A symbol the app cannot price becomes Infinity, never NaN,
// because the engine refuses a non-finite amount ('invalid_amount') where NaN would make
// every comparison against a cap false and sail through all of them.
export function usdOf(ctx: PCtx, symbol: string, amount: number, snapshot: LedgerSnapshot): number {
  const price = priceOf(ctx, symbol, snapshot);
  if (price === null || !Number.isFinite(amount) || amount < 0) return Infinity;
  return amount * price;
}

// Resolve something out of a verified table, collecting the table's own error message
// instead of throwing. The draft still gets built so the refusal has something to show.
export function resolve<T>(fn: () => T, problems: string[], fallback: T): T {
  try {
    return fn();
  } catch (err) {
    problems.push(errText(err));
    return fallback;
  }
}

// The one address this app owns: the EVM address of its signing key. It is the intents
// account id (the verifier derives the account from the erc191 signer, whatever chain an
// asset calls home) and the Hyperliquid account. The keystore is read first because the key
// is the truth, config.local.json second for an install that only reads, and the ledger's
// own rows last (demo mode). No wallet means nothing can be proposed, and the refusal says
// the one thing to do about it.
export function ourEvmAddress(ctx: PCtx, problems: string[]): string {
  const found = ownBook(ctx).evm[0] ?? ctx.ledger.intents()?.holdings[0]?.accountId ?? null;
  if (found === null) {
    problems.push('Make a wallet first.');
    return '';
  }
  return found;
}

// Who owns a balance held inside intents.near: the same EVM address. A SOL balance in there
// is owned by the EVM account, not by any Solana address, and the callers lowercase it the
// way the verifier does.
export function ourIntentsAddress(ctx: PCtx, problems: string[]): string {
  return ourEvmAddress(ctx, problems);
}

export function refuseDraft(ctx: PCtx, kind: RailKind, draft: RailDraft, reasons: string[], clientKey?: ClientKey): Promise<Proposal> {
  return land(ctx, newProposal(kind, draft, null, { outcome: 'refuse', reasons, rule: 'invalid_draft' }, clientKey));
}

// Shared tail for every rail: evaluate, simulate, persist, and execute only if the policy said
// allow. Nothing here knows which rail it is holding.
export async function proposeRail(ctx: PCtx, kind: RailKind, draft: RailDraft, clientKey?: ClientKey): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);

  // The engine runs first because it is pure and its refusals are terminal. An unlisted
  // venue, the kill switch or a cap breach settles the proposal without spending the
  // round trips a rail simulation costs.
  const verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));
  if (verdict.outcome === 'refuse') return land(ctx, newProposal(kind, draft, null, verdict, clientKey));

  const rail = ctx.rails.for(draft);
  if (rail === null) {
    return land(ctx, 
      newProposal(
        kind,
        draft,
        null,
        {
          outcome: 'refuse',
          reasons: [...verdict.reasons, `No ${kind} rail is wired in ${ctx.cfg.mode} mode, so there is nothing to execute.`],
          rule: 'no_rail',
        },
        clientKey,
      ),
    );
  }

  let simulation: SimulationResult;
  try {
    simulation = await rail.simulate(draft);
  } catch (err) {
    const message = errText(err);
    simulation = { ok: false, summary: `${kind} simulation threw: ${message}`, error: message };
  }

  // policy.outbound.simulateBeforeSign is a constant true and the UI says so, and this is
  // where it is enforced ('simulation_required'). A refusal rather than a pending proposal
  // on purpose: approve() re-runs the engine, not the simulation, so a failed simulation
  // parked as pending would quietly stop counting on its way to a human click.
  if (!simulation.ok) {
    return land(ctx, 
      newProposal(
        kind,
        draft,
        simulation,
        {
          outcome: 'refuse',
          reasons: [...verdict.reasons, `Simulation failed, so nothing is signed: ${simulation.error ?? simulation.summary}`],
          rule: 'simulation_required',
        },
        clientKey,
      ),
    );
  }

  return land(ctx, newProposal(kind, draft, simulation, verdict, clientKey));
}

// ---------- public surface ----------
export async function proposePolicyChange(ctx: PCtx, params: { patch: PolicyPatch; sentence: string; clientKey?: ClientKey }): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  /* THE PATCH THE AGENT WROTE, unchanged. It was rewritten here for a day, to bring the ask
     threshold down with a falling cap, and that was wrong in the way that matters: what the
     human clicked was then not what the agent had asked for, and the card described a change
     nobody had written. The engine refuses a pair that would collide instead, and the agent
     proposes both numbers in one patch. */
  const patch = params.patch;
  const draft: WriteDraft = { kind: 'policy_change', patch, sentence: params.sentence };
  const verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));

  let simulation: SimulationResult;
  if (policy === null) {
    simulation = { ok: false, summary: 'policy file is unreadable, so there is nothing to change', error: 'policy_unreadable' };
  } else if (verdict.outcome === 'refuse') {
    simulation = { ok: false, summary: `patch refused: ${verdict.rule}`, error: verdict.rule };
  } else {
    const after = renderSentences(mergePatch(policy, patch));
    // The +/- lines are the UI's to render from policyDiff; keeping them out of
    // summary stops the approval gate showing the same diff twice.
    simulation = {
      ok: true,
      summary: `the agent asked for: ${params.sentence}`,
      policyDiff: { before: policy.sentences, after },
    };
  }

  return land(ctx, newProposal('policy_change', draft, simulation, verdict, params.clientKey));
}
