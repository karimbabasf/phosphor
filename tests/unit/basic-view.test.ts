// Basic view is the screen a non-technical person makes a money decision on, so these
// tests are mostly about what it REFUSES to say: no fabricated balance, no truncated
// address, no destination left off, and never a zero standing in for an unknown.
//
// The sharpest one is "renders every destination the approval rests on". Asserting the
// amount alone would not have caught F2, where the amount was correct and the funds
// went to a solver-chosen deposit address behind the words "your wallet".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBasic } from '../../src/view/basic.ts';
import type { BasicInput, PriceReading } from '../../src/view/basic.ts';
import type {
  LogEvent,
  Proposal,
  SwapDraft,
  TradeDraft,
  WalletRow,
  WriteDraft,
} from '../../src/types.ts';

const SELF = '0x2dd9131edF3CC393B757463C85b2C870A6F3180a';
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const SOLVER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x9999999999999999999999999999999999999999';

const T0 = '2026-08-12T10:00:00.000Z';
const T1 = '2026-08-12T11:00:00.000Z';
const T2 = '2026-08-12T12:00:00.000Z';


function baseInput(over: Partial<BasicInput> = {}): BasicInput {
  return {
    wallet: { rows: [], totalUsd: 2341.08, byChain: { arb: 2000, eth: 341.08 }, stale: [], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] },
    proposals: [],
    policyReadable: true,
    killSwitch: false,

    agentsConnected: 1,
    readAt: T2,
    selfAddresses: [SELF],
    prices: [],
    events: [],
    ...over,
  };
}

// A 24-bar window that rises, so a series is present without every test writing one out.
function closes(last: number): number[] {
  return Array.from({ length: 24 }, (_, i) => last * (0.94 + (i * 0.06) / 23));
}

function reading(over: Partial<NonNullable<PriceReading>> = {}): PriceReading {
  return { product: 'ETH-USD', priceUsd: 3184.22, changePct: 1.44, closes: closes(3184.22), ...over };
}

function toolCall(ts: string, data: Record<string, unknown>): LogEvent {
  return { ts, type: 'tool_call', msg: 'agent: something a developer reads', data };
}

function swapDraft(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-native',
    chain: 'arb',
    toChain: 'arb',
    fromSymbol: 'USDC',
    toSymbol: 'WETH',
    amountIn: 105,
    amountUsd: 105,
    minAmountOut: 0.02,
    from: SELF,
    to: SELF,
    counterparty: ROUTER,
    quote: null,
    ...over,
  };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  const draft: WriteDraft = over.draft ?? swapDraft();
  return {
    id: 'p-1',
    kind: draft.kind,
    createdAt: T1,
    status: 'pending',
    draft,
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
    ...over,
  };
}

// ---------- the eleven states ----------

const ELEVEN: Array<[string, BasicInput]> = [
  ['resting', baseInput()],
  ['asking', baseInput({ proposals: [proposal()] })],
  ['working', baseInput({ proposals: [proposal({ status: 'executing' })] })],
  ['executed', baseInput({ proposals: [proposal({ status: 'executed', decidedAt: T1 })] })],
  ['human refused', baseInput({ proposals: [proposal({ status: 'refused', decidedAt: T1 })] })],
  ['policy refused', baseInput({ proposals: [proposal({ status: 'policy_refused', decidedAt: T1 })] })],
  ['kill switch', baseInput({ killSwitch: true })],
  ['policy unreadable', baseInput({ policyReadable: false })],
  ['no agent', baseInput({ agentsConnected: 0 })],
  ['chain read failed', baseInput({ wallet: { rows: [], totalUsd: 0, byChain: {}, stale: ['near'], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] } })],
];

test('every one of the eleven states produces copy', () => {
  for (const [name, input] of ELEVEN) {
    const view = buildBasic(input);
    assert.ok(view.headline.trim().length > 0, `${name} rendered an empty headline`);
    assert.ok(view.footer.trim().length > 0, `${name} rendered an empty footer`);
    // The hero's slot is empty in exactly one state: an unknown total that reads as nothing.
    // Then the state line carries the words, and the slot shows no number rather than a zero.
    assert.ok(
      view.totalLine.trim().length > 0 || (view.checkingLine !== null && input.wallet.totalUsd === 0),
      `${name} rendered an empty total line with nothing under it`,
    );
    assert.ok(view.agentLine.trim().length > 0, `${name} rendered an empty agent line`);
  }
});

test('each state lands on the tone the spec assigns it', () => {
  const toneOf = (name: string) => buildBasic(ELEVEN.find(([n]) => n === name)![1]).tone;
  assert.equal(toneOf('resting'), 'calm');
  assert.equal(toneOf('asking'), 'asking');
  assert.equal(toneOf('working'), 'working');
  assert.equal(toneOf('policy refused'), 'stopped');
  assert.equal(toneOf('kill switch'), 'frozen');
  assert.equal(toneOf('policy unreadable'), 'broken');
});

test('the kill switch outranks everything, including a pending question', () => {
  const view = buildBasic(baseInput({ killSwitch: true, proposals: [proposal()] }));
  assert.equal(view.tone, 'frozen');
  assert.equal(view.ask, null, 'a frozen app must not present a button that cannot work');
});

test('a policy refusal says what was tried, that it was stopped, and that money did not move', () => {
  const view = buildBasic(baseInput({ proposals: [proposal({ status: 'policy_refused', decidedAt: T1 })] }));
  assert.match(view.headline, /Phosphor stopped it/);
  assert.match(view.headline, /did not move/);
  assert.match(view.headline, /105/, 'the refusal has to name the amount that was tried');
});

// ---------- what it refuses to say ----------

