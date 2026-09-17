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
const MARKDOWN = readFileSync(new URL('../../ui/core/markdown.js', import.meta.url), 'utf8');

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
      PhosphorIcons: { svg: () => ({}) },
      PhosphorMotion: { reduced: () => false, spring: () => 'linear' },
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
  // The renderer the column hands a reply to is held to the same line: it is the one place a
  // model's text is shaped, so it is the one place markup could get in.
  for (const [name, source] of [['agent.js', SOURCE], ['markdown.js', MARKDOWN]] as const) {
    assert.equal(/\.innerHTML\s*=/.test(source), false, `${name} assigns innerHTML`);
    assert.equal(/insertAdjacentHTML|outerHTML|document\.write|createContextualFragment/.test(source), false, name);
  }
});

test('the renderer builds nothing that decides anything', () => {
  // The renderer is the only code that turns model text into elements. The tags it may build
  // are inert: a table, a list, a label, a span. Not a button, not a link, not a form.
  const tags = MARKDOWN.match(/el\('([a-z]+)'/g)?.map((m) => m.replace(/^el\('/, '').replace(/'$/, '')) ?? [];
  assert.ok(tags.length > 0, 'the renderer builds no elements, so this test is not looking at it');
  const inert = ['div', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'];
  for (const tag of tags) assert.ok(inert.includes(tag), `the renderer builds a <${tag}>`);
  // Every element is named by a literal in this file, so no tag name can come from the text.
  const sites = MARKDOWN.match(/(?<![A-Za-z_])el\(([^,)]*)/g)?.map((m) => m.replace(/^el\(/, '').trim()) ?? [];
  const named = sites.filter((arg) => arg !== 'tag');
  assert.ok(named.length > 0);
  for (const arg of named) {
    assert.ok(/^'[a-z]+'$/.test(arg) || /^[a-z]+ \? '[a-z]+' : '[a-z]+'$/.test(arg), `a tag from a variable: el(${arg})`);
  }
  assert.equal((MARKDOWN.match(/document\.createElement\(/g) ?? []).length, 1, 'one door for elements, the el() helper');
  assert.equal(/\bsetAttribute\b|\bhref\b|\bonclick\b/.test(MARKDOWN), false, 'the renderer writes no attribute');
});

test('the panel builds no control that decides anything', () => {
  // The panel's own buttons, named. A button this list does not know about is a
  // button somebody added to a transcript, which is the thing being prevented.
  // Every labelled button goes through the one helper, button(className, label), and the three
  // suggestion pills carry the questions in SUGGESTIONS. No other site builds a <button>.
  const labels = SOURCE.match(/\bbutton\('[^']*', '([^']+)'/g) ?? [];
  // Keep running and Turn off are the confirmation card's two answers (2026-09-16): the card
  // decides nothing about money, only whether the assistant's process ends. Jump to latest is
  // the pill at the foot of the scroller: it scrolls, and that is all it does.
  const allowed = ['Start your assistant', 'Turn off', 'Connect your own', 'Copy', 'Retry', 'Back', 'Keep running', 'Jump to latest'];
  assert.ok(labels.length > 0, 'the panel builds no buttons at all, so this test is not looking at it');
  for (const raw of labels) {
    const label = raw.replace(/^.*, '/, '').replace(/'$/, '');
    assert.ok(allowed.includes(label), `the panel built a button labelled "${label}"`);
  }
  const sites = SOURCE.match(/dom\.el\('button'[^\n]*/g) ?? [];
  const known = [
    "dom.el('button', className);",
    "dom.el('button', 'chip suggest', SUGGESTIONS[s]);",
    "dom.el('button', 'composer-send');",
    "dom.el('button', 'steps-fold');",
  ];
  for (const site of sites) assert.ok(known.includes(site.trim()), `an unknown button site: ${site.trim()}`);
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
  assert.equal(agent.toolLabel('propose_send'), 'asking to send');
  assert.equal(agent.toolLabel('intents_send'), 'sending inside NEAR Intents');
  assert.equal(agent.toolLabel('intents_pay'), 'paying out');
  assert.equal(agent.toolLabel('propose_trade'), 'proposing a trade');
  assert.equal(agent.toolLabel('trade'), 'opening a trade');
  assert.equal(agent.toolLabel('propose_trade_change'), 'proposing a change');
  assert.equal(agent.toolLabel('trade_change'), 'changing a trade');
  assert.equal(agent.toolLabel('trade_plan'), 'drawing a plan');
  assert.equal(agent.toolLabel('propose_hl_deposit'), 'asking to fund trading');
  assert.equal(agent.toolLabel('propose_policy_change'), 'asking to change a rule');
});

test('every tool the server offers has a phrase, not an id', () => {
  // A step row printing `chain_address` is the window handing a person the tool
  // surface instead of the answer, and the table is the only place that fixes it.
  const agent = load();
  assert.equal(agent.toolLabel('chain_address'), 'looking up an address');
  assert.equal(agent.toolLabel('chain_transaction'), 'reading a transaction');
  assert.equal(agent.toolLabel('intents_activity'), 'reading the NEAR Intents history');
  assert.equal(agent.toolLabel('set_theme'), 'recolouring the window');
});

test('the tools that leave this machine say so', () => {
  const agent = load();
  assert.equal(agent.toolLabel('research'), 'reading the news');
  assert.equal(agent.toolLabel('chain_transactions'), 'reading an address\'s history');
  // The step row's own words beside the phrase come from LEAVES, which names the news and the
  // four public chain reads: the wallet app reaching the internet is a fact a person is owed.
  const table = /var LEAVES = \{([^}]*)\}/.exec(SOURCE)?.[1] ?? '';
  for (const tool of ['research', 'chain_address', 'chain_transactions', 'chain_transaction', 'intents_activity']) {
    assert.ok(new RegExp(`\\b${tool}: true`).test(table), `${tool} is not marked as leaving the machine`);
  }
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
