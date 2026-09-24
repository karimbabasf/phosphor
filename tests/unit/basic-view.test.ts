// The balances panel's view model. The panel is where a person checks that their money is
// there, so these tests are mostly about what it REFUSES to say: no fabricated balance, never a
// zero standing in for an unknown, never a list that looks complete while a place is unread.
//
// It is also the whole of what the window reads from `state.basic`, and nothing more: nine keys
// nobody drew were rebuilt on every state frame until 2026-09-23.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBasic, didHeadline, triedHeadline } from '../../src/view/basic.ts';
import type { BasicInput } from '../../src/view/basic.ts';
import type { Proposal, SwapDraft, WalletRow, WalletView, WriteDraft } from '../../src/types.ts';

const SELF = '0x2dd9131edF3CC393B757463C85b2C870A6F3180a';
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

const T0 = '2026-08-12T10:00:00.000Z';
const T1 = '2026-08-12T11:00:00.000Z';
const T2 = '2026-08-12T12:00:00.000Z';

function wallet(over: Partial<WalletView> = {}): WalletView {
  return { rows: [], totalUsd: 2341.08, byChain: { intents: 2341.08 }, stale: [], emptyCount: 0, dustCount: 0, dustUsd: 0, unpriced: [], ...over };
}

function baseInput(over: Partial<BasicInput> = {}): BasicInput {
  return {
    wallet: wallet(),
    proposals: [],
    policyReadable: true,
    killSwitch: false,
    readAt: T2,
    ...over,
  };
}

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

// ---------- the keys ----------

test('the view carries what the panel draws and nothing else', () => {
  const view = buildBasic(baseInput());
  assert.deepEqual(Object.keys(view).sort(), ['caption', 'emptyLine', 'holdings', 'smallLine', 'totalLine', 'totalUsd', 'warning']);
});

// ---------- the total ----------

test('a settled total is the figure and "in your balance" under it', () => {
  const view = buildBasic(baseInput());
  assert.equal(view.totalUsd, 2341.08);
  assert.equal(view.totalLine, '$2,341.08');
  assert.equal(view.caption, 'in your balance');
});

test('a stale place shows no number at all when nothing was read, never a zero', () => {
  const view = buildBasic(baseInput({ wallet: wallet({ totalUsd: 0, byChain: {}, stale: ['intents'] }) }));
  assert.equal(view.totalUsd, null);
  assert.equal(view.totalLine, '');
  assert.equal(view.caption, 'Still checking your balance.');
});

test('a stale place keeps the last read total in the slot, and says it is still checking', () => {
  const row = walletRow({ quantity: 2000, valueUsd: 2000, share: 1 });
  const view = buildBasic(baseInput({ wallet: wallet({ rows: [row], totalUsd: 2000, stale: ['hyperliquid'] }) }));
  assert.equal(view.totalUsd, null, 'the number is not fact while a place is unread');
  assert.equal(view.totalLine, '$2,000.00');
  assert.equal(view.caption, 'still checking');
});

test('a coin with no price keeps the total from reading as the whole, and is named', () => {
  // 2026-09-20: "$0.00" over 2.0097 wNEAR. The figure is what is priced; the line says what it leaves out.
  const priced = walletRow({ symbol: 'USDC', quantity: 7.01, valueUsd: 7.01, share: 1 });
  const dark = walletRow({ symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priceUsd: 0, share: 0, priced: false });
  const some = buildBasic(baseInput({ wallet: wallet({ rows: [priced, dark], totalUsd: 7.01, unpriced: ['wNEAR'] }) }));
  assert.equal(some.totalLine, '$7.01');
  assert.equal(some.caption, 'in your balance, not counting wNEAR');

  const two = buildBasic(baseInput({
    wallet: wallet({ rows: [priced, dark, walletRow({ symbol: 'WIF', valueUsd: 0, priced: false })], totalUsd: 7.01, unpriced: ['wNEAR', 'WIF'] }),
  }));
  assert.equal(two.caption, 'in your balance, not counting wNEAR and WIF');

  const none = buildBasic(baseInput({ wallet: wallet({ rows: [dark], totalUsd: 0, unpriced: ['wNEAR'] }) }));
  assert.equal(none.totalLine, '', 'no figure rather than $0.00 over a coin somebody holds');
  assert.equal(none.caption, 'No price for wNEAR right now, so there is no total yet.');
});

