// The two drafts that touch a position: opening a plan, and changing one that is armed.
//
// Same shape as the moves in rails.ts and the same tail: everything is resolved from what the
// app already knows, then handed to proposeRail. What is different is the amount. A plan is
// priced at what it puts at stake, max(margin, max loss), and a change that only takes risk off
// (a cancel, a tighter stop) costs nothing at the wall: it lands allowed without the engine,
// which would otherwise refuse a zero amount as uncheckable. The kill switch and an unreadable
// policy still refuse it, because those are not about the amount.

import type { Proposal, TradeChangeParams, TradeDraft, TradeParams, Verdict } from '../types.ts';
import { loadPolicy } from '../policy/file.ts';
import { HYPERLIQUID_PERPS_COUNTERPARTY, planOfRow, riskInputsFor } from '../trade/rail.ts';
import type { TradeDeps } from '../trade/rail.ts';
import { planHash, validatePlanInput } from '../trade/plan.ts';
import type { Entry, Plan, PlanInput } from '../trade/plan.ts';
import type { PlanRow } from '../trade/plans.ts';
import { changeRisk, planRisk } from '../trade/risk.ts';
import { proposeRail, refuseDraft } from './draft.ts';
import type { Origin } from './draft.ts';
import type { ReasonCode } from '../rails/reasons.ts';
import { land } from './execute.ts';
import { newProposal } from './lifecycle.ts';
import type { PCtx } from './lifecycle.ts';

function noSurface(ctx: PCtx, draft: TradeDraft, origin?: Origin): Promise<Proposal> {
  return refuseDraft(ctx, 'trade', draft, [`no trading surface is wired in ${ctx.cfg.mode} mode`], origin);
}

// Two entries are the same order for this purpose when they are the same kind and, for a
// resting or stop entry, the same price. Two market entries always match.
function sameEntry(a: Entry, b: Entry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'market' || b.type === 'market') return a.type === b.type;
  return a.px === b.px;
}

// A plan already live (waiting, placed or open) that this one would double: same coin, side,
// entry, notional size and the same margin multiple. The multiple is in the match because it is
// what turns one notional into a different amount of collateral, so the same size at a different
// multiple is a different position a person may want beside the first. `exceptId` skips the
// plan's own row on the arm-by-id path.
function armedTwin(deps: TradeDeps, plan: PlanInput | Plan, exceptId: string | null): PlanRow | null {
  return (
    deps.runner
      .plans()
      .find(
        (r) =>
          r.id !== exceptId &&
          (r.status === 'waiting' || r.status === 'placed' || r.status === 'open') &&
          r.symbol === plan.symbol &&
          r.side === plan.side &&
          r.sizeUsd === plan.sizeUsd &&
          r.leverage === plan.leverage &&
          sameEntry(r.entry, plan.entry),
      ) ?? null
  );
}

function twinReason(plan: PlanInput | Plan, twin: PlanRow): string {
  const proposal = twin.proposalId === undefined ? '' : ` (proposal ${twin.proposalId})`;
  return `A ${plan.side} on ${plan.symbol} this size is already live as ${twin.id}${proposal}. Change or cancel it instead of arming a second one on the same coin.`;
}

/* The other live plan on this plan's coin. A second plan on a coin would share the venue's one
   position there, so it is refused before anything is drawn. */
function liveOnCoin(deps: TradeDeps, plan: PlanInput | Plan): string | null {
  return riskInputsFor(deps, { id: 'pl_new', ...plan } as Plan, null).sameCoinPlan;
}

