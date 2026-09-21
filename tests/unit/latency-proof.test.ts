// The arithmetic behind scripts/latency-proof.ts, held still: the percentile is nearest rank
// (the same rule runner-latency and venue-latency use), a row fails on its budget or on any
// problem whatever its numbers say, the table names the failing rows on its last line, and a
// floor is truncated toward zero, never rounded. The script itself boots a backend and is run
// by hand; what is asserted here is the part that turns samples into a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, rowStats, renderTable, verdictLine, truncatedFloor, type ProofRow } from '../../scripts/latency-proof.ts';

function row(route: string, samples: number[], budgetMs: number, problems: string[] = []): ProofRow {
  return { route, samples, budgetMs, problems };
}

test('percentile is nearest rank: the smallest sample at or above p percent of the set', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 50), 10);
  assert.equal(percentile(twenty, 95), 19);
  assert.equal(percentile(twenty, 100), 20);
  // Order does not matter and the input is left alone.
  const shuffled = [7, 1, 9, 3];
  assert.equal(percentile(shuffled, 95), 9);
  assert.deepEqual(shuffled, [7, 1, 9, 3]);
  // One sample is every percentile; none is no number.
  assert.equal(percentile([42], 5), 42);
  assert.ok(Number.isNaN(percentile([], 95)));
});

test('a row passes on its p95 against the budget and fails on a problem whatever the numbers', () => {
  const quick = rowStats(row('wallet', [1, 2, 3, 300], 300));
  assert.equal(quick.n, 4);
  assert.equal(quick.p95, 300);
  assert.equal(quick.max, 300);
  assert.equal(quick.pass, true);

  assert.equal(rowStats(row('wallet', [1, 2, 3, 301], 300)).pass, false);
  assert.equal(rowStats(row('wallet', [1, 2, 3], 300, ['one call errored'])).pass, false);
  assert.equal(rowStats(row('wallet', [], 300)).pass, false, 'no samples is not a pass');
});

test('the table carries route, n, p50, p95, max, budget and the result, with problems under their row', () => {
  const text = renderTable([row('wallet', [1.04, 2, 3, 4], 300), row('stage change to SSE frame', [600], 500, ['pr_1: no frame after signing'])]);
  const lines = text.split('\n');
  assert.match(lines[0] as string, /^route\s+n\s+p50\s+p95\s+max\s+budget\s+result$/);
  assert.match(lines[2] as string, /^wallet\s+4\s+2\.0\s+4\.0\s+4\.0\s+300 ms\s+PASS$/);
  assert.match(lines[3] as string, /^stage change to SSE frame\s+1\s+600\.0\s+600\.0\s+600\.0\s+500 ms\s+FAIL$/);
  assert.match(lines[4] as string, /^\s+pr_1: no frame after signing$/);
  assert.equal(lines.length, 5);
});

test('the verdict line is PASS alone, or FAIL naming every failing row and extra check', () => {
  const good = [row('wallet', [1], 300), row('propose_swap under threshold', [40], 3000)];
  assert.equal(verdictLine(good), 'LATENCY PROOF: PASS');
  assert.equal(verdictLine(good, [{ label: 'rss', pass: true }]), 'LATENCY PROOF: PASS');
  const bad = [row('wallet', [301], 300), row('policy_show', [1], 300), row('show (proposal)', [1], 300, ['a call errored'])];
  assert.equal(
    verdictLine(bad, [{ label: 'rss', pass: false }, { label: 'audit lines per lifecycle', pass: true }]),
    'LATENCY PROOF: FAIL: wallet, show (proposal), rss',
  );
});

test('a floor is truncated toward zero to six significant figures, never rounded', () => {
  assert.equal(truncatedFloor(5.934637), 5.93463);
  assert.equal(truncatedFloor(0.0021681415929), 0.00216814);
  assert.equal(truncatedFloor(1234567.89), 1234560);
  assert.equal(truncatedFloor(0), 0);
  assert.equal(truncatedFloor(-3), 0);
});
