// The view mode is the one piece of app state an agent can write directly, so the
// question these tests answer is not "does it round trip" but "what happens on every
// way it can go wrong".
//
// Two answers, because there are two questions. NO FILE is a fresh install: nobody has
// chosen, nothing is being downgraded, and the first screen is the simple one. A file that
// IS there and cannot be read lands on 'pro' every time, because pro shows more and a
// corrupt file must never be the reason a human sees less than they had.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScreen, readViewMode, writeScreen, writeViewMode } from '../../src/view/mode.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-view-'));
}

test('a fresh data dir with no view file opens on basic', () => {
  assert.equal(readViewMode(tmpDir()), 'basic');
});

test('a dataDir that does not exist at all reads as basic rather than throwing', () => {
  assert.equal(readViewMode(path.join(os.tmpdir(), 'phosphor-view-nonexistent-dir')), 'basic');
});

test('a written mode round trips in both directions', () => {
  const dir = tmpDir();
  writeViewMode(dir, 'basic');
  assert.equal(readViewMode(dir), 'basic');
  writeViewMode(dir, 'pro');
  assert.equal(readViewMode(dir), 'pro');
});

test('an unparseable view file falls back to pro rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'view.json'), '{not json');
  assert.equal(readViewMode(dir), 'pro');
});

test('a parseable file holding an unknown mode falls back to pro', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ view: 'expert' }));
  assert.equal(readViewMode(dir), 'pro');
});

test('a file holding null, or the wrong shape entirely, falls back to pro', () => {
  const dir = tmpDir();
  for (const body of ['null', '[]', '"basic"', '{}', '{"mode":"basic"}']) {
    fs.writeFileSync(path.join(dir, 'view.json'), body);
    assert.equal(readViewMode(dir), 'pro', `body ${body} should read as pro`);
  }
});

test('writing leaves no tmp file behind', () => {
  const dir = tmpDir();
  writeViewMode(dir, 'basic');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeViewMode creates the dataDir when it is missing', () => {
  const dir = path.join(tmpDir(), 'nested', 'data');
  writeViewMode(dir, 'basic');
  assert.equal(readViewMode(dir), 'basic');
});

// ---------- the screen record ----------

// The mode gained company on 2026-09-14: who put the window on its screen and when, because the
// human's tabs move it too and the agent reads the record back through `start`.

test('a written screen record round trips whole', () => {
  const dir = tmpDir();
  const screen = { view: 'trade' as const, since: '2026-09-14T20:00:00.000Z', by: 'human' as const };
  writeScreen(dir, screen);
  assert.deepEqual(readScreen(dir), screen);
  assert.equal(readViewMode(dir), 'trade', 'the mode reads the same file');
});

test('a file from before the record reads as the human, stamped now', () => {
  const dir = tmpDir();
  writeViewMode(dir, 'pro');
  const now = () => '2026-09-14T21:00:00.000Z';
  assert.deepEqual(readScreen(dir, now), { view: 'pro', since: now(), by: 'human' });
});

test('a fresh install and an unreadable file carry the same fallbacks as the mode', () => {
  const now = () => '2026-09-14T21:00:00.000Z';
  assert.deepEqual(readScreen(tmpDir(), now), { view: 'basic', since: now(), by: 'human' });
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'view.json'), '{not json');
  assert.deepEqual(readScreen(dir, now), { view: 'pro', since: now(), by: 'human' });
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ view: 'trade', since: 'yesterday', by: 'ghost' }));
  assert.deepEqual(readScreen(dir, now), { view: 'trade', since: now(), by: 'human' }, 'a bad stamp or author falls back, the mode does not');
});
