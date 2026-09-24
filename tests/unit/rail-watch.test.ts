// One status watch for every rail (src/rails/watch.ts).
//
// Four rails polled a venue in four copies of one loop, and only the 1Click swap rail started
// fast: sends, payouts and the Hyperliquid moves slept a flat 3 or 5 s between reads, so a move
// that settled in a second showed up to 5 s late (R5 A1 to A3). Every watch starts a quarter
// second after the submit now and doubles to the rail's own interval.
//
// Run: node --test tests/unit/rail-watch.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStatus } from '../../src/intents.ts';
import type { OneClickStatus } from '../../src/intents.ts';
import { FIRST_POLL_MS, pollUntil, watchOneClick } from '../../src/rails/watch.ts';
import { watchStatus } from '../../src/rails/intents-spend.ts';
import type { IntentsSpendDeps } from '../../src/rails/intents-spend.ts';

function clock() {
  const state = { now: 1_000_000, slept: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
}

test('the watch waits a quarter second first and doubles to the interval, inside the window', async () => {
  const c = clock();
  let reads = 0;
  const waited = await pollUntil({ firstMs: FIRST_POLL_MS, everyMs: 3_000, timeoutMs: 12_000, sleep: c.sleep, now: c.now }, async () => {
    reads += 1;
    return false;
  });
  assert.deepEqual(c.state.slept, [250, 500, 1000, 2000, 3000, 3000]);
  assert.equal(waited, 9_750);
  assert.equal(reads, 7);
});

test('a frozen clock still ends the watch, by the waits it asked for', async () => {
  const slept: number[] = [];
  const waited = await pollUntil({ firstMs: 250, everyMs: 1_000, timeoutMs: 3_000, sleep: async (ms) => void slept.push(ms), now: () => 0 }, async () => false);
  assert.ok(waited < 3_000);
  assert.deepEqual(slept, [250, 500, 1000, 1000]);
});

test('a 1Click watch stops at the first terminal word, tells every word, and a failed read is recorded, never thrown', async () => {
  const c = clock();
  const answers: Array<OneClickStatus | Error> = [new Error('502 from status'), parseStatus({ status: 'PROCESSING' }), parseStatus({ status: 'SUCCESS', swapDetails: {} })];
  const words: string[] = [];
  const last = await watchOneClick(
    { firstMs: FIRST_POLL_MS, everyMs: 5_000, timeoutMs: 60_000, sleep: c.sleep, now: c.now },
    async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next as OneClickStatus;
    },
    'handle-1',
    { onEvidence: (e) => void words.push(String(e.providerStage)) },
  );
  assert.equal(last.status, 'SUCCESS');
  assert.deepEqual(words, ['PROCESSING', 'SUCCESS']);
  assert.deepEqual(c.state.slept, [250, 500]);

  const failing = await watchOneClick({ firstMs: 250, everyMs: 500, timeoutMs: 1_000, sleep: c.sleep, now: () => 0 }, async () => {
    throw new Error('socket hang up');
  }, 'handle-2');
  assert.match(failing.reported, /status check failed: socket hang up/);
});

test('a send, a payout and a Hyperliquid deposit watch from a quarter second too, not a flat five', async () => {
  const c = clock();
  const statuses = ['PENDING_DEPOSIT', 'PROCESSING', 'PROCESSING', 'SUCCESS'];
  const deps = {
    api: { status: async () => parseStatus({ status: statuses.shift() ?? 'SUCCESS', swapDetails: {} }) },
    now: c.now,
    sleep: c.sleep,
    pollIntervalMs: 5_000,
    pollTimeoutMs: 300_000,
  } as unknown as IntentsSpendDeps;
  const last = await watchStatus(deps, 'dep-1');
  assert.equal(last.status, 'SUCCESS');
  assert.deepEqual(c.state.slept, [250, 500, 1000], 'a send that settles in two seconds is seen in two, not fifteen');
});
