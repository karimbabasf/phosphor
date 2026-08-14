// chart_scan's timeframe resolution.
//
// The bug this exists to keep dead: asking chart_scan for `1w` returned a ONE MINUTE chart, and
// labelled it as though that was what had been asked for. The handler matched only against the
// button bar (1m to 1d), and fell back to snapTimeframe(Number(entry)) on a miss. Number('1w')
// is NaN, every comparison inside the snap is then false, and the snap returned TIMEFRAMES[0].
//
// It is worth a test rather than a comment because of how it failed. There was no error, no
// staleness marker and no empty result: a weekly bias read came back full of plausible numbers
// off the wrong series, and nothing downstream could tell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScanTimeframe, snapTimeframe, TIMEFRAMES } from '../../src/chart.ts';

const WEEK = 604_800;
const DAY = 86_400;

test('a timeframe above the button bar resolves to itself, not to the first entry', () => {
  // The whole bug in one assertion.
  assert.equal(resolveScanTimeframe('1w'), WEEK);
  assert.notEqual(resolveScanTimeframe('1w'), TIMEFRAMES[0].sec);
});

test('the week can be spelled several ways and they all agree', () => {
  for (const spelling of ['1w', '7d', '168h', '1week', '1 w']) {
    assert.equal(resolveScanTimeframe(spelling), WEEK, `${spelling} should be a week`);
  }
});

test('every button-bar label still resolves to its own seconds', () => {
  for (const tf of TIMEFRAMES) {
    assert.equal(resolveScanTimeframe(tf.label), tf.sec, `${tf.label} should be ${tf.sec}s`);
  }
});

test('a timeframe no venue serves natively is still a timeframe', () => {
  // 7m and 90m are aggregated from a base series. The scan must not refuse them.
  assert.equal(resolveScanTimeframe('7m'), 420);
  assert.equal(resolveScanTimeframe('90m'), 5_400);
  assert.equal(resolveScanTimeframe('3d'), 3 * DAY);
});

test('bare seconds are accepted as a number and as a string', () => {
  assert.equal(resolveScanTimeframe(3600), 3600);
  assert.equal(resolveScanTimeframe('3600'), 3600);
});

test('something that is not a timeframe returns null rather than a nearest guess', () => {
  // Null is the point. A string nobody understood must be reportable by name; substituting the
  // closest real timeframe is exactly how the original bug hid.
  for (const junk of ['banana', '', 'w', '0m', '-5h', 'NaN']) {
    assert.equal(resolveScanTimeframe(junk), null, `${JSON.stringify(junk)} is not a timeframe`);
  }
});

test('past the one week ceiling is refused rather than clamped', () => {
  assert.equal(resolveScanTimeframe('2w'), null);
  assert.equal(resolveScanTimeframe('30d'), null);
});

test('snapTimeframe returns the first entry for NaN, which is why the fallback was wrong', () => {
  // Pinning the behaviour that made the old fallback silently wrong, so nobody reintroduces it
  // believing the snap is safe on unparsed input.
  assert.equal(snapTimeframe(Number('1w')), TIMEFRAMES[0].sec);
});
