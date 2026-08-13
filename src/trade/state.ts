// The trading surface's numbers: raw venue state in, one payload out.
//
// Everything the browser draws on /trade is a view of this function's output, and so is
// everything the agent reads. That is deliberate. One derivation means the human and the bot
// cannot be looking at two different accounts, which is the same argument the chart settled for
// price, held here for risk.
//
// The module is pure. No fetch, no timer, no clock of its own: the feed, the mandates, the asset
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
import type { Mandate } from '../strategy/envelope.ts';
import type { Program } from '../strategy/grammar.ts';
import { renderProgram } from '../strategy/render.ts';
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

// One armed (or recently halted) mandate as the runner host knows it. The envelope is the
// human's approved shape; everything else here is what has happened inside it since arming.
export type MandateStatus = {
  mandate: Mandate;
  // The validated program, for rendering to English. Null when a mandate outlived the program
  // object, which shows as a row with its bounds and no prose rather than no row at all.
  program: Program | null;
  armed: boolean;
  running: boolean;
  since: string;
  realisedUsd: number; // since arming, negative is a loss
  lastRule: { id: string; at: string; action: string } | null;
  haltedReason: string | null;
};

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
  mandateId: string | null;
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
  mandateId: string | null;
};

export type MandateRow = {
  id: string;
  symbol: string;
  armed: boolean;
  running: boolean;
  since: string;
  expiresAt: string;
  programHash: string;
  english: string[];
  envelope: {
    maxNotionalUsd: number;
    maxLeverage: number;
    maxOrdersPerMin: number;
    maxLossUsd: number;
    allowedActions: string[];
  };
  used: {
    notionalUsd: number;
    lossUsd: number;
    ordersLastMin: number;
    msToExpiry: number | null;
  };
  // The arm receipt: the account's next state if this program runs to the edge of what it was
  // granted. Every professional tool previews this before you commit, and it normally lives on
  // the order ticket. This surface has no order ticket by design, so it lands here, which is the
  // right place anyway: the mandate is the thing being approved.
  projected: {
    maxPositionUsd: number | null;
    liqPxAtMax: number | null;
    freeAfterUsd: number | null;
    marginRequiredUsd: number | null;
  } | null;
  wallPx: number | null;
  lastRule: { id: string; at: string; action: string } | null;
  haltedReason: string | null;
};

export type TradePayload = {
  rev: number;
  lastDriver: 'agent' | 'human';
  symbol: string;
  overlays: Record<OverlayName, boolean>;
  highlights: Highlight[];
  note: string | null;
  noteSource: 'agent' | 'human' | null;
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
  };
  markets: Market[];
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  mandates: MandateRow[];
  products: string[];
};

// The mandate's order rate is per minute, so the fill window that estimates it is one minute.
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

// Maintenance margin on this venue is half the initial margin at the asset's maximum leverage:
// positionValue / (2 * maxLeverage). There is no per-position maintenance field to read, so any
// projection of where liquidation would sit goes through this number.
const MAINTENANCE_DIVISOR = 2;

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

// ---------- the mandate wall ----------

// The price at which the approved loss is reached and the bot stands down.
//
// This is the second of the two walls the page is built around. The venue draws the liquidation;
// the human draws this one, and it exists nowhere but in the mandate, which is why it is derived
// here rather than fetched.
//
//   long:  wall = entry - (maxLoss - realisedLoss) / size
//   short: wall = entry + (maxLoss - realisedLoss) / size
//
// realisedLossUsd is signed: positive for a loss already taken, negative for a gain. That is not
// a convenience, it is what makes the line true. checkEnvelope halts on
// -(realised + unrealised) >= maxLoss, so it nets a realised gain against the cap, and a wall
// drawn on any other convention is a line that does not stop anything.
export function mandateWallPrice(p: {
  side: 'long' | 'short';
  entryPx: number;
  sizeCoin: number;
  maxLossUsd: number;
  realisedLossUsd: number;
}): number | null {
  const entryPx = finite(p.entryPx);
  const sizeCoin = finite(p.sizeCoin);
  const maxLossUsd = finite(p.maxLossUsd);
  const realisedLossUsd = finite(p.realisedLossUsd);
  if (entryPx === null || sizeCoin === null || maxLossUsd === null || realisedLossUsd === null) {
    return null;
  }

  // Flat. There is no wall yet because there is no position for a price to hurt, and the panel
  // says so rather than drawing a line at a price that means nothing. Size carries no sign here:
  // direction is the `side` field.
  if (sizeCoin <= 0) return null;

  const remainingUsd = maxLossUsd - realisedLossUsd;
  // The allowance is already gone. The wall is behind us rather than ahead: this mandate is at
  // or past its stop-out at any price at all, and a line would suggest there is room left.
  if (remainingUsd <= 0) return null;

  const move = remainingUsd / sizeCoin;
  const wall = p.side === 'long' ? entryPx - move : entryPx + move;
  if (!Number.isFinite(wall)) return null;
  // A long wall at or below zero is not a stop-out. It says the asset goes to nothing before the
  // approved loss is reached, so there is no price to draw.
  if (p.side === 'long' && wall <= 0) return null;
  return wall;
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
  const gapPx = liqPx === null || markPx === null ? null : Math.abs(liqPx - markPx);

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

// An order carries a client order id, so attribution here is by name rather than by inference:
// the runner stamps the mandate id into the cloid it sends. Two mandates matching one cloid is
// ambiguous, and an ambiguous answer is null.
function orderMandateId(cloid: string | null, mandates: MandateStatus[]): string | null {
  if (cloid === null || cloid === '') return null;
  const hits = mandates.filter((m) => cloid.includes(m.mandate.id));
  return hits.length === 1 ? hits[0].mandate.id : null;
}

function orderFrom(o: RawOrder, pos: Position | undefined, mandates: MandateStatus[]): Order {
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
    mandateId: orderMandateId(o.cloid, mandates),
  };
}

