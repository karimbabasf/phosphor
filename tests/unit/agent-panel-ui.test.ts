// The assistant panel's trust boundary.
//
// The panel renders whatever a language model writes. Two properties keep that
// safe and neither is a tidiness preference: nothing the assistant says may
// reach the DOM as markup, and the panel may not build a control that decides
// anything. An approval is a physical click on a surface the assistant cannot
// draw, and a transcript that could draw one would move that surface.
//
// The old four-phase panel and its globe are gone. These two properties came
// with the component to ui/screens/agent.js, so they are asserted there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/screens/agent.js', import.meta.url), 'utf8');

type Sandbox = Record<string, any>;

/* The panel is a browser script that assigns one global. Running it against a
   stub window makes that global the test surface. Nothing here touches a real
   DOM: the assertions are about the source and about the phrase table. */
function load(): Sandbox {
  const sandbox: Sandbox = {
    window: {
      PhosphorDom: { on: () => {}, el: () => ({}), clear: () => {} },
      PhosphorNet: {},
      PhosphorApi: { driverState: () => Promise.resolve({ data: {} }), connection: () => Promise.resolve({}) },
      PhosphorEvents: { on: () => {} },
      setTimeout: () => 0,
    },
    document: { createElement: () => ({}), addEventListener: () => {} },
    navigator: {},
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/agent.js' });
  return sandbox.window.PhosphorAgent;
}

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'agent.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});

test('the panel builds no control that decides anything', () => {
  // The panel's own buttons, named. A button this list does not know about is a
  // button somebody added to a transcript, which is the thing being prevented.
  const labels = SOURCE.match(/'btn-label', '([^']+)'/g) ?? [];
  const allowed = ['Start your assistant', 'Stop the answer', 'Stop', 'Connect your own', 'Copy', 'Send'];
  assert.ok(labels.length > 0, 'the panel builds no buttons at all, so this test is not looking at it');
  for (const raw of labels) {
    const label = raw.replace(/^.*, '/, '').replace(/'$/, '');
    assert.ok(allowed.includes(label), `the panel built a button labelled "${label}"`);
  }
  assert.equal(/\bapprove\b|\brefuse\b/i.test(SOURCE), false, 'the panel names an approval route');
});

test('the column never reaches for the beam itself', () => {
  // The step row dispatches phosphor:step and ui/beam/trace.js decides what
  // lights up. Wiring the column straight to the beam would make the transcript
  // stop working the day the beam file is not there, and the transcript is the
  // half a person cannot do without.
  assert.ok(SOURCE.includes('phosphor:step'), 'the column dispatches no step event');
  assert.equal(SOURCE.includes('PhosphorBeam'), false, 'the column calls the beam directly');
});

test('the phase is readable before a frame has arrived', () => {
  // shell.js draws the wordmark glyph from this and runs before the driver has
  // said anything, so a phase that only existed after the first frame would
  // leave the glyph undrawn on every cold window.
  const agent = load();
  assert.equal(typeof agent.phase, 'function');
  assert.equal(agent.phase(), 'idle');
});

test('a tool that only asks never reads as a tool that did it', () => {
  const agent = load();
  // The propose and do pairs are deliberately one word apart, because that word
  // is the entire difference between asking and moving money.
  assert.equal(agent.toolLabel('propose_swap'), 'asking to swap');
  assert.equal(agent.toolLabel('swap'), 'swapping');
  assert.equal(agent.toolLabel('propose_intents_withdraw'), 'asking to withdraw');
  assert.equal(agent.toolLabel('intents_withdraw'), 'withdrawing');
  assert.equal(agent.toolLabel('propose_mandate'), 'asking to arm a mandate');
  assert.equal(agent.toolLabel('mandate_arm'), 'arming a mandate');
  assert.equal(agent.toolLabel('propose_yield_deposit'), 'asking to put money to work');
  assert.equal(agent.toolLabel('propose_policy_change'), 'asking to change a rule');
});

test('every tool the server offers has a phrase, not an id', () => {
  // A step row printing `gas_report` is the window handing a person the tool
  // surface instead of the answer, and the table is the only place that fixes it.
  const agent = load();
  assert.equal(agent.toolLabel('gas_report'), 'checking gas');
  assert.equal(agent.toolLabel('set_theme'), 'recolouring the window');
});

test('the one tool that leaves this machine says so', () => {
  const agent = load();
  assert.equal(agent.toolLabel('research'), 'reading the news');
});

test('the server prefix is stripped and an unknown tool prints its own name', () => {
  const agent = load();
  assert.equal(agent.toolLabel('mcp__phosphor__wallet'), 'reading your wallet');
  assert.equal(agent.toolLabel('some_new_tool'), 'some_new_tool');
});

test('a tool id that names an Object member does not print a function', () => {
  // The id arrives from a language model, and a lookup on a plain object hands
  // back Object.prototype's own members for ids like `constructor`.
  const agent = load();
  assert.equal(agent.toolLabel('constructor'), 'constructor');
  assert.equal(agent.toolLabel('toString'), 'toString');
  assert.equal(agent.toolLabel('hasOwnProperty'), 'hasOwnProperty');
});
