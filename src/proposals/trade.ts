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
import type { Plan } from '../trade/plan.ts';
import { changeRisk, planRisk } from '../trade/risk.ts';
import { proposeRail, refuseDraft } from './draft.ts';
import { land } from './execute.ts';
import { newProposal } from './lifecycle.ts';
import type { PCtx } from './lifecycle.ts';

function noSurface(ctx: PCtx, draft: TradeDraft, clientKey?: string): Promise<Proposal> {
  return refuseDraft(ctx, 'trade', draft, [`no trading surface is wired in ${ctx.cfg.mode} mode`], clientKey);
}

export async function proposeTrade(ctx: PCtx, params: TradeParams): Promise<Proposal> {
  const deps: TradeDeps | undefined = ctx.trade;
  const now = deps?.now ?? Date.now;
  const problems: string[] = [];
  let plan: Plan | null = null;

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
      else plan = drawn;
    }
  } else {
    const parsed = validatePlanInput(params.plan, now());
    if (!parsed.ok) problems.push(...parsed.errors);
    else if (deps !== undefined) {
      // Drawn first, so the card and the chart show the same object while the human decides.
      plan = planOfRow(deps.runner.draw(parsed.plan, params.by ?? null));
    }
  }

  const empty: TradeDraft = {
    kind: 'trade',
    op: 'open',
    plan: plan ?? { id: 'pl_none', symbol: '', side: 'long', sizeUsd: 0, leverage: 1, entry: { type: 'market', maxSlippageBps: 30 }, stop: 0 },
    hash: '',
    risk: { marginUsd: 0, maxLossUsd: 0, stopSlipUsd: 0, entryRef: 0, liquidationPx: 0, notionalUsd: 0, amountUsd: Number.POSITIVE_INFINITY },
    amountUsd: Number.POSITIVE_INFINITY,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };
  if (deps === undefined) return noSurface(ctx, empty);
  if (plan === null || problems.length > 0) return refuseDraft(ctx, 'trade', empty, problems, params.clientKey);

  const risk = planRisk(plan, riskInputsFor(deps, plan, plan.id));
  if (!risk.ok) return refuseDraft(ctx, 'trade', { ...empty, plan, hash: planHash(plan) }, [risk.refusal], params.clientKey);

  const draft: TradeDraft = {
    kind: 'trade',
    op: 'open',
    plan,
    hash: planHash(plan),
    risk: risk.risk,
    amountUsd: risk.risk.amountUsd,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };
  return proposeRail(ctx, 'trade', draft, params.clientKey);
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
  if (deps === undefined) return noSurface(ctx, base, params.clientKey);

  const problems: string[] = [];
  const verbs = [params.cancel === true, params.close === true, params.stop !== undefined || params.target !== undefined].filter(Boolean).length;
  if (verbs !== 1) problems.push('one change at a time: cancel, close, or a new stop and/or target');
  const row = deps.runner.get(params.id);
  if (row === null) problems.push(`no plan ${params.id}`);
  else if (row.status !== 'waiting' && row.status !== 'placed' && row.status !== 'open') problems.push(`${params.id} is ${row.status}`);
  if (row === null || problems.length > 0) return refuseDraft(ctx, 'trade', base, problems, params.clientKey);

  const approved = row.risk ?? zero;

  if (params.cancel === true) {
    if (row.status === 'open') {
      return refuseDraft(
        ctx,
        'trade',
        { ...base, before: approved, after: approved },
        [`${row.id} is open: its exits are its protection. Close it, or change the stop`],
        params.clientKey,
      );
    }
    return landFree(ctx, { ...base, cancel: true, before: approved, after: approved, amountUsd: 0 }, params.clientKey);
  }

  if (params.close === true) {
    if (row.status !== 'open') {
      return refuseDraft(ctx, 'trade', { ...base, before: approved, after: approved }, [`${row.id} is ${row.status}, so there is nothing to close; cancel it instead`], params.clientKey);
    }
    return proposeRail(ctx, 'trade', { ...base, close: true, before: approved, after: approved, amountUsd: approved.marginUsd }, params.clientKey);
  }

  const plan = planOfRow(row);
  const out = changeRisk(plan, approved, { stop: params.stop, target: params.target }, riskInputsFor(deps, plan, row.id, row.fillPx));
  if (!out.ok) return refuseDraft(ctx, 'trade', { ...base, before: approved, after: approved }, [out.refusal], params.clientKey);
  const draft: TradeDraft = {
    ...base,
    ...(params.stop !== undefined ? { stop: params.stop } : {}),
    ...(params.target !== undefined ? { target: params.target } : {}),
    before: approved,
    after: out.risk,
    amountUsd: out.widens ? out.risk.amountUsd : 0,
  };
  return out.widens ? proposeRail(ctx, 'trade', draft, params.clientKey) : landFree(ctx, draft, params.clientKey);
}

// A change that only takes risk off. The engine would refuse a zero amount as one it cannot
// check against a limit, and there is nothing to check: no wall applies. The two rules that are
// not about the amount still do.
async function landFree(ctx: PCtx, draft: TradeDraft, clientKey?: string): Promise<Proposal> {
  const policy = loadPolicy(ctx.dataDir);
  let verdict: Verdict;
  if (policy === null) {
    verdict = { outcome: 'refuse', reasons: ['The policy file is unreadable, so every write is refused.'], rule: 'policy_unreadable' };
  } else if (policy.killSwitch) {
    verdict = { outcome: 'refuse', reasons: ['The kill switch is on: every write is refused.'], rule: 'kill_switch' };
  } else {
    verdict = { outcome: 'allow', reasons: ['This change only takes risk off, so no wall applies.'] };
  }
  if (verdict.outcome === 'refuse') return land(ctx, newProposal('trade', draft, null, verdict, clientKey));
  const rail = ctx.rails.for(draft);
  if (rail === null) return refuseDraft(ctx, 'trade', draft, [`no trade rail is wired in ${ctx.cfg.mode} mode`], clientKey);
  const simulation = await rail.simulate(draft);
  if (!simulation.ok) {
    return land(ctx, newProposal('trade', draft, simulation, { outcome: 'refuse', reasons: [simulation.error ?? simulation.summary], rule: 'simulation_required' }, clientKey));
  }
  return land(ctx, newProposal('trade', draft, simulation, verdict, clientKey));
}
