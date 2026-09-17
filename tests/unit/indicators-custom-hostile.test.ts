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

import { bootChartServer } from '../fixtures/chart-server.ts';
import type { Candle } from '../../src/types.ts';
import type { IndicatorSpec } from '../../src/indicators.ts';
import { normaliseParams } from '../../src/indicators.ts';
import { createChartStore } from '../../src/chart.ts';
import { resolveIndicator } from '../../src/http/chart.ts';
import type { Ctx } from '../../src/http/context.ts';
import { compile } from '../../src/indicators-custom/evaluate.ts';
import { createCustomIndicators } from '../../src/indicators-custom/loader.ts';
import { translatePine } from '../../src/indicators-custom/pine.ts';
import { customIndicatorSchema } from '../../src/indicators-custom/schema.ts';

const HEAD = '//@version=5\nindicator("T")\n';
const UI = path.join(import.meta.dirname, '..', '..', 'ui', 'chart');

// Built from code points rather than typed, so an editor that strips or shows invisible
// characters cannot change what these tests feed in.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(0x07);
const NBSP = String.fromCodePoint(0xa0);

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-hostile-'));
}

function candles(n: number): Candle[] {
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p += Math.sin(i / 7) + (i % 5) * 0.1;
    return { t: i * 60, o: p, h: p + 1, l: p - 1, c: p + 0.3, v: 10 + (i % 9) };
  });
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

test('a symbolic link in the folder is not followed, and nothing from its target reaches a problem', () => {
  const root = scratch();
  const dir = path.join(root, 'indicators');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'keys.enc.json'), JSON.stringify({ v: 1, kdf: 'scrypt', salt: 'c2FsdA==', ct: 'U0VDUkVU' }));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET_PRIVATE_KEY=0xdeadbeef\n');
  fs.writeFileSync(path.join(root, 'good.json'), JSON.stringify({ title: 'G', overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] }));
  fs.symlinkSync(path.join(root, 'keys.enc.json'), path.join(dir, 'keys.json'));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd.json'));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd2.pine'));
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'secret.json'));
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'secret2.pine'));
  fs.symlinkSync(path.join(root, 'good.json'), path.join(dir, 'good.json'));
  fs.symlinkSync(root, path.join(dir, 'dir.json'));
  fs.symlinkSync(path.join(dir, 'loop.json'), path.join(dir, 'loop.json'));
  fs.symlinkSync(path.join(dir, 'missing-target.json'), path.join(dir, 'dangling.json'));
  fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify({ title: 'R', overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] }));
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:real'],
    'a link to a valid indicator outside the folder is still not an indicator',
  );
  const files = problems.map((p) => p.file).sort();
  assert.deepEqual(files, ['dangling.json', 'dir.json', 'good.json', 'keys.json', 'loop.json', 'passwd.json', 'passwd2.pine', 'secret.json', 'secret2.pine']);
  for (const p of problems) {
    assert.match(p.message, /symbolic link/, p.file);
    for (const leak of ['SECRET', 'root', 'kdf', 'salt', 'Required', 'title']) assert.ok(!p.message.includes(leak), `${p.file}: ${p.message}`);
  }
  assert.equal(loader.get('keys'), null);
  assert.equal(loader.get('secret'), null);
  assert.equal(loader.get('good'), null);
});

test('a file that is not JSON is reported without quoting any of it', () => {
  for (const body of ['SECRET_PRIVATE_KEY=0xdeadbeef', 'root:*:0:0:System Administrator', '{"a": tru}', '{"title": "T", "cipher": "U0VDUkVU"', ' binary', '{"default":NaN}']) {
    const out = drop('leak.json', body);
    assert.equal(out.spec, null);
    assert.match(out.problems[0] ?? '', /^not valid JSON/);
    for (const word of ['SECRET', 'root', 'tru', 'cipher', 'U0VDUkVU', 'NaN', '"']) assert.ok(!(out.problems[0] ?? '').includes(word), `${JSON.stringify(body)} -> ${out.problems[0]}`);
  }
  // The position survives when the parser gives one, because that is what the human needs.
  assert.match(drop('pos.json', '{"a":1,').problems[0] ?? '', /position 7/);
});

