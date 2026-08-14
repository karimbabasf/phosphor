// The coins the basic screen tracks are a preference the owner sets by asking the
// assistant, so they outlive the process that heard the ask. These tests are about the
// two directions that matter: a bad file must not empty the screen, and a good one must
// come back exactly as it was written.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCoins, writeCoins, DEFAULT_COINS, MAX_COINS } from '../../src/view/coins.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-coins-'));
}

test('a list survives the write and comes back in the order it was set', () => {
  const dir = tmpDir();
  writeCoins(dir, ['SOL-USD', 'BTC-USD']);
  // Order is the reading order on screen, not a set, so it is part of what was saved.
  assert.deepEqual(readCoins(dir), ['SOL-USD', 'BTC-USD']);
});

test('an unwritten directory reads as the default three', () => {
  assert.deepEqual(readCoins(tmpDir()), DEFAULT_COINS);
  // A copy, not the constant itself: a caller that sorts the result must not reorder the
  // default for every later reader in the process.
  const dir = tmpDir();
  readCoins(dir).push('JUNK-USD');
  assert.deepEqual(readCoins(dir), ['BTC-USD', 'SOL-USD', 'ETH-USD']);
});

// The failure direction is the whole point of the file. A screen with no prices on it
// looks exactly like a screen whose prices could not be read, and this reader cannot tell
// those apart, so every bad state falls back to three coins that are known to work.
test('a broken file falls back to the default three rather than to nothing', () => {
  const cases: Array<[string, string]> = [
    ['not json at all', 'garbage'],
    ['json but not an object', '[]'],
    ['no coins key', '{"view":"basic"}'],
    ['coins is not an array', '{"coins":"BTC-USD"}'],
    ['empty list', '{"coins":[]}'],
    ['one entry is not a product id', '{"coins":["BTC-USD","bitcoin"]}'],
    ['too many', `{"coins":${JSON.stringify(['A-USD', 'B-USD', 'C-USD', 'D-USD', 'E-USD'])}}`],
  ];
  for (const [why, body] of cases) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'coins.json'), body);
    assert.deepEqual(readCoins(dir), DEFAULT_COINS, why);
  }
});

// A hand-edited file with one good entry and one broken one is somebody who got it wrong.
// Showing them the good half alone would be a screen they did not ask for with no reason
// given, so the list is sound as a whole or it is not used.
test('a half-good list is not half-used', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'coins.json'), '{"coins":["SOL-USD","not a ticker"]}');
  assert.deepEqual(readCoins(dir), DEFAULT_COINS);
});

test('the cap is what the layout can hold, and the file cannot exceed it', () => {
  const dir = tmpDir();
  const four = ['BTC-USD', 'SOL-USD', 'ETH-USD', 'NEAR-USD'];
  assert.equal(four.length, MAX_COINS);
  writeCoins(dir, four);
  assert.deepEqual(readCoins(dir), four);
});

test('a duplicate is one coin, not two rows of the same price', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'coins.json'), '{"coins":["BTC-USD","BTC-USD"]}');
  // The duplicate collapses, which makes the cleaned list shorter than what was on disk,
  // and a list that had to be repaired is not the list somebody chose: default.
  assert.deepEqual(readCoins(dir), DEFAULT_COINS);
});

test('the write is atomic, so a reader never sees a half-file', () => {
  const dir = tmpDir();
  writeCoins(dir, ['ETH-USD']);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== 'coins.json');
  assert.deepEqual(leftovers, [], 'the temp file is renamed, never left behind');
});
