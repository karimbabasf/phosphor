// The store reads the file once per change rather than once per call.
//
// list() and get() each did a readFileSync plus a JSON.parse of the whole proposal list, and
// buildState reaches list() twice: once for the payload and once through dailyLimit. Measured:
// 0.021 ms at 10 proposals, 0.549 at 500, 2.46 at 2000, 10.6 at 10000, so a state build at 2000
// rows did 4.9 ms of disk work and at 10000 did 21.3 ms, half of it for a list it had already read
// a microsecond earlier.
//
// The cache is validated against the FILE rather than trusted, which is the part that matters.
// src/store.ts's header promises that a freshly created Store against an existing dataDir sees
// prior proposals immediately, with no in-memory cache to go stale, and that promise is what these
// tests hold it to: a second Store over the same directory, an edit made behind its back, and a
// deletion are all seen. What is skipped is the parse, never the look.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, CorruptStateError } from '../../src/store.ts';
import type { Proposal, ProposalStatus } from '../../src/types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-store-cache-'));
}

function row(id: string, status: ProposalStatus = 'executed'): Proposal {
  const at = new Date().toISOString();
  return {
    id,
    kind: 'swap',
    createdAt: at,
    decidedAt: at,
    decidedBy: 'human',
    status,
    draft: { kind: 'swap', chain: 'base', fromSymbol: 'USDC', toSymbol: 'WETH', amountUsd: 100 } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] } as unknown as Proposal['verdict'],
  } as unknown as Proposal;
}

function seed(dir: string, rows: Proposal[]): void {
  fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify(rows, null, 2));
}

test('two reads with nothing written between them parse the file once', () => {
  const dir = tmpDir();
  seed(dir, [row('a'), row('b')]);
  const store = createStore(dir);

  const first = store.list();
  const second = store.list();
  assert.notEqual(first, second, 'each caller gets its own array, so it may push and splice');
  assert.equal(first[0], second[0], 'and the rows behind it were not parsed a second time');
  assert.equal(first[1], second[1]);
});

test('get shares the same read as list', () => {
  const dir = tmpDir();
  seed(dir, [row('a'), row('b')]);
  const store = createStore(dir);
  assert.equal(store.get('b'), store.list()[1]);
});

test('a caller may change the array it is handed without changing the store', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);

  const held = store.list();
  held.push(row('not-real'));
  assert.equal(store.list().length, 1, 'the store still holds one row');
});

test('a write through this store is on the next read', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  store.put(row('b'));
  assert.deepEqual(store.list().map((p) => p.id), ['a', 'b']);
  assert.equal(store.get('b')?.id, 'b');
});

test('a write from a second store over the same directory is seen', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const reader = createStore(dir);
  assert.deepEqual(reader.list().map((p) => p.id), ['a']);

  createStore(dir).put(row('b'));
  assert.deepEqual(reader.list().map((p) => p.id), ['a', 'b'], 'the cache is checked against the file, not trusted');
});

test('an edit made behind the store is seen', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  seed(dir, [row('a'), row('b'), row('c')]);
  assert.deepEqual(store.list().map((p) => p.id), ['a', 'b', 'c']);
});

test('a status changed in place behind the store is seen, even at the same length', () => {
  const dir = tmpDir();
  seed(dir, [row('a', 'pending')]);
  const store = createStore(dir);
  assert.equal(store.list()[0].status, 'pending');

  // Same row, same byte count, one word swapped for another of the same width.
  seed(dir, [row('a', 'refused')]);
  assert.equal(store.list()[0].status, 'refused');
});

test('deleting the file reads as an empty history rather than the last one held', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  fs.unlinkSync(path.join(dir, 'proposals.json'));
  assert.deepEqual(store.list(), []);
});

test('corruption still throws, still quarantines, and still latches for the life of the store', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  fs.writeFileSync(path.join(dir, 'proposals.json'), '{ not a list');
  assert.throws(() => store.list(), CorruptStateError);

  // The bytes are aside and a good file is back, and this store still refuses: reading as empty
  // would restore a spent 24 hour cap and the next put would write over the history.
  seed(dir, [row('a')]);
  assert.throws(() => store.list(), CorruptStateError);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('proposals.json.corrupt.')));

  assert.deepEqual(createStore(dir).list().map((p) => p.id), ['a'], 'the next boot comes up clean');
});

test('an empty file is still corruption, not an empty history, even from the cache', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  fs.writeFileSync(path.join(dir, 'proposals.json'), '');
  assert.throws(() => store.list(), CorruptStateError);
});

/* ---------- what a put leaves behind ----------

   put() rewrote the whole array durably and then dropped it, so the next read parsed back the
   bytes it had just written. Measured: put() cost 8.63 ms at 100 proposals, 10.65 at 1000 and
   19.30 at 5000, and a proposal's lifecycle is four of them (pending, approved, executing,
   executed) with a state build reading between each. The two fsyncs in the middle of that are the
   price of durability and stay; the parse on the way back out does not. */

test('the row that was written is the row that is read back', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  const written = row('b');
  store.put(written);
  assert.equal(store.list()[1], written, 'held in memory, not parsed back off the disk');
  assert.equal(store.get('b'), written);
});

test('and it is on the disk, which is the half that was never negotiable', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.put(row('b'));

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'proposals.json'), 'utf8')) as Proposal[];
  assert.deepEqual(onDisk.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(createStore(dir).list().map((p) => p.id), ['a', 'b'], 'and a new store over the same directory reads it');
});

test('a write that fails leaves the store holding what is actually on the disk', () => {
  const dir = tmpDir();
  seed(dir, [row('a')]);
  const store = createStore(dir);
  store.list();

  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => store.put(row('b')), 'a directory that cannot be written to should refuse the write');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepEqual(store.list().map((p) => p.id), ['a'], 'the row that never landed is not being read back');
});
