// The catalog exists to stop an agent guessing at the mandate grammar. An example in it that
// does not parse is worse than no example: it is a confident wrong answer handed to something
// that will act on it. So every example is run through the real validator here, and the
// envelope each one suggests is checked against the program it belongs to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EXAMPLES, buildMandateCatalog } from '../../src/strategy/catalog.ts';
import { validateProgram, actionVerbs, programHash } from '../../src/strategy/grammar.ts';

test('every catalogue example is a program the grammar actually accepts', () => {
  for (const example of EXAMPLES) {
    const result = validateProgram(example.program);
    assert.equal(result.ok, true, `"${example.intent}" failed to parse: ${result.ok ? '' : result.errors.join('; ')}`);
  }
});

// The trap the catalogue warns about, held to on the catalogue's own examples. allowedActions
// is derived from the verbs the rules use, and checkEnvelope refuses any verb outside it, so
// an example whose suggested envelope omits a verb its program uses would arm a bot that
// cannot perform its own exit.
test('every example suggests an envelope that covers the verbs its program uses', () => {
  for (const example of EXAMPLES) {
    const result = validateProgram(example.program);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const used = actionVerbs(result.program);
    const allowed = example.envelope.allowedActions as string[];
    for (const verb of used) {
      assert.ok(allowed.includes(verb), `"${example.intent}" uses ${verb} but its envelope does not allow it`);
    }
  }
});

test('every example that can open can also get flat', () => {
  for (const example of EXAMPLES) {
    const result = validateProgram(example.program);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const verbs = actionVerbs(result.program);
    if (!verbs.includes('open') && !verbs.includes('add')) continue;
    assert.ok(
      verbs.includes('close') || verbs.includes('reduce'),
      `"${example.intent}" can open a position and has no way to close one`,
    );
  }
});

test('the example envelopes never exceed the size the program asks for', () => {
  for (const example of EXAMPLES) {
    const result = validateProgram(example.program);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const maxNotional = Number(example.envelope.maxNotionalUsd);
    const maxLeverage = Number(example.envelope.maxLeverage);
    for (const rule of result.program.rules) {
      for (const action of rule.then) {
        if (action.do === 'open') {
          assert.ok(
            action.sizeUsd <= maxNotional,
            `"${example.intent}" opens ${action.sizeUsd} against a cap of ${maxNotional}`,
          );
          assert.ok(
            action.leverage <= maxLeverage,
            `"${example.intent}" opens at ${action.leverage}x against a cap of ${maxLeverage}x`,
          );
        }
      }
    }
  }
});

test('the catalogue names every condition and action the grammar has, so nothing is undiscoverable', () => {
  const catalog = buildMandateCatalog();
  const documentedConditions = new Set(catalog.conditions.map((c) => c.op));
  const documentedActions = new Set(catalog.actions.map((a) => a.do));

  // Taken from the type unions in grammar.ts. If a verb is added there and not here, an agent
  // reading the catalogue would never learn it exists, which is the failure this file prevents.
  for (const op of [
    'price_above',
    'price_below',
    'price_cross_up',
    'price_cross_down',
    'bar_close',
    'position',
    'pnl_pct',
    'elapsed',
    'and',
    'or',
    'not',
  ]) {
    assert.ok(documentedConditions.has(op), `condition ${op} exists in the grammar and is not in the catalogue`);
  }
  for (const verb of ['open', 'add', 'reduce', 'close', 'set_stop', 'set_target', 'cancel', 'stand_down', 'notify']) {
    assert.ok(documentedActions.has(verb), `action ${verb} exists in the grammar and is not in the catalogue`);
  }
});

test('an example hashes stably, which is what a mandate binds to', () => {
  const result = validateProgram(EXAMPLES[0].program);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(programHash(result.program), programHash(result.program));
});
