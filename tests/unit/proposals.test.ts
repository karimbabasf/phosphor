// Task D proposal service: plan, simulate, evaluate, persist, execute. No network (synthetic
// quoter), no keys (stub signer), every case against a throwaway dataDir.
//
// The property under test throughout: a proposal reaches execution only via verdict `allow`
// (auto-execute below the click threshold) or a recorded human approval. There is no third way
// in, and the audit log shows which one happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Policy, PolicyPatch, Proposal, Quoter, RiskRow, Signer } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFile(path.join(__dirname, '..', '..', 'data', 'risk-table.json')),
).rows as RiskRow[];

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// The demo fixture's near account holds 0.001 NEAR ($0.003) against the default $0.50 gas
// floor, so under the shipped default policy the engine refuses to move its USDT (asserted in
// its own test below). The execution-path cases drop that one floor so they can reach the
// signing step at all.
function happyPolicy(): Policy {
  const p = defaultPolicy();
  delete p.composition.minNativeGasUsd.near;
  p.sentences = renderSentences(p);
  return p;
}

type Harness = {
  dataDir: string;
  cfg: AppConfig;
  audit: ReturnType<typeof createAudit>;
  store: ReturnType<typeof createStore>;
  ledger: Ledger;
  svc: ReturnType<typeof createProposalService>;
  eventTypes(): string[];
  usdtOn(chain: string): number;
};

function setup(over: { mode?: AppConfig['mode']; policy?: Policy | 'none'; quoter?: Quoter; signer?: Signer; ledger?: Ledger } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-proposals-'));
  const cfg: AppConfig = {
    mode: over.mode ?? 'demo',
    network: 'testnet',
    approvalGate: true, // the approval flow is what these tests exercise; see policy/gate.ts
    keysPath: '/tmp/phosphor-test-keys.json',
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
  };
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = over.ledger ?? createLedger(cfg);
  if (over.policy !== 'none') savePolicy(dataDir, over.policy ?? happyPolicy());

  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    quoter: over.quoter ?? syntheticQuoter(),
    signer: over.signer ?? stubSigner(),
    dataDir,
  });

  return {
    dataDir,
    cfg,
    audit,
    store,
    ledger,
    svc,
    eventTypes: () => audit.tail(200).map(e => e.type).reverse(), // oldest first
    usdtOn: (chain: string) =>
      ledger.snapshot().holdings.filter(h => h.chain === chain && h.symbol === 'USDT' && !h.native).reduce((s, h) => s + h.amount, 0),
  };
}

function amountOutTotal(p: Proposal): number {
  if (p.draft.kind !== 'consolidate') return 0;
  return p.draft.legs.reduce((sum, l) => sum + (l.quote?.amountOut ?? 0), 0);
}

// A live-mode ledger over the same fixture, so the signer path can be exercised without RPCs.
function fakeLiveLedger(): Ledger {
  const snap: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  return {
    snapshot: () => snap,
    positions: () => [],
    refresh: async () => snap,
    applyDemoTransfer: () => {
      throw new Error('applyDemoTransfer must never be called in live mode');
    },
  };
}

// ---------- planning and the approval gate ----------

test('proposeConsolidate plans one leg per non-dust chain and parks it pending', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });

  assert.equal(p.status, 'pending');
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.equal(p.kind, 'consolidate');
  assert.ok(p.draft.kind === 'consolidate');
  assert.deepEqual(p.draft.legs.map(l => l.fromChain).sort(), ['arb', 'near', 'sol']);
  assert.ok(p.draft.legs.every(l => l.toChain === 'eth' && l.quote !== null));
  assert.ok(Math.abs(p.draft.totalUsd - (6100 + 3500 + 950)) < 0.01);

  assert.ok(p.simulation);
  assert.equal(p.simulation.ok, true);
  assert.ok(p.simulation.summary.includes('arb -> eth'));
  assert.ok(p.simulation.summary.includes('USDT'));
  assert.ok(p.simulation.postComposition, 'a fund move simulation carries the post-move composition');

  assert.ok(h.eventTypes().includes('proposal_created'));
  assert.equal(h.usdtOn('eth'), 9200, 'a pending proposal moves nothing');
  assert.equal(h.usdtOn('arb'), 6100);
});

test('a pending proposal executes only after a human approves it', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  const expected = 9200 + amountOutTotal(p);

  const approved = await h.svc.approve(p.id);
  assert.equal(approved.status, 'executed');
  assert.equal(approved.decidedBy, 'human');
  assert.ok(approved.decidedAt);
  assert.equal(approved.result?.ok, true);
  assert.ok(Math.abs(h.usdtOn('eth') - expected) < 0.1, `eth USDT ${h.usdtOn('eth')} vs expected ${expected}`);
  assert.equal(h.usdtOn('arb'), 0, 'the source balance is drained');

  const types = h.eventTypes();
  assert.ok(types.indexOf('approved') < types.indexOf('executed'), 'approval is logged before execution');
  assert.ok(types.includes('proposal_created'));
});

