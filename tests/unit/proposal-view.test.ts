// One case per stage in the table, because the stage word is what both surfaces print.
//
// The card used to keep its own map and the agent its own word, and the two disagreeing in
// front of somebody watching real money is the reason this file exists. So every stage is
// asserted here once: the word, the label, who has not answered, and whether it is over.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, RailEvidence } from '../../src/types.ts';
import { STAGE_LABEL, TERMINAL, proposalView } from '../../src/proposals/view.ts';
import type { ProposalStage } from '../../src/proposals/view.ts';

const CREATED = '2026-09-18T10:00:00.000Z';
const NOW = Date.parse('2026-09-18T10:02:00.000Z');

function rowOf(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    kind: 'hl_deposit',
    createdAt: CREATED,
    status: 'pending',
    draft: {
      kind: 'hl_deposit',
      symbol: 'USDC',
      originAsset: 'nep141:eth-usdc',
      amount: 7.5425,
      amountUsd: 7.5425,
      minCredited: 5,
      from: '0x1111111111111111111111111111111111111111',
      hlAccount: '0x1111111111111111111111111111111111111111',
      counterparty: 'hypercore',
    },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: [] },
    lastChangeAt: '2026-09-18T10:01:00.000Z',
    ...over,
  };
}

const POCKET = { venue: 'hyperliquid' as const, symbol: 'USDC', assetId: 'hl-usdc', account: '0x1111111111111111111111111111111111111111', decimals: 6, before: '0', after: null, floor: '5000000' };

function viewOf(over: Partial<Proposal>) {
  return proposalView({ settle: (row) => row }, rowOf(over), NOW);
}

function withProvider(status: Proposal['status'], stage: string, extra: Partial<Proposal> = {}) {
  const evidence: RailEvidence = { providerStage: stage, handle: 'h1' };
  return viewOf({ status, result: { ok: false, detail: 'polling', txids: ['0xintent'], evidence }, ...extra });
}

// stage -> the row that produces it. Every key of STAGE_LABEL appears exactly once.
const CASES: Record<ProposalStage, () => ReturnType<typeof viewOf>> = {
  waiting_for_you: () => viewOf({ status: 'pending' }),
  waiting_for_unlock: () => viewOf({ status: 'pending_unlock' }),
  waiting_for_touch: () => viewOf({ status: 'awaiting_touch' }),
  signing: () => viewOf({ status: 'approved' }),
  submitting: () => viewOf({ status: 'executing' }),
  KNOWN_DEPOSIT_TX: () => withProvider('executing', 'KNOWN_DEPOSIT_TX'),
  PENDING_DEPOSIT: () => withProvider('executing', 'PENDING_DEPOSIT'),
  INCOMPLETE_DEPOSIT: () => withProvider('executing', 'INCOMPLETE_DEPOSIT'),
  PROCESSING: () => withProvider('executing', 'PROCESSING'),
  SUCCESS: () => withProvider('executing', 'SUCCESS'),
  REFUNDED: () => withProvider('needs_reconciliation', 'REFUNDED', { pocket: POCKET }),
  FAILED: () => withProvider('needs_reconciliation', 'FAILED', { pocket: POCKET }),
  crediting: () => withProvider('needs_reconciliation', 'SUCCESS', { pocket: POCKET }),
  confirmed: () => viewOf({ status: 'executed', settledAt: '2026-09-18T10:01:30.000Z' }),
  failed: () => viewOf({ status: 'failed', result: { ok: false, detail: 'the rail threw' } }),
  declined: () => viewOf({ status: 'refused' }),
  refused: () => viewOf({ status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['over the cap'], rule: 'over_cap' } }),
  stalled: () => viewOf({ status: 'needs_reconciliation', pocket: POCKET, stalledAt: '2026-09-18T10:01:40.000Z' }),
};

test('every stage in the table has a row that produces it, with its own label', () => {
  const seen: string[] = [];
  for (const [stage, build] of Object.entries(CASES) as Array<[ProposalStage, () => ReturnType<typeof viewOf>]>) {
    const view = build();
    assert.equal(view.stage, stage, `expected ${stage}, got ${view.stage}`);
    assert.equal(view.stageLabel, STAGE_LABEL[stage]);
    assert.equal(view.terminal, TERMINAL.has(stage), `${stage} terminal`);
    seen.push(stage);
  }
  assert.deepEqual(seen.sort(), Object.keys(STAGE_LABEL).sort(), 'every stage is covered exactly once');
});

