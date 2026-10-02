// The two invite routes: check a code, and claim it into this wallet. docs/reference.md, "First
// run", describes them; the work is src/invite/claim.ts.
//
// Window only. Both carry the window token through guarded() like the custody routes, neither is
// an op on /api/mcp, and neither is a read tool: no agent reaches either, and tests/tool-surface.ts
// is what keeps the surface the same size. The code arrives in the body and goes no further than
// the claim service: these handlers never log, echo or throw with it, because the router's catch
// writes a thrown message to the audit log.

import type http from 'node:http';

import { sendJson } from './respond.ts';
import { guarded } from './wallet.ts';
import type { Ctx } from './context.ts';

export async function handleInviteCheck(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/invite/check', req, res);
  if (body === null) return;
  let answer;
  try {
    answer = await ctx.invites.check(body.code);
  } catch {
    answer = { ok: false, reason: 'offline' };
  }
  sendJson(res, 200, answer);
}

export async function handleInviteClaim(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/invite/claim', req, res);
  if (body === null) return;
  let answer;
  try {
    answer = await ctx.invites.claim(body.code);
  } catch {
    answer = { ok: false as const, reason: 'offline' as const };
  }
  sendJson(res, answer.ok ? 202 : 200, answer);
}