test('a stale chain shows no number at all, never a zero', () => {
  const view = buildBasic(baseInput({ wallet: { rows: [], totalUsd: 0, byChain: {}, stale: ['near'], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] } }));
  assert.equal(view.totalUsd, null);
  // The words go under the number, never into its slot: the slot is empty here because
  // the unknown total reads as nothing, and an empty slot beats a zero standing in for it.
  assert.equal(view.totalLine, '');
  assert.equal(view.checkingLine, 'Still checking.');
});

test('a stale chain keeps the last read total in the slot when there is one', () => {
  const row = walletRow({ chain: 'arb', quantity: 2000, valueUsd: 2000, share: 1 });
  const view = buildBasic(baseInput({ wallet: { rows: [row], totalUsd: 2000, byChain: { arb: 2000 }, stale: ['near'], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] } }));
  assert.equal(view.totalUsd, null, 'the number is not fact while a place is unread');
  assert.match(view.totalLine, /2,000\.00/);
  assert.equal(view.checkingLine, 'Still checking.');
});

test('a holding the app cannot price keeps the hero from reading as a whole number', () => {
  // The chat card of 2026-09-20 read "$0.00" over 2.0097 wNEAR; the basic screen's hero
  // prints the same total, so it says what the number is: a floor, or no figure at all.
  const priced = walletRow({ chain: 'intents', symbol: 'USDC', quantity: 7.01, valueUsd: 7.01, share: 1 });
  const dark = walletRow({ chain: 'intents', symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priceUsd: 0, share: 0, priced: false });
  const some = buildBasic(baseInput({ wallet: { rows: [priced, dark], totalUsd: 7.01, byChain: { intents: 7.01 }, stale: [], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: ['wNEAR'] } }));
  assert.equal(some.totalLine, 'at least $7.01');
  assert.match(some.placesLine, /wNEAR not priced/);
  const none = buildBasic(baseInput({ wallet: { rows: [dark], totalUsd: 0, byChain: { intents: 0 }, stale: [], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: ['wNEAR'] } }));
  assert.equal(none.totalLine, 'not priced');
});

test('a balance read before the last execution is not stated as fact', () => {
  // The ledger cache serves pre-trade balances after a write and still reports stale: [].
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'executed', decidedAt: T2 })],
      readAt: T0, // fetched an hour BEFORE the execution
    }),
  );
  assert.equal(view.totalUsd, null);
  // The last read total stays in the hero's slot and the sentence sits under it. Karim's
  // screenshot of 2026-09-14 had the sentence in the balance type, and it never left.
  assert.match(view.totalLine, /2,341\.08/);
  assert.equal(view.checkingLine, 'Checking your new balance.');
  assert.match(view.headline, /Checking your new balance/);
});

/* 2026-09-19, watching a real deposit settle at 1440: for the three seconds between the credit
   and the next balance read, the panel said "Nothing here yet. Open Money in and send something
   to one of your addresses." to somebody holding $4,010 who had just deposited $250. The list
   was emptied on the same condition that nulls the total, and the two are not the same question:
   a place that could not be read leaves a list that lies about what is there, while a read taken
   a moment before the write is the truth as of a moment ago, with a line under it saying so. */
test('a read that predates the last write still lists what it read; a place that could not be read does not', () => {
  const held = {
    rows: [{ kind: 'intents' as const, chain: 'intents' as const, symbol: 'USDC', tokenId: 'usdc', quantity: 1850, priceUsd: 1, valueUsd: 1850, share: 1, native: false }],
    totalUsd: 1850,
    byChain: { intents: 1850 },
    stale: [],
    emptyCount: 0,
    dustCount: 0,
    dustUsd: 0, unpriced: [],
  };
  const checking = buildBasic(
    baseInput({
      wallet: held,
      proposals: [proposal({ status: 'executed', decidedAt: T2 })],
      readAt: T0,
    }),
  );
  assert.equal(checking.totalUsd, null, 'the total is still unstated');
  assert.equal(checking.checkingLine, 'Checking your new balance.');
  assert.ok(checking.holdings.length > 0, 'the panel still shows what the last read held');

  const unread = buildBasic(
    baseInput({
      wallet: { ...held, stale: ['intents'] },
      proposals: [proposal({ status: 'executed', decidedAt: T0 })],
      readAt: T2,
    }),
  );
  assert.equal(unread.totalUsd, null);
  assert.equal(unread.checkingLine, 'Still checking.');
  assert.deepEqual(unread.holdings, [], 'a list missing a place is not shown at all');
});

test('a balance read after the last execution is stated normally', () => {
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'executed', decidedAt: T0 })],
      readAt: T2,
    }),
  );
  assert.equal(view.totalUsd, 2341.08);
  assert.match(view.totalLine, /2,341\.08/);
  assert.equal(view.checkingLine, null);
  assert.match(view.headline, /You now have \$2,341\.08/);
});

test('the stale check judges by when the money moved, not by when the click landed', () => {
  // Decided at T0, filled at T2 (a 1Click deposit can take a minute). A read stamped T1 is
  // after the decision and before the fill, and it used to be stated as the new balance.
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'executed', decidedAt: T0, settledAt: T2 })],
      readAt: T1,
    }),
  );
  assert.equal(view.totalUsd, null);
  assert.equal(view.checkingLine, 'Checking your new balance.');
});

test('a move the app could not confirm keeps the balance unstated until the ledger has read past it', () => {
  const unconfirmed = proposal({ status: 'needs_reconciliation', decidedAt: T2, result: { ok: false, detail: 'unconfirmed', txids: ['h1'] } });
  const stale = buildBasic(baseInput({ proposals: [unconfirmed], readAt: T1 }));
  assert.equal(stale.totalUsd, null, 'money may have left');
  assert.equal(stale.checkingLine, 'Checking your new balance.');

  const fresh = buildBasic(baseInput({ proposals: [unconfirmed], readAt: '2026-08-12T13:00:00.000Z' }));
  assert.equal(fresh.totalUsd, 2341.08);
  assert.match(fresh.headline, /not confirmed/i);
  assert.doesNotMatch(fresh.headline, /Done\. You now have/);
});

