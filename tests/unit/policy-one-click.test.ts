// One approval sets what the human wants.
//
// Two rules used to stand in front of a policy change: no limit could loosen by more than ten
// times, and none could be raised from zero. Both were paying for a second read of a sentence
// the human had already read and clicked, because propose_policy_change never auto-executes at
// any size. Going from the $1 the app ships with to $100 took two approvals of one decision.
//
// What is left is the rule about the two numbers making sense together, and it now fires in
// both directions: the ask can never be above the cap, and a cap coming down under the ask
// brings the ask with it rather than being refused for tightening.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clampPatch, evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import type { Policy, PolicyPatch, Verdict, WriteDraft } from '../../src/types.ts';

function policyWith(over: Partial<Policy['outbound']>): Policy {
  const p = defaultPolicy();
  p.outbound = { ...p.outbound, ...over };
  return p;
}

function ctxOf(policy: Policy): EngineCtx {
  return {
    policy,
    composition: { rows: [], totalUsd: 0, byIssuer: {}, freezableShare: 0, unclassified: [] },
    sessionSpentUsd: 0,
    selfAddresses: [],
  };
}

function change(patch: PolicyPatch, sentence = 'Change my limits.'): WriteDraft {
  return { kind: 'policy_change', patch, sentence };
}

function verdictOf(policy: Policy, patch: PolicyPatch): Verdict {
  return evaluate(change(patch), ctxOf(policy));
}

test('one dollar to a hundred lands in one patch, with no refusal and no staircase', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 100 } });
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.reasonCodes, []);
  assert.equal(verdict.reasons.some((r) => /times/.test(r)), false, 'no raise-factor sentence survives');
});

test('a limit raised from zero is a patch like any other now', () => {
  const policy = policyWith({ humanClickAboveUsd: 0, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 50 } });
  assert.equal(verdict.outcome, 'needs_approval');
});

test('an ask above the cap is still refused, because nothing would ever wait for anybody', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 5000 } });
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'click_threshold_above_cap');
  assert.deepEqual(verdict.reasonCodes, ['click_threshold_above_cap']);
  assert.match(verdict.reasons.join(' '), /nothing would ever wait for you/);
});

test('raising both in one patch is coherent and lands', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 5000, maxPerTransactionUsd: 10000 } });
  assert.equal(verdict.outcome, 'needs_approval');
});

test('a cap lowered under the ask clamps the ask and says so in a code', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { maxPerTransactionUsd: 50 } });
  assert.equal(verdict.outcome, 'needs_approval', 'refusing a tightening fails in the wrong direction');
  assert.deepEqual(verdict.reasonCodes, ['threshold_clamped_to_cap']);
  assert.match(verdict.reasons.join(' '), /ask threshold comes down with it/);

  // The clamp is the patch that gets stored and applied, not a sentence beside it.
  const clamped = clampPatch({ outbound: { maxPerTransactionUsd: 50 } }, policy);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.patch.outbound?.humanClickAboveUsd, 50);
  assert.equal(clamped.patch.outbound?.maxPerTransactionUsd, 50);
});

test('a cap lowered that stays above the ask changes nothing about the ask', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const out = clampPatch({ outbound: { maxPerTransactionUsd: 500 } }, policy);
  assert.equal(out.clamped, false);
  assert.equal(out.patch.outbound?.humanClickAboveUsd, undefined);
  assert.deepEqual(verdictOf(policy, { outbound: { maxPerTransactionUsd: 500 } }).reasonCodes, []);
});

test('a patch naming both, with the ask above the new cap, is clamped rather than refused', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const out = clampPatch({ outbound: { maxPerTransactionUsd: 200, humanClickAboveUsd: 900 } }, policy);
  assert.equal(out.clamped, true);
  assert.equal(out.patch.outbound?.humanClickAboveUsd, 200);
});

test('the kill switch, the version and the sentences are still unreachable from a patch', () => {
  const policy = policyWith({});
  for (const field of ['killSwitch', 'version', 'sentences']) {
    const verdict = evaluate(change({ [field]: true } as unknown as PolicyPatch), ctxOf(policy));
    assert.equal(verdict.outcome, 'refuse', field);
    assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'kill_switch_not_patchable');
  }
});

test('an allowlist that drops an address is still refused, and its code says which rule', () => {
  const policy = policyWith({ destinationAllowlist: ['0xaaa', '0xbbb'] });
  const verdict = verdictOf(policy, { outbound: { destinationAllowlist: ['0xaaa'] } });
  assert.equal(verdict.outcome, 'refuse');
  assert.deepEqual(verdict.reasonCodes, ['allowlist_shortened']);
});

test('a policy change still always waits for a click', () => {
  const policy = policyWith({ humanClickAboveUsd: 1_000_000, maxPerTransactionUsd: 1_000_000 });
  assert.equal(verdictOf(policy, { outbound: { maxPerSessionUsd: 25 } }).outcome, 'needs_approval');
});
