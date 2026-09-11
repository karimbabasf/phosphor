// Penetration tests for custom indicators: every hostile file goes in through the loader,
// the way a real one would, and the assertion is the same each time: refused or bounded, and
// nothing throws past the loader. A chart that dies because of a file in a folder is a
// window that goes blank while a human is deciding something.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Candle } from '../../src/types.ts';
import type { IndicatorSpec } from '../../src/indicators.ts';
import { normaliseParams } from '../../src/indicators.ts';
import { createCustomIndicators } from '../../src/indicators-custom/loader.ts';
import { translatePine } from '../../src/indicators-custom/pine.ts';
import { customIndicatorSchema } from '../../src/indicators-custom/schema.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pen-'));
}

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60, o: 100, h: 101, l: 99, c: 100 + (i % 3), v: 10 }));
}

// Loads one file and returns what the loader said about it. Never throws: that is the test.
function drop(name: string, body: string | Buffer): { spec: IndicatorSpec | null; problems: string[] } {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, name), body);
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  return { spec: specs[0] ?? null, problems: problems.map((p) => (p.line === undefined ? p.message : `line ${p.line}: ${p.message}`)) };
}

function computes(spec: IndicatorSpec, n = 60, params: Record<string, unknown> = {}): ReturnType<IndicatorSpec['compute']> {
  return spec.compute(candles(n), normaliseParams(spec, params).params);
}

const HEAD = '//@version=5\nindicator("T")\n';

test('a 10 MB file is refused on size, in both formats, without being read', () => {
  const started = Date.now();
  const big = Buffer.alloc(10 * 1024 * 1024, 0x20);
  const json = drop('big.json', big);
  const pine = drop('big.pine', big);
  assert.equal(json.spec, null);
  assert.equal(pine.spec, null);
  assert.match(json.problems[0] ?? '', /10240 KB/);
  assert.match(pine.problems[0] ?? '', /cap is 256 KB/);
  assert.ok(Date.now() - started < 1000);
});

test('a 100k node expression is refused whichever way it is shaped', () => {
  const flat = `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["max",${new Array(100_000).fill('1').join(',')}]}]}`;
  assert.ok(flat.length < 256 * 1024, 'the flat form fits under the size cap and must be refused by the walker');
  const out = drop('flat.json', flat);
  assert.equal(out.spec, null);
  assert.match(out.problems[0] ?? '', /max takes/);

  const nested = `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":${'["-",'.repeat(20_000)}"close"${']'.repeat(20_000)}}]}`;
  const deep = drop('deep.json', nested);
  assert.equal(deep.spec, null);
  assert.match(deep.problems[0] ?? '', /deeper than 16|too large/);

  const wide = `${HEAD}plot(${'('.repeat(20_000)}close${')'.repeat(20_000)})\n`;
  const pine = translatePine(wide);
  assert.equal(pine.ok, false);
  if (!pine.ok) assert.match(pine.message, /deep/);
});

