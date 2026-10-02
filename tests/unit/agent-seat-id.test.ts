// One seat, one id (audit 2026-10-01, HIGH: "an outside or local-secret seat defeats the asks-once
// gate by sending a session string the roster rewrites").
//
// The roster keys a seat on the session cleaned of control characters, trimmed and cut to 64, and
// marks an outside seat under that id. The door used to hand the RAW string on: the propose door
// recorded it as the row's `by`, the stranger-read mark keyed off it, and the mark lookups found
// nothing under it. A file-secret holder that sent "seat " or "seat\u0007" or 70 characters was
// seated and marked as one id and proposed as another, and its small swap ran with no click.
// Since then the door replaces the session with the seat's own id before anything else reads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Rail } from '../../src/types.ts';
import { OUTSIDE_REASON, allowOutside, clearWebRead, outsideBy } from '../../src/web-read.ts';
import { bootChartServer } from '../fixtures/chart-server.ts';
import { makeCtx } from './helpers/proposals.ts';

const HAND = 'h'.repeat(64);
const KEY = 'k'.repeat(64);

function swapRail(executed: string[]): Rail {
  return {
    kind: 'swap',
    valueUsd: () => 0,
    async simulate() {
      return { ok: true, summary: 'scripted rail: nothing was simulated' };
    },
    async execute(draft) {
      executed.push(draft.kind);
      return { ok: true, detail: 'scripted swap', txids: ['0xswap'] };
    },
  };
}

const SWAP = { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', minAmountOut: 1 };

// Each raw session string the audit sent, and the one id the roster seats it as.
const VARIANTS: Array<{ name: string; raw: string | undefined; id: string }> = [
  { name: 'a trailing space', raw: 'seat-id-space ', id: 'seat-id-space' },
  { name: 'a leading space', raw: ' seat-id-lead', id: 'seat-id-lead' },
  { name: 'a control character', raw: 'seat-id-ctl\u0007', id: 'seat-id-ctl' },
  { name: 'over 64 characters', raw: `seat-id-long-${'x'.repeat(80)}`, id: `seat-id-long-${'x'.repeat(51)}` },
  // Cut at 64 right after a space: the id is trimmed again, so it cleans to itself.
  { name: 'a cut that lands on a space', raw: `${'c'.repeat(63)} tail`, id: 'c'.repeat(63) },
  { name: 'no session at all', raw: undefined, id: 'unnamed-session' },
];

for (const v of VARIANTS) {
  test(`regression: an outside seat whose session is sent with ${v.name} still waits for the click`, async () => {
    const executed: string[] = [];
    const m = makeCtx({ rails: [swapRail(executed)], intentsUsdc: 1000 });
    const h = await bootChartServer({ proposals: m.svc, handSeat: HAND });
    // The fixture seats 'unnamed-session' as the app's own; a caller with no session takes it here.
    if (v.raw === undefined) h.agents.release({ session: 'unnamed-session' });
    const as = (body: Record<string, unknown>) =>
      h.post('/api/mcp', { client: 'claude-code', secret: HAND, key: KEY, ...(v.raw === undefined ? {} : { session: v.raw }), ...body });
    try {
      assert.equal((await as({ op: 'hello', intervalMs: 5000 })).status, 200);
      const members = (await h.get('/api/state')).json.agents.members as Array<Record<string, unknown>>;
      const seat = members.find((x) => x.origin === 'outside');
      assert.equal(seat?.session, v.id, 'the roster seated another id');
      assert.equal(seat?.allowed, false);
      assert.equal(outsideBy(v.id), true);

      const r = await as({ op: 'propose', kind: 'swap', params: { ...SWAP, amountIn: '20' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const p = await m.svc.settled(String(r.json.id), 5000);
      assert.equal(p.status, 'pending', `ran with no click: ${JSON.stringify(p.verdict)}`);
      assert.equal(p.outside, true);
      assert.equal(p.verdict.reasons.at(-1), OUTSIDE_REASON);
      assert.equal(p.by, v.id, 'the row names another seat than the one the roster marked');
      assert.deepEqual(executed, []);

      // The record says the same id the roster checked.
      const call = h.audit.tail(200).find((e) => e.type === 'tool_call' && e.msg === 'agent: propose swap');
      assert.equal((call?.data as { session?: unknown } | undefined)?.session, v.id);

      // The person's Allow, given to the id the window shows, reaches the seat that proposes.
      const yes = await h.post('/api/agents/answer', { token: h.token, session: v.id, allow: true });
      assert.equal(yes.status, 200, JSON.stringify(yes.json));
      const after = await as({ op: 'propose', kind: 'swap', params: { ...SWAP, amountIn: '21' } });
      assert.equal(after.status, 200, JSON.stringify(after.json));
      assert.equal((await m.svc.settled(String(after.json.id), 5000)).status, 'executed');
      assert.deepEqual(executed, ['swap']);
    } finally {
      await h.close();
      allowOutside(v.id);
      clearWebRead(v.id);
    }
  });
}
