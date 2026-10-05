// The allowance's two window routes (PHASE2-PLAN.md C9): a top-up the person asks for, and the
// allowance's size.
//
// Both carry the window token through guarded() like every custody route, and neither is an op on
// /api/mcp: the agent spends the allowance and never fills it or sizes it (call 14). A top-up is
// only filed here: it lands pending, and the person's click and then the vault's own Touch ID run
// it (src/proposals/execute.ts proposeVaultTopUp, src/rails/vault-topup.ts). A smaller size sends
// what is now over it home at once (src/rails/allowance-sweep.ts).

import type http from 'node:http';

import type { Ctx } from './context.ts';
import { errText, fail, sendJson } from './respond.ts';
import { guarded } from './wallet.ts';

// POST /api/vault/allowance/top-up {usd, why?: 'low' | 'manual'} -> {ok, proposal}
export async function handleAllowanceTopUp(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/allowance/top-up', req, res);
  if (body === null) return;
  if (typeof body.usd !== 'number' || !Number.isFinite(body.usd)) return fail(res, 400, 'A top-up is an amount of dollars above zero. Nothing changed.');
  const propose = ctx.proposals.proposeVaultTopUp;
  if (propose === undefined) return fail(res, 409, 'This copy of Phosphor cannot top up an allowance. Nothing changed.');
  try {
    const proposal = await propose({ usd: body.usd, why: body.why === 'low' ? 'low' : 'manual' });
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, proposal });
  } catch (err) {
    fail(res, 400, errText(err));
  }
}

// POST /api/vault/allowance/size {usd} -> {ok, sizeUsd}
export async function handleAllowanceSize(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/allowance/size', req, res);
  if (body === null) return;
  if (typeof body.usd !== 'number' || !Number.isFinite(body.usd)) return fail(res, 400, 'The allowance size is an amount of dollars. Nothing changed.');
  const before = ctx.vaultPrefs.get().allowance.sizeUsd;
  let sizeUsd: number;
  try {
    sizeUsd = ctx.vaultPrefs.setAllowanceSize(body.usd).allowance.sizeUsd;
  } catch (err) {
    return fail(res, 400, `${errText(err)}. Nothing changed.`);
  }
  ctx.audit.append('app_start', `the allowance size is now $${sizeUsd.toFixed(2)} (it was $${before.toFixed(2)})`, { allowanceUsd: sizeUsd, before });
  ctx.sse.broadcastState();
  void ctx.proposals.sweepAllowance?.('size').catch(() => undefined);
  sendJson(res, 200, { ok: true, sizeUsd });
}
