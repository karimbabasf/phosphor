// How the policy engine compares a destination against the addresses it treats as ours.
//
// It lowercased both sides of every comparison. That is right for an EVM address, where the same
// 20 bytes have a checksummed spelling and a lowercase one, and wrong for base58: the withdraw
// rail says so in as many words, "base58 case carries key material, and two strings differing
// only in case are two different accounts." The rail compares case-correctly and catches it; the
// engine, which is the layer meant to hold regardless of which rail ran, did not. A Solana payout
// to a case variant of our address is not theft, it is a total loss, and nothing recovers it.
//
// Run: node --test tests/unit/engine-destination-case.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { IntentsWithdrawDraft, LedgerSnapshot, Policy, RiskRow } from '../../src/types.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { classify } from '../../src/composition.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';
import { INTENTS_WITHDRAW_COUNTERPARTY } from '../../src/rails/intents-withdraw.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

const SELF_EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_SELF = 'So11111111111111111111111111111111111111112';
// The same 44 characters with one letter recased. A different ed25519 key, a different account,
// and money sent there is gone.
const SOL_VARIANT = 'so11111111111111111111111111111111111111112';

const base = loadDemoLedger();
const composition = classify(base, riskRows);

// A ledger that actually holds the Solana address, which is how the engine learns its exact
// spelling: lifecycle.selfAddresses lowercases everything it folds in, so the holdings table is
// the only place the real casing survives.
function ledgerHolding(address: string): LedgerSnapshot {
  return {
    ...base,
    holdings: [
      ...base.holdings,
      { chain: 'sol', address, symbol: 'USDC', amount: 100, usd: 100, native: false, tokenId: 'usdc' } as never,
    ],
  };
}

function policyAllowing(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = [INTENTS_WITHDRAW_COUNTERPARTY];
  return p;
}

function ctxWith(over: Partial<EngineCtx> = {}): EngineCtx {
  return {
    policy: policyAllowing(),
    composition,
    ledger: base,
    sessionSpentUsd: 0,
    // Lowercased, exactly as src/proposals/lifecycle.ts hands them over.
    selfAddresses: [SELF_EVM.toLowerCase(), SOL_SELF.toLowerCase()],
    ...over,
  };
}

function withdraw(to: string): IntentsWithdrawDraft {
  return {
    kind: 'intents_withdraw',
    chain: 'sol',
    symbol: 'USDC',
    amount: 10,
    amountUsd: 10,
    minReceived: 9.8,
    from: SELF_EVM,
    to,
    counterparty: INTENTS_WITHDRAW_COUNTERPARTY,
  } as IntentsWithdrawDraft;
}

test('a Solana destination differing only in case is refused by the engine', () => {
  const ctx = ctxWith({ ledger: ledgerHolding(SOL_SELF) });
  const verdict = evaluate(withdraw(SOL_VARIANT), ctx);

  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.rule, 'destination_not_allowed');
});

test('and the real address still passes, so the rule refuses the variant rather than the family', () => {
  const ctx = ctxWith({ ledger: ledgerHolding(SOL_SELF) });
  const verdict = evaluate(withdraw(SOL_SELF), ctx);
  assert.notEqual(verdict.outcome, 'refuse');
});

test('an EVM destination still matches whatever its checksum casing', () => {
  const ctx = ctxWith();
  const lower = evaluate(withdraw(SELF_EVM.toLowerCase()), ctx);
  const checksummed = evaluate(withdraw(SELF_EVM), ctx);

  assert.notEqual(lower.outcome, 'refuse');
  assert.notEqual(checksummed.outcome, 'refuse');
});

test('a chain we hold nothing on keeps working, because no exact spelling exists to contradict', () => {
  // The engine only ever sees the lowercased config entry here, so it cannot tell the two
  // spellings apart and says so by allowing rather than by refusing an address that may be ours.
  const ctx = ctxWith();
  assert.notEqual(evaluate(withdraw(SOL_SELF), ctx).outcome, 'refuse');
});

test('a venue string on the allowlist is not an address and keeps matching case-insensitively', () => {
  const policy = defaultPolicy();
  policy.outbound.destinationAllowlist = ['INTENTS.NEAR'];
  const draft = { ...withdraw(SOL_SELF), counterparty: 'intents.near' } as IntentsWithdrawDraft;
  const verdict = evaluate(draft, ctxWith({ policy }));

  assert.notEqual(verdict.outcome === 'refuse' ? verdict.rule : '', 'destination_not_allowed');
});
