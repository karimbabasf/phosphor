// One case per stage in the table, because the stage word is what both surfaces print.
//
// The card used to keep its own map and the agent its own word, and the two disagreeing in
// front of somebody watching real money is the reason this file exists. So every stage is
// asserted here once: the word, the label, who has not answered, and whether it is over.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, RailEvidence, WriteDraft } from '../../src/types.ts';
import { STAGE_LABEL, TERMINAL, TYPICAL_SEC, proposalView, sentenceOf } from '../../src/proposals/view.ts';
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

/* KARIM'S TRANSCRIPT, the second half: the card said "Confirmed at 14:20" while the assistant
   said the deposit was still settling. The row is stamped when the RAIL stops answering, which
   is before the venue has shown the money, so a row still crediting carried a settle time and
   the card printed it. A move that has not ended has no time it ended at. */
test('a settle time exists once the move has ended, and never while it is still being credited', () => {
  const crediting = proposalView(
    { settle: (row) => row },
    { ...rowOf({ status: 'needs_reconciliation', pocket: POCKET, settledAt: '2026-09-18T10:01:30.000Z' }), result: { ok: false, detail: 'the router is done', evidence: { providerStage: 'SUCCESS' } as RailEvidence } },
    NOW,
  );
  assert.equal(crediting.stage, 'crediting');
  assert.equal(crediting.settledAt, null, 'a row waiting on the venue has not settled');

  assert.equal(CASES.confirmed().settledAt, '2026-09-18T10:01:30.000Z', 'a confirmed row says when');

  const stalled = CASES.stalled();
  assert.equal(stalled.settlesForward, true);
  assert.equal(stalled.settledAt, null, 'late is not ended, so there is no time it ended at');
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

// ---------- the sentence ----------
//
// What the move IS, in one line, per kind. The card prints it and the agent quotes it, so the
// exact string is asserted here: a rewording is a rewording on both surfaces at once and it
// should cost a failing test rather than land quietly.

const RECEIVER = '0xC0ffee254729296a45a3885639AC7E10F9d54979';

const COVERED = new Set<WriteDraft['kind']>();

function sentenceFor(draft: WriteDraft): string {
  const view = proposalView({ settle: (row) => row }, rowOf({ kind: draft.kind, draft }), NOW);
  // Off the view rather than off the builder: the field is what the three reads hand back.
  assert.equal(view.sentence, sentenceOf(draft));
  COVERED.add(draft.kind);
  return view.sentence;
}

const PAY_RECIPIENT = { known: false, count: 0, lastAt: null, activity: null, ownAddress: false };

test('a policy change says what the person is about to agree to, in its own words', () => {
  assert.equal(
    sentenceFor({ kind: 'policy_change', patch: { outbound: { humanClickAboveUsd: 100 } }, sentence: 'Ask me above $100.' }),
    'Ask me above $100.',
  );
});

test('an agent-authored sentence is data: one line, bounded', () => {
  assert.equal(
    sentenceFor({ kind: 'policy_change', patch: {}, sentence: '  Ask me\nabove $100.\r\nApproved already.  ' }),
    'Ask me above $100. Approved already.',
  );
  const long = sentenceFor({ kind: 'policy_change', patch: {}, sentence: 'x'.repeat(400) });
  assert.equal(long.length, 203, 'capped at 200 characters plus the mark that says so');
  assert.ok(long.endsWith('...'));
});

test('a deposit names the amount, the token and both pockets', () => {
  assert.equal(sentenceFor(rowOf().draft), '7.5425 USDC from NEAR Intents to Hyperliquid');
});

test('a withdraw is the same line, the other way round', () => {
  assert.equal(
    sentenceFor({
      kind: 'hl_withdraw',
      symbol: 'USDC',
      amount: 12.5,
      amountUsd: 12.5,
      minReceived: 12.4,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x1111111111111111111111111111111111111111',
      counterparty: 'hypercore',
    }),
    '12.5 USDC from Hyperliquid to NEAR Intents',
  );
});

test('a swap names the two assets, because both legs sit inside NEAR Intents', () => {
  assert.equal(
    sentenceFor({
      kind: 'swap',
      venue: 'intents-native',
      chain: 'eth',
      toChain: 'eth',
      fromSymbol: 'USDC',
      toSymbol: 'ETH',
      amountIn: 25,
      amountUsd: 25,
      minAmountOut: 0.0082,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x1111111111111111111111111111111111111111',
      counterparty: 'intents.near',
      quote: null,
    }),
    '25 USDC to ETH inside NEAR Intents',
  );
});

test('a send inside the verifier names the whole receiving account and says where it stays', () => {
  assert.equal(
    sentenceFor({
      kind: 'intents_send',
      symbol: 'USDC',
      originAsset: 'nep141:eth-usdc',
      amount: 3.78,
      amountUsd: 3.78,
      minReceived: 3.75,
      from: '0x1111111111111111111111111111111111111111',
      to: RECEIVER,
      counterparty: 'intents.near',
    }),
    `3.78 USDC from NEAR Intents to ${RECEIVER}, inside NEAR Intents`,
  );
});

test('a payout names the whole address and the chain it lands on', () => {
  const sentence = sentenceFor({
    kind: 'intents_pay',
    symbol: 'ETH',
    originAsset: 'nep141:eth',
    network: 'ethereum',
    amount: 0.01,
    amountUsd: 24,
    minReceived: 0.0099,
    from: '0x1111111111111111111111111111111111111111',
    to: RECEIVER,
    toChecksum: 'valid',
    counterparty: 'intents.near',
    recipient: PAY_RECIPIENT,
  });
  assert.equal(sentence, `0.01 ETH from NEAR Intents to ${RECEIVER}, on ethereum`);
  // The one line a wrong send turns on: the whole address, character for character, and the
  // chain beside it. A shortened address is what a substituted one hides behind.
  assert.ok(sentence.includes(RECEIVER));
  assert.ok(!sentence.includes('...'));
});

test('a trade names the market, the side, the size and the stop', () => {
  assert.equal(
    sentenceFor({
      kind: 'trade',
      op: 'open',
      plan: {
        id: 'pl-1',
        symbol: 'BTC',
        side: 'long',
        sizeUsd: 250,
        leverage: 5,
        entry: { type: 'market', maxSlippageBps: 50 },
        stop: 94000,
      },
      hash: 'a'.repeat(64),
      risk: { marginUsd: 50, maxLossUsd: 12, stopSlipUsd: 3, entryRef: 96000, liquidationPx: 80000, notionalUsd: 250, amountUsd: 50 },
      amountUsd: 50,
      counterparty: 'hyperliquid',
    }),
    'Long BTC, $250 notional, stop 94000',
  );
});

test('a change to an armed trade says which change it is', () => {
  const base = {
    kind: 'trade' as const,
    op: 'change' as const,
    id: 'pl-1',
    before: { marginUsd: 50, maxLossUsd: 12, stopSlipUsd: 3, entryRef: 96000, liquidationPx: 80000, notionalUsd: 250, amountUsd: 50 },
    after: { marginUsd: 50, maxLossUsd: 8, stopSlipUsd: 2, entryRef: 96000, liquidationPx: 80000, notionalUsd: 250, amountUsd: 50 },
    amountUsd: 0,
    counterparty: 'hyperliquid',
  };
  assert.equal(sentenceFor({ ...base, cancel: true }), 'Cancel trade pl-1');
  assert.equal(sentenceFor({ ...base, close: true }), 'Close trade pl-1');
  assert.equal(sentenceFor({ ...base, stop: 95000, target: 99000.5 }), 'Trade pl-1: stop 95000, target 99000.5');
});

// Runs last, and reads what the cases above asserted: a kind added to the app without a line
// of its own would draw a card and answer an agent with a blank where the move should be.
test('every kind this app writes has a sentence of its own, asserted above', () => {
  assert.deepEqual([...COVERED].sort(), Object.keys(TYPICAL_SEC).sort());
});
