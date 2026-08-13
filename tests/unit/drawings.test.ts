import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingStore } from '../../src/drawings.ts';

const aLine = { a: { t: 0, price: 10 }, b: { t: 100, price: 20 } };

test('assigns short readable ids per kind', () => {
  const s = createDrawingStore();
  const one = s.add({ kind: 'trendline', label: 'support', source: 'agent', line: aLine });
  const two = s.add({ kind: 'trendline', label: 'resistance', source: 'agent', line: aLine });
  const zone = s.add({ kind: 'zone', label: 'supply', source: 'agent', zone: { low: 1, high: 2 } });
  assert.equal(one.id, 'tl_1');
  assert.equal(two.id, 'tl_2');
  assert.equal(zone.id, 'zn_1');
});

test('round-trips by id and lists in creation order', () => {
  const s = createDrawingStore();
  const d = s.add({ kind: 'trendline', label: 'x', source: 'agent', line: aLine });
  assert.deepEqual(s.get(d.id), d);
  s.add({ kind: 'zone', label: 'y', source: 'human', zone: { low: 1, high: 2 } });
  assert.deepEqual(s.list().map((x) => x.id), ['tl_1', 'zn_1']);
  assert.equal(s.count(), 2);
});

test('removes by id and reports whether anything went', () => {
  const s = createDrawingStore();
  const d = s.add({ kind: 'trendline', label: 'x', source: 'agent', line: aLine });
  assert.equal(s.remove(d.id), true);
  assert.equal(s.remove(d.id), false);
  assert.equal(s.get(d.id), undefined);
});

test('clears by source so a human can drop the agent drawings and keep their own', () => {
  const s = createDrawingStore();
  s.add({ kind: 'trendline', label: 'mine', source: 'human', line: aLine });
  s.add({ kind: 'trendline', label: 'theirs', source: 'agent', line: aLine });
  assert.equal(s.clear('agent'), 1);
  assert.deepEqual(s.list().map((d) => d.label), ['mine']);
  assert.equal(s.clear(), 1, 'no argument clears everything');
  assert.equal(s.count(), 0);
});

test('caps total drawings, dropping the oldest agent drawing first', () => {
  let clock = 0;
  const s = createDrawingStore({ max: 2, now: () => (clock += 1) });
  s.add({ kind: 'trendline', label: 'human keep', source: 'human', line: aLine });
  s.add({ kind: 'trendline', label: 'agent old', source: 'agent', line: aLine });
  s.add({ kind: 'trendline', label: 'agent new', source: 'agent', line: aLine });
  assert.equal(s.count(), 2);
  const labels = s.list().map((d) => d.label);
  assert.ok(labels.includes('human keep'), 'a human drawing is never evicted for an agent one');
  assert.ok(labels.includes('agent new'));
});

test('the cap yields rather than evict a human drawing', () => {
  const s = createDrawingStore({ max: 1 });
  s.add({ kind: 'trendline', label: 'a', source: 'human', line: aLine });
  s.add({ kind: 'trendline', label: 'b', source: 'human', line: aLine });
  assert.equal(s.count(), 2, 'both survive; a cap guards against agent runaway, not the human');
});

test('ids never repeat even after a removal', () => {
  const s = createDrawingStore();
  const first = s.add({ kind: 'trendline', label: 'a', source: 'agent', line: aLine });
  s.remove(first.id);
  const second = s.add({ kind: 'trendline', label: 'b', source: 'agent', line: aLine });
  assert.notEqual(second.id, first.id, 'a reused id would repoint a live strategy trigger');
});
