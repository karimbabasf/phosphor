// The second penetration pass over custom indicators. The first (indicators-custom-pen) fed
// the loader files that are too big, too deep or too many; this one goes after what a file
// can make the app DO: copy a shared subtree until the heap is gone, follow a link out of the
// folder and echo what it found, overflow the stack, or keep a render busy while a human is
// deciding something. Every case is a real file through the real loader, and the assertion
// is the same each time: refused or bounded, in a sentence, and nothing thrown past the loader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IndicatorSpec } from '../../src/indicators.ts';
import { createCustomIndicators } from '../../src/indicators-custom/loader.ts';
import { translatePine } from '../../src/indicators-custom/pine.ts';

const HEAD = '//@version=5\nindicator("T")\n';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-hostile-'));
}

function drop(name: string, body: string | Buffer): { spec: IndicatorSpec | null; problems: string[]; ms: number } {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, name), body);
  const started = performance.now();
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  return { spec: specs[0] ?? null, problems: problems.map((p) => p.message), ms: performance.now() - started };
}

// a0 = close + close, then a<i> = a<i-1> + a<i-1>: a tree of 2^levels leaves held as a graph
// of `levels` nodes. Reading it back through a placeholder is what forces a tree walk.
function doubling(levels: number, tail: string): string {
  let src = `${HEAD}a0 = close + close\n`;
  for (let i = 1; i <= levels; i++) src += `a${i} = a${i - 1} + a${i - 1}\n`;
  return src + tail.replace(/LAST/g, `a${levels}`);
}

test('a subtree that doubles thirty times is refused in bounded time, whichever way it is read back', () => {
  const tails = ['plot(LAST)\n', 'plot(LAST[1])\n', 'var x = 0.0\nx := LAST + nz(x[1])\nplot(x)\n', 'var x = 0.0\nx := nz(x[1]) + LAST\nplot(x)\n'];
  for (const tail of tails) {
    const src = doubling(30, tail);
    assert.ok(src.length < 1024, 'the whole attack fits in a kilobyte');
    const started = performance.now();
    const out = translatePine(src);
    const ms = performance.now() - started;
    assert.equal(out.ok, false, tail);
    if (!out.ok) assert.match(out.message, /deeper than 16|more than 400 nodes/, tail);
    assert.ok(ms < 1000, `${JSON.stringify(tail)} took ${Math.round(ms)} ms`);
  }
  const viaLoader = drop('double.pine', doubling(30, 'var x = 0.0\nx := LAST + nz(x[1])\nplot(x)\n'));
  assert.equal(viaLoader.spec, null);
  assert.ok(viaLoader.ms < 1000);
});