test('a failed row with no hash moved nothing, so it never puts the balance in question', () => {
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'failed', decidedAt: T2, result: { ok: false, detail: 'refused before the key', txids: [] } })],
      readAt: T1,
    }),
  );
  assert.equal(view.totalUsd, 2341.08);
  assert.equal(view.checkingLine, null);
});

test('a swap never claims the total goes down, because a swap does not reduce it', () => {
  const view = buildBasic(baseInput({ proposals: [proposal()] }));
  assert.match(view.ask!.afterLine, /stays about the same/);
  assert.ok(!/left afterwards/.test(view.ask!.afterLine), 'a swap must not fabricate a post-balance');
});

// ---------- the control that matters ----------

test('the ask carries the same USD the policy engine governed on', () => {
  const draft = swapDraft({ amountUsd: 105 });
  const view = buildBasic(baseInput({ proposals: [proposal({ draft })] }));
  assert.equal(view.ask?.amountUsd, draft.amountUsd);
  assert.match(view.ask!.headline, /105/);
  assert.match(view.ask!.headline, /WETH/);
});

test('basic renders every destination the approval rests on', () => {
  const draft = swapDraft({ counterparty: ROUTER });
  const p = proposal({ draft, simulation: { ok: true, summary: '', depositAddresses: [{ leg: 'leg0', address: SOLVER }] } });
  const view = buildBasic(baseInput({ proposals: [p] }));
  const shown = view.ask!.destinations.map((d) => d.address.toLowerCase());
  assert.ok(shown.includes(ROUTER.toLowerCase()), 'the counterparty must be rendered');
  assert.ok(shown.includes(SOLVER.toLowerCase()), 'the quoter-chosen deposit address must be rendered');

  const solver = view.ask!.destinations.find((d) => d.address.toLowerCase() === SOLVER.toLowerCase())!;
  assert.equal(solver.chosenBy, 'quoter');
  // Two halves, because "not your wallet" contains "your wallet" and a substring check
  // would pass the exact sentence F2 shipped while failing the correct one. The label
  // must not CLAIM ownership, and it must actively DENY it.
  assert.doesNotMatch(solver.label, /^your /i, 'a quoter address may never be called the user wallet');
  assert.match(solver.label, /\bnot your\b/i, 'a quoter address must actively say it is not the user wallet');
  assert.ok(
    view.ask!.facts.some((f) => /chosen by the swap service/.test(f)),
    'the quoter-chosen address needs a plain-words fact, not just a label',
  );
});

test('an output address that is not the user wallet is called out as such', () => {
  const view = buildBasic(baseInput({ proposals: [proposal({ draft: swapDraft({ to: STRANGER }) })] }));
  const stranger = view.ask!.destinations.find((d) => d.address.toLowerCase() === STRANGER.toLowerCase())!;
  assert.match(stranger.label, /NOT your wallet/);
  assert.ok(view.ask!.facts.some((f) => /not your own wallet/.test(f)));
});

test('the user own wallet is labelled as such when it really is theirs', () => {
  const view = buildBasic(baseInput({ proposals: [proposal({ draft: swapDraft({ to: SELF }) })] }));
  const own = view.ask!.destinations.find((d) => d.address.toLowerCase() === SELF.toLowerCase())!;
  assert.equal(own.label, 'your own wallet');
});

test('basic never truncates an address it shows', () => {
  const ELLIPSIS = String.fromCharCode(0x2026);
  const p = proposal({ simulation: { ok: true, summary: '', depositAddresses: [{ leg: 'leg0', address: SOLVER }] } });
  const view = buildBasic(baseInput({ proposals: [p] }));
  assert.ok(view.ask!.destinations.length > 0);
  for (const d of view.ask!.destinations) {
    assert.ok(!d.address.includes('...') && !d.address.includes(ELLIPSIS), 'addresses render in full');
    assert.equal(d.address.length >= 40, true, 'a shortened address is a hidden fact');
  }
});

test('every symbol the draft names survives into basic, and a swap names no chain: both legs sit inside NEAR Intents', () => {
  const draft = swapDraft({ fromSymbol: 'USDC', toSymbol: 'WETH', chain: 'arb', toChain: 'sol' });
  const view = buildBasic(baseInput({ proposals: [proposal({ draft })] }));
  assert.deepEqual([...view.ask!.symbols].sort(), ['USDC', 'WETH']);
  assert.deepEqual(view.ask!.chains, [], 'chain and toChain are the assets\' home chains, not places the money goes');
});

/* The retired kinds are in this list on purpose. lp_add, lp_remove, yield_deposit and
   yield_withdraw cannot be proposed any more, and state/proposals.json still holds rows naming
   them, so this screen still has to write a headline for each. Cast because the live WriteDraft
   union no longer describes them; the shape is what a row on disk actually carries. */
const retired = (draft: Record<string, unknown>): WriteDraft => draft as unknown as WriteDraft;

