import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCardRow, markUnreachable, parseRows, UNREACHABLE_MARK } from '../../scripts/anxiety/rows.ts';
import { median, parseVote, PASS_MAX_VOTE, RUBRIC, rowVerdict } from '../../scripts/anxiety/judge.ts';
import { counts, markdownTable, worstThree, type RowResult } from '../../scripts/anxiety/table.ts';
import { scoreFlow } from '../../scripts/anxiety/flows.ts';
import { endingReply, fill } from '../../scripts/anxiety/agent.ts';
import { claimedRows } from '../../scripts/anxiety/scenes.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// The harness's pure parts, tested away from the browser and the models: the row parser reads
// the real situation file, the judge's arithmetic and validation, the table's counts and pass
// rule, and the flow scorer. Everything here runs in the vm sandbox with no network.

// ---------- the rubric is the definitions file's own ----------

/* Frozen rule 10: the rubric is copied verbatim, never edited to raise a score. So the copy in
   judge.ts must equal the definitions file's term 6(b) byte for byte, from "(b) Rubric" through
   the "Levels:" line. This test reads both and compares; it fails the day the copy drifts. */
test('the rubric in judge.ts is the definitions file term 6(b) verbatim', () => {
  const defs = fs.readFileSync(path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-09-20-quality-definitions.md'), 'utf8');
  const start = defs.indexOf('(b) Rubric');
  assert.ok(start !== -1, 'the definitions file has a "(b) Rubric" block');
  const levelsAt = defs.indexOf('\nLevels:', start);
  assert.ok(levelsAt !== -1, 'the rubric block ends on a Levels line');
  const end = defs.indexOf('\n', levelsAt + 1);
  const fromFile = defs.slice(start, end === -1 ? undefined : end).trim();
  assert.equal(RUBRIC.trim(), fromFile, 'the rubric copy has drifted from the definitions file');
});

// ---------- row parsing ----------

const SAMPLE = `# situations

## A. One card per money kind (44 rows)

| id | kind | stage id | reach |
|---|---|---|---|
| A01 | swap | signing | propose_swap, shot at the signing tick; not reachable in demo: no signing tick |
| A06 | swap, over threshold | waiting_for_you | propose_swap 500 USDC, dock open |

## B. Failures (26 rows, all F)

| id | situation | reach |
|---|---|---|
| B01 | refused: kill_switch | Freeze everything on, then propose_swap |

## C. Onboarding (15 rows, FLOW where marked)

| id | screen | reach |
|---|---|---|
| C09 | money | the deposit card, USDC on a named network (FLOW) |
| C14 | threshold | the click threshold step |
`;

test('parseRows reads id, group, cells, failure, flow and the unreachable mark', () => {
  const rows = parseRows(SAMPLE);
  assert.equal(rows.length, 5);
  const a01 = rows.find((r) => r.id === 'A01')!;
  assert.equal(a01.group, 'A');
  assert.equal(a01.cells[0], 'swap');
  assert.equal(a01.failure, false);
  assert.equal(a01.flow, false);
  assert.equal(a01.unreachable, 'no signing tick');

  const a06 = rows.find((r) => r.id === 'A06')!;
  assert.equal(a06.unreachable, null);

  const b01 = rows.find((r) => r.id === 'B01')!;
  assert.equal(b01.group, 'B');
  assert.equal(b01.failure, true, 'every group B row is a failure by the heading');

  const c09 = rows.find((r) => r.id === 'C09')!;
  assert.equal(c09.flow, true, 'the FLOW mark makes it a leg-b row');
  const c14 = rows.find((r) => r.id === 'C14')!;
  assert.equal(c14.flow, false);
});

test('isCardRow is groups A and B only', () => {
  const rows = parseRows(SAMPLE);
  assert.equal(isCardRow(rows.find((r) => r.id === 'A06')!), true);
  assert.equal(isCardRow(rows.find((r) => r.id === 'B01')!), true);
  assert.equal(isCardRow(rows.find((r) => r.id === 'C09')!), false);
});

test('markUnreachable adds the mark in place, once, and returns null for an unknown row', () => {
  const marked = markUnreachable(SAMPLE, 'A06', 'the reason');
  assert.ok(marked !== null);
  assert.ok((marked as string).includes(`${UNREACHABLE_MARK} the reason`));
  // Idempotent: a row already carrying a mark keeps its first reason.
  const again = markUnreachable(marked as string, 'A06', 'a different reason');
  assert.equal(again, marked, 'a second mark is a no-op');
  assert.ok(!(again as string).includes('a different reason'));
  // The row is still parseable and now reads as unreachable.
  const row = parseRows(marked as string).find((r) => r.id === 'A06')!;
  assert.equal(row.unreachable, 'the reason');
  assert.equal(markUnreachable(SAMPLE, 'Z99', 'x'), null, 'an unknown row is null, never a silent no-op');
});

test('the real situation file parses to 100 rows and marks its unreachable ones', () => {
  const file = path.join(ROOT, 'docs', 'superpowers', 'prompts', '2026-09-20-ready-for-people.situations.md');
  const rows = parseRows(fs.readFileSync(file, 'utf8'));
  assert.equal(rows.length, 100, 'the list is 100 rows');
  assert.ok(rows.filter((r) => r.flow).length >= 4, 'the flow rows are marked');
  // Every marked row names a reason, never a bare mark.
  for (const row of rows.filter((r) => r.unreachable !== null)) assert.ok((row.unreachable as string).length > 0, `${row.id} has a reason`);
});

/* A row no scene plays is a hole in the score that only shows at run time, as "no scene reaches
   this row". Karim's two real swap failures (1Click FAILED with nothing moved, and nobody
   quoting a price) were missing from the list for a week; each row now has its scene. */
test('every row in the situation file is played by a scene or marked not reachable', () => {
  const file = path.join(ROOT, 'docs', 'superpowers', 'prompts', '2026-09-20-ready-for-people.situations.md');
  const claimed = claimedRows();
  const orphans = parseRows(fs.readFileSync(file, 'utf8')).filter((r) => r.unreachable === null && !claimed.has(r.id)).map((r) => r.id);
  assert.deepEqual(orphans, []);
  assert.ok(claimed.has('B27') && claimed.has('B28'), 'the two swap failures have no scene');
});

// ---------- the judge's arithmetic ----------

test('median is the middle, upper-middle on an even count', () => {
  assert.equal(median([2]), 2);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([3, 1, 2]), 2, 'unsorted input is sorted first');
  assert.equal(median([1, 2, 3, 100]), 3, 'even count takes the upper middle, against the product');
  assert.ok(Number.isNaN(median([])));
});

