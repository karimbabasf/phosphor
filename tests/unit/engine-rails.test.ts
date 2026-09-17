// The policy engine's rail branch: swap, hyperliquid deposit, LP add/remove.
// These drafts carry no TransferLegs, so none of the leg-based rules apply to them and
// this branch is the ONLY thing governing them. If it is wrong, three features move money
// with nothing checking the amount or the recipient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type {
  HlDepositDraft,
  HlWithdrawDraft,
  IntentsSendDraft,
  Policy,
  RiskRow,
  SwapDraft,
} from '../../src/types.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { classify } from '../../src/composition.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

const SELF_EVM = '0x1111111111111111111111111111111111111111';
const VENUE = '0x2222222222222222222222222222222222222222';
const UNKNOWN_VENUE = '0x9999999999999999999999999999999999999999';

const snapshot = loadDemoLedger();
const composition = classify(snapshot, riskRows);

// The allowlist is what blesses a venue. Every happy-path case here needs it, which is
// itself the point: a rail pointed at an unvetted contract must not run.
function policyAllowing(venue: string, over: Partial<Policy['outbound']> = {}): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = [venue];
  Object.assign(p.outbound, over);
  return p;
}

function ctxWith(over: Partial<EngineCtx> = {}): EngineCtx {
  return {
    policy: policyAllowing(VENUE),
    composition,
    ledger: snapshot,
    sessionSpentUsd: 0,
    selfAddresses: [SELF_EVM],
    ...over,
  };
}

function swap(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-native',
    chain: 'base',
    toChain: 'base',
    fromSymbol: 'USDC',
    toSymbol: 'WETH',
    amountIn: 50,
    amountUsd: 50,
    minAmountOut: 0.01,
    from: SELF_EVM,
    to: SELF_EVM,
    counterparty: VENUE,
    quote: { amountOut: 0.011, feeUsd: 0.05, timeEstimateSec: 12 },
    ...over,
  };
}

function hlDeposit(over: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: 'nep141:eth-usdc.omft.near',
    amount: 25,
    amountUsd: 25,
    minCredited: 24.7,
    from: SELF_EVM,
    hlAccount: SELF_EVM,
    counterparty: VENUE,
    ...over,
  };
}

const FRIEND = '0x3333333333333333333333333333333333333333';

function intentsSend(over: Partial<IntentsSendDraft> = {}): IntentsSendDraft {
  return {
    kind: 'intents_send',
    symbol: 'USDC',
    originAsset: 'nep141:usdc.near',
    amount: 20,
    amountUsd: 20,
    minReceived: 19.8,
    from: SELF_EVM.toLowerCase(),
    to: FRIEND,
    counterparty: VENUE,
    ...over,
  };
}

function hlWithdraw(over: Partial<HlWithdrawDraft> = {}): HlWithdrawDraft {
  return {
    kind: 'hl_withdraw',
    symbol: 'USDC',
    amount: 25,
    amountUsd: 25,
    minReceived: 24.6,
    from: SELF_EVM,
    to: SELF_EVM.toLowerCase(),
    counterparty: VENUE,
    ...over,
  };
}

const ALL = [
  ['swap', swap()],
  ['hl_deposit', hlDeposit()],
  ['hl_withdraw', hlWithdraw()],
  ['intents_send', intentsSend({ to: SELF_EVM })],
] as const;

// ---------- the rails are reachable at all ----------

test('every rail kind is evaluated, not refused as nothing_to_move', () => {
  for (const [name, draft] of ALL) {
    const v = evaluate(draft, ctxWith());
    assert.notEqual(v.outcome, 'refuse', `${name} was refused: ${JSON.stringify(v)}`);
  }
});

// ---------- the allowlist ----------

test('a rail pointed at an unlisted venue is refused', () => {
  const cases = [
    swap({ counterparty: UNKNOWN_VENUE }),
    hlDeposit({ counterparty: UNKNOWN_VENUE }),
    hlWithdraw({ counterparty: UNKNOWN_VENUE }),
  ];
  for (const draft of cases) {
    const v = evaluate(draft, ctxWith());
    assert.equal(v.outcome, 'refuse', draft.kind);
    assert.equal(v.outcome === 'refuse' ? v.rule : '', 'destination_not_allowed');
  }
});

