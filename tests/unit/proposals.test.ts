// The proposal service: price, evaluate, simulate, persist, execute. A scripted rail stands in
// for the venue, no network, no keys, every case against a throwaway dataDir.
//
// The property under test throughout: a proposal reaches execution only via verdict `allow`
// (auto-execute below the click threshold) or a recorded human approval. There is no third way
// in, and the audit log shows which one happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { LedgerSnapshot, Policy, PolicyPatch, Proposal, RailResult } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import { createStore } from '../../src/store.ts';
import { loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { ETH_USDC_FLAVOR, SELF_EVM, landed, makeCtx, railThat, seededPolicy, slowRail } from './helpers/proposals.ts';
import type { HarnessOptions } from './helpers/proposals.ts';

function happyPolicy(): Policy {
  return seededPolicy();
}

// A deposit rail that credits at once and counts how often it ran, so a test can say whether
// money moved rather than guess from a status.
function creditingRail(): { rail: ReturnType<typeof railThat>; runs: () => number } {
  let runs = 0;
  const rail = railThat('hl_deposit', async (): Promise<RailResult> => {
    runs += 1;
    return { ok: true, detail: 'credited', txids: ['0xtest'] };
  });
  return { rail, runs: () => runs };
}

// The service over that rail, with enough in the verifier for a large move.
function setup(over: HarnessOptions = {}) {
  const credit = creditingRail();
  const h = makeCtx({ rails: [credit.rail], intentsUsdc: 100_000, ...over });
  return { ...h, runs: credit.runs };
}

// ---------- pricing a non-stable, found by executing a real swap ----------
// This app started as a stablecoin tool and priced every token at a dollar. Correct for USDC,
// wrong for WETH. amountUsd is what every budget in the engine reads, so a 0.01 WETH swap was
// governed as $0.01 rather than ~$18.80, and 10 WETH (~$18,800) would have passed a $10,000
// per-transaction cap. Caught live on 2026-08-12.

test('a non-stable is priced at spot, not at the stablecoin assumption', async () => {
  const h = setup();
  const snap = h.ledger.snapshot();
  snap.prices.ETH = 1880;

  const p = await h.svc.proposeSwap({
    chain: 'arb', fromSymbol: 'WETH', toSymbol: 'USDC',
    amountIn: 0.01, minAmountOut: 1,
  });

  assert.ok(p.draft.kind === 'swap');
  // 0.01 WETH at 1880 is 18.80, not 0.01.
  assert.ok(Math.abs(p.draft.amountUsd - 18.8) < 0.01, `amountUsd was ${p.draft.amountUsd}`);
});

test('a token the app cannot price is refused rather than guessed at 1.0', async () => {
  const h = setup();

  const p = await h.svc.proposeSwap({
    chain: 'arb', fromSymbol: 'MYSTERY', toSymbol: 'USDC',
    amountIn: 1000, minAmountOut: 1,
  });

  // Infinity, not NaN: the engine refuses a non-finite amount, where NaN would make every
  // comparison against a cap false and sail through all of them.
  assert.equal(p.verdict.outcome, 'refuse');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'invalid_amount');
});

// ---------- the approval gate, which has no exemption ----------
// Security audit F3, 2026-08-12: the gate was configurable, and nothing in the execution path
// read the flag, so the banner said "every proposal auto-approves" while every one of them sat
// pending forever. The flag is gone: above the click threshold a person clicks, and there is
// no setting, environment or proposal kind that reaches execution without one.

test('a proposal above the click threshold parks as pending and nothing decides it', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });

  assert.equal(p.verdict.outcome, 'needs_approval', JSON.stringify(p.verdict));
  assert.equal(p.status, 'pending');
  assert.equal(p.decidedBy, undefined);
  assert.equal(p.decidedAt, undefined);
  assert.equal(h.runs(), 0, 'a pending proposal moves nothing');
});

