// One approval sets what the human wants.
//
// Two rules used to stand in front of a policy change: no limit could loosen by more than ten
// times, and none could be raised from zero. Both were paying for a second read of a sentence
// the human had already read and clicked, because propose_policy_change never auto-executes at
// any size. Going from the $1 the app ships with to $100 took two approvals of one decision.
//
// What is left is the rule about the two numbers making sense together, read off the pair the
// patch would LEAVE in the file: the ask has to end up strictly under the cap, whichever axis
// the patch names and whichever way each one moved, or nothing would ever ask. A patch that
// would collide is refused rather than rewritten, because a patch nobody wrote is a patch
// nobody clicked; the pair goes in one patch, which is still one click.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AXIS_CEILING_USD, evaluate } from '../../src/policy/engine.ts';
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

/* The sentence names every figure the patch moves, built from the patch, because the engine
   refuses one that does not (sentence_mismatch, its own tests below). Every other row here is
   about a different rule and should not be tripping over this one. */
function saying(patch: PolicyPatch): string {
  const figures = Object.values(patch.outbound ?? {})
    .filter((v): v is number => typeof v === 'number')
    .map((v) => `$${v}`);
  return figures.length === 0 ? 'Change my limits.' : `Change my limits to ${figures.join(', ')}.`;
}

function change(patch: PolicyPatch, sentence?: string): WriteDraft {
  return { kind: 'policy_change', patch, sentence: sentence ?? saying(patch) };
}

function verdictOf(policy: Policy, patch: PolicyPatch): Verdict {
  return evaluate(change(patch), ctxOf(policy));
}

test('one dollar to a hundred lands in one patch, with no refusal and no staircase', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 100 } });
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.reasonCodes, ['limits_changed']);
  assert.deepEqual(verdict.outcome === 'needs_approval' && verdict.changes, [
    { axis: 'humanClickAboveUsd', before: 1, after: 100, factor: 100 },
  ]);
  assert.equal(verdict.reasons.some((r) => /times/.test(r)), false, 'no raise-factor sentence survives');
});

test('a limit raised from zero is a patch like any other now', () => {
  const policy = policyWith({ humanClickAboveUsd: 0, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 50 } });
  assert.equal(verdict.outcome, 'needs_approval');
});

test('an ask above the cap is refused, because nothing would ever ask anybody', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 5000 } });
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'never_asks');
  assert.deepEqual(verdict.reasonCodes, ['never_asks']);
  assert.match(verdict.reasons.join(' '), /means nothing ever asks you/);
});

test('raising both in one patch is coherent and lands', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { humanClickAboveUsd: 5000, maxPerTransactionUsd: 10000 } });
  assert.equal(verdict.outcome, 'needs_approval');
});

test('a cap lowered under the ask is refused, and the refusal names both numbers and the fix', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { maxPerTransactionUsd: 50 } });
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'never_asks');
  assert.deepEqual(verdict.reasonCodes, ['never_asks']);
  const said = verdict.reasons.join(' ');
  assert.match(said, /Asking above \$100\.00 and refusing above \$50\.00/);
  assert.match(said, /Put the ask below the cap, both in the same patch/);
});

test('the patch the agent wrote is the patch that is judged, never one the app rewrote', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  // Both numbers, coherent: this is the shape the refusal above tells the agent to send.
  assert.equal(verdictOf(policy, { outbound: { maxPerTransactionUsd: 50, humanClickAboveUsd: 25 } }).outcome, 'needs_approval');
});

test('a cap lowered that stays above the ask is an ordinary tightening', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, { outbound: { maxPerTransactionUsd: 500 } });
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.reasonCodes, ['limits_changed']);
  assert.deepEqual(verdict.outcome === 'needs_approval' && verdict.changes, [
    { axis: 'maxPerTransactionUsd', before: 1000, after: 500, factor: 0.5 },
  ]);
});

