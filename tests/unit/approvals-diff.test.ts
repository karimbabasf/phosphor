// What a human reads before clicking APPROVE.
//
// policyDiff carries rendered SENTENCES, not fields. So adding one destination to an allowlist
// of seven makes one long string differ from another long string, and the old renderer printed
// both in full: sixteen lines of hex where one had changed, and the reader had to find it by
// eye. Verified on a real screenshot of a pending hyperliquid-perps proposal.
//
// That is a safety property rather than a tidiness one. An approval box nobody can read is an
// approval box that gets clicked without being read, which defeats the point of having one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

/* ui/approvals.js is a browser script that assigns one global. Running it in a context with a
   stub window makes that global the test surface, the same way tests/unit/chart-ui.test.ts
   reaches ui/chart.js. */
function loadApprovals(): Sandbox {
  const source = readFileSync(new URL('../../ui/approvals.js', import.meta.url), 'utf8');
  const sandbox: Sandbox = { window: {}, document: { createElement: () => ({}) }, console };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/approvals.js' });
  return sandbox.window.APPROVALS;
}

const APPROVALS = loadApprovals();

/* Arrays built inside the vm context carry that context's Array prototype, so a strict
   deepEqual against a literal here fails on identity while the contents match. Rebuilding the
   value in this realm compares what the test is actually about. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// The real sentences, taken from the pending proposal 1be070ae on 2026-08-13. Seven
// destinations before, the same seven plus hyperliquid-perps after.
const SEVEN = [
  '0x101f443b4d1b059569d643917553c771e1b9663e',
  '0x6b2937bde17889edcf8fbd8de31c3c2a70bc4d65',
  '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
  '0x27f971cb582bf9e50f397e4d29a5c7a34f11faa2',
  '0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89',
  'oneclick:1click.chaindefuser.com',
  'intents.near',
];
const BEFORE = ['Additional allowed destinations: ' + SEVEN.join(', ') + '.'];
const AFTER = ['Additional allowed destinations: ' + SEVEN.concat('hyperliquid-perps').join(', ') + '.'];

test('adding one destination to an allowlist reports one destination, not the whole list twice', () => {
  const diff = APPROVALS.diffOf(BEFORE, AFTER);
  // diffOf is still correct and still reports a whole sentence each way. The refinement is
  // what turns that into something readable, so both halves are asserted.
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added.length, 1);

  const entries = APPROVALS.refineDiff(diff);
  assert.equal(entries.length, 1, 'the pair must collapse into one changed rule');
  assert.equal(entries[0].kind, 'changed');
  assert.equal(entries[0].label, 'Additional allowed destinations');
  assert.deepEqual(plain(entries[0].gained), ['hyperliquid-perps']);
  assert.deepEqual(plain(entries[0].lost), []);
  assert.equal(entries[0].unchanged, 7, 'how many stayed is part of the decision');
});

test('a removed destination is reported as removed', () => {
  const after = ['Additional allowed destinations: ' + SEVEN.slice(0, 6).join(', ') + '.'];
  const entries = APPROVALS.refineDiff(APPROVALS.diffOf(BEFORE, after));
  assert.equal(entries.length, 1);
  assert.deepEqual(plain(entries[0].lost), ['intents.near']);
  assert.deepEqual(plain(entries[0].gained), []);
});

test('a rule that is not a list is still printed whole, which is the safe direction', () => {
  const before = ['Ask me before anything above $100.'];
  const after = ['Ask me before anything above $500.'];
  const entries = APPROVALS.refineDiff(APPROVALS.diffOf(before, after));
  // No colon and no comma list, so there is nothing to reduce and nothing is hidden.
  assert.equal(entries.length, 2);
  assert.deepEqual(
    plain(entries.map((e: any) => e.sign)),
    ['-', '+'],
  );
  assert.match(entries[0].text, /\$100/);
  assert.match(entries[1].text, /\$500/);
});

test('a rule added outright, with no rule it replaces, is printed whole', () => {
  const entries = APPROVALS.refineDiff(APPROVALS.diffOf([], AFTER));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'line');
  assert.equal(entries[0].sign, '+');
});

test('two rules changing at once do not cross-match', () => {
  const before = [
    'Additional allowed destinations: a, b, c',
    'Allowed programs: p1, p2, p3',
  ];
  const after = [
    'Additional allowed destinations: a, b, c, d',
    'Allowed programs: p1, p2',
  ];
  const entries = APPROVALS.refineDiff(APPROVALS.diffOf(before, after));
  assert.equal(entries.length, 2);
  const byLabel: Record<string, any> = {};
  for (const entry of entries) byLabel[entry.label] = entry;
  assert.deepEqual(plain(byLabel['Additional allowed destinations'].gained), ['d']);
  assert.deepEqual(plain(byLabel['Additional allowed destinations'].lost), []);
  assert.deepEqual(plain(byLabel['Allowed programs'].lost), ['p3']);
  assert.deepEqual(plain(byLabel['Allowed programs'].gained), []);
});

test('an unchanged policy still says nothing changed', () => {
  const entries = APPROVALS.refineDiff(APPROVALS.diffOf(BEFORE, BEFORE));
  assert.equal(entries.length, 0);
});