test('no path writes the retired gate_disabled decision', async () => {
  const h = setup();
  await h.svc.proposeHlDeposit({ amount: 200 });
  await h.svc.proposePolicyChange({
    patch: { outbound: { maxPerTransactionUsd: 999999 } },
    sentence: 'Refuse any single transaction above $999,999.',
  });

  for (const p of h.svc.list()) {
    assert.notEqual(p.decidedBy, 'gate_disabled' as never);
  }
  for (const line of h.audit.tail(50)) {
    assert.doesNotMatch(line.msg, /gate.disabled/i);
    assert.doesNotMatch(line.msg, /auto-approved/i);
  }
});

// The hole this closes was real and was introduced by the F3 fix itself: with the gate off,
// proposePolicyChange auto-applied, and an agent raised maxPerTransactionUsd from $10,000 to
// $999,999 with no human. The agent would author the limits and apply them, which is the one
// thing this app exists to prevent.
test('a policy change never auto-approves', async () => {
  const h = setup();
  /* $50,000 rather than the $999,999 this used to ask for, and the size no longer decides the
     verdict either way: the ten-times ceiling went on 2026-09-18 because the tool always waits
     for a click anyway. What this row asserts is that it waits, at any number. */
  const p = await h.svc.proposePolicyChange({
    patch: { outbound: { maxPerTransactionUsd: 50_000 } },
    sentence: 'Refuse any single transaction above $50,000.',
  });

  assert.equal(p.status, 'pending');
  assert.equal(p.decidedBy, undefined);
});

test('the policy on disk is untouched while that change sits pending', async () => {
  const h = setup();
  const before = loadPolicy(h.dataDir)?.outbound.maxPerTransactionUsd;
  await h.svc.proposePolicyChange({
    patch: { outbound: { maxPerTransactionUsd: 50_000 } },
    sentence: 'Refuse any single transaction above $50,000.',
  });

  assert.equal(loadPolicy(h.dataDir)?.outbound.maxPerTransactionUsd, before);
});

test('the gate being off does not turn a refusal into an approval', async () => {
  const policy = happyPolicy();
  policy.killSwitch = true;
  const h = setup({ policy });
  const p = await h.svc.proposeHlDeposit({ amount: 200 });

  assert.equal(p.status, 'policy_refused');
  assert.equal(p.decidedBy, 'policy');
  assert.equal(h.runs(), 0);
});

// ---------- the approval gate and the rail ----------

test('a pending proposal executes only after a human approves it', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  assert.equal(p.status, 'pending');
  assert.equal(h.runs(), 0, 'nothing ran while it waited');

  // The click answers with the executing row; the rail lands behind it.
  const approved = await landed(h, h.svc.approve(p.id));
  assert.equal(approved.status, 'executed');
  assert.equal(approved.decidedBy, 'human');
  assert.ok(approved.decidedAt);
  assert.equal(approved.result?.ok, true);
  assert.equal(h.runs(), 1, 'the rail ran exactly once, after the click');

  const types = h.eventTypes();
  assert.ok(types.indexOf('approved') < types.indexOf('executed'), 'approval is logged before execution');
  assert.ok(types.includes('proposal_created'));
});

test('refuse leaves the money alone', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });

  const refused = await h.svc.refuse(p.id);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.decidedBy, 'human');
  assert.equal(h.runs(), 0);
  assert.ok(h.eventTypes().includes('refused'));
  assert.ok(!h.eventTypes().includes('executed'));
});

test('a move below the click threshold is allowed and executes with no pending state', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 40 }));

  assert.equal(p.verdict.outcome, 'allow');
  assert.equal(p.status, 'executed');
  assert.equal(p.decidedBy, 'policy');
  assert.equal(h.runs(), 1);
  assert.equal(h.store.list().filter(x => x.status === 'pending').length, 0);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);
});

// ---------- fail-closed paths ----------