// Security audit F1, 2026-08-12. The engine allowlisted the counterparty (the router) and
// never looked at draft.to (who receives the swap output). A draft naming the real router
// and an attacker's address passed every rule and auto-executed under the click threshold.
test('a swap that would deliver its proceeds to an unlisted address is refused', () => {
  const v = evaluate(swap({ to: '0x9999999999999999999999999999999999999999' }), ctxWith());
  assert.equal(v.outcome, 'refuse');
  assert.equal(v.outcome === 'refuse' ? v.rule : '', 'destination_not_allowed');
});

// The withdraw tool has no destination field, and that is a property of the caller's shape,
// not a governance rule. This is the rule: a draft crediting an intents account that is not
// ours is refused here whatever built it.
test('a Hyperliquid withdrawal crediting an intents account that is not ours is refused', () => {
  const v = evaluate(hlWithdraw({ to: '0x9999999999999999999999999999999999999999' }), ctxWith());
  assert.equal(v.outcome, 'refuse');
  assert.equal(v.outcome === 'refuse' ? v.rule : '', 'destination_not_allowed');
  assert.match(v.outcome === 'refuse' ? v.reasons.join(' ') : '', /proceeds/);
});

// The send is the one draft MEANT to name another account, so the destination rule is the whole
// fence: a receiver the human never allowlisted is refused whatever the size, and one they did
// is decided like every other rail (the always-click rule sits in execute.ts, not here).
test('an intents send to an account that is neither ours nor on the allowlist is refused', () => {
  const v = evaluate(intentsSend({ to: FRIEND }), ctxWith());
  assert.equal(v.outcome, 'refuse');
  assert.equal(v.outcome === 'refuse' ? v.rule : '', 'destination_not_allowed');
  assert.match(v.reasons[v.reasons.length - 1] ?? '', /intents_send would deliver the proceeds to 0x3333/);
});

test('an intents send to an allowlisted account passes the destination rule, and the allowlist match ignores case', () => {
  const p = policyAllowing(VENUE);
  p.outbound.destinationAllowlist = [VENUE, FRIEND.toUpperCase().replace('0X', '0x')];
  const v = evaluate(intentsSend({ to: FRIEND }), ctxWith({ policy: p }));
  assert.notEqual(v.outcome, 'refuse', JSON.stringify(v));
  const own = evaluate(intentsSend({ to: SELF_EVM }), ctxWith());
  assert.notEqual(own.outcome, 'refuse', 'our own account counts as allowed without being listed');
});

test('a Hyperliquid withdrawal into our own intents account passes the engine on the threshold alone', () => {
  const small = evaluate(hlWithdraw({ amountUsd: 25, amount: 25 }), ctxWith());
  assert.equal(small.outcome, 'allow', 'the engine stays pure; the always-click downgrade lives in the executor');
  const big = evaluate(hlWithdraw({ amountUsd: 5000, amount: 5000 }), ctxWith());
  assert.equal(big.outcome, 'needs_approval');
});

test('a swap delivering to one of our own addresses is still fine', () => {
  const v = evaluate(swap({ to: SELF_EVM }), ctxWith());
  assert.notEqual(v.outcome, 'refuse');
});

test('the proceeds check is separate from the counterparty check, not a substitute', () => {
  // Real router, attacker destination: the exact shape of the audit's exploit path.
  const v = evaluate(swap({ counterparty: VENUE, to: UNKNOWN_VENUE, amountUsd: 99 }), ctxWith());
  assert.equal(v.outcome, 'refuse');
  assert.match(v.outcome === 'refuse' ? v.reasons.join(' ') : '', /proceeds/);
});

test('the allowlist match is case insensitive, because addresses arrive in mixed case', () => {
  const v = evaluate(swap({ counterparty: VENUE.toUpperCase() }), ctxWith());
  assert.notEqual(v.outcome, 'refuse');
});

test('one of our own addresses counts as allowed without being listed', () => {
  const ctx = ctxWith({ policy: policyAllowing('0xsomethingelse') });
  const v = evaluate(swap({ counterparty: SELF_EVM }), ctx);
  assert.notEqual(v.outcome, 'refuse');
});

// ---------- the money rules ----------

test('a rail above the per-transaction cap is refused', () => {
  const policy = policyAllowing(VENUE, { maxPerTransactionUsd: 100 });
  const v = evaluate(swap({ amountIn: 500, amountUsd: 500 }), ctxWith({ policy }));
  assert.equal(v.outcome, 'refuse');
  assert.equal(v.outcome === 'refuse' ? v.rule : '', 'max_per_transaction');
});

