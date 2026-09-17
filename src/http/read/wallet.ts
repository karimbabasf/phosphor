// The wallet reads: what an agent sees the moment it attaches, what the money is, what the
// rules say, what has been asked for, and the log behind all of it.

import { classify } from '../../composition.ts';
import { buildWallet } from '../../wallet.ts';
import { buildGreeting } from '../../greeting.ts';
import { loadProfile } from '../../profile/index.ts';
import { VERSION } from '../../version.ts';
import { fail, intParam, sendJson } from '../respond.ts';
import { LOG_LIMIT_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';
import { sentencesOf } from '../state.ts';
import { vaultStatus } from '../vault.ts';
import { outcomeOf } from '../../proposals/lifecycle.ts';
import type { PlanFate } from '../../proposals/lifecycle.ts';
import { RECEIVE_NETWORKS, receiveNetworkOf } from '../../rails/intents-address.ts';

/* An address for the agent's eyes: enough to say "check it ends in 9Xk2" and not enough to
   paste. The window shows the whole string, off a Touch ID open, and that is the only place
   a person should read it from. */
export function fingerprint(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

/* The other spellings an agent reaches for: the chain's full name, the ticker it is known by
   where that names one chain, and the network label off an exchange's withdraw screen. Each
   maps to a registry id. Compared with spaces, hyphens and underscores removed and case
   folded, so "BNB Smart Chain", "bnb-chain" and "bnbchain" are one word. A ticker shared by
   several chains (ETH) is not here: guessing which one is how money is lost. */
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: 'eth', erc20: 'eth', mainnet: 'eth', 'ethereum mainnet': 'eth',
  arbitrum: 'arb', 'arbitrum one': 'arb', arb1: 'arb',
  solana: 'sol', spl: 'sol',
  'near protocol': 'near',
  bitcoin: 'btc',
  'bitcoin cash': 'bch',
  litecoin: 'ltc',
  dogecoin: 'doge',
  zcash: 'zec',
  ripple: 'xrp', xrpl: 'xrp', 'xrp ledger': 'xrp',
  'the open network': 'ton', toncoin: 'ton',
  trx: 'tron', trc20: 'tron',
  apt: 'aptos',
  ada: 'cardano',
  xlm: 'stellar',
  strk: 'starknet',
  move: 'movement',
  hyperliquid: 'hypercore', hl: 'hypercore', 'hyper core': 'hypercore',
  optimism: 'op', 'op mainnet': 'op',
  'gnosis chain': 'gnosis', xdai: 'gnosis',
  matic: 'polygon', pol: 'polygon', 'polygon pos': 'polygon',
  mon: 'monad',
  'x layer': 'xlayer', okx: 'xlayer', okb: 'xlayer',
  'adi chain': 'adi',
  avalanche: 'avax', 'c chain': 'avax', 'avalanche c chain': 'avax',
  'robinhood chain': 'robinhood',
  bsc: 'bnb', 'bnb chain': 'bnb', 'bnb smart chain': 'bnb', 'binance smart chain': 'bnb', binance: 'bnb', bep20: 'bnb',
  berachain: 'bera',
  xpl: 'plasma',
};
const CHAIN_IDS = RECEIVE_NETWORKS.map((n) => n.id).join(', ');

function fold(word: string): string {
  return word.toLowerCase().replace(/[\s_-]+/g, '');
}
const ALIAS_BY_FOLD = new Map(Object.entries(CHAIN_ALIASES).map(([alias, id]) => [fold(alias), id]));

/* The registry id for what the agent typed, or null. An id is taken as it is; anything else
   goes through the alias table. */
function chainIdOf(raw: string): string | null {
  const word = fold(raw);
  if (word === '') return null;
  if (receiveNetworkOf(word) !== undefined) return word;
  return ALIAS_BY_FOLD.get(word) ?? null;
}

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
  composition: (ctx, _body, _args, res) => {
    const wallet = buildWallet(ctx.ledger.snapshot(), ctx.ledger.intents(), ctx.ledger.hyperliquid());
    sendJson(res, 200, classify(wallet.rows, ctx.riskRows));
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
    const chainRaw = typeof args?.chain === 'string' ? args.chain.trim() : '';
    const symbol = typeof args?.asset === 'string' ? args.asset.trim().toUpperCase() : '';
    const report = await ctx.intentsReceive();
    // `network` is the label off an exchange's withdraw screen, which is where the money is lost.
    const accepted = report.networks.map((n) => ({ chain: n.id, network: n.words, accepts: n.accepts.map((a) => a.symbol) }));
    if (report.account === null) {
      return sendJson(res, 200, { ok: false, reason: report.reason ?? 'no wallet', accepted });
    }
    const chain = chainIdOf(chainRaw);
    if (chain === null) {
      return sendJson(res, 200, {
        ok: false,
        reason: `chain must be one of ${CHAIN_IDS} (got ${chainRaw || 'nothing'}). Ask the person which network they will send on before calling again.`,
        accepted,
      });
    }
    const network = report.networks.find((n) => n.id === chain);
    if (network === undefined || network.address === null) {
      return sendJson(res, 200, { ok: false, reason: network?.unavailable ?? `no deposit address for ${chain} right now`, accepted });
    }
    const token = network.accepts.find((a) => a.symbol.toUpperCase() === symbol);
    if (token === undefined) {
      return sendJson(res, 200, {
        ok: false,
        reason: `${symbol || 'that asset'} is not credited on ${network.words}. Sending it there loses it. Accepted on that network: ${network.accepts.map((a) => a.symbol).join(', ') || 'nothing'}.`,
        accepted,
      });
    }
    const deposit = ctx.deposits.show(chain, token.symbol, network.address);
    ctx.audit.append('app_start', `the deposit card was opened for ${token.symbol} on ${chain}`, { chain, symbol: token.symbol, by: 'agent' });
    // A memo is half the destination on the chains that route by one: said in the relay line
    // so it cannot be left out of what the person is told.
    const memoLine = network.memo === null ? '' : ` This network needs the memo ${network.memo} on the deposit as well; without it the money is not credited.`;
    sendJson(res, 200, {
      ok: true,
      shownInWindow: true,
      chain,
      network: network.words,
      asset: token.symbol,
      // In the token's own unit ("0.001"), never the bridge's base units ("1000"): the agent
      // relays this number to a person about to type an amount.
      minDeposit: token.minDepositHuman,
      addressFingerprint: fingerprint(network.address),
      addressVerified: report.verified,
      memo: network.memo,
      disclaimer: DISCLAIMER,
      relay: `The address and a QR code are in the Phosphor window now. Tell the person to read it there, check that it ends in ${network.address.slice(-4)}, choose the network "${network.words}" on the sending side, and send a small test amount first.${memoLine}`,
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
    /* `outcome` is the one word the agent may repeat about this row (confirmed, settling,
       failed, unconfirmed, pending) with a plain sentence and the pocket's before and after,
       so a settling swap is never reported as failed. A trade proposal's fate is its plan's:
       the entry is confirmed, unconfirmed or ended on the runner's row, not on this one. */
    let plan: PlanFate | null = null;
    if (proposal.kind === 'trade') {
      try {
        const plans = (ctx.trade.payload() as { plans?: Array<PlanFate & { proposalId?: string }> }).plans ?? [];
        plan = plans.find((row) => row.proposalId === proposal.id) ?? null;
      } catch {
        plan = null;
      }
    }
    sendJson(res, 200, { ...proposal, outcome: outcomeOf(proposal, plan) });
  },
};