test('the pair is read off the post-patch policy, whichever axis the patch names', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  // Raising the ask to meet an untouched cap collides.
  assert.equal(verdictOf(policy, { outbound: { humanClickAboveUsd: 1000 } }).outcome, 'refuse');
  // Equal is a collision: at cap == ask the middle band is empty.
  assert.equal(verdictOf(policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000 }), { outbound: { maxPerTransactionUsd: 1 } }).outcome, 'refuse');
  // One below it is not.
  assert.equal(verdictOf(policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000 }), { outbound: { maxPerTransactionUsd: 2 } }).outcome, 'needs_approval');
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
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  assert.equal(verdictOf(policy, { outbound: { maxPerSessionUsd: 25 } }).outcome, 'needs_approval');
});

/* A policy already in the collided state refuses every patch until the pair is fixed, including
   one that names neither number. That is the rule doing its job rather than a gap in it: a file
   where nothing ever asks is the state this refuses to leave in place, and the sentence names
   both numbers and the fix, so the way out is always one patch away. */
test('a policy that already collides refuses any patch until the pair is fixed', () => {
  const stuck = policyWith({ humanClickAboveUsd: 1000, maxPerTransactionUsd: 1000 });
  const unrelated = verdictOf(stuck, { outbound: { maxPerSessionUsd: 25 } });
  assert.equal(unrelated.outcome, 'refuse');
  assert.deepEqual(unrelated.reasonCodes, ['never_asks']);
  // And the way out is one patch that puts the ask under the cap.
  assert.equal(verdictOf(stuck, { outbound: { humanClickAboveUsd: 100 } }).outcome, 'needs_approval');
});

/* ---------- the ceiling no click can pass ----------

   Every other rule bounds a patch against the policy in force, so a determined sequence of
   clicks walks anywhere: each step looks small beside the one before it. The audit walked it in
   ONE step, with all four axes at Number.MAX_SAFE_INTEGER and the sentence "adjust the freezable
   cap", and a $5,000,000 swap went from refused to `allow` on a single click. */

test('an axis past its ceiling is refused, whatever else the patch is doing', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = verdictOf(policy, {
    outbound: {
      maxPerTransactionUsd: Number.MAX_SAFE_INTEGER,
      maxPerSessionUsd: Number.MAX_SAFE_INTEGER,
      humanClickAboveUsd: Number.MAX_SAFE_INTEGER,
      autoApproveDailyUsd: Number.MAX_SAFE_INTEGER,
    },
  });
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'above_ceiling');
  assert.deepEqual(verdict.reasonCodes, ['above_ceiling']);
  assert.match(verdict.reasons.join(' '), /a person edits policy\.json to go higher/);
});

test('each axis is bounded by its own ceiling, one dollar either side of it', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  for (const [axis, ceiling] of Object.entries(AXIS_CEILING_USD)) {
    const over = verdictOf(policy, { outbound: { [axis]: ceiling + 1 } as Record<string, number> });
    assert.equal(over.outcome, 'refuse', `${axis} at the ceiling plus one`);
    assert.equal(over.outcome === 'refuse' && over.rule, 'above_ceiling', axis);
  }
  // At the ceiling exactly, the cap is allowed through; the ask is then refused for colliding
  // with a cap it cannot exceed, which is the rule above doing its job rather than this one.
  assert.equal(verdictOf(policy, { outbound: { maxPerTransactionUsd: AXIS_CEILING_USD.maxPerTransactionUsd } }).outcome, 'needs_approval');
  assert.equal(verdictOf(policy, { outbound: { maxPerSessionUsd: AXIS_CEILING_USD.maxPerSessionUsd } }).outcome, 'needs_approval');
});