test('a corrupt policy file refuses every propose', async () => {
  const h = setup();
  fs.writeFileSync(path.join(h.dataDir, 'policy.json'), '{ not json at all');

  const move = await h.svc.proposeHlDeposit({ amount: 200 });
  assert.equal(move.status, 'policy_refused');
  assert.ok(move.verdict.outcome === 'refuse' && move.verdict.rule === 'policy_unreadable');

  const change = await h.svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 5 } }, sentence: 'Ask me above $5.' });
  assert.equal(change.status, 'policy_refused');
  assert.ok(change.verdict.outcome === 'refuse' && change.verdict.rule === 'policy_unreadable');
  assert.ok(h.eventTypes().filter(t => t === 'policy_refused').length >= 2);
});

test('the kill switch stops a proposal that was already pending', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  assert.equal(p.status, 'pending');

  const killed = loadPolicy(h.dataDir) as Policy;
  killed.killSwitch = true;
  savePolicy(h.dataDir, killed);

  const after = await h.svc.approve(p.id);
  assert.equal(after.status, 'policy_refused');
  assert.ok(after.verdict.outcome === 'refuse' && after.verdict.rule === 'kill_switch');
  assert.equal(h.runs(), 0, 'nothing moved');
  assert.ok(!h.eventTypes().includes('executed'));
});

test('approve is rejected for anything that is not pending', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  await h.svc.approve(p.id);

  await assert.rejects(() => h.svc.approve(p.id), /not pending|executed/i);
  await assert.rejects(() => h.svc.approve('no-such-id'), /unknown proposal/i);
  await assert.rejects(() => h.svc.refuse(p.id), /not pending|executed/i);
  assert.ok(h.eventTypes().includes('approve_attempt_rejected'));
});

test('a proposal from an older build that no rail answers for fails on approval and moves nothing', async () => {
  const h = setup();
  // The shape a consolidate row had on disk. Nothing builds one any more; approve() still has
  // to answer for it, and the engine refuses it by name before any rail is looked up.
  const row = {
    id: 'old-consolidate',
    kind: 'consolidate',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: { kind: 'consolidate', legs: [], totalUsd: 250, toChain: 'eth', symbol: 'USDT' },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['from an older build'] },
  } as unknown as Proposal;
  h.store.put(row);

  const after = await h.svc.approve(row.id);
  assert.equal(after.status, 'policy_refused');
  assert.ok(after.verdict.outcome === 'refuse' && after.verdict.rule === 'unknown_kind', JSON.stringify(after.verdict));
  assert.equal(h.runs(), 0);
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
  const p = await h.svc.proposePolicyChange({ patch: { outbound: { maxPerSessionUsd: 1 } }, sentence: 'Cap a session at $1.' });
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

test('sessionSpentUsd counts executed moves and ignores refused ones and policy changes', async () => {
  const h = setup();
  assert.equal(h.svc.sessionSpentUsd(), 0);

  const small = await landed(h, h.svc.proposeHlDeposit({ amount: 40 }));
  assert.equal(small.status, 'executed');
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);

  const refused = await h.svc.proposeHlDeposit({ amount: 200 });
  await h.svc.refuse(refused.id);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01);

  const change = await h.svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 500 } }, sentence: 'Ask me above $500.' });
  await h.svc.approve(change.id);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 40) < 0.01, 'a policy change is not spend');
});

test('a stale proposal in the store survives a fresh service and stays gettable', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });

  assert.equal(h.svc.get(p.id)?.id, p.id);
  assert.equal(h.svc.list().length, 1);
  assert.equal(h.svc.get('nope'), undefined);
  assert.equal(createStore(h.dataDir).get(p.id)?.status, 'pending');
});

test('onChange fires on every state transition', async () => {
  let changes = 0;
  const h = setup({
    deps: {
      onChange: () => {
        changes += 1;
      },
    },
  });

  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  const afterPropose = changes;
  assert.ok(afterPropose >= 1);
  await h.svc.approve(p.id);
  assert.ok(changes > afterPropose);
});

