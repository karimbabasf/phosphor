// The button inventory's scan (scripts/button-inventory/scan.ts), held to the window it reads.
//
// The sheet needs a browser; the scan does not, and it is the half a rewrite of a screen bends
// first: a new class string is a new family, and a family the recipes do not know is a button
// the sheet never photographs. So every family the scan finds has a recipe, every .btn family
// has a rule for each of its five states, and the sites the floor was written against are
// still where the scan says they are.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES } from '../../scripts/button-inventory/recipes.ts';
import { families, scan } from '../../scripts/button-inventory/scan.ts';

const sites = scan();
const list = families(sites);
const literal = (family: string): boolean => /^[a-z][\w -]*$/.test(family);

test('the scan reads the whole window: index.html, the screens and the shell scripts', () => {
  const files = new Set(sites.map((s) => s.file));
  for (const file of ['ui/index.html', 'ui/split.js', 'ui/screens/decision.js', 'ui/screens/firstrun.js', 'ui/screens/vault.js', 'ui/screens/netpick.js']) {
    assert.ok(files.has(file), `no button found in ${file}`);
  }
  assert.ok(sites.length >= 100, `${sites.length} sites: the scan lost most of the window`);
});

test('every family the scan finds has a recipe, so the sheet photographs it', () => {
  const known = new Set(RECIPES.map((r) => r.family));
  const missing = list.filter((f) => literal(f.family) && !known.has(f.family)).map((f) => f.family);
  assert.deepEqual(missing, [], `families without a recipe in scripts/button-inventory/recipes.ts: ${missing.join(', ')}`);
});

test('every recipe still names a family the window builds', () => {
  const built = new Set(list.map((f) => f.family));
  const stale = RECIPES.filter((r) => !built.has(r.family)).map((r) => r.family);
  assert.deepEqual(stale, [], `recipes for buttons nothing builds: ${stale.join(', ')}`);
});

test('every .btn family has a rule for each of its five states', () => {
  for (const f of list) {
    if (!/(^|\s)btn(\s|$)/.test(f.family)) continue;
    for (const state of ['hover', 'active', 'disabled', 'focus', 'pending']) {
      assert.notEqual(f.states[state], '', `${f.family}: no rule draws the ${state} state`);
    }
  }
});

test('the helpers are read at their call sites, never at their definition', () => {
  assert.ok(!list.some((f) => f.family === 'className'), 'agent.js button(className, ...) was read as a family');
  assert.ok(!list.some((f) => /kind \|\| 'btn-ghost'/.test(f.family)), 'the netpick and vault helpers were read as a family');
  const yes = sites.find((s) => s.file === 'ui/screens/decision.js' && s.pending === 'Approving');
  assert.ok(yes, 'the dock\'s Yes was not found');
  assert.equal(yes?.family, 'btn btn-primary');
  const more = sites.find((s) => s.file === 'ui/screens/receipts.js' && s.label === '"See all"');
  assert.equal(more?.family, 'btn btn-ghost activity-more', 'receipts.js button() builds a fixed class, and the call site wears it');
});

test('the one button index.html builds is the small freeze with its verb', () => {
  const freeze = sites.find((s) => s.file === 'ui/index.html' && /freeze/.test(s.family));
  assert.equal(freeze?.family, 'btn btn-sm freeze');
  assert.equal(freeze?.label, '"Freeze everything"');
});

test('the three hook classes are on the buttons that carry them', () => {
  const hooks = new Map(list.map((f) => [f.family, f.sites.map((s) => `${s.file}:${s.line}`)]));
  assert.ok(hooks.has('check-row layers-row'), 'the check row lost its hook');
  assert.ok(hooks.has('btn btn-ghost btn-sm tcard-open'));
  assert.ok(hooks.has('btn btn-quiet btn-sm sendcard-copy'));
});
