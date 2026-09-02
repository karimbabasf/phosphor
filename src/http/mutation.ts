// The mutating routes: the lending loop's on/off switch, the browser's five token-checked
// writes (approve, refuse, kill, the yield withdrawal button, the driver), and the two pieces
// of app state an agent may set directly (the basic screen's coins, and which window is up).
//
// Everything on this surface either changes money or changes what the human sees while they
// decide about money, which is why every one of them is audited and every browser door carries
// the per-boot approval token.

import path from 'node:path';
import type http from 'node:http';

import type { ViewMode } from '../types.ts';
import { writeCoins, MAX_COINS, MIN_COINS } from '../view/coins.ts';
import { sameOrigin, tokenFingerprint, tokenMatches } from './auth.ts';
import { errText, fail, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { pollPrice } from './chart.ts';
import { PROJECT_DIR } from './context.ts';
import type { Ctx } from './context.ts';

// Starting and stopping the loop. It moves no money itself and gets no policy verdict,
// which puts it in the class of set_view_mode rather than of propose: what it changes is
// WHEN a proposal gets filed, not whether one can be. Every proposal the loop then files
// goes through the same engine, the same threshold and the same log an agent's does.
//
// Audited on both edges, because "who turned the bot on" is the first question anyone asks
// of a log after money moved without a click.
export function handleYieldAuto(ctx: Ctx, body: JsonBody, res: http.ServerResponse): void {
  if (!ctx.allocator) {
    fail(res, 400, 'no lending allocator is running in this app, so there is no loop to switch.');
    return;
  }
  if (typeof body.enabled !== 'boolean') {
    // No default, deliberately. A switch that defaults to one of its two states is a switch
    // an agent flips while trying to read it.
    fail(res, 400, 'enabled must be true or false');
    return;
  }
  const on = body.enabled;
  if (on) ctx.allocator.start();
  else ctx.allocator.stop();
  ctx.audit.append(
    'tool_call',
    on
      ? 'yield_auto ON: the lending loop may now file its own deposit proposals'
      : 'yield_auto OFF: the lending loop will file nothing further',
    { enabled: on },
  );
  ctx.sse.broadcastState();
  const view = ctx.allocator.view();
  sendJson(res, 200, { ok: true, autoAllocate: view.autoAllocate, lastTickAt: view.lastTickAt });
}

export async function handleMutation(
  ctx: Ctx,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const parsed = await readBody(req);
  const body = parsed.ok ? parsed.value : {};
  const id = typeof body.id === 'string' ? body.id : null;

  const reason = !parsed.ok
    ? parsed.error
    : !sameOrigin(req)
      ? 'cross-origin request'
      : !tokenMatches(body.token, ctx.token)
        ? typeof body.token === 'string' && body.token.length > 0
          ? 'wrong approval token'
          : 'approval token missing'
        : null;

  if (reason !== null) {
    // The supplied token itself never enters the audit log. Its SHA-256 prefix does, and that
    // is the difference between "a token was rejected" and "which client is holding which
    // token": two rejections sharing a fingerprint are one stale page retrying, and a
    // fingerprint that matches no boot this app has served is a client that never had one.
    // The same argument covers origin and agent: a rejection that cannot say who sent it
    // cannot tell a human reloading a dead tab apart from something hammering the endpoint.
    const supplied = typeof body.token === 'string' ? body.token : '';
    ctx.audit.append('approve_attempt_rejected', `POST ${route} rejected: ${reason}`, {
      route,
      id,
      reason,
      tokenPresent: supplied.length > 0,
      tokenFp: supplied === '' ? null : tokenFingerprint(supplied),
      expectedFp: tokenFingerprint(ctx.token),
      origin: req.headers.origin ?? '(absent)',
      agent: String(req.headers['user-agent'] ?? '(absent)').slice(0, 120),
    });
    fail(res, parsed.ok ? 403 : parsed.status, parsed.ok ? 'invalid approval token' : reason);
    return;
  }

  if (route === '/api/driver') {
    const action = String(body.action ?? '');

    /* The connection line for THIS installation, plus who is already on the door. It is
       checked before the chat is resolved because, like the plus, it is not ABOUT a chat.

       It used to live in a menu bar item on the packaged app only, which meant a person
       running from a terminal had to read a README to find the one string they needed. It
       reads nothing secret: an absolute path to a file already on this disk, and the names
       external clients chose for themselves. Those names are agent-authored and the window
       renders them as text, never as markup, exactly as it does the roster. */
    if (action === 'connection') {
      return sendJson(res, 200, {
        command: `claude mcp add phosphor -- node ${path.join(PROJECT_DIR, 'src/mcp.ts')}`,
        connected: ctx.agents.roster().map((member) => ({
          name: member.client || member.label || member.session,
          role: member.role,
          calls: member.ops,
        })),
      });
    }

    /* The plus, and it is checked before the chat is resolved because it is the one action
       that is not ABOUT an existing chat. */
    if (action === 'open') {
      const opened = ctx.chats.open();
      if (!opened.ok) return fail(res, 409, opened.error);
      return sendJson(res, 200, {
        ok: true,
        id: opened.chat.id,
        label: opened.chat.label,
        ...opened.chat.driver.status(),
      });
    }

    /* Naming a chat that is not open is refused rather than quietly redirected. Falling back
       to the first chat would send a sentence a human typed into one conversation to a
       different agent, which is the failure this whole tagging exercise exists to prevent. */
    const named = body.chat === undefined || body.chat === null || body.chat === '' ? null : ctx.chats.byId(body.chat);
    if (body.chat !== undefined && body.chat !== null && body.chat !== '' && named === null) {
      return fail(res, 404, `no chat ${String(body.chat)} is open`);
    }
    const chat = named ?? ctx.chats.primary();
    const instance = chat.driver;

    if (action === 'start') {
      /* THE GLOBE MEANS TWO DIFFERENT THINGS AND THE DIFFERENCE IS WHICH TAB IT IS ON.
         On the first and only conversation it still means "start over with your own agent",
         which clears the roster: a human pressing it while three terminals are attached is
         asking for one agent, not for a fourth. On a second tab it cannot mean that, because
         the roster it would clear holds the chat sitting next to this one. So the evicting
         path runs only when there is nothing else here to kill. */
      const sole = ctx.chats.size() <= 1;
      if (sole) {
        const dropped = ctx.chats.start('human');
        return sendJson(res, 200, { ok: true, dropped, id: chat.id, ...chat.driver.status() });
      }
      instance.start();
      ctx.sse.broadcastState();
      return sendJson(res, 200, { ok: true, dropped: null, id: chat.id, ...instance.status() });
    }

    if (action === 'close') {
      ctx.chats.close(chat);
      return sendJson(res, 200, { ok: true, id: chat.id });
    }

    if (action === 'prompt') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') return fail(res, 400, 'text is required');
      if (text.length > 8000) return fail(res, 400, 'text is too long: 8000 characters maximum');
      try {
        instance.send(text);
      } catch (err) {
        return fail(res, 409, errText(err));
      }
      /* Logged before anything the agent does with it. The dashcam is supposed to answer
         "why did this happen", and the tool calls alone only answer "what happened": a swap
         in the transcript with no instruction above it reads as the app acting on its own. */
      ctx.audit.append('driver_prompt', `human to ${chat.label}: ${text}`, { chars: text.length, chat: chat.id });
      ctx.chats.event(chat, { kind: 'said', text });
      return sendJson(res, 200, { ok: true, id: chat.id, ...instance.status() });
    }

    /* Stop the answer, not the agent. A separate action from `stop` because they are separate
       intentions and the app should never make a human choose the destructive one to get the
       cheap one: `interrupt` ends the turn in flight and keeps the conversation, `stop` ends
       the session and throws it away. It is audited like everything else, because "the agent
       went quiet halfway through" is a question somebody will ask the log later. */
    if (action === 'interrupt') {
      const stopped = instance.interrupt();
      /* No driverEvent here. interrupt() sets the state itself and the driver's own status
         event is already on its way through onEvent, so pushing a second one printed the
         line twice in the window. Seen doing exactly that on the live app. */
      if (stopped) {
        ctx.audit.append('driver_prompt', `the human stopped the answer in progress (${chat.label})`, {
          interrupted: true,
          chat: chat.id,
        });
      }
      return sendJson(res, 200, { ok: true, id: chat.id, interrupted: stopped, ...instance.status() });
    }

    if (action === 'stop') {
      instance.stop();
      ctx.audit.append('app_start', `in-app driver stopped by the human (${chat.label})`, { chat: chat.id });
      ctx.sse.broadcastState();
      return sendJson(res, 200, { ok: true, id: chat.id, ...instance.status() });
    }

    return fail(res, 400, `unknown driver action: ${action}`);
  }

  if (route === '/api/yield/withdraw') {
    // The button in the window, and the ONLY thing on this route.
    //
    // It files a yield_withdraw proposal exactly as the allocator would and then stops. It
    // does not approve it and it cannot: above the click threshold the proposal waits in
    // the same gate every other one waits in, and below it the policy engine decides. This
    // is not a second path to the money, it is the same path with a human at the front.
    //
    // No amount is accepted from the request. Omitting it means the whole position, which
    // is the only withdrawal that cannot leave dust behind on a balance that grows every
    // block, and an amount on the wire would be a number this route would have to trust.
    const chain = typeof body.chain === 'string' ? body.chain : '';
    if (chain !== 'eth' && chain !== 'base' && chain !== 'arb') {
      fail(res, 400, `chain must be one of eth, base, arb; got '${chain}'`);
      return;
    }
    try {
      const proposal = await ctx.proposals.proposeYieldWithdraw({ chain });
      ctx.sse.broadcastState();
      sendJson(res, 200, proposal);
    } catch (err) {
      fail(res, 400, errText(err));
    }
    return;
  }

  if (route === '/api/kill') {
    const on = body.on === true;
    ctx.setKill(on);
    ctx.audit.append(
      'kill_switch',
      on ? 'KILL SWITCH ON: all writes refused (human)' : 'kill switch off: writes allowed again, subject to policy (human)',
      { on },
    );
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, killSwitch: on });
    return;
  }

  if (id === null) {
    fail(res, 400, 'id is required');
    return;
  }

  /* Re-checking an unknown outcome is neither an approval nor a refusal: it decides nothing and
     signs nothing, it only asks the chain what already happened. It carries the window token
     anyway, because it is a browser write that changes a row a human is reading. */
  if (route === '/api/reconcile') {
    try {
      const proposal = await ctx.proposals.reconcile(id);
      ctx.sse.broadcastState();
      sendJson(res, 200, { ok: true, status: proposal.status, detail: proposal.result?.detail ?? null, id: proposal.id });
    } catch (err) {
      fail(res, 400, errText(err));
    }
    return;
  }

  try {
    // approve() and refuse() own their own audit trail and any execution.
    const proposal = route === '/api/approve' ? await ctx.proposals.approve(id) : await ctx.proposals.refuse(id);
    ctx.sse.broadcastState();
    sendJson(res, 200, proposal);
  } catch (err) {
    fail(res, 400, errText(err));
  }
}

