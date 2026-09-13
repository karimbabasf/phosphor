// A worker at every door it is not meant to have.
//
// The proxy never registers propose_*, chart_snapshot or the lead-only view tools for a worker
// (tests/injection.test.ts reads that surface back), and src/http/view.ts refuses the view tools
// by seat role behind it. This file is the same wall at the other two doors: a worker that
// reaches /api/mcp by hand, with its own session id and the right Origin, is refused by the role
// the roster gave it when the app spawned it, never by anything the body claims. The lead on the
// same server is answered as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

test('a worker seat cannot photograph the chart: chart_snapshot is refused at the read door by role, and the lead is not', async () => {
  const h = await bootChartServer();
  try {
    h.agents.markAnalyst('worker-1');
    const worker = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'worker-1', args: {} });
    assert.equal(worker.status, 403, JSON.stringify(worker.json));
    assert.match(String(worker.json.error), /worker/);
    // Claiming to be someone else in the body changes nothing: the role is the seat's.
    const dressed = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'worker-1', role: 'operator', args: {} });
    assert.equal(dressed.status, 403);
    // The reads a worker does hold still answer.
    const read = await h.mcp({ op: 'read', tool: 'chart_read', session: 'worker-1', args: {} });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    // And the lead gets the digest: no window is open in this test, and the answer says so.
    const lead = await h.mcp({ op: 'read', tool: 'chart_snapshot', session: 'lead-1', args: {} });
    assert.equal(lead.status, 200, JSON.stringify(lead.json));
    assert.match(String(lead.json.digest), /no window is open/);
  } finally {
    await h.close();
  }
});

test('a worker seat cannot propose: every kind is refused at the propose door by role before anything is drafted', async () => {
  const h = await bootChartServer();
  try {
    h.agents.markAnalyst('worker-2');
    for (const kind of ['trade', 'trade_change', 'swap', 'consolidate', 'policy_change', 'hl_deposit', 'intents_deposit', 'intents_withdraw']) {
      const out = await h.mcp({ op: 'propose', kind, session: 'worker-2', params: { plan: { symbol: 'ETH', side: 'long', sizeUsd: 20, leverage: 1, entry: { type: 'market' }, stop: 1 } } });
      assert.equal(out.status, 403, `${kind}: ${JSON.stringify(out.json)}`);
      assert.match(String(out.json.error), /worker/, kind);
    }
    // The fixture's proposal service throws on any call, so a lead reaching it is a 500 and a
    // lead refused on its arguments is a 400: either way, not the worker's 403.
    const lead = await h.mcp({ op: 'propose', kind: 'trade', session: 'lead-2', params: {} });
    assert.notEqual(lead.status, 403, JSON.stringify(lead.json));
    // Nothing the worker sent reached the audit as a proposal.
    const lines = h.audit.tail(200).map((e) => e.type);
    assert.ok(!lines.some((t) => t === 'proposal_created' || t === 'policy_refused' || t === 'executed'), lines.join(','));
  } finally {
    await h.close();
  }
});
