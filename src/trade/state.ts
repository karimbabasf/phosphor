// The trading surface's numbers: raw venue state in, one payload out.
//
// Everything the browser draws on /trade is a view of this function's output, and so is
// everything the agent reads. That is deliberate. One derivation means the human and the bot
// cannot be looking at two different accounts, which is the same argument the chart settled for
// price, held here for risk.
//
// The module is pure. No fetch, no timer, no clock of its own: the feed, the plans, the asset
// meta, the ATR lookup and the current time all arrive in deps. That is what makes a bad
// afternoon testable, and a risk panel nobody has tested against a bad afternoon is decoration.
//
// Two rules run through every line below.
//
//   null means unknown, and unknown is never rendered as zero. This comes from a real incident:
//   clearinghouseState reports accountValue 0.0 on a unified account that is holding real money,
//   and a screen printing that zero as a fact tells the human they have nothing while they carry
//   a leveraged position. There is no `?? 0` in this file.
//
//   A wrong number is worse than a missing one. Where the venue does not publish what a figure
//   needs, the figure is null and the reason is in a comment, rather than an approximation that
//   looks authoritative on a risk panel. The human acts on these numbers.

import type { Highlight, OverlayName, TradeViewState } from './view.ts';
import type { PlanRow } from './plans.ts';
import { DUST_USD, fundingBlock, type FundingBlock } from './funding.ts';
import { HYPERLIQUID_EXPLORER_TX } from '../explorers.ts';
import type {
  AccountSnapshot,
  MarketCtx,
  RawFill,
  RawOrder,
  RawPosition,
  TradeFeed,
} from './feed-ws.ts';

// ---------- what this module is handed ----------

// The venue's per-asset facts, read once from `meta` at boot. szDecimals is what a size may be
// rounded to, maxLeverage is the cap the venue itself enforces, assetId is how an order names
// the market.
export type AssetMeta = { assetId: number; szDecimals: number; maxLeverage: number };

// ---------- what this module produces ----------

export type Market = {
  coin: string;
  markPx: number;
  oraclePx: number | null;
  midPx: number | null;
  // Hourly, which is what the venue publishes. No annualised figure is derived here: an
  // unlabelled funding number read at the wrong period is off by 8760x.
  fundingRateHourly: number | null;
  openInterestUsd: number | null;
  volume24hUsd: number | null;
  premiumPct: number | null;
  atr: number | null;
  szDecimals: number | null;
  maxLeverage: number | null;
  assetId: number | null;
};

export type Position = {
  coin: string;
  side: 'long' | 'short';
  sizeCoin: number;
  notionalUsd: number;
  entryPx: number;
  markPx: number | null;
  liqPx: number | null;
  unrealisedUsd: number;
  roePct: number | null;
  leverage: number;
  leverageType: 'cross' | 'isolated';
  marginUsedUsd: number;
  fundingPaidUsd: number;
  // Whether liqPx is a price anything could actually reach. False means the collateral behind the
  // position exceeds its own notional, so the three distances below are blank on purpose. Null
  // means the venue published no liquidation price and the question has no answer yet.
  liqReachable: boolean | null;
  liqDistancePct: number | null;
  liqDistanceUsd: number | null;
  liqDistanceAtr: number | null;
  // A position's result is not one number. Price is what moved, funding is what holding it cost,
  // and a carry trade that is green on price can be red once it has paid for itself. Retail
  // screens show the first of these and call it PnL.
  pnlPriceUsd: number | null;
  pnlFundingUsd: number | null;
  pnlNetUsd: number | null;
};

export type Order = {
  oid: number;
  cloid: string | null;
  coin: string;
  side: 'buy' | 'sell';
  kind: 'limit' | 'trigger';
  role: 'entry' | 'stop' | 'target' | 'reduce';
  px: number | null;
  triggerPx: number | null;
  sizeCoin: number;
  notionalUsd: number | null;
  reduceOnly: boolean;
  tif: string | null;
  atMs: number;
  // The plan whose leg this order is, by the cloid the runner minted for it.
  planId: string | null;
};

export type Fill = {
  tid: string;
  coin: string;
  side: 'buy' | 'sell';
  px: number;
  sizeCoin: number;
  notionalUsd: number;
  feeUsd: number;
  closedPnlUsd: number | null;
  atMs: number;
  tSec: number;
  liquidation: boolean;
  planId: string | null;
  // The venue's ledger hash and order id when the venue stated real ones (feed-ws.ts parseFill
  // drops the all-zero hash), and the explorer page for the hash. Absent otherwise, so the
  // receipt card links only what resolves and the Done row shows its link only on rows that
  // have one.
  hash?: string;
  oid?: string;
  url?: string;
};

