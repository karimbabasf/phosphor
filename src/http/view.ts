// The sixteen view tools: everything an agent can write that changes what the human sees and
// moves no money. Chart geometry, studies, levels, marks, trend lines, presets, the window's
// colours, the board, a spawned worker, and the trading surface's own overlays.
//
// They never reach the proposal path and never wait on an approval. They are still audited like
// every other op: an agent that can change what the human sees while that human approves a
// transfer is a surface, not a decoration.

import type http from 'node:http';

import { applyPatch as applyThemePatch } from '../view/theme.ts';
import { findPreset, presetCatalog } from '../presets.ts';
import { asRecord, fail, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { chartRead, resolveViewPatch } from './chart.ts';
import { VIEW_TOOLS } from './context.ts';
import type { Ctx } from './context.ts';

export async function handleView(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const tool = String(body.tool ?? '');
  const args = asRecord(body.args);

  // The trading surface's writes answer with the trading surface, the same way the chart's
  // answer with the chart: an agent that has to read after every write pays two round trips
  // to learn what its own change did.
  //
  // Answered FIRST, and that placement is the fix rather than tidying. This block used to sit
  // in the middle of the chart chain, which cut that chain in two: chart_set_view matched the
  // `if` above it, set `outcome`, then fell into the second chain, matched nothing there, and
  // was refused by the final else as an "unknown view tool: chart_set_view" that the same
  // sentence went on to list as known. Every chart write below the split worked; the one
  // above it was unreachable, and the error blamed the caller for the server's own break.
  if (tool.startsWith('trade_')) {
    let out: { ok: boolean; notes: string[]; error?: string };
    if (tool === 'trade_focus') out = ctx.trade.view.setFocus(args, 'agent');
    else if (tool === 'trade_highlight') out = ctx.trade.view.highlight(args, 'agent');
    else if (tool === 'trade_overlay') out = ctx.trade.view.setOverlay(args, 'agent');
    else if (tool === 'trade_note') out = ctx.trade.view.setNote(args, 'agent');
    else out = ctx.trade.view.clear(String(args.what ?? 'agent'));

    if (!out.ok) {
      fail(res, 400, out.error, { notes: out.notes });
      return;
    }
    // Focus moves the chart with it. A trading screen whose position panel and whose candles
    // disagree about which market is on screen is the one bug on this surface a person would
    // not catch, because both halves look right on their own.
    if (tool === 'trade_focus') {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const match = ctx.cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === symbol);
      if (match !== undefined) ctx.chart.setView({ product: match }, 'agent');
    }
    ctx.sse.broadcastTrade();
    ctx.sse.broadcastChart();
    sendJson(res, 200, { ok: true, notes: out.notes, trade: ctx.trade.read() });
    return;
  }

  // Colour, answered before the chart chain for the same reason the trading writes are:
  // it does not change the chart, so answering with the chart would be noise. It answers
  // with the theme it wrote, so an agent never has to read back to see its own change.
  if (tool === 'set_theme') {
    const result = applyThemePatch(ctx.theme.get(), args);
    if (!result.ok) {
      fail(res, 400, result.error);
      return;
    }
    ctx.theme.set(result.theme);
    // Audited like every other agent write. Recolouring the window is not a money move and
    // it IS a change to what a human sees while they decide about one, so it leaves a line.
    ctx.audit.append('theme_changed', `agent recoloured the window: ${result.notes.join('; ')}`, {
      theme: result.theme,
    });
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, notes: result.notes, theme: result.theme });
    return;
  }

  // Who is writing. With a roster rather than a seat, "an agent drew this" is no longer an
  // answer: it is what the tidy, the roster line and the human's "which of them did that"
  // all read. See Provenance in src/chart.ts.
  const by = String(body.session ?? '') || null;

  let outcome: { ok: boolean; notes: string[]; error?: string; id?: string; label?: string };
  if (tool === 'chart_set_view') {
    // Resolve what was asked for into what a venue lists, before the view records it.
    // Without this the view stores the raw string, so "bitcoin" charts correctly and
    // then labels itself BITCOIN, and an agent reading the view back gets a product id
    // no venue would recognise.
    const resolved = resolveViewPatch(ctx, args, true);
    if (resolved !== null) {
      fail(res, 400, resolved);
      return;
    }
    const before = ctx.chart.state().view.product;
    outcome = ctx.chart.setView(args, 'agent', by);
    // The chart store tidies its own levels, marks and trend lines on a product switch. The
    // drawing store is a separate file holding the same kind of object (see the note beside
    // createDrawingStore above), so the sweep has to reach it from here or half the agent's
    // work would survive onto an instrument it does not describe.
    const after = ctx.chart.state().view.product;
    if (outcome.ok && after !== before) {
      const swept = ctx.drawings.sweepForeign(after);
      if (swept > 0) {
        outcome.notes.push(`cleared ${swept} agent ${swept === 1 ? 'drawing' : 'drawings'} (zones and lines) anchored to ${before}`);
      }
    }
  } else if (tool === 'chart_add_indicator') outcome = ctx.chart.addIndicator(args, 'agent', by);
  else if (tool === 'chart_remove_indicator') outcome = ctx.chart.removeIndicator(String(args.id ?? args.type ?? ''));
  else if (tool === 'chart_level') outcome = ctx.chart.setLevel(args, 'agent', by);
  else if (tool === 'chart_mark') outcome = ctx.chart.setMark(args, 'agent', by);
  else if (tool === 'chart_trendline') outcome = ctx.chart.setTrendline(args, 'agent', by);
  else if (tool === 'chart_clear') {
    const what = String(args.what ?? 'agent');
    outcome = ctx.chart.clear(what, by);
    // Same argument as the sweep above: a clear that left the zones behind would leave the
    // human looking at a chart the agent believes it cleaned.
    if (outcome.ok) {
      const removed =
        what === 'mine'
          ? ctx.drawings.clear('agent', by)
          : what === 'agent' || what === 'stale'
            ? ctx.drawings.clear('agent')
            : what === 'all'
              ? ctx.drawings.clear()
              : 0;
      if (removed > 0) outcome.notes.push(`and ${removed} drawn ${removed === 1 ? 'object' : 'objects'} (zones and lines)`);
    }
  } else if (tool === 'chart_preset') {
    /* A study package, and the tidy that makes it always fit.
       The clear runs first and it clears only THIS agent's studies, so a package can never be
       refused by the pane cap and can never delete a colleague's or a human's work. What a
       human's overlays leave no room for is reported rather than forced in. */
    const preset = findPreset(args.name);
    if (preset === undefined) {
      sendJson(res, 200, {
        ok: true,
        presets: presetCatalog(),
        note: 'Call chart_preset again with one of these names. Applying one clears your own studies first.',
      });
      return;
    }
    const notes: string[] = [];
    const mine = by === null ? null : ctx.chart.state().indicators.filter((i) => i.source === 'agent' && i.by === by);
    // With no session to go on, the honest tidy is every agent's studies: an agent that
    // cannot name itself cannot own anything, and leaving the chart full would fail the
    // package on the cap, which is the outcome this whole path exists to prevent.
    const cleared = ctx.chart.clear(by === null ? 'agent' : 'mine', by);
    if (cleared.ok && (mine === null || mine.length > 0)) notes.push(...cleared.notes);
    for (const want of preset.indicators) {
      const added = ctx.chart.addIndicator({ type: want.type, params: want.params ?? {} }, 'agent', by);
      if (added.ok) notes.push(`${added.label ?? want.type} added`);
      else notes.push(`${want.type} not added: ${added.error ?? 'refused'}`);
    }
    outcome = { ok: true, notes: [`preset ${preset.name}`, ...notes] };
  } else if (tool === 'agent_post') {
    // A board post is not a chart write, but it belongs on this route: it is a write an agent
    // makes to a shared surface a human reads, and it is audited like every other one.
    const member = ctx.agents.member(body.session);
    const post = ctx.board.post({
      session: String(body.session ?? ''),
      label: member?.label ?? String(body.client ?? 'agent'),
      role: member?.role ?? 'operator',
      kind: args.kind,
      text: args.text,
    });
    ctx.audit.append('tool_call', `board: ${post.label} ${post.kind}`, { text: post.text });
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, post, board: ctx.board.list(10) });
    return;
  } else if (tool === 'agent_spawn') {
    const result = ctx.crew().spawn({
      brief: args.brief,
      label: args.label,
      parent: String(body.session ?? 'unnamed-session'),
      timeoutMs: args.timeoutMs,
    });
    if (!result.ok) {
      fail(res, 400, result.error);
      return;
    }
    ctx.audit.append('tool_call', `agent spawned a worker: ${result.job.label}`, {
      id: result.job.id,
      brief: result.job.brief,
    });
    ctx.sse.broadcastState();
    sendJson(res, 200, {
      ok: true,
      job: { id: result.job.id, label: result.job.label, state: result.job.state },
      note:
        'The worker is running. It answers once and stops. Collect it with agent_jobs; do not spin ' +
        'waiting for it, carry on with your own work and read it when you next need it.',
    });
    return;
  } else {
    fail(res, 400, `unknown view tool: ${tool}. known tools: ${VIEW_TOOLS.join(', ')}`);
    return;
  }

  if (!outcome.ok) {
    fail(res, 400, outcome.error, { notes: outcome.notes });
    return;
  }
  ctx.sse.broadcastChart();
  // Answer with the chart as it now stands. An agent that has to call chart_read after
  // every write spends two round trips learning what its own change did.
  sendJson(res, 200, {
    ok: true,
    id: outcome.id,
    notes: outcome.notes,
    chart: await chartRead(ctx),
  });
}
