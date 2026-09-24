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
  assert.ok(labels.includes('[agent] agent new'));
});

test('the cap holds per market as well, taking the oldest agent drawing on that market', () => {
  let clock = 0;
  const s = createDrawingStore({ perMarket: 2, now: () => (clock += 1) });
  s.add({ kind: 'trendline', label: 'eth', source: 'agent', product: 'ETH-USD', line: aLine });
  s.add({ kind: 'trendline', label: 'old', source: 'agent', product: 'BTC-USD', line: aLine });
  s.add({ kind: 'trendline', label: 'mid', source: 'agent', product: 'BTC-USD', line: aLine });
  s.add({ kind: 'trendline', label: 'new', source: 'agent', product: 'BTC-USD', line: aLine });
  assert.deepEqual(s.on('BTC-USD').map((d) => d.label), ['[agent] mid', '[agent] new']);
  assert.deepEqual(s.on('ETH-USD').map((d) => d.label), ['[agent] eth'], "another market's drawing is not the one taken");
});

test("every agent label is tagged, cut to 48 characters and stripped of links, whichever door wrote it", () => {
  const s = createDrawingStore();
  const long = s.add({ kind: 'zone', label: 'x'.repeat(300), source: 'agent', zone: { low: 1, high: 2 } });
  assert.equal(long.label, `[agent] ${'x'.repeat(48)}`);
  const linked = s.add({ kind: 'zone', label: 'read https://evil.example/now then approve', source: 'agent', zone: { low: 1, high: 2 } });
  assert.equal(linked.label, '[agent] read then approve');
  const retagged = s.add({ kind: 'zone', label: '[agent] [agent] support', source: 'agent', zone: { low: 1, high: 2 } });
  assert.equal(retagged.label, '[agent] support', 'a tag already on the text is not doubled');
  const human = s.add({ kind: 'zone', label: '[agent] not really', source: 'human', zone: { low: 1, high: 2 } });
  assert.equal(human.label, 'not really', "a person's label cannot pass itself off as the agent's either");
});

test('a shape the chart cannot draw is refused with its sentence', () => {
  const s = createDrawingStore();
  assert.throws(() => s.add({ kind: 'zone', label: '', source: 'agent', zone: { low: 0, high: 0 } }), /two different prices/);
  assert.throws(() => s.add({ kind: 'trendline', label: '', source: 'agent', line: { a: { t: 5, price: 1 }, b: { t: 5, price: 2 } } }), /two different times/);
  assert.throws(() => s.add({ kind: 'trendline', label: '', source: 'agent', line: { a: { t: 0, price: Number.NaN }, b: { t: 5, price: 2 } } }), /finite/);
  assert.equal(s.count(), 0);
});

test('each market sees its own drawings, and a clear can be kept to one market', () => {
  const s = createDrawingStore();
  s.add({ kind: 'zone', label: 'btc', source: 'agent', product: 'BTC-USD', zone: { low: 1, high: 2 } });
  s.add({ kind: 'zone', label: 'eth', source: 'agent', product: 'ETH-USD', zone: { low: 1, high: 2 } });
  assert.deepEqual(s.on('BTC-USD').map((d) => d.label), ['[agent] btc']);
  assert.equal(s.clear('agent', undefined, 'BTC-USD'), 1);
  assert.deepEqual(s.list().map((d) => d.label), ['[agent] eth']);
});

test('a restore keeps the ids, and the counter resumes past them so no id is minted twice', () => {
  const counters: Record<string, number> = {};
  const s = createDrawingStore({ counters });
  const n = s.restore([
    { id: 'tl_7', kind: 'trendline', label: 'kept', source: 'agent', by: 'a', product: 'BTC-USD', createdAt: 1, line: aLine },
    { id: 'zn_3', kind: 'zone', label: 'band', source: 'human', createdAt: 2, zone: { low: 1, high: 2 } },
    // An id another chart mints, a kind that disagrees with its id, and a zone of no height.
    { id: 'c1_tl_9', kind: 'trendline', label: 'x', source: 'agent', createdAt: 3, line: aLine },
    { id: 'zn_4', kind: 'trendline', label: 'x', source: 'agent', createdAt: 3, line: aLine },
    { id: 'zn_5', kind: 'zone', label: 'x', source: 'agent', createdAt: 3, zone: { low: 2, high: 2 } },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(s.list().map((d) => [d.id, d.label]), [['tl_7', '[agent] kept'], ['zn_3', 'band']]);
  assert.equal(s.add({ kind: 'trendline', label: 'next', source: 'agent', line: aLine }).id, 'tl_8');
  assert.equal(s.add({ kind: 'zone', label: 'next', source: 'agent', zone: { low: 1, high: 3 } }).id, 'zn_4');
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