test('the ceiling holds the swap the audit walked through, before and after a click', () => {
  // The audit's exact path: one patch, one click, then a $5,000,000 swap reaching `allow`.
  const policy = policyWith({ maxPerTransactionUsd: 100, maxPerSessionUsd: 500, humanClickAboveUsd: 1, autoApproveDailyUsd: 50 });
  const verdict = verdictOf(policy, {
    outbound: { maxPerTransactionUsd: 9007199254740991, maxPerSessionUsd: 9007199254740991, humanClickAboveUsd: 9007199254740991, autoApproveDailyUsd: 9007199254740991 },
  });
  assert.equal(verdict.outcome, 'refuse', 'the patch that removed every wall in one click');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'above_ceiling');
});

/* ---------- the click on a lie ----------

   The card shows the agent's sentence and the file gets the agent's patch, and nothing held the
   two together: the audit carried "adjust the freezable cap" over a patch that set every money
   limit to nine quadrillion dollars. A person read a sentence about issuer exposure and would
   have clicked away every spending wall in the app. */

test('a sentence that does not name the figure it changes is refused', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100 });
  const verdict = evaluate(change({ outbound: { maxPerTransactionUsd: 900_000 } }, 'adjust the freezable cap'), ctxOf(policy));
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'sentence_mismatch');
  assert.deepEqual(verdict.reasonCodes, ['sentence_mismatch']);
  assert.match(verdict.reasons.join(' '), /maxPerTransactionUsd at \$900,000\.00/);
});

test('every changed axis has to be in the sentence, not just one of them', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100 });
  const half = evaluate(
    change({ outbound: { maxPerTransactionUsd: 5000, maxPerSessionUsd: 9000 } }, 'Refuse anything above $5000.'),
    ctxOf(policy),
  );
  assert.equal(half.outcome, 'refuse');
  assert.match(half.reasons.join(' '), /maxPerSessionUsd/);
  assert.doesNotMatch(half.reasons.join(' '), /maxPerTransactionUsd at/);

  const both = evaluate(
    change({ outbound: { maxPerTransactionUsd: 5000, maxPerSessionUsd: 9000 } }, 'Refuse anything above $5000, and $9000 in a day.'),
    ctxOf(policy),
  );
  assert.equal(both.outcome, 'needs_approval');
});

test('the figure is read past dollars, commas and cents, and not past a longer number', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100_000 });
  const patch = { outbound: { humanClickAboveUsd: 1000 } };
  for (const said of ['Ask me above $1,000.', 'Ask me above 1000.', 'Ask me above $1,000.00.', 'ask above $1000 please']) {
    assert.equal(evaluate(change(patch, said), ctxOf(policy)).outcome, 'needs_approval', said);
  }
  // A sentence naming a different number does not name this one, whatever digits it shares.
  for (const said of ['Ask me above $10,000.', 'Ask me above $100.', 'Ask me above $21000.']) {
    assert.equal(evaluate(change(patch, said), ctxOf(policy)).outcome, 'refuse', said);
  }
});

test('an accepted change carries the axes it moved, with the factor, for the card to print', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000, autoApproveDailyUsd: 0 });
  const verdict = evaluate(
    change({ outbound: { humanClickAboveUsd: 100, autoApproveDailyUsd: 500 } }, 'Ask me above $100, and stop at $500 a day.'),
    ctxOf(policy),
  );
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.reasonCodes, ['limits_changed']);
  assert.deepEqual(verdict.outcome === 'needs_approval' && verdict.changes, [
    { axis: 'humanClickAboveUsd', before: 1, after: 100, factor: 100 },
    // Every multiple of nothing is nothing, so a limit that was zero has no factor.
    { axis: 'autoApproveDailyUsd', before: 0, after: 500, factor: null },
  ]);
});

test('an axis named at the value it already has is not a change and needs no sentence', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = evaluate(change({ outbound: { humanClickAboveUsd: 100, maxPerSessionUsd: 9000 } }, 'Hold a day to $9000.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.outcome === 'needs_approval' && verdict.changes, [
    { axis: 'maxPerSessionUsd', before: 25000, after: 9000, factor: 0.36 },
  ]);
});