// C2. sessionSpentUsd() counted only 'executed', and nothing serialised proposal handling, so
// concurrent proposals each evaluated against a spend of 0. Five $10,000 moves went through
// against a $25,000 cap. The width of the window tracked send latency.
test('concurrent proposals cannot exceed the session cap between them', async () => {
  const policy = happyPolicy();
  policy.outbound.maxPerTransactionUsd = 10000;
  policy.outbound.maxPerSessionUsd = 25000;
  policy.outbound.humanClickAboveUsd = 1_000_000; // take the click out of the picture
  policy.outbound.autoApproveDailyUsd = 25000; // and the auto-approved ceiling too: this is the session cap's test
  const h = setup({ policy });

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.svc.proposeHlDeposit({ amount: 10000 })));

  const movedUsd = results
    .filter(p => p.status === 'executed' || p.status === 'executing')
    .reduce((sum, p) => sum + (p.draft.kind === 'hl_deposit' ? p.draft.amountUsd : 0), 0);

  assert.ok(movedUsd <= 25000, `moved $${movedUsd} against a $25,000 session cap`);
  assert.ok(results.some(p => p.status === 'policy_refused'), 'something has to have been refused');
});

test('an in-flight proposal counts against the cap while it is still executing', async () => {
  const policy = happyPolicy();
  policy.outbound.humanClickAboveUsd = 1_000_000; // take the click out of the picture
  policy.outbound.autoApproveDailyUsd = 1_000_000; // and the auto-approved ceiling out of the picture too
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail], policy, intentsUsdc: 100_000 });
  const before = h.svc.sessionSpentUsd();
  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  assert.equal(p.status, 'executing');
  assert.ok(h.svc.sessionSpentUsd() > before, 'a move still out registers');
  slow.release({ ok: true, detail: 'credited', txids: ['0xtest'] });
  await h.svc.settle(2000);
});

// ---------- the hash is the record, the balance is a decoration ----------
//
// Both used to be written together, after `balanceAfter`, which waits up to fifteen seconds for
// a ledger read. A process ending inside that window had broadcast a transaction and recorded
// nothing about it, and there is no drain that covers it: SETTLE_CAP_MS is 32s while a 30s venue
// write plus a 15s refresh is 45s. reconcileOnBoot then found an `executing` row with no txids,
// could only say "this may or may not have sent", and reconcileProposal had nothing to look it up
// by. Money moved and no hash existed anywhere.

// A ledger whose refresh never settles: exactly the fifteen seconds the old code spent between
// the broadcast and the durable write, held open forever so the assertion is deterministic.
function stuckLedger(base: Ledger): Ledger {
  return {
    snapshot: () => base.snapshot(),
    intents: () => base.intents(),
    hyperliquid: () => undefined,
    refresh: () => new Promise<LedgerSnapshot>(() => {}),
  };
}

test('the transaction hash is on disk before the balance refresh has even answered', async () => {
  const probe = makeCtx({ intentsUsdc: 100_000 });
  const h = setup({ deps: { ledger: stuckLedger(probe.ledger) } });
  const p = await h.svc.proposeHlDeposit({ amount: 200 });
  assert.equal(p.status, 'pending', JSON.stringify(p.verdict));

  // Deliberately NOT awaited: the refresh inside never settles, so awaiting the settled row
  // would hang. What matters is the state of the file while it is still in there.
  const running = h.svc.approve(p.id);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stored = h.store.get(p.id) as Proposal;
  assert.ok((stored.result?.txids ?? []).includes('0xtest'), 'the hash the rail returned is durable already');
  assert.equal(stored.status, 'executed', 'and so is the outcome');
  assert.equal(stored.balances?.afterUsd, null, 'while the balance is still being read');
  void running;
});

