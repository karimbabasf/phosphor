// The transaction history is derived, so what these assert is the derivation: that every
// row traces to a proposal this app executed, that a hash points at the explorer that
// actually owns it, and that nothing is filled in where the record is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTransactions, depositHandleOf, explorerAddressUrl, explorerTxUrl, txidsFromLog } from '../../src/transactions.ts';
import type { LogEvent, Proposal } from '../../src/types.ts';

const SELF = '0x1111111111111111111111111111111111111111';
const EVM_HASH = '0x' + 'a'.repeat(64);

function swap(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-swap',
    kind: 'swap',
    createdAt: '2026-08-13T05:07:06.560Z',
    status: 'executed',
    draft: {
      kind: 'swap',
      venue: 'intents-native',
      chain: 'eth',
      toChain: 'sol',
      fromSymbol: 'ETH',
      toSymbol: 'SOL',
      amountIn: 0.0048869082,
      amountUsd: 9.23,
      minAmountOut: 0.1196,
      from: SELF,
      to: SELF,
      counterparty: 'intents.near',
      quote: null,
    },
    simulation: { ok: true, summary: 'intents-native: 0.0048 ETH -> 0.1214 SOL\nfee $0.0027, eta ~10s' },
    verdict: { outcome: 'allow', reasons: ['swap of $9.24 to intents.near.'] },
    decidedBy: 'policy',
    decidedAt: '2026-08-13T05:07:12.898Z',
    result: {
      ok: true,
      detail: 'swapped 0.0048869082 ETH for 0.121448554 SOL inside intents.near; intent G8tyevVXKS4RA',
      txids: ['G8tyevVXKS4RA'],
    },
    ...over,
  } as Proposal;
}

function deposit(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-deposit',
    kind: 'intents_deposit',
    createdAt: '2026-08-13T04:45:00.000Z',
    status: 'executed',
    draft: {
      kind: 'intents_deposit',
      chain: 'eth',
      symbol: 'ETH',
      tokenId: 'native',
      amount: 0.0033,
      amountUsd: 6.2,
      minCredited: 0.0032,
      from: SELF,
      intentsAccount: SELF.toLowerCase(),
      counterparty: 'intents.near',
    },
    simulation: { ok: true, summary: 'intents deposit: 0.0033 ETH\nfee $0.0100, eta ~30s' },
    verdict: { outcome: 'allow', reasons: [] },
    decidedBy: 'policy',
    decidedAt: '2026-08-13T04:45:23.509Z',
    result: { ok: true, detail: '0.0032967 ETH now credited to ' + SELF, txids: [EVM_HASH] },
    ...over,
  } as Proposal;
}

function build(proposals: Proposal[], events: LogEvent[] = []) {
  return buildTransactions({ proposals, events, selfAddresses: [SELF] });
}

test('an executed proposal becomes one row, with the movement it actually made', () => {
  const [entry] = build([swap()]);
  assert.equal(entry.action, 'swap');
  assert.equal(entry.status, 'executed');
  // Both legs inside the verifier: eth and sol are the assets' home chains, not places.
  assert.equal(entry.place, 'intents');
  assert.equal(entry.toPlace, 'intents');
  assert.deepEqual(entry.sent, { symbol: 'ETH', amount: 0.0048869082 });
  assert.deepEqual(entry.received, { symbol: 'SOL', amount: 0.121448554 }, 'the fill, read off the rail sentence');
  assert.equal(entry.valueUsd, 9.23);
});

test('a fill is only ever the amount the rail reported, never the approved floor', () => {
  const noDetail = swap({ result: { ok: true, detail: 'swapped it', txids: [] } });
  const [entry] = build([noDetail]);
  assert.equal(entry.received, null, 'silence is reported as silence, not as minAmountOut');
});

test('a pending proposal is not a transaction', () => {
  const pending = swap({ status: 'pending', decidedAt: undefined, result: undefined });
  assert.equal(build([pending]).length, 0);
});