// The one piece of app state an agent writes directly, and the only agent-reachable
// thing that changes what a HUMAN sees. It moves no money and gets no policy verdict,
// so it is neither a read nor a propose.
//
// WHAT THE REFUSAL BELOW BUYS, EXACTLY. It stops the surface changing under a decision
// someone is in the middle of making: no moving the YES button while they read.
// It does NOT stop an agent choosing which surface a decision happens on, because
// nothing prevents calling this first and proposing after, and a proposal under the
// click threshold never becomes 'pending' at all (it goes straight to executed with
// decidedBy 'policy'). That ordering is inherent to agent-only switching, which is why
// the real control is that both modes render the same facts, asserted in
// tests/unit/basic-view.test.ts, not this refusal.
// Aliases exist because the switch is meant to cost one word. A human says "switch to
// trading", "go to hft", "back to simple"; an agent should not have to learn which of those
// is the enum member. Mapping them here rather than in src/mcp.ts keeps the shim stateless
// and means the /api/mcp path and the MCP path resolve a name identically.
const VIEW_ALIASES: Record<string, ViewMode> = {
  basic: 'basic',
  simple: 'basic',
  plain: 'basic',
  pro: 'pro',
  operator: 'pro',
  advanced: 'pro',
  wallet: 'pro',
  trade: 'trade',
  trading: 'trade',
  hft: 'trade',
  perps: 'trade',
  hyperliquid: 'trade',
  chart: 'trade',
};

