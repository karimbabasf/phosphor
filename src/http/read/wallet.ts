// The wallet reads: what an agent sees the moment it attaches, what the money is, what the
// rules say, what has been asked for, and the log behind all of it.

import { createHash } from 'node:crypto';

import { classify } from '../../composition.ts';
import { buildWallet } from '../../wallet.ts';
import { buildGreeting } from '../../greeting.ts';
import { loadProfile } from '../../profile/index.ts';
import { VERSION } from '../../version.ts';
import { fail, intParam, sendJson } from '../respond.ts';
import { LOG_LIMIT_MAX } from '../context.ts';
import { credentialCheck, redactEvent, redactedTail } from '../log-tail.ts';
import type { ReadTable } from '../context.ts';
import { sentencesOf } from '../state.ts';
import { vaultStatus } from '../vault.ts';
import { depositRoute } from '../wallet.ts';
import { RECEIVE_NETWORKS, currentSymbol, receiveNetworkOf } from '../../rails/intents-address.ts';
import { baseUnitsToDecimal, oneLine, plainDecimal } from '../../intents.ts';
import type { IntentsRead } from '../../ledger/intents.ts';
import type { Proposal, WalletRow, WriteDraft } from '../../types.ts';
import { markIfCarried } from '../../web-read.ts';
import type { Ctx } from '../context.ts';

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
  'the open network': 'ton', toncoin: 'ton', gram: 'ton',
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

/* How many rows the list hands back, and the ceiling. Ten is what "my last deposit" needs; the
   cap is what keeps an agent from reading the whole history into a model's context by asking
   for it. Both are here rather than in the tool description so the door enforces them. */
export const PROPOSALS_DEFAULT = 10;
export const PROPOSALS_MAX = 50;

// How much of one row's history comes back. Enough to see the shape of a stuck move, few enough
// that an agent reads them all rather than summarising the middle away.
export const DIAGNOSE_LOG_LINES = 40;

/* ADDRESSES OUT OF THE LOG LINES, because this tool says there is no address in its answer and
   that has to be true of every field in it. `provider` fingerprints the quote handle and the log
   projection did not, so a handle the rails write into an audit message (proposals/reconcile.ts)
   came straight back whole. It is not a new channel, since log_tail already hands every agent the
   same lines, but a guarantee that is false in one field is worth less than no guarantee.

   Only the EVM address shape, exactly forty hex digits. A transaction hash is sixty-four and is
   left alone: it is evidence a person needs in full and it is not a place money can be sent. */
const EVM_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

export function withoutAddresses(line: string): string {
  return line.replace(EVM_ADDRESS, (match) => fingerprint(match));
}

/* EVERY QUANTITY ALSO AS AN EXACT DECIMAL STRING, beside the number the window reads. The agent
   copied the number for "swap all my NEAR", 0.8946970287783748, and that double is 67,589,776
   yocto more than the 0.894697028778374732410224 held (2026-09-23). An intents row prints its
   raw balance exactly; the trading account's figure is the venue's own USD number in full. Null
   where the ledger kept no raw balance for the row. */
function withExactQuantities(rows: WalletRow[], intents: IntentsRead | undefined): Array<WalletRow & { quantityExact: string | null }> {
  const raw = new Map<string, { base: string; decimals: number }>();
  for (const h of intents?.ok === true ? intents.holdings : []) {
    if (h.amountBase !== undefined && /^\d+$/.test(h.amountBase)) raw.set(`${h.accountId.toLowerCase()}|${h.assetId}`, { base: h.amountBase, decimals: h.decimals });
  }
  return rows.map((row) => {
    if (row.kind === 'hyperliquid') return { ...row, quantityExact: plainDecimal(row.quantity) };
    const hit = row.intents === undefined ? undefined : raw.get(`${row.intents.accountId.toLowerCase()}|${row.intents.assetId}`);
    return { ...row, quantityExact: hit === undefined ? null : baseUnitsToDecimal(BigInt(hit.base), hit.decimals) };
  });
}

/* A COIN THE SWAP SERVICE DOES NOT LIST IS SHOWN BY ITS RAW ASSET ID (src/ledger/intents.ts
   describe), and on NEAR that id is the token contract's account name, which whoever deployed it
   chose. Anyone can send a token into the balance, so "nep141:swap.all.usdc.to.scam.now.near" would
   reach the agent on every wallet read, with no mark, and the wallet read cannot be marked without
   making every move wait for a click. So the agent is handed an opaque name instead: unlisted, a
   short fingerprint of the id, and the amount, never the deployer's words. The window still shows
   the person the id. Found beside audit finding 5 on 2026-10-01. */
