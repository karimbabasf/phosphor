// Why a move stopped, in one plain sentence chosen by the cause, and the four states a person
// reads it in.
//
// The card printed "A rule you set stopped it" under every refusal, including the app's own
// (nobody quoted a price, the price moved), because the sentence was keyed on the status
// (recon R1 c). And a FAILED swap whose input never left read "held by 1Click under handle",
// because nothing read the balance before choosing the words (R1 a). The code is the cause now,
// the sentence comes from one table in the view, and a proven "nothing left" closes the row.
//
// Run: node --test tests/unit/swap-reasons.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, RailResult, WriteDraft } from '../../src/types.ts';
import { REASON_CODES } from '../../src/rails/reasons.ts';
import type { ReasonCode } from '../../src/rails/reasons.ts';
import { moveStateOf, proposalView, reasonSentence, shortIds, STAGE_LABEL } from '../../src/proposals/view.ts';
import type { MoveState, ProposalStage } from '../../src/proposals/view.ts';
import { landed, makeCtx, railThat } from './helpers/proposals.ts';

const SELF = '0x1111111111111111111111111111111111111111';
const SWAP: WriteDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'eth',
  toChain: 'btc',
  fromSymbol: 'ETH',
  toSymbol: 'BTC',
  amountIn: 0.0015,
  amountInExact: '0.0015',
  amountUsd: 4,
  minAmountOut: 0,
  from: SELF,
  to: SELF,
  counterparty: 'intents.near',
  quote: null,
};
const NEAR_SWAP: WriteDraft = { ...SWAP, chain: 'near', toChain: 'eth', fromSymbol: 'wNEAR', toSymbol: 'WBTC' };

const NOW = Date.parse('2026-09-23T20:30:00.000Z');

// The two long dashes, by code point, so this file carries neither.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

function rowOf(over: Partial<Proposal>): Proposal {
  return {
    id: 'c28e9ae0',
    kind: 'swap',
    createdAt: '2026-09-23T20:19:17.000Z',
    status: 'pending',
    draft: SWAP,
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: [] },
    ...over,
  };
}

const view = (over: Partial<Proposal>) => proposalView({ settle: (row) => row }, rowOf(over), NOW);

// ---------- the words ----------

const BANNED = [/\bfloor\b/i, /\bsolver\b/i, /\bhandle\b/i, /simulation/i, /1click/i, /\bdraft\b/i, /base units/i, /verifier/i, /\bintent\b/i];

test('every code has one plain sentence: no jargon, no long dashes, short, and ending in a full stop', () => {
  for (const code of REASON_CODES) {
    for (const draft of [SWAP, NEAR_SWAP]) {
      const sentence = reasonSentence(code, draft);
      assert.ok(sentence.length > 0 && sentence.length <= 260, `${code}: ${sentence.length} characters`);
      assert.match(sentence, /[.]$/, `${code} ends in a full stop`);
      assert.doesNotMatch(sentence, DASHES, `${code} carries a long dash`);
      for (const word of BANNED) assert.doesNotMatch(sentence, word, `${code} says ${word}: ${sentence}`);
    }
  }
  assert.equal(reasonSentence('venue_failed_nothing_moved', NEAR_SWAP), "The swap didn't go through. Nothing left your balance.");
  assert.match(reasonSentence('insufficient_balance', NEAR_SWAP), /that much NEAR/, 'NEAR, never wNEAR');
});

test('a refusal the app made never says a rule you set stopped it; one the person set says their rule did', () => {
  // c28e9ae0 as filed today: the builder, not the policy, and no price for BTC.
  const noPrice = view({
    status: 'policy_refused',
    verdict: { outcome: 'refuse', reasons: ['Nobody offered a price for ETH to BTC right now, so no floor could be set. Try again in a minute.'], rule: 'invalid_draft', reasonCodes: ['no_price'] },
  });
  assert.equal(noPrice.state, 'didnt_go_through');
  assert.equal(noPrice.reason?.code, 'no_price');
  assert.doesNotMatch(noPrice.stageCopy, /rule you set/i);
  assert.match(noPrice.stageCopy, /Bitcoin itself can't be held here/);
  assert.match(noPrice.reason?.details ?? '', /Nobody offered a price/);

  // 78c16328: the price moved between the two quotes.
  const moved = view({
    status: 'policy_refused',
    verdict: { outcome: 'refuse', reasons: ['Simulation failed, so nothing is signed: the solver floor of 3.864737 USDC is below the draft floor of 3.86507'], rule: 'simulation_required', reasonCodes: ['price_moved'] },
  });
  assert.equal(moved.reason?.code, 'price_moved');
  assert.equal(moved.stageCopy, 'The price moved while we checked, so nothing happened and nothing moved. Ask again for a fresh price.');

  // A row written before codes existed still never blames the person for the app's refusal.
  const legacy = view({ status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['no price'], rule: 'simulation_required' } });
  assert.equal(legacy.reason?.code, 'simulation_failed');
  assert.doesNotMatch(legacy.stageCopy, /rule you set/i);

  // The person's own cap.
  const cap = view({ status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['Within every limit.', 'Never more than $50 in one move.'], rule: 'max_per_transaction', reasonCodes: ['max_per_transaction'] } });
  assert.equal(cap.reason?.code, 'over_trade_cap');
  assert.match(cap.stageCopy, /over your limit for one move/);
  assert.equal(cap.reason?.details, 'Never more than $50 in one move.');
  assert.match(cap.error?.message ?? '', /^That's over your limit for one move, so nothing moved\..*Never more than \$50 in one move\.$/);

  const kill = view({ status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['The kill switch is on.'], rule: 'kill_switch', reasonCodes: ['kill_switch'] } });
  assert.equal(kill.reason?.code, 'kill_switch');
});

