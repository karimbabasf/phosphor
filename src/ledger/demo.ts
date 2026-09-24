// Fixture loader for demo mode. Reads data/demo-state.json and produces the snapshot and the
// two pocket reads the live ledger would: the balances inside NEAR Intents and the Hyperliquid
// collateral. Pure and synchronous: no network.
//
// It also holds the moves the demo rail has made this run (src/rails/demo.ts). They live in
// memory rather than in the file: the fixture is a checked-in asset and an installed app reads
// it out of a read-only bundle, so a demo move edits nothing on disk and a restart is a fresh
// wallet. Nothing applies these but the reads below, so `wallet`, the composition and a
// settling proposal all see the same balance. Each move is also kept as the intents ledger rows
// it would have written, so the swap reads can ask what left the balance (demoActivity).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { LedgerSnapshot } from '../types.ts';
import type { IntentsActivity, IntentsRow } from '../chainscan/index.ts';
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
  // A price the fixture does not carry stays absent, never 0: unknown is not worthless.
  const prices: Record<string, number> = {};
  for (const symbol of ['ETH', 'SOL', 'NEAR'] as const) {
    const price = raw.prices[symbol];
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices[symbol] = price;
  }
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices };
}

// ---------- what a demo move did to the balances ----------

// A signed change to one asset inside the verifier, or to the trading account. The asset facts
// ride along so a move can credit something the fixture does not list yet: a swap to SOL on a
// fixture that holds none has to be able to show the SOL arriving.
export type DemoBalanceMove = {
  intents?: Array<DemoHolding>; // `amount` is the signed change, not a total
  hyperliquidUsdc?: number;
  // Who the intents legs moved to or from (the swap service's handle) and the move's hash, for
  // the ledger rows below. Absent writes rows with no counterparty.
  trail?: { counterparty: string | null; hash: string };
};

const movedIntents = new Map<string, DemoHolding>();
let movedHyperliquidUsdc = 0;
// Oldest first, as they happened.
const ledgerRows: IntentsRow[] = [];

export function moveDemoBalance(move: DemoBalanceMove): void {
  const time = new Date().toISOString();
  for (const row of move.intents ?? []) {
    const held = movedIntents.get(row.assetId);
    movedIntents.set(row.assetId, held === undefined ? { ...row } : { ...held, amount: held.amount + row.amount });
    if (row.amount === 0) continue;
    ledgerRows.push({
      cause: 'TRANSFER',
      token: row.symbol,
      tokenId: row.assetId,
      delta: `${row.amount < 0 ? '-' : '+'}${Number(Math.abs(row.amount).toFixed(Math.min(row.decimals, 8)))}`,
      counterparty: move.trail?.counterparty ?? null,
      hash: move.trail?.hash ?? 'demo',
      time,
    });
  }
  movedHyperliquidUsdc += move.hyperliquidUsdc ?? 0;
}

export function resetDemoBalances(): void {
  movedIntents.clear();
  movedHyperliquidUsdc = 0;
  ledgerRows.length = 0;
}

/* The intents ledger of the demo account, newest first: the rows this run's moves wrote and
   nothing else, since the fixture's opening balances have no history. The shape the live read
   answers in (src/chainscan/index.ts), whole and never partial, so a swap whose money never
   left reads as nothing leaving rather than as unknown. */
export function demoActivity(account: string, limit: number): IntentsActivity {
  return {
    account,
    ok: true,
    rows: [...ledgerRows].reverse().slice(0, Math.max(0, limit)),
    balances: null,
    partial: false,
    source: 'demo',
    explorer: null,
    note: 'demo mode: the moves this run made, read from memory rather than a chain',
  };
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
// fixture's own rows first, then the few assets it does not list but prices. An asset id (it
// carries a colon, a ticker never does) is that asset, which is how the swap reads name a coin.
export function demoAssetOf(symbol: string): DemoHolding | null {
  const byId = symbol.includes(':') ? demoAssets().find((h) => h.assetId === symbol.trim()) : undefined;
  if (byId !== undefined) return { ...byId, amount: 0 };
  const upper = symbol.trim().toUpperCase();
  const held = readFixture().intents.find((h) => h.symbol.toUpperCase() === upper);
  if (held !== undefined) return { ...held, amount: 0 };
  const known = UNHELD_ASSETS[upper];
  return known === undefined ? null : { ...known, amount: 0 };
}

// Every asset demo mode knows by id, once each: the fixture's rows, the ones it prices but does
// not list, and any a move has credited. Amounts are not balances here; demoHolding reads those.
export function demoAssets(): DemoHolding[] {
  const out = new Map<string, DemoHolding>();
  for (const h of [...readFixture().intents, ...Object.values(UNHELD_ASSETS), ...movedIntents.values()]) {
    if (!out.has(h.assetId)) out.set(h.assetId, { ...h, amount: 0 });
  }
  return [...out.values()];
}

// NEAR inside the verifier is wrap.near, which the live token list and the wallet row call wNEAR
// (src/intents.ts, canonicalSymbol). Both names land on the one holding so the demo books what
// the live app books.
const WNEAR: DemoHolding = { symbol: 'wNEAR', originChain: 'near', assetId: 'nep141:wrap.near', amount: 0, decimals: 24 };
const UNHELD_ASSETS: Record<string, DemoHolding> = {
  NEAR: WNEAR,
  WNEAR,
};

/* What the trading account has free, fixture plus moves. The account is unified, so this is
   also what a settling deposit is judged against (src/proposals/execute.ts, pocketBalance).
   Never negative: a demo move that would overdraw it is a bug in the rail, and a negative
   balance would read as a debt this app cannot have. */
export function demoAvailableUsdc(): number {
  return Math.max(0, readFixture().hyperliquid.availableUsdc + movedHyperliquidUsdc);
}

// ---------- the two pocket reads ----------

/* Both ok and stamped now: a fixture has nothing to fail.

   `owner` is the address this app's own keystore holds, and the fixture is attributed to it
   rather than to the address written in the file. The fixture stands in for THIS wallet's
   balances, and anything that matches a balance to an account (judgeSettling's pocket read, the
   recipients book, a venue read beside a draft) is holding the app's address in its hand. Left
   as the file's address, a demo deposit could never settle: the draft named the wallet's
   account, the read named the fixture's, they did not match, and a row that had been credited
   sat in `crediting` until its deadline flipped it to `stalled`. Absent (no wallet yet, or a
   test calling this bare) keeps the file's own account. */
export function loadDemoReads(owner?: string | null): { intents: IntentsRead; hyperliquid: HlRead } {
  const raw = readFixture();
  const fetchedAt = new Date().toISOString();
  const account = (owner ?? raw.account).toLowerCase();
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
      account,
      collateralUsdc: Math.max(0, raw.hyperliquid.collateralUsdc + movedHyperliquidUsdc),
      availableUsdc: demoAvailableUsdc(),
      marginUsedUsd: 0,
      openPositions: 0,
      unified: true,
    },
  };
}
