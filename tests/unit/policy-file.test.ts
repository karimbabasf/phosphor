// The auto-approved daily ceiling in the policy file: the default a fresh install gets, and the
// migration that gives an install predating the field one without a hand edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-policy-file-'));
}

test('a fresh default carries an auto-approved ceiling of five times the click threshold', () => {
  const p = defaultPolicy();
  assert.equal(p.outbound.autoApproveDailyUsd, 5 * p.outbound.humanClickAboveUsd);
  assert.equal(p.outbound.autoApproveDailyUsd, 500);
});

test('the default sentences name the ceiling in plain English', () => {
  const p = defaultPolicy();
  assert.ok(p.sentences.some((s) => /auto-approved moves pass \$500/i.test(s)), p.sentences.join(' | '));
});

test('a policy file predating the field loads with the ceiling filled in', () => {
  const dir = tmpDir();
  const p = defaultPolicy();
  delete (p.outbound as { autoApproveDailyUsd?: number }).autoApproveDailyUsd;
  p.outbound.humanClickAboveUsd = 100;
  // Written straight to disk, so this is a real old file rather than a defaultPolicy with a hole.
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(p));
  const loaded = loadPolicy(dir);
  assert.ok(loaded !== null);
  assert.equal(loaded.outbound.autoApproveDailyUsd, 500, 'five times the click threshold');
});

test('a policy file that already sets the ceiling keeps its own value', () => {
  const dir = tmpDir();
  const p = defaultPolicy();
  p.outbound.autoApproveDailyUsd = 1234;
  p.sentences = renderSentences(p);
  savePolicy(dir, p);
  assert.equal(loadPolicy(dir)?.outbound.autoApproveDailyUsd, 1234);
});

test('a patch may raise the ceiling within the tenfold rule and no further', () => {
  // The engine's raise-factor rule covers the new field: this is asserted in engine.test.ts by
  // rule name; here we only confirm the field survives a round trip through save and load.
  const dir = tmpDir();
  const p = defaultPolicy();
  p.outbound.autoApproveDailyUsd = 500;
  savePolicy(dir, p);
  const loaded = loadPolicy(dir);
  assert.equal(loaded?.outbound.autoApproveDailyUsd, 500);
});

test('a policy file from before the gas floors went loads with the key dropped and no gas sentence', () => {
  const dir = tmpDir();
  const p = defaultPolicy();
  const old = {
    ...p,
    composition: { ...p.composition, minNativeGasUsd: { eth: 5, base: 1, arb: 1, sol: 2, near: 0.5 } },
    sentences: [...p.sentences, 'Keep at least $5 of gas on eth.', 'Keep at least $1 of gas on base.'],
  };
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(old));
  const loaded = loadPolicy(dir);
  assert.ok(loaded !== null, 'an old file still loads: null would refuse every write');
  assert.equal('minNativeGasUsd' in loaded.composition, false, 'the retired key is dropped, not carried forward');
  assert.ok(!loaded.sentences.some((s) => /of gas on/i.test(s)), loaded.sentences.join(' | '));
  assert.ok(!renderSentences(loaded).some((s) => /of gas on/i.test(s)));
});
