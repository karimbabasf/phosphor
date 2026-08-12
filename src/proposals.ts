// The proposal service: the only path from an agent's intent to a signed transaction.
//
// An agent can author and propose. It cannot execute. Every proposal lands in exactly one of
// three places, decided by the policy engine and nothing else:
//   allow           -> executed immediately (only below the human click threshold)
//   needs_approval  -> pending, and it moves only when a human clicks approve
//   refuse          -> policy_refused, terminal
// There is no override, no force flag and no fourth path. Approval re-runs the engine against
// the policy and balances as they are at that moment, so a kill switch flipped after the
// proposal was created still stops it. Every transition appends one line to the audit log.

import crypto from 'node:crypto';
import type {
  AppConfig,
  ChainId,
  HlDepositDraft,
  HlDepositParams,
  Holding,
  LedgerSnapshot,
  LpAddDraft,
  LpAddParams,
  LpPosition,
  LpRemoveDraft,
  LpRemoveParams,
  Policy,
  PolicyPatch,
  Proposal,
  ProposalService,
  Quoter,
  Rail,
  RailResult,
  RiskRow,
  Signer,
  SimulationResult,
  SwapDraft,
  SwapParams,
  TransferLeg,
  Verdict,
  WriteDraft,
} from './types.ts';
import type { Audit } from './audit.ts';
import type { Store } from './store.ts';
import type { Ledger } from './ledger/index.ts';
import { classify } from './composition.ts';
import { applyLegs, evaluate } from './policy/engine.ts';
import type { EngineCtx } from './policy/engine.ts';
import { loadPolicy, savePolicy } from './policy/file.ts';
import { gateRequired } from './policy/gate.ts';
import { renderSentences } from './policy/render.ts';
import { isRailKind } from './rails/index.ts';
import type { RailDraft, RailKind, RailRegistry } from './rails/index.ts';
import { VENUE as UNISWAP_VENUE } from './rails/uniswap.ts';
import { chainsWithDeployment, deploymentFor, tokenFor } from './rails/uniswap-abi.ts';
import { hlSpec } from './rails/hyperliquid-deposit.ts';
import { ONECLICK_COUNTERPARTY } from './rails/oneclick.ts';

const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const EVM_CHAINS: ChainId[] = ['eth', 'base', 'arb'];
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// A registry with no rails in it. Fail closed: a wiring layer that forgets to pass one
// gets every rail proposal refused with a reason, not a rail picked by guesswork.
const NO_RAILS: RailRegistry = { for: () => null, kinds: () => [] };

