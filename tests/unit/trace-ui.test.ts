// Where each tool lands.
//
// The table below is the whole of the feedback the window gives while an agent
// works: a person watching sees the panel the tool touched light up, so a tool
// pointed at the wrong panel is a lie about what the agent just did. The rows
// are asserted one at a time rather than as a blob, because a wrong row is the
// failure and the test should name it.
//
// Two rules carry weight beyond the table. A tool that only asks lands amber,
// because amber in this window means a person has to click. And the one tool
// that leaves this machine is marked, so the trace can send its light out of
// the window and back rather than across it.

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
  ledger: (value: Any) => void;
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
    ledger: (value: Any) => slices['ledger'] && slices['ledger'](value),
    calls,
  };
}

const READS: Array<[string, string]> = [
  ['balances', 'holdings'],
  ['wallet', 'holdings'],
  ['composition', 'holdings'],
  ['gas_report', 'holdings'],
  ['yield_read', 'earning'],
  ['yield_auto', 'earning'],
  ['policy_show', 'rules'],
  ['mandate_catalog', 'rules'],
  ['proposal_status', 'activity'],
  ['log_tail', 'activity'],
  ['candles', 'chart'],
  ['market_search', 'chart'],
  ['indicator_catalog', 'chart'],
  ['watch', 'chart'],
  ['chart_mark', 'chart'],
  ['chart_read', 'chart'],
  ['chart_batch', 'chart'],
  ['trade_overlay', 'chart'],
  ['trade_highlight', 'chart'],
  ['trade_read', 'position'],
  ['switch', 'tabs'],
  ['set_theme', 'window'],
  ['start', 'assistant'],
  ['skill', 'assistant'],
  ['agent_roster', 'assistant'],
  ['agent_spawn', 'assistant'],
];

for (const [tool, id] of READS) {
  test(`${tool} lands on ${id}`, () => {
    const world = build();
    assert.deepEqual(plain(world.trace.surfaceOf(tool)), { id, tone: 'glow', leaves: false });
  });
}

const ASKS: Array<[string, string]> = [
  ['propose_swap', 'holdings'],
  ['propose_consolidate', 'holdings'],
  ['propose_intents_withdraw', 'holdings'],
  ['propose_yield_deposit', 'earning'],
  ['propose_yield_withdraw', 'earning'],
  ['propose_policy_change', 'rules'],
  ['propose_mandate', 'rules'],
  ['propose_intents_deposit', 'moneyin'],
  ['propose_hl_deposit', 'account'],
];

for (const [tool, id] of ASKS) {
  test(`${tool} lands amber on ${id}`, () => {
    const world = build();
    assert.deepEqual(plain(world.trace.surfaceOf(tool)), { id, tone: 'wait', leaves: false });
  });
}

test('the tools that move money land where the money moved, in the assistant colour', () => {
  const world = build();
  // Not amber: by the time these run a person has already clicked, so nothing
  // is waiting on them and amber would be asking a second time.
  assert.deepEqual(plain(world.trace.surfaceOf('swap')), { id: 'holdings', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('intents_deposit')), { id: 'moneyin', tone: 'glow', leaves: false });
  assert.deepEqual(plain(world.trace.surfaceOf('mandate_arm')), { id: 'rules', tone: 'glow', leaves: false });
});

test('the one tool that leaves this machine is marked', () => {
  const world = build();
  const where = world.trace.surfaceOf('research');
  assert.equal(where.leaves, true);
  assert.equal(where.id, 'assistant');
});

test('the server prefix is stripped and a tool nobody has mapped lands on the assistant', () => {
  const world = build();
  assert.equal(world.trace.surfaceOf('mcp__phosphor__balances').id, 'holdings');
  assert.equal(world.trace.surfaceOf('some_new_tool').id, 'assistant');
  // The id comes from a language model, so a lookup on a plain object must not
  // hand back Object.prototype's own members.
  assert.equal(world.trace.surfaceOf('constructor').id, 'assistant');
  assert.equal(world.trace.surfaceOf('hasOwnProperty').id, 'assistant');
});