test('prototype names never reach an object: __proto__, constructor and friends are refused', () => {
  const names = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];
  for (const name of names) {
    const json = `{"title":"T","overlay":true,"inputs":{${JSON.stringify(name)}:{"default":1}},"plots":[{"title":"p","expr":"close"}]}`;
    const out = drop('proto.json', json);
    assert.equal(out.spec, null, `${name} as an input name must be refused`);
    const pine = translatePine(`${HEAD}${name} = input.int(1)\nplot(close)\n`);
    assert.equal(pine.ok, false, `${name} as a Pine input must be refused`);
  }
  // As an op, a series name, or a top-level key.
  for (const body of [
    '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["constructor","close"]}]}',
    '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["__proto__","close"]}]}',
    '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"constructor"}]}',
    '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close"}],"__proto__":{"polluted":true}}',
    '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close","__proto__":{"polluted":true}}]}',
  ]) {
    assert.equal(drop('op.json', body).spec, null, body);
  }
  for (const line of ['constructor.constructor("return process")()', '__proto__.polluted = 1', 'plot(constructor)', 'plot(eval("1"))', 'x = Function("return 1")']) {
    const pine = translatePine(`${HEAD}${line}\nplot(close)\n`);
    assert.equal(pine.ok, false, line);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('unicode confusables and invisible characters are refused where they stand', () => {
  const cyrillic = translatePine(`${HEAD}plot(сlose)\n`);
  assert.equal(cyrillic.ok, false);
  if (!cyrillic.ok) {
    assert.equal(cyrillic.line, 3);
    assert.match(cyrillic.message, /unexpected character/);
  }
  const zwj = translatePine(`${HEAD}len‍ = input.int(5)\nplot(close)\n`);
  assert.equal(zwj.ok, false);
  const zwsp = translatePine(`${HEAD}plot(clo\u200bse)\n`);
  assert.equal(zwsp.ok, false);
  // A no-break space between tokens is whitespace, because pasted scripts carry them and a
  // space can never be mistaken for part of a name.
  const nbsp = translatePine(`${HEAD}plot(close\u00a0+\u00a01)\n`);
  assert.equal(nbsp.ok, true);

  const seriesName = drop('cy.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"сlose"}]}');
  assert.match(seriesName.problems[0] ?? '', /unknown name/);
  const inputName = drop('cyin.json', '{"title":"T","overlay":true,"inputs":{"lеn":{"default":1}},"plots":[{"title":"p","expr":"close"}]}');
  assert.equal(inputName.spec, null);
  const rtl = drop('rtl.json', '{"title":"T‮","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close"}]}');
  assert.match(rtl.problems[0] ?? '', /format characters/);
  const zw = drop('zw.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p​","expr":"close"}]}');
  assert.match(zw.problems[0] ?? '', /format characters/);
  const nul = drop('nul.json', '{"title":"T\\u0000","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close"}]}');
  assert.match(nul.problems[0] ?? '', /control/);
  // A Pine title with the same characters is refused by the schema pass at the end.
  const pineTitle = translatePine('//@version=5\nindicator("T‮")\nplot(close)\n');
  assert.equal(pineTitle.ok, false);
});

test('history and periods of a billion are refused, not allocated', () => {
  for (const expr of ['["hist","close",1000000000]', '["sma","close",1000000000]', '["atr",1e9]', '["change","close",1000000000]', '["hist","close",1e308]', '["hist","close",-1]']) {
    const out = drop('h.json', `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":${expr}}]}`);
    assert.equal(out.spec, null, expr);
    assert.match(out.problems[0] ?? '', /between/, expr);
  }
  for (const line of ['plot(close[1000000000])', 'plot(ta.sma(close, 1000000000))', 'plot(ta.atr(1e9))']) {
    const pine = translatePine(`${HEAD}${line}\n`);
    assert.equal(pine.ok, false, line);
  }
  // A period from an input is bounded at compute time whatever the agent sends.
  const viaInput = drop('in.json', '{"title":"T","overlay":true,"inputs":{"n":{"default":5}},"plots":[{"title":"p","expr":["hist","close","n"]}]}');
  assert.ok(viaInput.spec);
  const result = computes(viaInput.spec, 20, { n: 1e9 });
  assert.equal(result.plots[0]?.values.length, 20);
  assert.doesNotMatch(result.state, /refused/);
});

test('division by zero and the rest of the arithmetic edge is na, in both formats', () => {
  const json = drop('div.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["/","close",["-","close","close"]]},{"title":"q","expr":["log",["-","close","close"]]},{"title":"r","expr":["%","close",0]}]}');
  assert.ok(json.spec);
  const result = computes(json.spec);
  for (const plot of result.plots) assert.ok(plot.values.every((v) => v === null), plot.key);
  assert.doesNotMatch(result.state, /refused/);
  const pine = translatePine(`${HEAD}plot(close / 0)\nplot(1 / (close - close))\nplot(math.sqrt(-close))\n`);
  assert.ok(pine.ok);
});

test('a plot count of 50 is refused, and the seventh plot names its line', () => {
  const plots = Array.from({ length: 50 }, (_, i) => `{"title":"p${i}","expr":"close"}`).join(',');
  const json = drop('many.json', `{"title":"T","overlay":true,"inputs":{},"plots":[${plots}]}`);
  assert.equal(json.spec, null);
  assert.match(json.problems[0] ?? '', /plots/);
  const pine = translatePine(HEAD + 'plot(close)\n'.repeat(50));
  assert.equal(pine.ok, false);
  if (!pine.ok) {
    assert.equal(pine.line, 9);
    assert.match(pine.message, /at most 6 plots/);
  }
});

test('files that are not indicators at all are problems, not crashes', () => {
  const bodies: [string, string | Buffer][] = [
    ['null.json', 'null'],
    ['array.json', '[]'],
    ['string.json', '"hello"'],
    ['number.json', '42'],
    ['empty.json', ''],
    ['nan.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":NaN}]}'],
    ['inf.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":1e999}]}'],
    ['noexpr.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":null}]}'],
    ['object.json', '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":{"op":"sma"}}]}'],
    ['bin.pine', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80])],
    ['empty.pine', ''],
    ['onlyversion.pine', '//@version=5\n'],
    ['longtitle.json', `{"title":"${'T'.repeat(10_000)}","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close"}]}`],
    ['inputs.json', `{"title":"T","overlay":true,"inputs":{${Array.from({ length: 1000 }, (_, i) => `"i${i}":{"default":1}`).join(',')}},"plots":[{"title":"p","expr":"close"}]}`],
  ];
  for (const [name, body] of bodies) {
    const out = drop(name, body);
    assert.equal(out.spec, null, name);
    assert.ok(out.problems.length > 0, name);
  }
  // A byte order mark is what a Windows editor writes; that file is fine.
  const bom = drop('bom.pine', '﻿//@version=5\nindicator("T")\nplot(close)\n');
  assert.equal(bom.spec?.type, 'custom:bom');
});

