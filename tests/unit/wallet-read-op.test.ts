import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { walletReads } from '../../src/http/read/wallet.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { Ctx } from '../../src/http/context.ts';

// The wallet read op is what the agent calls; buildWallet is what the tests covered. The
// third pocket reached buildWallet and not the op, so a live run showed two pockets while the
// unit suite showed three. This holds the op to the same view as the state route.

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

// The balances tool summed snapshot.holdings, which a live refresh keeps empty on purpose, so it
// told the agent the wallet held $0 with every chain ok while the verifier held the money.
test('the balances read op totals what the verifier and the venue hold, not the empty chain holdings', async () => {
  const snapshot = { ...loadDemoLedger(), mode: 'live' as const, holdings: [] };
  const ctx = {
    ledger: {
      snapshot: () => snapshot,
      intents: () => ({
        ok: true,
        fetchedAt: 'now',
        holdings: [{ accountId: '0xabc', assetId: 'nep141:usdc', symbol: 'USDC', originChain: 'eth', amount: 24.78, decimals: 6 }],
      }),
      hyperliquid: () => ({
        ok: true,
        fetchedAt: 'now',
        account: '0xabc',
        collateralUsdc: 9.66,
        availableUsdc: 9.66,
        marginUsedUsd: 0,
        openPositions: 0,
        unified: true,
      }),
      refresh: async () => snapshot,
      applyDemoTransfer: () => {},
    },
    riskRows: [],
  } as unknown as Ctx;

  const { res, body } = captured();
  await walletReads.balances(ctx, {}, {}, res);
  const balances = body() as { totalUsd: number; rows: unknown[] };
  assert.equal(balances.totalUsd, 34.44);
  assert.equal(balances.rows.length, 2, 'one row per pocket, the same rows the wallet op shows');
});

test('the wallet read op carries the Hyperliquid row the ledger read', async () => {
  const snapshot = loadDemoLedger();
  const ctx = {
    ledger: {
      snapshot: () => snapshot,
      intents: () => undefined,
      hyperliquid: () => ({
        ok: true,
        fetchedAt: 'now',
        account: '0xabc',
        collateralUsdc: 9.66,
        availableUsdc: 9.66,
        marginUsedUsd: 0,
        openPositions: 0,
        unified: true,
      }),
      refresh: async () => snapshot,
      applyDemoTransfer: () => {},
    },
    keystore: { custody: () => null, enclave: () => null, state: () => 'no_wallet', header: () => null },
    vault: { attached: () => false, enclaveReady: () => false, capability: () => null, waiting: () => null },
    vaultPrefs: { get: () => ({ backedUp: false, backedUpAt: null, idleMinutes: 15 }) },
  } as unknown as Ctx;

  const { res, body } = captured();
  await walletReads.wallet(ctx, {}, {}, res);
  const wallet = body() as { rows: Array<{ kind: string; quantity: number }> };
  const row = wallet.rows.find((r) => r.kind === 'hyperliquid');
  assert.ok(row, 'the wallet op dropped the Hyperliquid row');
  assert.equal(row.quantity, 9.66);
});
