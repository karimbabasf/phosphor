// The two state files, read the way a crash leaves them.
//
// A power loss mid-append leaves a half-written JSON line in audit.jsonl, and a rename that
// lands without its body leaves a zero-byte proposals.json. Before this the first made the app
// permanently unbootable and the second erased every proposal in silence. Both are asserted
// here against files written by hand into a throwaway data dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit } from '../../src/audit.ts';
import { createStore, CorruptStateError } from '../../src/store.ts';
import type { Proposal } from '../../src/types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-tolerant-'));
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

test('audit.tail skips a torn last line instead of throwing', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'first');
  audit.append('app_start', 'second');
  // What a power loss during appendFileSync leaves: a line with no closing brace and no newline.
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"ts":"2026-09-01T00:00:00.000Z","type":"app_st');

  const events = audit.tail(10);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.msg), ['second', 'first']);
  assert.equal(audit.tornLines(), 1);
});

test('audit.tail still returns `limit` good lines when torn lines sit among them', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'audit.jsonl');
  const good = (n: number): string => JSON.stringify({ ts: new Date().toISOString(), type: 'app_start', msg: `e${n}` }) + '\n';
  fs.writeFileSync(file, good(1) + good(2) + 'not json at all\n' + good(3) + '{"half":\n' + good(4));

  const audit = createAudit(dir);
  const events = audit.tail(3);
  assert.deepEqual(events.map(e => e.msg), ['e4', 'e3', 'e2']);
  assert.equal(audit.tornLines(), 2);
});

test('audit.tail on a file of nothing but torn lines returns nothing and does not throw', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), 'garbage\n{"a":\nmore garbage\n');
  const audit = createAudit(dir);
  assert.deepEqual(audit.tail(50), []);
});

test('a good proposals.json still round-trips', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(sample('a'));
  store.put(sample('b'));
  assert.deepEqual(createStore(dir).list().map(p => p.id), ['a', 'b']);
});

test('an empty-but-existing proposals.json is corruption, not an empty history', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(sample('a'));
  fs.writeFileSync(path.join(dir, 'proposals.json'), '');

  assert.throws(() => store.list(), (err: unknown) => {
    assert.ok(err instanceof CorruptStateError);
    assert.match(err.message, /the file is empty/);
    assert.match(err.message, /will not start/);
    return true;
  });
});

test('a garbage proposals.json refuses, names why, and keeps the bytes', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[{"id":"a","kind":"conso');

  let savedAs = '';
  assert.throws(() => store.list(), (err: unknown) => {
    assert.ok(err instanceof CorruptStateError);
    savedAs = err.savedAs;
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, 'proposals.json')), false);
  assert.equal(fs.readFileSync(savedAs, 'utf8'), '[{"id":"a","kind":"conso');
});

/* ---------- a store that has quarantined once stays refused ----------

   Quarantine renames the bad file aside and throws, and every later read used to find no file
   and return []. One request 500s and from then on the spend history is empty: sessionSpentUsd
   and the daily limit both read zero, the 24 hour cap is fully restored, and the next put writes
   a fresh one-row list over what used to be the history. main.ts refuses to boot on this; nothing
   refused mid-run.
   The latch is per store instance, which is per process. The NEXT boot builds a new one, finds no
   file, and comes up clean with the evidence kept beside it, which is what quarantine is for. */

test('a store that quarantined a file refuses every later read, rather than reading as empty', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(sample('a'));
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[{"id":"a","kind":"conso');

  assert.throws(() => store.list(), CorruptStateError);
  assert.throws(() => store.list(), CorruptStateError, 'the second read refuses too, with the same sentence');
  assert.throws(() => store.get('a'), CorruptStateError);
});

test('a store that quarantined a file refuses to write, so nothing is written over the history', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(sample('a'));
  fs.writeFileSync(path.join(dir, 'proposals.json'), 'not json at all');

  assert.throws(() => store.list(), CorruptStateError);
  assert.throws(() => store.put(sample('b')), CorruptStateError);
  assert.equal(fs.existsSync(path.join(dir, 'proposals.json')), false, 'and no fresh one-row list took its place');
});

test('the next boot comes up clean, because the latch belongs to the process that hit it', () => {
  const dir = tmpDir();
  const first = createStore(dir);
  fs.writeFileSync(path.join(dir, 'proposals.json'), 'not json at all');
  assert.throws(() => first.list(), CorruptStateError);

  // A restart: a new store over the same directory, with the bad bytes kept beside it.
  assert.deepEqual(createStore(dir).list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('proposals.json.corrupt.')), 'the evidence is still there');
});

test('a proposals.json holding an object rather than a list is corruption too', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, 'proposals.json'), '{"proposals":[]}');
  assert.throws(() => store.list(), /holds object, not a list/);
});