// The coins the basic screen tracks. Karim, 2026-08-14: "if I don't want Bitcoin, on
// Ether it changes to whatever I ask it to change it to, and it's saved as my current
// favorites". The eye on that screen tells the owner this can be asked for, so the ask
// has to work: a tooltip promising a capability that does not exist is the same class of
// fault as a balance the app cannot back.
//
// Names go through the market catalog rather than being trusted, so "bitcoin", "btc" and
// "BTC-USD" all land on one product id and a coin nothing can chart is refused with the
// reason rather than accepted into a screen that would then show a blank row forever.
export async function handleSetBasicCoins(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const raw = Array.isArray(body.coins) ? body.coins : [];
  const asked = raw.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0);

  if (asked.length < MIN_COINS || asked.length > MAX_COINS) {
    fail(
      res,
      400,
      `the basic screen shows ${MIN_COINS} to ${MAX_COINS} coins, got ${asked.length}`,
      { coins: ctx.prices.coins },
    );
    return;
  }

  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const name of asked) {
    const ref = ctx.market.resolve(name);
    if (ref === null) unknown.push(name);
    else if (!resolved.includes(ref.product)) resolved.push(ref.product);
  }
  if (unknown.length > 0) {
    fail(
      res,
      400,
      `not a market this app can chart: ${unknown.join(', ')}`,
      { coins: ctx.prices.coins, hint: 'read market_search to find the id, then set that' },
    );
    return;
  }

  const previous = ctx.prices.coins;
  if (previous.join() === resolved.join()) {
    sendJson(res, 200, { ok: true, coins: resolved, unchanged: true });
    return;
  }

  ctx.prices.coins = resolved;
  writeCoins(ctx.cfg.dataDir, resolved);
  // Blank rather than stale while the new coins are fetched. The screen renders a coin
  // it has no price for as absent, so the band goes short for one poll instead of
  // showing the old coin's figure under the new coin's name.
  ctx.prices.readings = resolved.map(() => null);
  ctx.audit.append('view_changed', `agent set the basic screen coins to ${resolved.join(', ')}`, {
    from: previous,
    to: resolved,
  });
  ctx.sse.broadcastState();
  await pollPrice(ctx);
  ctx.sse.broadcastState();
  sendJson(res, 200, {
    ok: true,
    coins: resolved,
    from: previous,
    note: 'saved. this is what the basic screen shows until it is asked to change again',
  });
}