test('a failure reads the cause the rail recorded, and keeps the venue text and ids behind details, cut to their ends', () => {
  const handle = '840ade2d6a0f3a5b8d9c4e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b59da';
  const failed = view({
    status: 'failed',
    draft: NEAR_SWAP,
    decidedAt: '2026-09-23T20:20:26.000Z',
    settledAt: '2026-09-23T20:21:07.000Z',
    result: {
      ok: false,
      reason: 'venue_failed_nothing_moved',
      detail: `1click reported FAILED (reason not given) and nothing left the balance: the wNEAR balance reads 0.8947 against 0.8947 before the swap; quote handle ${handle}, account ${SELF}.`,
      txids: ['9g9Swr3scn4mnfQD8RMCyV6zpeJNJsAiKxfEabFbUSQD'],
      evidence: { handle, providerStage: 'FAILED' },
    },
  });
  assert.equal(failed.state, 'didnt_go_through');
  assert.equal(failed.reason?.sentence, "The swap didn't go through. Nothing left your balance.");
  assert.equal(failed.stageCopy, failed.reason?.sentence);
  assert.ok(failed.reason?.details?.includes('840ade2d...2a3b59da'), failed.reason?.details ?? '');
  assert.ok(!failed.reason?.details?.includes(handle), 'a whole 64-hex handle reached the details');
  assert.ok(failed.reason?.details?.includes(SELF), 'an address is not a hash and stays whole');
  assert.doesNotMatch(failed.stageCopy, /held by 1Click|Do not send/);
});

test('rows written before codes existed say only what their own fields prove', () => {
  // A FAILED row still open, with the rail's destination read and no cause: nothing proven.
  const open = view({
    status: 'needs_reconciliation',
    draft: NEAR_SWAP,
    result: { ok: false, detail: '1click reported FAILED and refunded 0 wNEAR so far; the input is held by 1Click under handle h', txids: ['i'], evidence: { handle: 'h', providerStage: 'FAILED' } },
    pocket: { venue: 'intents', account: SELF, assetId: 'nep141:eth.omft.near', symbol: 'WBTC', decimals: 8, before: '0', after: '0', floor: '1' },
  });
  assert.equal(open.reason?.code, 'stuck_unknown');
  assert.equal(open.reason?.sentence, "Still checking whether this went through. I'll update it here.");

  // A failed row with nothing sent at all: the executor's own proof nothing moved.
  const unsent = view({ status: 'failed', result: { ok: false, detail: 'swap rail threw: the quote timed out' } });
  assert.equal(unsent.reason?.code, 'not_sent');
  assert.equal(unsent.reason?.sentence, "The swap didn't go through. Nothing left your balance.");

  const refunded = view({ status: 'failed', result: { ok: false, detail: '1click reported REFUNDED: 1 went back', txids: ['x'], evidence: { handle: 'h', providerStage: 'REFUNDED' } } });
  assert.equal(refunded.reason?.code, 'refunded');
});

test('shortIds cuts 64-hex hashes and long base58 the way the card does, and leaves addresses whole', () => {
  const hex = 'a'.repeat(64);
  assert.equal(shortIds(`h ${hex} x`), `h ${'a'.repeat(8)}...${'a'.repeat(8)} x`);
  assert.equal(shortIds(`0x${hex}`), `0x${'a'.repeat(6)}...${'a'.repeat(8)}`);
  assert.equal(shortIds(SELF), SELF);
  assert.equal(shortIds('9g9Swr3scn4mnfQD8RMCyV6zpeJNJsAiKxfEabFbUSQD'), '9g9Swr3scn4mnfQD8RMCyV6zpeJNJsAiKxfEabFbUSQD');
});

// ---------- the four states and late ----------