export type TradePayload = {
  rev: number;
  lastDriver: 'agent' | 'human';
  symbol: string;
  overlays: Record<OverlayName, boolean>;
  highlights: Highlight[];
  venue: {
    connected: boolean;
    source: 'ws' | 'rest' | 'none';
    ageMs: number | null;
    latencyMs: number | null;
    error: string | null;
    degraded: boolean;
  };
  account: {
    equityUsd: number | null;
    marginUsedUsd: number | null;
    freeUsd: number | null;
    maintenanceUsd: number | null;
    withdrawableUsd: number | null;
    crossLeverage: number | null;
    healthPct: number | null;
    unified: boolean;
    // False until the feed has settled which kind of account this is. While it is false every
    // figure above is null, and the window says it is waiting rather than drawing zeros.
    accountKnown: boolean;
    // Cross margin makes every position a term in every other position's liquidation price, so a
    // per-position view is incomplete by construction. These three are the book as one number.
    netNotionalUsd: number | null;
    grossNotionalUsd: number | null;
    equityAtFivePctAdverse: number | null;
    // What the plans have posted and what they can lose: the sum of margin over every placed
    // and open plan, and the sum of their max loss at the stop. Zero when nothing is placed,
    // because that is an answer and not an unknown.
    atRiskUsd: number;
    maxLossUsd: number;
  };
  // Where the money that backs this account actually is, and how more of it arrives.
  //
  // Deliberately NOT a second copy of `account`. Free and withdrawable are already up there
  // and are read from there; what is down here is the set of facts the account block cannot
  // carry, because they are about the venue and the rail rather than about the book: which
  // Hyperliquid this is, whose account, how much of the collateral is sitting on the spot
  // side where a plan cannot reach it, and what it costs to send more.
  collateral: {
    address: string | null;
    // The perp book's own equity, straight from clearinghouseState and unreinterpreted.
    perpUsd: number | null;
    // The spot book's USDC, straight from spotClearinghouseState. What it MEANS depends on
    // the kind of account and the page says which: on a classic account these are two books
    // and this one backs nothing a plan can spend, while on a unified account they are
    // merged and this money is collateral the moment it lands. Both readings need the two
    // figures side by side, which is why they are published separately rather than summed.
    spotUsdcUsd: number | null;
    // Has this account got anything at all on either book. Null while the feed has not
    // answered, because "nothing here" and "not asked yet" are different sentences and the
    // empty state on this surface names a next action.
    funded: boolean | null;
    // What the rail costs, as a shape. Static: no quote is taken to draw this page, and
    // nothing on this page can start a deposit. A real deposit is priced by the rail's own
    // simulate() at propose time and again at execute time, and it is refused when the live
    // quote disagrees with the draft a human read.
    funding: FundingBlock;
  };
  markets: Market[];
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  // Ideas, waiting, placed, open, and the last twenty done, so the rail can say why a plan
  // stopped. A waiting plan carries which of its conditions hold right now.
  plans: PlanRow[];
  products: string[];
};

// The window the agent's read counts recent fills over.
const ORDER_RATE_WINDOW_MS = 60_000;

// Past this, the screen is no longer claiming to be current. The client pings on a timer and a
// pong is a message, so a healthy socket touches lastMessageMs far more often than this even on
// an account where nothing at all is happening.
const FEED_STALE_MS = 15_000;

// How many fills the agent's read carries. Fills are the one unbounded list on this surface and
// the agent asked what its situation is, not for the tape.
const READ_FILL_LIMIT = 5;

// The size of the adverse move the account is stress tested against. Five percent is a bad hour
// on a major and an ordinary one on anything smaller, which is what makes it a useful sentence
// rather than a tail scenario nobody plans around.
const ADVERSE_MOVE = 0.05;

// ---------- small arithmetic that all of it goes through ----------

function finite(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Every ratio on this surface goes through here. A missing input or a zero denominator is
// unknown, and unknown is null. Returning zero would draw a health bar that reads as fine.
function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const out = numerator / denominator;
  return Number.isFinite(out) ? out : null;
}