test('an indicator that is too heavy for the budget still returns, empty and labelled', () => {
  const chain = 'ta.wma(ta.wma(ta.wma(ta.wma(ta.wma(ta.wma(close, 500), 500), 500), 500), 500), 500)';
  const out = drop('heavy.pine', `${HEAD}plot(${chain})\n`);
  assert.ok(out.spec);
  const result = computes(out.spec, 2000);
  assert.match(result.state, /budget/);
  assert.equal(result.plots[0]?.values.length, 2000);
  assert.ok(result.plots[0]?.values.every((v) => v === null));
});

test('compute survives no candles, one candle, and hostile params', () => {
  const out = drop('ok.json', '{"title":"T","overlay":false,"inputs":{"length":{"default":5,"int":true}},"plots":[{"title":"p","expr":["ema",["rsi","close","length"],3]},{"title":"h","expr":["recur","na",["+",["nz","prev"],1]]}]}');
  assert.ok(out.spec);
  assert.equal(computes(out.spec, 0).plots[0]?.values.length, 0);
  assert.equal(computes(out.spec, 1).plots[1]?.values[0], 1);
  const hostile = JSON.parse('{"__proto__":{"length":3},"constructor":1,"length":"7","toString":9}') as Record<string, unknown>;
  const result = out.spec.compute(candles(30), normaliseParams(out.spec, hostile).params);
  assert.equal(result.plots.length, 2);
  assert.doesNotMatch(result.state, /refused/);
  const nullProto = out.spec.compute(candles(30), Object.assign(Object.create(null) as Record<string, number>, { length: 4 }));
  assert.doesNotMatch(nullProto.state, /refused/);
});

test('the schema validates a hostile object graph without walking it all', () => {
  const started = Date.now();
  const huge = { title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: ['+', 1, 1] as unknown }] };
  let expr: unknown = 'close';
  for (let i = 0; i < 100_000; i++) expr = ['+', expr, 1];
  (huge.plots[0] as { expr: unknown }).expr = expr;
  assert.equal(customIndicatorSchema.safeParse(huge).success, false);
  assert.ok(Date.now() - started < 1000);
});
