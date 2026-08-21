// The policy engine's rail branch: swap, hyperliquid deposit, LP add/remove.
// These drafts carry no TransferLegs, so none of the leg-based rules apply to them and
// this branch is the ONLY thing governing them. If it is wrong, three features move money
// with nothing checking the amount or the recipient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { HlDepositDraft, LpAddDraft, LpRemoveDraft, Policy, RiskRow, SwapDraft } from '../../src/types.ts';
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
    venue: 'uniswap-v3',
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
    chain: 'arb',
    symbol: 'USDC',
    tokenId: 'USDC',
    amount: 25,
    amountUsd: 25,
    minCredited: 24.7,
    from: SELF_EVM,
    hlAccount: SELF_EVM,
    counterparty: VENUE,
    ...over,
  };
}

function lpAdd(over: Partial<LpAddDraft> = {}): LpAddDraft {
  return {
    kind: 'lp_add',
    chain: 'base',
    venue: 'uniswap-v3',
    poolId: '0xpool',
    token0: { symbol: 'USDC', tokenId: '0xusdc', amount: 30, decimals: 6 },
    token1: { symbol: 'WETH', tokenId: '0xweth', amount: 0.01, decimals: 18 },
    feeTier: 500,
    tickLower: -60,
    tickUpper: 60,
    amountUsd: 60,
    from: SELF_EVM,
    counterparty: VENUE,
    ...over,
  };
}

function lpRemove(over: Partial<LpRemoveDraft> = {}): LpRemoveDraft {
  return {
    kind: 'lp_remove',
    chain: 'base',
    venue: 'uniswap-v3',
    positionId: '4242',
    liquidityPct: 0.5,
    amountUsd: 40,
    from: SELF_EVM,
    counterparty: VENUE,
    ...over,
  };
}

const ALL = [
  ['swap', swap()],
  ['hl_deposit', hlDeposit()],
  ['lp_add', lpAdd()],
  ['lp_remove', lpRemove()],
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
    lpAdd({ counterparty: UNKNOWN_VENUE }),
    lpRemove({ counterparty: UNKNOWN_VENUE }),
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