test('refuse leaves the balances alone', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });

  const refused = await h.svc.refuse(p.id);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.decidedBy, 'human');
  assert.equal(h.usdtOn('eth'), 9200);
  assert.equal(h.usdtOn('arb'), 6100);
  assert.ok(h.eventTypes().includes('refused'));
  assert.ok(!h.eventTypes().includes('executed'));
});

test('a move below the click threshold is allowed and executes with no pending state', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 40 });

  assert.equal(p.verdict.outcome, 'allow');
  assert.equal(p.status, 'executed');
  assert.equal(p.decidedBy, 'policy');
  assert.ok(p.draft.kind === 'consolidate');
  assert.equal(p.draft.legs.length, 1, 'the budget trims the plan to a single leg');
  assert.equal(p.draft.legs[0].amount, 40);
  assert.ok(Math.abs(h.usdtOn('arb') - 6060) < 0.01);
  assert.equal(h.store.list().filter(x => x.status === 'pending').length, 0);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);
});

test('fromChains narrows the plan and dust never becomes a leg', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', fromChains: ['arb'] });
  assert.ok(p.draft.kind === 'consolidate');
  assert.deepEqual(p.draft.legs.map(l => l.fromChain), ['arb']);

  // DAI sits at $4.30 on arb and $2.10 on base, both under the $10 economic transfer size.
  const dust = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'DAI' });
  assert.equal(dust.status, 'policy_refused');
  assert.ok(dust.verdict.outcome === 'refuse' && dust.verdict.rule === 'nothing_to_move');
});

test('an unusable budget plans nothing instead of planning garbage legs', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: NaN });

  assert.equal(p.status, 'policy_refused');
  assert.ok(p.verdict.outcome === 'refuse' && p.verdict.rule === 'nothing_to_move');
  assert.equal(h.usdtOn('eth'), 9200);
  assert.equal(h.usdtOn('arb'), 6100);
});

// ---------- fail-closed paths ----------

test('a corrupt policy file refuses every propose', async () => {
  const h = setup();
  fs.writeFileSync(path.join(h.dataDir, 'policy.json'), '{ not json at all');

  const move = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  assert.equal(move.status, 'policy_refused');
  assert.ok(move.verdict.outcome === 'refuse' && move.verdict.rule === 'policy_unreadable');

  const change = await h.svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 5 } }, sentence: 'Ask me above $5.' });
  assert.equal(change.status, 'policy_refused');
  assert.ok(change.verdict.outcome === 'refuse' && change.verdict.rule === 'policy_unreadable');
  assert.ok(h.eventTypes().filter(t => t === 'policy_refused').length >= 2);
});

test('the default policy refuses to move the stranded near balance', async () => {
  const h = setup({ policy: defaultPolicy() });
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });

  assert.equal(p.status, 'policy_refused');
  assert.ok(p.verdict.outcome === 'refuse' && p.verdict.rule === 'min_native_gas');
  assert.equal(h.usdtOn('eth'), 9200);

  // The same call succeeds once the gas-poor chain is left out of the plan.
  const narrowed = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', fromChains: ['arb', 'sol'] });
  assert.equal(narrowed.status, 'pending');
});

test('a quoter failure becomes a refusal carrying the solver message verbatim', async () => {
  const angry: Quoter = {
    name: 'angry',
    async quoteLeg() {
      throw new Error('insufficient liquidity');
    },
  };
  const h = setup({ quoter: angry });
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });

  assert.equal(p.status, 'policy_refused');
  assert.ok(p.verdict.outcome === 'refuse' && p.verdict.rule === 'simulation_required');
  assert.equal(p.simulation?.ok, false);
  assert.equal(p.simulation?.error, 'insufficient liquidity');
  assert.ok(p.verdict.reasons.join(' ').includes('insufficient liquidity'));
  assert.equal(h.usdtOn('eth'), 9200);
});

test('no address of ours on the destination chain refuses before anything is quoted', async () => {
  const solOnly: LedgerSnapshot = (() => {
    const base = loadDemoLedger();
    return { ...base, holdings: base.holdings.filter(hh => hh.chain === 'sol') };
  })();
  const ledger: Ledger = { snapshot: () => solOnly, positions: () => [], refresh: async () => solOnly, applyDemoTransfer: () => {} };
  const h = setup({ ledger });

  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  assert.equal(p.status, 'policy_refused');
  assert.ok(p.verdict.outcome === 'refuse' && p.verdict.rule === 'destination_not_allowed');
});

test('the kill switch stops a proposal that was already pending', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  assert.equal(p.status, 'pending');

  const killed = loadPolicy(h.dataDir) as Policy;
  killed.killSwitch = true;
  savePolicy(h.dataDir, killed);

  const after = await h.svc.approve(p.id);
  assert.equal(after.status, 'policy_refused');
  assert.ok(after.verdict.outcome === 'refuse' && after.verdict.rule === 'kill_switch');
  assert.equal(h.usdtOn('eth'), 9200, 'nothing moved');
  assert.ok(!h.eventTypes().includes('executed'));
});