test('every draft kind produces a headline that names its amount', () => {
  const drafts: WriteDraft[] = [
    swapDraft(),
    { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc.omft.near', amount: 20, amountUsd: 20, minCredited: 19.8, from: SELF.toLowerCase(), hlAccount: SELF, counterparty: ROUTER },
    retired({
      kind: 'lp_add',
      chain: 'arb',
      venue: 'uniswap-v3',
      poolId: '0xpool',
      token0: { symbol: 'USDC', tokenId: '0xa', amount: 30, decimals: 6 },
      token1: { symbol: 'WETH', tokenId: '0xb', amount: 0.01, decimals: 18 },
      feeTier: 500,
      tickLower: -100,
      tickUpper: 100,
      amountUsd: 60.64,
      from: SELF,
      counterparty: ROUTER,
    }),
    retired({
      kind: 'lp_remove',
      chain: 'arb',
      venue: 'uniswap-v3',
      positionId: '3643',
      liquidityPct: 0.5,
      amountUsd: 42.5,
      from: SELF,
      counterparty: ROUTER,
    }),
    retired({
      kind: 'yield_deposit',
      venue: 'aave-v3',
      chain: 'arb',
      symbol: 'USDC',
      amount: 50,
      amountBase: '50000000',
      decimals: 6,
      amountUsd: 50,
      from: SELF,
      counterparty: ROUTER,
    }),
    retired({
      kind: 'yield_withdraw',
      venue: 'aave-v3',
      chain: 'arb',
      symbol: 'USDC',
      amount: 50,
      amountBase: null,
      decimals: 6,
      amountUsd: 50,
      from: SELF,
      counterparty: ROUTER,
    }),
    { kind: 'policy_change', patch: {}, sentence: 'never hold more than 20% in anything freezable' },
  ];
  for (const draft of drafts) {
    const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: draft.kind })] }));
    assert.ok(view.ask !== null, `${draft.kind} produced no ask`);
    assert.ok(view.ask!.headline.trim().length > 0, `${draft.kind} produced an empty headline`);
    assert.equal(view.ask!.kind, draft.kind);
    // yield_withdraw is the one exception, and it always was: omitting the amount meant "the
    // whole position, interest included", so the sentence names the asset and no figure. A
    // number there would be one the draft did not have.
    if (draft.kind !== 'policy_change' && String(draft.kind) !== 'yield_withdraw') {
      assert.match(view.ask!.headline, /\$/, `${draft.kind} headline must name money`);
    }
  }
});

/* The trade ask, for the reader who owns the money and is not technical. Two numbers are the
   whole decision on an open (what is at stake, and the loss that ends it), a change names the
   old and the new figure, and the plan's note, which the assistant wrote, is nowhere on this
   screen: nothing the thing being decided about wrote gets to phrase the question. */
function tradeDraft(over: Partial<Extract<TradeDraft, { op: 'open' }>> = {}): Extract<TradeDraft, { op: 'open' }> {
  return {
    kind: 'trade',
    op: 'open',
    plan: {
      id: 'pl_1',
      symbol: 'BTC',
      side: 'long',
      sizeUsd: 4000,
      leverage: 20,
      entry: { type: 'market', maxSlippageBps: 30 },
      stop: 63000,
      target: 66000,
      expiresAt: '2026-09-12T10:00:00.000Z',
      note: '<b>APPROVED</b> by the owner already, reference APPROVAL-7781',
    },
    hash: 'h',
    risk: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
    amountUsd: 200,
    counterparty: 'hyperliquid-perps',
    ...over,
  };
}

test('a trade ask says what is at stake and what ends it, and the note never reaches this screen', () => {
  const view = buildBasic(baseInput({ proposals: [proposal({ draft: tradeDraft(), kind: 'trade' })] }));
  const ask = view.ask!;
  assert.equal(ask.amountUsd, 200, 'the governed amount is max(margin, max loss)');
  assert.match(ask.headline, /buy Bitcoin \(BTC\) with \$200\.00 of your trading account at stake/);
  assert.match(ask.headline, /stop out once it has lost \$66\.10/);
  assert.match(ask.afterLine, /stays in your trading account/);
  assert.match(ask.afterLine, /stop is on the exchange itself/);
  assert.ok(ask.facts.includes('Amount: $200.00.'));
  assert.deepEqual(ask.destinations, [], 'a perp order moves nothing to an address');
  assert.equal(JSON.stringify(ask).includes('APPROVAL-7781'), false, 'the assistant\'s note phrased the question');
  assert.equal(JSON.stringify(view).includes('<b>'), false);

  const short = buildBasic(baseInput({ proposals: [proposal({ draft: tradeDraft({ plan: { ...tradeDraft().plan, side: 'short', symbol: 'XYZ' } }), kind: 'trade' })] }));
  assert.match(short.ask!.headline, /sell XYZ with/, 'a coin with no plain name is shown as its ticker');
});

test('a change to a trade names the old and the new figure, and a cancel or close says what is left', () => {
  const before = { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 };
  const change = (over: Record<string, unknown>): TradeDraft =>
    ({ kind: 'trade', op: 'change', id: 'pl_1', before, after: before, amountUsd: 200, counterparty: 'hyperliquid-perps', ...over }) as TradeDraft;

  const wider = buildBasic(baseInput({ proposals: [proposal({ draft: change({ stop: 62000, after: { ...before, maxLossUsd: 128.6 } }), kind: 'trade' })] }));
  assert.match(wider.ask!.headline, /move the stop on trade pl_1/);
  assert.match(wider.ask!.headline, /from \$66\.10 to \$128\.60/);

  const close = buildBasic(baseInput({ proposals: [proposal({ draft: change({ close: true }), kind: 'trade' })] }));
  assert.match(close.ask!.headline, /close trade pl_1 now, at the market, with \$200\.00 at stake/);

  const cancel = buildBasic(baseInput({ proposals: [proposal({ draft: change({ cancel: true, amountUsd: 0 }), kind: 'trade' })] }));
  assert.match(cancel.ask!.headline, /cancel trade pl_1 before it opens/);
  assert.match(cancel.ask!.headline, /Nothing is at risk after that/);
});

test('a policy change says plainly that it moves no money', () => {
  const draft: WriteDraft = { kind: 'policy_change', patch: {}, sentence: 'raise the cap to $999,999' };
  const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: 'policy_change' })] }));
  assert.match(view.ask!.afterLine, /does not move any money/);
  assert.match(view.ask!.headline, /raise the cap/);
});

/* The agent writes the patch AND the sentence beside it, so a card that shows only the sentence
   shows nothing a hostile patch cannot choose. This screen used to show exactly that: the
   agent's words in the headline and "This does not move any money. It changes a rule." below.
   The app already computed the before/after sentences at src/proposals/draft.ts and nothing
   rendered them anywhere. */
