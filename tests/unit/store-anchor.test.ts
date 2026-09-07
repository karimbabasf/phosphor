/* The proposal store against the file edits the 2026-09-07 audit reproduced: an emptied or
   deleted proposals.json used to come up as "no proposals yet", and the 24 hour spend is computed
   from those rows, so one write restored the whole budget. The anchor beside the file remembers
   the count this app wrote, and every row is checked for the two fields a proposal cannot lack. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, CorruptStateError } from '../../src/store.ts';
import type { Proposal, ProposalStatus } from '../../src/types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-store-anchor-'));
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

test('writing [] over a store that held rows is corruption, not a fresh start', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(row('a'));
  store.put(row('b'));
  assert.equal(store.list().length, 2);
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[]');
  assert.throws(() => createStore(dir).list(), CorruptStateError);
});

test('a row that is not a proposal quarantines the file', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(row('a'));
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[null]');
  assert.throws(() => createStore(dir).list(), /row 1 is not a proposal/);
});

test('a deleted file with an anchor behind it is refused by name, and the anchor is the way out', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(row('a'));
  fs.rmSync(path.join(dir, 'proposals.json'));
  assert.throws(() => createStore(dir).list(), /proposals\.anchor\.json says this app wrote 1 rows/);
  fs.rmSync(path.join(dir, 'proposals.anchor.json'));
  assert.deepEqual(createStore(dir).list(), []);
});

test('a store that only grows keeps working across processes', () => {
  const dir = tmpDir();
  const first = createStore(dir);
  first.put(row('a', 'pending'));
  first.put(row('b'));
  first.put({ ...row('a', 'pending'), status: 'executed' } as Proposal);
  const second = createStore(dir);
  assert.equal(second.list().length, 2);
  assert.equal(second.get('a')?.status, 'executed');
});

test('the proposal file and its anchor are readable by their owner and nobody else', () => {
  const dir = tmpDir();
  createStore(dir).put(row('a'));
  for (const name of ['proposals.json', 'proposals.anchor.json']) {
    const mode = fs.statSync(path.join(dir, name)).mode & 0o777;
    assert.equal(mode, 0o600, `${name} is mode ${mode.toString(8)}`);
  }
});