test('a 20 MB pine file and a 300 KB json file are refused on size before they are read', () => {
  const pine = drop('big.pine', Buffer.alloc(20 * 1024 * 1024, 0x20));
  assert.equal(pine.spec, null);
  assert.match(pine.problems[0] ?? '', /20480 KB and the cap is 256 KB/);
  assert.ok(pine.ms < 500, `${Math.round(pine.ms)} ms`);
  const json = drop('big.json', `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":"close"}],"pad":"${'x'.repeat(300 * 1024)}"}`);
  assert.equal(json.spec, null);
  assert.match(json.problems[0] ?? '', /300 KB and the cap is 256 KB/);
});

test('an expression 10000 deep and an op with a million arguments are refused without a walk', () => {
  let deep: unknown = 'close';
  for (let i = 0; i < 10_000; i++) deep = ['abs', deep];
  let started = performance.now();
  const deepOut = customIndicatorSchema.safeParse({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: deep }] });
  assert.equal(deepOut.success, false);
  if (!deepOut.success) assert.match(deepOut.error.issues[0]?.message ?? '', /deeper than 16/);
  assert.ok(performance.now() - started < 200);
  started = performance.now();
  const wideOut = customIndicatorSchema.safeParse({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: ['max', ...new Array(1_000_000).fill(1)] }] });
  assert.equal(wideOut.success, false);
  if (!wideOut.success) assert.match(wideOut.error.issues[0]?.message ?? '', /max takes 2 to 8 arguments, got 1000000/);
  assert.ok(performance.now() - started < 500);
  // The same million, as a file, is over the cap and never parsed.
  const file = drop('wide.json', `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["max",${new Array(1_000_000).fill('1').join(',')}]}]}`);
  assert.match(file.problems[0] ?? '', /cap is 256 KB/);
});

test('a hist offset of 2^53 is refused as a literal and clamped as a parameter', () => {
  for (const n of [2 ** 53, 2 ** 53 + 2, 1e21, 501, -1]) {
    const out = customIndicatorSchema.safeParse({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: ['hist', 'close', n] }] });
    assert.equal(out.success, false, String(n));
    if (!out.success) assert.match(out.error.issues[0]?.message ?? '', /between 0 and 500/);
  }
  const spec = compile({ title: 'T', overlay: true, inputs: { n: { default: 5 } }, plots: [{ title: 'p', expr: ['hist', 'close', 'n'] }, { title: 'q', expr: ['sma', 'close', 'n'] }] }, 'h');
  const cs = candles(30);
  for (const v of [2 ** 53, -(2 ** 53), 1e308, NaN, Infinity, -Infinity, '7', null, {}, [], -0]) {
    const { params } = normaliseParams(spec, { n: v });
    const n = params.n as number;
    assert.ok(Number.isFinite(n) && Math.abs(n) <= 1_000_000, `${String(v)} became ${n}`);
    const result = spec.compute(cs, params);
    assert.equal(result.plots.length, 2);
    assert.doesNotMatch(result.state, /refused/);
    assert.equal(result.plots[0]?.values.length, 30);
  }
  // A param the agent could only reach by lying about the type falls back to the default.
  assert.equal(normaliseParams(spec, { n: NaN }).params.n, 5);
  assert.equal(normaliseParams(spec, { n: Infinity }).params.n, 5);
  // The spec's own hooks take hostile params too.
  assert.equal(spec.label({ n: NaN }), 'T 5');
  assert.equal(spec.warmup?.({ n: Infinity }), 1);
  assert.equal(spec.label(Object.create(null) as Record<string, number>), 'T 5');
});

test('markup and script tags in a title reach the label as text, and the legend never renders HTML', () => {
  const pine = translatePine('//@version=5\nindicator("</script><b>x</b>", overlay=true)\nplot(close, title="<img src=x onerror=alert(1)>")\n');
  assert.equal(pine.ok, true);
  if (!pine.ok) return;
  const spec = compile(pine.indicator, 'evil');
  assert.equal(spec.label({}), '</script><b>x</b>');
  const result = spec.compute(candles(10), {});
  assert.equal(result.plots[0]?.label, '<img src=x onerror=alert(1)>');
  assert.equal(result.plots[0]?.key, 'img-src-x-onerror-alert-1');
  assert.match(result.state, /^<\/script><b>x<\/b> /);
  // The legend is drawn on a canvas, and the chart code has no HTML sink at all. The label
  // reaches the column as a text part (chart.js) and the column types it with fillText (labels.js).
  for (const file of ['chart.js', 'labels.js', 'trade-overlay.js']) {
    const source = fs.readFileSync(path.join(UI, file), 'utf8');
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(source), false, `${file} has an HTML sink`);
  }
  const chart = fs.readFileSync(path.join(UI, 'chart.js'), 'utf8');
  assert.match(chart, /text: labelText\(indicator\.label\)/);
  const labels = fs.readFileSync(path.join(UI, 'labels.js'), 'utf8');
  assert.match(labels, /ctx\.fillText\(parts\[p\]\.text/);
});