export type ProposalDeps = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  quoter: Quoter;
  signer: Signer;
  dataDir: string;
  rails?: RailRegistry; // src/rails/index.ts; absent means no rail can execute
  onChange?: () => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(share: number): string {
  return (share * 100).toFixed(2) + '%';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function totalUsdOf(draft: WriteDraft): number {
  if (draft.kind === 'consolidate') return draft.totalUsd;
  if (draft.kind === 'transfer') return draft.leg.amountUsd;
  if (draft.kind === 'policy_change') return 0;
  // Every rail draft carries its own amountUsd, which is what the engine budgets on. A
  // non-finite one never executes (the engine refuses it), so it contributes nothing here.
  return Number.isFinite(draft.amountUsd) ? draft.amountUsd : 0;
}

// Symbols the app prices at exactly 1.0. The risk table is already the app's register of
// what a dollar stable is, so this reads it rather than keeping a second list to drift.
function stableSymbols(rows: RiskRow[]): Set<string> {
  return new Set(rows.map(r => r.symbol.toUpperCase()));
}

// Same dust rule as cost.ts: below the economic transfer size, or below 3x what it costs to
// move anything off that chain. Kept local because cost.ts does not export the predicate.
function dustThreshold(snapshot: LedgerSnapshot, chain: ChainId, cfg: AppConfig): number {
  const transferCostUsd = snapshot.gas[chain]?.transferCostUsd ?? 0;
  return Math.max(cfg.economicTransferUsd, 3 * transferCostUsd);
}

// Copies only the fields a PolicyPatch is allowed to carry. A spread would let a hostile patch
// smuggle unknown keys into policy.json, so every field is named.
function mergePatch(base: Policy, patch: PolicyPatch): Policy {
  const next: Policy = {
    version: base.version,
    killSwitch: base.killSwitch,
    outbound: { ...base.outbound },
    composition: {
      maxIssuerShare: { ...base.composition.maxIssuerShare },
      maxFreezableShare: base.composition.maxFreezableShare,
      minNativeGasUsd: { ...base.composition.minNativeGasUsd },
      forbiddenIssuers: [...base.composition.forbiddenIssuers],
    },
    sentences: [...base.sentences],
  };

  const o = patch.outbound;
  if (o) {
    if (o.maxPerTransactionUsd !== undefined) next.outbound.maxPerTransactionUsd = o.maxPerTransactionUsd;
    if (o.maxPerSessionUsd !== undefined) next.outbound.maxPerSessionUsd = o.maxPerSessionUsd;
    if (o.humanClickAboveUsd !== undefined) next.outbound.humanClickAboveUsd = o.humanClickAboveUsd;
    if (o.destinationAllowlist !== undefined) next.outbound.destinationAllowlist = o.destinationAllowlist.map(a => a.toLowerCase());
  }

  const c = patch.composition;
  if (c) {
    if (c.maxIssuerShare !== undefined) next.composition.maxIssuerShare = { ...c.maxIssuerShare };
    if (c.maxFreezableShare !== undefined) next.composition.maxFreezableShare = c.maxFreezableShare;
    if (c.minNativeGasUsd !== undefined) next.composition.minNativeGasUsd = { ...c.minNativeGasUsd };
    if (c.forbiddenIssuers !== undefined) next.composition.forbiddenIssuers = [...c.forbiddenIssuers];
  }

  return next;
}

export function createProposalService(deps: ProposalDeps): ProposalService {
  const { cfg, audit, store, ledger, riskRows, quoter, signer, dataDir } = deps;
  const rails = deps.rails ?? NO_RAILS;
  const stables = stableSymbols(riskRows);

  function notify(): void {
    deps.onChange?.();
  }

  function persist(p: Proposal): Proposal {
    store.put(p);
    notify();
    return p;
  }

  // Addresses we own: whatever the ledger reports holdings for, plus anything configured.
  function selfAddresses(snapshot: LedgerSnapshot): string[] {
    const set = new Set<string>();
    for (const h of snapshot.holdings) set.add(h.address.toLowerCase());
    for (const a of [...cfg.addresses.evm, ...cfg.addresses.solana, ...cfg.addresses.near]) set.add(a.toLowerCase());
    return [...set];
  }

  // Where a consolidation lands. eth, base and arb share one evm address, so a holding on any
  // of them names the recipient on the others.
  function recipientFor(chain: ChainId, snapshot: LedgerSnapshot): string | null {
    const onChain = snapshot.holdings.find(h => h.chain === chain);
    if (onChain) return onChain.address;

    if (EVM_CHAINS.includes(chain)) {
      const sibling = snapshot.holdings.find(h => EVM_CHAINS.includes(h.chain));
      if (sibling) return sibling.address;
      return cfg.addresses.evm[0] ?? null;
    }
    if (chain === 'sol') return cfg.addresses.solana[0] ?? null;
    return cfg.addresses.near[0] ?? null;
  }

  function buildCtx(snapshot: LedgerSnapshot, policy: Policy | null): EngineCtx {
    return {
      policy,
      composition: classify(snapshot, riskRows),
      ledger: snapshot,
      sessionSpentUsd: sessionSpentUsd(),
      selfAddresses: selfAddresses(snapshot),
    };
  }

  // Largest balance first, so a maxTotalUsd budget buys the fewest legs. The last leg is
  // trimmed to whatever budget is left, and dropped if trimming pushes it into dust.
  function planLegs(params: { toChain: ChainId; symbol: string; fromChains?: ChainId[]; maxTotalUsd?: number }, snapshot: LedgerSnapshot, recipient: string): TransferLeg[] {
    const sources = (params.fromChains ?? ALL_CHAINS).filter(c => c !== params.toChain);
    const candidates: Holding[] = snapshot.holdings
      .filter(h => !h.native && h.symbol === params.symbol && sources.includes(h.chain))
      .filter(h => h.usd >= dustThreshold(snapshot, h.chain, cfg))
      .sort((a, b) => b.usd - a.usd);

    // A non-finite budget makes every comparison below false and would plan legs carrying NaN,
    // so it reads as no budget at all and the draft ends up refused for having nothing to move.
    const budget = params.maxTotalUsd === undefined ? Infinity : Number.isFinite(params.maxTotalUsd) ? params.maxTotalUsd : 0;
    const legs: TransferLeg[] = [];
    let spent = 0;

    for (const h of candidates) {
      const remaining = budget - spent;
      if (remaining <= 0) break;
      const take = Math.min(h.amount, remaining);
      if (take < dustThreshold(snapshot, h.chain, cfg)) continue;
      legs.push({
        fromChain: h.chain,
        toChain: params.toChain,
        symbol: params.symbol,
        amount: take,
        amountUsd: take, // stables are priced 1.0 everywhere in this app
        from: h.address,
        to: recipient,
        quote: null,
        gasNativeUsd: snapshot.gas[h.chain]?.transferCostUsd ?? 0,
      });
      spent += take;
    }

    return legs;
  }

  function legSummary(leg: TransferLeg): string {
    const q = leg.quote;
    const out = q ? amount(q.amountOut) : amount(leg.amount);
    const fee = q ? money(q.feeUsd) : 'unknown fee';
    const eta = q ? `~${q.timeEstimateSec}s` : 'no quote';
    return `${leg.fromChain} -> ${leg.toChain}: ${out} ${leg.symbol}, fee ${fee}, ${eta}`;
  }

  function compositionDelta(snapshot: LedgerSnapshot, legs: TransferLeg[], selfList: string[]): { lines: string[]; post: ReturnType<typeof classify> } {
    const before = classify(snapshot, riskRows);
    const post = classify(applyLegs(snapshot, legs, selfList), riskRows);
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

  function newProposal(kind: WriteDraft['kind'], draft: WriteDraft, simulation: SimulationResult | null, verdict: Verdict): Proposal {
    return {
      id: crypto.randomUUID(),
      kind,
      createdAt: nowIso(),
      status: 'pending',
      draft,
      simulation,
      verdict,
    };
  }

  // Single exit for a freshly evaluated proposal. This is the only place a proposal can become
  // executed without a human, and only on verdict allow.
  async function land(p: Proposal): Promise<Proposal> {
    if (p.verdict.outcome === 'refuse') {
      const refused: Proposal = { ...p, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() };
      audit.append('proposal_created', `${p.kind} proposal ${p.id} refused by policy: ${p.verdict.rule}`, {
        id: p.id,
        verdict: p.verdict,
      });
      audit.append('policy_refused', `${p.verdict.rule}: ${p.verdict.reasons[p.verdict.reasons.length - 1]}`, {
        id: p.id,
        rule: p.verdict.rule,
        reasons: p.verdict.reasons,
      });
      return persist(refused);
    }

    audit.append('proposal_created', `${p.kind} proposal ${p.id}: ${p.verdict.outcome}`, {
      id: p.id,
      verdict: p.verdict,
      totalUsd: totalUsdOf(p.draft),
    });

    if (p.verdict.outcome === 'needs_approval') {
      if (gateRequired(cfg)) return persist(p);

      // The gate is off, which only ever happens on testnet: gateRequired() ignores this
      // flag entirely on mainnet. Karim asked for no safeguards while testing, and until
      // now the flag only changed what the UI said, not what the app did, so the banner
      // claimed every proposal auto-approves while they all sat pending forever. An app
      // that misreports its own safety state is worse than one with the safety off.
      //
      // decidedBy is 'gate_disabled', never 'human'. The audit trail must never let anyone
      // read this later as a person having looked at it and clicked.
      audit.append('approved', `${p.kind} proposal ${p.id} auto-approved: approval gate disabled on ${cfg.network}`, {
        id: p.id,
        decidedBy: 'gate_disabled',
        network: cfg.network,
        totalUsd: totalUsdOf(p.draft),
      });
      const auto = persist({ ...p, status: 'approved', decidedBy: 'gate_disabled', decidedAt: nowIso() });
      return executeApproved(auto);
    }

    // allow: under the click threshold, so the policy itself is the decision maker.
    const allowed = persist({ ...p, status: 'approved', decidedBy: 'policy', decidedAt: nowIso() });
    return executeApproved(allowed);
  }

  // The one route from an approved proposal to the thing that runs it. Both entry points
  // (the auto-allow path above and the human approve() below) come through here, so the
  // registry is consulted once rather than in a switch copied per call site.
  async function executeApproved(p: Proposal): Promise<Proposal> {
    if (p.draft.kind === 'policy_change') return applyPolicyChange(p);

    const rail = rails.for(p.draft);
    if (rail !== null) return executeRail(p, rail);

    if (isRailKind(p.draft.kind)) {
      // A rail draft with no rail behind it. Reachable when a proposal outlives the process
      // that made it and the app comes back up in a mode that owns no rails; running it as a
      // fund move would report a zero-leg success and move nothing.
      const detail = `no ${p.draft.kind} rail is wired in ${cfg.mode} mode, so nothing was sent`;
      audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
      return persist({ ...p, status: 'failed', result: { ok: false, detail } });
    }

    return executeFundMove(p);
  }

  async function executeRail(p: Proposal, rail: Rail): Promise<Proposal> {
    const executing = persist({ ...p, status: 'executing' });

    let result: RailResult;
    try {
      result = await rail.execute(p.draft);
    } catch (err) {
      // A rail that throws has said nothing about whether it sent anything, so its message
      // is passed through as-is rather than summarised into "failed".
      result = { ok: false, detail: `${p.draft.kind} rail threw: ${errText(err)}` };
    }

    const txids = result.txids ?? [];
    if (!result.ok) {
      audit.append('execution_failed', `${p.id}: ${result.detail}`, { id: p.id, txids });
      return persist({ ...executing, status: 'failed', result: { ok: false, detail: result.detail } });
    }
    audit.append('executed', `${p.id}: ${result.detail}`, { id: p.id, txids });
    return persist({ ...executing, status: 'executed', result: { ok: true, detail: result.detail } });
  }

  function depositAddressFor(leg: TransferLeg): string {
    const raw = leg.quote?.raw as { quote?: { depositAddress?: string } } | undefined;
    return raw?.quote?.depositAddress ?? leg.to;
  }

  async function executeFundMove(p: Proposal): Promise<Proposal> {
    const legs = p.draft.kind === 'consolidate' ? p.draft.legs : p.draft.kind === 'transfer' ? [p.draft.leg] : [];
    const executing = persist({ ...p, status: 'executing' });

    if (cfg.mode === 'demo') {
      for (const leg of legs) ledger.applyDemoTransfer(leg);
      const detail = `moved ${money(totalUsdOf(p.draft))} across ${legs.length} leg(s) in demo mode`;
      audit.append('executed', `${p.id}: ${detail}`, { id: p.id, legs: legs.length });
      return persist({ ...executing, status: 'executed', result: { ok: true, detail } });
    }

    if (!signer.ready) {
      // The auth step Karim does last. Nothing is signed, nothing is lost.
      const detail = signer.describe();
      audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
      return persist({ ...executing, status: 'failed', result: { ok: false, detail } });
    }

    const failures: string[] = [];
    const txids: string[] = [];
    for (const leg of legs) {
      try {
        const res = await signer.send(leg, depositAddressFor(leg));
        if (res.ok) txids.push(res.txid ?? '(no txid)');
        else failures.push(`${leg.fromChain} -> ${leg.toChain}: ${res.error ?? 'unknown error'}`);
      } catch (err) {
        failures.push(`${leg.fromChain} -> ${leg.toChain}: ${errText(err)}`);
      }
    }

    if (failures.length > 0) {
      const detail = failures.join('; ');
      audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id, txids });
      return persist({ ...executing, status: 'failed', result: { ok: false, detail } });
    }

    const detail = `sent ${legs.length} leg(s): ${txids.join(', ')}`;
    audit.append('executed', `${p.id}: ${detail}`, { id: p.id, txids });
    return persist({ ...executing, status: 'executed', result: { ok: true, detail } });
  }

  async function applyPolicyChange(p: Proposal): Promise<Proposal> {
    if (p.draft.kind !== 'policy_change') return p;
    const current = loadPolicy(dataDir);
    if (!current) {
      const detail = 'policy file became unreadable before the change could be applied';
      audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
      return persist({ ...p, status: 'failed', result: { ok: false, detail } });
    }

    const patched = mergePatch(current, p.draft.patch);
    patched.version = current.version + 1;
    // The policy the human reads is always the deterministic render of the policy that is
    // actually in force. The agent's own wording stays in the proposal and the audit trail,
    // where it is clearly the agent talking, and never becomes the displayed rule.
    patched.sentences = renderSentences(patched);
    savePolicy(dataDir, patched);

    audit.append('policy_changed', `${p.id}: policy now at version ${patched.version}`, {
      id: p.id,
      patch: p.draft.patch,
      agentSentence: p.draft.sentence,
      before: current.sentences,
      after: patched.sentences,
    });

    const detail = `policy updated to version ${patched.version}`;
    audit.append('executed', `${p.id}: ${detail}`, { id: p.id });
    return persist({ ...p, status: 'executed', result: { ok: true, detail } });
  }

  // ---------- public surface ----------

  async function proposeConsolidate(params: { toChain: ChainId; symbol: string; fromChains?: ChainId[]; maxTotalUsd?: number }): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const policy = loadPolicy(dataDir);
    const selfList = selfAddresses(snapshot);
    const recipient = recipientFor(params.toChain, snapshot);

    if (recipient === null) {
      const draft: WriteDraft = { kind: 'consolidate', legs: [], totalUsd: 0, toChain: params.toChain, symbol: params.symbol };
      const verdict: Verdict = {
        outcome: 'refuse',
        reasons: [`We hold no address on ${params.toChain}, so there is nowhere of ours to consolidate into.`],
        rule: 'destination_not_allowed',
      };
      return land(newProposal('consolidate', draft, null, verdict));
    }

    const legs = planLegs(params, snapshot, recipient);
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
      return land(newProposal('consolidate', draft, null, evaluate(draft, buildCtx(snapshot, policy))));
    }

    let simulation: SimulationResult;
    try {
      for (const leg of legs) leg.quote = await quoter.quoteLeg(leg);
      const { lines, post } = compositionDelta(snapshot, legs, selfList);
      simulation = {
        ok: true,
        summary: [...legs.map(legSummary), ...lines].join('\n'),
        postComposition: post,
      };
    } catch (err) {
      const message = errText(err);
      simulation = { ok: false, summary: `simulation failed via ${quoter.name}: ${message}`, error: message };
    }

    const verdict = evaluate(draft, buildCtx(snapshot, policy));
    if (!simulation.ok && verdict.outcome === 'refuse') {
      // Keep the solver's own words in front of the human rather than paraphrasing them.
      verdict.reasons = [...verdict.reasons, `${quoter.name}: ${simulation.error ?? 'quote failed'}`];
    }
    return land(newProposal('consolidate', draft, simulation, verdict));
  }

  async function proposePolicyChange(params: { patch: PolicyPatch; sentence: string }): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const policy = loadPolicy(dataDir);
    const draft: WriteDraft = { kind: 'policy_change', patch: params.patch, sentence: params.sentence };
    const verdict = evaluate(draft, buildCtx(snapshot, policy));

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

    return land(newProposal('policy_change', draft, simulation, verdict));
  }

  // ---------- rails ----------

  // What one unit of a symbol is worth, from what the app already knows: the risk table
  // (stables are 1.0 everywhere in this app), then the ledger's own holdings, then the
  // native spot table. null means this app cannot honestly price it.
  function priceOf(symbol: string, snapshot: LedgerSnapshot): number | null {
    const upper = symbol.toUpperCase();
    if (stables.has(upper)) return 1;

    const held = snapshot.holdings.find(h => h.symbol.toUpperCase() === upper && h.amount > 0 && Number.isFinite(h.usd));
    if (held !== undefined) return held.usd / held.amount;

    // WETH is ETH wrapped: one dollar value, two contracts. The ledger prices natives only.
    const spot = snapshot.prices[upper === 'WETH' ? 'ETH' : upper];
    return typeof spot === 'number' && Number.isFinite(spot) && spot > 0 ? spot : null;
  }

  // USD the draft moves, which is the number every budget in the engine reads. Deliberately
  // derived here rather than taken from the agent: a draft that could name its own dollar
  // value could name a small one. A symbol the app cannot price becomes Infinity, never NaN,
  // because the engine refuses a non-finite amount ('invalid_amount') where NaN would make
  // every comparison against a cap false and sail through all of them.
  function usdOf(symbol: string, amount: number, snapshot: LedgerSnapshot): number {
    const price = priceOf(symbol, snapshot);
    if (price === null || !Number.isFinite(amount) || amount < 0) return Infinity;
    return amount * price;
  }

  function positionUsd(pos: LpPosition, snapshot: LedgerSnapshot): number {
    return (
      usdOf(pos.token0.symbol, pos.token0.amount, snapshot) +
      usdOf(pos.token1.symbol, pos.token1.amount, snapshot) +
      (pos.uncollectedFeesUsd ?? 0)
    );
  }

  // Resolve something out of a verified table, collecting the table's own error message
  // instead of throwing. The draft still gets built so the refusal has something to show.
  function resolve<T>(fn: () => T, problems: string[], fallback: T): T {
    try {
      return fn();
    } catch (err) {
      problems.push(errText(err));
      return fallback;
    }
  }

  function ourAddress(chain: ChainId, snapshot: LedgerSnapshot, problems: string[]): string {
    const found = recipientFor(chain, snapshot);
    if (found === null) {
      problems.push(`We hold no address on ${chain}, so there is no wallet of ours for this to run from.`);
      return '';
    }
    return found;
  }

  function refuseDraft(kind: RailKind, draft: RailDraft, reasons: string[]): Promise<Proposal> {
    return land(newProposal(kind, draft, null, { outcome: 'refuse', reasons, rule: 'invalid_draft' }));
  }

  // Shared tail for all four rails: evaluate, simulate, persist, and execute only if the
  // policy said allow. Nothing here knows which rail it is holding.
  async function proposeRail(kind: RailKind, draft: RailDraft): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const policy = loadPolicy(dataDir);

    // The engine runs first because it is pure and its refusals are terminal. An unlisted
    // venue, the kill switch or a cap breach settles the proposal without spending the
    // round trips a rail simulation costs.
    const verdict = evaluate(draft, buildCtx(snapshot, policy));
    if (verdict.outcome === 'refuse') return land(newProposal(kind, draft, null, verdict));

    const rail = rails.for(draft);
    if (rail === null) {
      return land(
        newProposal(kind, draft, null, {
          outcome: 'refuse',
          reasons: [...verdict.reasons, `No ${kind} rail is wired in ${cfg.mode} mode, so there is nothing to execute.`],
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
      return land(
        newProposal(kind, draft, simulation, {
          outcome: 'refuse',
          reasons: [...verdict.reasons, `Simulation failed, so nothing is signed: ${simulation.error ?? simulation.summary}`],
          rule: 'simulation_required',
        }),
      );
    }

    return land(newProposal(kind, draft, simulation, verdict));
  }

  async function proposeSwap(params: SwapParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];
    const venue = params.venue === 'oneclick' ? 'oneclick' : UNISWAP_VENUE;
    const toChain = params.toChain ?? params.chain;

    // Both sides are our own wallet. The agent picks the chains and the symbols; it has no
    // way to say who receives the output.
    const from = ourAddress(params.chain, snapshot, problems);
    const to = params.chain === toChain ? from : ourAddress(toChain, snapshot, problems);

    const counterparty =
      venue === 'oneclick'
        ? ONECLICK_COUNTERPARTY
        : resolve(() => String(deploymentFor(cfg.network, params.chain).router), problems, '');

    const draft: SwapDraft = {
      kind: 'swap',
      venue,
      chain: params.chain,
      toChain,
      fromSymbol: params.fromSymbol,
      toSymbol: params.toSymbol,
      amountIn: params.amountIn,
      amountUsd: usdOf(params.fromSymbol, params.amountIn, snapshot),
      minAmountOut: params.minAmountOut,
      from,
      to,
      counterparty,
      quote: null,
    };

    return problems.length > 0 ? refuseDraft('swap', draft, problems) : proposeRail('swap', draft);
  }

  async function proposeHlDeposit(params: HlDepositParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];
    const spec = hlSpec(cfg.network);
    const from = ourAddress(spec.chain, snapshot, problems);

    const draft: HlDepositDraft = {
      kind: 'hl_deposit',
      chain: spec.chain,
      symbol: spec.symbol,
      amount: params.amount,
      // The bridge takes one token and it is a dollar stable, which is the same rule the
      // rail's own valueUsd applies.
      amountUsd: Number.isFinite(params.amount) && params.amount >= 0 ? params.amount : Infinity,
      from,
      bridge: spec.bridge,
    };

    return problems.length > 0 ? refuseDraft('hl_deposit', draft, problems) : proposeRail('hl_deposit', draft);
  }

  async function proposeLpAdd(params: LpAddParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];
    const from = ourAddress(params.chain, snapshot, problems);

    // Token addresses and decimals come from the venue's own verified registry, never from
    // the agent: a token id on the wire is a contract this app would then approve.
    const token0 = resolve(() => tokenFor(cfg.network, params.chain, params.token0Symbol), problems, null);
    const token1 = resolve(() => tokenFor(cfg.network, params.chain, params.token1Symbol), problems, null);
    const counterparty = resolve(
      () => String(deploymentFor(cfg.network, params.chain).positionManager),
      problems,
      '',
    );

    const draft: LpAddDraft = {
      kind: 'lp_add',
      chain: params.chain,
      venue: UNISWAP_VENUE,
      // Empty on purpose: the rail asks the factory which pool this pair and fee resolve to,
      // and a pool id from the agent would be a second answer to that question.
      poolId: '',
      token0: {
        symbol: token0?.symbol ?? params.token0Symbol,
        tokenId: token0?.address ?? '',
        amount: params.amount0,
        decimals: token0?.decimals ?? 0,
      },
      token1: {
        symbol: token1?.symbol ?? params.token1Symbol,
        tokenId: token1?.address ?? '',
        amount: params.amount1,
        decimals: token1?.decimals ?? 0,
      },
      feeTier: params.feeTier,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amountUsd:
        usdOf(token0?.symbol ?? params.token0Symbol, params.amount0, snapshot) +
        usdOf(token1?.symbol ?? params.token1Symbol, params.amount1, snapshot),
      from,
      counterparty,
    };

    return problems.length > 0 ? refuseDraft('lp_add', draft, problems) : proposeRail('lp_add', draft);
  }

  async function proposeLpRemove(params: LpRemoveParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];

    // The wallet decides which position this is. Reading the chain, the venue and the value
    // off a position we already hold means an id we do not hold cannot be turned into a
    // draft at all, and no field of the draft is the agent's word for it.
    const position = ledger.positions().find(p => p.positionId === params.positionId);
    if (position === undefined) {
      problems.push(
        `No pool position ${params.positionId} in the wallet. Read the wallet first: only positions this app can see can be pulled.`,
      );
    }

    const chain = position?.chain ?? chainsWithDeployment(cfg.network)[0] ?? 'arb';
    const from = position === undefined ? '' : ourAddress(chain, snapshot, problems);
    const counterparty =
      position === undefined ? '' : resolve(() => String(deploymentFor(cfg.network, chain).positionManager), problems, '');

    const draft: LpRemoveDraft = {
      kind: 'lp_remove',
      chain,
      venue: position?.venue ?? UNISWAP_VENUE,
      positionId: params.positionId,
      liquidityPct: params.liquidityPct,
      // Pessimistic on purpose: pulling liquidity brings funds back, but the engine budgets
      // every rail draft the same way, and over-counting a move costs a delay where
      // under-counting it costs money.
      amountUsd: position === undefined ? Infinity : positionUsd(position, snapshot) * params.liquidityPct,
      from,
      counterparty,
    };

    return problems.length > 0 ? refuseDraft('lp_remove', draft, problems) : proposeRail('lp_remove', draft);
  }

  function requirePending(id: string, action: string): Proposal {
    const p = store.get(id);
    if (!p) {
      audit.append('approve_attempt_rejected', `${action} for unknown proposal ${id}`, { id, action });
      throw new Error(`unknown proposal ${id}`);
    }
    if (p.status !== 'pending') {
      audit.append('approve_attempt_rejected', `${action} for proposal ${id} which is ${p.status}, not pending`, { id, action, status: p.status });
      throw new Error(`proposal ${id} is not pending (status ${p.status})`);
    }
    return p;
  }

  async function approve(id: string): Promise<Proposal> {
    const p = requirePending(id, 'approve');

    // Re-run the engine at approval time: the policy file, the kill switch and the balances
    // can all have moved since the proposal was created, and the older verdict is only ever a
    // statement about the world as it was then.
    const snapshot = ledger.snapshot();
    const policy = loadPolicy(dataDir);
    const verdict = evaluate(p.draft, buildCtx(snapshot, policy));
    if (verdict.outcome === 'refuse') {
      audit.append('policy_refused', `${id} refused at approval time: ${verdict.rule}`, { id, rule: verdict.rule, reasons: verdict.reasons });
      return persist({ ...p, verdict, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() });
    }

    const approved = persist({ ...p, verdict, status: 'approved', decidedBy: 'human', decidedAt: nowIso() });
    audit.append('approved', `human approved ${p.kind} proposal ${id}`, { id, totalUsd: totalUsdOf(p.draft) });
    return executeApproved(approved);
  }

  async function refuse(id: string): Promise<Proposal> {
    const p = requirePending(id, 'refuse');
    audit.append('refused', `human refused ${p.kind} proposal ${id}`, { id });
    return persist({ ...p, status: 'refused', decidedBy: 'human', decidedAt: nowIso() });
  }

  function sessionSpentUsd(): number {
    const cutoff = Date.now() - SESSION_WINDOW_MS;
    return store
      .list()
      // Everything that moved funds, which is every kind except a policy change. Written as
      // an exclusion so a rail added later counts against the session cap by default: an
      // inclusion list would leave the new kind silently unbudgeted.
      .filter(p => p.status === 'executed' && p.kind !== 'policy_change')
      .filter(p => {
        const at = Date.parse(p.decidedAt ?? p.createdAt);
        return Number.isFinite(at) && at >= cutoff;
      })
      .reduce((sum, p) => sum + totalUsdOf(p.draft), 0);
  }

  return {
    proposeConsolidate,
    proposePolicyChange,
    proposeSwap,
    proposeHlDeposit,
    proposeLpAdd,
    proposeLpRemove,
    approve,
    refuse,
    get: (id: string) => store.get(id),
    list: () => store.list(),
    sessionSpentUsd,
  };
}
