// Four things the second UI sweep found the backend saying two ways (L2, items 11 to 14).
//
// A failed row with a venue handle read "Still checking whether this went through" beside "Ended
// at"; a refused send pointed at "the window"; a payout named its network by id ("on eth"); and
// the network registry kept a colour table beside the window's own.
//
// Run: node --test tests/unit/card-truths.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, WriteDraft } from '../../src/types.ts';
import type { OneClickStatus } from '../../src/intents.ts';
import type { IntentsActivity } from '../../src/chainscan/index.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { RECEIVE_NETWORKS, SPEND_NETWORKS } from '../../src/rails/intents-address.ts';
import { STAGE_COPY, proposalView, reasonSentence, sentenceOf } from '../../src/proposals/view.ts';
import { SELF_EVM, makeCtx } from './helpers/proposals.ts';

const SWAP: WriteDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'near',
  toChain: 'near',
  fromSymbol: 'wNEAR',
  toSymbol: 'USDC',
  amountIn: 1,
  amountUsd: 4,
  minAmountOut: 3.9,
  from: SELF_EVM,
  to: SELF_EVM,
  counterparty: 'intents.near',
  quote: null,
};

// A row closed as failed with a venue handle and no cause, from before causes were written.
function closedUnknown(): Proposal {
  return {
    id: 'old-1',
    kind: 'swap',
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    decidedAt: new Date(Date.now() - 600_000).toISOString(),
    settledAt: new Date(Date.now() - 590_000).toISOString(),
    status: 'failed',
    draft: SWAP,
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedBy: 'policy',
    result: { ok: false, detail: '1click reported FAILED', txids: ['intent-h'], evidence: { handle: 'dep-1', providerStage: 'FAILED' } },
  };
}

// ---------- 11: one truth on a failed card ----------

test('a failed row still being checked says so everywhere: working, the checking sentence, and no end time', () => {
  const v = proposalView({ settle: (p) => p }, closedUnknown());
  assert.equal(v.reason?.code, 'stuck_unknown');
  assert.equal(v.state, 'working');
  assert.equal(v.stageCopy, "Still checking whether this went through. I'll update it here.");
  assert.equal(v.settledAt, null, 'no "Ended at" under a move that is still being checked');
  assert.equal(v.tookSec, null);
});

test('and it is being checked: the sweep asks the venue by its handle and writes the answer with its cause', async () => {
  const quiet: IntentsActivity = {
    account: SELF_EVM.toLowerCase(),
    ok: true,
    rows: [{ cause: 'TRANSFER', token: 'wNEAR', tokenId: 'nep141:wrap.near', delta: '+1', counterparty: 'solver.near', hash: 'h0', time: new Date(Date.now() - 3_600_000).toISOString() }],
    balances: null,
    partial: false,
    source: 'nearblocks',
    explorer: null,
    note: '',
  };
  const rails: RailRegistry = {
    for: () => null,
    kinds: () => [],
    swap: { tokens: async () => [], balance: async () => null, activity: async () => quiet },
  };
  const failed: OneClickStatus = { found: true, status: 'FAILED', reported: 'FAILED', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], refundedAmount: '0' };
  const asked: string[] = [];
  const h = makeCtx({
    deps: {
      rails,
      oneClickStatus: async (handle: string) => {
        asked.push(handle);
        return failed;
      },
    },
  });
  h.store.put(closedUnknown());
  assert.equal(await h.svc.reconcileOpen(), 0, 'the status stays failed');
  assert.deepEqual(asked, ['dep-1']);
  const row = h.store.get('old-1');
  assert.equal(row?.result?.reason, 'venue_failed_nothing_moved', 'the ledger showed nothing left, and now the row says why');
  assert.equal(proposalView({ settle: (p) => p }, row!).state, 'didnt_go_through');
});

// ---------- 12: the refused sentence ----------

test('a refusal by a rule says where it changes, Vault under Policies, never "the window"', () => {
  assert.equal(reasonSentence('policy_rule', SWAP), 'One of your rules stopped this, so nothing moved. Change it in Vault, under Policies, if you want it to go.');
  assert.equal(STAGE_COPY.refused, 'A rule you set stopped it. Nothing moved. Change it in Vault, under Policies, if you want it to go.');
  assert.equal(reasonSentence('over_trade_cap', SWAP), "That's over your limit for one move, so nothing moved. Ask for less, or ask me to raise the limit; your limits are in Vault, under Policies.");
  for (const code of ['over_trade_cap', 'over_daily_cap', 'kill_switch', 'policy_rule', 'rules_unreadable'] as const) {
    assert.doesNotMatch(reasonSentence(code, SWAP), /the window/, code);
  }
});

// ---------- 13: the payout sentence ----------

test('a payout names the network it lands on in words, never its id', () => {
  const pay = {
    kind: 'intents_pay',
    network: 'eth',
    symbol: 'USDC',
    amount: 25,
    amountUsd: 25,
    to: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  } as unknown as WriteDraft;
  assert.match(sentenceOf(pay), /, on Ethereum$/);
  assert.doesNotMatch(sentenceOf(pay), /on eth$/);
});

// ---------- 14: one colour table ----------

test('the network registry carries no colour: the window keys its one colour table by the mark', () => {
  for (const n of [...RECEIVE_NETWORKS, ...SPEND_NETWORKS]) {
    assert.equal('colour' in n, false, n.id);
    assert.ok(n.mark !== '', `${n.id} has a mark to take its colour from`);
  }
});
