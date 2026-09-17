// The trace: what the assistant did, and where the beam sends the light for it.
//
// Two things are asserted here. The routing table (ui/beam/trace.js) maps every tool the driver
// can call to a surface, and a wrong row lights the wrong panel or nothing. And the surface list:
// every id the table can produce has a data-surface somewhere in the window, because an id with
// no home is a beam aimed at nothing, which is exactly the 'position' bug this pass fixed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const TRACE = readFileSync(new URL('ui/beam/trace.js', ROOT), 'utf8');
const BEAM = readFileSync(new URL('ui/beam/beam.js', ROOT), 'utf8');

type Trace = {
  surfaceOf: (name: string, input?: Record<string, unknown>) => { id: string; tone: string; leaves: boolean };
  surfaceForProposal: (kind: string) => string;
};

type Any = Record<string, any>;

/* trace.js is an IIFE that assigns window.PhosphorTrace and reads window.PhosphorBeam lazily, so a
   bare window is enough to read the routing table without a beam or a DOM. */
function load(): Trace {
  const sandbox: Record<string, unknown> = { window: {}, console };
  createContext(sandbox);
  runInContext(TRACE, sandbox, { filename: 'ui/beam/trace.js' });
  return (sandbox.window as { PhosphorTrace: Trace }).PhosphorTrace;
}

/* Every data-surface id the window actually carries: the two virtual ones the beam resolves by
   hand (window, assistant), the tabs, and every data-surface written in the markup or set in a
   screen's dataset.surface. Read from source so the test fails when a routed id loses its home. */
function surfaceIds(): Set<string> {
  const ids = new Set<string>(['window', 'assistant', 'tabs']);
  const files = ['ui/index.html', 'ui/screens/basic.js', 'ui/screens/pro.js', 'ui/screens/trade.js', 'ui/screens/vault.js'];
  for (const file of files) {
    const src = readFileSync(new URL(file, ROOT), 'utf8');
    for (const m of src.matchAll(/data-surface="([a-z-]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/dataset\.surface\s*=\s*'([a-z-]+)'/g)) ids.add(m[1]);
    // card(...), linkCard(...), panel(...), linkPanel(...) and fold(...): the lowercase-word string arguments are surface
    // ids ('holdings', 'account', ...); titles carry capitals or spaces and spans carry a dash,
    // so a bare [a-z]+ token in the call is the surface.
    for (const call of src.matchAll(/(?:card|linkCard|panel|linkPanel|fold)\(([^)]*)\)/g)) {
      for (const q of call[1].matchAll(/'([a-z]+)'/g)) ids.add(q[1]);
    }
  }
  return ids;
}

/* The whole tool surface the driver is allowed (src/mcp.ts) after the 2026-09-16 pass: reads and
   writes alike, because a read routes to a surface too, so a card or a later write knows where it
   belongs. The chain reads and propose_send are routed here before their tools land, so the
   beam is right the day they do. */
const TOOLS = [
  'skill', 'start', 'wallet', 'deposit', 'composition', 'policy_show', 'log_tail', 'proposal_status',
  'chart_read', 'chart_scan', 'chart_snapshot', 'market_search', 'research', 'chart_batch',
  'set_theme', 'chart_draw', 'chart_layout', 'trade_read', 'trade_batch', 'trade_focus',
  'trade_highlight', 'trade_overlay', 'trade_clear', 'trade_plan', 'switch', 'watch',
  'agent_roster', 'agent_board', 'agent_jobs', 'agent_post', 'agent_spawn', 'profile_learned',
  'chain_address', 'chain_transactions', 'chain_transaction', 'intents_activity',
  'propose_policy_change', 'propose_swap', 'propose_send', 'propose_trade', 'propose_trade_change',
  'propose_hl_deposit', 'propose_hl_withdraw',
];

/* The kinds a proposal can carry, which the dock lights through surfaceForProposal. */
const KINDS = ['swap', 'intents_send', 'intents_pay', 'trade', 'trade_change', 'hl_deposit', 'hl_withdraw', 'policy_change'];

/* A window that carries every surface id the sources name, one element each, resolved through
   the real beam.js. That is the test the table has to pass: not that a row names an id that
   looks right, but that the beam, handed that id, finds an element to land on. */
function fixture(ids: Set<string>): { beam: Any; el: (id: string) => Any } {
  const nodes = new Map<string, Any>();
  function makeEl(id: string, surface: string | null, parent: Any | null): Any {
    const el: Any = {
      id,
      tagName: 'div',
      attrs: Object.create(null) as Any,
      children: [] as Any[],
      parentNode: parent,
      isConnected: true,
      style: { setProperty() {} },
      setAttribute(name: string, value: string) { el.attrs[name] = String(value); },
      getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
      removeAttribute(name: string) { delete el.attrs[name]; },
      appendChild(child: Any) { child.parentNode = el; el.children.push(child); return child; },
      removeChild(child: Any) { const at = el.children.indexOf(child); if (at >= 0) el.children.splice(at, 1); return child; },
      getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 200 }; },
    };
    if (surface) el.setAttribute('data-surface', surface);
    if (parent) parent.appendChild(el);
    nodes.set(id, el);
    return el;
  }
  const body = makeEl('body', null, null);
  const stage = makeEl('stage', 'window', body);
  const conversation = makeEl('conversation', 'assistant', stage);
  makeEl('agent-status', null, conversation);
  const topbar = makeEl('topbar', null, body);
  const view = makeEl('view-basic', null, stage);
  view.setAttribute('data-active', 'true');
  for (const id of ids) {
    if (id === 'window' || id === 'assistant' || id === 'tabs') continue;
    if (id.startsWith('tab-')) {
      const tab = makeEl(id, id, topbar);
      if (id === 'tab-basic') tab.setAttribute('aria-selected', 'true');
      continue;
    }
    makeEl(`surface-${id}`, id, id === 'dock' ? conversation : view);
  }
  function matchAll(selector: string): Any[] {
    const attr = /^\[data-surface="([^"]*)"\]$/.exec(selector);
    const out: Any[] = [];
    if (attr) {
      nodes.forEach((node) => { if (node.getAttribute('data-surface') === attr[1]) out.push(node); });
    } else if (selector === '.tab[aria-selected="true"]') {
      nodes.forEach((node) => { if (node.getAttribute('aria-selected') === 'true') out.push(node); });
    }
    return out;
  }
  const doc: Any = {
    body,
    documentElement: makeEl('html', null, null),
    getElementById: (id: string) => nodes.get(id) || null,
    querySelector: (selector: string) => matchAll(selector)[0] || null,
    querySelectorAll: matchAll,
    createElement: (tag: string) => makeEl(`made-${tag}-${nodes.size}`, null, null),
    addEventListener() {},
  };
  const sandbox: Any = { console, performance: { now: () => 0 }, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.location = { search: '' };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.PhosphorMotion = { reduced: () => true, animate: () => ({ finished: Promise.resolve(), stop() {} }) };
  createContext(sandbox);
  runInContext(BEAM, sandbox, { filename: 'ui/beam/beam.js' });
  return { beam: sandbox.PhosphorBeam, el: (id: string) => nodes.get(id) as Any };
}