test('a policy change is not a transaction: it moves no money', () => {
  const policy = {
    id: 'p-policy',
    kind: 'policy_change',
    createdAt: '2026-08-13T01:00:00.000Z',
    status: 'executed',
    draft: { kind: 'policy_change', patch: {}, sentence: 'raise the cap' },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: true, detail: 'applied' },
  } as unknown as Proposal;
  assert.equal(build([policy]).length, 0);
});

/* Until 2026-09-15 a trade had no row at all, because margin, position and profit stay on the
   venue. It is a row now (the lead's call: what the click armed or closed belongs in Activity),
   but the old reason still shapes it: nothing is sent, nothing is received, and the value is
   the stake the policy engine governed on. */
test('a trade is a row on the venue, not a movement: nothing sent, the stake as its value', () => {
  const trade = {
    id: 'p-trade',
    kind: 'trade',
    createdAt: '2026-09-11T10:00:00.000Z',
    status: 'executed',
    draft: {
      kind: 'trade',
      op: 'open',
      plan: { id: 'pl_1', symbol: 'BTC', side: 'long', sizeUsd: 4000, leverage: 20, entry: { type: 'market', maxSlippageBps: 30 }, stop: 63000, expiresAt: '2026-09-12T10:00:00.000Z' },
      hash: 'h',
      risk: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
      amountUsd: 200,
      counterparty: 'hyperliquid-perps',
    },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedBy: 'policy',
    decidedAt: '2026-09-11T10:00:01.000Z',
    result: { ok: true, detail: 'pl_1 armed on BTC', txids: [] },
  } as unknown as Proposal;
  const [arm] = build([trade]);
  assert.ok(arm);
  assert.equal(arm.kind, 'bot');
  assert.equal(arm.sent, null);
  assert.equal(arm.received, null);
  assert.equal(arm.valueUsd, 200);
  assert.equal(arm.place, 'hyperliquid');
  const change = { ...trade, id: 'p-change', draft: { kind: 'trade', op: 'change', id: 'pl_1', close: true, before: {}, after: {}, amountUsd: 200, counterparty: 'hyperliquid-perps' } } as unknown as Proposal;
  const [closed] = build([change]);
  assert.ok(closed);
  assert.equal(closed.kind, 'trade');
  assert.equal(closed.sent, null);
});

test('a failed execution stays in the history: what did not happen is part of the record', () => {
  const failed = swap({ status: 'failed', result: { ok: false, detail: 'the rail refused', txids: [] } });
  const [entry] = build([failed]);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.detail, 'the rail refused');
});

test('an EVM hash links to the chain it was mined on', () => {
  const [dep] = build([deposit()]);
  assert.equal(dep.hashes[0].kind, 'chain');
  assert.equal(dep.hashes[0].place, 'eth');
  assert.equal(dep.hashes[0].url, 'https://etherscan.io/tx/' + EVM_HASH);
});

test('an intent hash with no quote handle in the record is offered no link, because none resolves it', () => {
  const [sw] = build([swap()]);
  assert.equal(sw.hashes[0].kind, 'intent');
  assert.equal(sw.hashes[0].url, null, 'a link that goes nowhere is worse than a value that does not pretend');
});

test("an intent hash links to the venue explorer's page for its swap, keyed by the quote handle", () => {
  // The NEAR Intents explorer has no page for an intent hash; it has one per deposit address,
  // the handle 1Click mints for the swap, which every intents rail writes into its evidence
  // sentence as "quote handle <address>". Checked live on 2026-09-14 (transactions.ts).
  const handle = '0xF121dEAE804852e25a92fe4eB64A0dA405a564c7';
  const withHandle = swap({
    result: {
      ok: true,
      detail: `swapped 0.0048869082 ETH for 0.121448554 SOL inside intents.near; intent G8tyevVXKS4RA, quote handle ${handle}`,
      txids: ['G8tyevVXKS4RA'],
    },
  });
  const [sw] = build([withHandle]);
  assert.equal(sw.hashes[0].kind, 'intent');
  assert.equal(sw.hashes[0].url, `https://explorer.near-intents.org/transactions/${handle}`);
  assert.equal(depositHandleOf(sw.detail), handle);
});

