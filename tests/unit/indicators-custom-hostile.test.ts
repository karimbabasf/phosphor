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
import { customIndicatorSchema } from '../../src/indicators-custom/schema.ts';

const HEAD = '//@version=5\nindicator("T")\n';

// Built from code points rather than typed, so an editor that strips or shows invisible
// characters cannot change what these tests feed in.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(0x07);
const NBSP = String.fromCodePoint(0xa0);

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

test('a script that would overflow the stack is refused with a sentence, not a stack trace', () => {
  const chain = `${HEAD}x = ${new Array(10_000).fill('close').join(' + ')}\nplot(x[1])\n`;
  let elseIf = `${HEAD}x = 0.0\nif close > 1\n    x := 1\n`;
  for (let i = 0; i < 6_000; i++) elseIf += `else if close > ${i + 2}\n    x := ${i + 2}\n`;
  elseIf += 'plot(x)\n';
  for (const src of [chain, elseIf]) {
    const out = translatePine(src);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.match(out.message, /too deep/);
      assert.doesNotMatch(out.message, /translator error|call stack/);
    }
  }
});

test('a control or format character in a script is named by its code point, never echoed', () => {
  const cases: [string, string][] = [
    [`${HEAD}plot(close${RLO})\n`, 'U+202E'],
    [`${HEAD}plot(clo${ZWSP}se)\n`, 'U+200B'],
    [`${HEAD}plot(close${BEL})\n`, 'U+0007'],
    [`${HEAD}x${NBSP}= close\nplot(x)\n`, ''],
  ];
  for (const [src, expect] of cases) {
    const out = translatePine(src);
    if (expect === '') {
      assert.equal(out.ok, true, 'a no-break space between tokens is whitespace');
      continue;
    }
    assert.equal(out.ok, false, JSON.stringify(src));
    if (!out.ok) {
      assert.equal(out.message, `unexpected character ${expect}`);
      assert.equal(/[\p{Cc}\p{Cf}]/u.test(out.message), false, JSON.stringify(out.message));
    }
  }
  // The JSON side quotes an unknown name back too, so the same rule holds there, and a name
  // the size of the file is cut to something a human can find.
  const bidi = customIndicatorSchema.safeParse({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: [`sm${RLO}a`, 'close', 5] }] });
  assert.equal(bidi.success, false);
  if (!bidi.success) assert.equal(bidi.error.issues[0]?.message, "unknown op 'smU+202Ea'");
  const long = customIndicatorSchema.safeParse({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'x'.repeat(100_000) }] });
  assert.equal(long.success, false);
  if (!long.success) {
    const message = long.error.issues[0]?.message ?? '';
    assert.ok(message.length < 80, `${message.length} characters`);
    assert.match(message, /^unknown name 'x{40}\.\.\.'$/);
  }
});
