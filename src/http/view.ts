// The view tools: everything an agent can write that changes what the human sees and moves no
// money. The chart's one write, the layout of charts, the window's colours, the board, a
// spawned worker, the trading surface's own overlays, and a plan drawn as an idea.
//
// They never reach the proposal path and never wait on an approval. They are still audited like
// every other op: an agent that can change what the human sees while that human approves a
// transfer is a surface, not a decoration.
//
// A TABLE, not a chain of `else if`. The chain here broke exactly once and the break is worth
// restating, because it is the argument for the shape: the trading block was added in the middle
// of the chart branches, which cut that chain in two. `chart_set_view` matched the `if` above the
// split, set `outcome`, fell into the second chain, matched nothing, and was refused by the final
// else as an "unknown view tool: chart_set_view" that the same sentence went on to list as known.
// Every chart write below the split worked; the one above it was unreachable, and the error
// blamed the caller for the server's own break. A table cannot do that: a key is present or it is
// not, and the list of keys IS the dispatch rather than a comment beside it.

import type http from 'node:http';

import { applyPatch as applyThemePatch } from '../view/theme.ts';
import { findPreset, PRESETS } from '../presets.ts';
import { isConcept, loadProfile, normalizeConcept, recordLearned } from '../profile/index.ts';
import type { Outcome } from '../chart.ts';
import type { ChartSlot } from '../charts.ts';
import { asRecord, fail, sendJson } from './respond.ts';
import { CHAIN_NETWORKS, isChainNetwork, transaction, validateHash } from '../chainscan/index.ts';
import type { JsonBody } from './respond.ts';
import { chartDigest, resolveIndicator, resolveViewPatch } from './chart.ts';
import { LEAD_ONLY_VIEW_TOOLS, VIEW_TOOLS } from './context.ts';
import type { Ctx } from './context.ts';

type ViewArgs = {
  ctx: Ctx;
  args: JsonBody;
  body: JsonBody;
  res: http.ServerResponse;
  // Who is writing. With a roster rather than a seat, "an agent drew this" is no longer an
  // answer: it is what the tidy, the roster line and the human's "which of them did that" all
  // read. See Provenance in src/chart.ts.
  by: string | null;
};

// Every handler answers on `res` itself. The chart's one write answers with a digest, the
// trading surface's writes answer with the trading surface, and everything else with its own
// thing, so an agent never has to read after a write to learn what its own change did.
type ViewHandler = (a: ViewArgs) => void | Promise<void>;

// The trading surface's writes answer with the trading surface, the same way the chart's answer
// with the chart: an agent that has to read after every write pays two round trips to learn what
// its own change did.
function tradeWrite(apply: (a: ViewArgs) => Outcome): ViewHandler {
  return ({ ctx, args, res, ...rest }): void => {
    const out = apply({ ctx, args, res, ...rest });
    if (!out.ok) {
      fail(res, 400, out.error, { notes: out.notes });
      return;
    }
    ctx.sse.broadcastTrade();
    ctx.sse.broadcastChart();
    sendJson(res, 200, { ok: true, notes: out.notes, trade: ctx.trade.read() });
  };
}

// Which of the charts a call means. Absent is the primary; a number outside the slots, or one
// no layout has filled, is answered by name so the agent learns which tool puts a chart there.
export function slotOf(ctx: Ctx, raw: unknown): { ok: true; slot: ChartSlot } | { ok: false; error: string } {
  const n = raw === undefined || raw === null ? 0 : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3) return { ok: false, error: `chart must be 0 to 3, got ${String(raw)}` };
  const slot = ctx.charts.slot(n);
  if (slot === null) return { ok: false, error: `no chart in slot ${n}; chart_layout puts one there` };
  return { ok: true, slot };
}

type IndicatorReq = { type: string; params?: Record<string, number> };

