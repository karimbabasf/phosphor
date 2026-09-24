// The trade rail: a plan through the same door every other write goes through.
//
// The proposal is a draft of kind `trade` priced at what the plan actually puts at stake:
// max(margin, max loss). The policy engine is not touched: the allowlist, the per-transaction
// cap, the session cap and the click threshold all read that one figure, exactly as they do
// for a deposit or a swap. Under the threshold the plan executes at once; above it the card
// shows side, size, leverage, margin at stake, max loss at the stop, the slippage bound in
// dollars, entry, stop, target, the conditions in English, the expiry and the totals across
// every waiting, placed and open plan, then Yes or No.
//
// The draft carries the whole plan plus its sha256, never a reference to a drawn plan by id:
// what the human clicked is what runs.

import type { Rail, RailResult, SimulationResult, TradeDraft } from '../types.ts';
import type { PlanRunner } from '../runner/host.ts';
import type { AssetMeta } from '../runner/protocol.ts';
import { planHash, renderPlan } from './plan.ts';
import type { Plan } from './plan.ts';
import { bookkeepingOf } from './plans.ts';
import type { PlanRow } from './plans.ts';
import { changeRisk, DEFAULT_TAKER_FEE_BPS, planRisk } from './risk.ts';
import type { PlanRisk, RiskInputs } from './risk.ts';

// The venue stands in for a counterparty address. Every other rail hands funds to a contract
// that must be on the policy allowlist, and evaluateRail refuses an unlisted one. A perp order
// moves nothing off the account: margin, position and profit all stay inside the Hyperliquid
// account the human already funded. The check still has to mean something, so the venue names
// itself here and main.ts seeds it, which keeps "an unseeded venue is dead, not cautious" true.
export const HYPERLIQUID_PERPS_COUNTERPARTY = 'hyperliquid-perps';

// What the rail and the propose functions need from the trading surface. Narrow on purpose:
// nothing here can draw an idea or read a fill. It arms, changes, cancels and closes, and it
// reads the facts a plan is priced against.
export type TradeDeps = {
  runner: Pick<PlanRunner, 'get' | 'plans' | 'draw' | 'arm' | 'change' | 'cancel' | 'close'>;
  meta: (coin: string) => AssetMeta | null;
  mark: (coin: string) => number | null;
  free: () => number | null;
  now?: () => number;
};

// The subset a plan is priced against. The trade service prices ideas with this and holds no
// way to arm anything.
export type PricingDeps = {
  runner: Pick<PlanRunner, 'plans'>;
  meta: (coin: string) => AssetMeta | null;
  mark: (coin: string) => number | null;
  free: () => number | null;
};

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function planOfRow(row: PlanRow): Plan {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    sizeUsd: row.sizeUsd,
    leverage: row.leverage,
    entry: row.entry,
    stop: row.stop,
    ...(row.target !== undefined ? { target: row.target } : {}),
    ...(row.when !== undefined ? { when: row.when } : {}),
    expiresAt: row.expiresAt,
    ...(row.note !== undefined ? { note: row.note } : {}),
  };
}

// The live facts a plan is priced against, read at propose and again at simulate. Any other
// waiting, placed or open plan on the same coin takes the coin (see sameCoinRefusal).
export function riskInputsFor(deps: PricingDeps, plan: Plan, exceptId: string | null, entryPx?: number): RiskInputs {
  const meta = deps.meta(plan.symbol);
  const same = deps.runner
    .plans()
    .find((r) => r.id !== exceptId && r.symbol === plan.symbol && (r.status === 'waiting' || r.status === 'placed' || r.status === 'open'));
  return {
    mark: deps.mark(plan.symbol) ?? Number.NaN,
    szDecimals: meta?.szDecimals ?? 0,
    maxLeverage: meta?.maxLeverage ?? null,
    freeCollateralUsd: deps.free(),
    takerFeeBps: DEFAULT_TAKER_FEE_BPS,
    sameCoinPlan: same === undefined ? null : same.id,
    ...(entryPx !== undefined ? { entryPx } : {}),
  };
}

// The totals the card shows under the plan: what every waiting, placed and open plan already
// has at stake, so a person deciding about one sees the sum they are deciding into.
export function totalsLine(deps: PricingDeps, exceptId: string | null): string {
  const others = deps.runner.plans().filter((r) => r.id !== exceptId && (r.status === 'waiting' || r.status === 'placed' || r.status === 'open'));
  const margin = others.reduce((sum, r) => sum + (r.risk?.marginUsd ?? 0), 0);
  const loss = others.reduce((sum, r) => sum + (r.risk?.maxLossUsd ?? 0), 0);
  if (others.length === 0) return 'No other plan is waiting, placed or open.';
  return `${others.length} other plan${others.length === 1 ? '' : 's'} already at stake: ${money(margin)} of collateral, ${money(loss)} of max loss at their stops.`;
}