test('the quote handle is read off the two sentences the rails write, and off nothing else', () => {
  assert.equal(depositHandleOf('swapped 1 ETH for 3000 USDC; intent Abc123, quote handle 0xabc.near'), '0xabc.near');
  assert.equal(depositHandleOf('swapped 1 ETH for 3000 USDC; intent Abc123, quote handle HXJX3Dq7Wn2mXy1b.'), 'HXJX3Dq7Wn2mXy1b', 'the full stop that ends the sentence is not part of the handle');
  assert.equal(depositHandleOf('quote handle a.b.near.'), 'a.b.near', 'dots inside a NEAR account stay, the last one goes');
  assert.equal(depositHandleOf('swapped 1 ETH on base for 3000 USDC on arb; deposit 0xF121dEAE804852e25a92fe4eB64A0dA405a564c7, origin tx 0x1'), '0xF121dEAE804852e25a92fe4eB64A0dA405a564c7');
  assert.equal(depositHandleOf('1.9927 USDC paid out to our arb wallet'), null, 'a sentence with no handle invented one');
  assert.equal(depositHandleOf('deposit transfer failed: no funds left the wallet.'), null, 'the word deposit alone is not a handle');
  assert.equal(depositHandleOf('the deposit address 0xF121dEAE804852e25a92fe4eB64A0dA405a564c7 has no storage'), null, 'an address after other words is not the handle');
});

test('a row the retired 1Click venue wrote still moves between chains, and its payout hash keeps its explorer', () => {
  const withPayout = swap({
    draft: { ...(swap().draft as Record<string, unknown>), venue: 'oneclick', toChain: 'arb' } as unknown as Proposal['draft'],
    result: { ok: true, detail: 'swapped', txids: [EVM_HASH, EVM_HASH] },
  });
  const [entry] = build([withPayout]);
  assert.equal(entry.place, 'eth', 'the origin chain, as the row recorded it');
  assert.equal(entry.toPlace, 'arb');
  assert.equal(entry.hashes[0].kind, 'chain');
  assert.equal(entry.hashes[1].kind, 'chain');
  assert.equal(entry.hashes[1].url, 'https://arbiscan.io/tx/' + EVM_HASH, 'the payout landed on arb');
});

test('a balance inside the verifier gets no address link: no explorer has a page for it', () => {
  const withdraw = {
    id: 'p-w',
    kind: 'intents_withdraw',
    createdAt: '2026-08-13T05:57:00.000Z',
    status: 'executed',
    draft: {
      kind: 'intents_withdraw',
      chain: 'arb',
      symbol: 'USDC',
      amount: 2,
      amountUsd: 2,
      minReceived: 1.94,
      from: SELF.toLowerCase(),
      to: SELF,
      counterparty: 'intents.near',
    },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedAt: '2026-08-13T05:57:49.474Z',
    result: { ok: true, detail: '1.9927 USDC paid out to our arb wallet', txids: ['intentHashHere'] },
  } as unknown as Proposal;

  const [entry] = build([withdraw]);
  assert.equal(entry.from?.place, 'intents');
  assert.equal(entry.from?.url, null);
  assert.equal(entry.to?.url, 'https://arbiscan.io/address/' + SELF, 'where it landed is a real address on a real chain');
  assert.deepEqual(entry.received, { symbol: 'USDC', amount: 1.9927 });
});

