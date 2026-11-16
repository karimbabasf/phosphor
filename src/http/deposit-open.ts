// The one door a deposit card opens through: the window's POST /api/deposit/show and the agent's
// deposit tool (src/http/read/wallet.ts). Both ask the same questions in the same order, so a coin
// one door refuses the other refuses too, and only the sentences differ (the agent's quote another
// party's words as data).
//
// THE ADDRESS IS MINTED HERE, never taken from a request body: the caller names a network and a
// coin, and the address on the card is the one this process got from 1Click a moment ago for this
// wallet's account, checked line by line before it is kept (src/rails/deposit-quote.ts). Nothing
// that holds the window token or an agent seat can make the card show an address the app did not
// mint. The address is written to the book before it is shown, so Activity can ask about it and a
// payout to it is refused.
//
// ONE ADDRESS, ONE DEPOSIT. A card opened again for the same coin on the same network gets the
// address it already holds while that one has two hours left, nothing was seen arriving at it, and
// 1Click still calls it unused; anything else mints a new one.
//
// AT MOST TWENTY NEW ADDRESSES AN HOUR, both doors together, counted from the book so a restart
// does not reset it: an agent that loops the deposit tool is refused long before it could crowd
// an address that still takes money out of the book the payout check reads. The agent's door may
// take fifteen of them, so a looping agent never shuts the window out.

import { errText } from './respond.ts';
import type { Ctx } from './context.ts';
import { depositRoute, demoFixture } from './wallet.ts';
import type { IntentsReceiveNetwork, IntentsReceiveReport, IntentsReceiveToken } from './wallet.ts';
import { oneLine } from '../intents.ts';
import { currentSymbol, receiveNetworkOf } from '../rails/intents-address.ts';
import type { ReceiveNetwork } from '../rails/intents-address.ts';
import { AGENT_MINTS_PER_HOUR, MINTS_PER_HOUR, ONE_TIME_DEADLINE_MS, deadlineWords, mintRoom, stillGood } from '../rails/deposit-quote.ts';
import type { DepositBook, OneTimeDeposit } from '../rails/deposit-quote.ts';
import { STATUS_LINK, closedQuoteSentence } from '../preflight/route-health.ts';
import type { RouteAudience } from '../preflight/route-health.ts';
import type { DepositState } from '../vault/watch.ts';

export type DepositRefusal = {
  ok: false;
  status: 400 | 409 | 429;
  // The sentence the door that asked prints: the window's plain one, or the agent's labeled one.
  error: string;
  // A route NEAR Intents shut, so the window draws Paused with the status page.
  closed: boolean;
  statusLink: string | null;
};

export type ResolvedDeposit = {
  ok: true;
  chain: string;
  account: string;
  network: IntentsReceiveNetwork;
  token: IntentsReceiveToken;
  // What NEAR Intents reports about the route while it goes ahead, in the asking door's words.
  notice: string | null;
  statusLink: string | null;
};

export type OpenedDeposit = {
  ok: true;
  deposit: DepositState;
  oneTime: OneTimeDeposit;
  reused: boolean;
};

function refuse(error: string, opts: { status?: 400 | 409 | 429; closed?: boolean; statusLink?: string | null } = {}): DepositRefusal {
  return { ok: false, status: opts.status ?? 409, error, closed: opts.closed ?? false, statusLink: opts.statusLink ?? null };
}

/* Whether a card may be opened for this coin on this network right now, without minting anything:
   the report's row, the coin on it, and the route for that exact coin. The window asks this alone
   (GET /api/deposit/route) before it draws; both doors ask it before a mint. `chain` is already a
   registry id; each door reads its own spelling of it. */