test('twenty-three stage words fold into four states a person reads', () => {
  const expected: Record<MoveState, ProposalStage[]> = {
    needs_you: ['waiting_for_you', 'waiting_for_unlock', 'waiting_for_touch'],
    done: ['confirmed'],
    didnt_go_through: ['failed', 'declined', 'refused', 'REFUNDED', 'FAILED'],
    working: ['held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'PENDING', 'TX_BROADCASTED', 'SETTLED', 'NOT_FOUND_OR_NOT_VALID', 'crediting', 'stalled'],
    // No stage: only a cause says money is on its way back (plainStateOf).
    coming_back: [],
  };
  const all = Object.values(expected).flat().sort();
  assert.deepEqual(all, Object.keys(STAGE_LABEL).sort(), 'every stage has exactly one state');
  for (const [state, stages] of Object.entries(expected)) for (const stage of stages) assert.equal(moveStateOf(stage), state, stage);
});

/* EVERY CAUSE, THE STATE ITS SENTENCE SAYS. The card printed "Didn't go through" over "Still
   checking whether this went through", over a refund on its way and over a swap that went through
   short, and a person who read the state could try again and pay twice (hunt A, 2026-09-23). Each
   code is drawn on the row that carries it, in the stage that used to decide the word. */
test('every reason code maps to a plain state that agrees with its sentence', () => {
  const AGREES: Record<ReasonCode, [MoveState, RegExp]> = {
    needs_approval: ['needs_you', /waits for your OK/],
    over_trade_cap: ['didnt_go_through', /nothing moved/],
    over_daily_cap: ['didnt_go_through', /nothing moved/],
    kill_switch: ['didnt_go_through', /nothing moved/],
    policy_rule: ['didnt_go_through', /nothing moved/],
    rules_unreadable: ['didnt_go_through', /nothing can move/],
    unpriced: ['didnt_go_through', /Nothing moved/],
    no_price: ['didnt_go_through', /nothing moved/],
    price_moved: ['didnt_go_through', /nothing moved/],
    insufficient_balance: ['didnt_go_through', /nothing moved/],
    balance_unread: ['didnt_go_through', /nothing moved/],
    below_minimum: ['didnt_go_through', /nothing moved/],
    unsupported_asset: ['didnt_go_through', /nothing moved/],
    ambiguous_asset: ['didnt_go_through', /nothing moved/],
    simulation_failed: ['didnt_go_through', /nothing moved/],
    invalid_request: ['didnt_go_through', /nothing moved/],
    not_available: ['didnt_go_through', /nothing moved/],
    plan_exists: ['didnt_go_through', /nothing new was placed/],
    declined: ['didnt_go_through', /Nothing moved/],
    not_sent: ['didnt_go_through', /didn't go through\. Nothing left/],
    venue_failed_nothing_moved: ['didnt_go_through', /didn't go through\. Nothing left/],
    venue_failed_watching: ['working', /^Still checking this swap\. Your NEAR hasn't moved so far/],
    venue_failed_refund_pending: ['coming_back', /until it comes back to your balance/],
    refunded: ['didnt_go_through', /sent your NEAR back/],
    short_fill: ['done', /went through, but/],
    stuck_unknown: ['working', /^Still checking whether this went through/],
  };
  const REFUSALS = new Set<ReasonCode>(['over_trade_cap', 'over_daily_cap', 'kill_switch', 'policy_rule', 'rules_unreadable', 'unpriced', 'no_price', 'price_moved', 'insufficient_balance', 'balance_unread', 'below_minimum', 'unsupported_asset', 'ambiguous_asset', 'simulation_failed', 'invalid_request', 'not_available', 'plan_exists']);
  const ENDED = new Set<ReasonCode>(['not_sent', 'venue_failed_nothing_moved', 'refunded']);
  const rowFor = (code: ReasonCode): Partial<Proposal> => {
    if (code === 'needs_approval') return { status: 'pending' };
    if (code === 'declined') return { status: 'refused', decidedBy: 'human' };
    if (REFUSALS.has(code)) return { status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['refused'], rule: 'invalid_draft', reasonCodes: [code] } };
    const stage = code === 'venue_failed_refund_pending' ? 'REFUNDED' : 'FAILED';
    return { status: ENDED.has(code) ? 'failed' : 'needs_reconciliation', result: { ok: false, detail: 'the rail said so', txids: ['h1'], reason: code, evidence: { handle: 'dep-1', providerStage: stage } } };
  };
  assert.deepEqual(Object.keys(AGREES).sort(), [...REASON_CODES].sort(), 'every code has a row here');
  for (const code of REASON_CODES) {
    const v = view({ draft: NEAR_SWAP, ...rowFor(code) });
    const [state, says] = AGREES[code];
    assert.equal(v.reason?.code, code, code);
    assert.equal(v.state, state, `${code}: ${v.reason?.sentence}`);
    assert.match(v.reason?.sentence ?? '', says, code);
  }
});

test('a move still checking is working and late, a refund on its way is its own state, and a short fill is done with the amount that arrived', () => {
  const checking = view({ status: 'needs_reconciliation', decidedAt: new Date(NOW - 20_000).toISOString(), result: { ok: false, detail: 'unconfirmed', txids: ['h1'], reason: 'stuck_unknown', evidence: { handle: 'dep-1', providerStage: 'FAILED' } } });
  assert.equal(checking.state, 'working');
  assert.deepEqual(checking.late, { elapsedSec: 20, typicalSec: 45 }, 'late from the start: the rail already gave up on its answer');
  assert.equal(checking.stageCopy, checking.reason?.sentence);
  assert.equal(checking.reason?.retry, false);

  const refund = view({ status: 'needs_reconciliation', result: { ok: false, detail: 'refund pending', txids: ['h1'], reason: 'venue_failed_refund_pending', evidence: { handle: 'dep-1', providerStage: 'REFUNDED' } } });
  assert.equal(refund.state, 'coming_back');
  assert.equal(refund.late, null);
  assert.equal(refund.reason?.retry, false);

  const pocket = { venue: 'intents' as const, account: SELF, assetId: 'nep141:wbtc', symbol: 'WBTC', decimals: 8, before: '100000', after: '134000', floor: '35000' };
  const short = view({ status: 'failed', draft: NEAR_SWAP, pocket, result: { ok: false, detail: 'short', txids: ['h1'], reason: 'short_fill', evidence: { handle: 'dep-1', providerStage: 'FAILED' } } });
  assert.equal(short.state, 'done');
  assert.equal(short.reason?.sentence, 'The swap went through, but only 0.00034 WBTC arrived, less than the 0.00035 you approved.');
  assert.equal(short.note, short.reason?.sentence);
});

test('a move still working past its usual time is late, with the seconds since the click', () => {
  const executing = { status: 'executing' as const, decidedAt: new Date(NOW - 60_000).toISOString() };
  assert.deepEqual(view(executing).late, { elapsedSec: 60, typicalSec: 45 });
  assert.equal(view({ ...executing, decidedAt: new Date(NOW - 30_000).toISOString() }).late, null, 'inside the usual time is not late');
  assert.equal(view({ status: 'pending', createdAt: new Date(NOW - 3_600_000).toISOString() }).late, null, 'waiting for a person is never late');
  assert.equal(view({ status: 'executed', decidedAt: new Date(NOW - 600_000).toISOString(), settledAt: new Date(NOW - 590_000).toISOString() }).late, null);
  assert.equal(view(executing).state, 'working');
  assert.equal(view({ status: 'pending' }).reason?.code, 'needs_approval');
});

// ---------- the executor keeps the proof ----------

function railAnswering(result: RailResult) {
  return railThat('swap', async () => result);
}

test('a venue failure the rail proved cost nothing closes the row as failed and charges nothing to the day', async () => {
  const h = makeCtx({
    rails: [railAnswering({ ok: false, reason: 'venue_failed_nothing_moved', detail: '1click reported FAILED and nothing left the balance', txids: ['intent-h'], evidence: { handle: 'dep-1', providerStage: 'FAILED' } })],
  });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 10, minAmountOut: 9.9 }));
  assert.equal(p.status, 'failed');
  assert.equal(p.result?.reason, 'venue_failed_nothing_moved');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 0, 'money that never left is not spent');
  const v = h.svc.view(p);
  assert.equal(v.state, 'didnt_go_through');
  assert.equal(v.stageCopy, "The swap didn't go through. Nothing left your balance.");
});

test('a venue failure the rail could not prove stays open, counts against the day, and says it cannot tell yet', async () => {
  const h = makeCtx({
    rails: [railAnswering({ ok: false, reason: 'stuck_unknown', detail: '1click reported FAILED; whether the input left is not confirmed', txids: ['intent-h'], evidence: { handle: 'dep-1', providerStage: 'FAILED' } })],
  });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 10, minAmountOut: 9.9 }));
  assert.equal(p.status, 'needs_reconciliation');
  assert.equal(p.result?.reason, 'stuck_unknown');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10);
  assert.equal(h.svc.view(p).reason?.sentence, "Still checking whether this went through. I'll update it here.");
});

test('a rail that stopped before signing names its cause on the failed row', async () => {
  const err = Object.assign(new Error('the balance inside intents.near holds 5 USDT, less than the 10 USDT this swap spends; nothing was signed'), { reason: 'insufficient_balance' });
  const h = makeCtx({
    rails: [
      railThat('swap', async () => {
        throw err;
      }),
    ],
  });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 10, minAmountOut: 9.9 }));
  assert.equal(p.status, 'failed');
  assert.equal(p.result?.reason, 'insufficient_balance');
  assert.equal(h.svc.view(p).reason?.code, 'insufficient_balance');
});
