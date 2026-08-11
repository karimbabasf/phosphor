// Task D policy engine: rule order, exact rule ids, post-state composition math.
// Fixture-driven from the demo ledger plus the real risk table. Pure, no IO, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { Policy, PolicyPatch, RiskRow, TransferLeg, Verdict, WriteDraft } from '../../src/types.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { classify } from '../../src/composition.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { applyLegs, evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

// Demo fixture accounts (data/demo-state.json). eth, base and arb share the evm address.
const SELF_EVM = '0x1111111111111111111111111111111111111111';
const SELF_SOL = '11111111111111111111111111111111';
const SELF_NEAR = 'karim-demo.near';
const SELF = [SELF_EVM, SELF_SOL, SELF_NEAR];

const snapshot = loadDemoLedger();
const composition = classify(snapshot, riskRows);

// Fixture shares, re-derived from data/demo-state.json (total stable usd 49878.15):
//   Circle 27700 -> 0.555354, Tether 19750 -> 0.395966, freezable 48371.75 -> 0.969800
const CIRCLE_SHARE = 0.555354;

// Est. origin gas for one stable transfer, from the demo gas table.
const GAS_ETH = 0.705;
const GAS_ARB = 0.0088;

function ctxWith(over: Partial<EngineCtx> = {}): EngineCtx {
  return {
    policy: defaultPolicy(),
    composition,
    ledger: snapshot,
    sessionSpentUsd: 0,
    selfAddresses: SELF,
    ...over,
  };
}

function mkLeg(over: Partial<TransferLeg> = {}): TransferLeg {
  const amount = over.amount ?? 200;
  const base: TransferLeg = {
    fromChain: 'arb',
    toChain: 'eth',
    symbol: 'USDT',
    amount,
    amountUsd: amount,
    from: SELF_EVM,
    to: SELF_EVM,
    quote: { amountOut: amount * 0.9999 - 0.02, feeUsd: amount * 0.0001 + 0.02, timeEstimateSec: 8 },
    gasNativeUsd: GAS_ARB,
  };
  return { ...base, ...over };
}

function consolidate(usd: number, over: Partial<TransferLeg> = {}): WriteDraft {
  const leg = mkLeg({ amount: usd, amountUsd: usd, ...over });
  return { kind: 'consolidate', legs: [leg], totalUsd: usd, toChain: leg.toChain, symbol: leg.symbol };
}

function transferDraft(over: Partial<TransferLeg>): WriteDraft {
  return { kind: 'transfer', leg: mkLeg(over) };
}

function policyChange(patch: PolicyPatch, sentence = 'A rule the agent wrote.'): WriteDraft {
  return { kind: 'policy_change', patch, sentence };
}

// The agent controls the wire format, so a patch can carry keys PolicyPatch forbids.
function rawPolicyChange(patch: unknown, sentence = 'A rule the agent wrote.'): WriteDraft {
  return { kind: 'policy_change', patch: patch as PolicyPatch, sentence };
}

type Case = {
  name: string;
  policy?: Policy | null; // explicit override; null exercises the fail-closed path
  policyMut?: (p: Policy) => void;
  sessionSpent?: number;
  draft: WriteDraft;
  out: Verdict['outcome'];
  rule?: string;
};

