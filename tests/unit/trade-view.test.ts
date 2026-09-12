// The trading surface's own state: what the agent and the human are both looking at.
//
// The chart already proved the pattern. A trend line the agent draws is the shared coordinate
// system for PRICE: the agent measures against it, the human sees it, the bot triggers off it
// by id. This module is the same idea for ROWS. When the agent says "the ETH position is the
// one at risk", it highlights that row, and the human's eye lands on the same object the agent
// is reasoning about. Attention becomes addressable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTradeView, HIGHLIGHT_TTL_MAX_SEC, OVERLAYS } from '../../src/trade/view.ts';

test('the view starts on a symbol and every overlay a trader needs is on', () => {
  const v = createTradeView('BTC');
  assert.equal(v.state().symbol, 'BTC');
  // Risk overlays default ON. A liquidation line you have to switch on is a liquidation line
  // you find out about afterwards.
  assert.equal(v.state().overlays.liquidation, true);
  assert.equal(v.state().overlays.position, true);
  // The plan's stop is the human's own wall and it starts on for the same reason. It carried
  // the mandate's name after mandates were gone, so the window and the agent named one line
  // two ways.
  assert.equal(v.state().overlays.planStop, true);
  assert.ok(!('mandateWall' in v.state().overlays), 'the overlay still carries the mandate name');
  assert.ok((OVERLAYS as readonly string[]).includes('planStop'));
  assert.equal(v.state().rev, 0);
});

test('focusing a symbol bumps the revision and records who did it', () => {
  const v = createTradeView('BTC');
  const out = v.setFocus({ symbol: 'eth' }, 'agent');
  assert.equal(out.ok, true);
  assert.equal(v.state().symbol, 'ETH', 'symbols are upper-cased so one coin is one key');
  assert.equal(v.state().rev, 1);
  assert.equal(v.state().lastDriver, 'agent');
});

test('an empty focus call changes nothing and does not bump the revision', () => {
  // The revision drives the browser's redraw and the agent's echo suppression. Bumping it for
  // a call that changed nothing makes both of them work for no reason.
  const v = createTradeView('BTC');
  v.setFocus({ symbol: 'ETH' }, 'human');
  const before = v.state().rev;
  assert.equal(v.setFocus({}, 'human').ok, true);
  assert.equal(v.state().rev, before);
});

test('a highlight carries a note and points at a row by kind and id', () => {
  const v = createTradeView('BTC');
  const out = v.highlight(
    { kind: 'position', id: 'ETH', note: 'closest to liquidation of the three' },
    'agent',
  );
  assert.equal(out.ok, true);
  const [h] = v.state().highlights;
  assert.equal(h.kind, 'position');
  assert.equal(h.id, 'ETH');
  assert.equal(h.note, 'closest to liquidation of the three');
  assert.equal(h.source, 'agent');
});

test('highlighting the same row twice replaces rather than stacks', () => {
  const v = createTradeView('BTC');
  v.highlight({ kind: 'order', id: 'oid_9', note: 'first' }, 'agent');
  v.highlight({ kind: 'order', id: 'oid_9', note: 'second' }, 'agent');
  assert.equal(v.state().highlights.length, 1);
  assert.equal(v.state().highlights[0].note, 'second');
});

test('an unknown highlight kind is refused with the list of known kinds', () => {
  const v = createTradeView('BTC');
  const out = v.highlight({ kind: 'wallet', id: 'x', note: '' }, 'agent');
  assert.equal(out.ok, false);
  assert.match(String(out.error), /position/);
});

test('a plan, a level, a line and an indicator can be pointed at, and the note rides on the pointer', () => {
  // The spotlight: the note lives on the highlight, because a sentence with nothing pointed at
  // is a sentence nobody can check. There is no separate note surface.
  const v = createTradeView('BTC');
  for (const [kind, id] of [['plan', 'pl_1'], ['level', 'lv_2'], ['line', 'tl_3'], ['indicator', 'rsi_1']] as const) {
    const out = v.highlight({ kind, id, note: `look at ${id}` }, 'agent');
    assert.equal(out.ok, true, kind);
  }
  assert.equal(v.state().highlights.length, 4);
  assert.equal(v.state().highlights[0].note, 'look at pl_1');
  assert.equal('note' in v.state(), false, 'no note surface beside the highlights');
});

test('highlights expire, so a stale pointer never sits on screen claiming to be current', () => {
  let clock = 1_000_000;
  const v = createTradeView('BTC', () => clock);
  v.highlight({ kind: 'position', id: 'BTC', note: 'watch this', ttlSec: 60 }, 'agent');
  assert.equal(v.state().highlights.length, 1);
  clock += 59_000;
  assert.equal(v.state().highlights.length, 1);
  clock += 2_000;
  assert.equal(v.state().highlights.length, 0, 'past its ttl it is gone from the state itself');
});

test('a ttl beyond the cap is clamped and the clamp is reported, never silent', () => {
  const v = createTradeView('BTC');
  const out = v.highlight({ kind: 'fill', id: 'f1', note: 'x', ttlSec: 99_999 }, 'agent');
  assert.equal(out.ok, true);
  assert.ok(out.notes.some((n) => /clamped/.test(n)), `expected a clamp note, got ${JSON.stringify(out.notes)}`);
  assert.equal(v.state().highlights[0].ttlSec, HIGHLIGHT_TTL_MAX_SEC);
});

test('overlays toggle by name and an unknown name is refused', () => {
  const v = createTradeView('BTC');
  assert.equal(v.setOverlay({ name: 'fills', on: true }, 'agent').ok, true);
  assert.equal(v.state().overlays.fills, true);
  assert.equal(v.setOverlay({ name: 'fills', on: false }, 'agent').ok, true);
  assert.equal(v.state().overlays.fills, false);

  const bad = v.setOverlay({ name: 'moon', on: true }, 'agent');
  assert.equal(bad.ok, false);
  for (const name of OVERLAYS) assert.match(String(bad.error), new RegExp(name));
});

test('clearing drops the agent objects and leaves the human view alone', () => {
  const v = createTradeView('BTC');
  v.setFocus({ symbol: 'SOL' }, 'human');
  v.setOverlay({ name: 'fills', on: true }, 'human');
  v.highlight({ kind: 'position', id: 'SOL', note: 'a' }, 'agent');

  v.clear('agent');
  assert.equal(v.state().highlights.length, 0);
  assert.equal(v.state().symbol, 'SOL', 'the human focus is not the agent to clear');
  assert.equal(v.state().overlays.fills, true);
});