test('rowVerdict: median at or under the bar and no vote over 5 passes; a normal row bars at 3, a failure row at 4', () => {
  assert.equal(rowVerdict([2, 3, 3], false).pass, true, 'median 3 passes a normal row');
  assert.equal(rowVerdict([3, 4, 4], false).pass, false, 'median 4 fails a normal row');
  assert.equal(rowVerdict([3, 4, 4], true).pass, true, 'median 4 passes a failure row');
  assert.equal(rowVerdict([1, 1, 6], false).pass, false, 'a single vote of 6 fails whatever the median');
  assert.equal(rowVerdict([1, 1, PASS_MAX_VOTE], false).pass, true, 'a vote of exactly 5 is allowed');
  assert.equal(rowVerdict([], false).pass, false, 'no votes is a fail, never a skip');
  assert.equal(rowVerdict([], false).reason, 'no votes');
});

// ---------- judge JSON validation ----------

const GOOD = JSON.stringify({
  jargon: { score: 2, why: 'two crypto terms' },
  density: { score: 1, why: 'seven numbers' },
  next_step: { score: 0, why: 'clear' },
  money_certainty: { score: 0, why: 'all there' },
  alarm: { score: 0, why: 'calm' },
});

test('parseVote reads a valid vote and sums the total itself', () => {
  const vote = parseVote(GOOD)!;
  assert.equal(vote.total, 3, 'the total is summed here, never read off the model');
  assert.equal(vote.scores.jargon, 2);
  assert.equal(vote.why.density, 'seven numbers');
});

test('parseVote tolerates a code fence and a wrapping sentence', () => {
  assert.equal(parseVote('```json\n' + GOOD + '\n```')!.total, 3);
  assert.equal(parseVote('Here is my score: ' + GOOD + ' done')!.total, 3);
});

test('parseVote rejects a missing part, an out-of-range score, a non-integer and non-JSON', () => {
  assert.equal(parseVote('{"jargon":{"score":1,"why":"x"}}'), null, 'four parts missing');
  assert.equal(parseVote(GOOD.replace('"score":2', '"score":3')), null, 'a score of 3 is out of the 0 to 2 range');
  assert.equal(parseVote(GOOD.replace('"score":2', '"score":1.5')), null, 'a non-integer score');
  assert.equal(parseVote('not json at all'), null);
  assert.equal(parseVote('[1,2,3]'), null, 'an array is not a vote');
});

// ---------- the table ----------

function row(id: string, status: RowResult['status'], failure: boolean, median: number | null, max: number | null, worst?: { file: string; total: number }): RowResult {
  return { id, failure, flow: false, status, reason: status === 'pass' ? '' : 'because', median, max, votes: median === null ? 0 : 9, samples: median === null ? 0 : 3, worst: worst ?? null };
}

test('counts sums pass, fail, unreachable and the medians', () => {
  const rows = [row('A05', 'pass', false, 1, 2), row('A06', 'fail', false, 4, 7), row('A01', 'unreachable', false, null, null)];
  const c = counts(rows);
  assert.deepEqual([c.rows, c.pass, c.fail, c.unreachable], [3, 1, 1, 1]);
  assert.equal(c.judged, 2, 'the unreachable row has no median');
  assert.equal(c.maxMedian, 4);
  assert.equal(c.meanMedian, 2.5);
});

