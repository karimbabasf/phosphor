// The two pieces that turn a roster into a team: the board they write on, and the study
// packages that stop a shared chart from silently filling up.
//
// The board's job is small and its rules are not: everything on it is written by an agent, so
// it is data, it is capped, and it is rendered as text. The tests here are about the caps and
// the stamping; that a post cannot authorise anything is a property of there being no code
// anywhere that reads one, which is asserted by its absence rather than by a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoard } from '../../src/board.ts';
import { PRESETS, findPreset, presetCatalog } from '../../src/presets.ts';
import { indicatorSpec } from '../../src/indicators.ts';
import type { ParamSpec } from '../../src/indicators.ts';

test('a post is stamped with who wrote it and what kind of line it is', () => {
  const board = createBoard(() => 1_700_000_000_000);
  const post = board.post({ session: 's1', label: 'four hour', role: 'analyst', kind: 'claim', text: 'taking SOL 4h' });
  assert.equal(post.id, 1);
  assert.equal(post.session, 's1');
  assert.equal(post.label, 'four hour');
  assert.equal(post.role, 'analyst');
  assert.equal(post.kind, 'claim');
  assert.equal(post.text, 'taking SOL 4h');
  assert.equal(post.at, new Date(1_700_000_000_000).toISOString());
});

test('an unknown kind becomes a note rather than being invented', () => {
  const board = createBoard();
  assert.equal(board.post({ session: 's', label: 'l', role: 'operator', kind: 'order', text: 'x' }).kind, 'note');
});

test('post text is capped and stripped of control characters', () => {
  const board = createBoard();
  const post = board.post({ session: 's', label: 'l', role: 'operator', text: 'x'.repeat(500) + '\nsecond line' });
  assert.equal(post.text.length, 240);
  assert.equal(/[\u0000-\u001f]/.test(post.text), false);
});

test('a post with nothing in it says so instead of being empty', () => {
  const board = createBoard();
  assert.equal(board.post({ session: 's', label: 'l', role: 'operator', text: 42 }).text, '(empty)');
});

test('the board is a ring, so a busy team cannot fill anyone context window', () => {
  const board = createBoard();
  for (let i = 0; i < 200; i++) board.post({ session: 's', label: 'l', role: 'operator', text: `line ${i}` });
  assert.ok(board.count() <= 60);
  assert.equal(board.list(5).length, 5);
  assert.equal(board.list(5)[4]?.text, 'line 199', 'the newest is the last one listed');
});

test('since() returns only what is new, which is how an agent catches up cheaply', () => {
  const board = createBoard();
  const first = board.post({ session: 's', label: 'l', role: 'operator', text: 'one' });
  board.post({ session: 's', label: 'l', role: 'operator', text: 'two' });
  board.post({ session: 's', label: 'l', role: 'operator', text: 'three' });
  assert.deepEqual(
    board.since(first.id).map((p) => p.text),
    ['two', 'three'],
  );
});

// ---------- study packages ----------

test('every preset names indicators that actually exist', () => {
  // A preset naming a type the catalogue does not have fails at the last moment, on a human's
  // chart, as a package that half applied.
  for (const preset of PRESETS) {
    for (const want of preset.indicators) {
      assert.ok(indicatorSpec(want.type), `preset ${preset.name} names ${want.type}, which is not an indicator`);
    }
  }
});

test('no preset asks for more sub-panes than the chart allows', () => {
  // Three is the cap in src/chart.ts, and a package that could not fit would be a package that
  // reports a failure every time it is used.
  for (const preset of PRESETS) {
    const panes = preset.indicators.filter((i) => indicatorSpec(i.type)?.pane === 'own').length;
    assert.ok(panes <= 3, `preset ${preset.name} wants ${panes} sub-panes`);
    const overlays = preset.indicators.filter((i) => indicatorSpec(i.type)?.pane === 'price').length;
    assert.ok(overlays <= 8, `preset ${preset.name} wants ${overlays} overlays`);
  }
});

test('preset parameters are inside the ranges their indicator declares', () => {
  for (const preset of PRESETS) {
    for (const want of preset.indicators) {
      const spec = indicatorSpec(want.type);
      assert.ok(spec);
      for (const [name, value] of Object.entries(want.params ?? {})) {
        // Annotated, because assert.ok() narrows it and TypeScript cannot infer a type it is
        // narrowing at the same time.
        const param: ParamSpec | undefined = spec.params.find((entry) => entry.name === name);
        assert.ok(param, `preset ${preset.name} sets ${want.type}.${name}, which is not a parameter`);
        assert.ok(value >= param.min && value <= param.max, `${preset.name}: ${want.type}.${name} is out of range`);
      }
    }
  }
});

test('clean is the empty package, so applying it is the tidy and nothing else', () => {
  const clean = findPreset('clean');
  assert.ok(clean);
  assert.deepEqual(clean.indicators, []);
});

test('a preset is found by name however it is cased, and an unknown one is not invented', () => {
  assert.equal(findPreset('WAVE')?.name, 'wave');
  assert.equal(findPreset('  trend  ')?.name, 'trend');
  assert.equal(findPreset('marketcipher'), undefined);
  assert.equal(findPreset(undefined), undefined);
});

test('the catalogue lists what each package draws, so a list is enough to choose from', () => {
  const listed = presetCatalog() as { name: string; summary: string; draws: string[] }[];
  assert.equal(listed.length, PRESETS.length);
  for (const entry of listed) {
    assert.ok(entry.summary.length > 20, `${entry.name} has no useful summary`);
    assert.ok(Array.isArray(entry.draws));
  }
});

test('no preset summary tells anybody what to do with it', () => {
  /* A package is a set of studies to look at, not a way to trade. The words below are the ones
     that would turn it into the second thing.
     `long` and `short` are deliberately NOT banned on their own: "how long the squeeze has
     lasted" and "a short timeframe" are ordinary English, and a test that failed on them would
     be enforcing a vocabulary rather than the rule. The trade sense of them is `go long`. */
  const banned = /\b(buy|sell|bullish|bearish|profit|strategy|go (long|short))\b/i;
  for (const preset of PRESETS) {
    assert.doesNotMatch(preset.summary, banned, `preset ${preset.name} describes a strategy`);
  }
});