test('a rail that would breach the rolling session cap is refused', () => {
  const policy = policyAllowing(VENUE, { maxPerSessionUsd: 100, maxPerTransactionUsd: 1000 });
  const v = evaluate(swap({ amountUsd: 60 }), ctxWith({ policy, sessionSpentUsd: 50 }));
  assert.equal(v.outcome, 'refuse');
  assert.equal(v.outcome === 'refuse' ? v.rule : '', 'max_per_session');
});

test('a rail above the click threshold needs a human, it does not just proceed', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 10, maxPerTransactionUsd: 1000, maxPerSessionUsd: 10000 });
  const v = evaluate(swap({ amountUsd: 50 }), ctxWith({ policy }));
  assert.equal(v.outcome, 'needs_approval');
});

test('a rail under every limit is allowed', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 1000, maxPerTransactionUsd: 1000, maxPerSessionUsd: 10000 });
  const v = evaluate(swap({ amountUsd: 5 }), ctxWith({ policy }));
  assert.equal(v.outcome, 'allow');
});

// ---------- numbers that cannot be checked ----------

test('a rail with a nonsense amount is refused rather than treated as zero', () => {
  for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = evaluate(swap({ amountUsd: bad }), ctxWith());
    assert.equal(v.outcome, 'refuse', `amountUsd ${bad} should refuse`);
    assert.equal(v.outcome === 'refuse' ? v.rule : '', 'invalid_amount');
  }
});

// ---------- the rules that outrank everything ----------

test('the kill switch refuses every rail kind', () => {
  const policy = policyAllowing(VENUE);
  policy.killSwitch = true;
  for (const [name, draft] of ALL) {
    const v = evaluate(draft, ctxWith({ policy }));
    assert.equal(v.outcome, 'refuse', name);
    assert.equal(v.outcome === 'refuse' ? v.rule : '', 'kill_switch');
  }
});

test('an unreadable policy refuses every rail kind', () => {
  for (const [name, draft] of ALL) {
    const v = evaluate(draft, ctxWith({ policy: null }));
    assert.equal(v.outcome, 'refuse', name);
    assert.equal(v.outcome === 'refuse' ? v.rule : '', 'policy_unreadable');
  }
});

// ---------- the auto-approved daily ceiling (A.F5) ----------
//
// Nothing above the click threshold aggregates, so an agent can file an unbounded stream of
// sub-threshold moves and only the 24h cap stops it. This is a second wall, on the auto-approved
// subtotal alone: past it the next auto move waits for a click, whatever its size.

test('a sub-threshold move that would push auto-approved spend past the ceiling waits for a click', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 100, autoApproveDailyUsd: 250 });
  const v = evaluate(swap({ amountUsd: 60 }), ctxWith({ policy, autoApprovedSpentUsd: 200 }));
  assert.equal(v.outcome, 'needs_approval');
  assert.equal(
    v.reasons[v.reasons.length - 1],
    'Auto-approved moves in the last 24 hours already total $200.00; with $60.00 more that passes the $250.00 ceiling, so this one waits for a click.',
  );
});

test('the same move under the ceiling is allowed', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 100, autoApproveDailyUsd: 250 });
  const v = evaluate(swap({ amountUsd: 60 }), ctxWith({ policy, autoApprovedSpentUsd: 100 }));
  assert.equal(v.outcome, 'allow');
});

test('a move above the click threshold keeps the click reason, not the ceiling one', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 100, autoApproveDailyUsd: 250 });
  const v = evaluate(swap({ amountUsd: 150 }), ctxWith({ policy, autoApprovedSpentUsd: 200 }));
  assert.equal(v.outcome, 'needs_approval');
  assert.match(v.reasons.join(' '), /above the \$100\.00 click threshold/);
});

test('no ceiling set means the old behaviour: only the click threshold and the 24h cap bind', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 100 });
  delete (policy.outbound as { autoApproveDailyUsd?: number }).autoApproveDailyUsd;
  const v = evaluate(swap({ amountUsd: 60 }), ctxWith({ policy, autoApprovedSpentUsd: 1_000_000 }));
  assert.equal(v.outcome, 'allow');
});

test('the ceiling binds a hyperliquid deposit the same way it binds a swap', () => {
  const policy = policyAllowing(VENUE, { humanClickAboveUsd: 100, autoApproveDailyUsd: 250 });
  const v = evaluate(hlDeposit({ amountUsd: 60 }), ctxWith({ policy, autoApprovedSpentUsd: 200 }));
  assert.equal(v.outcome, 'needs_approval');
  assert.match(v.reasons.join(' '), /auto-approved moves/i);
});
