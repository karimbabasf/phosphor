// The wallet reads: what an agent sees the moment it attaches, what the money is, what the
// rules say, what has been asked for, and the log behind all of it.

import { classify } from '../../composition.ts';
import { buildWallet } from '../../wallet.ts';
import { buildGreeting } from '../../greeting.ts';
import { loadProfile } from '../../profile/index.ts';
import { VERSION } from '../../version.ts';
import { fail, intParam, round2, sendJson } from '../respond.ts';
import { LOG_LIMIT_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';
import { sentencesOf } from '../state.ts';
import { intentsReceiveReport } from '../wallet.ts';
import { vaultStatus } from '../vault.ts';
import type { ChainId } from '../../types.ts';

/* An address for the agent's eyes: enough to say "check it ends in 9Xk2" and not enough to
   paste. The window shows the whole string, off a Touch ID open, and that is the only place
   a person should read it from. */
export function fingerprint(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

const CHAIN_IDS: ReadonlySet<string> = new Set(['eth', 'base', 'arb', 'sol', 'near']);
// How exchanges name the network in their withdrawal picker, which is where the money is lost.
const EXCHANGE_NETWORK: Record<ChainId, string> = {
  eth: 'Ethereum (ERC-20)',
  base: 'Base',
  arb: 'Arbitrum One',
  sol: 'Solana (SPL)',
  near: 'NEAR Protocol',
};

const DISCLAIMER =
  'Send a small test amount first and wait for the app to say it landed before sending the rest. Sending on any other network, or any asset not on the accepted list, loses the money: the bridge does not refund.';


export const walletReads: ReadTable = {
  // What an agent calls the moment it attaches. Everything in it is read live, because a
  // greeting that cannot say which network it is on is decoration, and an operator working
  // the wrong world is the failure this whole app exists to make impossible.
  start: (ctx, _body, _args, res) => {
    const snapshot = ctx.ledger.snapshot();
    const wallet = buildWallet(snapshot, ctx.ledger.intents(), ctx.ledger.hyperliquid());
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
      loadProfile(ctx.cfg.dataDir),
    );
    const vault = vaultStatus(ctx);
    sendJson(res, 200, {
      ...greeting,
      // Which screen the window is on, who put it there and when. `facts.view` and the marker
      // in the banner say the same view; this is the record an agent can hold against its own
      // last switch, because the human's tabs move the window too.
      screen: ctx.getScreen(),
      pending: pending.map((p) => p.id),
      stale: wallet.stale,
      /* The vault's facts an agent should carry: how the keys are held, and whether the
         recovery phrase is proven backed up. A balance with no backup is the one thing the
         agent should say out loud before anything else. */
      custody: vault.custody,
      backedUp: vault.backedUp,
    });
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
    const vault = vaultStatus(ctx);
    sendJson(res, 200, {
      ...buildWallet(ctx.ledger.snapshot(), ctx.ledger.intents(), ctx.ledger.hyperliquid()),
      custody: vault.custody,
      backedUp: vault.backedUp,
    });
  },
  /* Where somebody sends money so that NEAR Intents holds it. The agent asks for one asset on
     one network; the app opens the deposit card in the window with the whole address and a
     QR, starts watching for the money, and hands the agent a fingerprint, the minimum, and the
     sentence to relay. The full address never goes to the agent: it is read from the window,
     which shows it off a Touch ID open, and nothing an agent says can change it. A wrong
     network or an asset the bridge does not credit is refused with the list of what is. */
  deposit: async (ctx, _body, args, res) => {
    const chainRaw = typeof args?.chain === 'string' ? args.chain.trim().toLowerCase() : '';
    const symbol = typeof args?.asset === 'string' ? args.asset.trim().toUpperCase() : '';
    const report = await intentsReceiveReport(ctx);
    const accepted = report.networks.map((n) => ({ chain: n.id, network: EXCHANGE_NETWORK[n.id], accepts: n.accepts.map((a) => a.symbol) }));
    if (report.account === null) {
      return sendJson(res, 200, { ok: false, reason: report.reason ?? 'no wallet', accepted });
    }
    if (!CHAIN_IDS.has(chainRaw)) {
      return sendJson(res, 200, {
        ok: false,
        reason: `chain must be one of eth, base, arb, sol, near (got ${chainRaw || 'nothing'}). Ask the person which network they will send on before calling again.`,
        accepted,
      });
    }
    const chain = chainRaw as ChainId;
    const network = report.networks.find((n) => n.id === chain);
    if (network === undefined || network.address === null) {
      return sendJson(res, 200, { ok: false, reason: network?.unavailable ?? `no deposit address for ${chain} right now`, accepted });
    }
    const token = network.accepts.find((a) => a.symbol.toUpperCase() === symbol);
    if (token === undefined) {
      return sendJson(res, 200, {
        ok: false,
        reason: `${symbol || 'that asset'} is not credited on ${EXCHANGE_NETWORK[chain]}. Sending it there loses it. Accepted on that network: ${network.accepts.map((a) => a.symbol).join(', ') || 'nothing'}.`,
        accepted,
      });
    }
    const deposit = ctx.deposits.show(chain, token.symbol, network.address);
    ctx.audit.append('app_start', `the deposit card was opened for ${token.symbol} on ${chain}`, { chain, symbol: token.symbol, by: 'agent' });
    sendJson(res, 200, {
      ok: true,
      shownInWindow: true,
      chain,
      network: EXCHANGE_NETWORK[chain],
      asset: token.symbol,
      minDeposit: token.minDeposit,
      addressFingerprint: fingerprint(network.address),
      addressVerified: report.verified,
      memo: network.memo,
      disclaimer: DISCLAIMER,
      relay: `The address and a QR code are in the Phosphor window now. Tell the person to read it there, check that it ends in ${network.address.slice(-4)}, choose the network "${EXCHANGE_NETWORK[chain]}" on the sending side, and send a small test amount first.`,
      watching: deposit.phase,
      backedUp: vaultStatus(ctx).backedUp,
    });
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