test('a rule change lists every rule it removes and every rule it adds', () => {
  const draft: WriteDraft = {
    kind: 'policy_change',
    patch: { outbound: { humanClickAboveUsd: 1_000_000_000 } },
    // The lie. The patch does something else entirely and this is the only thing the card used
    // to carry about it.
    sentence: 'cap the freezable share at half',
  };
  const view = buildBasic(
    baseInput({
      proposals: [
        proposal({
          draft,
          kind: 'policy_change',
          simulation: {
            ok: true,
            summary: 'the agent asked for: cap the freezable share at half',
            policyDiff: {
              before: ['Ask me before anything above $100.', 'No more than 50% of holdings may be freezable.', 'Never move funds into: acme.'],
              after: ['Ask me before anything above $1,000,000,000.'],
            },
          },
        }),
      ],
    }),
  );

  const facts = view.ask!.facts.join('\n');
  assert.match(facts, /removed: "Ask me before anything above \$100\."/);
  assert.match(facts, /removed: "No more than 50% of holdings may be freezable\."/, 'a deleted cap is a removal');
  assert.match(facts, /removed: "Never move funds into: acme\."/, 'so is a deleted forbidden issuer');
  assert.match(facts, /added: "Ask me before anything above \$1,000,000,000\."/);
});

test('a rule change that reads identically afterwards says so rather than showing an empty list', () => {
  const draft: WriteDraft = { kind: 'policy_change', patch: {}, sentence: 'tidy the rules' };
  const view = buildBasic(
    baseInput({
      proposals: [
        proposal({
          draft,
          kind: 'policy_change',
          simulation: { ok: true, summary: 'the agent asked for: tidy the rules', policyDiff: { before: ['Ask me before anything above $100.'], after: ['Ask me before anything above $100.'] } },
        }),
      ],
    }),
  );
  assert.match(view.ask!.facts.join('\n'), /None of your rules would actually read any differently/);
});

// ---------- both found by driving the app, not by an assertion ----------

test('the most recent decision wins, not the most alarming one', () => {
  // Ranking terminal states by status meant a human refusal at 02:15 was reported as
  // an unrelated policy refusal from 02:13. The person pressed NO and the screen told
  // them about something else entirely.
  const older = proposal({ id: 'older', status: 'policy_refused', decidedAt: T0 });
  const newer = proposal({ id: 'newer', status: 'refused', decidedAt: T2 });
  const view = buildBasic(baseInput({ proposals: [older, newer] }));
  assert.match(view.headline, /You said no/);
  assert.equal(view.tone, 'calm');

  // And the other way round: a policy refusal that really is the latest still leads.
  const flipped = buildBasic(
    baseInput({
      proposals: [proposal({ id: 'a', status: 'refused', decidedAt: T0 }), proposal({ id: 'b', status: 'policy_refused', decidedAt: T2 })],
    }),
  );
  assert.match(flipped.headline, /Phosphor stopped it/);
  assert.equal(flipped.tone, 'stopped');
});

test('a zero amount is never rendered as a money figure', () => {
  // A refused row with nothing priced (here a consolidate an older build wrote) prices at 0.
  // "tried to gather $0.00 of your dollars" tells this reader nothing at all.
  const draft = retired({ kind: 'consolidate', legs: [], totalUsd: 0, toChain: 'eth', symbol: 'USDT' });
  const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: draft.kind, status: 'policy_refused', decidedAt: T1 })] }));
  assert.ok(!view.headline.includes('$0.00'), `headline still prints a zero figure: ${view.headline}`);
  assert.match(view.headline, /Phosphor stopped it/);
  assert.match(view.headline, /USDT/);
});

test('a positive amount is still rendered in full', () => {
  const view = buildBasic(baseInput({ proposals: [proposal()] }));
  assert.match(view.ask!.headline, /\$105\.00/);
});

test('no two lines on the screen are the same sentence', () => {
  // The headline and the agent line both read "No assistant is connected right now."
  // On a screen this spare, the same words twice reads as a rendering fault.
  for (const [name, input] of ELEVEN) {
    const v = buildBasic(input);
    const lines = [v.headline, v.checkingLine, v.placesLine, v.agentLine, v.footer, v.warning, v.ask?.headline, v.ask?.afterLine]
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
    assert.equal(new Set(lines).size, lines.length, `${name} renders a duplicated sentence: ${JSON.stringify(lines)}`);
  }
});

// ---------- warnings ----------

// Found by looking at the rebuilt screen rather than at the object: the headline and
// the warning were the same sentence written twice, which on a page with this much
// space around it reads as a rendering fault rather than as emphasis. Same class of
// bug as the agentLine duplication the file already guards against.
test('the headline never restates the warning directly under it', () => {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((w) => w.length > 3));
  for (const input of [
    baseInput({ killSwitch: true }),
    baseInput({ policyReadable: false }),
  ]) {
    const v = buildBasic(input);
    assert.ok(v.warning !== null, 'this case should carry a warning');
    const head = words(v.headline);
    const warn = words(v.warning!);
    const shared = [...head].filter((w) => warn.has(w));
    assert.ok(
      shared.length < Math.min(head.size, warn.size) * 0.6,
      `headline and warning say the same thing:\n  ${v.headline}\n  ${v.warning}`,
    );
  }
});

test('no warning at all when everything is normal', () => {
  assert.equal(buildBasic(baseInput()).warning, null);
});

test('the footer promises nothing moves without a press, but only when asking', () => {
  assert.match(buildBasic(baseInput({ proposals: [proposal()] })).footer, /Nothing moves unless you press YES/);
  assert.doesNotMatch(buildBasic(baseInput()).footer, /press YES/);
});