test('a patch that moves no money limit carries no limits_changed and needs no figure', () => {
  const policy = policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 });
  const verdict = evaluate(change({ composition: { maxFreezableShare: 0.5 } }, 'Cap the freezable share at half.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'needs_approval');
  assert.deepEqual(verdict.reasonCodes, []);
  assert.deepEqual(verdict.outcome === 'needs_approval' && verdict.changes, []);
});

/* ---------- the sentence is ABOUT the change, not merely touching its digits ----------

   `namesFigure` asks one question: does this string contain these digits anywhere. The re-audit
   walked five sentences past it, every one VERIFIED as needs_approval against a patch that took
   the cap to $1,000,000 and the ask to $999,999 from a wallet holding $100 and $1:

     1. the two axes swapped, so the reader agrees to the wrong number on each
     2. the figures used as the FROM side, so a 10,000x loosening reads as a tightening
     3. the figure pushed past three hundred spaces, off the end of the line a person reads
     4. the figure pushed past five newlines, same effect
     5. the figure written with zero-width characters through it, present to the regex, absent
        to the eye

   The digits were all there. None of those sentences describes the change. Three rules answer
   the three different lies: the sentence has to be one line a person can actually read, every
   dollar figure in it has to be a figure this patch is about, and where a clause names one axis
   the figures in it have to belong to that axis. */

const BIG = { outbound: { maxPerTransactionUsd: 1_000_000, humanClickAboveUsd: 999_999 } };
const SMALL = () => policyWith({ maxPerTransactionUsd: 100, humanClickAboveUsd: 1 });

function outcomeOf(sentence: string, patch: PolicyPatch = BIG, policy = SMALL()): Verdict {
  return evaluate(change(patch, sentence), ctxOf(policy));
}

test('the five sentences the re-audit walked past the figure check are refused', () => {
  const bypasses: Array<[string, string]> = [
    ['axes swapped', 'Raise the ask to $1,000,000 and the cap to $999,999.'],
    ['figures as the from side', 'Lower the cap from $1,000,000 to $100 and the ask from $999,999 to $1.'],
    ['buried past three hundred spaces', `Tidy the limits.${' '.repeat(300)}Cap $1,000,000, ask $999,999.`],
    ['buried past five newlines', 'Tidy the limits.\n\n\n\n\nCap $1,000,000, ask $999,999.'],
    ['written with zero-width characters', 'Cap $1,000,000​, ask $999,999​.​'],
  ];
  for (const [label, sentence] of bypasses) {
    const verdict = outcomeOf(sentence);
    assert.equal(verdict.outcome, 'refuse', label);
    assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'sentence_mismatch', label);
    assert.deepEqual(verdict.reasonCodes, ['sentence_mismatch'], label);
  }
});

test('the sentences a person would actually write still pass', () => {
  const ok: Array<[PolicyPatch, Policy, string]> = [
    [
      { outbound: { humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 } },
      policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 50 }),
      'Ask me above $100 and refuse anything above $1,000',
    ],
    [
      { outbound: { maxPerTransactionUsd: 1000 } },
      policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100 }),
      'Raise the cap from $100 to $1,000',
    ],
    [
      { outbound: { maxPerTransactionUsd: 100 } },
      policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 1000 }),
      'Lower the cap from $1,000 to $100',
    ],
    [
      { outbound: { humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 } },
      policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 50 }),
      'Change my limits to $100 and $1,000.',
    ],
    [
      { outbound: { humanClickAboveUsd: 250 } },
      policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100_000 }),
      'Ask me before anything above $250.00.',
    ],
    [
      { outbound: { maxPerSessionUsd: 9000, autoApproveDailyUsd: 500 } },
      policyWith({ humanClickAboveUsd: 100, maxPerTransactionUsd: 1000 }),
      'Hold a session to $9,000 and stop auto-approving past $500 a day.',
    ],
  ];
  for (const [patch, policy, sentence] of ok) {
    assert.equal(outcomeOf(sentence, patch, policy).outcome, 'needs_approval', sentence);
  }
});

