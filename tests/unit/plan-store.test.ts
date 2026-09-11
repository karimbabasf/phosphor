// The plan registry on disk: plans.json beside the policy, written atomically and readable by
// the owner alone. An idea can be removed; anything that has been armed leaves a row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-plans-'));
}

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 'pl_1',
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 100,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    expiresAt: '2026-09-12T00:00:00.000Z',
    status: 'idea',
    hash: 'abc',
    cloids: {},
    gen: 0,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...over,
  };
}

test('put, get, list and a boot load from the same file', () => {
  const d = dir();
  const store = createPlanStore(d);
  store.put(row());
  store.put(row({ id: 'pl_2', status: 'waiting' }));
  assert.equal(store.get('pl_1')?.status, 'idea');
  assert.equal(store.list().length, 2);

  const again = createPlanStore(d);
  assert.deepEqual(
    again.list().map((r) => r.id),
    ['pl_1', 'pl_2'],
  );
});

test('the file is written whole through the one durable writer and is owner-only', () => {
  const d = dir();
  const store = createPlanStore(d);
  store.put(row());
  const file = path.join(d, 'plans.json');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(fs.readdirSync(d).some((f) => f.endsWith('.tmp')), false, 'no temp file is left behind');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))));
});

test('an idea can be removed and nothing else can', () => {
  const store = createPlanStore(dir());
  store.put(row());
  store.put(row({ id: 'pl_2', status: 'waiting' }));
  assert.equal(store.remove('pl_1'), true);
  assert.equal(store.get('pl_1'), null);
  assert.equal(store.remove('pl_2'), false, 'a waiting plan leaves a row');
  assert.equal(store.get('pl_2')?.status, 'waiting');
  assert.equal(store.remove('pl_9'), false);
});

test('a damaged file is moved aside and the store starts empty rather than throwing', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'plans.json'), '{not json');
  const store = createPlanStore(d);
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('plans.json.')), 'the evidence is kept beside the file');
});

test('rows that do not look like plans are dropped on load, and the rest survive', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'plans.json'), JSON.stringify([row(), { id: 42 }, null, 'x']));
  const store = createPlanStore(d);
  assert.equal(store.list().length, 1);
});