test('a balance read before the last execution is not stated as fact', () => {
  // The ledger cache serves pre-trade balances after a write and still reports stale: [].
  const view = buildBasic(baseInput({ proposals: [proposal({ status: 'executed', decidedAt: T2 })], readAt: T0 }));
  assert.equal(view.totalUsd, null);
  assert.equal(view.totalLine, '$2,341.08', 'the last read stays in the slot');
  assert.equal(view.caption, 'checking your new balance');
});

test('a balance read after the last execution is stated normally', () => {
  const view = buildBasic(baseInput({ proposals: [proposal({ status: 'executed', decidedAt: T0 })], readAt: T2 }));
  assert.equal(view.totalUsd, 2341.08);
  assert.equal(view.caption, 'in your balance');
});

test('the stale check judges by when the money moved, not by when the click landed', () => {
  // Decided at T0, filled at T2. A read stamped T1 is after the decision and before the fill.
  const view = buildBasic(baseInput({ proposals: [proposal({ status: 'executed', decidedAt: T0, settledAt: T2 })], readAt: T1 }));
  assert.equal(view.totalUsd, null);
  assert.equal(view.caption, 'checking your new balance');
});

test('a move the app could not confirm keeps the balance unstated until the ledger has read past it', () => {
  const unconfirmed = proposal({ status: 'needs_reconciliation', decidedAt: T2, result: { ok: false, detail: 'unconfirmed', txids: ['h1'] } });
  assert.equal(buildBasic(baseInput({ proposals: [unconfirmed], readAt: T1 })).totalUsd, null, 'money may have left');
  assert.equal(buildBasic(baseInput({ proposals: [unconfirmed], readAt: '2026-08-12T13:00:00.000Z' })).totalUsd, 2341.08);
});

test('a failed row with no hash moved nothing, so it never puts the balance in question', () => {
  const failed = proposal({ status: 'failed', decidedAt: T2, result: { ok: false, detail: 'refused before the key', txids: [] } });
  const view = buildBasic(baseInput({ proposals: [failed], readAt: T1 }));
  assert.equal(view.totalUsd, 2341.08);
  assert.equal(view.caption, 'in your balance');
});

// ---------- what you hold ----------

test('one row per coin, titled by its symbol, with the plain name kept for a screen reader', () => {
  const view = buildBasic(baseInput({
    wallet: wallet({
      rows: [
        walletRow({ chain: 'intents', symbol: 'USDC', quantity: 700, valueUsd: 700 }),
        walletRow({ chain: 'hyperliquid', kind: 'hyperliquid', symbol: 'USDC', quantity: 504, valueUsd: 504 }),
        walletRow({ symbol: 'ETH', quantity: 0.31, priceUsd: 3184.13, valueUsd: 987.08 }),
      ],
      totalUsd: 2191.08,
    }),
  }));
  assert.deepEqual(view.holdings.map((h) => h.symbol), ['USDC', 'ETH'], 'value first');
  const usdc = view.holdings[0]!;
  assert.equal(usdc.name, 'US dollars (USDC)');
  assert.equal(usdc.valueUsd, 1204);
  assert.equal(usdc.valueLine, '$1,204.00');
  assert.equal(usdc.quantityLine, '1,204.00');
});

test('a coin with no price is listed with no dollar figure, never $0.00, after the priced ones', () => {
  const view = buildBasic(baseInput({
    wallet: wallet({
      rows: [
        walletRow({ symbol: 'WIF', quantity: 12.5, priceUsd: 0, valueUsd: 0, priced: false }),
        walletRow({ symbol: 'USDC', quantity: 50, valueUsd: 50 }),
      ],
      totalUsd: 50,
      unpriced: ['WIF'],
    }),
  }));
  assert.deepEqual(view.holdings.map((h) => h.symbol), ['USDC', 'WIF']);
  const wif = view.holdings[1]!;
  assert.equal(wif.valueLine, null);
  assert.equal(wif.valueUsd, null);
  assert.equal(wif.quantityLine, '12.50');
  assert.equal(view.smallLine, null, 'an unknown value is not a small one');
});