test('hashes come off the proposal, and off the log for records written before they were stored', () => {
  const legacy = swap({ result: { ok: true, detail: 'swapped', txids: undefined } as Proposal['result'] });
  const events: LogEvent[] = [
    { ts: '2026-08-13T05:07:12.898Z', type: 'executed', msg: 'p-swap: swapped', data: { id: 'p-swap', txids: ['fromTheLog'] } },
  ];
  const [entry] = build([legacy], events);
  assert.equal(entry.hashes[0].hash, 'fromTheLog', 'a compacted log would have lost this, which is why it is stored now');

  assert.deepEqual(txidsFromLog(events).get('p-swap'), ['fromTheLog']);
});

test('our own address is marked as ours wherever it appears', () => {
  const [entry] = build([deposit()]);
  assert.equal(entry.from?.self, true);
  assert.equal(entry.from?.url, 'https://etherscan.io/address/' + SELF);
  assert.equal(entry.to?.self, true, 'the intents account is the same address, lowercased');
});

test('the venue fee is the one the human approved, and is absent when no quote named one', () => {
  assert.equal(build([swap()])[0].venueFeeUsd, 0.0027);
  const noFee = swap({ simulation: { ok: true, summary: 'no fee line here' } });
  assert.equal(build([noFee])[0].venueFeeUsd, null);
});

test('a move with no token amount says what it did move', () => {
  const lpRemove = {
    id: 'p-lp',
    kind: 'lp_remove',
    createdAt: '2026-08-11T18:00:00.000Z',
    status: 'executed',
    draft: {
      kind: 'lp_remove',
      chain: 'arb',
      venue: 'uniswap-v3',
      positionId: '4242',
      liquidityPct: 0.5,
      amountUsd: 11.7,
      from: SELF,
      counterparty: '0xmanager',
    },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: true, detail: 'pulled half', txids: [] },
  } as unknown as Proposal;

  const [entry] = build([lpRemove]);
  assert.equal(entry.sent, null, 'pulling liquidity is not an amount of a token');
  assert.equal(entry.note, '50% of the position', 'and "--" would say nothing the record does not know');
});

test('the list reads newest first', () => {
  const entries = build([deposit(), swap()]);
  assert.deepEqual(entries.map(e => e.id), ['p-swap', 'p-deposit']);
});

test('an explorer link names the chain the hash is actually on', () => {
  assert.equal(explorerTxUrl('arb', '0xabc'), 'https://arbiscan.io/tx/0xabc');
  assert.equal(explorerAddressUrl('near', 'demo.near'), 'https://nearblocks.io/address/demo.near');
  assert.equal(explorerAddressUrl('base', '0xabc'), 'https://basescan.org/address/0xabc');
  assert.equal(explorerTxUrl('sol', 'sig'), 'https://solscan.io/tx/sig');
});

// ---------- the yield rail ----------
//
// These fell through the shape switch's `default` until 2026-08-20, which returns place 'eth'
// and nulls for everything else. So every supply to a lending pool read as an Ethereum
// movement of an unnamed amount to nobody, whatever chain it was actually on, and the gas
// column beside it was right the whole time because TxGas.place is the chain whose RPC
// answered rather than the draft's guess. A money column and a fee column disagreeing about
// which chain a row is on is the kind of defect that is easy to look straight past.

function yieldDeposit(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-yield-deposit',
    kind: 'yield_deposit',
    createdAt: '2026-08-20T18:35:22.000Z',
    status: 'executed',
    draft: {
      kind: 'yield_deposit',
      venue: 'aave-v3',
      chain: 'arb',
      symbol: 'USDC',
      amount: 50,
      amountBase: '50000000',
      decimals: 6,
      amountUsd: 50,
      from: SELF,
      counterparty: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    },
    simulation: { ok: true, summary: 'aave-v3: supply 50 USDC on arb' },
    verdict: { outcome: 'allow', reasons: ['$50.00 against a $100 click threshold'] },
    decidedBy: 'policy',
    decidedAt: '2026-08-20T18:35:27.000Z',
    result: { ok: true, detail: 'supplied 50 USDC to Aave v3 on arb', txids: [EVM_HASH] },
    ...over,
  } as Proposal;
}

