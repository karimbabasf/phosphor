// The balances panel, as one pure function, and the sentences a receipt is headlined with.
//
// Every word a non-technical person reads about their money is written here and nowhere else.
// The browser renders this object and composes no sentences of its own, for the same reason
// policy sentences are machine-rendered: a money sentence built in untested browser JavaScript
// is a claim nothing checks.
//
// TWO PLACES THIS REFUSES TO STATE A NUMBER
//   1. A place that failed to read. A zero and an unknown look identical on screen, and the
//      panel is aimed at someone who cannot tell them apart.
//   2. A balance fetched before the most recent execution. The ledger cache serves pre-trade
//      balances after a write and still stamps them stale: [], because stale[] tracks places
//      that failed to READ, not data that is out of date. Verified 2026-08-12: an executed move
//      sent 36.540787 USDC and 0.011 WETH on chain while wallet still returned every pre-trade
//      figure.
// Both fail toward saying less rather than toward stating a stale number as fact.

import type { BasicHolding, BasicView, ChainId, Proposal, WalletView, WriteDraft } from '../types.ts';

// What the server managed to read about one of the coins the price tracker follows. Null rather
// than a stale figure, and null rather than a zero: see the rule at the top of the file.
export type PriceReading = {
  product: string; // 'ETH-USD'
  priceUsd: number;
  changePct: number; // over the tracked window, not since some arbitrary epoch
  closes: number[]; // the same window as a series, oldest first
} | null;

export type BasicInput = {
  wallet: WalletView;
  proposals: Proposal[];
  policyReadable: boolean;
  killSwitch: boolean;
  // When the ledger's last read started, ISO. Held against the newest executed proposal.
  readAt: string;
};

// Plain names for the symbols a non-technical reader will actually meet. The row is titled by
// the symbol, as the coin is written everywhere else; the plain name is what a screen reader
// says, and what a receipt headline says.
const PLAIN_SYMBOL: Record<string, string> = {
  USDC: 'US dollars (USDC)',
  USDT: 'US dollars (USDT)',
  DAI: 'US dollars (DAI)',
  PYUSD: 'US dollars (PYUSD)',
  USDE: 'US dollars (USDe)',
  WETH: 'Ether (WETH)',
  ETH: 'Ether (ETH)',
  SOL: 'Solana (SOL)',
  NEAR: 'NEAR',
  BTC: 'Bitcoin (BTC)',
};

const PLAIN_CHAIN: Record<string, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  near: 'NEAR',
};

function plainSymbol(symbol: string): string {
  return PLAIN_SYMBOL[symbol.toUpperCase()] ?? symbol;
}

function plainChain(chain: string): string {
  return PLAIN_CHAIN[chain] ?? chain;
}

// A payout network as this reader knows it. The ids are chainscan's (src/chainscan/networks.ts).
const PLAIN_NETWORK: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  solana: 'Solana',
  near: 'NEAR',
  bitcoin: 'Bitcoin',
};

function plainNetwork(network: string): string {
  return PLAIN_NETWORK[network] ?? network;
}