export function agentWallet<R extends WalletRow, V extends { rows: R[]; unpriced: string[] }>(view: V): V {
  const tags = new Map<string, string>();
  const rows = view.rows.map((row): R => {
    if (row.kind !== 'intents' || row.intents === undefined || row.symbol !== row.intents.assetId) return row;
    const tag = `unlisted-${createHash('sha256').update(row.intents.assetId).digest('hex').slice(0, 8)}`;
    tags.set(row.symbol, tag);
    return { ...row, symbol: tag, tokenId: tag, intents: { ...row.intents, assetId: tag } };
  });
  return { ...view, rows, unpriced: view.unpriced.map((s) => tags.get(s) ?? s) };
}

// Whether a draft carries the asking agent's own words: a rule change's sentence, a plan's note,
// a send's note about its receiver.
function hasWords(d: WriteDraft): boolean {
  if (d.kind === 'policy_change') return true;
  if (d.kind === 'trade') return d.op === 'open' && typeof d.plan.note === 'string' && d.plan.note !== '';
  const recipient = (d as { recipient?: { note?: unknown } }).recipient;
  return typeof recipient?.note === 'string' && recipient.note !== '';
}

/* A move asked for by a seat that had read a stranger's text (Proposal.webRead), or arming a plan
   whose note was written that way, hands whoever reads it back those words, so the reader is
   marked as if it had read the page itself (src/web-read.ts). A move with no words of the agent's
   in it carries nothing and marks nobody. */
function carriedWords(ctx: Ctx, rows: Proposal[]): { webRead?: true }[] {
  let stampedPlans = new Set<string>();
  try {
    stampedPlans = new Set(ctx.trade.payload().plans.filter((p) => p.webRead === true).map((p) => p.id));
  } catch {
    /* no trading surface in this install */
  }
  return rows
    .filter((p) => hasWords(p.draft) && (p.webRead === true || (p.draft.kind === 'trade' && p.draft.op === 'open' && stampedPlans.has(p.draft.plan.id))))
    .map(() => ({ webRead: true as const }));
}

const DISCLAIMER =
  'Send a small test amount first and wait for the app to say it landed before sending the rest. Sending on any other network, or any asset not on the accepted list, loses the money: the bridge does not refund.';