test('a proposal card lands on the panel its kind belongs to', () => {
  const world = build();
  assert.equal(world.trace.surfaceForProposal('swap'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('consolidate'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('intents_withdraw'), 'holdings');
  assert.equal(world.trace.surfaceForProposal('yield_deposit'), 'earning');
  assert.equal(world.trace.surfaceForProposal('yield_withdraw'), 'earning');
  assert.equal(world.trace.surfaceForProposal('intents_deposit'), 'moneyin');
  assert.equal(world.trace.surfaceForProposal('hl_deposit'), 'account');
  assert.equal(world.trace.surfaceForProposal('policy_change'), 'rules');
  assert.equal(world.trace.surfaceForProposal('mandate'), 'rules');
  assert.equal(world.trace.surfaceForProposal('something_new'), 'assistant');
});

test('a live step sends the beam and holds; the result releases it', () => {
  const world = build();
  const node = { dot: true };
  world.step({ id: 's1', name: 'balances', state: 'live', node });
  assert.deepEqual(world.calls, [
    { call: 'fire', from: node, to: 'holdings', tone: 'glow', then: 'hold' },
  ]);
  world.calls.length = 0;
  world.step({ id: 's1', name: 'balances', state: 'done', node });
  assert.deepEqual(world.calls, [{ call: 'release', id: 'holdings', ok: true }]);
});

test('an errored step releases rose on the surface the tool was aimed at', () => {
  const world = build();
  world.step({ id: 's2', name: 'propose_swap', state: 'live', node: null });
  world.calls.length = 0;
  world.step({ id: 's2', name: 'propose_swap', state: 'error', node: null });
  assert.deepEqual(world.calls, [{ call: 'release', id: 'holdings', ok: false }]);
});

test('a result for a step nobody opened releases nothing', () => {
  const world = build();
  world.step({ id: 'ghost', name: 'balances', state: 'done', node: null });
  assert.deepEqual(world.calls, []);
});

test('the tool that leaves the machine flies out of the window before it comes back', () => {
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
  const held = (amount: number, usd: number) => ({
    holdings: [{ chain: 'base', tokenId: 'usdc', symbol: 'USDC', amount, usd }],
    chainStatus: { base: { ok: true, fetchedAt: '' } },
    prices: { ETH: usd },
  });
  // The first call is the subscription handing over what it already had, which
  // is not a change and must not light anything.
  world.ledger(held(10, 10));
  assert.deepEqual(world.calls, []);
  world.ledger(held(12, 12));
  assert.deepEqual(world.calls, [{ call: 'decay', id: 'holdings' }]);
});

test('a price that moved is not money arriving', () => {
  /* The subscription was on the whole ledger slice, which carries prices and the dollar values
     they produce. Those move on every price poll and the hub pushes up to 8 frames a second with
     a trading feed live, so the holdings panel flashed for a reading of the market rather than
     for anything that happened to this wallet. On the basic screen it looked like a fault. */
  const world = build();
  const priced = (usd: number) => ({
    holdings: [{ chain: 'base', tokenId: 'weth', symbol: 'ETH', amount: 0.5, usd }],
    chainStatus: { base: { ok: true, fetchedAt: '2026-09-08T00:00:00Z' } },
    prices: { ETH: usd * 2 },
    priceAsOf: { ETH: Date.now() },
  });
  world.ledger(priced(1000));
  world.calls.length = 0;
  world.ledger(priced(1001));
  world.ledger(priced(999));
  assert.deepEqual(world.calls, [], 'the holdings panel lit for a price tick');
});

test('a chain going stale is a change worth seeing', () => {
  const world = build();
  const rows = (ok: boolean) => ({
    holdings: [{ chain: 'base', tokenId: 'usdc', symbol: 'USDC', amount: 3, usd: 3 }],
    chainStatus: { base: { ok, fetchedAt: '' } },
    prices: {},
  });
  world.ledger(rows(true));
  world.calls.length = 0;
  world.ledger(rows(false));
  assert.deepEqual(world.calls, [{ call: 'decay', id: 'holdings' }]);
});

test('nothing an assistant writes reaches the DOM through the trace', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});