test('approve is rejected for anything that is not pending', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  await h.svc.approve(p.id);

  await assert.rejects(() => h.svc.approve(p.id), /not pending|executed/i);
  await assert.rejects(() => h.svc.approve('no-such-id'), /unknown proposal/i);
  await assert.rejects(() => h.svc.refuse(p.id), /not pending|executed/i);
  assert.ok(h.eventTypes().includes('approve_attempt_rejected'));
});

test('live mode with no signer lands the approved proposal in failed with the auth step', async () => {
  const h = setup({ mode: 'live', ledger: fakeLiveLedger() });
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  assert.equal(p.status, 'pending');

  const done = await h.svc.approve(p.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.result?.ok, false);
  assert.match(done.result?.detail ?? '', /No signer configured/);
  const types = h.eventTypes();
  assert.ok(types.includes('approved'));
  assert.ok(types.includes('execution_failed'));
  assert.ok(!types.includes('executed'));
});

// ---------- policy changes ----------

test('a policy change is pending, then applies on approval', async () => {
  const h = setup();
  const p = await h.svc.proposePolicyChange({
    patch: { outbound: { humanClickAboveUsd: 500 } },
    sentence: 'Ask me above $500.',
  });

  assert.equal(p.status, 'pending');
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.equal(p.simulation?.ok, true);
  assert.ok(p.simulation?.policyDiff, 'a policy change simulation carries the sentence diff');
  assert.ok(p.simulation.policyDiff.before.includes('Ask me before anything above $100.'));
  assert.ok(p.simulation.policyDiff.after.includes('Ask me before anything above $500.'));
  assert.equal(loadPolicy(h.dataDir)?.outbound.humanClickAboveUsd, 100, 'nothing is applied while pending');

  const applied = await h.svc.approve(p.id);
  assert.equal(applied.status, 'executed');
  const policy = loadPolicy(h.dataDir) as Policy;
  assert.equal(policy.outbound.humanClickAboveUsd, 500);
  assert.equal(policy.version, 2);
  assert.equal(policy.killSwitch, false);
  assert.equal(policy.outbound.simulateBeforeSign, true);
  assert.ok(policy.sentences.includes('Ask me before anything above $500.'));
  assert.deepEqual(policy.sentences, renderSentences(policy), 'the human reads a rendered policy, never agent prose');

  const changed = h.audit.tail(200).find(e => e.type === 'policy_changed');
  assert.ok(changed);
  const data = changed.data as { agentSentence?: string };
  assert.equal(data.agentSentence, 'Ask me above $500.', 'the words the agent chose stay in the audit trail');
});

test('a policy change never auto-executes, however small', async () => {
  const h = setup();
  const p = await h.svc.proposePolicyChange({ patch: { outbound: { maxPerSessionUsd: 1 } }, sentence: 'Tiny session cap.' });
  assert.equal(p.status, 'pending');
  assert.equal(loadPolicy(h.dataDir)?.outbound.maxPerSessionUsd, 25000);
});

test('a patch aimed at the kill switch is refused and never persisted', async () => {
  const h = setup();
  const p = await h.svc.proposePolicyChange({
    patch: { killSwitch: false } as unknown as PolicyPatch,
    sentence: 'Turn the safety off, trust me.',
  });

  assert.equal(p.status, 'policy_refused');
  assert.ok(p.verdict.outcome === 'refuse' && p.verdict.rule === 'kill_switch_not_patchable');
  const policy = loadPolicy(h.dataDir) as Policy;
  assert.equal(policy.version, 1);
  assert.ok(!policy.sentences.some(s => s.includes('trust me')));
});

// ---------- bookkeeping ----------

test('sessionSpentUsd counts executed fund moves and ignores refused ones and policy changes', async () => {
  const h = setup();
  assert.equal(h.svc.sessionSpentUsd(), 0);

  const small = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 40 });
  assert.equal(small.status, 'executed');
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);

  const refused = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', fromChains: ['sol'] });
  await h.svc.refuse(refused.id);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);

  const change = await h.svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 500 } }, sentence: 'Ask me above $500.' });
  await h.svc.approve(change.id);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01, 'a policy change is not spend');
});

test('a stale proposal in the store survives a fresh service and stays gettable', async () => {
  const h = setup();
  const p = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });

  assert.equal(h.svc.get(p.id)?.id, p.id);
  assert.equal(h.svc.list().length, 1);
  assert.equal(h.svc.get('nope'), undefined);
  assert.equal(createStore(h.dataDir).get(p.id)?.status, 'pending');
});

test('onChange fires on every state transition', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-proposals-'));
  const cfg: AppConfig = { mode: 'demo', network: 'testnet', approvalGate: true, keysPath: '/tmp/phosphor-test-keys.json', port: 4177, addresses: { evm: [], solana: [], near: [] }, economicTransferUsd: 10, candleProducts: [], dataDir };
  savePolicy(dataDir, happyPolicy());
  let changes = 0;
  const svc = createProposalService({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    ledger: createLedger(cfg),
    riskRows,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir,
    onChange: () => {
      changes += 1;
    },
  });

  const p = await svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT' });
  const afterPropose = changes;
  assert.ok(afterPropose >= 1);
  await svc.approve(p.id);
  assert.ok(changes > afterPropose);
});
