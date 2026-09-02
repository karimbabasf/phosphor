// The wallet reads: what an agent sees the moment it attaches, what the money is, what the
// rules say, what has been asked for, and the log behind all of it.

import { classify } from '../../composition.ts';
import { buildWallet } from '../../wallet.ts';
import { buildGreeting } from '../../greeting.ts';
import { buildMandateCatalog } from '../../strategy/catalog.ts';
import { VERSION } from '../../version.ts';
import { fail, intParam, round2, sendJson } from '../respond.ts';
import { LOG_LIMIT_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';
import { sentencesOf } from '../state.ts';

export const walletReads: ReadTable = {
  // What an agent calls the moment it attaches. Everything in it is read live, because a
  // greeting that cannot say which network it is on is decoration, and an operator working
  // the wrong world is the failure this whole app exists to make impossible.
  start: (ctx, _body, _args, res) => {
    const snapshot = ctx.ledger.snapshot();
    const wallet = buildWallet(snapshot, ctx.ledger.positions(), ctx.ledger.intents());
    const policy = ctx.getPolicy();
    const pending = ctx.proposals.list().filter((p) => p.status === 'pending');
    const holder = ctx.agents.holder();
    const greeting = buildGreeting(
      {
        view: ctx.getView(),
        totalUsd: wallet.totalUsd,
        // Places actually holding something, which is what "across N chains" means to a
        // reader. Counting configured chains instead would say 5 while 2 hold the money.
        chainCount: Object.values(wallet.byChain).filter((usd) => usd > 0).length,
        pendingCount: pending.length,
        clickThresholdUsd: policy?.outbound.humanClickAboveUsd ?? null,
        killSwitch: policy?.killSwitch ?? false,
        tradingAllowed: true,
        holder: holder?.client ?? null,
        emptyCount: wallet.emptyCount,
      },
      VERSION,
    );
    sendJson(res, 200, {
      ...greeting,
      pending: pending.map((p) => p.id),
      stale: wallet.stale,
    });
  },
  mandate_catalog: (_ctx, _body, _args, res) => {
    sendJson(res, 200, buildMandateCatalog());
  },
  balances: (ctx, _body, _args, res) => {
    const snapshot = ctx.ledger.snapshot();
    const composition = classify(snapshot, ctx.riskRows);
    sendJson(res, 200, {
      mode: snapshot.mode,
      totalStableUsd: round2(composition.totalUsd),
      totalUsd: round2(snapshot.holdings.reduce((sum, h) => sum + h.usd, 0)),
      holdings: snapshot.holdings,
      chainStatus: snapshot.chainStatus,
      prices: snapshot.prices,
      gas: snapshot.gas,
    });
  },
  composition: (ctx, _body, _args, res) => {
    sendJson(res, 200, classify(ctx.ledger.snapshot(), ctx.riskRows));
  },
  wallet: (ctx, _body, _args, res) => {
    sendJson(res, 200, buildWallet(ctx.ledger.snapshot(), ctx.ledger.positions(), ctx.ledger.intents()));
  },
  policy_show: (ctx, _body, _args, res) => {
    const policy = ctx.getPolicy();
    if (policy === null) {
      /* `reason`, not `error`. The status is right: the question "what are the rules" HAS an
         answer here, and the answer is that they cannot be read and nothing may be written. A
         client switching on `error` was reading a failure out of a 200, which is the one shape
         `fail()` deliberately does not cover, because what was wrong was the key rather than the
         status. `readable: false` is the discriminator and always has been. */
      sendJson(res, 200, {
        readable: false,
        sentences: [],
        reason: 'policy file unreadable: every write is refused until it is fixed',
      });
      return;
    }
    sendJson(res, 200, {
      readable: true,
      killSwitch: policy.killSwitch,
      sentences: sentencesOf(policy),
      policy,
    });
  },
  log_tail: (ctx, _body, args, res) => {
    sendJson(res, 200, ctx.audit.tail(intParam(args.limit, 50, LOG_LIMIT_MAX)));
  },
  proposal_status: (ctx, _body, args, res) => {
    const id = typeof args.id === 'string' ? args.id : '';
    const proposal = ctx.proposals.get(id);
    if (proposal === undefined) {
      fail(res, 404, `unknown proposal id: ${id}`);
      return;
    }
    sendJson(res, 200, proposal);
  },
};
