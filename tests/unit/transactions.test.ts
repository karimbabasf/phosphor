// The transaction history is derived, so what these assert is the derivation: that every
// row traces to a proposal this app executed, that a hash points at the explorer that
// actually owns it, and that nothing is filled in where the record is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTransactions, explorerAddressUrl, explorerTxUrl, txidsFromLog } from '../../src/transactions.ts';
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
  assert.equal(entry.place, 'eth');
  assert.equal(entry.toPlace, 'sol');
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

test('an intent hash is not a transaction and is offered no link, because none resolves it', () => {
  const [sw] = build([swap()]);
  assert.equal(sw.hashes[0].kind, 'intent');
  assert.equal(sw.hashes[0].url, null, 'a link that goes nowhere is worse than a value that does not pretend');
});

test('a chain hash recorded after the intent hash keeps its explorer', () => {
  const withPayout = swap({
    draft: { ...(swap().draft as Record<string, unknown>), toChain: 'arb' } as Proposal['draft'],
    result: { ok: true, detail: 'swapped', txids: ['intentHashHere', EVM_HASH] },
  });
  const [entry] = build([withPayout]);
  assert.equal(entry.hashes[0].kind, 'intent');
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

test('gas is unknown until a receipt is read, and unknown is not zero', () => {
  const [entry] = build([deposit()]);
  assert.equal(entry.hashes[0].gas, null);
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
