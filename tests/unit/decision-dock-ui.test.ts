// The decision dock's trust boundary.
//
// The dock is the one place in the window where a click moves money, and it is
// drawn from the server's pending list and from nothing else. Three properties
// keep that true and none of them is a tidiness preference:
//
//   1. Nothing reaches the DOM as markup, so a draft field carrying a tag
//      cannot draw over the card that is asking about it.
//   2. The dock builds four buttons and they are named here. A fifth is either
//      a control somebody added to a card the assistant can influence, or a
//      second way out of a decision, and both are the thing being prevented.
//   3. No key dismisses it. The overlay had an Escape handler back when it was a
//      modal; the dock is a region inside the conversation, and the only ways
//      out of a pending ask are No and Yes.
//
// The policy diff logic lives in the same file and is asserted separately in
// tests/unit/approvals-diff.test.ts, so this file only checks it still exports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/screens/decision.js', import.meta.url), 'utf8');

type Sandbox = Record<string, any>;

/* The dock is a browser script that assigns one global. Running it against a
   stub window makes that global the test surface, the same way
   tests/unit/agent-panel-ui.test.ts reaches the conversation column. */
function load(): Sandbox {
  const sandbox: Sandbox = {
    window: {
      PhosphorDom: { on: () => {}, el: () => ({}), clear: () => {}, setHidden: () => {} },
      PhosphorNet: {},
      PhosphorApi: {},
      PhosphorState: { select: () => {}, get: () => ({}) },
    },
    document: { createElement: () => ({}), getElementById: () => null, addEventListener: () => {} },
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  return sandbox.window.PhosphorDecision;
}

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'decision.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});

test('the dock builds four buttons and they are named', () => {
  const labels = SOURCE.match(/'btn-label', '([^']+)'/g) ?? [];
  const allowed = ['No', 'Yes', 'Unlock', 'Reconcile'];
  assert.ok(labels.length > 0, 'the dock builds no buttons at all, so this test is not looking at it');
  for (const raw of labels) {
    const label = raw.replace(/^.*, '/, '').replace(/'$/, '');
    assert.ok(allowed.includes(label), `the dock built a button labelled "${label}"`);
  }
});

test('no key dismisses a decision', () => {
  // The dock is a region, not a modal. Escape closing it would be a way out of a
  // pending ask that is neither No nor Yes, and the person would not know which
  // one the server recorded.
  assert.equal(/'keydown'|"keydown"/.test(SOURCE), false, 'the dock listens for a key');
  assert.equal(/aria-modal/.test(SOURCE), false, 'the dock still calls itself a modal');
});

test('the card is drawn from the server and never from a frame', () => {
  // Every field on the card comes off the proposal the server sent. A dock that
  // read a driver frame would let the thing being approved write its own ask.
  assert.equal(/PhosphorEvents/.test(SOURCE), false, 'the dock subscribes to driver frames');
  assert.ok(SOURCE.includes("select('proposals'"), 'the dock does not read the proposals slice');
});

test('the policy diff still exports', () => {
  const decision = load();
  assert.equal(typeof decision.diffOf, 'function');
  assert.equal(typeof decision.refineDiff, 'function');
  const diff = decision.diffOf(['a: one, two.'], ['a: one, two, three.']);
  assert.equal(diff.added.length, 1);
  assert.equal(decision.refineDiff(diff).length, 1);
});