export async function resolveDeposit(ctx: Ctx, report: IntentsReceiveReport, chain: string, symbolRaw: unknown, audience: RouteAudience): Promise<ResolvedDeposit | DepositRefusal> {
  const agent = audience === 'agent';
  const symbol = typeof symbolRaw === 'string' ? symbolRaw.trim().toUpperCase() : '';
  if (receiveNetworkOf(chain) === undefined || symbol.length > 12 || (!agent && symbol === '')) return refuse('chain and symbol are required', { status: 400 });
  if (report.account === null) return refuse(report.reason ?? (agent ? 'no wallet' : `no deposit address for ${chain} right now`));
  const network = report.networks.find((n) => n.id === chain);
  if (network === undefined) return refuse(`no deposit address for ${chain} right now`);
  // A paused route, or a coin list that could not be read: the row says why, in each door's words.
  if (network.unavailable !== null) {
    const closed = network.route === 'closed';
    return refuse((agent ? network.agentUnavailable : null) ?? network.unavailable, { closed, statusLink: closed ? network.statusLink : null });
  }
  const want = currentSymbol(chain, symbol);
  const token = network.accepts.find((a) => a.symbol.toUpperCase() === want);
  const listed = network.accepts.map((a) => a.symbol).join(', ') || 'nothing';
  if (token === undefined || token.assetId === '') {
    return refuse(
      agent
        ? `${symbol || 'that asset'} is not credited on ${network.words}. Sending it there loses it. Accepted on that network: ${listed}.`
        : `${symbol} is not credited on ${network.name}; accepted: ${listed}`,
    );
  }
  // The route for this exact coin: TON USDT is its own question, and the row asked about TON's coin.
  const route = await depositRoute(ctx, chain, report.account, token.assetId, audience);
  if (route.closed !== null) return refuse(route.closed, { closed: true, statusLink: route.link });
  // Not a pause: the window draws this sentence with Try again.
  if (route.unconfirmed !== null) return refuse(route.unconfirmed);
  const notice = route.notice ?? (agent ? network.agentNotice : network.notice);
  return { ok: true, chain, account: report.account, network, token, notice, statusLink: notice === null ? null : (route.link ?? network.statusLink) };
}

/* The address the watch already carries, when it may be handed out again: the same account, chain
   and coin, two hours or more left, nothing seen at it here, and 1Click still calling it unused. A
   status read that fails is a no, and a fresh address is minted rather than a used one shown. */
async function reusable(ctx: Ctx, got: ResolvedDeposit, now: number): Promise<OneTimeDeposit | null> {
  const held = ctx.deposits.held();
  const state = ctx.deposits.current();
  if (held === null || state === null || !state.oneTime || state.address !== held.address) return null;
  if (state.txHash !== null || state.amount !== null || (state.phase !== 'watching' && state.phase !== 'stopped')) return null;
  if (!stillGood(held, { account: got.account, chain: got.chain, assetId: got.token.assetId }, now)) return null;
  const quotes = ctx.depositQuotes;
  if (quotes === undefined) return ctx.cfg.mode === 'demo' ? held : null;
  try {
    const said = await quotes.status(held.address, held.memo ?? undefined);
    return !said.found || said.status === 'PENDING_DEPOSIT' ? held : null;
  } catch {
    return null;
  }
}

/* The demo's address for the network, from PHOSPHOR_DEMO_RECEIVE, dressed as a one-time quote so
   the card draws the same way. Never in live mode. */
function demoMint(got: ResolvedDeposit, now: number): OneTimeDeposit | null {
  const address = demoFixture()?.addresses[got.chain];
  const net = receiveNetworkOf(got.chain);
  if (address === undefined || net === undefined) return null;
  return {
    account: got.account.toLowerCase(),
    chain: got.chain,
    network: net.bridge,
    symbol: got.token.symbol,
    assetId: got.token.assetId,
    decimals: got.token.decimals,
    address,
    memo: null,
    minimumBase: got.token.minDeposit,
    minimum: got.token.minDepositHuman,
    deadline: new Date(now + ONE_TIME_DEADLINE_MS).toISOString(),
    coldAt: null,
    mintedAt: new Date(now).toISOString(),
    correlationId: null,
    signature: null,
    timestamp: null,
  };
}

/* The mints of each book still waiting on 1Click, held against the hour's count so that many asks
   at once cannot all pass it before the first one is written down. */
const minting = new WeakMap<DepositBook, number>();