test('a figure the patch is not about has no business in the sentence', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100 });
  const verdict = outcomeOf('Raise the cap to $1,000,000, a rounding error next to the $40,000,000 in the fund.', { outbound: { maxPerTransactionUsd: 1_000_000 } }, policy);
  assert.equal(verdict.outcome, 'refuse');
  assert.match(verdict.reasons.join(' '), /\$40,000,000/);
});

test('a raise written as a fall is refused: the after figure cannot come first', () => {
  const policy = policyWith({ humanClickAboveUsd: 1, maxPerTransactionUsd: 100 });
  const verdict = outcomeOf('Lower the cap from $1,000 to $100.', { outbound: { maxPerTransactionUsd: 1000 } }, policy);
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'sentence_mismatch');
});

/* ---------- the other two lists ----------

   mergePatch REPLACES maxIssuerShare and forbiddenIssuers wholesale, exactly as it replaces
   destinationAllowlist, and only the allowlist had a rule about it. So `{forbiddenIssuers: []}`
   erased every forbidden issuer and `{maxIssuerShare: {default: 1}}` erased every named cap,
   both unrefused and both a removal dressed as a setting. Every list field in a patch gets the
   same rule: add what you like, take nothing away. */

function compositionWith(over: Partial<Policy['composition']>): Policy {
  const p = defaultPolicy();
  p.composition = { ...p.composition, ...over };
  return p;
}

test('a patch that erases the forbidden issuer list is refused', () => {
  const policy = compositionWith({ forbiddenIssuers: ['tether', 'someissuer'] });
  const verdict = evaluate(change({ composition: { forbiddenIssuers: [] } }, 'Tidy the issuer list.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'forbidden_issuers_shortened');
  assert.match(verdict.reasons.join(' '), /tether/);
});

test('a patch that drops one forbidden issuer while keeping the rest is refused too', () => {
  const policy = compositionWith({ forbiddenIssuers: ['tether', 'someissuer'] });
  const verdict = evaluate(change({ composition: { forbiddenIssuers: ['tether'] } }, 'Keep tether forbidden.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'refuse');
  assert.match(verdict.reasons.join(' '), /someissuer/);
});

test('adding a forbidden issuer is the reason the field exists, and still lands', () => {
  const policy = compositionWith({ forbiddenIssuers: ['tether'] });
  const verdict = evaluate(
    change({ composition: { forbiddenIssuers: ['tether', 'someissuer'] } }, 'Forbid someissuer as well.'),
    ctxOf(policy),
  );
  assert.equal(verdict.outcome, 'needs_approval');
});

test('a patch that erases a named issuer cap is refused', () => {
  const policy = compositionWith({ maxIssuerShare: { default: 1, tether: 0.2 } });
  const verdict = evaluate(change({ composition: { maxIssuerShare: { default: 1 } } }, 'Set the default share to one.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'issuer_caps_dropped');
  assert.match(verdict.reasons.join(' '), /tether/);
});

test('a named issuer cap may be raised, lowered or added, because the figure is on the card', () => {
  const policy = compositionWith({ maxIssuerShare: { default: 1, tether: 0.2 } });
  const shares: Array<Record<string, number>> = [{ default: 1, tether: 0.9 }, { default: 1, tether: 0.1 }, { default: 1, tether: 0.2, circle: 0.5 }];
  for (const share of shares) {
    const verdict = evaluate(change({ composition: { maxIssuerShare: share } }, 'Move the issuer shares.'), ctxOf(policy));
    assert.equal(verdict.outcome, 'needs_approval', JSON.stringify(share));
  }
});

test('the allowlist rule still fires on a composition-only patch path', () => {
  const policy = policyWith({});
  policy.outbound.destinationAllowlist = ['0xabc'];
  const verdict = evaluate(change({ outbound: { destinationAllowlist: [] } }, 'Tidy the venue list.'), ctxOf(policy));
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.outcome === 'refuse' && verdict.rule, 'allowlist_shortened');
});
