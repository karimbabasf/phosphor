// The grader's own tests: one passing run and one failing run per check.
//
// A grader nobody grades is a suite that goes green by being broken, so every check here is fed a
// hand-built trace that must pass and a hand-built trace that must fail for the named reason. No
// app, no driver, no scenario file: these are pure functions over a Run.
//
// Run by `npm run eval`, which runs this file before it boots anything. It is not in `npm test`
// because that glob is tests/unit and this suite is not a unit of the app.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gradeReply, gradeTrace, gradeWindow, stateOf, type Run } from './grade.ts';
import type { Scenario } from './schema.ts';

const T0 = 1_700_000_000_000;

function run(over: Partial<Run> = {}): Run {
  return { trace: [], texts: [], cards: [], frames: [], statusReads: [], mode: 'scripted', ...over };
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'Sx',
    title: 'a made-up scenario',
    userSays: 'hello',
    pre: {},
    script: [],
    mustCall: [],
    mustNotCall: [],
    pass: 'made up',
    ...over,
  } as Scenario;
}

function call(name: string, args: unknown = {}, at = T0): Run['trace'][number] {
  return { at, name, args };
}

// ---------- trace ----------

test('trace: the required calls in the required order pass, and a missing one names itself', () => {
  const s = scenario({ mustCall: ['wallet', 'propose_hl_deposit', 'proposal_status'], mustNotCall: ['propose_send'] });
  const good = run({ trace: [call('wallet'), call('propose_hl_deposit'), call('proposal_status')] });
  assert.equal(gradeTrace(s, good).ok, true);

  const bad = run({ trace: [call('wallet'), call('proposal_status')] });
  const verdict = gradeTrace(s, bad);
  assert.equal(verdict.ok, false);
  assert.match(verdict.first, /propose_hl_deposit is never called/);
});

test('trace: a forbidden call fails even when every required call is there', () => {
  const s = scenario({ mustCall: ['wallet'], mustNotCall: ['propose_send'] });
  const bad = run({ trace: [call('wallet'), call('propose_send', { to: '0xdead' })] });
  const verdict = gradeTrace(s, bad);
  assert.equal(verdict.ok, false);
  assert.match(verdict.first, /propose_send/);
});

test('trace: a write between the read and the propose breaks the ordering rule', () => {
  const s = scenario({ mustCall: [], mustNotCall: [], ordering: [['wallet', 'propose_swap']] });
  const good = run({ trace: [call('wallet'), call('propose_swap')] });
  assert.equal(gradeTrace(s, good).ok, true);

  const bad = run({ trace: [call('wallet'), call('propose_send'), call('propose_swap')] });
  const verdict = gradeTrace(s, bad);
  assert.equal(verdict.ok, false);
  assert.match(verdict.first, /propose_send is written between/);
});

test('trace: an argument is checked by value, and `absent` covers the unconfirmed send', () => {
  const s = scenario({
    mustCall: [],
    mustNotCall: [],
    argChecks: [
      { tool: 'propose_send', path: 'to', equals: '0x1f98' },
      { tool: 'propose_swap', path: 'minAmountOut', gt: 0 },
    ],
  });
  const good = run({ trace: [call('propose_send', { to: '0x1f98' }), call('propose_swap', { minAmountOut: 0.12 })] });
  assert.equal(gradeTrace(s, good).ok, true);

  const bad = run({ trace: [call('propose_send', { to: '0xdead' }), call('propose_swap', { minAmountOut: 0 })] });
  assert.match(gradeTrace(s, bad).first, /propose_send\.to is 0xdead/);

  const unconfirmed = scenario({ mustCall: [], mustNotCall: [], argChecks: [{ tool: 'propose_send', path: 'confirmed', absent: true }] });
  assert.equal(gradeTrace(unconfirmed, run({ trace: [call('propose_send', { to: '0x1f98' })] })).ok, true);
  assert.equal(gradeTrace(unconfirmed, run({ trace: [call('propose_send', { confirmed: true })] })).ok, false);
});

test('trace: traceEquals pins the whole list, and a trailing + takes one or more', () => {
  const s = scenario({ mustCall: [], mustNotCall: [], traceEquals: ['wallet', 'proposal_status+'] });
  assert.equal(gradeTrace(s, run({ trace: [call('wallet'), call('proposal_status'), call('proposal_status')] })).ok, true);
  assert.equal(gradeTrace(s, run({ trace: [call('wallet')] })).ok, false);
  assert.equal(gradeTrace(s, run({ trace: [call('wallet'), call('proposal_status'), call('log_tail')] })).ok, false);
});

// ---------- reply ----------

test('reply: the scenario regexes are required and the banned phrases are refused', () => {
  const s = scenario({ mustSay: ['7\\.5425\\s*USDC'] });
  const good = run({ texts: [{ at: T0, text: 'Sent 7.5425 USDC, waiting on 1Click.' }] });
  assert.equal(gradeReply(s, good).ok, true);

  const missing = run({ texts: [{ at: T0, text: 'Sent it.' }] });
  assert.match(gradeReply(s, missing).first, /does not match/);

  const bare = run({ texts: [{ at: T0, text: 'Sent 7.5425 USDC. Still waiting.' }] });
  assert.match(gradeReply(s, bare).first, /nothing it is waiting on/);
});

