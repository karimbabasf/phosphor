// The word an agent may repeat about a proposal: confirmed, settling, failed, unconfirmed,
// or pending, with a plain sentence and the pocket's before and after beside it.
//
// The persona tells the assistant to read proposal_status and quote what it finds. Before this
// the row came back raw, and a settling swap (needs_reconciliation, ok:false) read as a
// failure to anyone summarising it. The outcome names the state in one of five words, never
// invents "failed" for a row that is settling, and carries the numbers the receipt prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { outcomeOf } from '../../src/proposals/lifecycle.ts';
import type { PlanFate } from '../../src/proposals/lifecycle.ts';
import { proposalView } from '../../src/proposals/view.ts';
import type { ProposalView } from '../../src/proposals/view.ts';
import { SETTLING_SENTENCE } from '../../src/ledger/settle.ts';
import { walletReads } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { Proposal } from '../../src/types.ts';

function proposal(over: Partial<Proposal>): Proposal {
  return {
    id: 'p1',
    kind: 'swap',
    createdAt: '2026-09-15T18:00:00.000Z',
    status: 'executed',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 100, amountUsd: 100, minAmountOut: 99, from: '0xme', to: '0xme', counterparty: 'intents.near', quote: null },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    ...over,
  };
}

const pocket = { venue: 'intents' as const, account: '0xme', assetId: 'nep141:usdt.tether-token.near', symbol: 'USDT', decimals: 6, before: '5000000', after: null, floor: '99000000' };

test('an executed row is confirmed, with the rail sentence and the figures', () => {
  const out = outcomeOf(
    proposal({
      result: { ok: true, detail: 'swapped 100 USDC for 99.5 USDT inside intents.near', txids: ['0xi'] },
      balances: { beforeUsd: 5, afterUsd: 104.5 },
      pocket: { ...pocket, after: '104500000' },
    }),
  );
  assert.equal(out.state, 'confirmed');
  assert.match(out.sentence, /^Confirmed\. swapped 100 USDC for 99\.5 USDT/);
  assert.equal(out.beforeUsd, 5);
  assert.equal(out.afterUsd, 104.5);
  assert.deepEqual(out.pocket, { venue: 'intents', symbol: 'USDT', before: '5', after: '104.5' });
});

/* The lead sentence quotes the stage label the card is printing, so the agent and the window
   cannot describe the same moment in two different words. "Settling" was a word only this app
   used and nobody outside it could check. */
test('a settling row quotes the card\'s own stage label, and the word failed appears nowhere', () => {
  const out = outcomeOf(
    proposal({
      status: 'needs_reconciliation',
      result: { ok: false, detail: `${SETTLING_SENTENCE} Watched USDT for 90s; intent 0xi.`, txids: ['0xi'] },
      balances: { beforeUsd: 5, afterUsd: null },
      pocket,
    }),
  );
  assert.equal(out.state, 'settling');
  assert.match(out.sentence, /^Waiting for the venue to credit it: the transfer is done and the balance has not shown the money yet/);
  assert.match(out.sentence, /Nothing more is signed until it does/);
  assert.doesNotMatch(out.sentence, /fail/i);
  assert.equal(out.afterUsd, null, 'not read is not zero');
  assert.deepEqual(out.pocket, { venue: 'intents', symbol: 'USDT', before: '5', after: null });
});

test('a row the boot sweep stranded with no pocket is unconfirmed, not settling', () => {
  const out = outcomeOf(
    proposal({
      status: 'needs_reconciliation',
      result: { ok: false, detail: 'Phosphor stopped while this was executing and no transaction hash was recorded, so it may or may not have sent.', txids: [] },
    }),
  );
  assert.equal(out.state, 'unconfirmed');
  assert.match(out.sentence, /Still checking; read it again for the latest/);
  assert.doesNotMatch(out.sentence, /send it again/i);
});

test('a failed row is failed with the rail sentence; a refused one is failed and says nothing was signed', () => {
  const failed = outcomeOf(proposal({ status: 'failed', result: { ok: false, detail: '1click reported REFUNDED after the intent was submitted', txids: ['0xi'] } }));
  assert.equal(failed.state, 'failed');
  assert.match(failed.sentence, /^Failed\. 1click reported REFUNDED/);
  const refused = outcomeOf(proposal({ status: 'policy_refused', verdict: { outcome: 'refuse', rule: 'r', reasons: ['too big'] } }));
  assert.equal(refused.state, 'failed');
  assert.match(refused.sentence, /refused by policy and nothing was signed/);
});