export async function proposeTrade(ctx: PCtx, params: TradeParams): Promise<Proposal> {
  const deps: TradeDeps | undefined = ctx.trade;
  const now = deps?.now ?? Date.now;
  const problems: string[] = [];
  // The cause the card reads, when the refusal has one of its own.
  let code: ReasonCode | undefined;
  let plan: Plan | null = null;
  // The coin a refusal is about when no plan was drawn, so the card can name it.
  let coin = '';

  if (params.planId !== undefined) {
    // "go": the drawn plan arms exactly as it is on screen, id and all, so the chart object and
    // the armed row stay one object.
    const row = deps?.runner.get(params.planId) ?? null;
    if (row === null) problems.push(`no plan ${params.planId}`);
    else if (row.status !== 'idea') problems.push(`${params.planId} is already ${row.status}`);
    else {
      // The idea was validated when it was drawn, against the clock of that moment. Arming it
      // is a new moment: an expiry that has since passed is refused here, by the same rule, and
      // the idea stays drawn so the agent can redraw it with a new one.
      const drawn = planOfRow(row);
      const at = Date.parse(drawn.expiresAt ?? '');
      if (Number.isFinite(at) && at <= now()) problems.push(`${params.planId} expired at ${drawn.expiresAt ?? ''}; redraw it with a new expiry`);
      else {
        const twin = deps === undefined ? null : armedTwin(deps, drawn, row.id);
        if (twin !== null) problems.push(twinReason(drawn, twin));
        else plan = drawn;
      }
    }
  } else {
    const parsed = validatePlanInput(params.plan, now());
    if (!parsed.ok) problems.push(...parsed.errors);
    else if (deps !== undefined) {
      // A RETRY MUST NOT ARM A SECOND BRACKET. A lost reply, or an error the agent reads as
      // transient, brings the same plan back; without this each call draws a fresh id and arms
      // its own position, two brackets and double margin on one coin (A.F3). Checked before the
      // draw so a refused retry does not even leave a stray idea behind.
      const twin = armedTwin(deps, parsed.plan, null);
      const other = twin === null ? liveOnCoin(deps, parsed.plan) : null;
      if (twin !== null) problems.push(twinReason(parsed.plan, twin));
      else if (other !== null) {
        // Refused before the draw, so a second plan on the coin leaves no stray idea on the chart.
        problems.push(
          `${parsed.plan.symbol} already has a live plan (${other}), and the venue keeps one position per coin, so a second ` +
            `plan would share it. Change or cancel ${other} first`,
        );
        code = 'plan_exists';
        coin = parsed.plan.symbol;
      }
      // Drawn first, so the card and the chart show the same object while the human decides.
      else plan = planOfRow(deps.runner.draw(parsed.plan, params.by ?? null));
    }
  }

  const empty: TradeDraft = {
    kind: 'trade',
    op: 'open',
    plan: plan ?? { id: 'pl_none', symbol: coin, side: 'long', sizeUsd: 0, leverage: 1, entry: { type: 'market', maxSlippageBps: 30 }, stop: 0 },
    hash: '',
    risk: { marginUsd: 0, maxLossUsd: 0, stopSlipUsd: 0, entryRef: 0, liquidationPx: 0, notionalUsd: 0, amountUsd: Number.POSITIVE_INFINITY },
    amountUsd: Number.POSITIVE_INFINITY,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };
  if (deps === undefined) return noSurface(ctx, empty);
  if (plan === null || problems.length > 0) return refuseDraft(ctx, 'trade', empty, problems, params, code);

  const risk = planRisk(plan, riskInputsFor(deps, plan, plan.id));
  if (!risk.ok) return refuseDraft(ctx, 'trade', { ...empty, plan, hash: planHash(plan) }, [risk.refusal], params);

  const draft: TradeDraft = {
    kind: 'trade',
    op: 'open',
    plan,
    hash: planHash(plan),
    risk: risk.risk,
    amountUsd: risk.risk.amountUsd,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };
  return proposeRail(ctx, 'trade', draft, params);
}

