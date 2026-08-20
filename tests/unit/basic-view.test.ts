// Basic view is the screen a non-technical person makes a money decision on, so these
// tests are mostly about what it REFUSES to say: no fabricated balance, no truncated
// address, no destination left off, and never a zero standing in for an unknown.
//
// The sharpest one is "renders every destination the approval rests on". Asserting the
// amount alone would not have caught F2, where the amount was correct and the funds
// went to a solver-chosen deposit address behind the words "your wallet".

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBasic } from '../../src/view/basic.ts';
import type { BasicInput, PriceReading } from '../../src/view/basic.ts';
import type {
  ChainId,
  ChainStatus,
  LogEvent,
  Proposal,
  SwapDraft,
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

function chainStatus(fetchedAt = T2): Record<ChainId, ChainStatus> {
  const one: ChainStatus = { ok: true, fetchedAt };
  return { eth: one, base: one, arb: one, sol: one, near: one };
}

function baseInput(over: Partial<BasicInput> = {}): BasicInput {
  return {
    wallet: { rows: [], totalUsd: 2341.08, byChain: { arb: 2000, eth: 341.08 }, stale: [], emptyCount: 0 },
    proposals: [],
    policyReadable: true,
    killSwitch: false,
    gateRequired: true,
    agentsConnected: 1,
    chainStatus: chainStatus(),
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
    venue: 'uniswap-v3',
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
  ['gate disabled', baseInput({ gateRequired: false })],
  ['policy unreadable', baseInput({ policyReadable: false })],
  ['no agent', baseInput({ agentsConnected: 0 })],
  ['chain read failed', baseInput({ wallet: { rows: [], totalUsd: 0, byChain: {}, stale: ['near'], emptyCount: 0 } })],
];

test('every one of the eleven states produces copy', () => {
  for (const [name, input] of ELEVEN) {
    const view = buildBasic(input);
    assert.ok(view.headline.trim().length > 0, `${name} rendered an empty headline`);
    assert.ok(view.footer.trim().length > 0, `${name} rendered an empty footer`);
    assert.ok(view.totalLine.trim().length > 0, `${name} rendered an empty total line`);
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
  assert.equal(toneOf('gate disabled'), 'broken');
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
  const view = buildBasic(baseInput({ wallet: { rows: [], totalUsd: 0, byChain: {}, stale: ['near'], emptyCount: 0 } }));
  assert.equal(view.totalUsd, null);
  assert.match(view.totalLine, /still checking/);
  assert.ok(!view.totalLine.includes('0.00'), 'an unknown balance may not render as a zero');
});

test('a balance read before the last execution is not stated as fact', () => {
  // The ledger cache serves pre-trade balances after a write and still reports stale: [].
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'executed', decidedAt: T2 })],
      chainStatus: chainStatus(T0), // fetched an hour BEFORE the execution
    }),
  );
  assert.equal(view.totalUsd, null);
  assert.match(view.totalLine, /checking your new balance/);
});

test('a balance read after the last execution is stated normally', () => {
  const view = buildBasic(
    baseInput({
      proposals: [proposal({ status: 'executed', decidedAt: T0 })],
      chainStatus: chainStatus(T2),
    }),
  );
  assert.equal(view.totalUsd, 2341.08);
  assert.match(view.totalLine, /2,341\.08/);
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

test('every symbol and chain the draft names survives into basic', () => {
  const draft = swapDraft({ fromSymbol: 'USDC', toSymbol: 'WETH', chain: 'arb', toChain: 'arb' });
  const view = buildBasic(baseInput({ proposals: [proposal({ draft })] }));
  assert.deepEqual([...view.ask!.symbols].sort(), ['USDC', 'WETH']);
  assert.deepEqual(view.ask!.chains, ['arb']);
});

test('every draft kind produces a headline that names its amount', () => {
  const drafts: WriteDraft[] = [
    swapDraft(),
    { kind: 'hl_deposit', chain: 'arb', symbol: 'USDC', tokenId: 'USDC', amount: 20, amountUsd: 20, minCredited: 19.8, from: SELF, hlAccount: SELF, counterparty: ROUTER },
    {
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
    },
    {
      kind: 'lp_remove',
      chain: 'arb',
      venue: 'uniswap-v3',
      positionId: '3643',
      liquidityPct: 0.5,
      amountUsd: 42.5,
      from: SELF,
      counterparty: ROUTER,
    },
    { kind: 'policy_change', patch: {}, sentence: 'never hold more than 20% in anything freezable' },
  ];
  for (const draft of drafts) {
    const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: draft.kind })] }));
    assert.ok(view.ask !== null, `${draft.kind} produced no ask`);
    assert.ok(view.ask!.headline.trim().length > 0, `${draft.kind} produced an empty headline`);
    assert.equal(view.ask!.kind, draft.kind);
    if (draft.kind !== 'policy_change') {
      assert.match(view.ask!.headline, /\$/, `${draft.kind} headline must name money`);
    }
  }
});

