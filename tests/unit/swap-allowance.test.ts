// swap_quote once the vault has moved to the chip (PHASE2-PLAN.md C6). A move spends the allowance.
// A swap bigger than the allowance but inside what the vault adds is still a price, and the answer
// names the shortfall that moves from the vault first, a top-up the person confirms with Touch ID.
// More than both is short, a vault nobody could read is unread, and under kind key nothing changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Rail, RailResult, SwapDraft, SwapQuoteFacts } from '../../src/types.ts';
import type { OneClickToken } from '../../src/intents.ts';
import type { IntentsHolding, IntentsRead } from '../../src/ledger/intents.ts';
import { mergeIntentsReads } from '../../src/ledger/intents.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { useRailAccounts } from '../../src/intents-sign.ts';
import { SELF_EVM, makeCtx, railThat } from './helpers/proposals.ts';

const VAULT = SELF_EVM.toLowerCase();
const ALLOWANCE = '0xf6beee2877dc58331cfa06c66cc47b5f2535a379';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const WNEAR = 'nep141:wrap.near';
const LIST: OneClickToken[] = [
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1 },
  { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3.1 },
] as OneClickToken[];

function holding(accountId: string, amountBase: bigint): IntentsHolding {
  return { accountId, assetId: USDC, symbol: 'USDC', originChain: 'near', amount: Number(amountBase) / 1e6, amountBase: amountBase.toString(), decimals: 6 };
}

function readOf(holdings: IntentsHolding[]): IntentsRead {
  return { ok: true, fetchedAt: new Date().toISOString(), holdings, failures: 0 };
}

function venueRail(): Rail {
  const base = railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'never run here' }));
  return {
    ...base,
    async facts(draft): Promise<SwapQuoteFacts> {
      const d = draft as SwapDraft;
      return { amountIn: d.amountInExact ?? String(d.amountIn), expectedOut: '48.3', minOut: '47.8', feeUsd: 0.05, etaSeconds: 12 };
    },
  };
}

/* A wallet whose vault moved: the allowance holds `allowance` USDC and the vault `vault` (null is a
   vault the verifier would not answer for), each read apart and together, as src/ledger/index.ts
   keeps them. `kind: 'key'` is the same balance in a wallet that never moved. */
function chipCtx(allowance: bigint, vault: bigint | null, kind: 'key' | 'chip' = 'chip') {
  const spend = kind === 'chip' ? ALLOWANCE : VAULT;
  useRailAccounts(() => ({ kind, vault: VAULT, spend }));
  const vaultRead = readOf(vault === null || vault === 0n ? [] : [holding(VAULT, vault)]);
  const spendRead = readOf(allowance === 0n ? [] : [holding(spend, allowance)]);
  const registry: RailRegistry = {
    for: () => venueRail(),
    kinds: () => ['swap'],
    swap: {
      tokens: async () => LIST,
      balance: async (account, assetId) => {
        if (assetId !== USDC) return 0n;
        if (account.toLowerCase() === spend) return allowance;
        return account.toLowerCase() === VAULT ? vault : 0n;
      },
      activity: async () => ({ account: spend, ok: false, rows: [], balances: null, partial: false, source: 'none', explorer: null, note: '' }),
    },
  };
  const h = makeCtx({ intents: kind === 'chip' ? mergeIntentsReads([vaultRead, spendRead]) : spendRead, deps: { rails: registry } });
  if (kind === 'chip') h.ledger.reads = () => ({ vault: { account: VAULT, read: vaultRead }, spend: { account: ALLOWANCE, read: spendRead } });
  return h;
}

test.afterEach(() => {
  useRailAccounts(null);
});

test('over the allowance and inside what the vault adds: a price, and the shortfall that moves from the vault first behind a Touch ID', async () => {
  const h = chipCtx(100_000_000n, 1_850_000_000n);
  const reply = await h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '150' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.reason, null, 'it can run, after the top-up');
  assert.deepEqual(reply.topUp, { amount: '50', symbol: 'USDC' });
  assert.equal(reply.sentence, 'Your allowance holds 100 USDC, less than this swap spends, so 50 USDC moves from your vault first; you confirm that move with Touch ID.');
  assert.equal(reply.expectedOut, '48.3');
  assert.equal(h.store.list().length, 0, 'a quote files nothing');
});

test('inside the allowance: a plain price, no top-up', async () => {
  const reply = await chipCtx(100_000_000n, 1_850_000_000n).svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '80' });
  assert.equal(reply.ok, true);
  assert.equal(reply.reason, null);
  assert.equal(reply.sentence, null);
  assert.equal(reply.topUp, undefined);
});

test('more than the allowance and the vault together is short, and a vault nobody could read is unread, never a top-up', async () => {
  const short = await chipCtx(100_000_000n, 1_850_000_000n).svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '3000' });
  assert.equal(short.reason, 'insufficient_balance');
  assert.equal(short.topUp, undefined);
  const unread = await chipCtx(100_000_000n, null).svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '150' });
  assert.equal(unread.reason, 'balance_unread');
  assert.equal(unread.topUp, undefined);
});

test('"all" is what the allowance holds; with none there, the answer names the vault\'s amount to swap instead', async () => {
  const all = await chipCtx(100_000_000n, 1_850_000_000n).svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: 'all' });
  assert.equal(all.amountIn, '100');
  assert.equal(all.topUp, undefined);
  const none = await chipCtx(0n, 1_850_000_000n).svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: 'all' });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'insufficient_balance');
  assert.equal(none.sentence, 'Your allowance holds no USDC, and your vault holds 1850 USDC. Swap 1850 USDC instead of "all": Approve then moves it from your vault with one more Touch ID.');
});

test('kind key: the same 150 over a 100 balance is short, exactly as before', async () => {
  const reply = await chipCtx(100_000_000n, 1_850_000_000n, 'key').svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '150' });
  assert.equal(reply.ok, true);
  assert.equal(reply.reason, 'insufficient_balance');
  assert.equal(reply.topUp, undefined);
});
