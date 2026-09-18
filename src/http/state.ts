// The state payload the window reads, the transaction history behind it, and the gas report
// both doors share.
//
// buildState is synchronous and every caller depends on that: prices come from a cache the
// poller fills (see chart.ts), so a state build never waits on a network read.

import type { Policy, Proposal } from '../types.ts';
import { buildBasic } from '../view/basic.ts';
import { classify } from '../composition.ts';
import { buildWallet } from '../wallet.ts';
import { buildTransactions } from '../transactions.ts';
import { renderSentences } from '../policy/render.ts';
import { LOG_LIMIT_MAX } from './context.ts';
import { intParam, jsonWithEtag } from './respond.ts';
import type { CachedJson } from './respond.ts';
import type { Ctx } from './context.ts';
import { vaultStatus } from './vault.ts';

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
const WAITING: ReadonlySet<string> = new Set(['pending', 'pending_unlock', 'awaiting_touch', 'needs_reconciliation']);

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
  const wallet = buildWallet(snapshot, ctx.ledger.intents(), ctx.ledger.hyperliquid());
  const composition = classify(wallet.rows, ctx.riskRows);
  const policy = ctx.getPolicy();
  const list = ctx.proposals.list();
  const lockAddresses = ctx.keystore.addressReport();
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
    /* `verified` says whether the addresses beside it were decrypted or merely read out of the
       file's plaintext header, which nothing authenticates while the wallet is shut. `tampered`
       says a correct password proved the header was edited, and the addresses are empty in that
       state. The window draws the difference; the server does not decide what it looks like. */
    lock: {
      state: ctx.keystore.state(),
      idleLocksInSec: ctx.session.idleLocksInSec(),
      addresses: { evm: lockAddresses.addresses.evm },
      verified: lockAddresses.verified,
      tampered: lockAddresses.tampered,
    },
    /* The vault beside the lock: which custody, whether the enclave is reachable, what the
       Touch ID dialog is waiting on, whether the phrase is proven backed up. The Vault tab, the
       first-run screen and the decision card all read it from here. Never a key. */
    vault: vaultStatus(ctx),
    /* Whether the terms of use are accepted at their current version. The window shows its
       terms screen ahead of everything else until this says so. */
    terms: ctx.terms.get(),
    deposit: ctx.deposits.current(),
    sentences: sentencesOf(policy),
    /* Everything still waiting on a person, plus the last 20 decided, each carrying the one
       object every surface reads. The rest is paged behind GET /api/proposals; see the note on
       STATE_DECIDED_KEPT above.
       `view` is what the card draws and it is the SAME object proposal_status hands the agent,
       built by the same function off the same row, which is the whole of the fix: two surfaces
       cannot disagree about a stage neither of them derives. */
    proposals: stateProposals(list).map((p) => ({ ...p, view: ctx.proposals.view(p) })),
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
      readAt: snapshot.fetchedAt,
      selfAddresses: ctx.cfg.addresses.evm === undefined ? [] : [ctx.cfg.addresses.evm],
      prices: ctx.prices.readings,
      // The assistant's half of the history: the same events the pro screen's log
      // carries, rendered as sentences instead of as log lines. See buildActions.
      events: ctx.recent,
    }),
  };
}

/* ---------- the built payload, cached behind what it reads ----------

   State is pushed whether or not it moved. The heartbeat fires every 15 s, the ledger refresh
   broadcasts on every pass, and with a trading feed live the hub can push 8.3 frames a second. The
   browser answers each one with a conditional GET, and the ETag made those cheap for the browser
   and free for nobody: the body and the tag were built BEFORE the if-none-match comparison, so a
   304 cost 4.49 ms against a 200's 4.66 ms at 1000 proposals. That is about 37 ms of blocked event
   loop every second, for as long as the trading page is open, on a payload nobody receives.

   So the pair is built once and kept until something it reads moves. What it reads, and how each
   one is noticed:

     the proposal store   ctx.store.revision(), bumped by every put
     the audit log        ctx.audit.lineCount(), which moves on every line and so covers the policy,
                          the kill switch, the view, the theme, the agent roster, the board, the
                          workers and the recent-events list, all of which are written through it
     the lock             ctx.keystore.state(), a string compared by value
     the chains           the identity of ctx.ledger.snapshot(), which src/ledger/index.ts holds
                          and replaces on refresh

   Counters and identities rather than subscriptions, deliberately: there is no listener to leak
   and no caller that has to remember to unsubscribe, and a server that is closed takes its entry
   with it because the map is weak.

   THE CEILING IS THE SAFETY NET, and it is why this is not a list of hooks to get exactly right.
   The lending view refreshes on a 60 s timer, the price poll on a 30 s one, and the idle countdown
   ticks every second, and none of the three announces itself. A cache that only ever invalidated
   on the four inputs above would show a stale price for as long as nothing else moved, which for a
   number a person reads is the wrong kind of wrong. One second bounds every input nobody
   enumerated, including one added later by somebody who never read this comment. */
export const STATE_CACHE_MAX_MS = 1_000;

type StateCache = {
  built: CachedJson;
  at: number;
  storeRevision: number;
  auditLines: number;
  lockState: string;
  snapshot: unknown;
};

const caches = new WeakMap<Ctx, StateCache>();

function stateKey(ctx: Ctx): Omit<StateCache, 'built' | 'at'> {
  return {
    storeRevision: ctx.store.revision(),
    auditLines: ctx.audit.lineCount(),
    lockState: ctx.keystore.state(),
    snapshot: ctx.ledger.snapshot(),
  };
}

export function buildStateCached(ctx: Ctx): CachedJson {
  const key = stateKey(ctx);
  const held = caches.get(ctx);
  if (
    held !== undefined &&
    held.storeRevision === key.storeRevision &&
    held.auditLines === key.auditLines &&
    held.lockState === key.lockState &&
    held.snapshot === key.snapshot &&
    Date.now() - held.at < STATE_CACHE_MAX_MS
  ) {
    return held.built;
  }
  const built = jsonWithEtag(buildState(ctx));
  caches.set(ctx, { built, at: Date.now(), ...key });
  return built;
}

// ---------- transaction history ----------
//
// Derived from the proposal store and the audit log on every request (see the header of
// src/transactions.ts). Nothing here reads a chain: every move settles inside a venue.

export function transactionsPayload(ctx: Ctx): { entries: ReturnType<typeof buildTransactions> } {
  const entries = buildTransactions({
    proposals: ctx.proposals.list(),
    events: ctx.audit.tail(LOG_LIMIT_MAX),
    selfAddresses: ctx.cfg.addresses.evm === undefined ? [] : [ctx.cfg.addresses.evm],
  });
  return { entries };
}

