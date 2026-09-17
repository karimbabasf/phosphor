// The basic screen after a fill. Karim, 2026-09-14: "when a trade happens, basic mode doesnt
// update the balance". The hero read "checking your new balance" in the balance type and never
// stopped, because the ledger stamped chainStatus.fetchedAt once at boot and every refresh
// carried the stamp forward, so from the first fill after boot the read was older than the
// execution for the life of the process. These tests hold the ledger to re-stamping every read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig, ChainStatus } from '../../src/types.ts';
import { createLedger } from '../../src/ledger/index.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function newestStamp(status: Record<string, ChainStatus>): number {
  return Math.max(...Object.values(status).map((s) => Date.parse(s.fetchedAt)));
}

function cfgFor(mode: AppConfig['mode'], dataDir: string): AppConfig {
  return {
    mode,
    keysPath: path.join(dataDir, 'no-keys.json'),
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    candleProducts: [],
    dataDir,
  };
}

test('the demo ledger re-stamps its read on every refresh', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-after-fill-'));
  const ledger = createLedger(cfgFor('demo', dataDir));
  const first = newestStamp(ledger.snapshot().chainStatus);
  await sleep(5);
  await ledger.refresh();
  assert.ok(newestStamp(ledger.snapshot().chainStatus) > first);
});

test('the live ledger stamps the read when it starts, and again on every refresh', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-after-fill-'));
  // No key on disk, so the verifier and the venue are not read; a fetch that fails after a
  // pause stands in for the price reads and makes the start and the end of a refresh distinct.
  const slowOffline = (async () => {
    await sleep(60);
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const ledger = createLedger(cfgFor('live', dataDir), { fetchImpl: slowOffline });
  const first = newestStamp(ledger.snapshot().chainStatus);
  await sleep(5);

  const started = Date.now();
  await ledger.refresh();
  const stamp = newestStamp(ledger.snapshot().chainStatus);
  assert.ok(stamp > first, 'the stamp moved');
  assert.ok(stamp >= started, 'the stamp is not older than the refresh');
  // Taken before the reads, not after: a read that started before a fill can only carry the
  // balance from before it, whatever the clock said when the answer came back.
  assert.ok(stamp < started + 30, `the stamp is the start of the refresh, not its end (${stamp - started} ms in)`);

  await sleep(5);
  await ledger.refresh();
  assert.ok(newestStamp(ledger.snapshot().chainStatus) > stamp, 'and it moves again on the next pass');
});
