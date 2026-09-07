// The state payload the window reads, the transaction history behind it, the gas report both
// doors share, and the two questions the lending loop answers about which chain.
//
// buildState is synchronous and every caller depends on that: prices come from a cache the
// poller fills (see chart.ts) and the yield view from a background refresh, because a position
// lives on a chain and a state build must never wait on one.

import type { ChainId, Policy, Proposal } from '../types.ts';
import { buildBasic } from '../view/basic.ts';
import { classify } from '../composition.ts';
import { buildWallet } from '../wallet.ts';
import { buildTransactions, evmCandidates } from '../transactions.ts';
import type { TxPlace } from '../transactions.ts';
import { buildGasReport } from '../gas/report.ts';
import type { GasReport, GasWindow } from '../gas/report.ts';
import { renderSentences } from '../policy/render.ts';
import { LOG_LIMIT_MAX } from './context.ts';
import { intParam } from './respond.ts';
import type { Ctx } from './context.ts';

/* NOTHING UNBOUNDED RIDES ON /api/state, and this is where that rule is kept.
   The payload used to carry every proposal the data directory had ever held. Measured on a demo
   instance: 14.4 KB with none, 216 KB at 200, 1027 KB at 1000, of which the proposals key was
   1014 KB, or 98% of the response. The window reads that list filtered to pending in exactly two
   places (ui/screens/shell.js and ui/screens/decision.js) and draws at most two cards from it, so
   the growth was history nothing rendered, re-serialised on the server and re-parsed in the
   browser on every state frame.

   What stays: everything still waiting on a person, whatever its age, because a pending ask that
   fell off a page would be an ask nobody is shown. What goes behind /api/proposals: the decided
   history, newest first, paged.

   The 20 decided rows that stay are the recent-activity window: enough for a screen to draw what
   just happened without a second read, few enough that the payload does not grow with the data
   directory. tests/unit/state-payload.test.ts asserts the size, so a key added later that grows
   with use fails there rather than in front of somebody a year in.

   A COUNT ALONE DOES NOT BOUND BYTES, which is why there is a budget beside it. A proposal is not
   a fixed size: a swap carries its draft, its quote echo, a simulation and a result, and twenty of
   those measured 21.4 KB against a 20 KB target on their own. So the twenty is a ceiling on rows
   and the budget is a ceiling on bytes, and whichever runs out first stops the walk. The rest is
   one fetch away. */
export const STATE_DECIDED_KEPT = 20;
export const STATE_DECIDED_BYTES = 6 * 1024;
export const PROPOSAL_PAGE_DEFAULT = 25;
export const PROPOSAL_PAGE_MAX = 200;

// Still waiting on someone: a person, an unlock, or a look at the chain. Never trimmed.
const WAITING: ReadonlySet<string> = new Set(['pending', 'pending_unlock', 'needs_reconciliation']);

/* The trim, in store order.
   The order is load-bearing rather than cosmetic: ui/screens/decision.js takes pending[0] out of
   the filtered list, so reversing here would silently change which proposal a person is asked
   about first. The walk is backwards to find the newest decided rows and the result is put back
   the way the store wrote it. */
export function stateProposals(all: Proposal[]): Proposal[] {
  const out: Proposal[] = [];
  let decided = 0;
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const p = all[i];
    if (WAITING.has(p.status)) {
      out.push(p);
      continue;
    }
    if (decided >= STATE_DECIDED_KEPT || bytes >= STATE_DECIDED_BYTES) continue;
    out.push(p);
    decided += 1;
    // At most twenty of these, so measuring them costs microseconds and buys a payload that
    // cannot be blown out by one unusually fat row.
    bytes += JSON.stringify(p).length;
  }
  out.reverse();
  return out;
}

/* GET /api/proposals?limit=&before=: the whole history, newest first, a page at a time.
   `before` is the id of the last row of the page before it rather than a timestamp, because two
   proposals filed in the same millisecond are ordinary and a timestamp cursor drops one of them.
   An id nobody has heard of is a 400 with the id in the sentence: answering an empty page would
   read as "your history ends here", which is the one wrong answer this route can give. */
