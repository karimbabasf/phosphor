// Drafting: how a fund move is planned, how a symbol is priced, and the two drafts that are not
// rail-backed (a consolidation and a policy change). The nine rail drafts are in rails.ts and
// they all end in proposeRail below.
//
// Every dollar figure here is derived rather than taken from the agent: a draft that could name
// its own dollar value could name a small one, and amountUsd is what every budget reads.

import type {
  ChainId,
  Holding,
  LedgerSnapshot,
  LpPosition,
  PolicyPatch,
  Proposal,
  SimulationResult,
  TransferLeg,
  Verdict,
  WriteDraft,
} from '../types.ts';
import { classify } from '../composition.ts';
import { applyLegs, evaluate } from '../policy/engine.ts';
import { loadPolicy } from '../policy/file.ts';
import { renderSentences } from '../policy/render.ts';
import type { RailDraft, RailKind } from '../rails/index.ts';
import {
  ALL_CHAINS,
  amount,
  buildCtx,
  dustThreshold,
  errText,
  mergePatch,
  money,
  newProposal,
  pct,
  recipientFor,
  selfAddresses,
} from './lifecycle.ts';
import { depositAddressesOf, land } from './execute.ts';
import type { PCtx } from './lifecycle.ts';

// Largest balance first, so a maxTotalUsd budget buys the fewest legs. The last leg is
// trimmed to whatever budget is left, and dropped if trimming pushes it into dust.
export function planLegs(ctx: PCtx, params: { toChain: ChainId; symbol: string; fromChains?: ChainId[]; maxTotalUsd?: number }, snapshot: LedgerSnapshot, recipient: string): TransferLeg[] {
  const sources = (params.fromChains ?? ALL_CHAINS).filter(c => c !== params.toChain);
  const candidates: Holding[] = snapshot.holdings
    .filter(h => !h.native && h.symbol === params.symbol && sources.includes(h.chain))
    .filter(h => h.usd >= dustThreshold(snapshot, h.chain, ctx.cfg))
    .sort((a, b) => b.usd - a.usd);

  // A non-finite budget makes every comparison below false and would plan legs carrying NaN,
  // so it reads as no budget at all and the draft ends up refused for having nothing to move.
  const budget = params.maxTotalUsd === undefined ? Infinity : Number.isFinite(params.maxTotalUsd) ? params.maxTotalUsd : 0;
  const legs: TransferLeg[] = [];
  let spentUsd = 0;

  // The price of one unit of what is being moved. This used to be assumed to be 1.0, with
  // the comment "stables are priced 1.0 everywhere in this app", and that was true while
  // the app only ever held stables. It stopped being true in this branch: the wallet now
  // holds WETH, data/tokens.json lists it, and the candidate filter above is
  // `!h.native && symbol matches`, which does not exclude it.
  //
  // Setting amountUsd to the token count made a 10 WETH consolidation (~$18,800) govern as
  // $10: below the $100 click threshold, so `allow`, so auto-executed with no human on any
  // gate setting. The engine cannot catch it downstream either, because legUsd() takes
  // max(declared, amount) and both were the token count. This is the same defect the swap
  // path was fixed for, left on the one fund-move path the MCP surface actually exposes.
  //
  // Infinity when the symbol cannot be priced, which the engine refuses as invalid_amount.
  // A token the app cannot price is a token it cannot govern.
  const unitPrice = priceOf(ctx, params.symbol, snapshot);
  const priceUsd = unitPrice === null ? Infinity : unitPrice;

  for (const h of candidates) {
    const remainingUsd = budget - spentUsd;
    if (remainingUsd <= 0) break;
    // Budget is in dollars and holdings are in tokens, so the trim has to convert rather
    // than compare the two directly. A non-finite price makes maxTokens 0, which drops
    // every leg and leaves the draft refused for having nothing to move.
    const maxTokens = Number.isFinite(priceUsd) && priceUsd > 0 ? remainingUsd / priceUsd : Infinity;
    const take = Math.min(h.amount, maxTokens);
    const takeUsd = take * priceUsd;
    // Dust is a DOLLAR floor, so it has to be compared against dollars. Comparing the token
    // count against it was the same units confusion as amountUsd above, and it bit in the
    // opposite direction: 1 WETH is $1,880 and would have been dropped as dust against a
    // $10 floor. Cheap either way for a stable, where the two numbers coincide.
    if (takeUsd < dustThreshold(snapshot, h.chain, ctx.cfg)) continue;
    legs.push({
      fromChain: h.chain,
      toChain: params.toChain,
      symbol: params.symbol,
      amount: take,
      amountUsd: takeUsd,
      from: h.address,
      to: recipient,
      quote: null,
      gasNativeUsd: snapshot.gas[h.chain]?.transferCostUsd ?? 0,
    });
    spentUsd += takeUsd;
  }

  return legs;
}