// Found by opening the page rather than by any assertion: the footer promised
// "You will be asked before anything moves" directly under a warning that contradicted
// it. Two sentences contradicting each other is worse than either one, and worst on
// this screen, where the reader has no third source to break the tie.
test('the footer never contradicts the warning above it', () => {
  const frozen = buildBasic(baseInput({ killSwitch: true }));
  assert.doesNotMatch(frozen.footer, /You will be asked/);

  const broken = buildBasic(baseInput({ policyReadable: false }));
  assert.doesNotMatch(broken.footer, /You will be asked/);

  // And the normal case still makes the promise it is allowed to make.
  assert.match(buildBasic(baseInput()).footer, /You will be asked before anything moves/);
});

test('nothing claims "all normal" while a warning is on screen', () => {
  // Same class as the footer bug, found the same way. "all normal" reads as a claim
  // about the whole app, so it cannot sit under a red box saying everything is frozen.
  for (const input of [
    baseInput({ killSwitch: true }),
    baseInput({ policyReadable: false }),
  ]) {
    const v = buildBasic(input);
    assert.ok(v.warning !== null, 'this case should carry a warning');
    assert.doesNotMatch(v.placesLine, /all normal/, `placesLine contradicts the warning: ${v.placesLine}`);
  }
  assert.match(buildBasic(baseInput()).placesLine, /all normal/);
});

// ---------- what you own ----------
//
// The holdings list is the one part of this screen that shows a number per THING
// rather than one number for everything, so its failure mode is the same as the
// total's: a list that is missing a chain looks exactly like the list of someone
// who owns less, and this reader has nothing to check it against.

function walletRow(over: Partial<WalletRow> = {}): WalletRow {
  return {
    kind: 'intents',
    chain: 'intents',
    symbol: 'USDC',
    tokenId: 'nep141:base-usdc.omft.near',
    quantity: 100,
    priceUsd: 1,
    valueUsd: 100,
    share: 0.1,
    native: false,
    ...over,
  };
}

test('one row per thing owned, not one per chain', () => {
  const v = buildBasic(
    baseInput({
      wallet: {
        rows: [
          walletRow({ chain: 'base', symbol: 'USDC', quantity: 700, valueUsd: 700 }),
          walletRow({ chain: 'arb', symbol: 'USDC', quantity: 504, valueUsd: 504 }),
          walletRow({ chain: 'eth', symbol: 'WETH', quantity: 0.31, valueUsd: 987.08 }),
        ],
        totalUsd: 2191.08,
        byChain: { base: 700, arb: 504, eth: 987.08 },
        stale: [],
        emptyCount: 0,
        dustCount: 0,
        dustUsd: 0, unpriced: [],
      },
    }),
  );

  const names = v.holdings.map((h) => h.name);
  assert.equal(names.filter((n) => n.includes('USDC')).length, 1, 'the same token on two chains is one row');
  assert.equal(v.holdings.length, 2);

  const dollars = v.holdings.find((h) => h.name.includes('USDC'))!;
  assert.equal(dollars.valueUsd, 1204);
  assert.equal(dollars.valueLine, '$1,204.00');
  assert.equal(dollars.quantityLine, '1,204.00');
});

test('holdings go empty exactly when the total goes unknown', () => {
  const rows = [walletRow({ valueUsd: 100, quantity: 100 })];

  const stale = buildBasic(
    baseInput({ wallet: { rows, totalUsd: 100, byChain: { base: 100 }, stale: ['near'], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] } }),
  );
  assert.equal(stale.totalUsd, null);
  assert.deepEqual(stale.holdings, [], 'a partial list is worse than no list');

  const fine = buildBasic(baseInput({ wallet: { rows, totalUsd: 100, byChain: { base: 100 }, stale: [], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [] } }));
  assert.equal(fine.holdings.length, 1);
});

// ---------- the three prices ----------

test('a price refuses rather than shows a figure it does not have', () => {
  assert.deepEqual(buildBasic(baseInput({ prices: [null] })).prices, []);
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ priceUsd: 0 })] })).prices, []);
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ priceUsd: Number.NaN })] })).prices, []);
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ changePct: Number.NaN })] })).prices, []);
});

// One coin failing must not blank the other two. Three prices behind one flag would mean
// a Solana outage taking the Bitcoin line off the screen, which is a lie about Bitcoin.
test('one unreadable coin drops out and the others stay', () => {
  const view = buildBasic(
    baseInput({
      prices: [reading({ product: 'BTC-USD', priceUsd: 64210.37 }), null, reading()],
    }),
  );
  assert.deepEqual(
    view.prices.map((p) => p.symbol),
    ['BTC', 'ETH'],
  );
});

test('a price says up, down, or level, and never draws an arrow on noise', () => {
  const up = buildBasic(baseInput({ prices: [reading()] })).prices[0]!;
  assert.equal(up.direction, 'up');
  assert.equal(up.changeLine, 'up 1.4% today');
  assert.equal(up.priceLine, '$3,184.22');
  // The bare name for reading, the symbol kept because it is the verifiable half.
  assert.equal(up.name, 'Ether');
  assert.equal(up.symbol, 'ETH');
  assert.equal(up.mark, 'eth');

  const down = buildBasic(baseInput({ prices: [reading({ priceUsd: 3000, changePct: -0.83 })] })).prices[0]!;
  assert.equal(down.direction, 'down');
  assert.equal(down.changeLine, 'down 0.8% today');

  // A twentieth of a percent is noise. An arrow drawn on it tells this reader that
  // something happened when nothing did.
  const flat = buildBasic(
    baseInput({ prices: [reading({ product: 'BTC-USD', priceUsd: 61000, changePct: 0.05 })] }),
  ).prices[0]!;
  assert.equal(flat.direction, 'flat');
  assert.equal(flat.changeLine, 'level today');
  assert.equal(flat.mark, 'btc');
});