test('worstThree ranks by the single worst vote, then the median', () => {
  const rows = [
    row('A05', 'pass', false, 1, 2, { file: 'A05.png', total: 2 }),
    row('A06', 'fail', false, 5, 7, { file: 'A06.png', total: 7 }),
    row('B01', 'fail', true, 4, 6, { file: 'B01.png', total: 6 }),
    row('A10', 'pass', false, 3, 5, { file: 'A10.png', total: 5 }),
  ];
  const worst = worstThree(rows);
  assert.deepEqual(worst.map((w) => w.id), ['A06', 'B01', 'A10'], 'the three highest single votes, in order');
});

test('markdownTable prints a row per line, the (F) mark, and the counts line', () => {
  const md = markdownTable([row('A05', 'pass', false, 1, 2), row('B01', 'fail', true, 5, 7)], { judge: 'nearai', runs: 3, folder: '/tmp/run' });
  assert.ok(md.includes('| A05 | pass |'));
  assert.ok(md.includes('| B01 (F) | fail |'), 'a failure row carries the (F) mark');
  assert.ok(md.includes('2 rows: 1 pass, 1 fail'));
  assert.ok(md.includes('Judge: nearai'));
});

// ---------- the scripted agent's pure parts ----------

test('fill substitutes an earlier answer at a path, falls back after a bar, and marks a miss', () => {
  const results = [{ id: 'abc', view: { sentence: '2 USDC to NEAR', money: { amountIn: '2' } } }];
  assert.equal(fill('id is {{0.id}}', results), 'id is abc');
  assert.equal(fill('move: {{0.view.sentence}}', results), 'move: 2 USDC to NEAR');
  assert.equal(fill('{{0.view.missing|the move}}', results), 'the move', 'a missing path takes the fallback');
  assert.equal(fill('{{0.view.missing}}', results), '?', 'no fallback and no value is a visible ?');
  assert.equal(fill('whole: {{0}}', ['hello']), 'whole: hello', 'the whole answer when it was plain text');
});

test('endingReply builds one sentence in the card words for confirmed, declined, refused, failed and stalled', () => {
  const confirmed = endingReply('[phosphor: the swap you proposed (500 USDC to wNEAR, proposal p1) has ended: Confirmed. 161 wNEAR arrived. Tell the person...]');
  assert.ok(confirmed !== null && /Done:/.test(confirmed) && confirmed.includes('161 wNEAR'), 'confirmed names what arrived');
  assert.ok(/no\b/i.test(endingReply('[phosphor: the swap you proposed (x, proposal p1) has ended: Declined. Tell...]') ?? ''), 'declined says you said no');
  assert.ok(/rule/i.test(endingReply('[phosphor: the swap you proposed (x, proposal p1) has ended: Refused. Tell...]') ?? ''), 'refused names a rule');
  assert.ok(/late/i.test(endingReply('[phosphor: the deposit to Hyperliquid you proposed (x, proposal p1) has ended: Late, nothing has changed. Tell...]') ?? ''), 'stalled says late');
  assert.equal(endingReply('the human just typed a normal message'), null, 'a normal turn is not an ending notice');
});

// ---------- the flow scorer ----------

test('scoreFlow: reached, within budget, no wrong clicks passes', () => {
  const flow = { minimum: 4, onPath: [/base/i, /usdc/i, /continue/i] };
  const result = { status: 'done', verified: true, steps: 5, actions: [{ operation: 'click', target: 'Base tile' }, { operation: 'click', target: 'USDC row' }, { operation: 'click', target: 'Continue' }] };
  const score = scoreFlow(flow, result);
  assert.equal(score.pass, true);
  assert.equal(score.reached, true);
  assert.equal(score.wrongClicks, 0);
});

test('scoreFlow: too many steps, a wrong click, or not reached each fail', () => {
  const flow = { minimum: 2, onPath: [/base/i] };
  assert.equal(scoreFlow(flow, { status: 'done', verified: true, steps: 4, actions: [] }).pass, false, '4 steps over 2 x 1.5');
  assert.equal(
    scoreFlow(flow, { status: 'done', verified: true, steps: 2, actions: [{ operation: 'click', target: 'Base' }, { operation: 'click', target: 'Settings' }, { operation: 'click', target: 'Danger' }, { operation: 'click', target: 'Delete' }] }).pass,
    false,
    'three off-path clicks is over the two-wrong-click bar',
  );
  assert.equal(scoreFlow(flow, { status: 'blocked', message: 'stuck', actions: [] }).blocked, true);
  assert.equal(scoreFlow(flow, { status: 'done', verified: false, expect_missing: ['Send on Base only'], actions: [] }).reached, false);
});
