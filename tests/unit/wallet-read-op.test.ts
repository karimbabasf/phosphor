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