// ---------- fills ----------

// Which armed mandate a fill belongs to, or null.
//
// Attribution is by coverage and time, not by client order id: the fills feed carries no cloid,
// so nothing on the fill itself names the program that caused it. A mandate claims a fill when it
// is armed, covers that coin, and the fill landed inside its armed window.
//
// One consequence is worth stating plainly. A fill the human caused with close or flatten, while
// a mandate covered that coin, is attributed to the mandate. Nothing in this app reads mandateId
// to decide anything, so that is a labelling defect and not a safety one. Two armed mandates on
// one coin makes the answer ambiguous, and ambiguous is null.
function fillMandateId(f: RawFill, mandates: MandateStatus[]): string | null {
  const hits = mandates.filter((m) => {
    if (!m.armed || m.mandate.symbol !== f.coin) return false;
    const armedAt = Date.parse(m.since);
    return Number.isFinite(armedAt) && f.atMs >= armedAt;
  });
  return hits.length === 1 ? hits[0].mandate.id : null;
}

function fillFrom(f: RawFill, mandates: MandateStatus[]): Fill {
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
    mandateId: fillMandateId(f, mandates),
  };
}

// ---------- account ----------

function accountFrom(s: AccountSnapshot | null, positions: Position[]): TradePayload['account'] {
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
  // Not the same number as ageMs, which only says the socket is still talking.
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

// ---------- mandates ----------

// Which way this program trades, or null when it could go either way.
//
// The direction is read off the program's own open actions rather than guessed from the live
// position, because the receipt is most useful before anything has been opened. A program that
// can open both ways has no single liquidation to project, and saying so is the only honest
// answer available.
function programSide(p: Program | null): 'long' | 'short' | null {
  if (p === null) return null;
  const sides = new Set<'long' | 'short'>();
  for (const rule of p.rules) for (const a of rule.then) if (a.do === 'open') sides.add(a.side);
  return sides.size === 1 ? [...sides][0] : null;
}

// The account's next state if this program runs to the edge of its envelope.
//
// Sized against both walls: what the human granted, and what the collateral can actually carry.
// An envelope allowing fifty thousand of notional on an account with two hundred dollars free is
// not a fifty thousand dollar position, and a receipt that says it is would be the wrong number
// on an approval screen.
//
// Liquidation at that size is a straight consequence of the maintenance rule. The position is
// gone when the loss has eaten the initial margin down to maintenance, and maintenance is half
// the initial margin at maximum leverage, so the move that does it is 1 / (2 * maxLeverage) of
// the entry price. It opens at the current mark, because that is when the receipt was written.
//
// The whole object is null when any input is unknown, rather than zeros: a projection built on a
// missing free balance would read as a real plan.
function projectedFor(
  s: MandateStatus,
  pos: Position | undefined,
  markPx: number | null,
  freeUsd: number | null,
): MandateRow['projected'] {
  const maxNotionalUsd = finite(s.mandate.maxNotionalUsd);
  const maxLeverage = finite(s.mandate.maxLeverage);
  const mark = finite(markPx);
  const free = finite(freeUsd);
  if (maxNotionalUsd === null || maxLeverage === null || mark === null || free === null) return null;
  if (maxLeverage <= 0) return null;

  // Margin already posted counts toward the buying power, since growing an open position to the
  // envelope's cap does not re-post the margin it already holds.
  const postedUsd = pos === undefined ? 0 : pos.marginUsedUsd;
  const buyingPowerUsd = (free + postedUsd) * maxLeverage;
  const maxPositionUsd = Math.min(maxNotionalUsd, buyingPowerUsd);
  const marginRequiredUsd = maxPositionUsd / maxLeverage;
  const freeAfterUsd = free + postedUsd - marginRequiredUsd;

  const side = programSide(s.program) ?? (pos === undefined ? null : pos.side);
  const adverse = 1 / (MAINTENANCE_DIVISOR * maxLeverage);
  const liqPxAtMax = side === null ? null : side === 'long' ? mark * (1 - adverse) : mark * (1 + adverse);

  return { maxPositionUsd, liqPxAtMax, freeAfterUsd, marginRequiredUsd };
}

function mandateRowFrom(
  s: MandateStatus,
  pos: Position | undefined,
  fills: Fill[],
  nowMs: number,
  markPx: number | null,
  freeUsd: number | null,
): MandateRow {
  const m = s.mandate;
  const notionalUsd = pos === undefined ? 0 : pos.notionalUsd;
  const unrealisedUsd = pos === undefined ? 0 : pos.unrealisedUsd;

  // Only a loss spends the allowance. A bot that is up has spent none of it, and a negative
  // "used" would draw a bar running backwards out of its own frame.
  const net = s.realisedUsd + unrealisedUsd;
  const lossUsd = net < 0 ? -net : 0;

  const ordersLastMin = fills.filter(
    (f) => f.mandateId === m.id && nowMs - f.atMs < ORDER_RATE_WINDOW_MS,
  ).length;

  const expiryMs = Date.parse(m.expiresAt);
  // Clamped at zero: an expired mandate has no time left rather than negative time. An expiry
  // that will not parse is unknown, not immediate.
  const msToExpiry = Number.isFinite(expiryMs) ? Math.max(0, expiryMs - nowMs) : null;

  const wallPx =
    pos === undefined
      ? null
      : mandateWallPrice({
          side: pos.side,
          entryPx: pos.entryPx,
          sizeCoin: pos.sizeCoin,
          maxLossUsd: m.maxLossUsd,
          realisedLossUsd: -s.realisedUsd,
        });

  return {
    id: m.id,
    symbol: m.symbol,
    armed: s.armed,
    running: s.running,
    since: s.since,
    expiresAt: m.expiresAt,
    programHash: m.programHash,
    // The same renderer the approval screen used. A second one would eventually describe the
    // program differently from the text the human actually approved.
    english: s.program === null ? [] : renderProgram(s.program),
    envelope: {
      maxNotionalUsd: m.maxNotionalUsd,
      maxLeverage: m.maxLeverage,
      maxOrdersPerMin: m.maxOrdersPerMin,
      maxLossUsd: m.maxLossUsd,
      allowedActions: [...m.allowedActions],
    },
    used: { notionalUsd, lossUsd, ordersLastMin, msToExpiry },
    projected: projectedFor(s, pos, markPx, freeUsd),
    wallPx,
    lastRule: s.lastRule,
    haltedReason: s.haltedReason,
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
  mandates: MandateStatus[];
  meta: Map<string, AssetMeta>;
  atrFor: (coin: string) => number | null;
  products: string[];
  nowMs: number;
}): TradePayload {
  const snapshot = deps.feed.account();
  const status = deps.feed.status();

  const positions = (snapshot === null ? [] : snapshot.positions).map((p) =>
    positionFrom(p, deps.feed.market(p.coin), deps.atrFor(p.coin)),
  );
  // One position per coin, which is what the venue reports and what the book panel nests orders
  // under.
  const byCoin = new Map(positions.map((p) => [p.coin, p]));

  const orders = deps.feed.orders().map((o) => orderFrom(o, byCoin.get(o.coin), deps.mandates));

  // Keyed by tid, because that is the fill's identity on this venue: hash is often all zeroes,
  // and a reconnect snapshot that arrived on top of live fills would otherwise count the same
  // trade twice against a mandate's order rate.
  const seen = new Set<string>();
  const fills: Fill[] = [];
  for (const raw of deps.feed.fills()) {
    if (seen.has(raw.tid)) continue;
    seen.add(raw.tid);
    fills.push(fillFrom(raw, deps.mandates));
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

  // The account block is built before the mandate rows because the arm receipt spends free
  // collateral, and there is one answer to how much of that there is.
  const account = accountFrom(snapshot, positions);

  const mandates = deps.mandates.map((m) => {
    const ctx = deps.feed.market(m.mandate.symbol);
    return mandateRowFrom(
      m,
      byCoin.get(m.mandate.symbol),
      fills,
      deps.nowMs,
      ctx === null ? null : finite(ctx.markPx),
      account.freeUsd,
    );
  });

  return {
    rev: deps.view.rev,
    lastDriver: deps.view.lastDriver,
    symbol: deps.view.symbol,
    overlays: { ...deps.view.overlays },
    highlights: [...deps.view.highlights],
    note: deps.view.note,
    noteSource: deps.view.noteSource,
    venue: venueFrom(status, snapshot, deps.nowMs),
    account,
    markets,
    positions,
    orders,
    fills,
    mandates,
    products: [...deps.products],
  };
}

// ---------- the agent's read ----------

export type TradeBound = {
  bound: 'notional' | 'loss' | 'orders' | 'time';
  used: number;
  cap: number;
  // Fraction of the bound already spent, 0..1. Null when the cap is zero or the window cannot be
  // worked out, since a fraction of nothing is not full, it is undefined.
  spent: number | null;
};

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
    mandateId: string | null;
  }[];
  fills: {
    count: number;
    inLastMin: number;
    recent: { tid: string; coin: string; side: 'buy' | 'sell'; px: number; sizeCoin: number; closedPnlUsd: number | null; atMs: number; liquidation: boolean }[];
  };
  mandates: {
    id: string;
    symbol: string;
    armed: boolean;
    running: boolean;
    english: string[];
    bounds: TradeBound[];
    tightest: TradeBound['bound'] | null;
    wallPx: number | null;
    projected: MandateRow['projected'];
    haltedReason: string | null;
  }[];
  markets: { coin: string; markPx: number; fundingRateHourly: number | null; premiumPct: number | null; openInterestUsd: number | null; atr: number | null; maxLeverage: number | null }[];
  highlights: { kind: string; id: string; note: string }[];
  note: string | null;
  products: string[];
};