export function proposalPage(ctx: Ctx, url: URL): { status: number; body: unknown } {
  const limit = intParam(url.searchParams.get('limit'), PROPOSAL_PAGE_DEFAULT, PROPOSAL_PAGE_MAX);
  const before = url.searchParams.get('before');
  const all = ctx.proposals.list();

  let end = all.length;
  if (before !== null && before.length > 0) {
    const at = all.findIndex((p) => p.id === before);
    if (at === -1) {
      return { status: 400, body: { error: `there is no proposal called '${before}', so there is nothing to page back from.` } };
    }
    end = at;
  }
  const start = Math.max(0, end - limit);
  const rows = all.slice(start, end).reverse();
  return {
    status: 200,
    body: {
      proposals: rows,
      // null means this was the last page. The caller stops rather than asking again with a
      // cursor that would answer the same rows.
      nextBefore: start > 0 && rows.length > 0 ? rows[rows.length - 1].id : null,
      total: all.length,
    },
  };
}

export function sentencesOf(policy: Policy | null): string[] {
  if (policy === null) return [];
  // Authored sentences are the human's own words and win. A hand-edited file
  // that empties them would otherwise hide live rules, so fall back to render.
  const rendered = renderSentences(policy);
  const lines = policy.sentences.length > 0 ? policy.sentences.slice() : rendered;
  // The kill switch line can never be missing from the surface while the switch
  // is on, whatever the stored sentences say. A refusal state the page does not
  // state is a safety bug, so this does not depend on the writer of policy.json.
  const killLine = rendered.find((line) => line.startsWith('KILL SWITCH ON'));
  if (killLine !== undefined && !lines.some((line) => line.startsWith('KILL SWITCH ON'))) {
    lines.push(killLine);
  }
  return lines;
}

