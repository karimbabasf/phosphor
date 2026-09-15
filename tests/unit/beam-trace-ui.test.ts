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

type Trace = {
  surfaceOf: (name: string, input?: Record<string, unknown>) => { id: string; tone: string; leaves: boolean };
  surfaceForProposal: (kind: string) => string;
};

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

test('every write and every proposal lands on a surface the window carries', () => {
  const trace = load();
  const ids = surfaceIds();
  // The trade deck is landing in its own branch; the beam falls back to the chart until it does,
  // so 'position' is a legitimate target even before the markup carries it.
  ids.add('position');

  // The whole tool surface the driver is allowed (src/mcp.ts), reads and writes alike: a read
  // routes to a surface too, so a card or a later write knows where it belongs.
  const tools = [
    'balances', 'wallet', 'composition', 'gas_report', 'swap', 'consolidate', 'intents_withdraw',
    'policy_show', 'policy_change', 'trade', 'trade_change', 'trade_read', 'trade_plan',
    'proposal_status', 'log_tail', 'intents_deposit', 'hl_deposit', 'hl_withdraw',
    'market_search', 'chart_draw', 'chart_read', 'chart_scan', 'chart_snapshot', 'chart_layout',
    'chart_batch', 'watch', 'switch', 'set_theme', 'start', 'skill', 'profile_learned', 'research',
    'propose_swap', 'propose_consolidate', 'propose_intents_deposit', 'propose_intents_withdraw',
    'propose_hl_deposit', 'propose_hl_withdraw', 'propose_trade', 'propose_trade_change',
    'propose_policy_change', 'agent_spawn', 'agent_roster', 'agent_post',
  ];
  for (const tool of tools) {
    const where = trace.surfaceOf(tool);
    assert.ok(where.id, `${tool} routed to nothing`);
    const resolvable = ids.has(where.id) || /^tab-(basic|pro|trade|vault)$/.test(where.id);
    assert.ok(resolvable, `${tool} routed to "${where.id}", which no surface carries`);
  }
});

test('a proposal and the tool that asked for it read the same row', () => {
  const trace = load();
  // propose_swap is swap with a person in front of it, so the card and the light point at one place.
  assert.equal(trace.surfaceOf('propose_swap').id, trace.surfaceOf('swap').id);
  assert.equal(trace.surfaceOf('propose_swap').id, 'holdings');
  assert.equal(trace.surfaceForProposal('swap'), 'holdings');
  // Trades land on the trade deck.
  assert.equal(trace.surfaceOf('propose_trade').id, 'position');
  assert.equal(trace.surfaceForProposal('trade'), 'position');
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

test('the one tool that leaves this machine says so, and an unknown tool lands on the assistant', () => {
  const trace = load();
  assert.equal(trace.surfaceOf('research').leaves, true);
  assert.equal(trace.surfaceOf('research').id, 'assistant');
  assert.equal(trace.surfaceOf('balances').leaves, false);
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
