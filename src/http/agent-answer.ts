// The person's answer to an agent started outside Phosphor: the one write the window's card makes.
//
// Carries the window token like every custody route, because the answer is a fact about the person
// at the window and nothing an agent can supply: the agent being asked about holds the seat secret,
// never the token. Allow lets that agent's moves run under the policy, as the app's own agent's
// do; Not now keeps every move it asks for waiting for a click. Both are audited.

import type http from 'node:http';

import type { Ctx } from './context.ts';
import { fail, sendJson } from './respond.ts';
import { guarded } from './wallet.ts';

export async function handleAgentAnswer(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/agents/answer', req, res);
  if (body === null) return;
  if (typeof body.allow !== 'boolean') {
    fail(res, 400, 'allow must be true or false');
    return;
  }
  if (!body.allow) {
    const member = ctx.agents.later(body.session);
    if (member === null) {
      fail(res, 404, 'that agent is no longer connected');
      return;
    }
    ctx.audit.append('agent_answered', `the person answered Not now to ${member.label}: its moves keep waiting for a click`, {
      client: member.client,
      label: member.label,
    });
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, allowed: false });
    return;
  }
  const out = ctx.agents.allow(body.session);
  if (!out.ok) {
    fail(res, 409, out.reason);
    return;
  }
  ctx.audit.append('agent_answered', `the person allowed ${out.member.label}: its moves run under the policy`, {
    client: out.member.client,
    label: out.member.label,
  });
  ctx.sse.broadcastState();
  sendJson(res, 200, { ok: true, allowed: true });
}
