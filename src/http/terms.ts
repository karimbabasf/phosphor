// The one write the terms screen makes: the person clicked Accept.
//
// Carries the window token like every custody route, because the acceptance is a fact about
// the person at the window and nothing an agent can supply. The audit log gets a line with the
// version, so the transcript says when the terms were agreed to and to which text.

import type http from 'node:http';

import type { Ctx } from './context.ts';
import { sendJson } from './respond.ts';
import { guarded } from './wallet.ts';

export async function handleTermsAccept(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/terms/accept', req, res);
  if (body === null) return;
  const terms = ctx.terms.accept();
  ctx.audit.append('terms_accepted', `the terms of use dated ${terms.version} were accepted in the window`, {
    version: terms.version,
    acceptedAt: terms.acceptedAt,
  });
  ctx.sse.broadcastState();
  sendJson(res, 200, { ok: true, ...terms });
}
