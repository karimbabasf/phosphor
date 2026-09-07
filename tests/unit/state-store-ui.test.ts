// What the window does to decide whether a slice changed.
//
// A state frame arrives every 15 s at rest and up to 8 times a second with a trading feed live, and
// on each one the store compared every subscribed slice against the last. It did that with
// JSON.stringify on both sides. At 1000 proposals the proposals slice was 744 KB, stringify of it
// measured 0.67 ms, and same() runs it twice: 1.33 ms of main-thread work per frame, on top of
// parsing the response, to answer a question the answer to which was usually "nothing moved".
//
// Nothing is serialised now. It walks the two values, stops at the first thing that differs, and
// stops altogether once it has looked at a fixed number of objects. Giving up reads as "changed",
// so a slice too big to walk is rendered rather than skipped: that costs a redraw of something that
// already looked right, and the keyed reconcilers write nothing for it. The other direction costs a
// screen quietly showing a number that has moved, and this is a window that tells somebody how much
// money they have.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/core/state.js', import.meta.url), 'utf8');

type Store = {
  get(): Record<string, unknown>;
  put(next: Record<string, unknown>): void;
  select(key: string, handler: (value: unknown) => void): () => void;
  subscribe(handler: (next: unknown, previous: unknown) => void): () => void;
  loaded(): boolean;
};

type Loaded = { store: Store; stringifyCalls: () => number };

/* The store is a browser script that assigns one global. JSON.stringify inside the sandbox is
   wrapped before the script runs, so the tests can assert not just what the store decided but
   what it spent to decide it. */
function load(): Loaded {
  const sandbox: Record<string, any> = { window: {}, console };
  createContext(sandbox);
  runInContext(
    'globalThis.__calls = 0; var real = JSON.stringify; JSON.stringify = function (v) { globalThis.__calls += 1; return real(v); };',
    sandbox,
  );
  runInContext(SOURCE, sandbox, { filename: 'ui/core/state.js' });
  return { store: sandbox.window.PhosphorState as Store, stringifyCalls: () => sandbox.__calls as number };
}

// Comfortably over any sane text ceiling: 200 rows of about forty characters each.
function bigRows(tag: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 200; i += 1) out.push({ id: `${tag}-${i}`, detail: 'a sentence about what this row did, in full' });
  return out;
}

test('a slice handed back as the same object does not fire', () => {
  const { store, stringifyCalls } = load();
  const rows = bigRows('a');
  store.put({ proposals: rows, other: 1 });

  let fired = 0;
  store.select('proposals', () => (fired += 1));
  assert.equal(fired, 1, 'select fires once on subscribe when the store is already loaded');

  const before = stringifyCalls();
  store.put({ proposals: rows, other: 2 });
  assert.equal(fired, 1, 'the same array is the same slice');
  assert.equal(stringifyCalls(), before, 'and nothing was serialised to work that out');
});

test('a big slice whose rows are the same objects does not fire, and is not serialised', () => {
  const { store, stringifyCalls } = load();
  const rows = bigRows('a');
  store.put({ proposals: rows.slice() });

  let fired = 0;
  store.select('proposals', () => (fired += 1));

  const before = stringifyCalls();
  // What a re-parsed payload looks like when the list itself did not move: a new array carrying
  // the rows that were already there.
  store.put({ proposals: rows.slice() });
  assert.equal(fired, 1, 'a new array over the same rows is not a change');
  assert.equal(stringifyCalls(), before, 'and 200 rows were not serialised twice to say so');
});

test('a small slice that is equal but rebuilt does not fire', () => {
  const { store } = load();
  store.put({ lock: { state: 'unlocked', idleLocksInSec: 900 } });

  let fired = 0;
  store.select('lock', () => (fired += 1));
  store.put({ lock: { state: 'unlocked', idleLocksInSec: 900 } });
  assert.equal(fired, 1, 'the same three values are the same slice');
});

test('a slice that changed fires, at every size', () => {
  const { store } = load();
  store.put({ lock: { state: 'unlocked' }, proposals: bigRows('a') });

  let lock = 0;
  let proposals = 0;
  store.select('lock', () => (lock += 1));
  store.select('proposals', () => (proposals += 1));

  store.put({ lock: { state: 'locked' }, proposals: bigRows('b') });
  assert.equal(lock, 2, 'the lock moved');
  assert.equal(proposals, 2, 'and so did every row of the list');
});

test('a list that lost or gained a row fires', () => {
  const { store } = load();
  const rows = bigRows('a');
  store.put({ proposals: rows });

  let fired = 0;
  store.select('proposals', () => (fired += 1));
  store.put({ proposals: rows.slice(0, 199) });
  assert.equal(fired, 2);
});

test('nothing is ever serialised to answer this question', () => {
  const { store, stringifyCalls } = load();
  store.put({ proposals: bigRows('a'), lock: { state: 'unlocked' } });
  store.select('proposals', () => {});
  store.select('lock', () => {});

  const before = stringifyCalls();
  store.put({ proposals: bigRows('b'), lock: { state: 'unlocked' } });
  store.put({ proposals: bigRows('c'), lock: { state: 'locked' } });
  assert.equal(stringifyCalls(), before, 'the walk stops at the first thing that differs; it does not measure the whole slice');
});

/* The ceiling, and which way it errs. A slice too big to walk inside the budget is reported as
   changed, so the renderer runs on something that already looked right. That is a redraw the keyed
   reconcilers write nothing for. The other direction would be a screen quietly showing a number
   that has moved. */
test('a slice too big to walk is reported as changed rather than guessed at', () => {
  const { store } = load();
  const deep = (tag: string): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 900; i += 1) out.push({ id: `${tag}-${i}`, nested: { a: i, b: 'x' } });
    return out;
  };
  store.put({ proposals: deep('a') });

  let fired = 0;
  store.select('proposals', () => (fired += 1));
  store.put({ proposals: deep('a') });
  assert.equal(fired, 2, 'equal, and too big to prove it inside the budget');
});

test('a shallow slice of the same size is still compared properly', () => {
  const { store } = load();
  const rows = (tag: string): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 40; i += 1) out.push({ id: `${tag}-${i}`, at: i });
    return out;
  };
  store.put({ proposals: rows('a') });

  let fired = 0;
  store.select('proposals', () => (fired += 1));
  store.put({ proposals: rows('a') });
  assert.equal(fired, 1, 'forty rows rebuilt with the same contents is not a change');
  store.put({ proposals: rows('b') });
  assert.equal(fired, 2);
});

test('the whole-payload subscribers still fire on every put', () => {
  const { store } = load();
  let fired = 0;
  store.subscribe(() => (fired += 1));
  store.put({ a: 1 });
  store.put({ a: 1 });
  assert.equal(fired, 2, 'a subscriber gets every frame; only slices are filtered');
});

test('a non-object put is ignored and a null slice is not an object', () => {
  const { store } = load();
  store.put({ a: 1 });
  store.put(null as unknown as Record<string, unknown>);
  assert.deepEqual(store.get(), { a: 1 });

  let fired = 0;
  store.select('policy', () => (fired += 1));
  store.put({ a: 1, policy: null });
  assert.equal(fired, 2, 'null replacing undefined is a change');
  store.put({ a: 1, policy: null });
  assert.equal(fired, 2, 'and null replacing null is not');
});