function indicatorReqs(raw: unknown): IndicatorReq[] {
  if (!Array.isArray(raw)) return [];
  const out: IndicatorReq[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const params: Record<string, number> = {};
    if (r.params !== null && typeof r.params === 'object') {
      for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) if (typeof v === 'number') params[k] = v;
    }
    out.push({ type: String(r.type ?? ''), params });
  }
  return out;
}

function rows(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object') : [];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// The one chart write. Everything the old ten tools did, in one call, applied in a fixed order:
// clear, view, indicators, levels, marks, lines, zones. One entry failing is named under
// `refused` and the rest still lands, because a whole markup refused for one bad level is a
// model turn wasted, and the answer is a digest rather than the read: the agent asked for what
// it drew, not for a re-statement of the chart.
async function chartDraw({ ctx, args, res, by: session }: ViewArgs): Promise<void> {
  const found = slotOf(ctx, args.chart);
  if (!found.ok) {
    fail(res, 400, found.error);
    return;
  }
  const { slot } = found;
  const chart = slot.store;
  const refused: string[] = [];
  const notes: string[] = [];
  // The chart store keeps 64 characters of a session id on every stamp (src/chart.ts). The
  // drawing store is stamped from here, so the same cut is made here, or a session past 64
  // characters would own its zones and not its levels, and `clear: 'mine'` would take one and
  // leave the other.
  const by = session === null ? null : session.slice(0, 64);
  // The lines a waiting plan is anchored to, read fresh off the plans on every write, so nothing
  // below (clear, the product sweep, the cap) can take one from under a plan the human approved.
  const held = linesHeld(ctx);
  slot.drawings.hold(held.keys());

  // 1. Clear. Scoped like the old chart_clear: `mine` is this session's, `agent` every agent's,
  // `all` the human's too. A plan drawn on this chart is never touched here, whatever the
  // scope: an idea is removed through trade_plan, and anything armed is protection the venue
  // holds, so it is named in the refusals and left exactly where it is.
  if (args.clear !== undefined) {
    const what = String(args.clear);
    if (what !== 'mine' && what !== 'agent' && what !== 'all') {
      refused.push(`clear must be mine, agent or all, got ${what}`);
    } else {
      const out = chart.clear(what, by);
      if (!out.ok) refused.push(out.error);
      else {
        const removed = what === 'mine' ? slot.drawings.clear('agent', by) : what === 'agent' ? slot.drawings.clear('agent') : slot.drawings.clear();
        notes.push(...out.notes);
        if (removed > 0) notes.push(`and ${removed} drawn ${removed === 1 ? 'object' : 'objects'} (zones and lines)`);
      }
      for (const plan of plansOn(ctx, chart.state().view.product)) {
        if (plan.status !== 'idea') refused.push(`plan ${plan.id} is ${plan.status}, not an idea: clear leaves it; propose_trade_change is how it changes`);
      }
      for (const [id, plan] of held) {
        if (slot.drawings.get(id) !== undefined) {
          refused.push(`plan ${plan.id} is waiting on line ${id}: clear leaves the line; propose_trade_change is how the plan changes`);
        }
      }
    }
  }

  // 2. View. Resolved against the venue before the store records it, the same door the window's
  // own click uses, so "bitcoin" charts BTC-USD and an unlisted name is refused by name.
  if (args.view !== null && typeof args.view === 'object') {
    const v = args.view as Record<string, unknown>;
    const patch: JsonBody = {};
    if (typeof v.product === 'string') patch.product = v.product;
    if (typeof v.timeframe === 'string') patch.timeframe = v.timeframe;
    if (typeof v.bars === 'number') patch.barCount = v.bars;
    if (typeof v.provider === 'string') patch.provider = v.provider;
    const refusal = resolveViewPatch(ctx, patch, true, chart);
    if (refusal !== null) refused.push(refusal);
    else {
      const before = chart.state().view.product;
      const out = chart.setView(patch, 'agent', by);
      if (!out.ok) refused.push(out.error);
      else {
        notes.push(...out.notes);
        const after = chart.state().view.product;
        // The chart store tidies its own levels and marks on a product switch. The drawing store
        // is a separate file holding the same kind of object, so the sweep has to reach it from
        // here or half the agent's work would survive onto an instrument it does not describe.
        if (after !== before) {
          const swept = slot.drawings.sweepForeign(after);
          if (swept > 0) notes.push(`cleared ${swept} agent ${swept === 1 ? 'drawing' : 'drawings'} (zones and lines) anchored to ${before}`);
          for (const [id, plan] of held) {
            const line = slot.drawings.get(id);
            if (line !== undefined && line.product !== after) notes.push(`line ${id} stays, anchored to ${line.product ?? before}: plan ${plan.id} is waiting on it`);
          }
        }
      }
    }
  }

  // 3. Indicators. `preset` and `set` clear this agent's own studies first, so a package can never
  // be refused by the pane cap and the chart cannot silently accumulate; a human's studies and a
  // colleague's are never touched. `add` adds, `remove` removes by id or type.
  if (args.indicators !== null && typeof args.indicators === 'object') {
    const ind = args.indicators as Record<string, unknown>;
    let wanted: IndicatorReq[] | null = null;
    if (ind.preset !== undefined) {
      const preset = findPreset(ind.preset);
      if (preset === undefined) refused.push(`unknown preset: ${String(ind.preset)}. one of ${PRESETS.map((p) => p.name).join(', ')}`);
      else wanted = preset.indicators.map((i) => ({ type: i.type, params: i.params ?? {} }));
    }
    if (Array.isArray(ind.set)) wanted = [...(wanted ?? []), ...indicatorReqs(ind.set)];
    if (wanted !== null) {
      // With no session to go on, the honest tidy is every agent's studies: an agent that cannot
      // name itself cannot own anything, and leaving the chart full would fail the package on the
      // cap, which is the outcome this path exists to prevent.
      chart.clear(by === null ? 'agent' : 'mine', by);
      for (const want of wanted) addIndicator(ctx, chart, want, by, refused, notes);
    }
    for (const want of indicatorReqs(ind.add)) addIndicator(ctx, chart, want, by, refused, notes);
    if (Array.isArray(ind.remove)) {
      for (const ref of ind.remove) {
        const out = chart.removeIndicator(String(ref));
        if (!out.ok) refused.push(out.error);
      }
    }
  }

  // 4 and 5. Levels and marks, into the chart store, tagged [agent] by it.
  for (const level of rows(args.levels)) {
    const px = num(level.px);
    if (px === null) {
      refused.push('a level needs px as a finite number');
      continue;
    }
    const out = chart.setLevel({ price: px, label: level.label }, 'agent', by);
    if (!out.ok) refused.push(out.error);
  }
  for (const mark of rows(args.marks)) {
    const t = num(mark.t);
    if (t === null) {
      refused.push('a mark needs t as a unix timestamp in seconds');
      continue;
    }
    const out = chart.setMark({ t, label: mark.label }, 'agent', by);
    if (!out.ok) refused.push(out.error);
  }

  // 6 and 7. Lines and zones, into the drawing store, the one the window renders. Stamped with
  // the session and the instrument so `clear: 'mine'` and the product sweep reach them the same
  // way they reach a level.
  const view = chart.state().view;
  const stamp = { source: 'agent' as const, by, product: view.product, granularitySec: view.granularitySec };
  for (const line of rows(args.lines)) {
    const t1 = num(line.t1);
    const p1 = num(line.p1);
    const t2 = num(line.t2);
    const p2 = num(line.p2);
    if (t1 === null || p1 === null || t2 === null || p2 === null) {
      refused.push('a line needs t1, p1, t2 and p2 as finite numbers');
      continue;
    }
    // Two anchors at the same instant describe a vertical line, which is a mark, and the
    // renderer would divide by zero working out the slope.
    if (t1 === t2) {
      refused.push('a line needs two different times; for a vertical line at one moment use marks');
      continue;
    }
    const flip = t2 < t1;
    slot.drawings.add({
      kind: 'trendline',
      label: tagLabel(line.label, 'line'),
      ...stamp,
      line: { a: { t: flip ? t2 : t1, price: flip ? p2 : p1 }, b: { t: flip ? t1 : t2, price: flip ? p1 : p2 } },
    });
  }
  for (const zone of rows(args.zones)) {
    const p1 = num(zone.p1);
    const p2 = num(zone.p2);
    if (p1 === null || p2 === null) {
      refused.push('a zone needs p1 and p2 as finite numbers');
      continue;
    }
    if (p1 === p2) {
      refused.push('a zone needs two different prices; for one price use levels');
      continue;
    }
    const t1 = num(zone.t1);
    const t2 = num(zone.t2);
    slot.drawings.add({
      kind: 'zone',
      label: tagLabel(zone.label, 'zone'),
      ...stamp,
      zone: {
        low: Math.min(p1, p2),
        high: Math.max(p1, p2),
        ...(t1 !== null && t2 !== null ? { t1: Math.min(t1, t2), t2: Math.max(t1, t2) } : {}),
      },
    });
  }

  ctx.sse.broadcastChart(slot.index);
  const digest = await chartDigest(ctx, slot);
  sendJson(res, 200, { ...digest, refused: collapse(refused), ...(notes.length > 0 ? { notes: collapse(notes) } : {}) });
}

/* The digest is a few hundred bytes, and `refused` and `notes` were the one part of it with no
   bound: ten thousand levels in one call answered with 9,976 copies of "24 price levels is the
   maximum", 679 KB for a 119 KB request, handed to a model as its tool result. Identical lines
   become one line with a count, and past this many distinct lines the rest is a count too. */
const DIGEST_LINES_MAX = 24;

function collapse(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out = [...counts].map(([line, n]) => (n > 1 ? `${line} (x${n})` : line));
  if (out.length <= DIGEST_LINES_MAX) return out;
  return [...out.slice(0, DIGEST_LINES_MAX), `and ${out.length - DIGEST_LINES_MAX} more`];
}

// Attribution the agent cannot write its way out of. The chart store tags its own objects; the
// drawing store is written from here, so the tag is added here.
function tagLabel(raw: unknown, fallback: string): string {
  const trimmed = String(raw ?? '').trim().slice(0, 48);
  return `[agent] ${trimmed || fallback}`;
}

function addIndicator(ctx: Ctx, chart: ChartSlot['store'], want: IndicatorReq, by: string | null, refused: string[], notes: string[]): void {
  const type = want.type.toLowerCase().trim();
  const spec = resolveIndicator(ctx, type);
  if (spec === undefined) {
    refused.push(`unknown indicator: ${type || '(none given)'}. chart_batch op indicator_list has the list`);
    return;
  }
  const out = chart.addIndicator({ type, params: want.params ?? {} }, 'agent', by, spec);
  if (!out.ok) refused.push(out.error);
  else notes.push(...out.notes);
}

// Every plan row on the trading payload. Guarded, because the plan store is the execution unit's
// and a server built without one (every chart test) has no plans at all.
function planRows(ctx: Ctx): Record<string, unknown>[] {
  let payload: unknown;
  try {
    payload = ctx.trade.payload();
  } catch {
    return [];
  }
  const plans = (payload as { plans?: unknown } | null)?.plans;
  if (!Array.isArray(plans)) return [];
  return plans.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object');
}

// The plans drawn on a chart.
export function plansOn(ctx: Ctx, product: string): { id: string; status: string }[] {
  const coin = product.split('-')[0]?.toUpperCase() ?? '';
  return planRows(ctx)
    .filter((p) => String(p.symbol ?? '').toUpperCase() === coin)
    .map((p) => ({ id: String(p.id ?? ''), status: String(p.status ?? '') }));
}

/* The lines waiting plans are anchored to, keyed by line id, whatever chart is showing: the
   watcher resolves a plan's `{ line: 'tl_N' }` on the primary by id, so the line matters wherever
   the human has panned to. Only a WAITING plan holds one. An idea has no authority and
   trade_plan is how it changes; a placed or open plan has already fired and the venue holds its
   orders; a done plan is history. */
export function linesHeld(ctx: Ctx): Map<string, { id: string; status: string }> {
  const out = new Map<string, { id: string; status: string }>();
  for (const plan of planRows(ctx)) {
    const status = String(plan.status ?? '');
    if (status !== 'waiting') continue;
    const when = Array.isArray(plan.when) ? plan.when : [];
    for (const condition of when) {
      const at = (condition as { at?: { line?: unknown } } | null)?.at;
      if (typeof at?.line === 'string') out.set(at.line, { id: String(plan.id ?? ''), status });
    }
  }
  return out;
}
/* How many concepts each session has recorded, per server. Ten is the session's allowance: the
   profile is a file the next role text is built from, and an agent that could fill it in one
   sitting could fill it with sixty things nobody taught. Keyed by the Ctx rather than held in a
   module binding, because every test in this repo builds its own server in one process and the
   sessions they seat share a name. */
const LEARNED_PER_SESSION = 10;
const learnedCounts = new WeakMap<Ctx, Map<string, number>>();

/* DRAW SOMETHING THAT ALREADY EXISTS, as the app's own card rather than as a paragraph.
   "Show me the transaction" used to come back as prose with a hash pasted in the middle of it,
   because the window only knew how to draw a tool's own answer and nothing let an agent point
   at a thing and say "that one". This is that pointer. It moves no money and reads nothing off
   the machine that a read tool would not: it is on the view door because all it does is change
   what the human is looking at.

   THE CARD GOES THROUGH THE SAME PIPE A TOOL ANSWER DOES, the driver's tool_data event, so the
   window draws it with the code it already has and there is no second path to keep in step. A
   window with no conversation open has nothing to draw into, and the answer says so rather than
   claiming a card that nobody will see. */
const SHOW_KINDS = ['proposal', 'transaction', 'position', 'deposit'] as const;
type ShowKind = (typeof SHOW_KINDS)[number];

function isShowKind(raw: unknown): raw is ShowKind {
  return typeof raw === 'string' && (SHOW_KINDS as readonly string[]).includes(raw);
}

async function showBody(ctx: Ctx, kind: ShowKind, id: string, network: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  if (kind === 'proposal') {
    const p = ctx.proposals.get(id);
    if (p === undefined) return { ok: false, reason: `unknown proposal id: ${id}` };
    return { ok: true, data: { card: 'proposal', id, view: ctx.proposals.view(p) } };
  }
  if (kind === 'transaction') {
    // The network is not guessable from a hash and a card drawn against the wrong chain is a
    // confident lie, so it is asked for by name rather than inferred.
    if (!isChainNetwork(network)) return { ok: false, reason: `a transaction card needs the network it is on: one of ${CHAIN_NETWORKS.join(', ')}` };
    const check = validateHash(network, id);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, data: { card: 'transaction', id: check.normalized, tx: await transaction(network, check.normalized, { keys: ctx.cfg.chainscan }) } };
  }
  if (kind === 'position') {
    const read = ctx.trade.read(id) as { positions?: unknown[] };
    const position = (read.positions ?? [])[0];
    if (position === undefined) return { ok: false, reason: `no open position in ${id}` };
    return { ok: true, data: { card: 'position', id, position } };
  }
  const deposit = ctx.deposits.current();
  if (deposit === null) return { ok: false, reason: 'no deposit is being watched: the deposit tool opens that card' };
  return { ok: true, data: { card: 'deposit', id, deposit } };
}

