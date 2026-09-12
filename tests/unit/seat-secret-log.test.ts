// The seat secret never enters the audit log.
//
// Every agent the app spawns carries this boot's seat secret (PHOSPHOR_SEAT, src/driver.ts) and
// the proxy sends it on the hello and on every tool call, because that is how a spawned agent
// proves it may take a reserved seat. The agent's door logs the hello and every call with the
// body verbatim, which is the right thing for arguments and the wrong thing for a credential:
// audit.jsonl is read back by log_tail, which every agent holds, worker included, and by
// GET /api/log, which any local process reads. A secret on that file is a secret every reader
// has, and with it the six-seat roster flood that RESERVED_SEATS exists to close is open again.
//
// The window token has the same shape of protection on the decision routes (only a fingerprint
// is ever logged, tests/unit/log-fingerprint.test.ts). This holds the seat secret to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

const SECRET = 'f'.repeat(64);
const TOKEN = 'e'.repeat(48);

test('the seat secret an agent presents is on no audit line, on the hello or on a call', async () => {
  const h = await bootChartServer();
  try {
    const hello = await h.mcp({ op: 'hello', session: 'spawned-agent', client: 'phosphor-mcp', intervalMs: 5000, secret: SECRET, label: 'worker' });
    assert.equal(hello.status, 200);
    const read = await h.mcp({ op: 'read', tool: 'policy_show', args: {}, session: 'spawned-agent', client: 'phosphor-mcp', secret: SECRET });
    assert.equal(read.status, 200);
    const view = await h.mcp({ op: 'view', tool: 'trade_focus', args: { symbol: 'ETH' }, session: 'spawned-agent', client: 'phosphor-mcp', secret: SECRET });
    assert.equal(view.status, 200);
    // A session that skipped hello joins on its first op, and that edge is logged too.
    const cold = await h.mcp({ op: 'read', tool: 'policy_show', args: {}, session: 'cold-agent', client: 'phosphor-mcp', secret: SECRET, token: TOKEN });
    assert.equal(cold.status, 200);

    const lines = h.audit.tail(50);
    assert.ok(lines.some((e) => e.type === 'agent_connected'), 'the hello left no line at all, so nothing here was tested');
    assert.ok(lines.some((e) => e.type === 'tool_call'));
    for (const e of lines) {
      const text = JSON.stringify(e);
      assert.ok(!text.includes(SECRET), `the seat secret is on a ${e.type} line: ${text.slice(0, 160)}`);
      assert.ok(!text.includes(TOKEN), `a token sent to the agent door is on a ${e.type} line`);
    }
    // The rest of the body is still the record: who called, and with what.
    const call = lines.find((e) => e.type === 'tool_call' && e.msg.includes('trade_focus'));
    assert.ok(call !== undefined);
    assert.equal((call.data as { session?: unknown }).session, 'spawned-agent');
    assert.deepEqual((call.data as { args?: unknown }).args, { symbol: 'ETH' });
  } finally {
    await h.close();
  }
});