test('a policy change says plainly that it moves no money', () => {
  const draft: WriteDraft = { kind: 'policy_change', patch: {}, sentence: 'raise the cap to $999,999' };
  const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: 'policy_change' })] }));
  assert.match(view.ask!.afterLine, /does not move any money/);
  assert.match(view.ask!.headline, /raise the cap/);
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
  // A consolidate with nothing left to gather prices at 0 and gets refused. "tried to
  // gather $0.00 of your dollars" tells this reader nothing at all.
  const draft: WriteDraft = { kind: 'consolidate', legs: [], totalUsd: 0, toChain: 'eth', symbol: 'USDT' };
  const view = buildBasic(baseInput({ proposals: [proposal({ draft, kind: 'consolidate', status: 'policy_refused', decidedAt: T1 })] }));
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
    const lines = [v.headline, v.placesLine, v.agentLine, v.footer, v.warning, v.ask?.headline, v.ask?.afterLine]
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
    assert.equal(new Set(lines).size, lines.length, `${name} renders a duplicated sentence: ${JSON.stringify(lines)}`);
  }
});

// ---------- warnings ----------

test('the gate being off warns even while a question is on screen', () => {
  const view = buildBasic(baseInput({ gateRequired: false, proposals: [proposal()] }));
  assert.equal(view.tone, 'asking', 'the question is still what the human must act on');
  assert.ok(view.warning !== null);
  assert.match(view.warning!, /without asking you first/);
});

test('a quiet screen with the gate off still shouts about it', () => {
  const view = buildBasic(baseInput({ gateRequired: false }));
  assert.equal(view.tone, 'broken');
  // The alarm has to be on the screen. It is the warning that carries the words, and
  // the tone that carries the colour, so this asserts both rather than one wording.
  assert.match(view.warning!, /without asking you first/);
  assert.match(view.headline, /not protecting it/);
  assert.doesNotMatch(view.footer, /You will be asked before/);
});

// Found by looking at the rebuilt screen rather than at the object: the headline and
// the warning were the same sentence written twice, which on a page with this much
// space around it reads as a rendering fault rather than as emphasis. Same class of
// bug as the agentLine duplication the file already guards against.
test('the headline never restates the warning directly under it', () => {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((w) => w.length > 3));
  for (const input of [
    baseInput({ gateRequired: false }),
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
// "You will be asked before anything moves" directly under a warning saying the
// gate was off. Two sentences contradicting each other is worse than either one,
// and worst on this screen, where the reader has no third source to break the tie.
test('the footer never contradicts the warning above it', () => {
  const gateOff = buildBasic(baseInput({ gateRequired: false }));
  assert.match(gateOff.warning!, /without asking you first/);
  assert.match(gateOff.footer, /NOT be asked/);
  assert.doesNotMatch(gateOff.footer, /^You will be asked/);

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
    baseInput({ gateRequired: false }),
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
    kind: 'token',
    chain: 'base',
    symbol: 'USDC',
    tokenId: 'base:usdc',
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

test('holdings sort by value and pool positions collapse into one line', () => {
  const v = buildBasic(
    baseInput({
      wallet: {
        rows: [
          walletRow({ symbol: 'USDC', quantity: 10, valueUsd: 10 }),
          walletRow({ kind: 'lp', symbol: 'USDC/WETH 0.05%', valueUsd: 300, quantity: 1 }),
          walletRow({ kind: 'lp', symbol: 'USDC/WETH 0.30%', valueUsd: 120, quantity: 1 }),
        ],
        totalUsd: 430,
        byChain: { base: 430 },
        stale: [],
        emptyCount: 0,
      },
    }),
  );

  assert.deepEqual(
    v.holdings.map((h) => h.valueLine),
    ['$420.00', '$10.00'],
  );

  // The ring is drawn from these, and a ring whose slices do not close is a drawing of an
  // arithmetic error. They are shares of the rows, which is what the ring sits beside.
  assert.deepEqual(
    v.holdings.map((h) => h.share),
    [420 / 430, 10 / 430],
  );
  assert.equal(
    v.holdings.reduce((sum, h) => sum + h.share, 0),
    1,
  );
  // Two different pools summed to one quantity would be a number that means nothing,
  // so the pool line carries a value and no quantity at all.
  assert.equal(v.holdings[0]!.name, 'Money in Uniswap pools');
  assert.equal(v.holdings[0]!.quantityLine, '');
});

test('holdings go empty exactly when the total goes unknown', () => {
  const rows = [walletRow({ valueUsd: 100, quantity: 100 })];

  const stale = buildBasic(
    baseInput({ wallet: { rows, totalUsd: 100, byChain: { base: 100 }, stale: ['near'], emptyCount: 0 } }),
  );
  assert.equal(stale.totalUsd, null);
  assert.deepEqual(stale.holdings, [], 'a partial list is worse than no list');

  const fine = buildBasic(baseInput({ wallet: { rows, totalUsd: 100, byChain: { base: 100 }, stale: [], emptyCount: 0 } }));
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