export function handleSetViewMode(ctx: Ctx, body: JsonBody, res: http.ServerResponse): void {
  const raw = String(body.mode ?? '').trim().toLowerCase();
  const mode = VIEW_ALIASES[raw];
  if (mode === undefined) {
    fail(
      res,
      400,
      `mode must be basic, pro or trade, got: ${raw || '(missing)'}`,
      { accepted: Object.keys(VIEW_ALIASES) },
    );
    return;
  }

  // This used to refuse outright while any proposal was pending, so that an agent could not
  // move a human away from a decision they were in the middle of. Commit 7b41af4 put the
  // approval block on the trading window too, and ui/screens/decision.js now renders it on all
  // three surfaces, so the reason the refusal existed no longer holds: the decision follows
  // the human rather than being left behind on the screen they came from.
  //
  // What replaces it is disclosure, not silence. The pending ids ride back on the response
  // and the tool description tells the agent to say the count out loud, because the basic
  // screen shows one ask at a time and switching there with three waiting would otherwise
  // quietly hide two of them.
  const pending = ctx.proposals.list().filter((p) => p.status === 'pending');
  const previous = ctx.getView();
  if (mode === previous) {
    sendJson(res, 200, { ok: true, view: mode, unchanged: true, pending: pending.map((p) => p.id) });
    return;
  }
  ctx.setView(mode);
  ctx.audit.append('view_changed', `agent switched the app window from ${previous} to ${mode}`, {
    from: previous,
    to: mode,
    pending: pending.map((p) => p.id),
  });
  ctx.sse.broadcastState();
  sendJson(res, 200, {
    ok: true,
    view: mode,
    from: previous,
    pending: pending.map((p) => p.id),
    // Named rather than implied: an agent reading `pending: []` has to know that an empty
    // array is the good case. A sentence it can repeat costs nothing and gets repeated.
    note:
      pending.length === 0
        ? 'nothing is waiting for a human decision'
        : `${pending.length} proposal(s) still await a human click, and they render on this window too`,
  });
}