export async function proposeTradeChange(ctx: PCtx, params: TradeChangeParams): Promise<Proposal> {
  const deps: TradeDeps | undefined = ctx.trade;
  const zero = { marginUsd: 0, maxLossUsd: 0, stopSlipUsd: 0, entryRef: 0, liquidationPx: 0, notionalUsd: 0, amountUsd: 0 };
  const base: TradeDraft = {
    kind: 'trade',
    op: 'change',
    id: params.id,
    before: zero,
    after: zero,
    amountUsd: Number.POSITIVE_INFINITY,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };
  if (deps === undefined) return noSurface(ctx, base, params);

  const problems: string[] = [];
  const verbs = [params.cancel === true, params.close === true, params.stop !== undefined || params.target !== undefined].filter(Boolean).length;
  if (verbs !== 1) problems.push('one change at a time: cancel, close, or a new stop and/or target');
  const row = deps.runner.get(params.id);
  if (row === null) problems.push(`no plan ${params.id}`);
  else if (row.status !== 'waiting' && row.status !== 'placed' && row.status !== 'open') problems.push(`${params.id} is ${row.status}`);
  if (row === null || problems.length > 0) return refuseDraft(ctx, 'trade', base, problems, params);

  const approved = row.risk ?? zero;

  if (params.cancel === true) {
    if (row.status === 'open') {
      return refuseDraft(
        ctx,
        'trade',
        { ...base, before: approved, after: approved },
        [`${row.id} is open: its exits are its protection. Close it, or change the stop`],
        params,
      );
    }
    return landFree(ctx, { ...base, cancel: true, before: approved, after: approved, amountUsd: 0 }, params);
  }

  /* A close only takes risk off: a reduce-only order at the plan's own bound, sized to what the
     plan's own entry filled and never to size on the coin the plan did not open (src/runner/
     main.ts closePlan), no new margin, and nothing leaves the venue. So it lands free like a
     cancel, charges nothing to the day, and still stops at the kill switch and an unreadable
     policy (landFree). */
  if (params.close === true) {
    if (row.status !== 'open') {
      return refuseDraft(ctx, 'trade', { ...base, before: approved, after: approved }, [`${row.id} is ${row.status}, so there is nothing to close; cancel it instead`], params);
    }
    return landFree(ctx, { ...base, close: true, before: approved, after: approved, amountUsd: 0 }, params);
  }

  const plan = planOfRow(row);
  const out = changeRisk(plan, approved, { stop: params.stop, target: params.target }, riskInputsFor(deps, plan, row.id, row.fillPx));
  if (!out.ok) return refuseDraft(ctx, 'trade', { ...base, before: approved, after: approved }, [out.refusal], params);
  const draft: TradeDraft = {
    ...base,
    ...(params.stop !== undefined ? { stop: params.stop } : {}),
    ...(params.target !== undefined ? { target: params.target } : {}),
    before: approved,
    after: out.risk,
    amountUsd: out.widens ? out.risk.amountUsd : 0,
  };
  return out.widens ? proposeRail(ctx, 'trade', draft, params) : landFree(ctx, draft, params);
}

// A change that only takes risk off. The engine would refuse a zero amount as one it cannot
// check against a limit, and there is nothing to check: no wall applies. The two rules that are
// not about the amount still do.
async function landFree(ctx: PCtx, draft: TradeDraft, origin?: Origin): Promise<Proposal> {
  const policy = loadPolicy(ctx.dataDir);
  let verdict: Verdict;
  if (policy === null) {
    verdict = { outcome: 'refuse', reasons: ['The policy file is unreadable, so every write is refused.'], rule: 'policy_unreadable' };
  } else if (policy.killSwitch) {
    verdict = { outcome: 'refuse', reasons: ['The kill switch is on: every write is refused.'], rule: 'kill_switch' };
  } else {
    verdict = { outcome: 'allow', reasons: ['This change only takes risk off, so no wall applies.'] };
  }
  if (verdict.outcome === 'refuse') return land(ctx, newProposal('trade', draft, null, verdict, origin));
  const rail = ctx.rails.for(draft);
  if (rail === null) return refuseDraft(ctx, 'trade', draft, [`no trade rail is wired in ${ctx.cfg.mode} mode`], origin);
  const simulation = await rail.simulate(draft);
  if (!simulation.ok) {
    return land(ctx, newProposal('trade', draft, simulation, { outcome: 'refuse', reasons: [simulation.error ?? simulation.summary], rule: 'simulation_required' }, origin));
  }
  return land(ctx, newProposal('trade', draft, simulation, verdict, origin));
}
