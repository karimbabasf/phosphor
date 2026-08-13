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
  IntentsDepositDraft,
  IntentsDepositParams,
  IntentsWithdrawDraft,
  IntentsWithdrawParams,
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
import { INTENTS_DEPOSIT_COUNTERPARTY, minCreditedFor } from './rails/intents-deposit.ts';
import { INTENTS_NATIVE_COUNTERPARTY } from './rails/intents-native.ts';
import {
  INTENTS_WITHDRAW_COUNTERPARTY,
  WITHDRAW_DESTINATIONS,
  minReceivedFor,
  ourWalletOn,
} from './rails/intents-withdraw.ts';
import { NATIVE_ASSET, NATIVE_TOKEN_ID } from './intents.ts';

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
    let spentUsd = 0;

    // The price of one unit of what is being moved. This used to be assumed to be 1.0, with
    // the comment "stables are priced 1.0 everywhere in this app", and that was true while
    // the app only ever held stables. It stopped being true in this branch: the wallet now
    // holds WETH, data/tokens.testnet.json lists it, and the candidate filter above is
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
    const unitPrice = priceOf(params.symbol, snapshot);
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
      if (takeUsd < dustThreshold(snapshot, h.chain, cfg)) continue;
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
      // A policy change is NEVER auto-approved, on any network, with the gate off or on.
      // Karim's "no safeguards on testnet" means moving money without clicking; it cannot
      // mean letting the agent rewrite the rules that govern it, because then the agent
      // authors the limits AND applies them, which is the exact thing this app exists to
      // prevent. Proven before this line existed: with the gate off an agent raised
      // maxPerTransactionUsd from $10,000 to $999,999 and the file on disk changed.
      // The policy file is also shared with mainnet, so a testnet convenience that can
      // widen it is a mainnet hole wearing a testnet label.
      if (gateRequired(cfg) || p.kind === 'policy_change') return persist(p);

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
      return persist({ ...executing, status: 'failed', result: { ok: false, detail: result.detail, txids } });
    }
    audit.append('executed', `${p.id}: ${result.detail}`, { id: p.id, txids });
    return persist({ ...executing, status: 'executed', result: { ok: true, detail: result.detail, txids } });
  }

  function legKey(leg: TransferLeg): string {
    return `${leg.fromChain}->${leg.toChain}:${leg.symbol}`;
  }

  // Where a leg's funds are ACTUALLY sent. For a 1Click quote this is a deposit address the
  // solver minted, not leg.to: the solver takes delivery here and pays out to leg.to itself.
  // That is inherent to intent bridging and is not the bug. The bug was that the policy
  // engine's destination rule checks leg.to while this value is what gets signed, so the
  // control reported a guarantee about an address nobody looked at.
  function depositAddressFor(leg: TransferLeg): string {
    const raw = leg.quote?.raw as { quote?: { depositAddress?: string } } | undefined;
    return raw?.quote?.depositAddress ?? leg.to;
  }

  // Captured at propose time so the human approves a concrete destination, and so execution
  // has something to compare against. Only legs that actually have a venue-chosen address
  // appear: a leg falling back to leg.to is already governed by the allowlist.
  function depositAddressesOf(legs: TransferLeg[]): Array<{ leg: string; address: string }> {
    const out: Array<{ leg: string; address: string }> = [];
    for (const leg of legs) {
      const address = depositAddressFor(leg);
      if (address !== leg.to) out.push({ leg: legKey(leg), address });
    }
    return out;
  }

  // The check that closes the gap. Proposals persist to disk as JSON between approval and
  // execution, so the quote a leg carries at send time is not necessarily the one the human
  // saw. Anything that edits that file, or any refetch, would otherwise redirect the funds
  // silently. Compare what we are about to sign against what was recorded when the proposal
  // was made, and refuse on any difference rather than guessing which one is right.
  function depositAddressMismatch(p: Proposal, legs: TransferLeg[]): string | null {
    const approved = p.simulation?.depositAddresses;
    if (approved === undefined) return null; // nothing venue-chosen in this proposal

    const now = depositAddressesOf(legs);
    if (now.length !== approved.length) {
      return `deposit addresses changed since approval: ${approved.length} recorded, ${now.length} now`;
    }
    for (const record of approved) {
      const current = now.find(n => n.leg === record.leg);
      if (current === undefined) return `leg ${record.leg} no longer carries the approved deposit address`;
      if (current.address.toLowerCase() !== record.address.toLowerCase()) {
        return `leg ${record.leg} would now send to a different address than the one approved`;
      }
    }
    return null;
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

    // Refuse before signing anything if the destination is no longer what was approved.
    const mismatch = depositAddressMismatch(p, legs);
    if (mismatch !== null) {
      audit.append('execution_failed', `${p.id}: ${mismatch}`, { id: p.id });
      return persist({ ...executing, status: 'failed', result: { ok: false, detail: mismatch } });
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
      return persist({ ...executing, status: 'failed', result: { ok: false, detail, txids } });
    }

    const detail = `sent ${legs.length} leg(s): ${txids.join(', ')}`;
    audit.append('executed', `${p.id}: ${detail}`, { id: p.id, txids });
    return persist({ ...executing, status: 'executed', result: { ok: true, detail, txids } });
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
      const deposits = depositAddressesOf(legs);
      // The addresses go in the summary, not just the record: the approval gate renders the
      // summary, and a destination the human cannot see is one they cannot meaningfully
      // approve. That was the substance of the finding, not just the missing comparison.
      const depositLines = deposits.map(d => `${d.leg} funds go to ${d.address} (chosen by ${quoter.name}, not by us)`);
      simulation = {
        ok: true,
        summary: [...legs.map(legSummary), ...depositLines, ...lines].join('\n'),
        postComposition: post,
        ...(deposits.length > 0 ? { depositAddresses: deposits } : {}),
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

  // Who owns a balance held inside intents.near. This is deliberately not a per-chain wallet
  // lookup: the verifier derives the account id from the erc191 signer, so it is our EVM
  // address whatever chain the asset calls home. A SOL balance in there is owned by the EVM
  // account, not by the Solana address we hold SOL at on Solana, and those are different
  // strings for the same money.
  function ourIntentsAddress(snapshot: LedgerSnapshot, problems: string[]): string {
    const found = recipientFor('eth', snapshot);
    if (found === null) {
      problems.push(
        'We hold no EVM address, and a balance inside intents.near is owned by the EVM account the ' +
          'verifier derives from our signing key, so there is no account of ours to swap from.',
      );
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
    // Explicit per venue, not a two-way test with a default, for the reason the rail router
    // gives: a new venue falling through to uniswap silently would route a draft meant for
    // NEAR Intents into an on-chain DEX swap.
    const venue =
      params.venue === 'oneclick' || params.venue === 'intents-native' ? params.venue : UNISWAP_VENUE;
    const toChain = params.toChain ?? params.chain;

    // Both sides are our own wallet. The agent picks the chains and the symbols; it has no
    // way to say who receives the output.
    //
    // toChain means two different things depending on the venue, and conflating them made the
    // intents-native rail unreachable for every pair it exists to serve. On an on-chain venue
    // it names where the output LANDS, so the recipient is that chain's address. On
    // intents-native nothing lands on a chain at all: the proceeds are credited to our own
    // account inside the verifier, so toChain names only the destination ASSET's home chain
    // and the recipient stays the origin address. Deriving `to` from toChain regardless sent
    // a sol address into a draft whose own rail requires from === to, so the swap was refused
    // as unsimulatable while omitting toChain failed asset lookup instead. No argument
    // combination worked. Note this is strictly narrowing: intents-native can now only ever
    // pay ourselves, which is what the rail already asserted in requireVenue.
    // `from` carried the same bug as `to` above, and it was found the same way: a swap that
    // passed simulation and was refused at execution, after the policy engine had already
    // allowed it. On intents-native, chain names the origin ASSET's home chain, not a wallet,
    // for exactly the reason toChain does not name a destination wallet. Deriving `from` from
    // params.chain authored a SOL-in-intents draft for our Solana address, which execute()
    // refuses because the configured key is the EVM one. The pair was unsellable either way:
    // chain 'sol' resolved the asset and the wrong owner, and any EVM chain resolved the right
    // owner but could not name SOL at all.
    const from =
      venue === 'intents-native'
        ? ourIntentsAddress(snapshot, problems)
        : ourAddress(params.chain, snapshot, problems);
    const to =
      venue === 'intents-native' || params.chain === toChain
        ? from
        : ourAddress(toChain, snapshot, problems);

    const counterparty =
      venue === 'oneclick'
        ? ONECLICK_COUNTERPARTY
        : venue === 'intents-native'
          ? INTENTS_NATIVE_COUNTERPARTY
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

  // "Deposit $10 onto NEAR Intents." The agent names a chain, optionally a symbol, and an
  // amount. Everything that decides where the money ends up is resolved here from the app's
  // own state: the wallet it leaves, the account credited inside the verifier, the loss floor
  // and the counterparty. There is deliberately no argument for any of them.
  async function proposeIntentsDeposit(params: IntentsDepositParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];
    const from = ourAddress(params.chain, snapshot, problems);

    // Default to the chain's gas asset, because that is what a bare "deposit $10 from
    // ethereum" means and it is the case the ERC-20 path could not serve.
    const native = NATIVE_ASSET[params.chain];
    const symbol = params.symbol ?? native?.symbol ?? '';
    if (symbol === '') {
      problems.push(`No default asset for ${params.chain}, so the deposit has to name a symbol.`);
    }
    const tokenId = native !== undefined && symbol === native.symbol ? NATIVE_TOKEN_ID : symbol;

    // The verifier derives an account id from the erc191 signer, and that id is the EVM
    // address lowercased. Credit anything else and the balance is real but unspendable by
    // this app, so it is derived here and never taken from a caller.
    const intentsAccount = from.toLowerCase();

    const draft: IntentsDepositDraft = {
      kind: 'intents_deposit',
      chain: params.chain,
      symbol,
      tokenId,
      amount: params.amount,
      amountUsd: usdOf(symbol, params.amount, snapshot),
      minCredited: minCreditedFor(params.amount),
      from,
      intentsAccount,
      counterparty: INTENTS_DEPOSIT_COUNTERPARTY,
    };

    return problems.length > 0
      ? refuseDraft('intents_deposit', draft, problems)
      : proposeRail('intents_deposit', draft);
  }

  async function proposeIntentsWithdraw(params: IntentsWithdrawParams): Promise<Proposal> {
    const snapshot = ledger.snapshot();
    const problems: string[] = [];

    // The account whose balance is spent inside the verifier. Derived the same way the deposit
    // rail credits it, from our own EVM address lowercased, so a deposit and the withdrawal
    // that undoes it name the same account by construction. 'eth' only picks which chain's
    // address row to read; the three EVM chains share one address.
    const from = ourAddress('eth', snapshot, problems).toLowerCase();

    // Where it lands. Read from config here and again inside the rail, which refuses a draft
    // naming anything else. There is no argument that can reach this.
    const to = ourWalletOn(params.chain, cfg.addresses) ?? '';
    if (!WITHDRAW_DESTINATIONS.includes(params.chain)) {
      problems.push(
        `Withdrawals go to ${WITHDRAW_DESTINATIONS.join(', ')} only. A NEAR payout would go to an account id ` +
          'nobody signed for.',
      );
    } else if (to === '') {
      problems.push(`No ${params.chain} address is configured, so there is no wallet of ours to withdraw to.`);
    }

    const native = NATIVE_ASSET[params.chain];
    const symbol = params.symbol ?? native?.symbol ?? '';
    if (symbol === '') {
      problems.push(`No default asset for ${params.chain}, so the withdrawal has to name a symbol.`);
    }

    // What the verifier actually holds, from the same read the wallet panel shows. A withdrawal
    // for more than that gets signed, submitted and rejected by the contract: no money is lost,
    // but the human learns nothing, so naming the number here is worth doing.
    //
    // It refuses only where it is CERTAIN, and that restraint is the point. The symbol and the
    // chain on an intents holding are labels looked up in the 1Click token list, and
    // src/ledger/intents.ts degrades them to the raw asset id at zero decimals when that list
    // momentarily fails to load, which it does (seen live 2026-08-13). Keying a refusal on a
    // label that can degrade would silently block every withdrawal whenever a remote list
    // blipped, which is a worse failure than the one this check prevents. So: an empty verifier
    // is unambiguous and refuses, a positively identified balance that is too small refuses and
    // names itself, and anything else says nothing and lets the contract answer.
    const read = ledger.intents();
    if (read !== undefined && read.ok) {
      if (read.holdings.length === 0) {
        problems.push(`intents.near holds nothing for ${from}, so there is nothing to withdraw.`);
      } else {
        const held = read.holdings.find((h) => h.symbol === symbol && h.originChain === params.chain);
        if (held !== undefined && held.amount < params.amount) {
          problems.push(
            `intents.near holds ${held.amount} ${symbol} from ${params.chain} for ${from}, which is less than ` +
              `the ${params.amount} this would withdraw.`,
          );
        }
      }
    }

    const draft: IntentsWithdrawDraft = {
      kind: 'intents_withdraw',
      chain: params.chain,
      symbol,
      amount: params.amount,
      amountUsd: usdOf(symbol, params.amount, snapshot),
      minReceived: minReceivedFor(params.amount),
      from,
      to,
      counterparty: INTENTS_WITHDRAW_COUNTERPARTY,
    };

    return problems.length > 0
      ? refuseDraft('intents_withdraw', draft, problems)
      : proposeRail('intents_withdraw', draft);
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
      // Everything that moved funds OR is moving them right now, which is every kind except
      // a policy change. Written as an exclusion so a rail added later counts against the
      // session cap by default: an inclusion list would leave the new kind silently
      // unbudgeted.
      //
      // 'executing' counts, and that is the whole fix. Counting only 'executed' meant a
      // proposal was invisible to the cap for the entire duration of an on-chain send, and
      // nothing serialises proposal handling: node:http runs them concurrently and there is
      // no queue anywhere. So N proposals arriving together each evaluated against a spend
      // of 0 and all N executed. Demonstrated: five concurrent $10,000 consolidations moved
      // $50,000 against a $25,000 session cap, and the window's width tracks send latency,
      // so a slower chain is a wider hole.
      //
      // Committed-but-unconfirmed money is spent for budgeting purposes. Over-counting a
      // send that later fails costs a refusal the human can retry; under-counting one that
      // succeeds costs the cap itself.
      .filter(p => (p.status === 'executed' || p.status === 'executing') && p.kind !== 'policy_change')
      .filter(p => {
        const at = Date.parse(p.decidedAt ?? p.createdAt);
        return Number.isFinite(at) && at >= cutoff;
      })
      .reduce((sum, p) => sum + totalUsdOf(p.draft), 0);
  }

  // Every path that can spend runs one at a time.
  //
  // Counting 'executing' against the session cap is necessary but not sufficient on its own:
  // a proposal is only marked executing after it has already been evaluated, so two arriving
  // together could both read the same spend figure and both be allowed before either
  // reserved anything. node:http handles requests concurrently and nothing else in this
  // process serialises them, so that window was real. Demonstrated before this existed:
  // five concurrent $10,000 consolidations moved $50,000 against a $25,000 cap.
  //
  // A promise chain is the whole mechanism. It makes "read the spend, decide, reserve" one
  // indivisible step, which is what a budget needs to mean anything. Throughput is not a
  // concern here: these operations end in a chain send, a human click, or both.
  let chain: Promise<unknown> = Promise.resolve();
  function serialise<T>(fn: () => Promise<T>): Promise<T> {
    // Both arms run fn, so one rejection does not wedge the queue for everything after it.
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    proposeConsolidate: (p) => serialise(() => proposeConsolidate(p)),
    proposePolicyChange: (p) => serialise(() => proposePolicyChange(p)),
    proposeSwap: (p) => serialise(() => proposeSwap(p)),
    proposeHlDeposit: (p) => serialise(() => proposeHlDeposit(p)),
    proposeIntentsDeposit: (p) => serialise(() => proposeIntentsDeposit(p)),
    proposeIntentsWithdraw: (p) => serialise(() => proposeIntentsWithdraw(p)),
    proposeLpAdd: (p) => serialise(() => proposeLpAdd(p)),
    proposeLpRemove: (p) => serialise(() => proposeLpRemove(p)),
    // approve() executes, so it shares the queue: a human click landing next to an
    // auto-approval must not be able to double-spend the cap either.
    approve: (id: string) => serialise(() => approve(id)),
    refuse,
    get: (id: string) => store.get(id),
    list: () => store.list(),
    sessionSpentUsd,
  };
}
