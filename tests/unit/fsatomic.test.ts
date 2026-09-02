// The durable write, and the seven callers that use it.
//
// What cannot be tested here is the thing the fsync is for: nothing short of pulling the power
// out of a machine proves a flush reached the platter. What CAN be tested is everything around
// it, and the failure this replaced was visible from userland: a tmp file left behind, a
// non-atomic overwrite, and a caller that still wrote its own tmp-then-rename by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWrite, atomicWriteJson } from '../../src/fsatomic.ts';
import { createStore } from '../../src/store.ts';
import { writeCoins, readCoins } from '../../src/view/coins.ts';
import { writeViewMode, readViewMode } from '../../src/view/mode.ts';
import { writeTheme, readTheme, DEFAULT_THEME } from '../../src/view/theme.ts';
import { savePolicy, loadPolicy, defaultPolicy } from '../../src/policy/file.ts';
import type { Proposal } from '../../src/types.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-atomic-'));
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
}

function sample(id: string): Proposal {
  return {
    id,
    kind: 'consolidate',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: { kind: 'consolidate', legs: [], totalUsd: 0, reason: 'test' } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['test'] },
  };
}

test('the content round-trips and no tmp file is left behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'thing.json');
  atomicWriteJson(file, { a: 1, b: ['two'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: ['two'] });
  assert.deepEqual(leftovers(dir), []);
});

test('an overwrite replaces the whole file rather than truncating it', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'thing.json');
  atomicWrite(file, 'a'.repeat(5000));
  atomicWrite(file, 'short');
  assert.equal(fs.readFileSync(file, 'utf8'), 'short');
  assert.deepEqual(leftovers(dir), []);
});

test('it creates the directory it is pointed at', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'deeper', 'thing.json');
  atomicWriteJson(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
});

test('a rename onto a directory fails loudly and cleans up its tmp file', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'iamadirectory');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'child'), 'so the rename cannot succeed');
  assert.throws(() => atomicWrite(target, 'nope'));
  assert.deepEqual(leftovers(dir), [], 'a failed write does not slowly fill the data dir');
});

test('every state writer in the app goes through it, and none leave tmp files', () => {
  const dir = tmpDir();

  const store = createStore(dir);
  store.put(sample('a'));
  writeCoins(dir, ['BTC-USD', 'ETH-USD']);
  writeViewMode(dir, 'basic');
  writeTheme(dir, { ...DEFAULT_THEME });
  savePolicy(dir, defaultPolicy());

  assert.deepEqual(store.list().map(p => p.id), ['a']);
  assert.deepEqual(readCoins(dir), ['BTC-USD', 'ETH-USD']);
  assert.equal(readViewMode(dir), 'basic');
  assert.deepEqual(readTheme(dir), { ...DEFAULT_THEME });
  assert.notEqual(loadPolicy(dir), null);
  assert.deepEqual(leftovers(dir), []);
});

// The mechanical half of the guarantee: one implementation, not seven. A second hand-rolled
// tmp-then-rename anywhere in src/ is a writer that is atomic and not durable, which is exactly
// the state this replaced.
test('src/ holds exactly one durable writer', () => {
  const files: string[] = [];
  (function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  })(path.join(ROOT, 'src'));

  /* One durable WRITER. The keystore's overwrite-in-place is the single other fsync in src/, and
     it is not a writer: destroyPlaintext scribbles random bytes over the same inode and truncates
     it, which is the whole point (a tmp-then-rename would leave the original blocks on disk with
     the key still in them). It is named here rather than allowed by a pattern, so a THIRD fsync
     appearing anywhere still fails this. */
  const syncing = files.filter(f => /\bfsyncSync\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(syncing.map(f => path.relative(ROOT, f)).sort(), ['src/fsatomic.ts', 'src/keystore/store.ts']);

  const keystore = fs.readFileSync(path.join(ROOT, 'src/keystore/store.ts'), 'utf8');
  assert.match(keystore, /export function destroyPlaintext/, 'the keystore fsync is the destruction path');
  assert.doesNotMatch(keystore, /renameSync/, 'and its writes go through the one writer, not a second copy of it');
  assert.match(keystore, /atomicWrite\(/, 'which it calls');

  const rolledByHand = files
    .filter(f => path.relative(ROOT, f) !== 'src/fsatomic.ts')
    .filter(f => /\brenameSync\(/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f));
  // store.ts renames a file it refuses to read; that is quarantine, not a state write.
  assert.deepEqual(rolledByHand, ['src/store.ts']);
});