test('every tool lands on a surface the window carries, and the beam finds an element for it', () => {
  const trace = load();
  const ids = surfaceIds();
  const world = fixture(ids);
  for (const tool of TOOLS) {
    const where = trace.surfaceOf(tool);
    assert.ok(where.id, `${tool} routed to nothing`);
    const resolvable = ids.has(where.id) || /^tab-(basic|pro|trade|vault)$/.test(where.id);
    assert.ok(resolvable, `${tool} routed to "${where.id}", which no surface carries`);
    assert.ok(world.beam.surface(where.id), `${tool} routed to "${where.id}", which the beam cannot find`);
  }
  for (const kind of KINDS) {
    const id = trace.surfaceForProposal(kind);
    assert.ok(ids.has(id), `proposal kind ${kind} lights "${id}", which no surface carries`);
    assert.ok(world.beam.surface(id), `proposal kind ${kind} lights "${id}", which the beam cannot find`);
  }
});

test('the reads land where their answer is shown, the chain reads on the assistant', () => {
  const trace = load();
  assert.equal(trace.surfaceOf('wallet').id, 'holdings');
  assert.equal(trace.surfaceOf('composition').id, 'holdings');
  assert.equal(trace.surfaceOf('watch').id, 'holdings');
  assert.equal(trace.surfaceOf('policy_show').id, 'rules');
  assert.equal(trace.surfaceOf('log_tail').id, 'activity');
  assert.equal(trace.surfaceOf('proposal_status').id, 'activity');
  assert.equal(trace.surfaceOf('deposit').id, 'moneyin');
  assert.equal(trace.surfaceOf('trade_read').id, 'position');
  assert.equal(trace.surfaceOf('trade_batch').id, 'position');
  for (const tool of ['chart_read', 'chart_scan', 'chart_batch', 'chart_draw', 'chart_layout', 'chart_snapshot', 'market_search', 'trade_focus', 'trade_highlight', 'trade_overlay', 'trade_clear', 'trade_plan']) {
    assert.equal(trace.surfaceOf(tool).id, 'chart', tool);
  }
  for (const tool of ['chain_address', 'chain_transactions', 'chain_transaction', 'intents_activity', 'skill', 'start', 'profile_learned', 'agent_roster', 'agent_post']) {
    assert.equal(trace.surfaceOf(tool).id, 'assistant', tool);
  }
  assert.equal(trace.surfaceOf('set_theme').id, 'window');
});