export function buildState(ctx: Ctx): unknown {
  const snapshot = ctx.ledger.snapshot();
  const composition = classify(snapshot, ctx.riskRows);
  const policy = ctx.getPolicy();
  // The yield positions are handed in so the wallet TOTAL includes them. Supplying a token
  // removes it from the balance the chain reader sees, so without this the money in a
  // lending venue is invisible to the one number a person checks first.
  const yieldView = ctx.allocator?.view() ?? null;
  const wallet = buildWallet(
    snapshot,
    ctx.ledger.positions(),
    ctx.ledger.intents(),
    (yieldView?.positions ?? []).map((p) => ({
      chain: p.chain,
      venue: p.venue,
      symbol: p.symbol,
      receipt: p.receipt,
      receiptSymbol: p.receiptSymbol,
      valueUsd: p.valueUsd,
      principalUsd: p.principalUsd,
      earnedUsd: p.earnedUsd,
    })),
  );
  const list = ctx.proposals.list();
  return {
    ledger: snapshot,
    // wallet is what the UI renders; composition stays because the policy engine
    // reads byIssuer and freezableShare out of it.
    wallet,
    composition,
    policy,
    // Unconditional. Kept in the payload so the window states it rather than assumes it.
    gate: { required: true, banner: null },
    /* The custody state, so the window can draw the lock chip and the lock screen without a
       second read. `state` is one of unlocked, locked, no_wallet or needs_migration, and the
       last two are what the first-run and migration screens key off. Never carries a key. */
    lock: {
      state: ctx.keystore.state(),
      idleLocksInSec: ctx.session.idleLocksInSec(),
      addresses: ctx.keystore.addresses(),
    },
    sentences: sentencesOf(policy),
    // Everything still waiting on a person, plus the last 20 decided. The rest is paged behind
    // GET /api/proposals; see the note on STATE_DECIDED_KEPT above.
    proposals: stateProposals(list),
    mode: ctx.cfg.mode,
    /* The rolling 24h cap, as a fact rather than a sentence.
       It was already in `sentences` as prose and nowhere as a number, so the window could tell a
       person what the rule was and not how much of it was left. `spentUsd` is the same figure
       the engine budgets on, so the number on screen and the number a proposal is refused
       against cannot drift, and `resetsAt` is when the oldest counted spend leaves the window:
       this cap does not empty at midnight and a screen implying it did would be wrong daily.
       An unreadable policy has no cap to state, so the whole block is null rather than a zero
       that would read as "nothing left to spend". */
    dailyLimit: policy === null ? null : ctx.proposals.dailyLimit(policy.outbound.maxPerSessionUsd),
    // Every string in here is agent-authored (client names, labels, board posts) and is
    // rendered as text, never as markup. It is here so the status bar can say WHICH agents
    // are driving: "an agent is connected" is a weaker answer than "claude-code since 19:12"
    // and, now that several can attach, a wrong one when there are three.
    agents: {
      connected: ctx.agents.connected(),
      // The lead, under the name every caller written before the roster already reads. The
      // window's status bar says WHICH agent is driving, and with a team that is the lead.
      holder: ctx.agents.holder(),
      // The whole team, for the window's roster line. Labels and client names are
      // agent-authored and are rendered as text, never as markup, exactly like `holder`.
      members: ctx.agents.roster().map((m) => ({
        session: m.session,
        label: m.label,
        client: m.client,
        role: m.role,
        parent: m.parent,
        since: m.since,
        ops: m.ops,
      })),
      capacity: ctx.agents.capacity(),
      workers: (ctx.crewIfAny()?.list() ?? []).map((j) => ({ id: j.id, label: j.label, state: j.state })),
      // What the agents have told each other, so the human can read over their shoulder.
      board: ctx.board.list(12),
      // The most recent tool call, so a browser that just loaded (or reconnected and missed
      // the live 'activity' pings below) can seed its presence light from state alone rather
      // than waiting for the next op to know whether the agent is working.
      lastActivityAt: ctx.agents.activityAt(),
    },
    candleProducts: ctx.cfg.candleProducts,
    // What the stablecoin is earning. Read from a background refresh rather than here,
    // because buildState is synchronous and a position lives on a chain. `stale` on that
    // view means the last read failed and these are the previous good numbers; the panel
    // says so rather than drawing a zero, which for this feature would be the worst
    // available lie.
    yield: yieldView,
    view: ctx.getView(),
    // The window paints itself from this. It rides on state rather than on the chart
    // payload because the ground and the accent are the whole page, not the canvas.
    theme: ctx.theme.get(),
    // Computed in BOTH modes, deliberately. A view model that only exists in the mode
    // that renders it is a view model nothing exercises while the app sits in its
    // default state, which is where a regression would hide longest.
    basic: buildBasic({
      wallet,
      proposals: list,
      policyReadable: policy !== null,
      killSwitch: policy?.killSwitch ?? false,
      agentsConnected: ctx.agents.connected(),
      chainStatus: snapshot.chainStatus,
      selfAddresses: [...ctx.cfg.addresses.evm, ...ctx.cfg.addresses.solana, ...ctx.cfg.addresses.near],
      prices: ctx.prices.readings,
      // The assistant's half of the history: the same events the pro screen's log
      // carries, rendered as sentences instead of as log lines. See buildActions.
      events: ctx.recent,
    }),
  };
}

// ---------- transaction history ----------
//
// Derived from the proposal store and the audit log on every request (see the header of
// src/transactions.ts). Gas is the one part that needs the chain, so it is read behind the
// response rather than in front of it: the panel draws immediately with whatever receipts
// are already cached, the rest are fetched, and the browser is told when they land.

export function transactionsPayload(ctx: Ctx): { entries: ReturnType<typeof buildTransactions>; gasPending: number } {
  const entries = buildTransactions({
    proposals: ctx.proposals.list(),
    events: ctx.audit.tail(LOG_LIMIT_MAX),
    selfAddresses: [...ctx.cfg.addresses.evm, ...ctx.cfg.addresses.solana, ...ctx.cfg.addresses.near],
    gas: ctx.gas.cache.all(),
    tried: ctx.gas.cache.triedAll(),
  });
  // Only what is still worth waiting for. A hash no chain we can reach has ever heard of
  // is answered, not pending: an app that has run on two networks holds plenty of them.
  let gasPending = 0;
  for (const entry of entries) {
    for (const tx of entry.hashes) if (tx.gasPending) gasPending += 1;
  }
  return { entries, gasPending };
}