test('waitingOn names a person, the wallet, the router or the venue, and nobody once it is over', () => {
  assert.equal(CASES.waiting_for_you().waitingOn, 'You');
  assert.equal(CASES.waiting_for_unlock().waitingOn, 'You');
  assert.equal(CASES.waiting_for_touch().waitingOn, 'Touch ID');
  assert.equal(CASES.signing().waitingOn, 'The wallet');
  assert.equal(CASES.PROCESSING().waitingOn, '1Click');
  assert.equal(CASES.crediting().waitingOn, 'Hyperliquid');
  for (const stage of TERMINAL) assert.equal(CASES[stage]().waitingOn, null, `${stage} waits on nobody`);
});

test('the clocks count from the row and the stage, not from the last write', () => {
  const view = CASES.crediting();
  assert.equal(view.elapsedSec, 120);
  assert.equal(view.sinceChangeSec, 60);
  assert.equal(view.typicalSec, 180);
});

test('a policy change has no typical duration and no deadline', () => {
  const view = proposalView(
    { settle: (row) => row },
    { ...rowOf(), kind: 'policy_change', draft: { kind: 'policy_change', patch: {}, sentence: 'Ask me above $100.' } },
    NOW,
  );
  assert.equal(view.typicalSec, null);
  assert.equal(view.deadlineAt, null);
  assert.equal(view.money.symbol, '');
  assert.equal(view.money.fromPocket, null);
});

test('the deadline runs from the decision, so a row waiting on a person is never late', () => {
  const waiting = CASES.waiting_for_you();
  assert.equal(waiting.deadlineAt, new Date(Date.parse(CREATED) + 1440 * 1000).toISOString());
  const decided = viewOf({ status: 'executing', decidedAt: '2026-09-18T10:01:00.000Z' });
  assert.equal(decided.deadlineAt, new Date(Date.parse('2026-09-18T10:01:00.000Z') + 1440 * 1000).toISOString());
});

test('the hashes carry one running leg while the row is open and none once it is over', () => {
  const open = withProvider('executing', 'PROCESSING', { result: { ok: false, detail: 'polling', txids: ['0xintent', '0xdest'], evidence: { providerStage: 'PROCESSING', explorerUrl: 'https://example.invalid/tx' } } });
  assert.deepEqual(open.txs.map((t) => t.leg), ['intent', 'destination']);
  assert.deepEqual(open.txs.map((t) => t.running), [false, true]);
  assert.equal(open.txs[1].explorer, 'https://example.invalid/tx');

  const done = viewOf({ status: 'executed', result: { ok: true, detail: 'credited', txids: ['0xintent', '0xdest'] } });
  assert.equal(done.txs.some((t) => t.running), false);
});

test('an error carries a code the grader reads and a sentence a person reads', () => {
  assert.equal(CASES.failed().error?.code, 'rail_failed');
  assert.equal(CASES.refused().error?.code, 'over_cap');
  assert.equal(CASES.FAILED().error?.code, 'provider_failed');
  assert.equal(CASES.stalled().error?.code, 'deadline_passed');
  assert.match(CASES.stalled().error?.message ?? '', /Hyperliquid has not answered/);
  assert.equal(CASES.declined().error, null, 'a person saying no is a decision, not a fault');
  assert.equal(CASES.confirmed().error, null);
});

test('the money block names both pockets and never invents a figure', () => {
  const view = CASES.crediting();
  assert.equal(view.money.symbol, 'USDC');
  assert.equal(view.money.amountIn, '7.5425');
  assert.equal(view.money.fromPocket, 'NEAR Intents');
  assert.equal(view.money.toPocket, 'Hyperliquid');
  assert.equal(view.money.amountOut, null, 'no settled amount and no simulation means no figure');
  assert.equal(view.money.feeUsd, null);

  const settled = withProvider('needs_reconciliation', 'SUCCESS', {
    pocket: POCKET,
    result: { ok: false, detail: 'settling', txids: [], evidence: { providerStage: 'SUCCESS', settledAmountOut: '7.0623' } },
  });
  assert.equal(settled.money.amountOut, '7.0623');
});
