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
import { readViewMode, writeViewMode } from '../../src/view/mode.ts';

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
