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
  Holding,
  LedgerSnapshot,
  Policy,
  PolicyPatch,
  Proposal,
  ProposalService,
  Quoter,
  RiskRow,
  Signer,
  SimulationResult,
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
import { renderSentences } from './policy/render.ts';

const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const EVM_CHAINS: ChainId[] = ['eth', 'base', 'arb'];
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProposalDeps = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  quoter: Quoter;
  signer: Signer;
  dataDir: string;
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
  return 0;
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

    if (p.verdict.outcome === 'needs_approval') return persist(p);

    // allow: under the click threshold, so the policy itself is the decision maker.
    const allowed = persist({ ...p, status: 'approved', decidedBy: 'policy', decidedAt: nowIso() });
    return p.kind === 'policy_change' ? applyPolicyChange(allowed) : executeFundMove(allowed);
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
      simulation = {
        ok: true,
        summary: [`the agent asked for: ${params.sentence}`, '', ...after.filter(s => !policy.sentences.includes(s)).map(s => `+ ${s}`), ...policy.sentences.filter(s => !after.includes(s)).map(s => `- ${s}`)].join('\n'),
        policyDiff: { before: policy.sentences, after },
      };
    }

    return land(newProposal('policy_change', draft, simulation, verdict));
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
    return p.kind === 'policy_change' ? applyPolicyChange(approved) : executeFundMove(approved);
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
      .filter(p => p.status === 'executed' && (p.kind === 'consolidate' || p.kind === 'transfer'))
      .filter(p => {
        const at = Date.parse(p.decidedAt ?? p.createdAt);
        return Number.isFinite(at) && at >= cutoff;
      })
      .reduce((sum, p) => sum + totalUsdOf(p.draft), 0);
  }

  return {
    proposeConsolidate,
    proposePolicyChange,
    approve,
    refuse,
    get: (id: string) => store.get(id),
    list: () => store.list(),
    sessionSpentUsd,
  };
}