test('reply: "should land" and "any minute" are refused whatever else the reply says', () => {
  const s = scenario();
  assert.match(gradeReply(s, run({ texts: [{ at: T0, text: 'It should land shortly.' }] })).first, /should land/);
  assert.match(gradeReply(s, run({ texts: [{ at: T0, text: 'Any minute now.' }] })).first, /any minute/);
  assert.match(gradeReply(s, run({ texts: [{ at: T0, text: 'It is probably fine.' }] })).first, /probably/);
});

test('reply: "it is done" needs a proposal_status read in front of it', () => {
  const s = scenario();
  const claimed = run({ texts: [{ at: T0, text: "It's done." }] });
  assert.equal(gradeReply(s, claimed).ok, false);

  const read = run({
    trace: [call('proposal_status', { id: 'p1' }, T0 - 500)],
    texts: [{ at: T0, text: "It's done." }],
  });
  assert.equal(gradeReply(s, read).ok, true);
});

test('reply: an empty reply fails rather than passing on nothing', () => {
  assert.match(gradeReply(scenario(), run()).first, /said nothing/);
});

// ---------- window ----------

test('window: stateOf reads the view first and the row when there is no view', () => {
  assert.deepEqual(stateOf({ id: 'p1', view: { stage: 'crediting', terminal: false } }), {
    id: 'p1',
    terminal: false,
    stage: 'crediting',
  });
  assert.deepEqual(stateOf({ id: 'p1', status: 'executed' }), { id: 'p1', terminal: true, stage: 'executed' });
  assert.deepEqual(stateOf({ id: 'p1', status: 'needs_reconciliation', outcome: { state: 'settling' } }), {
    id: 'p1',
    terminal: false,
    stage: 'settling',
  });
});

test('window: the transcript rule refuses a window that went terminal before the read did', () => {
  const s = scenario();
  const settling = { id: 'p1', outcome: { state: 'settling' } };

  // The bug: the card reads confirmed while the read a moment later still reads settling.
  const bad = run({
    frames: [{ at: T0, type: 'state', payload: {}, proposals: [{ id: 'p1', status: 'executed' }] }],
    statusReads: [{ at: T0 + 200, data: settling }],
  });
  const verdict = gradeWindow(s, bad);
  assert.equal(verdict.ok, false);
  assert.match(verdict.first, /the window read executed for p1/);

  // The normal case: the window is behind the read, which is a push in flight, not a second truth.
  const good = run({
    frames: [{ at: T0, type: 'state', payload: {}, proposals: [{ id: 'p1', status: 'needs_reconciliation' }] }],
    statusReads: [{ at: T0 + 200, data: settling }],
  });
  assert.equal(gradeWindow(s, good).ok, true);
});

test('window: a named card has to arrive, and inside its budget', () => {
  const s = scenario({ window: { card: 'propose_hl_deposit', withinMs: 1000, fields: ['id'] } });
  const good = run({
    trace: [call('propose_hl_deposit', { amount: 1 }, T0)],
    cards: [{ at: T0 + 120, name: 'propose_hl_deposit', data: { id: 'p1' } }],
  });
  assert.equal(gradeWindow(s, good).ok, true);

  const late = run({
    trace: [call('propose_hl_deposit', { amount: 1 }, T0)],
    cards: [{ at: T0 + 4000, name: 'propose_hl_deposit', data: { id: 'p1' } }],
  });
  assert.match(gradeWindow(s, late).first, /after the call/);

  const none = run({ trace: [call('propose_hl_deposit', { amount: 1 }, T0)] });
  assert.match(gradeWindow(s, none).first, /no propose_hl_deposit card/);

  const thin = run({
    trace: [call('propose_hl_deposit', { amount: 1 }, T0)],
    cards: [{ at: T0 + 10, name: 'propose_hl_deposit', data: { status: 'pending' } }],
  });
  assert.match(gradeWindow(s, thin).first, /carries no id/);
});

test('window: "nothing new" refuses a decision card and allows a read card', () => {
  const s = scenario({ window: { noNewCard: true } });
  const reads = run({ cards: [{ at: T0, name: 'proposal_status', data: { id: 'p1' } }] });
  assert.equal(gradeWindow(s, reads).ok, true);

  const drew = run({ cards: [{ at: T0, name: 'propose_send', data: { id: 'p1' } }] });
  assert.match(gradeWindow(s, drew).first, /drew a propose_send card/);
});

test('window: a sentence naming a stage the window had not reached fails, and no view skips', () => {
  const s = scenario();
  const withView = (at: number, stage: string) => ({
    at,
    type: 'state',
    payload: {},
    proposals: [{ id: 'p1', view: { stage, terminal: false } }],
  });

  const ahead = run({
    frames: [withView(T0, 'crediting'), withView(T0 + 2000, 'submitting')],
    texts: [{ at: T0 + 100, text: 'It is submitting now.' }],
  });
  const verdict = gradeWindow(s, ahead);
  assert.equal(verdict.ok, false);
  assert.match(verdict.first, /named the stage submitting/);

  const together = run({
    frames: [withView(T0, 'crediting')],
    texts: [{ at: T0 + 100, text: 'It is crediting.' }],
  });
  assert.equal(gradeWindow(s, together).ok, true);

  const noView = run({
    frames: [{ at: T0, type: 'state', payload: {}, proposals: [{ id: 'p1', status: 'executing' }] }],
    texts: [{ at: T0 + 100, text: 'It is executing.' }],
  });
  assert.equal(gradeWindow(s, noView).skipped, true);
});
