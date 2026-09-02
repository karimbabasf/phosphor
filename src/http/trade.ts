// The human's controls on the trading window, and the window's own view writes.
//
// handleTradeAction is deliberately NOT reachable from /api/mcp: the agent has no verb for
// closing a position, and the way that is guaranteed is that the door it knocks on does not
// open onto this function. A check could be wrong; an absence cannot.

import type http from 'node:http';

import { sameOrigin, tokenMatches } from './auth.ts';
import { errText, fail, readBody, sendJson } from './respond.ts';
import { TRADE_ACTIONS } from './context.ts';
import type { Ctx } from './context.ts';

// The human's controls on the trading window. Deliberately NOT reachable from /api/mcp: the
// agent has no verb for closing a position, and the way that is guaranteed is that the door
// it knocks on does not open onto this function. A check could be wrong; an absence cannot.
export async function handleTradeAction(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await readBody(req);
  if (!parsed.ok) return fail(res, 400, parsed.error);
  const body = parsed.value;
  if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused');
  if (!tokenMatches(body.token, ctx.token)) {
    ctx.audit.append('approve_attempt_rejected', 'POST /api/trade/action rejected: bad approval token', {
      action: String(body.action ?? ''),
      tokenPresent: typeof body.token === 'string' && body.token.length > 0,
    });
    return fail(res, 403, 'invalid approval token');
  }

  const action = String(body.action ?? '');
  if (!TRADE_ACTIONS.includes(action)) {
    return fail(res, 400, `unknown action: ${action}. known: ${TRADE_ACTIONS.join(', ')}`);
  }

  const id = typeof body.id === 'string' ? body.id : undefined;
  const coin = typeof body.coin === 'string' ? body.coin : undefined;
  ctx.audit.append('tool_call', `human: ${action}${id ? ` ${id}` : ''}${coin ? ` ${coin}` : ''}`, {
    action,
    id,
    coin,
  });

  try {
    const result = await ctx.trade.action({ action, id, coin });
    ctx.audit.append(result.ok ? 'executed' : 'error', `${action}: ${result.detail}`, { action, id, coin });
    ctx.sse.broadcastTrade();
    ctx.sse.broadcastState();
    // `error` alongside `detail` on a failure, because the window builds the sentence it
    // shows from `payload.error`. Without it a refused close reached the human as
    // "/api/trade/action returned 400" and the venue's own words, which are the only part
    // that says what to do next, were dropped on the floor.
    // TRACK B: the two failure bodies below are the only ones on this surface that do not go
    // through fail(). The 400 is `{ ...result, error }` because the window reads the venue's own
    // fields beside the sentence, and the 500 is `{ ok: false, detail }` with no `error` at all.
    // Both are left exactly as they are: changing them changes what the window renders.
    sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ...result, error: result.detail });
  } catch (err) {
    ctx.audit.append('error', `${action} failed: ${errText(err)}`);
    sendJson(res, 500, { ok: false, detail: errText(err) });
  }
}

// The window's own view writes, the mirror of handleChartWrite. Same reasoning: one door per
// caller, so the browser uses this and an agent uses /api/mcp, and both land in one place.
export async function handleTradeWrite(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await readBody(req);
  if (!parsed.ok) return fail(res, 400, parsed.error);
  const body = parsed.value;
  if (!sameOrigin(req)) return fail(res, 403, 'cross-origin trade write refused');
  if (!tokenMatches(body.token, ctx.token)) return fail(res, 403, 'invalid approval token');

  const notes: string[] = [];
  for (const [key, apply] of [
    ['focus', (a: Record<string, unknown>) => ctx.trade.view.setFocus(a, 'human')],
    ['overlay', (a: Record<string, unknown>) => ctx.trade.view.setOverlay(a, 'human')],
    ['note', (a: Record<string, unknown>) => ctx.trade.view.setNote(a, 'human')],
  ] as const) {
    const arg = body[key];
    if (arg === undefined || arg === null || typeof arg !== 'object') continue;
    const out = apply(arg as Record<string, unknown>);
    if (!out.ok) return fail(res, 400, out.error);
    notes.push(...out.notes);
  }
  if (typeof body.clear === 'string') {
    const out = ctx.trade.view.clear(body.clear);
    if (!out.ok) return fail(res, 400, out.error);
    notes.push(...out.notes);
  }
  if (typeof body.focus === 'object' && body.focus !== null) {
    const symbol = String((body.focus as Record<string, unknown>).symbol ?? '').toUpperCase();
    const match = ctx.cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === symbol);
    if (match !== undefined) ctx.chart.setView({ product: match }, 'human');
    ctx.sse.broadcastChart();
  }
  ctx.sse.broadcastTrade();
  sendJson(res, 200, { ok: true, notes });
}
