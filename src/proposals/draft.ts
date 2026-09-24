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
  Rail,
  SimulationResult,
  SwapDraft,
  Verdict,
  WriteDraft,
} from '../types.ts';
import { evaluate } from '../policy/engine.ts';
import { loadPolicy } from '../policy/file.ts';
import { renderSentences } from '../policy/render.ts';
import type { RailDraft, RailKind } from '../rails/index.ts';
import { isReasonCode, reasonOf } from '../rails/reasons.ts';
import type { ReasonCode } from '../rails/reasons.ts';
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

/* A wrapper is the coin it wraps, priced. WETH is ETH behind an ERC-20, wNEAR is NEAR behind
   wrap.near, and the spot table only carries the natives. Keyed uppercase because the wallet and
   the engine both look up through this and used to disagree on case. Karim, 2026-09-20: 2.0097
   wNEAR sat in NEAR Intents "not priced", the wallet read $0.00 over seven dollars, and the swap
   out of it was refused as an unbounded amount. One table, both readers. */
const WRAPPED_AS: Record<string, string> = { WETH: 'ETH', WNEAR: 'NEAR' };
export function pricedAs(symbol: string): string {
  const upper = symbol.toUpperCase();
  return WRAPPED_AS[upper] ?? upper;
}

// What one unit of a symbol is worth, from what the app already knows: the risk table
// (stables are 1.0 everywhere in this app), then the native spot table, then 1Click's own price
// for the asset held (listedPrice). null means this app cannot honestly price it.
export function priceOf(ctx: PCtx, symbol: string, snapshot: LedgerSnapshot, assetId?: string): number | null {
  return pricing(ctx, symbol, snapshot, assetId)?.price ?? null;
}

/* The same price with where it came from: a stable, the spot table, or 1Click's list, the price of
   last resort. A swap priced by the list alone is bounded by its quote (src/proposals/rails.ts). */
export type PriceSource = 'stable' | 'spot' | 'list';

export function pricing(ctx: PCtx, symbol: string, snapshot: LedgerSnapshot, assetId?: string): { price: number; source: PriceSource } | null {
  const upper = symbol.toUpperCase();
  if (ctx.stables.has(upper)) return { price: 1, source: 'stable' };

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
  const key = pricedAs(upper);
  const spot = snapshot.prices[key];
  if (typeof spot === 'number' && Number.isFinite(spot) && spot > 0) {
    return priceIsFresh(snapshot, key) ? { price: spot, source: 'spot' } : null;
  }

  // Then 1Click's own price for the coin held, the price of last resort. For anything it does not
  // price either, null: usdOf turns that into Infinity and the engine refuses it as
  // invalid_amount. A token the app cannot price is a token it cannot govern, and refusing beats
  // guessing 1.0 and letting an unbounded amount through.
  const listed = listedPrice(ctx, upper, assetId);
  return listed === null ? null : { price: listed, source: 'list' };
}

/* 1CLICK'S PRICE FOR A COIN THE BALANCE HOLDS, off the token list the ledger labelled it from. Any
   coin 1Click lists has one, so a swap out of WBTC is governed by its limit instead of waiting on
   a click as unpriced (2026-09-23). Held to the same age as a spot price, PRICE_STALENESS_MS,
   counted from when the list was fetched. By asset id where the caller knows it; by symbol only
   when one held asset carries it, since two coins under one name are two prices. */
function listedPrice(ctx: PCtx, upper: string, assetId?: string): number | null {
  const read = ctx.ledger.intents();
  if (read === undefined) return null;
  const rows = read.holdings.filter((h) => (assetId !== undefined ? h.assetId === assetId : h.symbol.toUpperCase() === upper));
  const ids = new Set(rows.map((h) => h.assetId));
  const row = rows[0];
  if (row === undefined || ids.size !== 1) return null;
  if (typeof row.priceUsd !== 'number' || !(row.priceUsd > 0) || row.priceAsOf === undefined) return null;
  return Date.now() - row.priceAsOf <= PRICE_STALENESS_MS ? row.priceUsd : null;
}

