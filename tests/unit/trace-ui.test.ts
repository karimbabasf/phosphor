// Where each tool lands.
//
// The table below is the whole of the feedback the window gives while an agent
// works: a person watching sees the panel the tool touched light up, so a tool
// pointed at the wrong panel is a lie about what the agent just did. The rows
// are asserted one at a time rather than as a blob, because a wrong row is the
// failure and the test should name it.
//
// Three rules carry weight beyond the table. A tool that only asks lands amber
// on the dock, because amber in this window means a person has to click and
// the dock is where the click is. The one tool that leaves this machine is
// marked, so the trace can send its light out of the window and back rather
// than across it. And the beam flies for WRITES only: a tool that changes what
// the window shows, or asks a person to click. A read lights nothing, because
// a panel that lit on every wallet read was a window flashing for an agent
// thinking, and the agent thinks constantly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/beam/trace.js', import.meta.url), 'utf8');

type Any = Record<string, any>;

/* Objects built inside the vm carry that realm's Object.prototype, and a strict
   deep compare tests prototypes as well as keys. Copying through JSON puts the
   shape back in this realm so the assertion is about the shape, which is what
   these tests are for. */
function plain(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

type World = {
  trace: Any;
  step: (detail: Any) => void;
  frame: (type: string, payload: Any) => void;
  wallet: (value: Any) => void;
  calls: Any[];
};

function build(): World {
  const calls: Any[] = [];
  const listeners = Object.create(null) as Any;
  const streams = Object.create(null) as Any;
  const slices = Object.create(null) as Any;

  const sandbox: Any = { console };
  sandbox.window = sandbox;
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  sandbox.document = { addEventListener() {} };
  sandbox.addEventListener = (type: string, fn: Any) => {
    listeners[type] = fn;
  };
  sandbox.PhosphorBeam = {
    fire: (opts: Any) => calls.push({ call: 'fire', ...opts }),
    hold: (id: string) => calls.push({ call: 'hold', id }),
    release: (id: string, ok: boolean) => calls.push({ call: 'release', id, ok }),
    decay: (id: string) => calls.push({ call: 'decay', id }),
    wait: (id: string, on: boolean) => calls.push({ call: 'wait', id, on }),
    surface: () => null,
  };
  sandbox.PhosphorEvents = {
    on(type: string, fn: Any) {
      streams[type] = fn;
      return () => {};
    },
  };
  sandbox.PhosphorState = {
    select(key: string, fn: Any) {
      slices[key] = fn;
      return () => {};
    },
  };

  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/beam/trace.js' });
  sandbox.PhosphorTrace.start();

  return {
    trace: sandbox.PhosphorTrace,
    step: (detail: Any) => listeners['phosphor:step']({ detail }),
    frame: (type: string, payload: Any) => streams[type] && streams[type](payload),
    wallet: (value: Any) => slices['wallet'] && slices['wallet'](value),
    calls,
  };
}

const READS: Array<[string, string]> = [
  ['wallet', 'holdings'],
  ['composition', 'holdings'],
  ['watch', 'holdings'],
  ['policy_show', 'rules'],
  ['trade_plan', 'chart'],
  ['proposal_status', 'activity'],
  ['log_tail', 'activity'],
  ['deposit', 'moneyin'],
  ['chart_snapshot', 'chart'],
  ['market_search', 'chart'],
  ['chart_layout', 'chart'],
  ['chart_draw', 'chart'],
  ['chart_read', 'chart'],
  ['chart_scan', 'chart'],
  ['chart_batch', 'chart'],
  ['trade_overlay', 'chart'],
  ['trade_highlight', 'chart'],
  ['trade_focus', 'chart'],
  ['trade_clear', 'chart'],
  ['trade_read', 'position'],
  ['trade_batch', 'position'],
  ['switch', 'tabs'],
  ['set_theme', 'window'],
  ['start', 'assistant'],
  ['skill', 'assistant'],
  ['profile_learned', 'assistant'],
  ['agent_roster', 'assistant'],
  ['agent_spawn', 'assistant'],
  ['chain_address', 'assistant'],
  ['chain_transactions', 'assistant'],
  ['chain_transaction', 'assistant'],
  ['intents_activity', 'assistant'],
];

for (const [tool, id] of READS) {
  test(`${tool} lands on ${id}`, () => {
    const world = build();
    assert.deepEqual(plain(world.trace.surfaceOf(tool)), { id, tone: 'glow', leaves: false });
  });
}

/* Every ask flies to the dock: that is where the person's click is. The panel the request
   would touch is lit by the dock itself, amber, through surfaceForProposal. */
const ASKS: string[] = [
  'propose_swap', 'propose_send', 'propose_policy_change', 'propose_trade', 'propose_trade_change',
  'propose_hl_deposit', 'propose_hl_withdraw',
];

for (const tool of ASKS) {
  test(`${tool} lands amber on the dock`, () => {
    const world = build();
    assert.deepEqual(plain(world.trace.surfaceOf(tool)), { id: 'dock', tone: 'wait', leaves: false });
  });
}

test('the tools that move money land where the money moved, in the assistant colour', () => {
  const world = build();
  // Not amber: by the time these run a person has already clicked, so nothing
  // is waiting on them and amber would be asking a second time.
  assert.deepEqual(plain(world.trace.surfaceOf('swap')), { id: 'holdings', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('intents_send')), { id: 'holdings', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('intents_pay')), { id: 'holdings', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('hl_deposit')), { id: 'account', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('trade')), { id: 'position', tone: 'glow', leaves: false });
});

test('the one tool that leaves this machine is marked', () => {
  const world = build();
  const where = world.trace.surfaceOf('research');
  assert.equal(where.leaves, true);
  assert.equal(where.id, 'assistant');
});

test('the server prefix is stripped and a tool nobody has mapped lands on the assistant', () => {
  const world = build();
  assert.equal(world.trace.surfaceOf('mcp__phosphor__wallet').id, 'holdings');
  assert.equal(world.trace.surfaceOf('some_new_tool').id, 'assistant');
  // The chains left the window with the legacy pocket. A tool for one of them is now a tool
  // nobody has mapped, which lights the assistant rather than a panel that is no longer on
  // either deck; an ask for one still goes to the dock, because asking is asking.
  assert.equal(world.trace.surfaceOf('balances').id, 'assistant');
  assert.equal(world.trace.surfaceOf('gas_report').id, 'assistant');
  assert.equal(world.trace.surfaceOf('yield_read').id, 'assistant');
  assert.equal(world.trace.surfaceOf('propose_yield_deposit').id, 'dock');
  // The historic table is for proposal kinds and must not put a live tool back on the map.
  assert.equal(world.trace.surfaceOf('yield_deposit').id, 'assistant');
  assert.equal(world.trace.surfaceOf('lp_add').id, 'assistant');
  // The id comes from a language model, so a lookup on a plain object must not
  // hand back Object.prototype's own members.
  assert.equal(world.trace.surfaceOf('constructor').id, 'assistant');
  assert.equal(world.trace.surfaceOf('hasOwnProperty').id, 'assistant');
});

test('a proposal card lands on the panel its kind belongs to', () => {
  const world = build();
  assert.equal(world.trace.surfaceForProposal('swap'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('intents_send'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('intents_pay'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('hl_deposit'), 'account');
  assert.equal(world.trace.surfaceForProposal('hl_withdraw'), 'account');
  assert.equal(world.trace.surfaceForProposal('policy_change'), 'rules');
  assert.equal(world.trace.surfaceForProposal('trade'), 'position');
  assert.equal(world.trace.surfaceForProposal('mandate_arm'), 'rules');
  // A kind this app can no longer propose but can still be asked to DRAW. Earning and the
  // pools went with their venues, and state/proposals.json keeps the rows that already
  // executed, so one of these can still reach a card. Each moved money into or out of the
  // wallet, so the wallet is where its light belongs: a kind with no tool is not a kind
  // with no home, and landing on the assistant would say the assistant did it to itself.
  assert.equal(world.trace.surfaceForProposal('yield_deposit'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('yield_withdraw'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('lp_add'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('lp_remove'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('something_new'), 'assistant');
});

test('a live write sends the beam and holds; the result releases it', () => {
  const world = build();
  const node = { dot: true };
  world.step({ id: 's1', name: 'chart_draw', state: 'live', node });
  assert.deepEqual(world.calls, [
    { call: 'fire', from: node, to: 'chart', tone: 'glow', then: 'hold' },
  ]);
  world.calls.length = 0;
  world.step({ id: 's1', name: 'chart_draw', state: 'done', node });
  assert.deepEqual(world.calls, [{ call: 'release', id: 'chart', ok: true }]);
});

const WRITES: Array<[string, string, string]> = [
  ['chart_draw', 'chart', 'glow'],
  ['chart_layout', 'chart', 'glow'],
  ['trade_plan', 'chart', 'glow'],
  ['trade_highlight', 'chart', 'glow'],
  ['trade_overlay', 'chart', 'glow'],
  ['trade_focus', 'chart', 'glow'],
  ['trade_clear', 'chart', 'glow'],
  ['set_theme', 'window', 'glow'],
  ['switch', 'tabs', 'glow'],
  ['watch', 'holdings', 'glow'],
  ['propose_trade', 'dock', 'wait'],
  ['propose_swap', 'dock', 'wait'],
  ['propose_send', 'dock', 'wait'],
  ['propose_hl_deposit', 'dock', 'wait'],
];

for (const [tool, id, tone] of WRITES) {
  test(`${tool} is a write: the beam holds ${id} while it runs and the glow lands after`, () => {
    const world = build();
    const node = { dot: true };
    world.step({ id: 'w', name: tool, state: 'live', node });
    assert.deepEqual(world.calls, [{ call: 'fire', from: node, to: id, tone, then: 'hold' }]);
    world.calls.length = 0;
    world.step({ id: 'w', name: tool, state: 'done', node });
    assert.deepEqual(world.calls, [{ call: 'release', id, ok: true }]);
  });
}

const QUIET: string[] = [
  'wallet', 'composition', 'policy_show', 'proposal_status', 'log_tail', 'deposit',
  'chart_read', 'chart_scan', 'chart_batch', 'chart_snapshot', 'market_search', 'trade_read', 'trade_batch',
  'chain_address', 'chain_transactions', 'chain_transaction', 'intents_activity',
  'start', 'skill', 'agent_roster', 'agent_board', 'agent_jobs', 'some_new_tool', 'constructor',
];

for (const tool of QUIET) {
  test(`${tool} is a read: no flight, no hold, no glow, and nothing to release`, () => {
    const world = build();
    const node = { dot: true };
    world.step({ id: 'r', name: tool, state: 'live', node });
    assert.deepEqual(world.calls, [], `${tool} lit the window`);
    world.step({ id: 'r', name: tool, state: 'done', node });
    assert.deepEqual(world.calls, []);
    world.step({ id: 'r2', name: tool, state: 'live', node });
    world.step({ id: 'r2', name: tool, state: 'error', node });
    assert.deepEqual(world.calls, [], `${tool} failing lit the window`);
  });
}

test('the server prefix does not turn a write into a read', () => {
  const world = build();
  world.step({ id: 'p', name: 'mcp__phosphor__trade_highlight', state: 'live', node: null });
  assert.equal(world.calls.length, 1);
  assert.equal(world.calls[0].to, 'chart');
});

test('an errored step releases rose on the surface the tool was aimed at', () => {
  const world = build();
  world.step({ id: 's2', name: 'propose_swap', state: 'live', node: null });
  world.calls.length = 0;
  world.step({ id: 's2', name: 'propose_swap', state: 'error', node: null });
  assert.deepEqual(world.calls, [{ call: 'release', id: 'dock', ok: false }]);
});

test('a result for a step nobody opened releases nothing', () => {
  const world = build();
  world.step({ id: 'ghost', name: 'wallet', state: 'done', node: null });
  assert.deepEqual(world.calls, []);
});

test('the tool that leaves the machine flies out of the window before it comes back', () => {
  // research is a read, and the one read that still flies: its light is about WHERE the
  // call went, not that a call happened. A person watching their wallet app reach the
  // internet is entitled to see it, every time.
  const world = build();
  const node = { dot: true };
  world.step({ id: 's3', name: 'research', state: 'live', node });
  assert.equal(world.calls.length, 1);
  const out = world.calls[0];
  assert.equal(out.call, 'fire');
  assert.equal(out.from, node);
  assert.deepEqual(plain(out.to), { x: 720, y: -20 }, 'the light did not leave through the top of the window');
  assert.equal(out.then, 'none');
  // The return leg is what holds the assistant, so the step stays lit while
  // the network call runs.
  out.done();
  const back = world.calls[1];
  assert.deepEqual(plain(back.from), { x: 720, y: -20 });
  assert.equal(back.to, 'assistant');
  assert.equal(back.then, 'hold');
});

test('what changed after an execution glows on its own', () => {
  const world = build();
  world.frame('transactions', { type: 'transactions' });
  assert.deepEqual(world.calls, [{ call: 'decay', id: 'activity' }]);
  world.calls.length = 0;
  const held = (quantity: number, valueUsd: number) => ({
    rows: [{ kind: 'intents', chain: 'intents', tokenId: 'nep141:usdc.near', symbol: 'USDC', quantity, valueUsd, priceUsd: 1 }],
    totalUsd: valueUsd,
    stale: [],
  });
  // The first call is the subscription handing over what it already had, which
  // is not a change and must not light anything.
  world.wallet(held(10, 10));
  assert.deepEqual(world.calls, []);
  world.wallet(held(12, 12));
  assert.deepEqual(world.calls, [{ call: 'decay', id: 'holdings' }]);
});

test('a price that moved is not money arriving', () => {
  /* The subscription used to be on the raw ledger, which carries prices and the dollar values
     they produce. Those move on every price poll and the hub pushes up to 8 frames a second with
     a trading feed live, so the holdings panel flashed for a reading of the market rather than
     for anything that happened to this wallet. On the basic screen it looked like a fault. */
  const world = build();
  const priced = (usd: number) => ({
    rows: [{ kind: 'intents', chain: 'intents', tokenId: 'nep141:eth.omft.near', symbol: 'ETH', quantity: 0.5, valueUsd: usd, priceUsd: usd * 2 }],
    totalUsd: usd,
    stale: [],
  });
  world.wallet(priced(1000));
  world.calls.length = 0;
  world.wallet(priced(1001));
  world.wallet(priced(999));
  assert.deepEqual(world.calls, [], 'the holdings panel lit for a price tick');
});

test('a pocket going stale is a change worth seeing', () => {
  const world = build();
  const rows = (stale: string[]) => ({
    rows: [{ kind: 'intents', chain: 'intents', tokenId: 'nep141:usdc.near', symbol: 'USDC', quantity: 3, valueUsd: 3, priceUsd: 1 }],
    totalUsd: 3,
    stale,
  });
  world.wallet(rows([]));
  world.calls.length = 0;
  world.wallet(rows(['intents']));
  assert.deepEqual(world.calls, [{ call: 'decay', id: 'holdings' }]);
});

test('nothing an assistant writes reaches the DOM through the trace', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});
