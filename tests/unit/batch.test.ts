import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../../src/batch.ts';

const echo = { echo: (args: Record<string, unknown>) => args };

test('runs ops in order and returns one result each', async () => {
  const out = await runBatch([{ op: 'echo', args: { n: 1 } }, { op: 'echo', args: { n: 2 } }], echo);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [{ n: 1 }, { n: 2 }]);
});

test('a later op can reference an earlier result by name', async () => {
  const handlers = {
    make: () => ({ id: 'tl_1' }),
    use: (args: Record<string, unknown>) => ({ got: args.target }),
  };
  const out = await runBatch(
    [
      { op: 'make', as: 'line' },
      { op: 'use', args: { target: '$ref:line.id' } },
    ],
    handlers,
  );
  assert.ok(out[1].ok);
  assert.deepEqual(out[1].ok && out[1].value, { got: 'tl_1' });
});

test('a reference with no path resolves the whole earlier value', async () => {
  const handlers = {
    make: () => ({ id: 'tl_1', label: 'support' }),
    use: (args: Record<string, unknown>) => args.target,
  };
  const out = await runBatch(
    [{ op: 'make', as: 'line' }, { op: 'use', args: { target: '$ref:line' } }],
    handlers,
  );
  assert.deepEqual(out[1].ok && out[1].value, { id: 'tl_1', label: 'support' });
});

test('one failing op does not abort the batch', async () => {
  const handlers = {
    boom: () => {
      throw new Error('nope');
    },
    echo: (args: Record<string, unknown>) => args,
  };
  const out = await runBatch([{ op: 'boom' }, { op: 'echo', args: { n: 1 } }], handlers);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].ok === false && out[0].error, 'nope');
  assert.equal(out[1].ok, true, 'the batch keeps going');
});

test('an unknown op fails that entry with a listing of what exists', async () => {
  const out = await runBatch([{ op: 'nope' }], echo);
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /unknown op.*echo/i);
});

test('an unresolvable reference fails only its own op', async () => {
  const out = await runBatch(
    [{ op: 'echo', args: { x: '$ref:missing.id' } }, { op: 'echo', args: { n: 1 } }],
    echo,
  );
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /missing/);
  assert.equal(out[1].ok, true);
});

test('a string that merely contains a reference is left alone', async () => {
  // Substring interpolation would silently rewrite human-visible label text.
  const out = await runBatch([{ op: 'echo', args: { label: 'watch $ref:line.id here' } }], echo);
  assert.deepEqual(out[0].ok && out[0].value, { label: 'watch $ref:line.id here' });
});

test('caps batch size so one call cannot become a denial of service', async () => {
  const ops = Array.from({ length: 5 }, () => ({ op: 'echo', args: {} }));
  const out = await runBatch(ops, echo, { max: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /at most 3/);
});

test('awaits async handlers', async () => {
  const out = await runBatch([{ op: 'slow' }], { slow: async () => 'done' });
  assert.equal(out[0].ok && out[0].value, 'done');
});
