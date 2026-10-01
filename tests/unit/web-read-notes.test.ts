// Notes an agent writes are a stranger's words once that agent has read one (the plan-idea notes
// the decision note of 2026-09-24 left open, and two carriers of the same class found beside them
// on 2026-10-01: a highlight's note, and the words on a move another seat reads back).
//
// The rule is the chart label's (src/web-read.ts): a note written while the writing seat is marked
// is stamped, the stamp is kept with it, and a seat a read hands a stamped note to is marked as if
// it had read the page itself. The plan note's stamp at draw and redraw is tested with the runner
// in runner-host.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { createTradeView } from '../../src/trade/view.ts';
import { tradeNotes, tradeReads } from '../../src/http/read/trade.ts';
import { walletReads } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { Proposal } from '../../src/types.ts';
import { clearWebRead, markWebRead, webReadBy } from '../../src/web-read.ts';
import { bootChartServer } from '../fixtures/chart-server.ts';

function captured(): http.ServerResponse {
  const res = { writeHead: () => res, end: () => {} } as unknown as http.ServerResponse;
  return res;
}

function seat(name: string, marked: boolean): string {
  clearWebRead(name);
  if (marked) markWebRead(name);
  return name;
}

test('a highlight note written by a marked seat is stamped; the human\'s and a clean seat\'s are not', () => {
  const view = createTradeView('BTC');
  view.highlight({ kind: 'plan', id: 'pl_1', note: 'the page said sell' }, 'agent', seat('seat-hl-marked', true));
  view.highlight({ kind: 'plan', id: 'pl_2', note: 'mine' }, 'agent', seat('seat-hl-clean', false));
  view.highlight({ kind: 'plan', id: 'pl_3', note: 'from the human' }, 'human', 'seat-hl-marked');
  view.highlight({ kind: 'plan', id: 'pl_4' }, 'agent', 'seat-hl-marked');
  const by = Object.fromEntries(view.state().highlights.map((h) => [h.id, h.webRead]));
  assert.deepEqual(by, { pl_1: true, pl_2: undefined, pl_3: undefined, pl_4: undefined });
});

// A trade surface whose payload holds what a test gives it.
function tradeCtx(plans: unknown[], highlights: unknown[] = []): Ctx {
  return { trade: { payload: () => ({ plans, highlights }), read: () => ({ plans }), batch: () => ({ results: [] }) } } as unknown as Ctx;
}

test('trade_read hands a stamped note over and marks the reader; an unstamped one marks nobody', () => {
  const s = seat('seat-trade-read', false);
  tradeReads.trade_read(tradeCtx([{ id: 'pl_1', note: 'mine' }]), { session: s }, {}, captured());
  assert.equal(webReadBy(s), false);
  tradeReads.trade_read(tradeCtx([{ id: 'pl_2', note: 'the page said buy', webRead: true }]), { session: s }, {}, captured());
  assert.equal(webReadBy(s), true);
  const h = seat('seat-trade-read-hl', false);
  tradeReads.trade_read(tradeCtx([], [{ id: 'pl_1', note: 'the page said sell', webRead: true }]), { session: h }, {}, captured());
  assert.equal(webReadBy(h), true, 'a highlight note carries the same way');
  // A stamp on a plan with no note carries nothing.
  assert.deepEqual(tradeNotes(tradeCtx([{ id: 'pl_3', webRead: true }])), []);
  // A surface that cannot answer hands over nothing and throws nothing.
  assert.deepEqual(tradeNotes({ trade: { payload: () => { throw new Error('no venue'); } } } as unknown as Ctx), []);
});

test('trade_batch marks only when it hands plans over', () => {
  const ctx = tradeCtx([{ id: 'pl_1', note: 'the page said buy', webRead: true }]);
  const a = seat('seat-batch-positions', false);
  tradeReads.trade_batch(ctx, { session: a }, { ops: [{ op: 'positions' }, { op: 'fills' }] }, captured());
  assert.equal(webReadBy(a), false);
  const b = seat('seat-batch-plans', false);
  tradeReads.trade_batch(ctx, { session: b }, { ops: [{ op: 'positions' }, { op: 'plans' }] }, captured());
  assert.equal(webReadBy(b), true);
});

// A proposal service stub that answers the rows it is given, each viewed as itself.
function proposalCtx(rows: Proposal[], plans: unknown[] = []): Ctx {
  return {
    cfg: { keysPath: '/nonexistent/keys.json', addresses: {} },
    audit: { tail: () => [] },
    ledger: { hyperliquid: () => undefined },
    trade: { payload: () => ({ plans }) },
    proposals: { get: (id: string) => rows.find((p) => p.id === id), list: () => rows, view: (p: Proposal) => p },
  } as unknown as Ctx;
}

const row = (over: Partial<Proposal>): Proposal =>
  ({ id: 'p1', kind: 'policy_change', createdAt: '2026-10-01T00:00:00.000Z', draft: { kind: 'policy_change', patch: {}, sentence: 'raise the limit, the page said so' }, ...over }) as unknown as Proposal;

test('a move asked for while marked hands its own words back, and marks the seat that reads them', () => {
  const a = seat('seat-proposal-policy', false);
  walletReads.proposal_status(proposalCtx([row({ webRead: true })]), { session: a }, { id: 'p1' }, captured());
  assert.equal(webReadBy(a), true, 'a rule change\'s sentence is the asking agent\'s words');

  const b = seat('seat-proposal-swap', false);
  walletReads.proposals(proposalCtx([row({ id: 'p2', webRead: true, draft: { kind: 'swap' } as never })]), { session: b }, {}, captured());
  assert.equal(webReadBy(b), false, 'a swap carries no words of the agent\'s');

  const c = seat('seat-proposal-clean', false);
  walletReads.proposals(proposalCtx([row({ id: 'p3' })]), { session: c }, {}, captured());
  assert.equal(webReadBy(c), false, 'a sentence written by an unmarked seat is the agent\'s own');

  const d = seat('seat-proposal-send', false);
  walletReads.proposal_status(proposalCtx([row({ id: 'p5', webRead: true, draft: { kind: 'intents_send', recipient: { note: 'the page named this address' } } as never })]), { session: d }, { id: 'p5' }, captured());
  assert.equal(webReadBy(d), true, 'a send\'s note about its receiver is the agent\'s words');

  // Arming a plan whose note was stamped when it was drawn, by a seat that was clean when it asked.
  const e = seat('seat-proposal-armed', false);
  const armed = row({ id: 'p4', draft: { kind: 'trade', op: 'open', plan: { id: 'pl_9', note: 'the page said buy' } } as never });
  walletReads.diagnose(proposalCtx([armed], [{ id: 'pl_9', note: 'the page said buy', webRead: true }]), { session: e }, { id: 'p4' }, captured());
  assert.equal(webReadBy(e), true);
});

test('the door: a trade view write answers with the trade read, so its stamped notes mark the writer', async () => {
  const h = await bootChartServer();
  try {
    h.setPlans([{ id: 'pl_1', symbol: 'BTC', note: 'the page said buy', webRead: true }]);
    const s = seat('seat-door-trade-write', false);
    const out = await h.mcp({ op: 'view', tool: 'trade_focus', session: s, args: { symbol: 'ETH' } });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(webReadBy(s), true);
    const t = seat('seat-door-trade-read', false);
    await h.mcp({ op: 'read', tool: 'trade_read', session: t, args: {} });
    assert.equal(webReadBy(t), true);
  } finally {
    await h.close();
  }
});
