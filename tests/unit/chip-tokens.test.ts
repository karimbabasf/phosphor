// The chip key's token table (src-tauri/se-helper/TokenTable.swift) is written by
// scripts/gen-chip-tokens.ts from the app's registry, never by hand. These tests write it again in
// memory and hold the file to it, so a registry change that skips the script fails here; and they
// hold the generator to the rows it may emit, since a symbol it lets through reaches the Touch ID
// dialog and an id it lets through is money the chip key will move.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { NATIVE_ASSET } from '../../src/intents.ts';
import { REGISTRY, TOKEN_TABLE, chipTokenRows, currentTable, renderTokenTable } from '../../scripts/gen-chip-tokens.ts';

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, unknown>;

test('TokenTable.swift is exactly what the generator writes from data/tokens.json and NATIVE_ASSET', () => {
  assert.equal(fs.readFileSync(TOKEN_TABLE, 'utf8'), currentTable(), 'run node scripts/gen-chip-tokens.ts and commit the table');
});

test('the table holds every pinned registry id and every pinned gas asset, and nothing unpinned', () => {
  const rows = chipTokenRows(registry, NATIVE_ASSET);
  const pinned: string[] = [];
  const unpinned: string[] = [];
  for (const [chain, table] of Object.entries(registry)) {
    if (chain.startsWith('_')) continue;
    for (const spec of Object.values(table as Record<string, { assetId: string | null; tokenId: string }>)) {
      if (spec.assetId === null) unpinned.push(spec.tokenId);
      else pinned.push(spec.assetId);
    }
  }
  const gas = Object.values(NATIVE_ASSET).flatMap((spec) => (spec?.assetId === undefined ? [] : [spec.assetId]));
  assert.equal(pinned.length, 11);
  assert.equal(gas.length, 4);
  assert.deepEqual(rows.map((r) => r.assetId).sort(), [...pinned, ...gas].sort());
  for (const id of unpinned) assert.ok(!rows.some((r) => r.assetId.includes(id)), `${id} has no pinned id and stays out`);
  // NEAR has no gas asset id of its own; the vault holds it as wNEAR.
  assert.deepEqual(rows.find((r) => r.assetId === 'nep141:wrap.near'), { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 });
});

test('the generator refuses a row it cannot put in front of the owner or the verifier', () => {
  const one = (symbol: string, spec: Record<string, unknown>) => ({ near: { [symbol]: { tokenId: 'x.near', ...spec } } });
  const refused: [string, Record<string, unknown>, Record<string, { symbol: string; decimals: number; assetId?: string }>][] = [
    ['a symbol that is a sentence', one('ATTACKER-CON', { decimals: 6, assetId: 'nep141:x.near' }), {}],
    ['a symbol with a quote', one('US"DC', { decimals: 6, assetId: 'nep141:x.near' }), {}],
    ['a one letter symbol', one('U', { decimals: 6, assetId: 'nep141:x.near' }), {}],
    ['decimals below zero', one('USDC', { decimals: -1, assetId: 'nep141:x.near' }), {}],
    ['decimals past a u128', one('USDC', { decimals: 39, assetId: 'nep141:x.near' }), {}],
    ['fractional decimals', one('USDC', { decimals: 6.5, assetId: 'nep141:x.near' }), {}],
    ['decimals as text', one('USDC', { decimals: '6', assetId: 'nep141:x.near' }), {}],
    ['an id that is not nep141', one('USDC', { decimals: 6, assetId: 'nep245:x.near:1' }), {}],
    ['an id with a capital', one('USDC', { decimals: 6, assetId: 'nep141:X.near' }), {}],
    ['an id with a quote', one('USDC', { decimals: 6, assetId: 'nep141:x".near' }), {}],
    ['an id with two separators in a row', one('USDC', { decimals: 6, assetId: 'nep141:x..near' }), {}],
    ['an id twice', one('USDC', { decimals: 6, assetId: 'nep141:x.near' }), { near: { symbol: 'NEAR', decimals: 24, assetId: 'nep141:x.near' } }],
    ['a gas asset with a bad symbol', {}, { eth: { symbol: 'E T H', decimals: 18, assetId: 'nep141:eth.omft.near' } }],
  ];
  for (const [name, reg, native] of refused) assert.throws(() => chipTokenRows(reg, native), Error, name);
});

test('the rendered table is sorted, one row per line, and every row is a literal Swift can only read one way', () => {
  const rows = chipTokenRows(registry, NATIVE_ASSET);
  const text = renderTokenTable(rows);
  const lines = text.split('\n').filter((l) => l.startsWith('  ChipToken('));
  assert.equal(lines.length, rows.length);
  assert.deepEqual(rows.map((r) => r.assetId), [...rows.map((r) => r.assetId)].sort());
  for (const line of lines) assert.match(line, /^ {2}ChipToken\(assetId: "nep141:[a-z0-9._-]+", symbol: "[A-Za-z0-9]{2,8}", decimals: \d{1,2}\),$/);
});