// The line is the fifth-pass addition and it is drawn from these numbers, so a hole in
// them is a spike on screen that reads as a crash. A series with a hole is dropped whole.
test('the line is dropped rather than drawn through a hole in it', () => {
  const holed = closes(3184.22);
  holed[7] = Number.NaN;
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ closes: holed })] })).prices[0]!.points, []);

  const negative = closes(3184.22);
  negative[3] = -1;
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ closes: negative })] })).prices[0]!.points, []);

  // One point is a dot, not a line, and the price figure already says where it is now.
  assert.deepEqual(buildBasic(baseInput({ prices: [reading({ closes: [3184.22] })] })).prices[0]!.points, []);

  // A good series survives whole and in order: the browser scales it, it does not filter it.
  const good = buildBasic(baseInput({ prices: [reading()] })).prices[0]!;
  assert.equal(good.points.length, 24);
  assert.deepEqual(good.points, closes(3184.22));
});

// A coin priced under a dollar rounds to $0.00 at two decimals, which is the same failure
// as printing a zero for an unknown: it states a figure that is not true.
test('a sub-dollar price keeps the digits that make it a number', () => {
  const view = buildBasic(baseInput({ prices: [reading({ product: 'PEPE-USD', priceUsd: 0.00001234 })] }));
  assert.equal(view.prices[0]!.priceLine, '$0.000012');
  // Nothing has been drawn for it, so it says so rather than borrowing another coin's mark.
  assert.equal(view.prices[0]!.mark, null);
});

// ---------- what the assistant did ----------

test('the assistant list is composed from the event, never from its developer text', () => {
  const view = buildBasic(
    baseInput({
      events: [
        toolCall(T2, { op: 'read', tool: 'wallet' }),
        toolCall(T1, { op: 'read', tool: 'policy_show' }),
        { ts: T0, type: 'agent_connected', msg: 'an agent attached to phosphor' },
      ],
    }),
  );
  assert.deepEqual(
    view.actions.map((a) => a.line),
    ['Looked at what you own.', 'Read your safety rules.', 'An assistant connected.'],
  );
  for (const action of view.actions) {
    assert.doesNotMatch(action.line, /agent:|tool_call|phosphor/i, 'no developer text reaches this screen');
  }
});

// Nine identical sentences is a log, which is the thing this screen exists not to be.
test('a run of the same action collapses to one line that counts itself', () => {
  const events: LogEvent[] = [];
  for (let i = 0; i < 9; i += 1) events.push(toolCall(T2, { op: 'read', tool: 'balances' }));
  events.push(toolCall(T1, { op: 'propose', kind: 'swap' }));

  const view = buildBasic(baseInput({ events }));
  assert.equal(view.actions.length, 2);
  assert.equal(view.actions[0]!.line, 'Looked at what you own.');
  assert.equal(view.actions[0]!.repeat, 9);
  assert.equal(view.actions[1]!.repeat, 1);

  // The newest time in the run, not the oldest: the run is reported as of when it last
  // happened. Derived rather than written out, so the assertion is not about a timezone.
  const one = buildBasic(baseInput({ events: [toolCall(T2, { op: 'read', tool: 'balances' })] }));
  assert.equal(view.actions[0]!.timeLine, one.actions[0]!.timeLine);
});

// Only neighbours collapse. Two reads with a proposal between them are two things that
// happened, and merging them across the proposal puts the newest time on the oldest event.
test('a run is broken by anything that happened inside it', () => {
  const view = buildBasic(
    baseInput({
      events: [
        toolCall(T2, { op: 'read', tool: 'wallet' }),
        toolCall(T1, { op: 'propose', kind: 'swap' }),
        toolCall(T0, { op: 'read', tool: 'wallet' }),
      ],
    }),
  );
  assert.equal(view.actions.length, 3);
  assert.deepEqual(
    view.actions.map((a) => a.repeat),
    [1, 1, 1],
  );
});

// A human pressing a button in the trade window is logged as a tool_call too. This list is
// what the ASSISTANT did: the owner's own clicks in it would tell them a machine did those.
test('a human pressing a button is not reported as something the assistant did', () => {
  const view = buildBasic(
    baseInput({
      events: [
        { ts: T2, type: 'tool_call', msg: 'human: cancel abc', data: { action: 'cancel', id: 'abc' } },
        { ts: T1, type: 'kill_switch', msg: 'kill switch on' },
        toolCall(T0, { op: 'read', tool: 'wallet' }),
      ],
    }),
  );
  assert.deepEqual(
    view.actions.map((a) => a.line),
    ['Looked at what you own.'],
  );
});

test('the assistant list caps, and an empty one is a designed state', () => {
  const tools = ['wallet', 'policy_show', 'log_tail', 'trade_read', 'mandate_catalog', 'candles', 'chart_read'];
  const events = tools.map((tool) => toolCall(T2, { op: 'read', tool }));
  assert.equal(buildBasic(baseInput({ events })).actions.length, 5);
  assert.deepEqual(buildBasic(baseInput()).actions, []);
});

// ---------- what happened ----------

test('a refusal never reads as a receipt', () => {
  const v = buildBasic(
    baseInput({
      proposals: [
        proposal({ id: 'a', status: 'executed', decidedAt: T0 }),
        proposal({ id: 'b', status: 'refused', decidedAt: T1 }),
        proposal({ id: 'c', status: 'policy_refused', decidedAt: T2 }),
      ],
    }),
  );

  assert.deepEqual(
    v.recent.map((r) => r.outcome),
    ['blocked', 'refused', 'done'],
    'newest first',
  );

  const [blocked, refused, done] = v.recent;
  assert.match(blocked!.headline, /^Your rules blocked /);
  assert.match(refused!.headline, /^You said no to /);
  // The one that actually happened is the only one in the past tense.
  assert.match(done!.headline, /^Changed /);
  for (const line of [blocked!.headline, refused!.headline]) {
    assert.doesNotMatch(line, /^Changed /, 'a thing that did not happen may not be reported as one that did');
  }
});

