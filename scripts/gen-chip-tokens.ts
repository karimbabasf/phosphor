// Writes src-tauri/se-helper/TokenTable.swift: the assets the vault service lets the chip key move,
// read from the app's own registry. Every row of data/tokens.json that pins a 1Click asset id is in
// it, and so is every gas asset in NATIVE_ASSET (src/intents.ts) that pins one. A row with no
// pinned id is never quoted, so the chip never moves it either.
//
// Run after changing either source: node scripts/gen-chip-tokens.ts
// tests/unit/chip-tokens.test.ts renders the table again in memory and fails on any difference, so
// a registry change that skips this script fails the suite instead of reaching a build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVE_ASSET } from '../src/intents.ts';
import { REGISTRY, chipTokenRows } from '../src/vault/chip-tokens.ts';
import type { ChipTokenRow } from '../src/vault/chip-tokens.ts';

// The rows live beside the app's own reading of them (src/vault/chip-tokens.ts).
export { REGISTRY, chipTokenRows };
export type { ChipTokenRow };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TOKEN_TABLE = path.join(ROOT, 'src-tauri/se-helper/TokenTable.swift');

export function renderTokenTable(rows: ChipTokenRow[]): string {
  const lines = rows.map((r) => `  ChipToken(assetId: "${r.assetId}", symbol: "${r.symbol}", decimals: ${r.decimals}),`);
  return [
    '// Written by scripts/gen-chip-tokens.ts from data/tokens.json and NATIVE_ASSET in src/intents.ts:',
    '// the assets the chip key may move, by the verifier\'s id. Not edited by hand:',
    '// tests/unit/chip-tokens.test.ts writes it again in memory and fails on any difference.',
    '',
    'let chipTokens: [ChipToken] = [',
    ...lines,
    ']',
    '',
  ].join('\n');
}

export function currentTable(): string {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, unknown>;
  return renderTokenTable(chipTokenRows(registry, NATIVE_ASSET));
}

if (import.meta.main) {
  const text = currentTable();
  fs.writeFileSync(TOKEN_TABLE, text);
  console.log(`${path.relative(ROOT, TOKEN_TABLE)}: ${text.split('\n').filter((l) => l.startsWith('  ChipToken(')).length} tokens`);
}