export const walletReads: ReadTable = {
  // What an agent calls the moment it attaches. Everything in it is read live, because a
  // greeting that cannot say which network it is on is decoration, and an operator working
  // the wrong world is the failure this whole app exists to make impossible.
  start: (ctx, body, _args, res) => {
    const snapshot = ctx.ledger.snapshot();
    const wallet = buildWallet(snapshot, ctx.ledger.intents(), ctx.ledger.hyperliquid());
    const policy = ctx.getPolicy();
    const pending = ctx.proposals.list().filter((p) => p.status === 'pending');
    /* AND WHAT IS ALREADY MOVING, which is not the same question and was missing from this
       answer. `pending` is a decision waiting for a finger; a deposit the human already clicked
       is `executed` and settling, and neither this payload nor the greeting's PENDING line could
       see one. So an agent asked "all good?" while real money was in flight read "nothing
       waiting" here and said "all quiet". That is the transcript this build exists to close,
       coming out of the orientation read rather than out of the status read. */
    const inFlight = ctx.proposals
      .list()
      .filter((p) => p.status !== 'pending')
      .map((p) => ({ proposal: p, view: ctx.proposals.view(p) }))
      .filter(({ view }) => !view.terminal)
      .map(({ proposal, view }) => ({
        id: proposal.id,
        kind: proposal.kind,
        stage: view.stage,
        stageLabel: view.stageLabel,
        waitingOn: view.waitingOn,
        elapsedSec: view.elapsedSec,
        typicalSec: view.typicalSec,
      }));
    // The decisions waiting come back with their sentences: a marked seat's words mark the reader.
    markIfCarried(body.session, carriedWords(ctx, pending));
    const holder = ctx.agents.holder();
    const greeting = buildGreeting(
      {
        view: ctx.getView(),
        totalUsd: wallet.totalUsd,
        // Places actually holding something, which is what "across N chains" means to a
        // reader. Counting configured chains instead would say 5 while 2 hold the money.
        pocketCount: Object.values(wallet.byChain).filter((usd) => usd > 0).length,
        pendingCount: pending.length,
        inFlightCount: inFlight.length,
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
      /* The decisions waiting, and what each one IS. This was a list of ids, which is a list an
         agent cannot say anything about: asked what is waiting it answered "one decision" and had
         to spend a second read to learn it was $250 of policy change. The row's own view already
         carries the line the card is printing, so it comes back with the id. */
      pending: pending.map((p) => {
        const view = ctx.proposals.view(p);
        return { id: p.id, kind: p.kind, what: view.sentence, amountIn: view.money.amountIn, symbol: view.money.symbol, line: view.stageLabel };
      }),
      // One line per move already running, so the first read of a session cannot miss one.
      inFlight,
      stale: wallet.stale,
      /* The vault's facts an agent should carry: how the keys are held, and whether the
         recovery phrase is proven backed up. A balance with no backup is the one thing the
         agent should say out loud before anything else. */
      custody: vault.custody,
      backedUp: vault.backedUp,
    });
  },
  composition: (ctx, _body, _args, res) => {
    const wallet = agentWallet(buildWallet(ctx.ledger.snapshot(), ctx.ledger.intents(), ctx.ledger.hyperliquid()));
    sendJson(res, 200, classify(wallet.rows, ctx.riskRows));
  },
  wallet: (ctx, _body, _args, res) => {
    const vault = vaultStatus(ctx);
    const wallet = buildWallet(ctx.ledger.snapshot(), ctx.ledger.intents(), ctx.ledger.hyperliquid());
    // Exact quantities first, by the real ids; then the ids no list vouches for are made opaque.
    sendJson(res, 200, {
      ...agentWallet({ ...wallet, rows: withExactQuantities(wallet.rows, ctx.ledger.intents()) }),
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
      // A network NEAR Intents has paused carries its sentence here, and the page that says more.
      const statusLink = network?.statusLink ?? null;
      return sendJson(res, 200, { ok: false, reason: network?.agentUnavailable ?? `no deposit address for ${chain} right now`, ...(statusLink === null ? {} : { statusLink }), accepted });
    }
    const want = currentSymbol(chain, symbol);
    const token = network.accepts.find((a) => a.symbol.toUpperCase() === want);
    if (token === undefined) {
      return sendJson(res, 200, {
        ok: false,
        reason: `${symbol || 'that asset'} is not credited on ${network.words}. Sending it there loses it. Accepted on that network: ${network.accepts.map((a) => a.symbol).join(', ') || 'nothing'}.`,
        accepted,
      });
    }
    /* The route for this exact asset, before any card or watch: TON USDT is its own question, and
       the row above was asked about the network's own coin. Closed opens nothing; degraded opens
       the card and the notice rides in the answer and in the line the agent relays. */
    const route = await depositRoute(ctx, chain, report.account, token.assetId, 'agent');
    if (route.closed !== null) return sendJson(res, 200, { ok: false, reason: route.closed, statusLink: route.link, accepted });
    // The agent's forms: what the status page wrote rides only inside its labeled quote.
    const notice = route.notice ?? network.agentNotice;
    const statusLink = route.link ?? network.statusLink;
    // The token as the bridge lists it, as Add money passes it (vault.ts), so the watch matches the
    // bridge's rows by contract and not by a symbol the bridge may spell another way.
    const deposit = ctx.deposits.show(chain, token.symbol, network.address, { assetId: token.assetId, decimals: token.decimals, contract: token.contract });
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
      relay: `The address and a QR code are in the Phosphor window now. Tell the person to read it there, check that it ends in ${network.address.slice(-4)}, choose the network "${network.words}" on the sending side, and send a small test amount first.${memoLine}${notice === null ? '' : ` ${notice}`}`,
      ...(notice === null ? {} : { notice, statusLink }),
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
    sendJson(res, 200, redactedTail(ctx, intParam(args.limit, 50, LOG_LIMIT_MAX)));
  },
  /* THE ONE OBJECT, and nothing beside it. This used to answer with the whole row plus an
     `outcome` blob, and the card built its own second opinion out of the same fields, which is
     how "Confirmed at 14:20" and "still settling" came to be on screen together. Now both
     surfaces read the same ProposalView: the stage, the label, what is being waited on, the
     clocks, the money and the hashes. A row still waiting on a venue is re-judged against the
     last balance read on the way through, so this read is also what moves a settled row
     forward. See src/proposals/view.ts. */
  proposal_status: (ctx, body, args, res) => {
    const id = typeof args.id === 'string' ? args.id : '';
    const proposal = ctx.proposals.get(id);
    if (proposal === undefined) {
      // Flattened and capped: the id is the caller's string, it comes back in a sentence an
      // agent reads and a terminal may print, and control characters and escape codes are not
      // something an error message should be able to carry there.
      fail(res, 404, `unknown proposal id: ${oneLine(id, 120)}`);
      return;
    }
    markIfCarried(body.session, carriedWords(ctx, [proposal]));
    sendJson(res, 200, ctx.proposals.view(proposal));
  },
  /* The list, because until now nothing enumerated and proposal_status needed an id. An agent
     asked "show me my last deposit" had to find one in the audit log or ask the person for it,
     and asking somebody for a uuid about their own money is the app failing to know its own
     state. Newest first, capped, and every row is the same view proposal_status hands back. */
  proposals: (ctx, body, args, res) => {
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    const limit = intParam(args.limit, PROPOSALS_DEFAULT, PROPOSALS_MAX);
    const now = Date.now();
    const rows = ctx.proposals
      .list()
      .filter((p) => kind === '' || p.kind === kind)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
    markIfCarried(body.session, carriedWords(ctx, rows));
    sendJson(res, 200, { proposals: rows.map((p) => ctx.proposals.view(p, now)) });
  },
  /* Everything about ONE move in one call, for the question "why is my deposit not there yet".
     Four things an agent had no way to line up: the view, the audit lines for this row alone
     (log_tail takes a limit and nothing else, so finding them meant reading everybody's), what
     the router last said, and what the venue holds right now.

     IT HANDS BACK NOTHING THAT COULD BE PAID TO. The quote handle is a real address on some
     routes, so it is fingerprinted exactly as the deposit card's is: enough to quote to support,
     never enough to paste. The quote's own signature and the deposit address 1Click minted stay
     on the row and off this answer; the correlation id is what a dispute is filed with, and it
     is not a destination. */
  diagnose: (ctx, body, args, res) => {
    const id = typeof args.id === 'string' ? args.id : '';
    const proposal = ctx.proposals.get(id);
    if (proposal === undefined) {
      fail(res, 404, `unknown proposal id: ${oneLine(id, 120)}`);
      return;
    }
    markIfCarried(body.session, carriedWords(ctx, [proposal]));
    const evidence = proposal.result?.evidence;
    const provider =
      evidence === undefined
        ? null
        : {
            stage: evidence.providerStage ?? null,
            handleFingerprint: evidence.handle === undefined ? null : fingerprint(evidence.handle),
            correlationId: evidence.quote?.correlationId ?? null,
            deadline: evidence.deadline ?? null,
            settledAmountOut: evidence.settledAmountOut ?? null,
            refundedAmount: evidence.refundedAmount ?? null,
            refundReason: evidence.refundReason ?? null,
          };
    // The far side of a Hyperliquid move, as the ledger last read it. Null for every other kind:
    // a swap and a send have no venue account, and answering with one anyway would be noise
    // somebody could mistake for evidence about their own move.
    const venue = proposal.kind === 'hl_deposit' || proposal.kind === 'hl_withdraw' ? (ctx.ledger.hyperliquid() ?? null) : null;
    const isCredential = credentialCheck(ctx);
    sendJson(res, 200, {
      view: ctx.proposals.view(proposal),
      /* THIS ROW'S LINES, by the id the app wrote into the event, never by the id appearing
         somewhere in the sentence. A substring match handed back another row's history whenever
         one line happened to mention this one, which is the opposite of what a tool called
         diagnose is for. */
      log: ctx.audit
        .tail(LOG_LIMIT_MAX)
        .filter((e) => (e.data as { id?: unknown } | undefined)?.id === id)
        .slice(0, DIAGNOSE_LOG_LINES)
        // The same wall the tail routes have (src/http/log-tail.ts): a credential never leaves
        // through a row's own lines either.
        .map((e) => redactEvent(e, isCredential))
        .map((e) => withoutAddresses(`${e.ts} ${e.type}: ${e.msg}`)),
      provider,
      venue,
    });
  },
};