/* The sentence for a mint the hour's count refused, in the asking door's words. */
function tooManyWords(freesInMs: number, by: 'window' | 'agent'): string {
  if (by === 'agent') {
    const said = `No new address was made: ${AGENT_MINTS_PER_HOUR} deposit addresses were made on this Mac in the last hour, the most an agent may ask for in an hour.`;
    return `${said} Do not ask for another one before ${deadlineWords(new Date(Date.now() + freesInMs).toISOString())}.`;
  }
  const said = `No new address was made: ${MINTS_PER_HOUR} deposit addresses were made on this Mac in the last hour, the most it makes in an hour.`;
  const minutes = Math.max(1, Math.ceil(freesInMs / 60_000));
  return `${said} Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/* A new address, kept in the book before anything shows it. At most MINTS_PER_HOUR an hour, both
   doors together: an agent that calls the deposit tool over and over is refused here, so it can
   never crowd an address that still takes money out of the book the payout check reads. */
async function mintAndKeep(ctx: Ctx, got: ResolvedDeposit, net: ReceiveNetwork, by: 'window' | 'agent', now: number): Promise<{ ok: true; record: OneTimeDeposit } | DepositRefusal> {
  const book = ctx.depositBook;
  const waiting = minting.get(book) ?? 0;
  // The agent's door stops short of the hour's count, so the window always keeps some of it.
  const room = mintRoom(book.all(), Date.now(), waiting, by === 'agent' ? AGENT_MINTS_PER_HOUR : MINTS_PER_HOUR);
  if (!room.ok) return refuse(tooManyWords(room.freesInMs, by), { status: 429 });
  minting.set(book, waiting + 1);
  try {
    let record: OneTimeDeposit | null;
    if (ctx.cfg.mode === 'demo') {
      record = demoMint(got, now);
      if (record === null) return refuse(`the demo has no address for ${net.name}`);
    } else {
      const quotes = ctx.depositQuotes;
      if (quotes === undefined) return refuse('this build of the app has no line to NEAR Intents, so no address is shown');
      try {
        record = await quotes.mint({ account: got.account, net, token: { symbol: got.token.symbol, assetId: got.token.assetId, decimals: got.token.decimals } });
      } catch (err) {
        // 1Click shutting the pair is a pause upstream, drawn as one; anything else is said as it was.
        const closed = closedQuoteSentence(err, got.chain, 'deposit');
        if (closed !== null) return refuse(closed, { closed: true, statusLink: STATUS_LINK });
        return refuse(`No address was made for ${got.token.symbol} on ${net.name}: ${oneLine(errText(err), 300)}`);
      }
    }
    // Kept before it is shown: an address the app cannot find again is never on screen.
    try {
      book.add(record);
    } catch (err) {
      return refuse(`The new address could not be written down on this Mac, so it is not shown (${oneLine(errText(err), 120)}). Nothing was sent anywhere.`);
    }
    return { ok: true, record };
  } finally {
    minting.set(book, (minting.get(book) ?? 1) - 1);
  }
}

/* Resolve, then reuse or mint, then keep, then show. The watch starts on the address the card
   draws, and the window reads it from the watch. */
export async function openDeposit(ctx: Ctx, got: ResolvedDeposit, by: 'window' | 'agent'): Promise<OpenedDeposit | DepositRefusal> {
  const now = Date.now();
  const net = receiveNetworkOf(got.chain);
  if (net === undefined) return refuse('chain and symbol are required', { status: 400 });
  let record = await reusable(ctx, got, now);
  const reused = record !== null;
  if (record === null) {
    const made = await mintAndKeep(ctx, got, net, by, now);
    if (!made.ok) return made;
    record = made.record;
  }
  const deposit = ctx.deposits.show(got.chain, got.token.symbol, record.address, { assetId: got.token.assetId, decimals: got.token.decimals, contract: got.token.contract }, record);
  ctx.audit.append('app_start', `the deposit card was opened for ${got.token.symbol} on ${got.chain}`, {
    chain: got.chain,
    symbol: got.token.symbol,
    by,
    oneTime: true,
    reused,
    deadline: record.deadline,
    correlationId: record.correlationId,
  });
  return { ok: true, deposit, oneTime: record, reused };
}