test('balances under a cent fold into one quiet line, counted with the ones the wallet kept out', () => {
  const view = buildBasic(baseInput({
    wallet: wallet({
      rows: [
        walletRow({ symbol: 'USDC', quantity: 50, valueUsd: 50 }),
        walletRow({ symbol: 'SOL', quantity: 0.00003, priceUsd: 140, valueUsd: 0.0042 }),
      ],
      totalUsd: 50.0042,
      dustCount: 1,
      dustUsd: 0.001,
    }),
  }));
  assert.deepEqual(view.holdings.map((h) => h.symbol), ['USDC']);
  assert.equal(view.smallLine, '2 tiny balances under a cent, not listed');
  const one = buildBasic(baseInput({ wallet: wallet({ rows: [walletRow()], totalUsd: 100, dustCount: 1, dustUsd: 0.002 }) }));
  assert.equal(one.smallLine, '1 tiny balance under a cent, not listed');
  assert.equal(buildBasic(baseInput({ wallet: wallet({ rows: [walletRow()], totalUsd: 100 }) })).smallLine, null);
});

test('holdings go empty exactly when a place could not be read, and the list says why', () => {
  const rows = [walletRow({ valueUsd: 100, quantity: 100 })];
  const stale = buildBasic(baseInput({ wallet: wallet({ rows, totalUsd: 100, stale: ['intents'] }) }));
  assert.deepEqual(stale.holdings, [], 'a partial list is worse than no list');
  assert.equal(stale.emptyLine, 'Part of your balance could not be read just now. It shows here as soon as it can be.');
  assert.doesNotMatch(stale.emptyLine ?? '', /Nothing here/, 'an unread wallet is not an empty one');

  const fine = buildBasic(baseInput({ wallet: wallet({ rows, totalUsd: 100 }) }));
  assert.equal(fine.holdings.length, 1);
  assert.equal(fine.emptyLine, null);
});

test('a wallet that holds nothing says so calmly, and a true zero is a figure', () => {
  const view = buildBasic(baseInput({ wallet: wallet({ totalUsd: 0, byChain: {} }) }));
  assert.equal(view.totalLine, '$0.00', 'every place answered and there is nothing: that zero is a fact');
  assert.equal(view.emptyLine, 'Nothing here yet. Money you add shows up here as it lands.');
});

test('a read that predates the last write still lists what it read', () => {
  const held = wallet({ rows: [walletRow({ quantity: 1850, valueUsd: 1850, share: 1 })], totalUsd: 1850 });
  const checking = buildBasic(baseInput({ wallet: held, proposals: [proposal({ status: 'executed', decidedAt: T2 })], readAt: T0 }));
  assert.equal(checking.totalUsd, null);
  assert.ok(checking.holdings.length > 0, 'the panel still shows what the last read held');
});

// ---------- warnings ----------

test('a warning only when nothing can move, in plain words', () => {
  assert.equal(buildBasic(baseInput()).warning, null);
  assert.match(buildBasic(baseInput({ killSwitch: true })).warning ?? '', /frozen everything/);
  assert.match(buildBasic(baseInput({ policyReadable: false })).warning ?? '', /rules cannot be read/);
});

// ---------- the headlines the receipts use ----------

// A draft can legitimately price at zero. The first version substituted the word "money" for the
// missing figure and rendered "gathering money of your US dollars (USDT) onto Ethereum".
test('a zero-priced draft drops the money clause rather than wording around it', () => {
  const drafts: WriteDraft[] = [
    swapDraft({ amountUsd: 0 }),
    { kind: 'consolidate', symbol: 'USDT', toChain: 'eth', totalUsd: 0, legs: [] } as unknown as WriteDraft,
  ];
  for (const draft of drafts) {
    for (const line of [didHeadline(draft, 0), triedHeadline(draft, 0)]) {
      assert.doesNotMatch(line, /money of your/, `not English: ${line}`);
      assert.doesNotMatch(line, /\$0\.00/, `a zero is the absence of an amount, not one: ${line}`);
    }
  }
  assert.match(didHeadline(swapDraft({ amountUsd: 105 }), 105), /^Changed \$105\.00 of your/);
  assert.match(triedHeadline(swapDraft({ amountUsd: 105 }), 105), /^Tried to change \$105\.00 of your/);
});

// ---------- the window that renders it ----------

// The source with its comments taken out. A comment that names the bug it fixed would
// otherwise satisfy an assertion looking for the bug.
function codeOf(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the panel is one surface, reads only the view above, and has no Freeze of its own', () => {
  const source = codeOf('../../ui/screens/basic.js');
  assert.ok(source.includes("'holdings'"), 'ui/screens/basic.js must place the holdings surface');
  for (const gone of ['placesLine', 'headline', 'agentLine', 'footer', '.prices', '.recent', '.actions', 'checkingLine']) {
    assert.ok(!source.includes(gone), `ui/screens/basic.js still reads ${gone}`);
  }
  assert.ok(!source.includes('Freeze everything'), 'two copies of the brake on one screen');
});