function changeLines(row: PlanRow, draft: Extract<TradeDraft, { op: 'change' }>): string[] {
  const lines: string[] = [];
  if (draft.cancel === true) {
    lines.push(`Cancel ${row.id}: the ${row.side} on ${row.symbol} ${row.status === 'placed' ? 'comes off the book' : 'stops waiting'}. Nothing is at risk after this.`);
    if (row.status === 'placed') lines.push('Anything that filled before the cancel lands is protected with a stop and a target before the runner answers.');
    return lines;
  }
  if (draft.close === true) {
    lines.push(`Close ${row.id}: the plan's own ${row.side} on ${row.symbol} is closed at market, reduce only, within ${row.entry.type === 'market' || row.entry.type === 'stop' ? row.entry.maxSlippageBps : 30} bps of the mark. Any other size on ${row.symbol} stays open.`);
    lines.push(`Collateral at stake now: ${money(draft.before.marginUsd)}. Slippage bound: ${money((row.sizeUsd * (row.entry.type === 'market' || row.entry.type === 'stop' ? row.entry.maxSlippageBps : 30)) / 10_000)}.`);
    lines.push('The stop and the target are cancelled once the position is flat.');
    return lines;
  }
  if (draft.stop !== undefined) {
    lines.push(`Stop ${String(row.stop)} becomes ${String(draft.stop)}.`);
    lines.push(`Max loss ${money(draft.before.maxLossUsd)} becomes ${money(draft.after.maxLossUsd)}${draft.amountUsd === 0 ? ' (tighter, so no wall applies)' : ' (wider, so the wall applies to the new figure)'}.`);
  }
  if (draft.target !== undefined) {
    lines.push(`Target ${row.target === undefined ? 'none' : String(row.target)} becomes ${String(draft.target)}.`);
  }
  lines.push(`Liquidation stays near ${draft.after.liquidationPx.toFixed(2)}.`);
  return lines;
}

export function tradeRail(deps: TradeDeps): Rail<TradeDraft> {
  return {
    kind: 'trade',

    valueUsd: (draft) => draft.amountUsd,

    async simulate(draft): Promise<SimulationResult> {
      if (draft.op === 'open') {
        // Priced again here rather than trusting what reached the draft: the mark has moved
        // since propose, and a plan cannot arrive at the card through any path that skipped
        // the check.
        const risk = planRisk(draft.plan, riskInputsFor(deps, draft.plan, draft.plan.id));
        if (!risk.ok) return { ok: false, summary: 'plan refused', error: risk.refusal };
        if (planHash(draft.plan) !== draft.hash) return { ok: false, summary: 'plan refused', error: 'the plan does not match its hash' };
        return { ok: true, summary: [...renderPlan(draft.plan, risk.risk), totalsLine(deps, draft.plan.id)].join('\n') };
      }
      const row = deps.runner.get(draft.id);
      if (row === null || (row.status !== 'waiting' && row.status !== 'placed' && row.status !== 'open')) {
        return { ok: false, summary: 'change refused', error: `no live plan ${draft.id}` };
      }
      if (draft.cancel === true && row.status === 'open') {
        return { ok: false, summary: 'change refused', error: `${draft.id} is open: its exits are its protection. Close it, or change the stop` };
      }
      if (draft.close === true && row.status !== 'open') {
        return { ok: false, summary: 'change refused', error: `${draft.id} is ${row.status}, so there is nothing to close; cancel it instead` };
      }
      if (draft.stop !== undefined || draft.target !== undefined) {
        const plan = planOfRow(row);
        const approved = row.risk ?? draft.before;
        const out = changeRisk(plan, approved, { stop: draft.stop, target: draft.target }, riskInputsFor(deps, plan, row.id, row.fillPx));
        if (!out.ok) return { ok: false, summary: 'change refused', error: out.refusal };
      }
      return { ok: true, summary: [...changeLines(row, draft), totalsLine(deps, row.id)].join('\n') };
    },

    async execute(draft, proposalId): Promise<RailResult> {
      if (draft.op === 'open') {
        const known = deps.runner.get(draft.plan.id);
        const at = new Date((deps.now ?? Date.now)()).toISOString();
        // The drawn row's bookkeeping and the card's plan, whole: a target or a condition the
        // idea grew while the card waited is not what the human clicked.
        const row: PlanRow = {
          ...(known === null ? { cloids: {}, gen: 0, createdAt: at } : bookkeepingOf(known)),
          ...draft.plan,
          status: 'waiting',
          hash: draft.hash,
          risk: draft.risk,
          ...(proposalId !== undefined ? { proposalId } : {}),
          updatedAt: at,
        };
        const out = await deps.runner.arm(row);
        return out.ok ? { ok: true, detail: `${draft.plan.id} armed on ${draft.plan.symbol}` } : { ok: false, detail: out.reason };
      }
      if (draft.cancel === true) return deps.runner.cancel(draft.id);
      if (draft.close === true) {
        const row = deps.runner.get(draft.id);
        const bps = row !== null && (row.entry.type === 'market' || row.entry.type === 'stop') ? row.entry.maxSlippageBps : 30;
        return deps.runner.close(draft.id, bps);
      }
      const out = await deps.runner.change(draft.id, { stop: draft.stop, target: draft.target });
      if (out.ok) {
        // The approved figure moves with the change once it has landed.
        const row = deps.runner.get(draft.id);
        if (row !== null) row.risk = draft.after;
      }
      return out;
    },
  };
}

export type { PlanRisk };
