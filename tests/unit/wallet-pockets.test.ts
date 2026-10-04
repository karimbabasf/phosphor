// The agent's wallet read once the vault has moved to the chip (PHASE2-PLAN.md C6): `spendable` is
// the allowance, what a move spends with no touch, and `savings` is the vault, which moves only
// through a top-up the person confirms with Touch ID. Under kind key the answer is what it always
// was, with neither key in it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { SAVINGS_NOTE, SPENDABLE_LOCKED, walletReads } from '../../src/http/read/wallet.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { AccountRead, IntentsHolding, IntentsRead } from '../../src/ledger/intents.ts';
import { mergeIntentsReads } from '../../src/ledger/intents.ts';
import type { Ctx } from '../../src/http/context.ts';

const VAULT = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const ALLOWANCE = '0xf6beee2877dc58331cfa06c66cc47b5f2535a379';
const USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const ETH = 'nep141:eth.omft.near';

function captured(): { res: http.ServerResponse; body: () => Record<string, unknown> } {
  let text = '';
  const res = {
    writeHead() {
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, body: () => JSON.parse(text) as Record<string, unknown> };
}

function holding(accountId: string, assetId: string, symbol: string, amount: number, decimals: number): IntentsHolding {
  return { accountId, assetId, symbol, originChain: 'eth', amount, amountBase: BigInt(Math.round(amount * 10 ** decimals)).toString(), decimals };
}

function readOf(holdings: IntentsHolding[]): IntentsRead {
  return { ok: true, fetchedAt: new Date().toISOString(), holdings, failures: 0 };
}

function ctxOf(intents: IntentsRead | undefined, reads?: { vault: AccountRead | null; spend: AccountRead | null }): Ctx {
  const snapshot = { ...loadDemoLedger(), prices: { ETH: 4000 } };
  return {
    ledger: { snapshot: () => snapshot, intents: () => intents, hyperliquid: () => undefined, refresh: async () => snapshot, ...(reads === undefined ? {} : { reads: () => reads }) },
    keystore: { custody: () => null, enclave: () => null, state: () => 'unlocked', header: () => null },
    vault: { attached: () => false, enclaveReady: () => false, capability: () => null, bound: () => null, waiting: () => null },
    vaultPrefs: { get: () => ({ backedUp: true, backedUpAt: null, idleMinutes: 15 }) },
  } as unknown as Ctx;
}

async function walletOf(ctx: Ctx): Promise<Record<string, unknown>> {
  const { res, body } = captured();
  await walletReads.wallet(ctx, {}, {}, res);
  return body();
}

test('kind key: the wallet read is what it always was, with no spendable and no savings in it', async () => {
  const vault = readOf([holding(VAULT, USDC, 'USDC', 1850, 6)]);
  for (const reads of [undefined, { vault: { account: VAULT, read: vault }, spend: { account: VAULT, read: vault } }]) {
    const wallet = await walletOf(ctxOf(vault, reads));
    assert.equal('spendable' in wallet, false);
    assert.equal('savings' in wallet, false);
    assert.equal((wallet.rows as Array<Record<string, unknown>>).some((r) => 'pocket' in r), false);
  }
});

test('kind chip: spendable is the allowance and savings the vault, each with its own exact rows and total, and every row says which', async () => {
  const vault = readOf([holding(VAULT, USDC, 'USDC', 1850, 6), holding(VAULT, ETH, 'ETH', 0.5, 18)]);
  const allowance = readOf([holding(ALLOWANCE, USDC, 'USDC', 63.25, 6)]);
  const wallet = await walletOf(ctxOf(mergeIntentsReads([vault, allowance]), { vault: { account: VAULT, read: vault }, spend: { account: ALLOWANCE, read: allowance } }));
  const spendable = wallet.spendable as { totalUsd: number; rows: Array<Record<string, unknown>> };
  const savings = wallet.savings as { totalUsd: number; rows: Array<Record<string, unknown>>; note: string };
  assert.equal(spendable.totalUsd, 63.25);
  assert.deepEqual(spendable.rows, [{ symbol: 'USDC', quantity: 63.25, quantityExact: '63.25', valueUsd: 63.25 }]);
  assert.equal(savings.totalUsd, 3850);
  assert.deepEqual(savings.rows.map((r) => [r.symbol, r.quantityExact]), [['ETH', '0.5'], ['USDC', '1850']]);
  assert.equal(savings.note, SAVINGS_NOTE);
  assert.match(SAVINGS_NOTE, /top-up the person confirms with Touch ID/);
  // The whole wallet still counts everything, and each intents row names its pocket.
  assert.equal(wallet.totalUsd, 3913.25);
  const pockets = (wallet.rows as Array<{ symbol: string; quantity: number; pocket?: string }>).map((r) => `${r.symbol} ${r.quantity} ${r.pocket}`).sort();
  assert.deepEqual(pockets, ['ETH 0.5 savings', 'USDC 1850 savings', 'USDC 63.25 spendable']);
});

test('kind chip before the allowance can be named: savings shows the vault and spendable says to unlock, never a zero', async () => {
  const vault = readOf([holding(VAULT, USDC, 'USDC', 1850, 6)]);
  const wallet = await walletOf(ctxOf(vault, { vault: { account: VAULT, read: vault }, spend: null }));
  assert.deepEqual(wallet.spendable, { totalUsd: null, rows: [], note: SPENDABLE_LOCKED });
  assert.equal((wallet.savings as { totalUsd: number }).totalUsd, 1850);
});