function money(v: number | null): string {
  return v === null ? 'unknown' : `$${v.toFixed(2)}`;
}

// Every bound the mandate has, sorted by how much of it is gone. The first one is the answer to
// "what stops this bot first", which is the question the row exists to answer.
function boundsFor(row: MandateRow, nowMs: number): TradeBound[] {
  const windowMs = Date.parse(row.expiresAt) - Date.parse(row.since);
  const timeCap = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : null;
  const timeUsed = timeCap === null || row.used.msToExpiry === null ? null : timeCap - row.used.msToExpiry;

  const bounds: TradeBound[] = [
    {
      bound: 'notional',
      used: row.used.notionalUsd,
      cap: row.envelope.maxNotionalUsd,
      spent: clamp01(ratio(row.used.notionalUsd, row.envelope.maxNotionalUsd)),
    },
    {
      bound: 'loss',
      used: row.used.lossUsd,
      cap: row.envelope.maxLossUsd,
      spent: clamp01(ratio(row.used.lossUsd, row.envelope.maxLossUsd)),
    },
    {
      bound: 'orders',
      used: row.used.ordersLastMin,
      cap: row.envelope.maxOrdersPerMin,
      spent: clamp01(ratio(row.used.ordersLastMin, row.envelope.maxOrdersPerMin)),
    },
    {
      bound: 'time',
      used: timeUsed === null ? 0 : timeUsed,
      cap: timeCap === null ? 0 : timeCap,
      spent: clamp01(ratio(timeUsed, timeCap)),
    },
  ];

  // An unknown fraction sorts last. It is not the tightest bound, it is the one nobody can say
  // anything about, and putting it first would name it as the thing about to stop the bot.
  return bounds.sort((a, b) => (b.spent === null ? -1 : b.spent) - (a.spent === null ? -1 : a.spent));
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
  const nowMs = newestFillMs === null ? Date.parse(payload.mandates[0]?.since ?? '') : newestFillMs;

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
      mandateId: o.mandateId,
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
    mandates: payload.mandates.map((m) => {
      const bounds = boundsFor(m, Number.isFinite(nowMs) ? nowMs : Date.parse(m.since));
      const top = bounds[0];
      return {
        id: m.id,
        symbol: m.symbol,
        armed: m.armed,
        running: m.running,
        english: m.english,
        bounds,
        tightest: top === undefined || top.spent === null ? null : top.bound,
        wallPx: m.wallPx,
        projected: m.projected,
        haltedReason: m.haltedReason,
      };
    }),
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
    note: payload.note,
    products: payload.products,
  };
}
