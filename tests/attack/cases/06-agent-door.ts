// The agent door. agent.secret sits in the data dir, readable by any process running as this user.
// Such a process reads it, seats itself through the by-hand MCP proxy (an OUTSIDE seat), and asks
// for a small swap, far under the $100 click line. The defense: an OUTSIDE seat starts marked, so
// every move it proposes waits for a human click whatever its size, with its own reason. The person
// then Allows that one process from the window (the window token, which no agent holds); its next
// small move runs on the policy. A second process that read the same file is a different proxy
// with a different key, so the Allow does not cover it: its move still waits.

import assert from 'node:assert/strict';
import { bootBackend, rmTemp, sleep, type Backend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';
import { OUTSIDE_REASON } from '../../../src/web-read.ts';

type Member = { session: string; client: string; origin: string; allowed: boolean; askable: boolean; later: boolean };

async function member(app: Backend, client: string): Promise<Member | undefined> {
  for (let i = 0; i < 20; i++) {
    const st = (await app.get('/api/state')).json;
    const m = (st?.agents?.members as Member[] | undefined)?.find(x => x.client === client);
    if (m) return m;
    await sleep(100);
  }
  return undefined;
}

async function stored(app: Backend, id: string): Promise<any> {
  const page = (await app.get('/api/proposals')).json;
  return (page?.proposals as any[] | undefined)?.find(p => p.id === id);
}

export const attack: AttackCase = {
  id: '06-agent-door',
  title: 'a same-user process seats itself off agent.secret: its small move waits for a click; Allow covers only that process',
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    const a = await app.mcpOutside('door-attacker-a');
    let b: Awaited<ReturnType<Backend['mcpOutside']>> | null = null;
    try {
      await app.callTool(a.client, 'start', {});
      const ma = await member(app, 'door-attacker-a');
      assert.ok(ma, 'attacker A never showed in the roster');
      assert.deepEqual([ma.origin, ma.allowed, ma.askable], ['outside', false, true], `A seated as ${JSON.stringify(ma)}`);

      // 1. The attack: a $5 swap from the OUTSIDE seat, 20x under the click line.
      const p1 = await app.callTool(a.client, 'propose_swap', { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '5' });
      assert.equal(p1?.status, 'pending', `A's small swap was not held: ${JSON.stringify(p1).slice(0, 300)}`);
      assert.equal(p1.verdict?.outcome, 'needs_approval');
      assert.equal(p1.verdict.reasons.at(-1), OUTSIDE_REASON, `held for another reason: ${JSON.stringify(p1.verdict.reasons)}`);
      const s1 = await app.callTool(a.client, 'proposal_status', { id: p1.id });
      assert.equal(s1?.stage, 'waiting_for_you');
      assert.equal(s1?.reason?.details, OUTSIDE_REASON);
      const r1 = await stored(app, p1.id);
      assert.equal(r1?.status, 'pending');
      assert.equal(r1?.outside, true);

      // The attacker cannot answer its own card: the answer route wants the window token.
      const self = await app.post('/api/agents/answer', { session: ma.session, allow: true });
      assert.equal(self.status, 403, `answer without the token: ${self.status} ${self.text}`);
      assert.equal((await member(app, 'door-attacker-a'))?.allowed, false);

      // 2. The human Allows A from the window.
      const yes = await app.post('/api/agents/answer', { token: app.token, session: ma.session, allow: true });
      assert.equal(yes.status, 200, yes.text);
      assert.equal((await member(app, 'door-attacker-a'))?.allowed, true);
      // A different coin, so the in-flight guard on USDC does not hold it for its own reason.
      const p2 = await app.callTool(a.client, 'propose_swap', { fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: '0.02' });
      assert.equal(p2?.verdict?.outcome, 'allow', `A after Allow: ${JSON.stringify(p2).slice(0, 300)}`);
      assert.notEqual(p2.status, 'pending');
      const r2 = await stored(app, p2.id);
      assert.equal(r2?.decidedBy, 'policy');

      // 3. A second process reads the same agent.secret. The Allow was bound to A's key, not to it.
      b = await app.mcpOutside('door-attacker-b');
      await app.callTool(b.client, 'start', {});
      const mb = await member(app, 'door-attacker-b');
      assert.ok(mb, 'attacker B never showed in the roster');
      assert.deepEqual([mb.origin, mb.allowed], ['outside', false], `B seated as ${JSON.stringify(mb)}`);
      const p3 = await app.callTool(b.client, 'propose_swap', { fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '0.001' });
      assert.equal(p3?.status, 'pending', `B's small swap was not held: ${JSON.stringify(p3).slice(0, 300)}`);
      assert.equal(p3.verdict.reasons.at(-1), OUTSIDE_REASON);
      const r3 = await stored(app, p3.id);
      assert.equal(r3?.status, 'pending');
      assert.equal((await member(app, 'door-attacker-a'))?.allowed, true, 'A lost its Allow');

      // The audit trail tells the same story.
      const log = await app.auditLog(200);
      const allowed = log.filter((l: any) => l.type === 'agent_answered').map((l: any) => String(l.msg));
      assert.deepEqual(allowed, ['the person allowed door-attacker-a: its moves run under the policy']);

      const usd = (p: any) => String(p?.view?.money?.amountIn ?? '');
      return {
        expected: "OUTSIDE seat's $5 swap held pending with OUTSIDE_REASON; token-less self-Allow 403; after the window's Allow A's next small move runs on the policy; a second proxy B stays unallowed and its small move is held",
        observed: `A ${usd(p1)} USDC swap: ${p1.status} (${s1.stage}); self-Allow ${self.status}; window Allow ${yes.status}; A after Allow: ${p2.status}/${r2.decidedBy}; B: allowed=${mb.allowed}, its swap ${p3.status}; audit agent_answered x${allowed.length}`,
        pass: true,
        evidence: `MCP propose_swap(A) -> status=pending reasons[-1]="${p1.verdict.reasons.at(-1)}"; POST /api/agents/answer -> 200; propose_swap(A) -> ${p2.status} decidedBy=${r2.decidedBy}; propose_swap(B) -> ${p3.status}; /api/state members=${JSON.stringify([[ma.client, 'allowed=true'], [mb.client, `allowed=${mb.allowed}`]])}`,
      };
    } finally {
      await a.close();
      if (b) await b.close();
      await app.stop();
      rmTemp(app.home);
      rmTemp(app.dataDir);
    }
  },
};

export default attack;