test('a supply to a lending pool is recorded on the chain it happened on, not on Ethereum', () => {
  const [entry] = build([yieldDeposit()]);
  assert.equal(entry!.action, 'deposit');
  assert.equal(entry!.kind, 'yield_deposit');
  assert.equal(entry!.place, 'arb');
  assert.equal(entry!.toPlace, 'arb');
});

test('a supply names its venue and its size, so the row says what moved and where it went', () => {
  const [entry] = build([yieldDeposit()]);
  assert.equal(entry!.venue, 'aave-v3');
  assert.deepEqual(entry!.sent, { symbol: 'USDC', amount: 50 });
  assert.equal(entry!.counterparty?.address, '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
  // Out of our wallet, into the pool. The direction is the whole difference from a withdrawal.
  assert.equal(entry!.from?.self, true);
  assert.equal(entry!.to?.address, '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
});

test('a withdrawal runs the other way: out of the pool, back to us', () => {
  const [entry] = build([
    yieldDeposit({
      id: 'p-yield-withdraw',
      kind: 'yield_withdraw',
      draft: {
        kind: 'yield_withdraw',
        venue: 'aave-v3',
        chain: 'arb',
        symbol: 'USDC',
        amount: 10,
        amountBase: '10000000',
        decimals: 6,
        amountUsd: 10,
        from: SELF,
        counterparty: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
      },
    } as unknown as Partial<Proposal>),
  ]);
  assert.equal(entry!.action, 'withdraw');
  assert.equal(entry!.place, 'arb');
  assert.equal(entry!.from?.address, '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
  assert.equal(entry!.to?.self, true);
  assert.deepEqual(entry!.sent, { symbol: 'USDC', amount: 10 });
});

test('a full exit records no amount, because the figure in the draft was stale before it was written', () => {
  // amountBase null is how "the whole position, interest included" is expressed. The rebasing
  // receipt grows while the proposal waits for a click, so the rail reads the balance at
  // execution. Printing the quoted number here would be printing a number that was already
  // wrong, and this row's own detail line carries what actually came back.
  const [entry] = build([
    yieldDeposit({
      id: 'p-yield-exit',
      kind: 'yield_withdraw',
      draft: {
        kind: 'yield_withdraw',
        venue: 'aave-v3',
        chain: 'arb',
        symbol: 'USDC',
        amount: 56.292312,
        amountBase: null,
        decimals: 6,
        amountUsd: 56.29,
        from: SELF,
        counterparty: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
      },
    } as unknown as Partial<Proposal>),
  ]);
  assert.equal(entry!.sent, null);
  assert.equal(entry!.venue, 'aave-v3');
  assert.equal(entry!.place, 'arb');
});

// ---------- the venue rows: an armed plan, a close, a cancel, a moved stop ----------
//
// A trade moves nothing off the venue, and it used to have no row for that reason. It is still
// something that happened to the money: the click armed a bot that acts without asking again, or
// closed a trade at the market. So the executed proposal becomes a row on the venue, with the
// proposal's own time, no sent amount (nothing left the trading account), the stake as its value,
// and the venue's own sentence. What the row does NOT carry is a fill: the proposal record holds
// no fill price, size, time or fee, because the runner reads fills off the venue after the click.

const HL_HASH = '0x' + 'b'.repeat(64);

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1', symbol: 'BTC', side: 'long', sizeUsd: 12, leverage: 2,
    entry: { type: 'market', maxSlippageBps: 30 }, stop: 76_000, target: 79_500, ...over,
  };
}

const RISK = { marginUsd: 6, maxLossUsd: 0.62, stopSlipUsd: 0.1, entryRef: 76_425, liquidationPx: 40_000, notionalUsd: 12, amountUsd: 6 };

function armed(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-arm',
    kind: 'trade',
    createdAt: '2026-09-15T10:00:00.000Z',
    status: 'executed',
    draft: { kind: 'trade', op: 'open', plan: plan(), hash: 'h1', risk: RISK, amountUsd: 6, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Long BTC $12 at 2x' },
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    decidedBy: 'human',
    decidedAt: '2026-09-15T10:00:05.000Z',
    result: { ok: true, detail: 'plan-1 armed on BTC' },
    ...over,
  } as unknown as Proposal;
}

function change(over: Record<string, unknown>, id = 'p-change'): Proposal {
  return armed({
    id,
    draft: { kind: 'trade', op: 'change', id: 'plan-1', before: RISK, after: RISK, amountUsd: 0, counterparty: 'hyperliquid-perps', ...over },
    result: { ok: true, detail: 'plan-1 closed' },
  } as unknown as Partial<Proposal>);
}

test('an armed plan is a bot row on the venue: no sent amount, the stake as its value, the venue sentence', () => {
  const [row] = build([armed()]);
  assert.ok(row);
  assert.equal(row.action, 'trade');
  assert.equal(row.kind, 'bot');
  assert.equal(row.status, 'executed');
  assert.equal(row.place, 'hyperliquid');
  assert.equal(row.toPlace, 'hyperliquid');
  assert.equal(row.venue, 'hyperliquid');
  assert.equal(row.sent, null, 'nothing left the trading account');
  assert.equal(row.received, null);
  assert.equal(row.valueUsd, 6, 'the stake is what the policy engine governed on');
  assert.equal(row.ts, '2026-09-15T10:00:05.000Z', 'the proposal\'s own time');
  assert.equal(row.detail, 'plan-1 armed on BTC');
  assert.equal(row.counterparty?.address, 'hyperliquid-perps');
  assert.deepEqual(row.hashes, [], 'an arm records no venue hash, and none is invented');
});

test('a close and a moved stop are trade rows, a cancel is a bot row', () => {
  const rows = build([
    change({ close: true }, 'p-close'),
    change({ cancel: true }, 'p-cancel'),
    change({ stop: 77_000 }, 'p-stop'),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get('p-close')?.kind, 'trade');
  assert.equal(byId.get('p-cancel')?.kind, 'bot');
  assert.equal(byId.get('p-stop')?.kind, 'trade');
  for (const r of rows) {
    assert.equal(r.action, 'trade');
    assert.equal(r.place, 'hyperliquid');
    assert.equal(r.sent, null);
  }
});

test('a venue hash on a trade links to the venue explorer and never goes looking for an EVM receipt', () => {
  const [row] = build([armed({ result: { ok: true, detail: 'plan-1 armed on BTC', txids: [HL_HASH] } })]);
  assert.ok(row);
  assert.equal(row.hashes.length, 1);
  assert.equal(row.hashes[0]?.place, 'hyperliquid');
  assert.equal(row.hashes[0]?.url, explorerTxUrl('hyperliquid', HL_HASH));
});

test('a trade that the venue refused is a failed row, and a pending one is no row', () => {
  const rows = build([
    armed({ id: 'p-refused', status: 'failed', result: { ok: false, detail: 'the venue refused the order' } }),
    armed({ id: 'p-waiting', status: 'pending', result: undefined }),
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['p-refused', 'failed']]);
});

test('a retired standing mandate still on disk reads as a bot that was armed', () => {
  const [row] = build([
    armed({
      id: 'p-mandate',
      kind: 'mandate_arm' as Proposal['kind'],
      draft: { kind: 'mandate_arm', symbol: 'ETH', maxNotionalUsd: 100, maxLossUsd: 10, amountUsd: 100, counterparty: 'hyperliquid-perps' } as unknown as Proposal['draft'],
      result: { ok: true, detail: 'mandate armed' },
    }),
  ]);
  assert.ok(row);
  assert.equal(row.action, 'arm');
  assert.equal(row.kind, 'bot');
  assert.equal(row.place, 'hyperliquid');
  assert.equal(row.valueUsd, 100);
});
