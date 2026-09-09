// Releasing the queue twice at once, which is what a person does when the first Unlock appears
// to do nothing.
//
// The bug: releaseQueued awaited land() for each queued row in turn, and each of those is a
// network wait of up to thirty seconds. A second unlock arriving mid-loop re-listed the rows the
// first loop had not reached yet, all still pending_unlock, and executed them alongside it. Two
// sends, one intent. land() takes the proposal it is handed and never re-reads the stored
// status, so nothing downstream caught it either.
//
// The property under test is the only one that matters here: however many releases run at once,
// every queued proposal is landed exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChainId, ChainStatus, LedgerSnapshot, Proposal, RiskRow } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { NO_RAILS, releaseQueued } from '../../src/proposals/lifecycle.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function snapshot(): LedgerSnapshot {
  const status: ChainStatus = { ok: true, fetchedAt: new Date().toISOString() };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

function queued(usd: number, createdAt: string): Proposal {
  return {
    id: crypto.randomUUID(),
    kind: 'consolidate',
    createdAt,
    status: 'pending_unlock',
    draft: { kind: 'consolidate', toChain: 'eth', symbol: 'USDT', totalUsd: usd, legs: [] },
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['queued while the wallet was locked'] },
  } as Proposal;
}

/* A context whose land() is a stub that TAKES ITS TIME, which is the whole point: the real one
   ends in a chain send, and the window in which a second release can start is exactly that
   wait. It records every id it was handed, so a row landed twice is visible as a duplicate. */
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-release-'));
  const policy = defaultPolicy();
  policy.sentences = renderSentences(policy);
  savePolicy(dataDir, policy);

  const store = createStore(dataDir);
  const landed: string[] = [];
  let inFlight = 0;
  let overlapped = false;

  const ctx = {
    cfg: {
      mode: 'demo',
      port: 4177,
      addresses: { evm: [], solana: [], near: [] },
      economicTransferUsd: 10,
      candleProducts: [],
      dataDir,
      keysPath: path.join(dataDir, 'keys.json'),
    },
    audit: createAudit(dataDir),
    store,
    ledger: {
      snapshot,
      intents: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    riskRows: [] as RiskRow[],
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir,
    rails: NO_RAILS,
    stables: new Set<string>(),
    notify: () => {},
    execute: async (p: Proposal) => p,
    land: async (p: Proposal) => {
      landed.push(p.id);
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const done: Proposal = { ...p, status: 'executed' };
      store.put(done);
      return done;
    },
    txLookup: async () => null,
  } as unknown as PCtx;

  return { ctx, store, landed, overlapped: () => overlapped };
}

test('two releases running at once land each queued proposal exactly once', async () => {
  const h = setup();
  const rows = [queued(10, '2026-09-01T10:00:00.000Z'), queued(11, '2026-09-01T10:00:01.000Z'), queued(12, '2026-09-01T10:00:02.000Z')];
  for (const row of rows) h.store.put(row);

  // Both calls start before either has finished a single row, which is the two-clicks case.
  const [first, second] = await Promise.all([releaseQueued(h.ctx), releaseQueued(h.ctx)]);

  assert.deepEqual([...h.landed].sort(), rows.map((r) => r.id).sort(), 'every row landed, and none of them twice');
  assert.equal(h.landed.length, 3);
  assert.equal(first + second, 3, 'the two calls report three releases between them, not six');
});

test('a proposal a human already dealt with is skipped rather than landed again', async () => {
  const h = setup();
  const row = queued(10, '2026-09-01T10:00:00.000Z');
  h.store.put(row);
  // Somebody refused it in the window between the unlock and the release reaching this row.
  h.store.put({ ...row, status: 'refused', decidedBy: 'human' });

  assert.equal(await releaseQueued(h.ctx), 0);
  assert.deepEqual(h.landed, [], 'the stored status is the authority, not the list read at the top');
  assert.equal(h.store.get(row.id)?.status, 'refused');
});

test('a queued row is claimed before the wait, so a second reader cannot see it as queued', async () => {
  const h = setup();
  const row = queued(10, '2026-09-01T10:00:00.000Z');
  h.store.put(row);

  const running = releaseQueued(h.ctx);
  // One turn of the loop is enough for the claim to be on disk, because the claim happens with
  // no await between reading the row and writing it back.
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(h.store.get(row.id)?.status, 'pending_unlock', 'claimed before land() is awaited');

  await running;
  assert.equal(h.landed.length, 1);
});