// The addresses the builders resolve are the app's own, never the caller's: the same account
// that the ledger reads is the one a deposit spends from.
test('a deposit spends from the app account the ledger reads, lowercased, and credits its own trading account', async () => {
  const h = setup();
  const p = await h.svc.proposeHlDeposit({ amount: 40 });
  assert.ok(p.draft.kind === 'hl_deposit');
  assert.equal(p.draft.from, SELF_EVM.toLowerCase());
  assert.equal(p.draft.hlAccount.toLowerCase(), SELF_EVM.toLowerCase());
  assert.equal(p.draft.originAsset, ETH_USDC_FLAVOR);
});

// ---------- NEAR inside the verifier is wNEAR ----------
// 1Click lists the coin on its own chain as nep141:wrap.near under the symbol wNEAR and lists no
// native NEAR at all, so "swap my USDC to NEAR" was refused before any quote (Karim, 2026-09-20).
// The door books the coin under the name the wallet row and the venue use.

test('a swap into NEAR on near is drafted as wNEAR, the name the wallet and the venue use', async () => {
  const h = setup();
  const p = await h.svc.proposeSwap({
    chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'NEAR',
    amountIn: 7, minAmountOut: 1.9,
  });
  assert.ok(p.draft.kind === 'swap');
  assert.equal(p.draft.toSymbol, 'wNEAR');
  assert.equal(p.draft.fromSymbol, 'USDC');
});

// ---------- a swap is valued on whichever side the app can price ----------
// The engine measures in dollars. USDC into an unpriced token was allowed (the USDC side priced
// it), and the same token back into ETH was refused as unbounded, although ETH was priced and
// the quote said how much would arrive: money that could get in and not out (Karim, 2026-09-20).

function quotingSwapRail(receives: string) {
  const base = railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'swapped', txids: ['0xswap'] }));
  return {
    ...base,
    async simulate() {
      return { ok: true, summary: `quoted ${receives}`, swap: { receives, receivesAtLeast: receives, feeUsd: 0.02, etaSeconds: 5 } };
    },
  };
}

test('an unpriced token into a priced one is valued off the quote, and lands', async () => {
  const h = makeCtx({ rails: [quotingSwapRail('5.25')], intentsUsdc: 100_000 });
  const p = await h.svc.proposeSwap({
    chain: 'arb', fromSymbol: 'MYSTERY', toSymbol: 'USDC',
    amountIn: 1000, minAmountOut: 5,
  });
  assert.ok(p.draft.kind === 'swap');
  assert.equal(p.draft.amountUsd, 5.25, 'a dollar per USDC, off the quote');
  assert.notEqual(p.verdict.outcome, 'refuse', JSON.stringify(p.verdict));
  assert.ok(p.simulation?.ok, 'the quote that priced it rides on the row');
});

test('a swap with no price on either side is still refused', async () => {
  const h = makeCtx({ rails: [quotingSwapRail('5')], intentsUsdc: 100_000 });
  const p = await h.svc.proposeSwap({
    chain: 'arb', fromSymbol: 'MYSTERY', toSymbol: 'RIDDLE',
    amountIn: 1000, minAmountOut: 1,
  });
  assert.equal(p.verdict.outcome, 'refuse');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'invalid_amount');
});

test('a quote that fails leaves the unpriced swap refused as simulation_required, not as invalid_amount', async () => {
  const failing = { ...railThat('swap', async (): Promise<RailResult> => ({ ok: false, detail: 'never' })), async simulate() { return { ok: false, summary: 'no route', error: 'no route' }; } };
  const h = makeCtx({ rails: [failing], intentsUsdc: 100_000 });
  const p = await h.svc.proposeSwap({
    chain: 'arb', fromSymbol: 'MYSTERY', toSymbol: 'USDC',
    amountIn: 1000, minAmountOut: 5,
  });
  assert.equal(p.verdict.outcome, 'refuse');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'simulation_required');
});