const HANDLERS: Record<string, ViewHandler> = {
  show: async ({ ctx, args, res }): Promise<void> => {
    const kind = args.kind;
    if (!isShowKind(kind)) {
      fail(res, 400, `kind must be one of ${SHOW_KINDS.join(', ')}`);
      return;
    }
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (id === '') {
      fail(res, 400, `a ${kind} card needs the id of the ${kind} to draw`);
      return;
    }
    const built = await showBody(ctx, kind, id, args.network);
    if (!built.ok) {
      fail(res, 404, built.reason);
      return;
    }
    const chats = ctx.chats.all();
    for (const chat of chats) {
      ctx.chats.event(chat, { kind: 'tool_data', name: 'show', input: { kind, id }, data: built.data });
    }
    sendJson(res, 200, { drawn: chats.length > 0, kind, id, ...(chats.length > 0 ? {} : { reason: 'no conversation is open in the window, so there is nothing to draw into' }) });
  },
  // ---------- the human's knowledge ----------
  profile_learned: ({ ctx, args, body, res }): void => {
    /* A worker's MCP process never registers this tool, and this is the wall behind that one:
       the app minted the worker's session id and seated it as an analyst, so the route can tell
       a worker from a lead without reading anything off the wire. A worker has no human in its
       session to have taught, so nothing it could record is a fact the human learned. */
    if (ctx.agents.member(body.session)?.role === 'analyst') {
      fail(res, 403, "profile_learned is the lead's tool: a worker has no human in its session to have taught");
      return;
    }
    const session = String(body.session ?? '');
    const counts = learnedCounts.get(ctx) ?? new Map<string, number>();
    learnedCounts.set(ctx, counts);
    const sofar = counts.get(session) ?? 0;
    const concept = normalizeConcept(args.concept);
    // Only a concept that would be added counts against the allowance: a repeat writes nothing,
    // and an invalid one is refused below with the rule it broke rather than with the count.
    const known = loadProfile(ctx.cfg.dataDir).knows.some((k) => k.concept.toLowerCase() === concept.toLowerCase());
    if (sofar >= LEARNED_PER_SESSION && isConcept(concept) && !known) {
      fail(res, 400, `ten concepts is the most one session records; the next session can record more`);
      return;
    }
    const out = recordLearned(ctx.cfg.dataDir, concept, new Date().toISOString().slice(0, 10));
    if (!out.ok) {
      fail(res, 400, out.reason);
      return;
    }
    if (out.added) {
      counts.set(session, sofar + 1);
      ctx.audit.append('tool_call', `profile: the agent recorded that the human knows ${concept}`, { concept });
    }
    sendJson(res, 200, {
      ok: true,
      added: out.added,
      count: out.count,
      note: out.added ? `recorded; ${out.count} in the Knows list` : 'already recorded, nothing written',
    });
    return;
  },

  // ---------- the trading surface ----------
  trade_focus: tradeWrite(({ ctx, args }) => {
    const out = ctx.trade.view.setFocus(args, 'agent');
    // Focus moves the chart with it. A trading screen whose position panel and whose candles
    // disagree about which market is on screen is the one bug on this surface a person would not
    // catch, because both halves look right on their own.
    if (out.ok) {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const match = ctx.cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === symbol);
      if (match !== undefined) ctx.chart.setView({ product: match }, 'agent');
    }
    return out;
  }),
  trade_highlight: tradeWrite(({ ctx, args }) => ctx.trade.view.highlight(args, 'agent')),
  trade_overlay: tradeWrite(({ ctx, args }) => ctx.trade.view.setOverlay(args, 'agent')),
  trade_clear: tradeWrite(({ ctx, args }) => ctx.trade.view.clear(String(args.what ?? 'agent'))),
  // A plan as an idea: drawn on the chart and listed under Waiting with no authority. It answers
  // with the row it drew, so the agent has the id "go" will arm without a second read.
  trade_plan: ({ ctx, args, body, res }): void => {
    const by = String(body.session ?? '') || null;
    const out = ctx.trade.plan(args, by);
    if (!out.ok) {
      fail(res, 400, out.error);
      return;
    }
    ctx.audit.append('tool_call', `plan: ${out.notes.join('; ')}`, { plan: out.row });
    ctx.sse.broadcastTrade();
    ctx.sse.broadcastChart();
    sendJson(res, 200, { ok: true, notes: out.notes, plan: out.row, trade: ctx.trade.read() });
  },

  // ---------- colour ----------
  // It does not change the chart, so answering with the chart would be noise. It answers with the
  // theme it wrote, so an agent never has to read back to see its own change.
  set_theme: ({ ctx, args, res }): void => {
    const result = applyThemePatch(ctx.theme.get(), args);
    if (!result.ok) {
      fail(res, 400, result.error);
      return;
    }
    ctx.theme.set(result.theme);
    // Audited like every other agent write. Recolouring the window is not a money move and it IS
    // a change to what a human sees while they decide about one, so it leaves a line.
    ctx.audit.append('theme_changed', `agent recoloured the window: ${result.notes.join('; ')}`, {
      theme: result.theme,
    });
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, notes: result.notes, theme: result.theme });
  },

  // ---------- the chart ----------
  chart_draw: chartDraw,

  // Up to four charts side by side. The first entry is the primary, the one the human interacts
  // with; the rest are comparison charts on their own stores. Every product is resolved against
  // the catalogue first, so an unlisted name refuses the whole layout rather than putting up a
  // blank chart under it.
  chart_layout: ({ ctx, args, res }): void => {
    const asked = rows(args.charts);
    const charts: { product: string; timeframe: string }[] = [];
    for (const entry of asked) {
      const patch: JsonBody = { product: String(entry.product ?? '') };
      const refusal = resolveViewPatch(ctx, patch, true);
      if (refusal !== null) {
        fail(res, 400, refusal);
        return;
      }
      charts.push({ product: String(patch.product), timeframe: String(entry.timeframe ?? '') });
    }
    // A layout that moves the primary onto another instrument sweeps its agent drawings, and a
    // line a waiting plan is anchored to is not one of those.
    ctx.charts.primary.drawings.hold(linesHeld(ctx).keys());
    const out = ctx.charts.layout(charts);
    if (!out.ok) {
      fail(res, 400, out.reason);
      return;
    }
    for (const slot of ctx.charts.list()) ctx.sse.broadcastChart(slot.index);
    ctx.sse.broadcastState();
    sendJson(res, 200, { ok: true, charts: ctx.charts.list() });
  },

  // ---------- the team ----------
  agent_post: ({ ctx, args, body, res }): void => {
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
  },

  agent_spawn: ({ ctx, args, body, res }): void => {
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
  },
};

// The table's own keys, for the test that holds VIEW_TOOLS and this in step. A tool listed in the
// refusal message and missing from here is a tool an agent is told it has and cannot call.
export function viewToolNames(): string[] {
  return Object.keys(HANDLERS);
}

export async function handleView(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const tool = String(body.tool ?? '');
  const args = asRecord(body.args);
  const by = String(body.session ?? '') || null;

  const handler = HANDLERS[tool];
  if (handler === undefined) {
    fail(res, 400, `unknown view tool: ${tool}. known tools: ${VIEW_TOOLS.join(', ')}`);
    return;
  }
  // The proxy never registers these for a worker, and this is the second wall behind it: a
  // raw POST from an analyst seat is refused by the seat's role, decided by the roster and never
  // by anything the body claims.
  if ((LEAD_ONLY_VIEW_TOOLS as readonly string[]).includes(tool) && ctx.agents.member(body.session)?.role === 'analyst') {
    fail(res, 403, `${tool} is not on a worker's surface`);
    return;
  }
  await handler({ ctx, args, body, res, by });
}
