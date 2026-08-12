// The policy engine. Pure, no IO: it takes a draft plus a snapshot of the world and returns
// one of exactly three outcomes. There is no override path and no fourth outcome, so every
// caller either gets `allow` (small enough to auto-execute), `needs_approval` (a human clicks)
// or `refuse` (nothing happens).
//
// Two habits run through this file, both because a wrong answer here loses money:
//   1. Fail closed. Missing policy, missing quote, unreadable numbers and unknown issuers all
//      resolve to the pessimistic reading.
//   2. Never trust the draft's own arithmetic. The agent authors the draft, so declared totals
//      and declared usd values are treated as claims and re-derived from the legs.
//
// Rule order is normative (see the plan's Task D section). First refusal wins; reasons
// accumulate so the UI can show the whole chain of reasoning, not just the last line.

import { z } from 'zod';
import { classify } from '../composition.ts';
import type {
  ChainId,
  CompositionView,
  LedgerSnapshot,
  Policy,
  RiskRow,
  TransferLeg,
  Verdict,
  WriteDraft,
} from '../types.ts';

export type EngineCtx = {
  policy: Policy | null;
  composition: CompositionView;
  ledger: LedgerSnapshot;
  sessionSpentUsd: number;
  selfAddresses: string[];
};

const CHAIN_IDS = ['eth', 'base', 'arb', 'sol', 'near'] as const;

