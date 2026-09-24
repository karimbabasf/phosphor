// The idea door, attacked with volume: ideas are the one row an agent mints without a wall, so a
// seat that draws without end rewrites plans.json on every call and fills every payload. The
// cap is per seat, a redraw and a removal are free of it, and another seat keeps its own twenty.
//
// The real service over a fake socket and a fake runner, because the cap lives in the service's
// plan() and nowhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTradeService, IDEAS_PER_SESSION } from '../../src/trade/service.ts';
import type { TradeRunner } from '../../src/trade/service.ts';
import type { FeedSocket } from '../../src/trade/feed-ws.ts';
import type { InfoClient } from '../../src/hl/info.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import type { PlanInput } from '../../src/trade/plan.ts';
import { planHash } from '../../src/trade/plan.ts';

const USER = '0x1111111111111111111111111111111111111111';

function fakeSocket(): FeedSocket {
  return { readyState: 0, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
}

const info: InfoClient = {
  post: <T>(): Promise<T> => Promise.resolve({ universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] } as T),
  health: () => ({ ok: true, failures: 0, lastError: null, retryAt: null }) as unknown as ReturnType<InfoClient['health']>,
};

function fakeRunner(): TradeRunner & { rows: Map<string, PlanRow> } {
  const rows = new Map<string, PlanRow>();
  let seq = 0;
  return {
    rows,
    status: () => ({ plans: [...rows.values()], child: 'off', watching: [] }),
    plans: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    draw(input: PlanInput, by: string | null) {
      seq += 1;
      const id = `pl_${seq}`;
      const row: PlanRow = { id, ...input, status: 'idea', hash: planHash({ id, ...input }), cloids: {}, gen: 0, by, createdAt: 'x', updatedAt: 'x' };
      rows.set(id, row);
      return row;
    },
    redraw(id) {
      const row = rows.get(id);
      return row === undefined ? { ok: false, reason: `no plan ${id}` } : { ok: true, row };
    },
    erase(id) {
      return { ok: rows.delete(id), reason: `removed ${id}` };
    },
    cancel: async (id) => ({ ok: true, detail: `cancelled ${id}` }),
    close: async (id) => ({ ok: true, detail: `closed ${id}` }),
    flatten: async () => ({ ok: true, detail: 'flat' }),
    onAccount: () => {},
    events: () => [],
  };
}

function setup() {
  const runner = fakeRunner();
  const svc = createTradeService({ wsUrl: 'wss://test.invalid/ws', user: USER, info, runner, products: ['ETH-USD'], atrFor: () => null, initialSymbol: 'ETH', wsImpl: fakeSocket });
  return { svc, runner };
}

const plan = (sizeUsd = 300): Record<string, unknown> => ({ symbol: 'ETH', side: 'long', sizeUsd, leverage: 5, entry: { type: 'market' }, stop: 92, target: 110 });

// ---------- venue metadata ----------

