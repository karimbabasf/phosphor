// How long a fire takes, measured where it happens: the real host, a real fork of the child,
// and the fixture venue on loopback. Two clocks over twenty fires:
//
//   FRAME TO POST   from the market frame that makes a waiting plan's conditions hold
//                   (host.onMarket) to the child's order reaching /exchange. Everything the
//                   app owns: the tick, the watcher, the IPC hop, the child's refusals, the
//                   leverage read, the signature, the socket.
//   FIRE TO POST    from the fire command leaving the host to that same POST. The child's
//                   share of the path above.
//
// The numbers print so they land in the test output. The assertion is p95 under 50 ms on both,
// nearest rank, so one cold sample (the first signature after a fork) does not decide it.
// Nothing here reaches the network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRunnerHost } from '../../src/runner/host.ts';
import type { AccountView, RunnerEvent } from '../../src/runner/host.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import { planHash } from '../../src/trade/plan.ts';
import { venue } from '../fixtures/hl-venue.ts';

const FIRES = 20;
const BUDGET_MS = 50;
// Each plan comes due ten seconds after the one before, so one frame fires exactly one plan.
const STEP_MS = 10_000;
const META = { assetId: 3, szDecimals: 4, maxLeverage: 25 };
const USER = '0x2222222222222222222222222222222222222222';
const KEY = `0x${'11'.repeat(32)}` as `0x${string}`;

// Each plan on a coin of its own: a coin takes one plan at a time.
function row(id: string, after: string, createdAt: string, symbol: string): PlanRow {
  const plan = {
    id,
    symbol,
    side: 'long' as const,
    sizeUsd: 1000,
    leverage: 5,
    entry: { type: 'market' as const, maxSlippageBps: 30 },
    stop: 90,
    target: 120,
    when: [{ type: 'time' as const, after }],
    expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
  };
  return { ...plan, status: 'waiting', hash: planHash(plan), cloids: {}, gen: 0, createdAt, updatedAt: createdAt };
}

function account(atMs: number): AccountView {
  return { atMs, freeUsd: 1000, positions: [], orders: [], fills: [] };
}

// Nearest rank: the p-th percentile is the smallest sample at or above p percent of the set.
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

function report(name: string, samples: number[]): { p50: number; p95: number } {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.log(`${name}: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...samples).toFixed(1)} ms over ${samples.length} fires`);
  return { p50, p95 };
}

const v = venue();
let runner: ReturnType<typeof createRunnerHost> | null = null;

after(async () => {
  await runner?.shutdown();
  await v.close();
});

// The budget is a promise about the machine that develops. A shared CI runner cannot keep it,
// so there the test is skipped by name rather than failing on somebody else's scheduler.
test('twenty fires: frame to venue post and fire command to venue post, p95 under 50 ms', { skip: process.env.CI ? 'a shared runner cannot promise a p95' : false }, async () => {
  const url = await v.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-latency-'));
  const clock = { now: Date.now() };
  const base = clock.now;
  // The instant each fire command left the host, and the placed event that answers it.
  const firedAt = new Map<string, number>();
  const placed = new Map<string, (e: RunnerEvent) => void>();
  runner = createRunnerHost({
    apiWalletKey: async () => KEY,
    baseUrl: url,
    user: USER,
    killSwitch: () => false,
    onEvent: (e) => {
      if (e.type === 'fired') firedAt.set(e.id, performance.now());
      if (e.type === 'placed') placed.get(e.id)?.(e);
    },
    store: createPlanStore(dir),
    meta: () => META,
    mark: () => 100,
    free: () => 1000,
    now: () => clock.now,
  });

  const createdAt = new Date(base).toISOString();
  for (let i = 0; i < FIRES; i += 1) {
    const out = await runner.arm(row(`pl_${i}`, new Date(base + (i + 1) * STEP_MS).toISOString(), createdAt, `COIN${i}`));
    assert.equal(out.ok, true, out.ok ? '' : out.reason);
  }
  runner.onAccount(account(clock.now));
  assert.equal(runner.status().child, 'on');
  assert.equal(v.orders().length, 0, 'nothing fires before its time');

  const frameToPost: number[] = [];
  const fireToPost: number[] = [];
  for (let i = 0; i < FIRES; i += 1) {
    const id = `pl_${i}`;
    clock.now = base + (i + 1) * STEP_MS + 1;
    const answered = new Promise<RunnerEvent>((resolve) => placed.set(id, resolve));
    const t = Math.floor(clock.now / 60_000) * 60;
    const before = performance.now();
    runner.onMarket(`COIN${i}`, { t, o: 100, h: 100, l: 100, c: 100, v: 1 });
    const e = await answered;
    assert.equal(e.type, 'placed');
    const posts = v.state.arrivals.filter((a) => a.path === '/exchange');
    assert.equal(posts.length, i + 1, 'one frame fires one plan, and one plan is one order');
    const post = posts[i] as { at: number };
    frameToPost.push(post.at - before);
    fireToPost.push(post.at - (firedAt.get(id) as number));
  }
  assert.equal(v.orders().length, FIRES);
  for (const o of v.orders()) assert.equal(o.grouping, 'normalTpsl', 'every fire was the bracket');

  const frame = report('frame to venue post', frameToPost);
  const fire = report('fire command to venue post', fireToPost);
  assert.ok(frame.p95 < BUDGET_MS, `frame to post p95 ${frame.p95.toFixed(1)} ms is over ${BUDGET_MS} ms`);
  assert.ok(fire.p95 < BUDGET_MS, `fire to post p95 ${fire.p95.toFixed(1)} ms is over ${BUDGET_MS} ms`);
  assert.ok(fire.p95 <= frame.p95, 'the child path is inside the frame path');
});