test('six plots over 2000 bars compute in under 50 ms, and so does a refusal', () => {
  const scripts: [string, string][] = [
    [
      'bands, macd, rsi, atr',
      `//@version=5\nindicator("T", overlay=false)\nlen = input.int(20, "Length", minval=1)\nmult = input.float(2.0, "Mult")\nbasis = ta.sma(close, len)\ndev = mult * ta.stdev(close, len)\nplot(basis, "Basis")\nplot(basis + dev, "Upper")\nplot(basis - dev, "Lower")\nplot(ta.ema(close, 12) - ta.ema(close, 26), "MACD")\nplot(ta.rsi(close, 14), "RSI")\nplot(ta.atr(14), "ATR")\n`,
    ],
    [
      'six recurrences',
      `//@version=5\nindicator("T", overlay=false)\nvar a = 0.0\na := nz(a[1]) * 0.9 + close\nvar b = 0.0\nb := nz(b[1]) * 0.8 + high\nvar c = 0.0\nc := nz(c[1]) * 0.7 + low\nvar d = 0.0\nd := math.max(nz(d[1]), close)\nvar e = 0.0\ne := math.min(nz(e[1], 1e9), close)\nvar f = 0.0\nf := nz(f[1]) + (close > open ? 1 : -1)\nplot(a, "a")\nplot(b, "b")\nplot(c, "c")\nplot(d, "d")\nplot(e, "e")\nplot(f, "f")\n`,
    ],
    [
      'a recurrence over a wide subtree',
      `//@version=5\nindicator("T", overlay=false)\na = ta.sma(close, 5) + ta.ema(close, 5) + ta.rsi(close, 5) + ta.atr(5) + math.abs(close - open) + hl2\nvar m = 0.0\nm := math.max(nz(m[1]), a)\nvar k = 0.0\nk := math.min(nz(k[1], 1e9), a)\nplot(m, "max")\nplot(k, "min")\nplot(a, "a")\nplot(m - k, "range")\nplot(close, "c")\nplot(hl2, "h")\n`,
    ],
    [
      'six budget refusals',
      `//@version=5\nindicator("T", overlay=false)\nplot(ta.wma(close, 500), "a")\nplot(ta.wma(high, 500), "b")\nplot(ta.wma(low, 500), "c")\nplot(ta.stdev(close, 500), "d")\nplot(ta.wma(hl2, 500), "e")\nplot(ta.stdev(hl2, 500), "f")\n`,
    ],
    [
      'six wma of 160, the budget nearly spent',
      `//@version=5\nindicator("T", overlay=false)\nplot(ta.wma(close, 160), "a")\nplot(ta.wma(high, 160), "b")\nplot(ta.wma(low, 160), "c")\nplot(ta.wma(open, 160), "d")\nplot(ta.wma(hl2, 160), "e")\nplot(ta.wma(hlc3, 160), "f")\n`,
    ],
  ];
  const cs = candles(2000);
  for (const [name, src] of scripts) {
    const out = translatePine(src);
    assert.equal(out.ok, true, `${name}: ${out.ok ? '' : out.message}`);
    if (!out.ok) continue;
    const spec = compile(out.indicator, 'bench');
    const params = normaliseParams(spec, {}).params;
    spec.compute(cs, params);
    const runs = 5;
    const started = performance.now();
    let result = spec.compute(cs, params);
    for (let i = 1; i < runs; i++) result = spec.compute(cs, params);
    const ms = (performance.now() - started) / runs;
    assert.equal(result.plots.length, 6, name);
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms per compute`);
  }
});

test('a slug that is a path, a prototype name or a confusable never resolves, by route or by store', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'sma.json'), JSON.stringify({ title: 'S', overlay: true, inputs: { length: { default: 5, int: true } }, plots: [{ title: 'sma', expr: ['sma', 'close', 'length'] }] }));
  const loader = createCustomIndicators(dir);
  const ctx = { customIndicators: loader } as unknown as Ctx;
  const store = createChartStore('BTC-USD', Date.now, (type) => loader.get(type));
  const division = String.fromCodePoint(0x2215);
  const fullwidth = String.fromCodePoint(0xff0f);
  const cyrillic = String.fromCodePoint(0x0455);
  for (const probe of ['custom:..%2Fsma', 'custom:../sma', `custom:sma${division}x`, `custom:sma${fullwidth}x`, `custom:${cyrillic}ma`, 'custom:sma ', 'custom:sma.json', 'custom:', 'custom:custom:sma', 'custom:constructor', 'custom:__proto__', 'custom:toString', 'custom:sma/../sma']) {
    assert.equal(resolveIndicator(ctx, probe), undefined, JSON.stringify(probe));
    const out = store.addIndicator({ type: probe }, 'agent', null);
    assert.equal(out.ok, false, JSON.stringify(probe));
    if (!out.ok) assert.match(out.error, /^unknown indicator/);
  }
  assert.equal(store.state().indicators.length, 0);
  // Case and surrounding space normalise, which is the same rule the built-ins follow.
  assert.equal(resolveIndicator(ctx, ' CUSTOM:SMA ')?.type, 'custom:sma');
  assert.equal(store.addIndicator({ type: 'CUSTOM:SMA' }, 'agent', null).ok, true);
  assert.equal(store.state().indicators[0]?.type, 'custom:sma');
  // The directory listing is the only source of slugs: nothing was created or read outside it.
  assert.deepEqual(fs.readdirSync(dir), ['sma.json']);
});

test('a var that assigns itself without history still terminates, and the loader survives the whole zoo', () => {
  const self = translatePine(`${HEAD}var a = 0.0\na := a + 1\nplot(a)\n`);
  assert.equal(self.ok, true);
  if (self.ok) {
    const result = compile(self.indicator, 'self').compute(candles(50), {});
    assert.equal(result.plots[0]?.values[49], 50);
  }
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'double.pine'), doubling(30, 'var x = 0.0\nx := LAST + nz(x[1])\nplot(x)\n'));
  fs.writeFileSync(path.join(dir, 'chain.pine'), `${HEAD}x = ${new Array(10_000).fill('close').join(' + ')}\nplot(x[1])\n`);
  fs.writeFileSync(path.join(dir, 'bidi.pine'), `${HEAD}plot(close${RLO})\n`);
  fs.writeFileSync(path.join(dir, 'leak.json'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ title: 'OK', overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] }));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd.json'));
  fs.symlinkSync(path.join(dir, 'loop.pine'), path.join(dir, 'loop.pine'));
  fs.mkdirSync(path.join(dir, 'folder.json'));
  const started = performance.now();
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:ok'],
  );
  assert.equal(problems.length, 6);
  for (const name of ['double', 'chain', 'bidi', 'leak', 'passwd', 'loop', 'folder']) assert.equal(loader.get(name), null, name);
  assert.equal(loader.get('ok')?.type, 'custom:ok');
});

test('a filename that is a path in disguise never becomes a slug, and the folder listing is the only thing read', () => {
  // A name off the disk cannot carry a slash, so a traversal has to hide in what is left: dots,
  // a backslash, an encoded slash, a space, upper case, a second extension. None of them is a
  // slug, every one is a problem that names the rule, and nothing outside the folder is opened.
  const dir = scratch();
  const body = JSON.stringify({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] });
  const names = ['..json', '.json', 'a..b.json', '..\\x.json', 'a%2Fb.json', 'A.json', 'x y.json', 'sma.JSON', '..pine', 'x.tar.json', 'x.json.pine', '~.json', 'a:b.json', `${'x'.repeat(33)}.pine`];
  for (const name of names) fs.writeFileSync(path.join(dir, name), name.endsWith('.pine') ? `${HEAD}plot(close)\n` : body);
  fs.writeFileSync(path.join(dir, 'fine-1.json'), body);
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(specs.map((s) => s.type), ['custom:fine-1']);
  // sma.JSON and .json are not indicator files at all (the extension is case-sensitive, and a
  // dotfile has none), so they are skipped rather than reported; every other name is reported
  // by the slug rule.
  assert.deepEqual(problems.map((p) => p.file).sort(), names.filter((n) => n !== 'sma.JSON' && n !== '.json').sort());
  for (const p of problems) assert.match(p.message, /1 to 32 lower-case letters, digits or dashes/, p.file);
  for (const probe of ['..', '.', '../fine-1', 'a..b', '..\\x', 'a%2Fb', 'A', 'x y', 'x.tar', 'custom:..', 'custom:../fine-1', 'fine-1/../fine-1']) {
    assert.equal(loader.get(probe), null, probe);
  }
  assert.equal(loader.get('fine-1')?.type, 'custom:fine-1');
  assert.deepEqual(fs.readdirSync(dir).length, names.length + 1, 'nothing was created');
});

test('a 100 KB title is refused in a sentence that does not carry it, in both formats', () => {
  const title = 'T'.repeat(100 * 1024);
  const json = drop('title.json', JSON.stringify({ title, overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] }));
  assert.equal(json.spec, null);
  assert.match(json.problems[0] ?? '', /title must be at most 64 characters/);
  assert.ok((json.problems[0] ?? '').length < 120, `${(json.problems[0] ?? '').length} characters`);
  const pine = drop('title.pine', `//@version=5\nindicator("${title}")\nplot(close)\n`);
  assert.equal(pine.spec, null);
  assert.ok((pine.problems[0] ?? '').length < 120, `${(pine.problems[0] ?? '').length} characters`);
  assert.ok(!(pine.problems[0] ?? '').includes('TTTTTTTT'), pine.problems[0]);
  // The same size on a plot title and an input title.
  const plotTitle = drop('plot.json', JSON.stringify({ title: 'T', overlay: true, inputs: {}, plots: [{ title, expr: 'close' }] }));
  assert.equal(plotTitle.spec, null);
  assert.ok((plotTitle.problems[0] ?? '').length < 120);
  const inputTitle = drop('input.json', JSON.stringify({ title: 'T', overlay: true, inputs: { n: { default: 5, title } }, plots: [{ title: 'p', expr: 'close' }] }));
  assert.equal(inputTitle.spec, null);
  assert.ok((inputTitle.problems[0] ?? '').length < 120);
});

test('a thousand plots are refused by count, quickly, in both formats', () => {
  const plots = Array.from({ length: 1000 }, (_, i) => ({ title: `p${i}`, expr: ['sma', 'close', 5] }));
  const started = performance.now();
  const json = drop('plots.json', JSON.stringify({ title: 'T', overlay: true, inputs: {}, plots }));
  assert.equal(json.spec, null);
  assert.match(json.problems[0] ?? '', /plots: at most 6 plots/);
  assert.ok(performance.now() - started < 500, `${Math.round(performance.now() - started)} ms`);
  const again = performance.now();
  const pine = translatePine(`${HEAD}${'plot(ta.sma(close, 5))\n'.repeat(1000)}`);
  assert.equal(pine.ok, false);
  if (!pine.ok) {
    assert.equal(pine.line, 9);
    assert.match(pine.message, /at most 6 plots/);
  }
  assert.ok(performance.now() - again < 500);
});

test('a log of a negative number and a root of one are na, in both formats, and NaN or Infinity in a literal never loads', () => {
  const json = drop('neg.json', JSON.stringify({ title: 'T', overlay: true, inputs: {}, plots: [{ title: 'l', expr: ['log', ['-', 0, 'close']] }, { title: 's', expr: ['sqrt', ['-', 0, 'close']] }, { title: 'z', expr: ['log', 0] }, { title: 'm', expr: ['%', 'close', 0] }] }));
  assert.ok(json.spec, json.problems.join('; '));
  const result = json.spec.compute(candles(40), {});
  for (const plot of result.plots) assert.ok(plot.values.every((v) => v === null), plot.key);
  assert.doesNotMatch(result.state, /refused|NaN|Infinity/);
  const pine = drop('neg.pine', `${HEAD}plot(math.log(-close))\nplot(math.sqrt(-close))\nplot(math.log(close - close))\n`);
  assert.ok(pine.spec, pine.problems.join('; '));
  const viaPine = pine.spec.compute(candles(40), {});
  for (const plot of viaPine.plots) assert.ok(plot.values.every((v) => v === null), plot.key);
  // A literal that is not a finite number is refused where it stands, not carried into a plot.
  for (const literal of ['1e999', '-1e999', 'NaN', 'Infinity']) {
    const out = drop('lit.json', `{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":["+","close",${literal}]}]}`);
    assert.equal(out.spec, null, literal);
  }
  for (const line of ['plot(close + 1e999)', 'plot(close / 0.0)', 'plot(math.log(-1))']) {
    const out = drop('lit.pine', `${HEAD}${line}\n`);
    if (out.spec !== null) {
      const r = out.spec.compute(candles(10), {});
      assert.ok(r.plots[0]?.values.every((v) => v === null || Number.isFinite(v)), line);
    }
  }
});

test('the whole zoo behind the real server: every write and read over it answers, and no file byte reaches a reply', async () => {
  const secret = 'SECRET_PRIVATE_KEY=0xdeadbeefcafe';
  const h = await bootChartServer({
    indicators: {
      'evil.pine': '//@version=5\nindicator("</script><b>x</b>", overlay=true)\nplot(close, title="<img src=x onerror=alert(1)>")\n',
      'heavy.pine': `${HEAD}plot(ta.wma(ta.wma(ta.wma(ta.wma(ta.wma(ta.wma(close, 500), 500), 500), 500), 500), 500))\n`,
      'double.pine': doubling(30, 'var x = 0.0\nx := LAST + nz(x[1])\nplot(x)\n'),
      'chain.pine': `${HEAD}x = ${new Array(10_000).fill('close').join(' + ')}\nplot(x[1])\n`,
      'bidi.pine': `${HEAD}plot(close${RLO})\n`,
      'leak.json': secret,
      'big.json': Buffer.alloc(300 * 1024, 0x20),
      'title.json': JSON.stringify({ title: 'T'.repeat(100_000), overlay: true, inputs: {}, plots: [{ title: 'p', expr: 'close' }] }),
      'nan.json': '{"title":"T","overlay":true,"inputs":{},"plots":[{"title":"p","expr":NaN}]}',
      'proto.json': '{"title":"T","overlay":true,"inputs":{"__proto__":{"default":1}},"plots":[{"title":"p","expr":"close"}]}',
      'ok.json': JSON.stringify({ title: 'OK', overlay: false, inputs: { n: { default: 5, int: true } }, plots: [{ title: 'p', expr: ['sma', 'close', 'n'] }] }),
    },
  });
  try {
    const replies: string[] = [];
    const keep = (r: { status: number; json: unknown }): { status: number; json: any } => {
      replies.push(JSON.stringify(r.json));
      return r as { status: number; json: any };
    };
    const list = keep(await h.mcp({ op: 'read', tool: 'chart_batch', session: 'a', args: { ops: [{ op: 'indicator_list' }] } }));
    assert.equal(list.status, 200, JSON.stringify(list.json).slice(0, 200));
    const types = JSON.stringify(list.json).match(/custom:[a-z0-9-]+/g) ?? [];
    assert.deepEqual([...new Set(types)].sort(), ['custom:evil', 'custom:heavy', 'custom:ok'], 'only the three that load are listed');
    const set = keep(await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { set: [{ type: 'custom:evil' }, { type: 'custom:heavy' }, { type: 'custom:ok', params: { n: Number.MAX_SAFE_INTEGER } }, { type: 'custom:leak' }, { type: 'custom:double' }, { type: 'custom:proto' }] } } }));
    assert.equal(set.status, 200, JSON.stringify(set.json).slice(0, 200));
    assert.equal(set.json.indicators.length, 3);
    assert.equal(set.json.refused.length, 3);
    for (const r of set.json.refused as string[]) assert.match(r, /^unknown indicator: custom:/);
    const payload = keep(await h.get('/api/chart'));
    assert.equal(payload.status, 200);
    assert.equal(payload.json.indicators.length, 3);
    const byType = new Map((payload.json.indicators as { type: string; state?: string; label?: string; plots?: { label: string }[] }[]).map((i) => [i.type, i]));
    assert.match(String(byType.get('custom:heavy')?.state ?? ''), /refused, work budget/);
    assert.equal(byType.get('custom:evil')?.plots?.[0]?.label, '<img src=x onerror=alert(1)>', 'the markup is a label, and the window draws labels as text');
    const read = keep(await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: { full: true } }));
    assert.equal(read.status, 200);
    const compact = keep(await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: {} }));
    assert.equal(compact.status, 200);
    const scan = keep(await h.mcp({ op: 'read', tool: 'chart_scan', session: 'a', args: { timeframes: ['1h'] } }));
    assert.equal(scan.status, 200);
    for (const reply of replies) {
      for (const leak of ['SECRET', 'deadbeefcafe', 'TTTTTTTTTT', '__proto__']) assert.ok(!reply.includes(leak), `${leak} reached a reply: ${reply.slice(0, 200)}`);
    }
  } finally {
    await h.close();
  }
});
