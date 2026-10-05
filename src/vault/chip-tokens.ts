// The assets the vault's chip key may move, read from the app's own registry: every row of
// data/tokens.json that pins a 1Click asset id, and every gas asset in NATIVE_ASSET (src/intents.ts)
// that pins one. A row with no pinned id is never quoted, so the chip never moves it either.
//
// The vault service holds the same table as src-tauri/se-helper/TokenTable.swift, written from these
// rows by scripts/gen-chip-tokens.ts; tests/unit/chip-tokens.test.ts fails on any difference. Node
// reads them too, to refuse a payload the service would refuse before asking it (chip-grammar.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVE_ASSET } from '../intents.ts';

export const REGISTRY = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'data', 'tokens.json');

export type ChipTokenRow = { assetId: string; symbol: string; decimals: number };

type RegistryRow = { decimals?: unknown; assetId?: unknown };
type NativeRow = { symbol: string; decimals: number; assetId?: string };

/* The grammar's account id rule (IntentGrammar.swift isAccountId), for the contract half of an id. */
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
// The symbol reaches the Touch ID dialog, so it is a ticker or nothing (src/vault/reason.ts clean).
const TICKER = /^[A-Za-z0-9]{2,8}$/;

function row(assetId: unknown, symbol: string, decimals: unknown, where: string): ChipTokenRow {
  if (typeof assetId !== 'string' || !assetId.startsWith('nep141:') || !ACCOUNT_ID.test(assetId.slice('nep141:'.length))) {
    throw new Error(`${where}: ${JSON.stringify(assetId)} is not a nep141 asset id`);
  }
  if (!TICKER.test(symbol)) throw new Error(`${where}: the symbol ${JSON.stringify(symbol)} is not ticker shaped`);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error(`${where}: decimals ${JSON.stringify(decimals)} is not a whole number from 0 to 38`);
  }
  return { assetId, symbol, decimals };
}

/* The table's rows, sorted by asset id. An id twice is a refusal, even when both rows agree: the
   registry holds one row per asset, and a second one means it changed in a way nobody checked. */
export function chipTokenRows(registry: Record<string, unknown>, native: Partial<Record<string, NativeRow>>): ChipTokenRow[] {
  const rows: ChipTokenRow[] = [];
  for (const [chain, table] of Object.entries(registry)) {
    if (chain.startsWith('_') || table === null || typeof table !== 'object') continue;
    for (const [symbol, spec] of Object.entries(table as Record<string, RegistryRow>)) {
      if (spec.assetId === null || spec.assetId === undefined) continue;
      rows.push(row(spec.assetId, symbol, spec.decimals, `data/tokens.json ${chain} ${symbol}`));
    }
  }
  for (const [chain, spec] of Object.entries(native)) {
    if (spec?.assetId === undefined) continue;
    rows.push(row(spec.assetId, spec.symbol, spec.decimals, `NATIVE_ASSET ${chain}`));
  }
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.assetId)) throw new Error(`${r.assetId} is in the registry twice`);
    seen.add(r.assetId);
  }
  return rows.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

let table: ReadonlyMap<string, ChipTokenRow> | null = null;

// The rows by asset id, read from the registry once.
export function chipTokens(): ReadonlyMap<string, ChipTokenRow> {
  if (table === null) {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, unknown>;
    table = new Map(chipTokenRows(registry, NATIVE_ASSET).map((r) => [r.assetId, r]));
  }
  return table;
}