export function legSummary(leg: TransferLeg): string {
  const q = leg.quote;
  const out = q ? amount(q.amountOut) : amount(leg.amount);
  const fee = q ? money(q.feeUsd) : 'unknown fee';
  const eta = q ? `~${q.timeEstimateSec}s` : 'no quote';
  return `${leg.fromChain} -> ${leg.toChain}: ${out} ${leg.symbol}, fee ${fee}, ${eta}`;
}

export function compositionDelta(ctx: PCtx, snapshot: LedgerSnapshot, legs: TransferLeg[], selfList: string[]): { lines: string[]; post: ReturnType<typeof classify> } {
  const before = classify(snapshot, ctx.riskRows);
  const post = classify(applyLegs(snapshot, legs, selfList), ctx.riskRows);
  const lines = [`total stables ${money(before.totalUsd)} -> ${money(post.totalUsd)}`];

  const issuers = [...new Set([...Object.keys(before.byIssuer), ...Object.keys(post.byIssuer)])].sort();
  for (const issuer of issuers) {
    const a = before.byIssuer[issuer] ?? 0;
    const b = post.byIssuer[issuer] ?? 0;
    if (Math.abs(b - a) >= 0.0005) lines.push(`${issuer} ${pct(a)} -> ${pct(b)}`);
  }
  lines.push(`freezable ${pct(before.freezableShare)} -> ${pct(post.freezableShare)}`);
  return { lines, post };
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
  const spot = snapshot.prices[upper === 'WETH' ? 'ETH' : upper];
  if (typeof spot === 'number' && Number.isFinite(spot) && spot > 0) return spot;

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

export function positionUsd(ctx: PCtx, pos: LpPosition, snapshot: LedgerSnapshot): number {
  return (
    usdOf(ctx, pos.token0.symbol, pos.token0.amount, snapshot) +
    usdOf(ctx, pos.token1.symbol, pos.token1.amount, snapshot) +
    (pos.uncollectedFeesUsd ?? 0)
  );
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

export function ourAddress(ctx: PCtx, chain: ChainId, snapshot: LedgerSnapshot, problems: string[]): string {
  const found = recipientFor(ctx, chain, snapshot);
  if (found === null) {
    problems.push(`We hold no address on ${chain}, so there is no wallet of ours for this to run from.`);
    return '';
  }
  return found;
}

// Who owns a balance held inside intents.near. This is deliberately not a per-chain wallet
// lookup: the verifier derives the account id from the erc191 signer, so it is our EVM
// address whatever chain the asset calls home. A SOL balance in there is owned by the EVM
// account, not by the Solana address we hold SOL at on Solana, and those are different
// strings for the same money.
export function ourIntentsAddress(ctx: PCtx, snapshot: LedgerSnapshot, problems: string[]): string {
  const found = recipientFor(ctx, 'eth', snapshot);
  if (found === null) {
    problems.push(
      'We hold no EVM address, and a balance inside intents.near is owned by the EVM account the ' +
        'verifier derives from our signing key, so there is no account of ours to swap from.',
    );
    return '';
  }
  return found;
}

export function refuseDraft(ctx: PCtx, kind: RailKind, draft: RailDraft, reasons: string[]): Promise<Proposal> {
  return land(ctx, newProposal(kind, draft, null, { outcome: 'refuse', reasons, rule: 'invalid_draft' }));
}

// Shared tail for all four rails: evaluate, simulate, persist, and execute only if the
// policy said allow. Nothing here knows which rail it is holding.
export async function proposeRail(ctx: PCtx, kind: RailKind, draft: RailDraft): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);

  // The engine runs first because it is pure and its refusals are terminal. An unlisted
  // venue, the kill switch or a cap breach settles the proposal without spending the
  // round trips a rail simulation costs.
  const verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));
  if (verdict.outcome === 'refuse') return land(ctx, newProposal(kind, draft, null, verdict));

  const rail = ctx.rails.for(draft);
  if (rail === null) {
    return land(ctx, 
      newProposal(kind, draft, null, {
        outcome: 'refuse',
        reasons: [...verdict.reasons, `No ${kind} rail is wired in ${ctx.cfg.mode} mode, so there is nothing to execute.`],
        rule: 'no_rail',
      }),
    );
  }

  let simulation: SimulationResult;
  try {
    simulation = await rail.simulate(draft);
  } catch (err) {
    const message = errText(err);
    simulation = { ok: false, summary: `${kind} simulation threw: ${message}`, error: message };
  }

  // policy.outbound.simulateBeforeSign is a constant true and the UI says so. The engine
  // enforces it for legs by requiring a quote on each ('simulation_required'); a rail has
  // no legs, so the same rule is enforced here. A refusal rather than a pending proposal
  // on purpose: approve() re-runs the engine, not the simulation, so a failed simulation
  // parked as pending would quietly stop counting on its way to a human click.
  if (!simulation.ok) {
    return land(ctx, 
      newProposal(kind, draft, simulation, {
        outcome: 'refuse',
        reasons: [...verdict.reasons, `Simulation failed, so nothing is signed: ${simulation.error ?? simulation.summary}`],
        rule: 'simulation_required',
      }),
    );
  }

  return land(ctx, newProposal(kind, draft, simulation, verdict));
}

