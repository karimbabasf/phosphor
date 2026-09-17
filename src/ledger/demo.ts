// Fixture loader for demo mode. Reads data/demo-state.json and produces the snapshot and the
// two pocket reads the live ledger would: the balances inside NEAR Intents and the Hyperliquid
// collateral. Pure and synchronous: no network, no mutation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { LedgerSnapshot } from '../types.ts';
import type { IntentsRead } from './intents.ts';
import type { HlRead } from './hyperliquid.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'demo-state.json');

type DemoStateFile = {
  prices: Record<string, number>;
  account: string;
  intents: Array<{ symbol: string; originChain: string; assetId: string; amount: number; decimals: number }>;
  hyperliquid: { collateralUsdc: number; availableUsdc: number };
};

function readFixture(): DemoStateFile {
  return JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoStateFile;
}

// The demo account: the one address the fixture holds everything under, lowercased the way
// the verifier names it.
export function demoAccount(): string {
  return readFixture().account.toLowerCase();
}

export function loadDemoLedger(): LedgerSnapshot {
  const raw = readFixture();
  const prices: Record<string, number> = { ETH: raw.prices.ETH ?? 0, SOL: raw.prices.SOL ?? 0, NEAR: raw.prices.NEAR ?? 0 };
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices };
}

// The two pocket reads, stamped now, both ok: a fixture has nothing to fail.
export function loadDemoReads(): { intents: IntentsRead; hyperliquid: HlRead } {
  const raw = readFixture();
  const fetchedAt = new Date().toISOString();
  const account = raw.account.toLowerCase();
  return {
    intents: {
      ok: true,
      fetchedAt,
      holdings: raw.intents.map(h => ({
        accountId: account,
        assetId: h.assetId,
        symbol: h.symbol,
        originChain: h.originChain,
        amount: h.amount,
        amountBase: BigInt(Math.round(h.amount * 10 ** h.decimals)).toString(),
        decimals: h.decimals,
      })),
    },
    hyperliquid: {
      ok: true,
      fetchedAt,
      account: raw.account,
      collateralUsdc: raw.hyperliquid.collateralUsdc,
      availableUsdc: raw.hyperliquid.availableUsdc,
      marginUsedUsd: 0,
      openPositions: 0,
      unified: true,
    },
  };
}
