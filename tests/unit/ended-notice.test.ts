// The app tells the agent when a move it proposed has ended after its turn was over.
//
// Karim's transcript, 2026-09-20: the agent proposed a withdrawal, said "waiting for your click",
// and its turn ended. He clicked, the venue refused the send, and nobody said so: the agent's
// text stayed "Waiting for you" over a card that read Failed, because the only thing that ever
// prompted the driver was a human typing. This module is the other thing.
//
// Run: node --test tests/unit/ended-notice.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEndedNotices } from '../../src/http/ended.ts';
import { proposalView } from '../../src/proposals/view.ts';
import type { Chat } from '../../src/http/context.ts';
import type { DriverEvent, DriverState } from '../../src/driver.ts';
import type { Proposal } from '../../src/types.ts';

const SEAT = 'seat-1';
const T0 = Date.parse('2026-09-20T22:31:00.000Z');

function row(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'w1',
    kind: 'hl_withdraw',
    createdAt: new Date(T0).toISOString(),
    status: 'pending',
    draft: { kind: 'hl_withdraw', symbol: 'USDC', amount: 6.209399, amountUsd: 6.209399, minReceived: 5.93, from: '0x1', to: '0x1', counterparty: 'hypercore-withdraw' },
    simulation: { ok: true, summary: 'ok' },
    verdict: { outcome: 'needs_approval', reasons: [] },
    by: SEAT,
    lastChangeAt: new Date(T0).toISOString(),
    ...over,
  };
}

const failed = (): Proposal =>
  row({ status: 'failed', decidedBy: 'human', decidedAt: new Date(T0 + 30_000).toISOString(), settledAt: new Date(T0 + 31_000).toISOString(),
    result: { ok: false, detail: 'spotSend refused by Hyperliquid: "Action disabled when unified account is active". Nothing was sent.' } });

function world(state: DriverState = 'ready') {
  const subscribers: Array<(p: Proposal) => void> = [];
  const sent: string[] = [];
  const audited: string[] = [];
  let driverState = state;
  const chat = {
    id: 'c1',
    session: SEAT,
    label: 'Assistant',
    transcript: [] as Array<DriverEvent & { at: number }>,
    driver: {
      status: () => ({ state: driverState }),
      send: (text: string) => { if (driverState === 'failed') throw new Error('no agent'); sent.push(text); },
    },
  } as unknown as Chat;
  let now = T0 + 31_000;
  const notices = createEndedNotices({
    store: { subscribe: (fn) => { subscribers.push(fn); return () => {}; } },
    chats: () => [chat],
    view: (p) => proposalView({ settle: (r) => r }, p, now),
    tag: () => '[phosphor: the window is on the basic screen]',
    audit: { append: (_kind: string, text: string) => { audited.push(text); } } as never,
    now: () => now,
  });
  return {
    chat, sent, audited, notices,
    write: (p: Proposal) => { for (const fn of subscribers) fn(p); },
    setState: (s: DriverState) => { driverState = s; },
    tick: (ms: number) => { now += ms; },
    saw: (id: string) => { chat.transcript.push({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id }, data: { id, status: 'failed' }, at: now } as never); },
  };
}

test('a move that ends while the agent is idle is told to it at once, in plain words, with the screen tag', () => {
  const w = world('ready');
  w.write(failed());
  assert.equal(w.sent.length, 1);
  const text = w.sent[0];
  assert.match(text, /withdrawal from Hyperliquid you proposed/);
  assert.match(text, /6\.209399 USDC/);
  assert.match(text, /has ended: Failed/);
  assert.match(text, /Action disabled when unified account is active/);
  assert.match(text, /say nothing/);
  assert.match(text, /\[phosphor: the window is on the basic screen\]$/);
  assert.equal(w.audited.length, 1);
  assert.match(w.audited[0], /^app to Assistant:/);
});

test('the same ending is told once, however many times the row is written', () => {
  const w = world('ready');
  w.write(failed());
  w.write(failed());
  w.write({ ...failed(), lastChangeAt: new Date(T0 + 40_000).toISOString() });
  assert.equal(w.sent.length, 1);
});

test('a move that ends mid-turn waits for the turn to end, then is told', () => {
  const w = world('thinking');
  w.write(failed());
  assert.equal(w.sent.length, 0, 'a turn in progress is not interrupted');
  assert.equal(w.notices.pending(), 1);
  w.setState('ready');
  w.notices.flush(w.chat);
  assert.equal(w.sent.length, 1);
  assert.equal(w.notices.pending(), 0);
});

test('a move the agent read back after it ended is not told again', () => {
  const w = world('thinking');
  w.write(failed());
  w.tick(2_000);
  w.saw('w1');
  w.setState('ready');
  w.notices.flush(w.chat);
  assert.equal(w.sent.length, 0);
});

test('the proposals page and diagnose count as having seen the ending too', () => {
  for (const data of [{ proposals: [{ id: 'w1', stage: 'failed' }] }, { view: { id: 'w1', stage: 'failed' }, audit: [] }]) {
    const w = world('thinking');
    w.write(failed());
    w.tick(2_000);
    w.chat.transcript.push({ kind: 'tool_data', name: 'mcp__phosphor__proposals', input: {}, data, at: T0 + 33_000 } as never);
    w.setState('ready');
    w.notices.flush(w.chat);
    assert.equal(w.sent.length, 0, JSON.stringify(data));
  }
});

test('a row still running, a row nobody proposed, and a row from another seat say nothing', () => {
  const w = world('ready');
  w.write(row({ status: 'approved' }));
  w.write({ ...failed(), by: undefined });
  w.write({ ...failed(), id: 'w2', by: 'somebody-else' });
  assert.equal(w.sent.length, 0);
});

test('a confirmed move is told too, naming what arrived', () => {
  const w = world('ready');
  w.write(row({
    id: 's1', kind: 'swap', status: 'executed', decidedBy: 'policy', decidedAt: new Date(T0).toISOString(), settledAt: new Date(T0 + 15_000).toISOString(),
    draft: { kind: 'swap', venue: 'intents-native', chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7.006872, amountUsd: 7, minAmountOut: 1.9889, from: '0x1', to: '0x1', counterparty: 'intents-native', quote: null },
    result: { ok: true, detail: 'swapped', txids: ['abc'], evidence: { settledAmountOut: '2.0097006159115414' } },
  }));
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /swap you proposed \(7\.006872 USDC to wNEAR/);
  assert.match(w.sent[0], /has ended: Confirmed/);
  assert.match(w.sent[0], /2\.0097006159115414 wNEAR arrived/);
});

test('a late row is told once as late and again when it settles, because stalled settles forward', () => {
  const w = world('ready');
  const late = row({ id: 'd1', status: 'needs_reconciliation', stalledAt: new Date(T0 + 600_000).toISOString(), decidedBy: 'human', decidedAt: new Date(T0).toISOString(),
    result: { ok: false, detail: 'polling', txids: ['0xintent'], evidence: { providerStage: 'PENDING_DEPOSIT', handle: 'h1' } } });
  w.write(late);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /Late, nothing has changed/);
  w.write(late);
  assert.equal(w.sent.length, 1, 'the same lateness twice');
  w.write({ ...late, status: 'executed', settledAt: new Date(T0 + 900_000).toISOString(), result: { ok: true, detail: 'credited', txids: ['0xintent'] } });
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1], /has ended: Confirmed/);
});

test('an agent that is gone is not an error, and the notice is dropped', () => {
  const w = world('failed');
  w.write(failed());
  assert.equal(w.sent.length, 0);
  assert.equal(w.notices.pending(), 0);
});