// USD the draft moves, which is the number every budget in the engine reads. Deliberately
// derived here rather than taken from the agent: a draft that could name its own dollar
// value could name a small one. A symbol the app cannot price becomes Infinity, never NaN,
// because the engine refuses a non-finite amount ('invalid_amount') where NaN would make
// every comparison against a cap false and sail through all of them.
export function usdOf(ctx: PCtx, symbol: string, amount: number, snapshot: LedgerSnapshot, assetId?: string): number {
  const price = priceOf(ctx, symbol, snapshot, assetId);
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

/* Who is proposing: the idempotency key they chose and the seat they hold. Every propose door
   passes its params object as this, so a rail never has to know either field by name. */
export type Origin = { clientKey?: ClientKey; by?: string | null; webRead?: boolean };

/* A draft the app itself will not file. The rule stays `invalid_draft`, the app's own wall and
   never the person's; `code` is the cause the card and the agent read (src/rails/reasons.ts):
   no price, a coin the venue does not list, more than the balance holds. */
export function refuseDraft(ctx: PCtx, kind: RailKind, draft: RailDraft, reasons: string[], origin?: Origin, code?: ReasonCode): Promise<Proposal> {
  return land(
    ctx,
    newProposal(kind, draft, null, { outcome: 'refuse', reasons, rule: 'invalid_draft', ...(code === undefined ? {} : { reasonCodes: [code] }) }, origin),
  );
}

/* The one refusal a quote can lift: a swap spending a coin the app cannot price, into one it can,
   is valued off what the quote says arrives (proposeRail below). */
function liftableByQuote(ctx: PCtx, verdict: Verdict, draft: RailDraft, snapshot: LedgerSnapshot): boolean {
  return (
    verdict.outcome === 'refuse' &&
    verdict.rule === 'invalid_amount' &&
    draft.kind === 'swap' &&
    !Number.isFinite(draft.amountUsd) &&
    priceOf(ctx, draft.toSymbol, snapshot) !== null
  );
}

/* THE SIMULATION, TAKEN BEFORE THE QUEUE. It is a network read, and a read inside the spend queue
   holds every approve and refuse behind it (R5 B2). Skipped where the engine refuses the draft as
   it stands and no quote could change that (a kill switch, a cap), so a refused move still costs
   no round trip. What it returns is only an input: proposeRail runs the engine again inside the
   queue, against the policy and the day's spend as they are then, and simulates there itself if
   the answer has changed since. */
export async function presimulate(ctx: PCtx, kind: RailKind, draft: RailDraft): Promise<SimulationResult | null> {
  const rail = ctx.rails.for(draft);
  if (rail === null) return null;
  const snapshot = ctx.ledger.snapshot();
  const verdict = evaluate(draft, buildCtx(ctx, snapshot, loadPolicy(ctx.dataDir)));
  if (verdict.outcome === 'refuse' && !liftableByQuote(ctx, verdict, draft, snapshot)) return null;
  return simulateSafely(rail, kind, draft);
}

// Shared tail for every rail: evaluate, simulate, persist, and execute only if the policy said
// allow. Nothing here knows which rail it is holding. `presimulated` is the simulation a caller
// took before the queue (presimulate), used instead of asking again.
// `ask` is a reason the caller already holds for a person to look first: an allow becomes a click.
export async function proposeRail(ctx: PCtx, kind: RailKind, draft: RailDraft, origin?: Origin, presimulated?: SimulationResult | null, ask?: string | null): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  const rail = ctx.rails.for(draft);
  const simulated = async (r: Rail): Promise<SimulationResult> => presimulated ?? simulateSafely(r, kind, draft);

  // The engine runs first because it is pure and its refusals are terminal. An unlisted
  // venue, the kill switch or a cap breach settles the proposal without spending the
  // round trips a rail simulation costs.
  let verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));
  let simulation: SimulationResult | null = null;

  /* A SWAP IS VALUED ON WHICHEVER SIDE THE APP CAN PRICE. The draft arrives priced off what it
     spends, and a coin the app has no price for arrives as Infinity, which the engine refuses
     as invalid_amount. When the coin it BUYS is priced, the dry quote says how much of it
     arrives, and that is a dollar figure the engine can govern: the quote is the venue's
     number, never the agent's, and the agent's own floor (minAmountOut) is deliberately not
     used, because a floor chosen by the caller could be set small to make the move look small.
     So on that one refusal the quote is fetched, the draft is repriced off it, the engine runs
     again, and the same quote rides on the row. Without this, USDC into an unpriced token was
     allowed and the same token back into ETH was refused as unbounded: money that could get in
     and not out (Karim, 2026-09-20, 2.0097 wNEAR).

     AND IT ALWAYS WAITS FOR A CLICK. The bought side is bounded by the quote and its floor; the
     spent side is bounded by nothing the app can see, and a thin route quoting 8 USDC for a
     holding worth far more would otherwise run on its own under the ask line. A move the app
     cannot measure stops for a human, whatever its size. */
  if (rail !== null && draft.kind === 'swap' && liftableByQuote(ctx, verdict, draft, snapshot)) {
    const unpriced = `This swap spends ${draft.fromSymbol}, which the app cannot price, so it is valued off what the quote says arrives.`;
    simulation = await simulated(rail);
    const repriced = simulation.ok ? pricedOffQuote(ctx, draft, simulation, snapshot) : draft;
    if (!simulation.ok || repriced === draft) {
      const why = simulation.ok ? 'the quote named no amount arriving, so there is nothing to value it by' : (simulation.error ?? simulation.summary);
      return land(ctx,
        newProposal(
          kind,
          draft,
          simulation,
          { outcome: 'refuse', reasons: [unpriced, `Simulation failed, so nothing is signed: ${why}`], rule: 'simulation_required', reasonCodes: [causeOf(simulation, 'no_price')] },
          origin,
        ),
      );
    }
    draft = repriced;
    verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));
    if (verdict.outcome === 'allow') {
      verdict = { outcome: 'needs_approval', reasons: [...verdict.reasons, `${unpriced} A move the app cannot measure waits for your click, whatever the size.`] };
    } else if (verdict.outcome === 'needs_approval') {
      verdict = { ...verdict, reasons: [...verdict.reasons, unpriced] };
    }
  }

  if (ask !== undefined && ask !== null && verdict.outcome === 'allow') verdict = { outcome: 'needs_approval', reasons: [...verdict.reasons, ask] };

  if (verdict.outcome === 'refuse') return land(ctx, newProposal(kind, draft, simulation, verdict, origin));

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
        origin,
      ),
    );
  }

  if (simulation === null) simulation = await simulated(rail);

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
          reasonCodes: [causeOf(simulation, 'simulation_failed')],
        },
        origin,
      ),
    );
  }

  return land(ctx, newProposal(kind, draft, simulation, verdict, origin));
}