// An info door whose meta read fails while `down` is set, the way it does when the app starts
// before the network is up. Every other read answers.
function flakyInfo(): InfoClient & { down: boolean; metaAsks: number } {
  const door = {
    down: true,
    metaAsks: 0,
    post<T>(body: unknown): Promise<T> {
      if ((body as { type?: string }).type === 'meta') {
        door.metaAsks += 1;
        if (door.down) return Promise.reject(new Error('fetch failed'));
      }
      return info.post<T>(body);
    },
    health: info.health,
  };
  return door;
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('venue metadata that did not load at start is read again on its own until it lands, with no restart', async () => {
  const door = flakyInfo();
  const svc = createTradeService({ wsUrl: 'wss://test.invalid/ws', user: USER, info: door, runner: fakeRunner(), products: ['ETH-USD'], atrFor: () => null, initialSymbol: 'ETH', wsImpl: fakeSocket, metaRetryMs: [5] });
  try {
    const first = door.metaAsks;
    await until(() => door.metaAsks >= first + 2);
    assert.equal(svc.meta('ETH'), null, 'nothing loaded while the venue is down');
    door.down = false;
    await until(() => svc.meta('ETH') !== null);
    assert.deepEqual(svc.meta('ETH'), { assetId: 0, szDecimals: 4, maxLeverage: 25 });
  } finally {
    svc.stop();
  }
});

test('a lookup while the metadata is missing asks for it at once instead of waiting out the retry', async () => {
  const door = flakyInfo();
  const svc = createTradeService({ wsUrl: 'wss://test.invalid/ws', user: USER, info: door, runner: fakeRunner(), products: ['ETH-USD'], atrFor: () => null, initialSymbol: 'ETH', wsImpl: fakeSocket, metaRetryMs: [60_000] });
  try {
    await until(() => door.metaAsks >= 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    door.down = false;
    assert.equal(svc.meta('ETH'), null);
    await until(() => svc.meta('ETH') !== null, 500);
  } finally {
    svc.stop();
  }
});

test('the twenty-first idea from one seat is refused by name, another seat still draws, and a removal frees the slot', () => {
  const { svc, runner } = setup();
  try {
    for (let i = 0; i < IDEAS_PER_SESSION; i++) {
      const out = svc.plan({ plan: plan(300 + i) }, 'agent-a');
      assert.equal(out.ok, true, out.ok ? '' : out.error);
    }
    const over = svc.plan({ plan: plan(999) }, 'agent-a');
    assert.equal(over.ok, false);
    assert.match(over.ok ? '' : over.error, /20 ideas are drawn already/);
    assert.equal(runner.rows.size, IDEAS_PER_SESSION, 'the refused idea was never drawn');
    // A thousand more from the same seat cost nothing but the refusal.
    const started = Date.now();
    for (let i = 0; i < 1000; i++) assert.equal(svc.plan({ plan: plan(999) }, 'agent-a').ok, false);
    assert.ok(Date.now() - started < 2000);
    assert.equal(runner.rows.size, IDEAS_PER_SESSION);
    // Another seat has its own twenty, and a seat with no name is a seat too.
    assert.equal(svc.plan({ plan: plan() }, 'agent-b').ok, true);
    assert.equal(svc.plan({ plan: plan() }, null).ok, true);
    // A redraw is not a draw, and a removal gives the slot back.
    const first = [...runner.rows.values()][0] as PlanRow;
    assert.equal(svc.plan({ planId: first.id, changes: { stop: 91 } }, 'agent-a').ok, true);
    assert.equal(svc.plan({ planId: first.id, remove: true }, 'agent-a').ok, true);
    assert.equal(svc.plan({ plan: plan() }, 'agent-a').ok, true);
    assert.equal(svc.plan({ plan: plan() }, 'agent-a').ok, false);
  } finally {
    svc.stop();
  }
});

test('an armed plan does not count against its seat, and a seat cannot lift its own cap by claiming another name', () => {
  const { svc, runner } = setup();
  try {
    for (let i = 0; i < IDEAS_PER_SESSION; i++) assert.equal(svc.plan({ plan: plan() }, 'agent-a').ok, true);
    // Five of them are armed: the cap is on ideas, because an armed plan sits behind the wall.
    for (const row of [...runner.rows.values()].slice(0, 5)) row.status = 'waiting';
    for (let i = 0; i < 5; i++) assert.equal(svc.plan({ plan: plan() }, 'agent-a').ok, true);
    assert.equal(svc.plan({ plan: plan() }, 'agent-a').ok, false);
    // The seat name is the door's, not the body's: `by` inside the plan is an unknown key.
    const claimed = svc.plan({ plan: { ...plan(), by: 'agent-z' } }, 'agent-a');
    assert.equal(claimed.ok, false);
    assert.match(claimed.ok ? '' : claimed.error, /by/);
  } finally {
    svc.stop();
  }
});