// ---------- public surface ----------
export async function proposeConsolidate(ctx: PCtx, params: { toChain: ChainId; symbol: string; fromChains?: ChainId[]; maxTotalUsd?: number }): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  const selfList = selfAddresses(ctx, snapshot);
  const recipient = recipientFor(ctx, params.toChain, snapshot);

  if (recipient === null) {
    const draft: WriteDraft = { kind: 'consolidate', legs: [], totalUsd: 0, toChain: params.toChain, symbol: params.symbol };
    const verdict: Verdict = {
      outcome: 'refuse',
      reasons: [`We hold no address on ${params.toChain}, so there is nowhere of ours to consolidate into.`],
      rule: 'destination_not_allowed',
    };
    return land(ctx, newProposal('consolidate', draft, null, verdict));
  }

  const legs = planLegs(ctx, params, snapshot, recipient);
  const draft: WriteDraft = {
    kind: 'consolidate',
    legs,
    totalUsd: legs.reduce((sum, l) => sum + l.amountUsd, 0),
    toChain: params.toChain,
    symbol: params.symbol,
  };

  // A dead or disarmed policy refuses every write, so do not spend a quote (or a network
  // round trip) finding that out.
  if (policy === null || policy.killSwitch || legs.length === 0) {
    return land(ctx, newProposal('consolidate', draft, null, evaluate(draft, buildCtx(ctx, snapshot, policy))));
  }

  let simulation: SimulationResult;
  try {
    for (const leg of legs) leg.quote = await ctx.quoter.quoteLeg(leg);
    const { lines, post } = compositionDelta(ctx, snapshot, legs, selfList);
    const deposits = depositAddressesOf(legs);
    // The addresses go in the summary, not just the record: the approval gate renders the
    // summary, and a destination the human cannot see is one they cannot meaningfully
    // approve. That was the substance of the finding, not just the missing comparison.
    const depositLines = deposits.map(d => `${d.leg} funds go to ${d.address} (chosen by ${ctx.quoter.name}, not by us)`);
    simulation = {
      ok: true,
      summary: [...legs.map(legSummary), ...depositLines, ...lines].join('\n'),
      postComposition: post,
      ...(deposits.length > 0 ? { depositAddresses: deposits } : {}),
    };
  } catch (err) {
    const message = errText(err);
    simulation = { ok: false, summary: `simulation failed via ${ctx.quoter.name}: ${message}`, error: message };
  }

  const verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));
  if (!simulation.ok && verdict.outcome === 'refuse') {
    // Keep the solver's own words in front of the human rather than paraphrasing them.
    verdict.reasons = [...verdict.reasons, `${ctx.quoter.name}: ${simulation.error ?? 'quote failed'}`];
  }
  return land(ctx, newProposal('consolidate', draft, simulation, verdict));
}

export async function proposePolicyChange(ctx: PCtx, params: { patch: PolicyPatch; sentence: string }): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  const draft: WriteDraft = { kind: 'policy_change', patch: params.patch, sentence: params.sentence };
  const verdict = evaluate(draft, buildCtx(ctx, snapshot, policy));

  let simulation: SimulationResult;
  if (policy === null) {
    simulation = { ok: false, summary: 'policy file is unreadable, so there is nothing to change', error: 'policy_unreadable' };
  } else if (verdict.outcome === 'refuse') {
    simulation = { ok: false, summary: `patch refused: ${verdict.rule}`, error: verdict.rule };
  } else {
    const after = renderSentences(mergePatch(policy, params.patch));
    // The +/- lines are the UI's to render from policyDiff; keeping them out of
    // summary stops the approval gate showing the same diff twice.
    simulation = {
      ok: true,
      summary: `the agent asked for: ${params.sentence}`,
      policyDiff: { before: policy.sentences, after },
    };
  }

  return land(ctx, newProposal('policy_change', draft, simulation, verdict));
}
