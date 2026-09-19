// Fixture loader for demo mode. Reads data/demo-state.json and produces the snapshot and the
// two pocket reads the live ledger would: the balances inside NEAR Intents and the Hyperliquid
// collateral. Pure and synchronous: no network.
//
// It also holds the moves the demo rail has made this run (src/rails/demo.ts). They live in
// memory rather than in the file: the fixture is a checked-in asset and an installed app reads
// it out of a read-only bundle, so a demo move edits nothing on disk and a restart is a fresh
// wallet. Nothing applies these but the reads below, so `wallet`, the composition and a
// settling proposal all see the same balance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { LedgerSnapshot } from '../types.ts';
import type { IntentsRead } from './intents.ts';
import type { HlRead } from './hyperliquid.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'demo-state.json');

type DemoHolding = { symbol: string; originChain: string; assetId: string; amount: number; decimals: number };

type DemoStateFile = {
  prices: Record<string, number>;
  account: string;
  intents: DemoHolding[];
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

// ---------- what a demo move did to the balances ----------

// A signed change to one asset inside the verifier, or to the trading account. The asset facts
// ride along so a move can credit something the fixture does not list yet: a swap to SOL on a
// fixture that holds none has to be able to show the SOL arriving.
export type DemoBalanceMove = {
  intents?: Array<DemoHolding>; // `amount` is the signed change, not a total
  hyperliquidUsdc?: number;
};

const movedIntents = new Map<string, DemoHolding>();
let movedHyperliquidUsdc = 0;

export function moveDemoBalance(move: DemoBalanceMove): void {
  for (const row of move.intents ?? []) {
    const held = movedIntents.get(row.assetId);
    movedIntents.set(row.assetId, held === undefined ? { ...row } : { ...held, amount: held.amount + row.amount });
  }
  movedHyperliquidUsdc += move.hyperliquidUsdc ?? 0;
}

export function resetDemoBalances(): void {
  movedIntents.clear();
  movedHyperliquidUsdc = 0;
}

// What the fixture plus this run's moves holds of one asset, and how the verifier spells it.
// Null for an asset neither the fixture nor a move has ever named.
export function demoHolding(assetId: string): DemoHolding | null {
  const row = readFixture().intents.find((h) => h.assetId === assetId);
  const moved = movedIntents.get(assetId);
  if (row === undefined && moved === undefined) return null;
  const base = row ?? { ...(moved as DemoHolding), amount: 0 };
  return { ...base, amount: Math.max(0, base.amount + (moved?.amount ?? 0)) };
}

// The asset the fixture keys a symbol by, for a demo move that has only a symbol to go on. The
// fixture's own rows first, then the few assets it does not list but prices.
export function demoAssetOf(symbol: string): DemoHolding | null {
  const upper = symbol.trim().toUpperCase();
  const held = readFixture().intents.find((h) => h.symbol.toUpperCase() === upper);
  if (held !== undefined) return { ...held, amount: 0 };
  const known = UNHELD_ASSETS[upper];
  return known === undefined ? null : { ...known, amount: 0 };
}

const UNHELD_ASSETS: Record<string, DemoHolding> = {
  NEAR: { symbol: 'NEAR', originChain: 'near', assetId: 'nep141:wrap.near', amount: 0, decimals: 24 },
};

/* What the trading account has free, fixture plus moves. The account is unified, so this is
   also what a settling deposit is judged against (src/proposals/execute.ts, pocketBalance).
   Never negative: a demo move that would overdraw it is a bug in the rail, and a negative
   balance would read as a debt this app cannot have. */
export function demoAvailableUsdc(): number {
  return Math.max(0, readFixture().hyperliquid.availableUsdc + movedHyperliquidUsdc);
}

// ---------- the two pocket reads ----------

// Both ok and stamped now: a fixture has nothing to fail.
export function loadDemoReads(): { intents: IntentsRead; hyperliquid: HlRead } {
  const raw = readFixture();
  const fetchedAt = new Date().toISOString();
  const account = raw.account.toLowerCase();
  const assetIds = new Set([...raw.intents.map((h) => h.assetId), ...movedIntents.keys()]);
  return {
    intents: {
      ok: true,
      fetchedAt,
      holdings: [...assetIds].map((assetId) => {
        const h = demoHolding(assetId) as DemoHolding;
        return {
          accountId: account,
          assetId: h.assetId,
          symbol: h.symbol,
          originChain: h.originChain,
          amount: h.amount,
          amountBase: BigInt(Math.round(h.amount * 10 ** h.decimals)).toString(),
          decimals: h.decimals,
        };
      }),
    },
    hyperliquid: {
      ok: true,
      fetchedAt,
      account: raw.account,
      collateralUsdc: Math.max(0, raw.hyperliquid.collateralUsdc + movedHyperliquidUsdc),
      availableUsdc: demoAvailableUsdc(),
      marginUsedUsd: 0,
      openPositions: 0,
      unified: true,
    },
  };
}