function minus(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

function clamp01(v: number | null): number | null {
  return v === null ? null : Math.min(1, Math.max(0, v));
}

// Whether a liquidation price is one anything could reach, which is a different question from
// where it sits.
//
// The threshold is a whole mark of distance, and it is the one place on the scale that is not a
// matter of taste: |liq - mark| >= mark says the loss from here to the wall is at least the
// position's entire notional, which is the same statement as the collateral behind the wall
// exceeding the notional it stands behind. Past that line the position is cash backed rather than
// leveraged and there is no wall to draw. This is the same quantity collateralBehindLiq() in
// feed-ws.ts reads out of liqPx, expressed per position in price terms, so it needs neither the
// account's blended maintenance ratio nor its `sole` caveat to answer.
//
// One rule for both sides, because the sides are only superficially different. A long states this
// plainly: its wall comes out at or below zero and nobody reads a negative number as a price. A
// short has no such tell. Its wall runs off through 84636 on a mark of 87.738, and every number on
// the way there still looks like a price. Writing it as a distance covers both in one line.
function wallIsReachable(liqPx: number, markPx: number): boolean {
  return Math.abs(liqPx - markPx) < markPx;
}

// ---------- positions ----------

// The mark comes from the market context when there is one, because that is the number the chart
// is drawing and the two panels must not disagree about price. Without a context the venue's own
// positionValue implies it, since positionValue is size times mark.
function markFor(p: RawPosition, ctx: MarketCtx | null): number | null {
  const fromCtx = ctx === null ? null : finite(ctx.markPx);
  if (fromCtx !== null) return fromCtx;
  const size = Math.abs(p.szi);
  return size === 0 ? null : ratio(finite(p.positionValueUsd), size);
}

function positionFrom(p: RawPosition, ctx: MarketCtx | null, atr: number | null): Position {
  const side: 'long' | 'short' = p.szi < 0 ? 'short' : 'long';
  const sizeCoin = Math.abs(p.szi);
  const markPx = markFor(p, ctx);
  const liqPx = finite(p.liqPx);
  const marginUsedUsd = finite(p.marginUsedUsd);

  // liqPx is null on a cross position often enough that this is the most likely real null on the
  // whole payload, so all three distances go dark together. Two of the three showing a number
  // while the third is blank would read as a data glitch instead of the truth, which is that the
  // venue has not published a liquidation price for this position.
  //
  // They go dark for a second reason too: a wall that exists and cannot be reached. Measured
  // live: 0.01 SOL sold at 74.914 in a unified account whose 887 dollars of spot USDC back 88 cents of
  // notional, and the venue truthfully answered 84636.71 against a mark of 87.738. The panel then
  // truthfully rendered it 96365 percent away. Neither number is wrong and together they read as
  // a broken screen. A distance is something a human acts on and nobody acts on 96365 percent, so
  // the honest answer is that this position has no wall in reach, not a very large number.
  const rawGapPx = liqPx === null || markPx === null ? null : Math.abs(liqPx - markPx);
  const liqReachable = liqPx === null || markPx === null ? null : wallIsReachable(liqPx, markPx);
  const gapPx = liqReachable === true ? rawGapPx : null;

  // The anchor is the MARK, not the entry, and the choice matters.
  //
  // |liqPx - entryPx| * size is the whole loss from opening the position to losing it, which
  // mixes what already happened with what has not. The human reading this panel already owns the
  // move from entry to mark; the open question is what is still at stake. So the dollar figure is
  // |liqPx - markPx| * size: how much more comes off the account from here. The percent and the
  // ATR figure use the same anchor, so all three answer one question in three units.
  const liqDistanceUsd = gapPx === null ? null : gapPx * sizeCoin;
  const liqDistancePct = gapPx === null ? null : ratio(gapPx * 100, markPx);
  // ATR is the only one of the three that answers "is that far". Twelve percent sounds safe and
  // is not, on something that moves eight percent a day.
  const liqDistanceAtr = gapPx === null ? null : ratio(gapPx, finite(atr));

  // Profit, split into the two things that made it.
  //
  // pnlPriceUsd is the move alone, signed by direction. It is what the venue's own unrealisedPnl
  // reports, since funding is settled into the account balance rather than folded into that
  // figure, so the two agree up to the tick of difference between our mark and the venue's. That
  // is the comparison a reader will want to make, so it is worth saying which is which.
  //
  // pnlFundingUsd is the same period's funding with the sign flipped, because fundingPaidUsd is
  // funding PAID: positive means it cost money, and money that left the account belongs on the
  // negative side of a profit line.
  //
  // Entry and exit fees are not in this split. They are realised at fill time and live on the
  // fills, and the position carries no fee accumulator to read them from.
  const signedSize = side === 'long' ? sizeCoin : -sizeCoin;
  const entryPx = finite(p.entryPx);
  const pnlPriceUsd = markPx === null || entryPx === null ? null : (markPx - entryPx) * signedSize;
  const fundingPaidUsd = finite(p.fundingPaidUsd);
  const pnlFundingUsd = fundingPaidUsd === null ? null : -fundingPaidUsd;
  const pnlNetUsd = pnlPriceUsd === null || pnlFundingUsd === null ? null : pnlPriceUsd + pnlFundingUsd;

  return {
    coin: p.coin,
    side,
    sizeCoin,
    notionalUsd: Math.abs(p.positionValueUsd),
    entryPx: p.entryPx,
    markPx,
    liqPx,
    unrealisedUsd: p.unrealisedUsd,
    // Return on the margin actually posted, not on notional. Null with no margin used, because
    // a return on nothing is not infinite, it is undefined.
    roePct: ratio(finite(p.unrealisedUsd) === null ? null : p.unrealisedUsd * 100, marginUsedUsd),
    leverage: p.leverage,
    leverageType: p.leverageType,
    marginUsedUsd: p.marginUsedUsd,
    fundingPaidUsd: p.fundingPaidUsd,
    liqReachable,
    liqDistancePct,
    liqDistanceUsd,
    liqDistanceAtr,
    pnlPriceUsd,
    pnlFundingUsd,
    pnlNetUsd,
  };
}

// ---------- orders ----------

// What an order is for, read against the position it belongs to.
//
// The classification is off triggerPx and never limitPx. On a trigger order limitPx is the
// slippage bound the venue fills within once the trigger fires, so reading the role off it would
// call a stop a target whenever that bound sat the other side of the mark. Triggers fire on the
// mark, which is also why the comparison is against the mark.
function roleFor(o: RawOrder, pos: Position | undefined): Order['role'] {
  // reduceOnly is the venue's own statement that this order can only take exposure off. Without
  // it the order can only add, whatever its price.
  if (o.reduceOnly !== true) return 'entry';
  if (o.isTrigger !== true) return 'reduce';
  // A trigger with no position under it is not protecting anything. It is how a program gets into
  // a trade on a break, so it is an entry.
  if (pos === undefined) return 'entry';

  const trigger = finite(o.triggerPx);
  const mark = pos.markPx;
  // Reduce-only and unclassifiable is still reduce-only. Saying 'reduce' claims only what the
  // venue said; guessing 'stop' would claim the position is protected.
  if (trigger === null || mark === null) return 'reduce';
  // A tie resolves to the protective read, the same direction every other tie in this repo
  // resolves: the reading that assumes less about the position being safe.
  if (trigger === mark) return 'stop';

  const losing = pos.side === 'long' ? trigger < mark : trigger > mark;
  return losing ? 'stop' : 'target';
}

// An order carries a client order id, and the runner mints one per plan leg, so attribution is
// by name rather than by inference. An id no plan owns is null.
function orderPlanId(cloid: string | null, plans: PlanRow[]): string | null {
  if (cloid === null || cloid === '') return null;
  const owner = plans.find((p) => p.cloids.entry === cloid || p.cloids.stop === cloid || p.cloids.target === cloid);
  return owner === undefined ? null : owner.id;
}

function orderFrom(o: RawOrder, pos: Position | undefined, plans: PlanRow[]): Order {
  const limitPx = finite(o.limitPx);
  const triggerPx = finite(o.triggerPx);
  // Notional against the price that decides the order: the trigger line for a trigger, the limit
  // for a limit. Neither known means the size is known and its value is not.
  const px = o.isTrigger === true ? triggerPx : limitPx;
  return {
    oid: o.oid,
    cloid: o.cloid,
    coin: o.coin,
    side: o.side,
    kind: o.isTrigger === true ? 'trigger' : 'limit',
    role: roleFor(o, pos),
    px: limitPx,
    triggerPx,
    sizeCoin: o.sizeCoin,
    notionalUsd: px === null ? null : px * o.sizeCoin,
    reduceOnly: o.reduceOnly === true,
    tif: o.tif,
    atMs: o.atMs,
    planId: orderPlanId(o.cloid, plans),
  };
}

// ---------- fills ----------

// Which plan a fill belongs to, or null.
//
// Attribution is by coverage and time, not by client order id: the fills feed carries no cloid,
// so nothing on the fill itself names the plan that caused it. A placed or open plan claims a
// fill on its coin that landed after it was placed. Nothing in this app reads planId to decide
// anything, so a fill the human caused with close while a plan covered that coin is a labelling
// defect and not a safety one. Two live plans on one coin make the answer ambiguous, and
// ambiguous is null.
function fillPlanId(f: RawFill, plans: PlanRow[]): string | null {
  const hits = plans.filter((p) => {
    if (p.symbol !== f.coin || (p.status !== 'placed' && p.status !== 'open')) return false;
    const since = Date.parse(p.updatedAt);
    return Number.isFinite(since) && f.atMs >= since - 1000;
  });
  return hits.length === 1 ? hits[0].id : null;
}

function fillFrom(f: RawFill, plans: PlanRow[]): Fill {
  return {
    tid: f.tid,
    coin: f.coin,
    side: f.side,
    px: f.px,
    sizeCoin: f.sizeCoin,
    notionalUsd: f.px * f.sizeCoin,
    feeUsd: f.feeUsd,
    closedPnlUsd: f.closedPnlUsd,
    atMs: f.atMs,
    // Seconds, because that is the chart's time axis and a fill marker has to land on a bar.
    tSec: Math.floor(f.atMs / 1000),
    liquidation: f.liquidation === true,
    planId: fillPlanId(f, plans),
    ...(f.hash === undefined ? {} : { hash: f.hash, url: HYPERLIQUID_EXPLORER_TX + f.hash }),
    ...(f.oid === undefined ? {} : { oid: f.oid }),
  };
}

// ---------- collateral ----------

// Where the money is, on which venue, and what it costs to send more.
//
// `funded` is three-valued for the same reason everything else on this surface is: with no
// snapshot the account has not answered, and "no collateral" is a different sentence from "not
// asked yet". Only one of those two names a next action.
//
// A zero on either book counts as an answer here, not as a null. That is the opposite of the
// rule accountFrom applies to a unified account's equity, and the difference is what the
// figure is for: equity 0.0 on a unified account is the venue failing to report money that is
// there, while perp value 0.0 next to spot 0.0 is the venue correctly reporting an account
// nobody has funded. This block exists to say that second thing out loud.
function collateralFrom(
  s: AccountSnapshot | null,
  address: string | null,
): TradePayload['collateral'] {
  const perpUsd = s === null ? null : finite(s.perpValueUsd);
  const spotUsdcUsd = s === null ? null : finite(s.spotUsdcUsd);
  const answered = perpUsd !== null || spotUsdcUsd !== null;
  // Dust is not collateral. The live mainnet account holds 0.000002 USDC and every figure on
  // this surface rounds at half a cent, so counting that as funded would print $0.00 on both
  // books while suppressing the one line that says what to do about an empty account.
  const holds = (n: number | null): boolean => n !== null && Math.abs(n) >= DUST_USD;
  return {
    address: address === null || address === '' ? null : address,
    perpUsd,
    spotUsdcUsd,
    funded: answered ? holds(perpUsd) || holds(spotUsdcUsd) : null,
    funding: fundingBlock(),
  };
}

// ---------- account ----------

function accountFrom(s: AccountSnapshot | null, positions: Position[], plans: PlanRow[]): TradePayload['account'] {
  const live = plans.filter((p) => p.status === 'placed' || p.status === 'open');
  const atRiskUsd = live.reduce((sum, p) => sum + (p.risk?.marginUsd ?? 0), 0);
  const maxLossUsd = live.reduce((sum, p) => sum + (p.risk?.maxLossUsd ?? 0), 0);
  if (s === null) {
    // No snapshot is not an empty account. Every figure is unknown, including whether the account
    // is unified, and the flag has no third state to say so.
    return {
      equityUsd: null,
      marginUsedUsd: null,
      freeUsd: null,
      maintenanceUsd: null,
      withdrawableUsd: null,
      crossLeverage: null,
      healthPct: null,
      unified: false,
      accountKnown: false,
      netNotionalUsd: null,
      grossNotionalUsd: null,
      equityAtFivePctAdverse: null,
      atRiskUsd,
      maxLossUsd,
    };
  }

  const unified = s.unified === true;
  // Whether the feed has settled WHICH kind of account this is. clearinghouseState and
  // activeAssetData arrive on separate messages, and in the window between them the two
  // readings disagree by the whole balance. Publishing anything derived from either one during
  // that window is how a funded account renders as an empty one on the first paint.
  const accountKnown = s.accountKnown === true;

  // The incident. On a unified account with no perp position, clearinghouseState reports
  // accountValue exactly 0.0 and withdrawable 0.0 while the money sits at the account level. A
  // zero from a unified account is therefore unknown, and it renders as a dash instead of as the
  // claim that there is nothing there.
  const equityUsd = unified && s.equityUsd === 0 ? null : finite(s.equityUsd);
  const withdrawableUsd = unified && s.withdrawableUsd === 0 ? null : finite(s.withdrawableUsd);
  const maintenanceUsd = finite(s.maintenanceUsd);

  const notionalUsd = positions.reduce((sum, p) => sum + p.notionalUsd, 0);
  const netNotionalUsd = positions.reduce(
    (sum, p) => sum + (p.side === 'long' ? p.notionalUsd : -p.notionalUsd),
    0,
  );

  // What a five percent move against the book leaves. Computed against NET exposure, which is the
  // same as assuming every coin in the book moves together: a long hedged by a short shows little
  // damage here and would take more than this if the two came apart. Stated so nobody reads it as
  // a floor.
  //
  // Null on a unified account for the same reason the two ratios above are null. Subtracting a
  // real loss from an equity figure that is not the account's money produces a sentence that
  // sounds specific and is not true, and this is the one number on the panel a human reads as a
  // plan.
  const equityAtFivePctAdverse =
    unified || equityUsd === null ? null : equityUsd - Math.abs(netNotionalUsd) * ADVERSE_MOVE;

  // Both ratios are null on a unified account, and the reason is not the zero above.
  //
  // With perp positions open, accountValue is not zero, but it equals totalRawUsd + totalNtlPos
  // with totalRawUsd negative: it is the equity of the positions, not the account's money. A
  // health ratio or a cross leverage computed against it is wrong rather than missing, and a
  // wrong number on a risk panel is worse than a missing one because the human acts on it.
  //
  // There is no single venue figure for whole-account health on a unified account either. The
  // published formula, computeUnifiedAccountRatio, is the max over collateral tokens of
  // crossMargin / (spotTotal - isolatedMargin), and this feed carries none of the per-token spot
  // totals or per-token cross margin it needs. Approximating it is the one thing not to do here,
  // so the answer is null and the panel says the account is unified.
  const healthPct = unified ? null : clamp01(ratio(minus(equityUsd, maintenanceUsd), equityUsd));
  const crossLeverage = unified ? null : ratio(notionalUsd, equityUsd);

  return {
    equityUsd,
    marginUsedUsd: finite(s.marginUsedUsd),
    freeUsd: finite(s.freeUsd),
    maintenanceUsd,
    withdrawableUsd,
    crossLeverage,
    healthPct,
    unified,
    accountKnown,
    netNotionalUsd,
    grossNotionalUsd: notionalUsd,
    equityAtFivePctAdverse,
    atRiskUsd,
    maxLossUsd,
  };
}

// ---------- venue ----------

function venueFrom(
  // Taken off the feed's own signature rather than imported by name, so this file cannot drift
  // from whatever the locked FeedStatus turns out to be called.
  status: ReturnType<TradeFeed['status']>,
  s: AccountSnapshot | null,
  nowMs: number,
): TradePayload['venue'] {
  const lastMessageMs = finite(status.lastMessageMs);
  // A negative age needs a clock that went backwards. Clamping stops a skewed one printing a
  // feed fresher than any message we hold.
  const ageMs = lastMessageMs === null ? null : Math.max(0, nowMs - lastMessageMs);
  // How far behind the venue the screen actually is: the age of the account state being drawn.
  // Not the same number as ageMs, which only says the socket is still talking. And not the
  // number beside the chart's state word: the venue pushes this snapshot every 5 s, so this
  // one climbs to 5000 and resets, and painted beside a price moving every half second it read
  // as a five-second chart. The chart's number is the market rail's (src/market/live.ts).
  const latencyMs = s === null ? null : Math.max(0, nowMs - s.atMs);
  const connected = status.connected === true;
  const source: 'ws' | 'rest' | 'none' = connected ? 'ws' : s === null ? 'none' : 'rest';

  return {
    connected,
    source,
    ageMs,
    latencyMs,
    error: status.lastError,
    // Degraded is the honest answer to "can I trust what I am looking at". A socket that is down,
    // an account with no state yet, or an age past the stale mark all mean the same thing to the
    // human: this may not be current.
    degraded: !connected || s === null || ageMs === null || ageMs > FEED_STALE_MS,
  };
}

// ---------- markets ----------

function marketFrom(ctx: MarketCtx, meta: AssetMeta | undefined, atr: number | null): Market {
  return {
    coin: ctx.coin,
    markPx: ctx.markPx,
    oraclePx: finite(ctx.oraclePx),
    midPx: finite(ctx.midPx),
    fundingRateHourly: finite(ctx.fundingRateHourly),
    openInterestUsd: finite(ctx.openInterestUsd),
    volume24hUsd: finite(ctx.volume24hUsd),
    premiumPct: finite(ctx.premiumPct),
    atr: finite(atr),
    szDecimals: meta === undefined ? null : meta.szDecimals,
    maxLeverage: meta === undefined ? null : meta.maxLeverage,
    assetId: meta === undefined ? null : meta.assetId,
  };
}

// ---------- the payload ----------

export function buildTradePayload(deps: {
  view: TradeViewState;
  feed: TradeFeed;
  plans: PlanRow[];
  meta: Map<string, AssetMeta>;
  atrFor: (coin: string) => number | null;
  products: string[];
  nowMs: number;
  // Which Hyperliquid this account lives on, and which account. Both come from the app's
  // config rather than from the venue, because a screen that asked the venue which network it
  // was talking to would be asking the thing it is trying to check.
  address: string;
}): TradePayload {
  const snapshot = deps.feed.account();
  const status = deps.feed.status();

  const positions = (snapshot === null ? [] : snapshot.positions).map((p) =>
    positionFrom(p, deps.feed.market(p.coin), deps.atrFor(p.coin)),
  );
  // One position per coin, which is what the venue reports and what the book panel nests orders
  // under.
  const byCoin = new Map(positions.map((p) => [p.coin, p]));

  const orders = deps.feed.orders().map((o) => orderFrom(o, byCoin.get(o.coin), deps.plans));

  // Keyed by tid, because that is the fill's identity on this venue: hash is often all zeroes,
  // and a reconnect snapshot that arrived on top of live fills would otherwise count the same
  // trade twice.
  const seen = new Set<string>();
  const fills: Fill[] = [];
  for (const raw of deps.feed.fills()) {
    if (seen.has(raw.tid)) continue;
    seen.add(raw.tid);
    fills.push(fillFrom(raw, deps.plans));
  }
  // Newest first: the panel reads down from the top and the agent's read takes from the front.
  fills.sort((a, b) => b.atMs - a.atMs);

  // A market row for every coin on screen: the focused one, plus anything the account is actually
  // exposed to. No context means no row, rather than a row of nulls pretending to be a market.
  const coins = new Set<string>([deps.view.symbol]);
  for (const p of positions) coins.add(p.coin);
  for (const o of orders) coins.add(o.coin);
  const markets: Market[] = [];
  for (const coin of coins) {
    const ctx = deps.feed.market(coin);
    if (ctx === null) continue;
    markets.push(marketFrom(ctx, deps.meta.get(coin), deps.atrFor(coin)));
  }

  const account = accountFrom(snapshot, positions, deps.plans);

  return {
    rev: deps.view.rev,
    lastDriver: deps.view.lastDriver,
    symbol: deps.view.symbol,
    overlays: { ...deps.view.overlays },
    highlights: [...deps.view.highlights],
    venue: venueFrom(status, snapshot, deps.nowMs),
    account,
    collateral: collateralFrom(snapshot, deps.address),
    markets,
    positions,
    orders,
    fills,
    plans: deps.plans.map((p) => ({ ...p })),
    products: [...deps.products],
  };
}

// ---------- the agent's read ----------

export type TradeRead = {
  symbol: string;
  rev: number;
  account: {
    summary: string;
    equityUsd: number | null;
    freeUsd: number | null;
    marginUsedUsd: number | null;
    maintenanceUsd: number | null;
    withdrawableUsd: number | null;
    crossLeverage: number | null;
    healthPct: number | null;
    unified: boolean;
    netNotionalUsd: number | null;
    grossNotionalUsd: number | null;
    equityAtFivePctAdverse: number | null;
    atRiskUsd: number;
    maxLossUsd: number;
  };
  venue: TradePayload['venue'];
  positions: {
    coin: string;
    side: 'long' | 'short';
    sizeCoin: number;
    notionalUsd: number;
    entryPx: number;
    markPx: number | null;
    unrealisedUsd: number;
    roePct: number | null;
    leverage: number;
    leverageType: 'cross' | 'isolated';
    liqPx: number | null;
    liqDistance: { pct: number | null; usd: number | null; atr: number | null };
    pnl: { priceUsd: number | null; fundingUsd: number | null; netUsd: number | null };
  }[];
  orders: {
    oid: number;
    coin: string;
    side: 'buy' | 'sell';
    role: Order['role'];
    kind: Order['kind'];
    px: number | null;
    triggerPx: number | null;
    sizeCoin: number;
    reduceOnly: boolean;
    planId: string | null;
  }[];
  fills: {
    count: number;
    inLastMin: number;
    recent: { tid: string; coin: string; side: 'buy' | 'sell'; px: number; sizeCoin: number; closedPnlUsd: number | null; atMs: number; liquidation: boolean }[];
  };
  plans: {
    id: string;
    symbol: string;
    side: 'long' | 'short';
    sizeUsd: number;
    leverage: number;
    entry: PlanRow['entry'];
    stop: number;
    target: number | null;
    when: PlanRow['when'];
    expiresAt: string | null;
    note: string | null;
    status: PlanRow['status'];
    endReason: PlanRow['endReason'] | null;
    blind: boolean;
    locked: boolean;
    // Which conditions hold right now, waiting plans only.
    holds: PlanRow['holds'] | null;
    risk: PlanRow['risk'] | null;
    fillPx: number | null;
  }[];
  markets: { coin: string; markPx: number; fundingRateHourly: number | null; premiumPct: number | null; openInterestUsd: number | null; atr: number | null; maxLeverage: number | null }[];
  highlights: { kind: string; id: string; note: string }[];
  products: string[];
};

function money(v: number | null): string {
  return v === null ? 'unknown' : `$${v.toFixed(2)}`;
}

// The same surface, shaped for something that reads rather than looks.
//
// Numbers in context and never pixels: no bar widths, no colours, no row order that only means
// something on a screen. The one list that is summarised rather than passed through is fills,
// because it is the only unbounded one and the agent asked what its situation is, not for the
// tape. Derived from the payload alone, so the agent and the screen cannot disagree.
export function buildTradeRead(payload: TradePayload): TradeRead {
  const a = payload.account;

  const bits = [
    `equity ${money(a.equityUsd)}`,
    `free ${money(a.freeUsd)}`,
    `maintenance ${money(a.maintenanceUsd)}`,
    `health ${a.healthPct === null ? 'unknown' : `${(a.healthPct * 100).toFixed(1)}%`}`,
    `cross ${a.crossLeverage === null ? 'unknown' : `${a.crossLeverage.toFixed(2)}x`}`,
    `net exposure ${money(a.netNotionalUsd)} of ${money(a.grossNotionalUsd)} gross`,
  ];
  if (a.equityAtFivePctAdverse !== null) {
    bits.push(`a 5% move against the book leaves ${money(a.equityAtFivePctAdverse)}`);
  }
  if (a.atRiskUsd > 0) bits.push(`plans have ${money(a.atRiskUsd)} at risk and ${money(a.maxLossUsd)} of max loss at their stops`);
  if (a.unified) {
    // Said in the sentence rather than left to a null, because an agent that sees "unknown"
    // without a reason will go looking for the number somewhere else and find the wrong one.
    bits.push(
      'unified account: the venue reports position equity as account value, so health and cross leverage are not computable from it',
    );
  }
  if (payload.venue.degraded) bits.push('feed degraded, these numbers may not be current');

  // The clock comes from the payload rather than from Date.now, because this function is pure and
  // two reads of one payload must not differ.
  const newestFillMs = payload.fills.length === 0 ? null : payload.fills[0].atMs;
  const inLastMin =
    newestFillMs === null
      ? 0
      : payload.fills.filter((f) => newestFillMs - f.atMs < ORDER_RATE_WINDOW_MS).length;

  return {
    symbol: payload.symbol,
    rev: payload.rev,
    account: {
      summary: bits.join(', '),
      equityUsd: a.equityUsd,
      freeUsd: a.freeUsd,
      marginUsedUsd: a.marginUsedUsd,
      maintenanceUsd: a.maintenanceUsd,
      withdrawableUsd: a.withdrawableUsd,
      crossLeverage: a.crossLeverage,
      healthPct: a.healthPct,
      unified: a.unified,
      netNotionalUsd: a.netNotionalUsd,
      grossNotionalUsd: a.grossNotionalUsd,
      equityAtFivePctAdverse: a.equityAtFivePctAdverse,
      atRiskUsd: a.atRiskUsd,
      maxLossUsd: a.maxLossUsd,
    },
    venue: payload.venue,
    positions: payload.positions.map((p) => ({
      coin: p.coin,
      side: p.side,
      sizeCoin: p.sizeCoin,
      notionalUsd: p.notionalUsd,
      entryPx: p.entryPx,
      markPx: p.markPx,
      unrealisedUsd: p.unrealisedUsd,
      roePct: p.roePct,
      leverage: p.leverage,
      leverageType: p.leverageType,
      liqPx: p.liqPx,
      // False means liqPx is further from the mark than the mark itself, so no price gets there
      // and the three distances below are blank on purpose rather than missing.
      liqReachable: p.liqReachable,
      // Grouped, because the three are one fact in three units and reading one without the others
      // is how twelve percent gets mistaken for safe.
      liqDistance: { pct: p.liqDistancePct, usd: p.liqDistanceUsd, atr: p.liqDistanceAtr },
      // Split the same way the panel splits it, so an agent asked why a green position is
      // shrinking has the funding line in front of it rather than having to ask again.
      pnl: { priceUsd: p.pnlPriceUsd, fundingUsd: p.pnlFundingUsd, netUsd: p.pnlNetUsd },
    })),
    orders: payload.orders.map((o) => ({
      oid: o.oid,
      coin: o.coin,
      side: o.side,
      role: o.role,
      kind: o.kind,
      px: o.px,
      triggerPx: o.triggerPx,
      sizeCoin: o.sizeCoin,
      reduceOnly: o.reduceOnly,
      planId: o.planId,
    })),
    fills: {
      count: payload.fills.length,
      inLastMin,
      recent: payload.fills.slice(0, READ_FILL_LIMIT).map((f) => ({
        tid: f.tid,
        coin: f.coin,
        side: f.side,
        px: f.px,
        sizeCoin: f.sizeCoin,
        closedPnlUsd: f.closedPnlUsd,
        atMs: f.atMs,
        liquidation: f.liquidation,
      })),
    },
    plans: payload.plans.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      sizeUsd: p.sizeUsd,
      leverage: p.leverage,
      entry: p.entry,
      stop: p.stop,
      target: p.target ?? null,
      when: p.when,
      expiresAt: p.expiresAt ?? null,
      note: p.note ?? null,
      status: p.status,
      endReason: p.endReason ?? null,
      blind: p.blind === true,
      locked: p.locked === true,
      holds: p.status === 'waiting' ? (p.holds ?? []) : null,
      risk: p.risk ?? null,
      fillPx: p.fillPx ?? null,
    })),
    markets: payload.markets.map((m) => ({
      coin: m.coin,
      markPx: m.markPx,
      fundingRateHourly: m.fundingRateHourly,
      premiumPct: m.premiumPct,
      openInterestUsd: m.openInterestUsd,
      atr: m.atr,
      maxLeverage: m.maxLeverage,
    })),
    highlights: payload.highlights.map((h) => ({ kind: h.kind, id: h.id, note: h.note })),
    products: payload.products,
  };
}