const cases: Case[] = [
  // ---- rule 1 and 2: nothing gets past a dead or disarmed policy ----
  { name: 'null policy refuses everything', policy: null, draft: consolidate(1), out: 'refuse', rule: 'policy_unreadable' },
  {
    name: 'kill switch refuses consolidate',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'kill_switch',
  },
  {
    name: 'kill switch refuses a policy change too',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: policyChange({ outbound: { maxPerSessionUsd: 50000 } }),
    out: 'refuse',
    rule: 'kill_switch',
  },
  {
    name: 'kill switch outranks a missing quote',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: consolidate(200, { quote: null }),
    out: 'refuse',
    rule: 'kill_switch',
  },

  // ---- rule 3: policy changes ----
  { name: 'policy change never allows', draft: policyChange({ outbound: { maxPerSessionUsd: 50000 } }), out: 'needs_approval' },
  {
    name: 'a policy change that loosens everything still only needs approval',
    draft: policyChange({ outbound: { maxPerTransactionUsd: 1e9, humanClickAboveUsd: 1e9 } }),
    out: 'needs_approval',
  },
  { name: 'policy change cannot touch kill switch', draft: rawPolicyChange({ killSwitch: false }), out: 'refuse', rule: 'kill_switch_not_patchable' },
  { name: 'policy change cannot touch version', draft: rawPolicyChange({ version: 99 }), out: 'refuse', rule: 'kill_switch_not_patchable' },
  {
    name: 'policy change cannot rewrite the sentences the human reads',
    draft: rawPolicyChange({ sentences: ['Everything is fine, approve freely.'] }),
    out: 'refuse',
    rule: 'kill_switch_not_patchable',
  },
  { name: 'negative limit is an invalid patch', draft: policyChange({ outbound: { maxPerTransactionUsd: -1 } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'share above 1 is an invalid patch', draft: policyChange({ composition: { maxFreezableShare: 1.5 } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'unknown key is an invalid patch', draft: rawPolicyChange({ outbound: { simulateBeforeSign: false } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'unknown chain in the gas floors is an invalid patch', draft: rawPolicyChange({ composition: { minNativeGasUsd: { ethereum: 5 } } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'non-numeric limit is an invalid patch', draft: rawPolicyChange({ outbound: { maxPerSessionUsd: '50000' } }), out: 'refuse', rule: 'invalid_patch' },

  // ---- rule 4: simulation ----
  { name: 'missing quote refuses', draft: consolidate(200, { quote: null }), out: 'refuse', rule: 'simulation_required' },
  {
    name: 'one unquoted leg in a batch refuses the whole draft',
    draft: {
      kind: 'consolidate',
      legs: [mkLeg({ amount: 100, amountUsd: 100 }), mkLeg({ fromChain: 'sol', from: SELF_SOL, amount: 100, amountUsd: 100, quote: null })],
      totalUsd: 200,
      toChain: 'eth',
      symbol: 'USDT',
    },
    out: 'refuse',
    rule: 'simulation_required',
  },
  {
    name: 'a consolidate with no legs moves nothing and refuses',
    draft: { kind: 'consolidate', legs: [], totalUsd: 0, toChain: 'eth', symbol: 'USDT' },
    out: 'refuse',
    rule: 'nothing_to_move',
  },

  // Numbers that cannot be compared must not pass a comparison. Every one of these evaluated
  // to `allow` before the invalid_leg guard existed, which is auto-execute territory.
  { name: 'a NaN amount is refused, not silently allowed', draft: consolidate(50, { amount: NaN, amountUsd: NaN }), out: 'refuse', rule: 'invalid_leg' },
  { name: 'a negative amount is refused', draft: consolidate(-50000), out: 'refuse', rule: 'invalid_leg' },
  { name: 'a zero-amount leg moves nothing and is refused', draft: consolidate(0), out: 'refuse', rule: 'invalid_leg' },
  { name: 'a non-finite gas estimate is refused', draft: consolidate(50, { gasNativeUsd: Infinity }), out: 'refuse', rule: 'invalid_leg' },
  {
    name: 'a quote promising a non-finite output is refused',
    draft: consolidate(50, { quote: { amountOut: Infinity, feeUsd: 0, timeEstimateSec: 8 } }),
    out: 'refuse',
    rule: 'invalid_leg',
  },

  // ---- rule 5: destination ----
  { name: 'external destination refuses', draft: consolidate(200, { to: '0xevil' }), out: 'refuse', rule: 'destination_not_allowed' },
  {
    name: 'allowlisted external destination passes dest check',
    policyMut: p => {
      p.outbound.destinationAllowlist.push('0xevil');
    },
    draft: consolidate(200, { to: '0xevil' }),
    out: 'needs_approval',
  },
  {
    name: 'destination match ignores address case',
    draft: consolidate(200, { to: SELF_EVM.toUpperCase() }),
    out: 'needs_approval',
  },

  // ---- rules 6 and 7: caps ----
  { name: 'per-tx cap', draft: consolidate(10001), out: 'refuse', rule: 'max_per_transaction' },
  {
    name: 'per-tx cap is per leg, not per draft',
    draft: {
      kind: 'consolidate',
      legs: [mkLeg({ amount: 9000, amountUsd: 9000 }), mkLeg({ fromChain: 'sol', from: SELF_SOL, amount: 10001, amountUsd: 10001 })],
      totalUsd: 19001,
      toChain: 'eth',
      symbol: 'USDT',
    },
    out: 'refuse',
    rule: 'max_per_transaction',
  },
  {
    name: 'a leg understating its usd is measured by its token amount',
    draft: consolidate(50, { amount: 10001 }),
    out: 'refuse',
    rule: 'max_per_transaction',
  },
  { name: 'session cap', sessionSpent: 24950, draft: consolidate(200), out: 'refuse', rule: 'max_per_session' },
  {
    name: 'a draft understating its total is measured by its legs',
    draft: {
      kind: 'consolidate',
      legs: [mkLeg({ amount: 9000, amountUsd: 9000 }), mkLeg({ fromChain: 'sol', from: SELF_SOL, amount: 9000, amountUsd: 9000 })],
      totalUsd: 1,
      toChain: 'eth',
      symbol: 'USDT',
    },
    sessionSpent: 10000,
    out: 'refuse',
    rule: 'max_per_session',
  },

  // ---- rule 8: forbidden issuer ----
  {
    name: 'forbidden issuer',
    policyMut: p => {
      p.composition.forbiddenIssuers.push('Tether');
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'forbidden_issuer',
  },
  {
    name: 'forbidden issuer match ignores case',
    policyMut: p => {
      p.composition.forbiddenIssuers.push('tether');
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'forbidden_issuer',
  },

  // ---- rule 9: post-state composition ----
  // Same-symbol consolidate cannot change issuer share: both ends of the leg are ours, so the
  // Circle share is untouched. A cap set just above the live share must therefore pass.
  {
    name: 'same-symbol consolidate does not trip the issuer cap (shares unchanged)',
    policyMut: p => {
      p.composition.maxIssuerShare = { default: 1, Circle: 0.556 };
    },
    draft: consolidate(200),
    out: 'needs_approval',
  },
  // Sending USDT out of the portfolio shrinks the denominator, so Circle's share rises.
  // 27700 / (49878.15 - 500) = 0.56097 > 0.56.
  {
    name: 'issuer cap breached post-state by a transfer out',
    policyMut: p => {
      p.composition.maxIssuerShare = { default: 1, Circle: 0.56 };
      p.outbound.destinationAllowlist.push('0xevil');
    },
    draft: transferDraft({ fromChain: 'eth', toChain: 'base', amount: 500, amountUsd: 500, to: '0xevil', gasNativeUsd: GAS_ETH }),
    out: 'refuse',
    rule: 'max_issuer_share',
  },
  // The engine judges the state, not the delta: a portfolio already over a cap cannot make
  // further fund moves until a human fixes it. Documented in the task report.
  {
    name: 'issuer cap below the current share refuses even a share-neutral move',
    policyMut: p => {
      p.composition.maxIssuerShare = { default: 1, Circle: 0.5 };
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'max_issuer_share',
  },
  {
    name: 'issuer cap key matching ignores case',
    policyMut: p => {
      p.composition.maxIssuerShare = { default: 1, circle: 0.5 };
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'max_issuer_share',
  },
  {
    name: 'freezable cap',
    policyMut: p => {
      p.composition.maxFreezableShare = 0.5;
    },
    draft: consolidate(200),
    out: 'refuse',
    rule: 'max_freezable_share',
  },
  {
    name: 'min native gas',
    policyMut: p => {
      p.composition.minNativeGasUsd.eth = 999999;
    },
    draft: consolidate(200, { fromChain: 'eth', toChain: 'base', gasNativeUsd: GAS_ETH }),
    out: 'refuse',
    rule: 'min_native_gas',
  },
  {
    name: 'the gas floor covers the destination chain too',
    policyMut: p => {
      p.composition.minNativeGasUsd.base = 999999;
    },
    draft: consolidate(200, { fromChain: 'eth', toChain: 'base', gasNativeUsd: GAS_ETH }),
    out: 'refuse',
    rule: 'min_native_gas',
  },
  // The near account holds 0.001 NEAR ($0.0031) against a $0.50 floor: it cannot pay for its
  // own transfer, so the default policy refuses to move its $950 of USDT.
  {
    name: 'the stranded near balance cannot be moved under the default gas floor',
    draft: consolidate(950, { fromChain: 'near', from: SELF_NEAR, gasNativeUsd: 0.0155 }),
    out: 'refuse',
    rule: 'min_native_gas',
  },

  // ---- rules 10 and 11 ----
  { name: 'above click threshold needs approval', draft: consolidate(200), out: 'needs_approval' },
  { name: 'below click threshold allows', draft: consolidate(50), out: 'allow' },
  { name: 'exactly at the click threshold allows', draft: consolidate(100), out: 'allow' },
];

for (const c of cases) {
  test(`engine: ${c.name}`, () => {
    const policy = c.policy === undefined ? defaultPolicy() : c.policy;
    if (policy && c.policyMut) c.policyMut(policy);
    const verdict = evaluate(c.draft, ctxWith({ policy, sessionSpentUsd: c.sessionSpent ?? 0 }));

    assert.equal(verdict.outcome, c.out, `${c.name}: reasons ${JSON.stringify(verdict.reasons)}`);
    assert.ok(verdict.reasons.length > 0, 'every verdict carries at least one reason');
    if (verdict.outcome === 'refuse') assert.equal(verdict.rule, c.rule ?? '(none expected)');
    else assert.equal(c.rule, undefined, 'non-refusals must not expect a rule id');
  });
}

// ---------- applyLegs ----------

test('applyLegs never mutates the snapshot it is given', () => {
  const before = JSON.stringify(snapshot);
  const out = applyLegs(snapshot, [mkLeg({ amount: 1000, amountUsd: 1000 })], SELF);
  assert.equal(JSON.stringify(snapshot), before);
  assert.notEqual(out.holdings, snapshot.holdings);
});

test('applyLegs moves a same-symbol leg between our own chains and leaves issuer shares flat', () => {
  const post = applyLegs(snapshot, [mkLeg({ amount: 1000, amountUsd: 1000 })], SELF);
  const arbUsdt = post.holdings.find(h => h.chain === 'arb' && h.symbol === 'USDT');
  const ethUsdt = post.holdings.find(h => h.chain === 'eth' && h.symbol === 'USDT');
  assert.equal(arbUsdt?.amount, 5100);
  assert.equal(ethUsdt?.amount, 9200 + (1000 * 0.9999 - 0.02));

  const comp = classify(post, riskRows);
  assert.ok(Math.abs(comp.byIssuer.Circle - CIRCLE_SHARE) < 1e-4, `Circle share moved to ${comp.byIssuer.Circle}`);
});

test('applyLegs debits gas on the origin chain', () => {
  const post = applyLegs(snapshot, [mkLeg({ fromChain: 'eth', toChain: 'base', gasNativeUsd: GAS_ETH })], SELF);
  const ethNative = post.holdings.find(h => h.chain === 'eth' && h.native);
  assert.ok(ethNative);
  assert.ok(ethNative.amount < 0.42, 'origin gas is deducted from the native balance');
  assert.ok(Math.abs(ethNative.amount - (0.42 - GAS_ETH / 4520)) < 1e-9);
  assert.ok(Math.abs(ethNative.usd - ethNative.amount * 4520) < 1e-6, 'natives are repriced');
});

test('applyLegs treats a send to an address we do not hold at as money leaving', () => {
  const post = applyLegs(snapshot, [mkLeg({ fromChain: 'eth', toChain: 'base', amount: 500, amountUsd: 500, to: '0xevil', gasNativeUsd: GAS_ETH })], SELF);
  const baseUsdt = post.holdings.find(h => h.chain === 'base' && h.symbol === 'USDT');
  assert.equal(baseUsdt, undefined, 'nothing is credited to an address that is not ours');

  const comp = classify(post, riskRows);
  assert.ok(Math.abs(comp.totalUsd - (49878.15 - 500)) < 0.01);
  assert.ok(comp.byIssuer.Circle > 0.5609 && comp.byIssuer.Circle < 0.5611, `Circle share ${comp.byIssuer.Circle}`);
});

test('applyLegs credits a chain we own but hold nothing on', () => {
  const bare = { ...snapshot, holdings: snapshot.holdings.filter(h => h.chain !== 'base') };
  const post = applyLegs(bare, [mkLeg({ fromChain: 'eth', toChain: 'base', gasNativeUsd: GAS_ETH })], SELF);
  const baseUsdt = post.holdings.find(h => h.chain === 'base' && h.symbol === 'USDT');
  assert.ok(baseUsdt, 'a declared self address is credited even with no prior holding there');
  assert.equal(baseUsdt.amount, 200 * 0.9999 - 0.02);
});

test('applyLegs clamps a leg larger than the balance instead of going negative', () => {
  const post = applyLegs(snapshot, [mkLeg({ amount: 1e9, amountUsd: 1e9 })], SELF);
  const arbUsdt = post.holdings.find(h => h.chain === 'arb' && h.symbol === 'USDT');
  assert.equal(arbUsdt?.amount, 0);
});