// One fill at a time, and only for hashes nobody has read yet. A receipt is immutable, so
// this converges: every call after the last one has landed does no network work at all.
export function fillGas(ctx: Ctx, entries: ReturnType<typeof buildTransactions>): void {
  if (ctx.gas.filling) return;
  const wanted: Array<{ places: TxPlace[]; hash: string }> = [];
  for (const entry of entries) {
    for (const tx of entry.hashes) {
      if (tx.gasPending) wanted.push({ places: evmCandidates(tx.place), hash: tx.hash });
    }
  }
  if (wanted.length === 0) return;
  ctx.gas.filling = true;
  const prices = ctx.ledger.snapshot().prices;
  void ctx.gas.cache
    .fill(wanted, symbol => prices[symbol] ?? 0)
    .then(landed => {
      if (landed > 0) ctx.sse.broadcastTransactions();
    })
    .catch(() => undefined)
    .finally(() => {
      ctx.gas.filling = false;
    });
}

// ---------- gas analytics ----------
//
// One derivation, two doors. The window opens GET /api/gas and an agent asks for the
// gas_report read tool, and both land here, for the same reason /api/chart and the chart
// read tools land in one place: two aggregations of one history would eventually disagree
// about a dollar, and the human and the agent would each be told a different number about
// the same money.
//
// The fill is kicked off exactly as /api/transactions does it. Without that line, a report
// asked for before the history panel was ever opened would count every unread receipt as a
// remainder forever, because nothing else on this surface reads a receipt.

export function gasReport(ctx: Ctx, windowRaw: string): { status: number; body: GasReport | { error: string } } {
  const window = windowRaw as GasWindow;
  if (window !== '24h' && window !== '7d' && window !== '30d' && window !== 'all') {
    // A 400, not a 200 carrying an error field. The window renders whatever body it is
    // handed, so an error object answered with a success status draws as a report of zero
    // gas, which is the one wrong answer this whole feature exists to avoid.
    return { status: 400, body: { error: `window must be one of 24h, 7d, 30d, all; got '${windowRaw}'` } };
  }
  const payload = transactionsPayload(ctx);
  fillGas(ctx, payload.entries);
  return { status: 200, body: buildGasReport({ entries: payload.entries, window, nowMs: Date.now() }) };
}

// ---------- the lending allocator's two doors ----------
//
// A chain omitted on a yield proposal is answered from the loop's own view rather than
// defaulted to a constant. A constant would be right until the day a second venue paid
// more, and then it would be quietly wrong on every call that trusted it.

export function bestYieldChain(ctx: Ctx): { ok: true; chain: ChainId } | { ok: false; reason: string } {
  const view = ctx.allocator?.view();
  if (!view) {
    return { ok: false, reason: 'no lending allocator is running, so there is no best venue to pick. Name a chain.' };
  }
  if (view.best) return { ok: true, chain: view.best.chain };
  // Healthy venues exist and none of them quoted a rate: the read failed or the reserve is
  // frozen. Saying which is what lets a caller decide whether to retry or to stop.
  const unhealthy = view.venues.filter(v => !v.healthy).map(v => `${v.chain}: ${v.note}`);
  return {
    ok: false,
    reason:
      'no venue is currently paying a readable rate, so there is no best chain to deposit into. ' +
      (unhealthy.length > 0 ? unhealthy.join('; ') : 'Name a chain to force one.'),
  };
}

export function heldYieldChain(ctx: Ctx): { ok: true; chain: ChainId } | { ok: false; reason: string } {
  const view = ctx.allocator?.view();
  if (!view) {
    return { ok: false, reason: 'no lending allocator is running, so there is no position to withdraw from.' };
  }
  // Only positions that actually hold something. A closed position keeps its row so the
  // window can still show what it earned, and withdrawing from it would refuse at the rail
  // with a message about a zero balance instead of here with one about which chain.
  const held = view.positions.filter(pos => Number(pos.valueUsd) > 0);
  if (held.length === 0) return { ok: false, reason: 'nothing is supplied to a lending venue, so there is nothing to withdraw.' };
  if (held.length > 1) {
    return {
      ok: false,
      reason: `money is supplied on more than one chain (${held.map(p => p.chain).join(', ')}), so name the one to withdraw from.`,
    };
  }
  return { ok: true, chain: held[0]!.chain };
}