/* Why a simulation did not pass, as the rail named it: the price moved, nobody quoted, the
   balance is short. A rail that named no cause, or a simulation that passed and still could not
   be used, is `fallback`. */
function causeOf(simulation: SimulationResult, fallback: ReasonCode): ReasonCode {
  return !simulation.ok && isReasonCode(simulation.reason) ? simulation.reason : fallback;
}

// A rail that throws inside simulate is a failed simulation, not a crashed proposal.
async function simulateSafely(rail: Rail, kind: RailKind, draft: RailDraft): Promise<SimulationResult> {
  try {
    return await rail.simulate(draft);
  } catch (err) {
    const message = errText(err);
    const reason = reasonOf(err);
    return { ok: false, summary: `${kind} simulation threw: ${message}`, error: message, ...(reason === undefined ? {} : { reason }) };
  }
}

// The swap draft again, valued in dollars off what the quote says arrives times the app's own
// price for that coin. A quote with no usable figure returns the draft itself, unchanged, and
// the caller refuses the move as a failed simulation rather than blaming a price table.
function pricedOffQuote(ctx: PCtx, draft: SwapDraft, simulation: SimulationResult, snapshot: LedgerSnapshot): SwapDraft {
  const receives = Number(simulation.swap?.receives);
  if (!Number.isFinite(receives) || receives <= 0) return draft;
  const usd = usdOf(ctx, draft.toSymbol, receives, snapshot);
  return Number.isFinite(usd) ? { ...draft, amountUsd: usd } : draft;
}

// ---------- public surface ----------
export async function proposePolicyChange(ctx: PCtx, params: { patch: PolicyPatch; sentence: string; clientKey?: ClientKey; by?: string }): Promise<Proposal> {
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

  return land(ctx, newProposal('policy_change', draft, simulation, verdict, params));
}