// Structural shape of a PolicyPatch on the wire. Strict everywhere: an unknown key is an
// invalid patch rather than a silently ignored one, since a patch that half applies is worse
// than a patch that is refused.
const usdField = z.number().finite().nonnegative();
const shareField = z.number().finite().min(0).max(1);
const patchSchema = z
  .object({
    outbound: z
      .object({
        maxPerTransactionUsd: usdField.optional(),
        maxPerSessionUsd: usdField.optional(),
        humanClickAboveUsd: usdField.optional(),
        destinationAllowlist: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    composition: z
      .object({
        maxIssuerShare: z.record(z.string(), shareField).optional(),
        maxFreezableShare: shareField.optional(),
        minNativeGasUsd: z.record(z.enum(CHAIN_IDS), usdField).optional(),
        forbiddenIssuers: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Fields a patch may never reach. killSwitch is human-only hardware; version and sentences are
// what the human reads to know what the policy is.
const UNPATCHABLE = ['killSwitch', 'version', 'sentences'];

function lower(s: string): string {
  return s.toLowerCase();
}

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(share: number): string {
  return (share * 100).toFixed(2) + '%';
}

function refusal(reasons: string[], rule: string, line: string): Verdict {
  return { outcome: 'refuse', reasons: [...reasons, line], rule };
}

// Every stable in this app is priced at 1.0 (see ledger and composition), so a leg claiming a
// usd value below its token amount is understating itself. Take the larger of the two.
function legUsd(leg: TransferLeg): number {
  const declared = Number.isFinite(leg.amountUsd) ? leg.amountUsd : 0;
  const amount = Number.isFinite(leg.amount) ? leg.amount : 0;
  return Math.max(declared, amount);
}

// Amounts on the wire are claims by the agent, and a non-finite or negative one slips past
// every cap below: comparisons against NaN are always false, and a negative amount understates
// the move it is asking for. Such a leg is refused before any cap is consulted.
function legNumbersAreSane(leg: TransferLeg): boolean {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const nonNegative = (n: number) => Number.isFinite(n) && n >= 0;
  if (!positive(leg.amount)) return false;
  if (!nonNegative(leg.amountUsd) || !nonNegative(leg.gasNativeUsd)) return false;
  if (leg.quote && !nonNegative(leg.quote.amountOut)) return false;
  return true;
}

function legsOf(draft: WriteDraft): TransferLeg[] {
  if (draft.kind === 'consolidate') return draft.legs;
  if (draft.kind === 'transfer') return [draft.leg];
  return [];
}

// The rail kinds (swap, hyperliquid deposit, LP add/remove) do not decompose into
// TransferLegs: they hand funds to a contract and get something else back, so there is
// no from-chain/to-chain pair to walk. They still have to be governed, and the honest
// way is their own branch rather than a fake leg. Anything with no legs and no branch
// falls through to 'nothing_to_move', which is fail-closed by design.
type RailDraft = Extract<WriteDraft, { counterparty: string } | { kind: 'hl_deposit' }>;

function isRailDraft(draft: WriteDraft): draft is RailDraft {
  return draft.kind === 'swap' || draft.kind === 'hl_deposit' || draft.kind === 'lp_add' || draft.kind === 'lp_remove';
}

// Where the funds actually go. This is the address the allowlist has to bless, and it is
// a contract we chose rather than an arbitrary recipient, which is why rails get an
// allowlist check on the venue instead of the leg-destination check.
function counterpartyOf(draft: RailDraft): string {
  return draft.kind === 'hl_deposit' ? draft.bridge : draft.counterparty;
}

// Where the OUTPUT lands, which is a different question from who we hand the funds to.
// A swap passes tokens through an allowlisted router and the router delivers them to
// draft.to; allowlisting only the router says nothing about who receives the proceeds.
// The other rail kinds have no such field: lp_add and lp_remove deliver to the signer,
// and hl_deposit credits whoever sent. Returns null when the kind has no destination.
function destinationOf(draft: RailDraft): string | null {
  return draft.kind === 'swap' ? draft.to : null;
}

function symbolOf(draft: WriteDraft): string {
  if (draft.kind === 'consolidate') return draft.symbol;
  if (draft.kind === 'transfer') return draft.leg.symbol;
  return '';
}

// Issuer for a symbol, read off the composition the human is looking at. A symbol we hold
// nothing of, or hold unclassified, is 'unclassified' (same pessimism as composition.ts).
function issuerOf(symbol: string, comp: CompositionView): string {
  const row = comp.rows.find(r => r.symbol === symbol);
  return row ? row.issuer : 'unclassified';
}

// A cap keyed 'circle' must still bind an issuer named 'Circle'; a silently unapplied cap is a
// money bug. Exact key first, then a case-insensitive scan, then the catch-all.
function issuerCap(issuer: string, caps: Record<string, number>): number {
  if (caps[issuer] !== undefined) return caps[issuer];
  const hit = Object.keys(caps).find(k => k !== 'default' && lower(k) === lower(issuer));
  if (hit !== undefined) return caps[hit];
  return caps.default ?? 1;
}

// classify() needs issuer and freeze power per symbol, which the current composition already
// carries. Rebuilding the rows from it keeps one share formula in the codebase instead of two.
// Genuinely unclassified symbols are left out so classify() applies its own pessimistic path.
function riskRowsFromComposition(comp: CompositionView): RiskRow[] {
  const bySymbol = new Map<string, RiskRow>();
  for (const row of comp.rows) {
    if (!row.classified || bySymbol.has(row.symbol)) continue;
    bySymbol.set(row.symbol, {
      symbol: row.symbol,
      issuer: row.issuer,
      freezable: row.freezable,
      // Descriptive fields, never read by classify().
      freezeMechanism: '',
      reserveType: 'unknown',
      depegWorstUsd: 0,
      depegNote: '',
      sourceUrl: '',
    });
  }
  return [...bySymbol.values()];
}

// Post-state of the portfolio if every leg lands. Clones, never mutates.
// Funds are credited on the destination chain only when the recipient is an address we own:
// money sent anywhere else has left the portfolio and must stop counting toward our shares.
export function applyLegs(snapshot: LedgerSnapshot, legs: TransferLeg[], selfAddresses?: string[]): LedgerSnapshot {
  const holdings = snapshot.holdings.map(h => ({ ...h }));
  const owned = new Set<string>([
    ...snapshot.holdings.map(h => lower(h.address)),
    ...(selfAddresses ?? []).map(lower),
  ]);

  for (const leg of legs) {
    const onFrom = holdings.filter(h => h.chain === leg.fromChain && !h.native && h.symbol === leg.symbol);
    const from = onFrom.find(h => lower(h.address) === lower(leg.from)) ?? onFrom[0];
    if (from) from.amount = Math.max(0, from.amount - leg.amount);

    const natives = holdings.filter(h => h.chain === leg.fromChain && h.native);
    const gasHolding = natives.find(h => lower(h.address) === lower(leg.from)) ?? natives[0];
    if (gasHolding) {
      const price = snapshot.prices[gasHolding.symbol] ?? 0;
      const units = price > 0 ? leg.gasNativeUsd / price : 0;
      gasHolding.amount = Math.max(0, gasHolding.amount - units);
    }

    if (!owned.has(lower(leg.to))) continue;
    const amountOut = leg.quote?.amountOut ?? leg.amount;
    const onTo = holdings.filter(h => h.chain === leg.toChain && !h.native && h.symbol === leg.symbol);
    let to = onTo.find(h => lower(h.address) === lower(leg.to)) ?? onTo[0];
    if (!to) {
      to = {
        chain: leg.toChain,
        address: leg.to,
        symbol: leg.symbol,
        tokenId: from?.tokenId ?? leg.symbol,
        amount: 0,
        usd: 0,
        native: false,
      };
      holdings.push(to);
    }
    to.amount += amountOut;
  }

  // Same pricing rule as the ledger: stables at 1.0, natives at spot.
  for (const h of holdings) h.usd = h.native ? h.amount * (snapshot.prices[h.symbol] ?? 0) : h.amount;

  return {
    ...snapshot,
    holdings,
    chainStatus: { ...snapshot.chainStatus },
    prices: { ...snapshot.prices },
    gas: { ...snapshot.gas },
  };
}

function nativeUsdByChain(snapshot: LedgerSnapshot): Map<ChainId, number> {
  const out = new Map<ChainId, number>();
  for (const h of snapshot.holdings) {
    if (h.native) out.set(h.chain, (out.get(h.chain) ?? 0) + h.usd);
  }
  return out;
}

// Rule 3. A policy change is the one draft that can never be auto-executed.
function evaluatePolicyChange(draft: Extract<WriteDraft, { kind: 'policy_change' }>, reasons: string[]): Verdict {
  const patch = draft.patch as unknown as Record<string, unknown>;
  const raw = patch !== null && typeof patch === 'object' ? patch : {};

  // Checked before the schema so an attempt on the kill switch is named as such rather than
  // reported as a generic unknown key.
  const forbidden = UNPATCHABLE.filter(k => Object.prototype.hasOwnProperty.call(raw, k));
  if (forbidden.length > 0) {
    return refusal(
      reasons,
      'kill_switch_not_patchable',
      `A patch may not touch ${forbidden.join(', ')}: the kill switch, the version and the policy sentences are human-only.`,
    );
  }

  const parsed = patchSchema.safeParse(draft.patch);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return refusal(reasons, 'invalid_patch', `Patch is not a valid policy change: ${detail}`);
  }

  reasons.push('Policy changes always require a human click.');
  return { outcome: 'needs_approval', reasons };
}

// A rail hands funds to a venue contract. What can be checked is the size of the move and
// who is receiving it; what cannot be checked is a post-move composition, because the
// engine does not know what a pool or an exchange will hand back. So this branch enforces
// the money rules strictly and is honest about the rest rather than inventing a post-state.
function evaluateRail(draft: RailDraft, policy: Policy, ctx: EngineCtx, reasons: string[]): Verdict {
  const usd = draft.amountUsd;
  const counterparty = counterpartyOf(draft);
  reasons.push(`${draft.kind} of ${money(usd)} to ${counterparty}.`);

  if (!Number.isFinite(usd) || usd <= 0) {
    return refusal(reasons, 'invalid_amount', `${draft.kind} declares ${usd} USD, which cannot be checked against a limit.`);
  }

  // The venue must be explicitly blessed. Unlike a transfer, the recipient here is a
  // contract the app chose, so an unknown one means either a misconfiguration or a
  // rail pointed somewhere it should not be. Both are refusals.
  const allowed = new Set<string>([
    ...ctx.selfAddresses.map(lower),
    ...policy.outbound.destinationAllowlist.map(lower),
  ]);
  if (!allowed.has(lower(counterparty))) {
    return refusal(
      reasons,
      'destination_not_allowed',
      `${draft.kind} sends funds to ${counterparty}, which is not on the allowlist. Add the venue to the policy before using this rail.`,
    );
  }

  // The proceeds, checked separately and against the same list. Allowlisting the router a
  // swap passes through says nothing about who receives what comes out of it: a draft naming
  // the real router as counterparty and an attacker's address as `to` would otherwise pass
  // every rule here and auto-execute under the click threshold. The tool surface does not
  // currently expose `to`, which is what stops that today, but a governance rule that holds
  // only because of the shape of the caller is not a governance rule.
  const destination = destinationOf(draft);
  if (destination !== null && !allowed.has(lower(destination))) {
    return refusal(
      reasons,
      'destination_not_allowed',
      `${draft.kind} would deliver the proceeds to ${destination}, which is neither one of our own addresses nor on the allowlist.`,
    );
  }

  if (usd > policy.outbound.maxPerTransactionUsd) {
    return refusal(
      reasons,
      'max_per_transaction',
      `${money(usd)} is above the ${money(policy.outbound.maxPerTransactionUsd)} per-transaction limit.`,
    );
  }

  if (ctx.sessionSpentUsd + usd > policy.outbound.maxPerSessionUsd) {
    return refusal(
      reasons,
      'max_per_session',
      `${money(ctx.sessionSpentUsd)} already moved this session plus ${money(usd)} is above the ${money(policy.outbound.maxPerSessionUsd)} session limit.`,
    );
  }

  if (usd > policy.outbound.humanClickAboveUsd) {
    reasons.push(`${money(usd)} is above the ${money(policy.outbound.humanClickAboveUsd)} click threshold.`);
    return { outcome: 'needs_approval', reasons };
  }

  reasons.push('Within every limit.');
  return { outcome: 'allow', reasons };
}

export function evaluate(draft: WriteDraft, ctx: EngineCtx): Verdict {
  const reasons: string[] = [];

  // 1. No readable policy means no writes at all.
  if (ctx.policy === null) {
    return refusal(reasons, 'policy_unreadable', 'Policy file is unreadable, so every write is refused.');
  }
  const policy = ctx.policy;

  // 2. The kill switch outranks everything below it.
  if (policy.killSwitch) {
    return refusal(reasons, 'kill_switch', 'Kill switch is on: all writes refused.');
  }

  // 3. Policy changes.
  if (draft.kind === 'policy_change') return evaluatePolicyChange(draft, reasons);

  // 3b. Rails: swap, hyperliquid deposit, LP add/remove.
  if (isRailDraft(draft)) return evaluateRail(draft, policy, ctx, reasons);

  // ---- fund moves ----
  const legs = legsOf(draft);
  reasons.push(`${legs.length} leg(s) of ${symbolOf(draft)}.`);

  // 4. Nothing to move, no unreadable numbers, and nothing at all without a simulation.
  if (legs.length === 0) {
    return refusal(reasons, 'nothing_to_move', 'Draft has no legs: there is nothing to execute.');
  }
  const badLeg = legs.find(l => !legNumbersAreSane(l));
  if (badLeg) {
    return refusal(
      reasons,
      'invalid_leg',
      `Leg ${badLeg.fromChain} -> ${badLeg.toChain} asks to move ${badLeg.amount} ${badLeg.symbol}, which is not an amount that can be checked against a limit.`,
    );
  }
  const unquoted = legs.filter(l => l.quote === null);
  if (unquoted.length > 0) {
    return refusal(
      reasons,
      'simulation_required',
      `${unquoted.length} of ${legs.length} leg(s) have no quote: every leg must be simulated before it can be signed.`,
    );
  }

  const declaredTotal = draft.kind === 'consolidate' ? draft.totalUsd : draft.leg.amountUsd;
  const legTotal = legs.reduce((sum, l) => sum + legUsd(l), 0);
  const totalUsd = Math.max(Number.isFinite(declaredTotal) ? declaredTotal : 0, legTotal);
  reasons.push(`Moving ${money(totalUsd)} in total.`);

  // 5. Destination. Self addresses are implicitly allowed, everything else must be listed.
  const allowedDestinations = new Set<string>([
    ...ctx.selfAddresses.map(lower),
    ...policy.outbound.destinationAllowlist.map(lower),
  ]);
  const badDestination = legs.find(l => !allowedDestinations.has(lower(l.to)));
  if (badDestination) {
    return refusal(
      reasons,
      'destination_not_allowed',
      `Destination ${badDestination.to} is neither one of our own addresses nor on the allowlist.`,
    );
  }

  // 6. Per-transaction cap, measured per leg.
  const overCap = legs.find(l => legUsd(l) > policy.outbound.maxPerTransactionUsd);
  if (overCap) {
    return refusal(
      reasons,
      'max_per_transaction',
      `Leg of ${money(legUsd(overCap))} is above the ${money(policy.outbound.maxPerTransactionUsd)} per-transaction limit.`,
    );
  }

  // 7. Rolling session cap.
  if (ctx.sessionSpentUsd + totalUsd > policy.outbound.maxPerSessionUsd) {
    return refusal(
      reasons,
      'max_per_session',
      `${money(ctx.sessionSpentUsd)} already moved this session plus ${money(totalUsd)} is above the ${money(policy.outbound.maxPerSessionUsd)} session limit.`,
    );
  }

  // 8. Forbidden issuer for the symbol being moved.
  const issuer = issuerOf(symbolOf(draft), ctx.composition);
  const forbidden = policy.composition.forbiddenIssuers.find(f => lower(f) === lower(issuer));
  if (forbidden !== undefined) {
    return refusal(reasons, 'forbidden_issuer', `${symbolOf(draft)} is issued by ${issuer}, which the policy forbids.`);
  }

  // 9. Post-state composition. The engine judges the resulting state, not the delta: a
  // portfolio already past a cap cannot make further fund moves until a human changes the
  // policy or the caps stop being breached.
  const post = applyLegs(ctx.ledger, legs, ctx.selfAddresses);
  const postComp = classify(post, riskRowsFromComposition(ctx.composition));

  for (const [postIssuer, share] of Object.entries(postComp.byIssuer)) {
    const cap = issuerCap(postIssuer, policy.composition.maxIssuerShare);
    if (share > cap) {
      return refusal(
        reasons,
        'max_issuer_share',
        `After this move ${postIssuer} would hold ${pct(share)} of the portfolio, above its ${pct(cap)} cap.`,
      );
    }
  }

  if (postComp.freezableShare > policy.composition.maxFreezableShare) {
    return refusal(
      reasons,
      'max_freezable_share',
      `After this move ${pct(postComp.freezableShare)} of the portfolio would be freezable, above the ${pct(policy.composition.maxFreezableShare)} cap.`,
    );
  }

  const postNative = nativeUsdByChain(post);
  const touched: ChainId[] = [];
  for (const leg of legs) {
    if (!touched.includes(leg.fromChain)) touched.push(leg.fromChain);
    if (!touched.includes(leg.toChain)) touched.push(leg.toChain);
  }
  for (const chain of touched) {
    const floor = policy.composition.minNativeGasUsd[chain];
    if (floor === undefined) continue;
    const left = postNative.get(chain) ?? 0;
    if (left < floor) {
      return refusal(
        reasons,
        'min_native_gas',
        `After this move ${chain} would hold ${money(left)} of gas, below the ${money(floor)} floor.`,
      );
    }
  }
  reasons.push(`Post-move composition stays inside every cap.`);

  // 10 and 11.
  if (totalUsd > policy.outbound.humanClickAboveUsd) {
    reasons.push(`${money(totalUsd)} is above the ${money(policy.outbound.humanClickAboveUsd)} click threshold, so a human has to approve it.`);
    return { outcome: 'needs_approval', reasons };
  }
  reasons.push(`${money(totalUsd)} is at or below the ${money(policy.outbound.humanClickAboveUsd)} click threshold.`);
  return { outcome: 'allow', reasons };
}