export function money(usd: number): string {
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------- freshness ----------

function readAtMs(readAt: string): number {
  const t = Date.parse(readAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

// A row after which the balance may differ from the last read: anything that went through,
// and anything that carries a hash whatever its status, because a hash means money moved or
// may have. Stamped by when the rail returned when that was recorded: the decision can be a
// minute earlier, and a read taken between the two is not the new balance.
function movedMoney(p: Proposal): boolean {
  if (p.status === 'executed') return true;
  if (p.status !== 'failed' && p.status !== 'needs_reconciliation') return false;
  // A hash, or the handle or nonce of a signed intent or a venue send that got no answer:
  // each is something live at a venue that this app did not see settle.
  const evidence = p.result?.evidence;
  return (p.result?.txids ?? []).length > 0 || evidence?.handle !== undefined || evidence?.nonce !== undefined;
}

function movedAt(p: Proposal): string {
  return p.settledAt ?? p.decidedAt ?? p.createdAt;
}

function newestExecutionAt(proposals: Proposal[]): number {
  let newest = 0;
  for (const p of proposals) {
    if (!movedMoney(p)) continue;
    const t = Date.parse(movedAt(p));
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

// ---------- the kinds this app no longer builds ----------

/* lp_add, lp_remove, yield_deposit and yield_withdraw were real rails, consolidate and transfer
   were the chain-era fund moves, and intents_deposit and intents_withdraw moved between a chain
   wallet and the verifier. state/proposals.json holds executed and refused rows naming them, and
   the money they moved was real, so a receipt still headlines them. Nothing can propose one of
   these again; every one of them can still be read back.
   `kindOf` exists because draft.kind no longer includes the retired names, so TypeScript calls
   the comparison unreachable and refuses it. Reading the same field as a string is the honest
   way to say "this value is wider at rest than the live type is". `retired` is the matching
   read for the fields those drafts carried. */
type RetiredLeg = { fromChain?: ChainId; toChain?: ChainId; symbol?: string; amountUsd?: number; to?: string };

type RetiredDraft = {
  chain?: ChainId;
  symbol?: string;
  maxNotionalUsd?: number;
  maxLossUsd?: number;
  toChain?: ChainId;
  totalUsd?: number;
  leg?: RetiredLeg;
};

function kindOf(draft: WriteDraft): string {
  return draft.kind;
}

function retired(draft: WriteDraft): RetiredDraft {
  return draft as unknown as RetiredDraft;
}

export function amountUsdOf(draft: WriteDraft): number {
  if (kindOf(draft) === 'consolidate') return retired(draft).totalUsd ?? 0;
  if (kindOf(draft) === 'transfer') return retired(draft).leg?.amountUsd ?? 0;
  if (draft.kind === 'policy_change') return 0;
  // Every retired kind carried amountUsd too, so the same read serves them.
  return (draft as { amountUsd?: number }).amountUsd ?? 0;
}

// "$0.00" is not an amount, it is the absence of one. A draft can legitimately price at zero
// (nothing left to consolidate, which is then refused), so the money clause is dropped rather
// than printed as a figure. Substituting "money" was tried and shipped "gathering money of your
// US dollars (USDT) onto Ethereum", which is not English.
function amountClause(amountUsd: number): string {
  return amountUsd > 0 ? `${money(amountUsd)} of ` : '';
}

// ---------- what you hold ----------

// A quantity is shown at the precision that distinguishes it, not at a fixed one.
// "0.00" of Ether and "0.31" of Ether are different holdings; "1204.00" and
// "1204.000000" are the same one, and the second is harder to read at a glance.
function quantity(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const abs = Math.abs(amount);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

// Under a cent is folded into one line rather than listed: a row reading $0.00 says "you own
// nothing of this" about something the person does own.
const SMALL_USD = 0.01;

type Held = { list: BasicHolding[]; small: number };

// One row per THING OWNED, not one per place. The same dollars inside NEAR Intents and in the
// trading account are one holding to this reader; which place each part sits in is a Pro fact.
// A coin the app has no price for keeps its row with no dollar figure: its value is unknown,
// which is not the same as small, and never the same as zero.
function buildHoldings(wallet: WalletView, unread: boolean): Held {
  if (unread) return { list: [], small: 0 };

  const coins = new Map<string, { symbol: string; qty: number; usd: number; priced: boolean }>();
  for (const row of wallet.rows ?? []) {
    const key = row.symbol.toUpperCase();
    const at = coins.get(key) ?? { symbol: row.symbol, qty: 0, usd: 0, priced: false };
    at.qty += row.quantity;
    if (row.priced !== false) {
      at.usd += row.valueUsd;
      at.priced = true;
    }
    coins.set(key, at);
  }

  const priced: BasicHolding[] = [];
  const unpriced: BasicHolding[] = [];
  let small = 0;
  for (const at of coins.values()) {
    if (at.priced && at.usd < SMALL_USD) {
      small += 1;
      continue;
    }
    (at.priced ? priced : unpriced).push({
      symbol: at.symbol,
      name: plainSymbol(at.symbol),
      quantityLine: quantity(at.qty),
      valueLine: at.priced ? money(at.usd) : null,
      valueUsd: at.priced ? at.usd : null,
    });
  }
  priced.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  unpriced.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { list: [...priced, ...unpriced], small: small + (wallet.dustCount ?? 0) };
}

// "WIF", "wNEAR and WIF", "3 coins": the names of what the total leaves out.
function namesOf(symbols: string[]): string {
  if (symbols.length <= 2) return symbols.join(' and ');
  return `${symbols.length} coins`;
}

function smallLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 tiny balance under a cent, not listed' : `${count} tiny balances under a cent, not listed`;
}

// ---------- what happened, for the receipts ----------

// Past tense, for something that actually happened.
export function didHeadline(draft: WriteDraft, amountUsd: number): string {
  const amt = amountClause(amountUsd);
  if (draft.kind === 'swap') {
    return `Changed ${amt}your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}.`;
  }
  if (draft.kind === 'hl_deposit') return `Moved ${amt}your ${plainSymbol(draft.symbol)} to your Hyperliquid trading account.`;
  if (draft.kind === 'hl_withdraw') return `Brought ${amt}your ${plainSymbol(draft.symbol)} back out of your Hyperliquid trading account.`;
  /* The two rails that now carry nearly all of it, and neither had a sentence: both fell
     through to the safety-rules line at the bottom, so a NEAR Intents deposit read as
     "Changed one of your safety rules." on this screen and on every receipt. */
  if (kindOf(draft) === 'intents_deposit') {
    return `Moved ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} from ${plainChain(retired(draft).chain ?? '')} into NEAR Intents.`;
  }
  if (kindOf(draft) === 'intents_withdraw') {
    return `Brought ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} out of NEAR Intents onto ${plainChain(retired(draft).chain ?? '')}.`;
  }
  if (draft.kind === 'intents_send') {
    return `Sent ${amt}your ${plainSymbol(draft.symbol)} inside NEAR Intents to ${draft.to}.`;
  }
  if (draft.kind === 'intents_pay') {
    return `Paid ${amt}your ${plainSymbol(draft.symbol)} out of NEAR Intents to ${draft.to} on ${plainNetwork(draft.network)}.`;
  }
  if (kindOf(draft) === 'lp_add') return `Put ${amt}your money into a pool.`;
  if (kindOf(draft) === 'lp_remove') return 'Took money back out of a pool.';
  if (kindOf(draft) === 'yield_deposit') return `Put ${amt}your money somewhere it earns interest.`;
  if (kindOf(draft) === 'yield_withdraw') return 'Brought your money back out of the place it was earning interest.';
  if (kindOf(draft) === 'consolidate') return `Gathered ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} onto ${plainChain(retired(draft).toChain ?? '')}.`;
  if (kindOf(draft) === 'transfer') return `Sent ${amt}your ${plainSymbol(retired(draft).leg?.symbol ?? '')} to another address.`;
  /* The venue rows. An approved plan is a bot from the moment the click lands: the runner
     places the entry and manages the exits without asking again, so the receipt says what
     was armed, in the plan's own figures. The fill is not here, because the proposal never
     learns it: the runner reads fills off the venue, and the trade page shows them. A
     change names the plan by its id, which is all the change draft carries. */
  if (draft.kind === 'trade') {
    if (draft.op === 'open') {
      const plan = draft.plan;
      const side = plan.side === 'long' ? 'Long' : 'Short';
      const target = plan.target === undefined ? '' : `, target ${price(plan.target)}`;
      return `Armed a bot: ${side} ${plan.symbol} ${money(plan.sizeUsd)} at ${plan.leverage}x, stop ${price(plan.stop)}${target}.`;
    }
    if (draft.cancel === true) return `Cancelled bot ${draft.id} before it opened.`;
    if (draft.close === true) return `Closed trade ${draft.id} at the market.`;
    const moved: string[] = [];
    if (draft.stop !== undefined) moved.push(`the stop to ${price(draft.stop)}`);
    if (draft.target !== undefined) moved.push(`the target to ${price(draft.target)}`);
    return `Moved ${moved.length > 0 ? moved.join(' and ') : 'the exits'} on trade ${draft.id}.`;
  }
  if (kindOf(draft) === 'mandate_arm') {
    const arm = retired(draft);
    return `Armed a bot on ${arm.symbol ?? 'the venue'}: at most ${money(arm.maxNotionalUsd ?? 0)} at a time, stopping for good after ${money(arm.maxLossUsd ?? 0)} lost.`;
  }
  return 'Changed one of your safety rules.';
}

// The same sentence as a thing that was tried and did not, or may not have, go through. Built
// from the past tense form so the two never drift: only the verb changes.
const TRIED_VERBS: Record<string, string> = {
  Changed: 'change',
  Moved: 'move',
  Brought: 'bring',
  Put: 'put',
  Took: 'take',
  Gathered: 'gather',
  Sent: 'send',
  Armed: 'arm',
  Cancelled: 'cancel',
  Closed: 'close',
};

export function triedHeadline(draft: WriteDraft, amountUsd: number): string {
  const did = didHeadline(draft, amountUsd);
  const space = did.indexOf(' ');
  const verb = TRIED_VERBS[space > 0 ? did.slice(0, space) : did];
  return verb === undefined ? `Tried: ${did}` : `Tried to ${verb}${did.slice(space)}`;
}

// A venue price in the sentence, as the venue quotes it: grouped thousands, no trailing
// zeros, and as many decimals as the plan gave it, so a stop at 0.4512 is not rounded to 0.45.
function price(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

// ---------- the panel ----------

export function buildBasic(input: BasicInput): BasicView {
  const { wallet, proposals, policyReadable, killSwitch } = input;

  const staleChains = wallet.stale ?? [];
  const lastExecution = newestExecutionAt(proposals);
  const staleAfterWrite = lastExecution > 0 && readAtMs(input.readAt) < lastExecution;

  /* The figure and the line under it are two fields, because they land in two places. The
     figure's slot carries the last read total whenever one exists, and the caption says why that
     number is not yet fact. `totalUsd` still goes null, so nothing downstream treats the number
     as settled. An unknown total that reads as nothing leaves the slot empty rather than showing
     a zero: a zero and an unknown look the same on screen. A holding the app has no price for is
     left out of totalUsd, so the caption names it rather than letting the figure read as the
     whole (2026-09-20: "$0.00" over 2.0097 wNEAR). */
  let totalUsd: number | null = wallet.totalUsd;
  if (staleChains.length > 0 || staleAfterWrite) totalUsd = null;

  const unpriced = wallet.unpriced ?? [];
  const nothingRead = totalUsd === null && wallet.totalUsd === 0;
  const nothingPriced = unpriced.length > 0 && wallet.totalUsd === 0;
  const totalLine = nothingRead || nothingPriced ? '' : money(wallet.totalUsd);

  let caption: string;
  if (staleChains.length > 0) caption = totalLine === '' ? 'Still checking your balance.' : 'still checking';
  else if (staleAfterWrite) caption = totalLine === '' ? 'Checking your new balance.' : 'checking your new balance';
  else if (nothingPriced) caption = `No price for ${namesOf(unpriced)} right now, so there is no total yet.`;
  else if (unpriced.length > 0) caption = `in your balance, not counting ${namesOf(unpriced)}`;
  else caption = 'in your balance';

  // Nothing can move while these hold, so the window says it in one calm line.
  let warning: string | null = null;
  if (killSwitch) warning = 'You have frozen everything. The assistant cannot move any money.';
  else if (!policyReadable) warning = 'The safety rules cannot be read, so every move is being refused.';

  /* EMPTIED WHEN A PLACE COULD NOT BE READ, and only then. A list with a place missing from it
     looks exactly like the list of someone who owns less. A read that merely predates the last
     write is a different thing: every place answered, the figures are from a moment ago, and the
     caption already says the new balance is being checked (2026-09-19, a $250 deposit settling
     under "Nothing here yet"). */
  const held = buildHoldings(wallet, staleChains.length > 0);

  let emptyLine: string | null = null;
  if (held.list.length === 0 && held.small === 0) {
    emptyLine = staleChains.length > 0
      ? 'Part of your balance could not be read just now. It shows here as soon as it can be.'
      : 'Nothing here yet. Money you add shows up here as it lands.';
  }

  return {
    totalUsd,
    totalLine,
    caption,
    warning,
    holdings: held.list,
    smallLine: smallLine(held.small),
    emptyLine,
  };
}
