// The loader over <dataDir>/indicators: the slug rule, the mtime gate, the problems list, and
// the one property that matters most, which is that nothing an agent sends ever becomes a
// path. A slug is looked up in a map built from a directory listing, and that is all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createCustomIndicators, FILE_CAP_BYTES, SLUG_RE } from '../../src/indicators-custom/loader.ts';
import { tempDir } from './helpers/tmp.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'indicators');

function scratch(): string {
  return tempDir('phosphor-indicators-');
}

function copy(dir: string, ...names: string[]): void {
  for (const name of names) fs.copyFileSync(path.join(FIXTURES, name), path.join(dir, name));
}

function sma(length: number): string {
  return JSON.stringify({
    title: 'S',
    overlay: true,
    inputs: { length: { default: length, int: true } },
    plots: [{ title: 'sma', expr: ['sma', 'close', 'length'] }],
  });
}

// Touch the file's clock forward so an edit inside the same millisecond still reads as new.
function bump(file: string, seconds: number): void {
  const t = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(file, t, t);
}

test('a missing directory is an empty catalogue, not an error', () => {
  const loader = createCustomIndicators(path.join(scratch(), 'nowhere'));
  assert.deepEqual(loader.refresh(), { specs: [], problems: [] });
  assert.equal(loader.get('sma'), null);
});

test('json and pine files load as custom:<slug> specs, in slug order', () => {
  const dir = scratch();
  copy(dir, 'sma.json', 'rsi.json', 'ma-cross.pine', 'running-max.pine');
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:ma-cross', 'custom:rsi', 'custom:running-max', 'custom:sma'],
  );
  assert.equal(problems.length, 1, 'the plotshape note is the only problem');
  assert.match(problems[0]?.message ?? '', /^ignored: plotshape/);
  assert.equal(problems[0]?.file, 'ma-cross.pine');
  assert.equal(loader.get('sma')?.type, 'custom:sma');
  assert.equal(loader.get('custom:sma')?.type, 'custom:sma');
  assert.equal(loader.get('ma-cross')?.pane, 'price');
  assert.equal(loader.get('rsi')?.pane, 'own');
});

test('the slug is the filename and only a safe filename', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'ok-1.json'), sma(5));
  fs.writeFileSync(path.join(dir, 'Bad_Name.json'), sma(5));
  fs.writeFileSync(path.join(dir, 'a b.json'), sma(5));
  fs.writeFileSync(path.join(dir, `${'x'.repeat(33)}.json`), sma(5));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an indicator');
  fs.mkdirSync(path.join(dir, 'folder.json'));
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:ok-1'],
  );
  assert.equal(problems.length, 3);
  for (const p of problems) assert.match(p.message, /letters, digits or dashes/);
  assert.ok(SLUG_RE.test('ok-1'));
  assert.ok(!SLUG_RE.test('Bad_Name'));
});

test('get is a map lookup: no prefix trick, no path, no case folding', () => {
  const dir = scratch();
  copy(dir, 'sma.json');
  const loader = createCustomIndicators(dir);
  loader.refresh();
  for (const probe of ['SMA', 'sma.json', '../sma', './sma', 'sma/', '', 'custom:', 'custom:../sma', '..', 'sma\u0000']) {
    assert.equal(loader.get(probe), null, `${JSON.stringify(probe)} must not resolve`);
  }
});

test('two files with one slug: the first in listing order wins and the other is reported', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'dup.json'), sma(5));
  copy(dir, 'ma-cross.pine');
  fs.renameSync(path.join(dir, 'ma-cross.pine'), path.join(dir, 'dup.pine'));
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:dup'],
  );
  assert.equal(loader.get('dup')?.summary.includes('S'), true);
  assert.ok(problems.some((p) => p.file === 'dup.pine' && /already taken by dup\.json/.test(p.message)));
});

test('a broken file is a problem with the file and line, and the good ones still load', () => {
  const dir = scratch();
  copy(dir, 'sma.json', 'for-loop.pine', 'security.pine');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ title: 'W', overlay: true, inputs: {}, plots: [{ title: 'p', expr: ['cum', 'close'] }] }));
  const loader = createCustomIndicators(dir);
  const { specs, problems } = loader.refresh();
  assert.deepEqual(
    specs.map((s) => s.type),
    ['custom:sma'],
  );
  const byFile = new Map(problems.map((p) => [p.file, p]));
  assert.match(byFile.get('broken.json')?.message ?? '', /JSON/);
  assert.match(byFile.get('wrong.json')?.message ?? '', /unknown op 'cum'/);
  assert.equal(byFile.get('for-loop.pine')?.line, 4);
  assert.match(byFile.get('for-loop.pine')?.message ?? '', /for/);
  assert.equal(byFile.get('security.pine')?.line, 3);
});

test('refresh is gated on mtime: an untouched file is not re-read, an edited one is', () => {
  const dir = scratch();
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, sma(5));
  const loader = createCustomIndicators(dir);
  const first = loader.refresh().specs[0];
  assert.ok(first);
  assert.equal(first.params[0]?.def, 5);
  const again = loader.refresh().specs[0];
  assert.equal(again, first, 'same spec object: the file was not parsed again');

  fs.writeFileSync(file, sma(10));
  bump(file, 10);
  const edited = loader.refresh().specs[0];
  assert.ok(edited);
  assert.notEqual(edited, first);
  assert.equal(edited.params[0]?.def, 10);
  assert.equal(loader.get('x'), edited);

  fs.unlinkSync(file);
  assert.deepEqual(loader.refresh().specs, []);
  assert.equal(loader.get('x'), null);
});

test('a broken file that has not changed keeps reporting its problem without a re-parse', () => {
  const dir = scratch();
  const file = path.join(dir, 'b.json');
  fs.writeFileSync(file, '{ not json');
  const loader = createCustomIndicators(dir);
  const a = loader.refresh().problems[0];
  const b = loader.refresh().problems[0];
  assert.ok(a);
  assert.equal(b, a, 'same problem object: no re-parse');
  fs.writeFileSync(file, sma(3));
  bump(file, 10);
  assert.deepEqual(loader.refresh().problems, []);
  assert.equal(loader.get('b')?.type, 'custom:b');
});

test('a file dropped in after the last scan is found by get, once the rescan gap has passed', () => {
  const dir = scratch();
  let clock = 1_000_000;
  const loader = createCustomIndicators(dir, () => clock);
  assert.equal(loader.get('late'), null);
  fs.writeFileSync(path.join(dir, 'late.json'), sma(4));
  // Inside the gap a miss stays a miss: a chart holding a deleted type asks on every render.
  clock += 500;
  assert.equal(loader.get('late'), null);
  clock += 2000;
  assert.equal(loader.get('late')?.type, 'custom:late');
});

test('a file over the cap is refused on its size alone, before it is read', () => {
  const dir = scratch();
  const file = path.join(dir, 'huge.json');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 10 * 1024 * 1024);
  fs.closeSync(fd);
  const loader = createCustomIndicators(dir);
  const started = Date.now();
  const { specs, problems } = loader.refresh();
  assert.ok(Date.now() - started < 200);
  assert.deepEqual(specs, []);
  assert.match(problems[0]?.message ?? '', /cap/);
  assert.ok(FILE_CAP_BYTES <= 1024 * 1024);
});

test('specs() lists what the last scan compiled and nothing that failed', () => {
  const dir = scratch();
  copy(dir, 'atr.json', 'for-loop.pine');
  const loader = createCustomIndicators(dir);
  assert.deepEqual(
    loader.specs().map((s) => s.type),
    ['custom:atr'],
  );
});