test('a row still running is unconfirmed; a pending one is pending', () => {
  assert.equal(outcomeOf(proposal({ status: 'executing' })).state, 'unconfirmed');
  const pending = outcomeOf(proposal({ status: 'pending_unlock', verdict: { outcome: 'needs_approval', reasons: [] } }));
  assert.equal(pending.state, 'pending');
  assert.match(pending.sentence, /pending unlock/);
});

test('a trade proposal takes its word from the plan the runner holds', () => {
  const armed = proposal({ kind: 'trade', status: 'executed', result: { ok: true, detail: 'armed', txids: [] } });
  assert.equal(outcomeOf(armed, { status: 'waiting' }).state, 'confirmed');
  assert.equal(outcomeOf(armed, { status: 'placed' }).state, 'unconfirmed', 'sent and not read back yet');
  assert.equal(outcomeOf(armed, { status: 'placed', confirm: { state: 'unconfirmed', venueStatus: null } }).state, 'unconfirmed');
  const resting = outcomeOf(armed, { status: 'placed', confirm: { state: 'resting', venueStatus: 'open' } });
  assert.equal(resting.state, 'confirmed');
  assert.match(resting.sentence, /The venue reports the entry open/);
  assert.equal(outcomeOf(armed, { status: 'open' }).state, 'confirmed');
  const rejected = outcomeOf(armed, { status: 'done', endReason: 'failed:the venue rejected the entry (perpMarginRejected)' });
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.sentence, /perpMarginRejected/);
  assert.equal(outcomeOf(armed, { status: 'done', endReason: 'targeted' }).state, 'confirmed');
  assert.equal(outcomeOf(armed, { status: 'done', endReason: 'cancelled' }).state, 'failed');
});

// ---------- the read door ----------

function captured(): { res: http.ServerResponse; body: () => unknown } {
  let text = '';
  const res = {
    writeHead() {
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, body: () => JSON.parse(text) };
}

/* proposal_status answers with the ProposalView and nothing beside it. It used to answer with
   the whole row plus an `outcome` blob, and the card built a second opinion out of the same
   fields: that pair is what put "Confirmed at 14:20" on screen beside "still settling". The one
   word an agent may repeat is still here, as `outcome` on the view, next to the stage word both
   surfaces print. */
test('proposal_status answers with the view, carrying the stage and the outcome word', async () => {
  const settling = proposal({
    id: 'swap-1',
    status: 'needs_reconciliation',
    result: { ok: false, detail: SETTLING_SENTENCE, txids: ['0xi'] },
    balances: { beforeUsd: 5, afterUsd: null },
    pocket,
  });
  const trade = proposal({ id: 'trade-1', kind: 'trade', status: 'executed', result: { ok: true, detail: 'armed', txids: [] } });
  const rows = new Map([
    [settling.id, settling],
    [trade.id, trade],
  ]);
  const plans: PlanFate[] = [{ status: 'placed', confirm: { state: 'unconfirmed', venueStatus: null } }];
  const ctx = {
    proposals: {
      get: (id: string) => rows.get(id),
      view: (p: Proposal) => proposalView({ settle: (row) => row, plan: () => (p.kind === 'trade' ? plans[0] : null) }, p),
    },
  } as unknown as Ctx;

  const a = captured();
  await walletReads.proposal_status(ctx, {}, { id: 'swap-1' }, a.res);
  const swap = a.body() as ProposalView;
  assert.equal(swap.stage, 'crediting');
  assert.equal(swap.stageLabel, 'Waiting for the venue to credit it');
  assert.equal(swap.outcome, 'settling');
  assert.equal(swap.terminal, false);
  assert.equal(swap.money.beforeUsd, 5);
  assert.equal(swap.money.afterUsd, null);
  assert.equal((swap as unknown as { draft?: unknown }).draft, undefined, 'the row itself does not ride along any more');

  const b = captured();
  await walletReads.proposal_status(ctx, {}, { id: 'trade-1' }, b.res);
  const armed = b.body() as ProposalView;
  assert.equal(armed.stage, 'confirmed');
  assert.equal(armed.outcome, 'unconfirmed', "the plan's own fate is what a trade row reports");
});