test('every propose verb flies to the dock, and the proposal it makes lights the panel it would touch', () => {
  const trace = load();
  // The flight goes where the click is. The dock then lights the world surface the request would
  // touch, amber, through surfaceForProposal (ui/screens/decision.js), so a swap waiting for a yes
  // points at the dock and rings the Money card.
  for (const tool of ['propose_swap', 'propose_send', 'propose_trade', 'propose_trade_change', 'propose_hl_deposit', 'propose_hl_withdraw', 'propose_policy_change']) {
    assert.equal(trace.surfaceOf(tool).id, 'dock', tool);
  }
  assert.equal(trace.surfaceForProposal('swap'), 'holdings');
  assert.equal(trace.surfaceForProposal('intents_send'), 'holdings');
  assert.equal(trace.surfaceForProposal('intents_pay'), 'holdings');
  assert.equal(trace.surfaceForProposal('trade'), 'position');
  assert.equal(trace.surfaceForProposal('trade_change'), 'position');
  assert.equal(trace.surfaceForProposal('hl_deposit'), 'account');
  assert.equal(trace.surfaceForProposal('hl_withdraw'), 'account');
  assert.equal(trace.surfaceForProposal('policy_change'), 'rules');
  assert.equal(trace.surfaceOf('trade').id, 'position');
});

test('every propose verb is amber, every read and write is the assistant light', () => {
  const trace = load();
  assert.equal(trace.surfaceOf('propose_hl_deposit').tone, 'wait');
  assert.equal(trace.surfaceOf('propose_policy_change').tone, 'wait');
  assert.equal(trace.surfaceOf('swap').tone, 'glow');
  assert.equal(trace.surfaceOf('chart_draw').tone, 'glow');
});

test('switch lights the tab it is going TO, read from the tool argument, not the tab being left', () => {
  const trace = load();
  // 'tabs' resolves to the current tab, which is the one being left. The destination is in the arg.
  assert.equal(trace.surfaceOf('switch', { mode: 'trade' }).id, 'tab-trade');
  assert.equal(trace.surfaceOf('switch', { mode: 'basic' }).id, 'tab-basic');
  // Aliases the tool accepts (src/mcp.ts) resolve to the same tabs.
  assert.equal(trace.surfaceOf('switch', { mode: 'trading' }).id, 'tab-trade');
  assert.equal(trace.surfaceOf('switch', { mode: 'operator' }).id, 'tab-pro');
  // No arg, or one nobody knows: fall back to the old behaviour rather than guess a tab.
  assert.equal(trace.surfaceOf('switch').id, 'tabs');
  assert.equal(trace.surfaceOf('switch', { mode: 'sideways' }).id, 'tabs');
});

test('the tools that leave this machine say so, and an unknown tool lands on the assistant', () => {
  const trace = load();
  for (const tool of ['research', 'chain_address', 'chain_transactions', 'chain_transaction', 'intents_activity']) {
    assert.equal(trace.surfaceOf(tool).leaves, true, tool);
    assert.equal(trace.surfaceOf(tool).id, 'assistant', tool);
  }
  assert.equal(trace.surfaceOf('wallet').leaves, false);
  // A tool id from a model that no row knows still comes from the assistant, so it lights there.
  assert.equal(trace.surfaceOf('some_tool_added_next_release').id, 'assistant');
  // An id that names an Object member is not a surface.
  assert.equal(trace.surfaceOf('constructor').id, 'assistant');
});

test('a historic kind with no live tool still has a home', () => {
  const trace = load();
  // Earning and pools left with their venues, so no tool writes them, but an executed one can still
  // reach a card. They moved money in the wallet, so the wallet is where their light belongs.
  assert.equal(trace.surfaceForProposal('lp_add'), 'holdings');
  assert.equal(trace.surfaceForProposal('mandate_arm'), 'rules');
  assert.equal(trace.surfaceForProposal('something_unknown'), 'assistant');
});