test('what happened lists only finished things, newest first, and is capped', () => {
  // Distinct amounts so the ordering is readable off the headline rather than off a
  // clock string that depends on the machine's timezone.
  const many = [0, 1, 2, 3, 4, 5].map((i) =>
    proposal({
      id: `p-${i}`,
      status: 'executed',
      decidedAt: `2026-08-12T1${i}:00:00.000Z`,
      draft: swapDraft({ amountUsd: (i + 1) * 10 }),
    }),
  );
  const pending = proposal({ id: 'open', status: 'pending', draft: swapDraft({ amountUsd: 999 }) });
  const v = buildBasic(baseInput({ proposals: [...many, pending] }));

  assert.equal(v.recent.length, 4, 'a fifth line turns this section into a log');
  // p-5 decided last, so it leads; p-2 is the oldest that still fits.
  assert.deepEqual(
    v.recent.map((r) => r.headline.match(/\$(\d+)\.00/)![1]),
    ['60', '50', '40', '30'],
  );
  // The pending one is not here: it is on screen above as the question, and listing it
  // in "what happened" would report a decision nobody has made yet.
  assert.ok(
    v.recent.every((r) => !r.headline.includes('999')),
    'a pending proposal is not a thing that happened',
  );
});

test('a move the app cannot confirm is listed as unconfirmed with the rail\'s sentence, never as one that did not happen', () => {
  const sentence = 'the intent was signed and its submission is unconfirmed (timeout); handle abc123, deadline 2026-08-15T12:00:00.000Z.';
  const v = buildBasic(
    baseInput({
      proposals: [
        proposal({ id: 'a', status: 'executed', decidedAt: T0 }),
        proposal({ id: 'b', status: 'needs_reconciliation', decidedAt: T1, settledAt: T2, result: { ok: false, detail: sentence, txids: ['h1'], evidence: { handle: 'abc123' } } }),
      ],
    }),
  );
  assert.deepEqual(v.recent.map((r) => r.outcome), ['unconfirmed', 'done'], 'newest first, by when the rail returned');
  const [open] = v.recent;
  assert.match(open!.headline, /^Tried to change /, 'never past tense: it may not have happened');
  assert.match(open!.headline, /Not confirmed/);
  assert.ok(open!.headline.includes(sentence), 'the rail\'s own sentence, verbatim');
  assert.doesNotMatch(open!.headline, /did not happen|blocked|said no/);
});

test('a failed row with a handle or a nonce but no hash is unconfirmed too, and one with nothing is not listed', () => {
  const v = buildBasic(
    baseInput({
      proposals: [
        proposal({ id: 'handle', status: 'failed', decidedAt: T2, result: { ok: false, detail: 'signed, unconfirmed; handle abc', txids: [], evidence: { handle: 'abc' } } }),
        proposal({ id: 'nonce', status: 'failed', decidedAt: T1, result: { ok: false, detail: 'no reply; nonce 5', txids: [], evidence: { nonce: '5' } } }),
        proposal({ id: 'nothing', status: 'failed', decidedAt: T0, result: { ok: false, detail: 'refused before the key', txids: [] } }),
      ],
    }),
  );
  assert.deepEqual(v.recent.map((r) => r.outcome), ['unconfirmed', 'unconfirmed']);
  assert.ok(v.recent.every((r) => !r.headline.includes('refused before the key')), 'a move that never happened is not a thing that happened');
});

test('nothing has happened yet is a state, not an empty box', () => {
  assert.deepEqual(buildBasic(baseInput()).recent, []);
});

// A draft can legitimately price at zero (nothing left to consolidate, which is then
// refused). The first version substituted the word "money" for the missing figure and
// rendered "gathering money of your US dollars (USDT) onto Ethereum" onto a live screen.
// Every kind runs through amountClause now, which drops the clause instead.
test('a zero-priced draft drops the money clause rather than wording around it', () => {
  const kinds: WriteDraft[] = [
    swapDraft({ amountUsd: 0 }),
    { kind: 'consolidate', symbol: 'USDT', toChain: 'eth', totalUsd: 0, legs: [] } as unknown as WriteDraft,
    { kind: 'hl_deposit', chain: 'arb', symbol: 'USDC', amount: 0, amountUsd: 0, bridge: ROUTER, from: SELF } as unknown as WriteDraft,
  ];

  for (const draft of kinds) {
    for (const status of ['executed', 'refused', 'policy_refused'] as const) {
      const v = buildBasic(baseInput({ proposals: [proposal({ draft, status, decidedAt: T1 })] }));
      const line = v.recent[0]!.headline;
      assert.doesNotMatch(line, /money of your/, `not English: ${line}`);
      assert.doesNotMatch(line, /\$0\.00/, `a zero is the absence of an amount, not one: ${line}`);
      assert.ok(line.trim().length > 0);
    }
  }

  // And the clause is still there when there is a real figure to state.
  const priced = buildBasic(
    baseInput({ proposals: [proposal({ draft: swapDraft({ amountUsd: 105 }), status: 'executed', decidedAt: T1 })] }),
  );
  assert.match(priced.recent[0]!.headline, /\$105\.00 of your/);
});

// ---------- the window that renders it ----------
//
// The five surfaces are how the beam finds its targets: ui/beam/trace.js maps a tool to a
// data-surface id and ui/beam/beam.js looks that id up inside the active view. A panel that
// loses its id does not fail here at render time, it fails silently as a tool call that lands
// nowhere, which is exactly the feedback this window exists to give.

// The source with its comments taken out. A comment that names the bug it fixed would
// otherwise satisfy an assertion looking for the bug.
function codeOf(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('Basic carries every surface the beam aims at, and no Freeze of its own', () => {
  const source = codeOf('../../ui/screens/basic.js');
  for (const id of ['holdings', 'rules', 'moneyin', 'activity']) {
    assert.ok(source.includes(`'${id}'`), `ui/screens/basic.js must place the ${id} surface`);
  }
  // The top bar carries the brake now. Two copies of one action on one screen is how a person
  // stops believing either of them.
  assert.ok(!source.includes('Freeze everything'));
});

