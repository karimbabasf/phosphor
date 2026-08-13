// The runner: the only code in phosphor that places an order.
//
// No model runs in this process. It holds an agent-authored program and a human-approved
// envelope, and every tick it evaluates one against the market and checks the other before it
// signs. That is the whole design: the agent had judgment and no authority, the human granted
// authority once, and this loop has authority and no judgment.
//
// Order of operations per tick, and the order matters:
//
//   1. The supervisor runs FIRST, before any program logic. Drawdown, expiry, distance to
//      liquidation and the kill switch are checked whether or not the program has an opinion,
//      because a program that has stopped producing actions is exactly the case where a stop
//      still has to fire.
//   2. The evaluator produces intended actions.
//   3. checkEnvelope rules on each one, in the same function that signs.
//
// Liquidation is watched on MARK price, not last trade. The venue blends external prices with
// its own book to form mark, and the docs warn the two diverge exactly when it matters, during
// volatility and on a position with a large borrowed multiple. Watching the book price would be
// watching the wrong number. Below two thirds of maintenance margin the liquidator vault takes
// the position AND keeps the maintenance margin, so getting out early is worth real money.

import { checkEnvelope } from '../strategy/envelope.ts';
import { programHash } from '../strategy/grammar.ts';
import type { Mandate, RunState } from '../strategy/envelope.ts';
import { emptyMemory, evaluate } from '../strategy/evaluate.ts';
import type { MarketState, RuleMemory } from '../strategy/evaluate.ts';
import type { Action, Program, Ref } from '../strategy/grammar.ts';
import { createExchange, aggressiveLimitPrice, newCloid } from '../hl/exchange.ts';
import { roundToValidPrice } from '../hl/format.ts';
import { distanceToLiquidationPct, liquidationPrice } from '../hl/liquidation.ts';

const KEY = process.env.PHOSPHOR_HL_KEY as `0x${string}` | undefined;
const IS_MAINNET = process.env.PHOSPHOR_HL_MAINNET === '1';
const BASE_URL = process.env.PHOSPHOR_HL_URL ?? 'https://api.hyperliquid-testnet.xyz';

// Same guard as src/rails/hyperliquid-withdraw.ts:427. Mainnet trading is not enabled in this
// version, and a flag that could turn it on by accident is worse than no flag.
const MAINNET_REFUSED = 'the runner is testnet only in this version';

type Armed = {
  mandate: Mandate;
  program: Program;
  memory: RuleMemory;
  armedAtMs: number;
  entryAtMs: number | null;
  prevMarkPx: number;
  ordersInLastMin: number[];  // timestamps, trimmed to the trailing minute
  realisedUsd: number;
  // Notional this runner has ORDERED but the feed has not confirmed yet.
  //
  // Without it the cap is bypassable inside a single tick: several rules can fire together,
  // each envelope check reads positionUsd from the book, and the book only moves when the
  // venue answers. Three opens of $500 against a $1,000 cap all saw a flat position and all
  // passed. Counting what is already in flight is what makes the cap mean the same thing on
  // the first order of a tick and the third.
  inFlightUsd: number;
  // When the oldest still-unconfirmed order was sent, and the position notional the last book
  // reported. Together they are what lets in-flight size be RETIRED correctly instead of
  // discarded. See the 'book' handler for the incident that made both necessary.
  inFlightSinceMs: number;
  lastPositionUsd: number;
  // The leverage this runner has actually SET on the venue, as opposed to the number in the
  // program. Null until it has been set once.
  venueLeverage: number | null;
};

// An order the venue never confirms would otherwise hold its size in flight forever and wedge
// the mandate. Long enough that a slow fill is not mistaken for a lost one.
const IN_FLIGHT_TTL_MS = 30_000;

const armed = new Map<string, Armed>();
let stopping = false;
let killed = false;

function send(e: unknown): void {
  if (typeof process.send === 'function') process.send(e);
}

// What the venue reports about the account, refreshed from the feed. Held here rather than
// recomputed so an order never blocks on a network read.
type Book = {
  markPx: number;
  positionUsd: number;
  positionSide: 'flat' | 'long' | 'short';
  entryPx: number;
  unrealisedUsd: number;
  marginAvailable: number;
  maintenanceLeverage: number;
  szDecimals: number;
  assetId: number;
};

const book = new Map<string, Book>();

function runState(a: Armed, symbol: string): RunState {
  const b = book.get(symbol);
  const cutoff = Date.now() - 60_000;
  a.ordersInLastMin = a.ordersInLastMin.filter((t) => t > cutoff);
  return {
    nowMs: Date.now(),
    armedAtMs: a.armedAtMs,
    symbol,
    positionUsd: (b?.positionUsd ?? 0) + a.inFlightUsd,
    positionSide: b?.positionSide ?? 'flat',
    entryAtMs: a.entryAtMs,
    realisedUsd: a.realisedUsd,
    unrealisedUsd: b?.unrealisedUsd ?? 0,
    ordersInLastMin: a.ordersInLastMin.length,
    // Hashed from the program this process is HOLDING, not copied off the mandate. Copying
    // it made the identity check compare the mandate to itself, so it could never fail and
    // defended nothing. This is what makes "the thing running is the thing that was read"
    // an assertion rather than a comment.
    programHash: programHash(a.program),
  };
}

// Resolving a Ref to a price. Drawing references arrive already resolved from the app, because
// the drawing store lives there; the runner holds the last value it was told rather than
// reaching across the process boundary on the hot path.
const refCache = new Map<string, number>();

function resolveRef(ref: Ref): number | null {
  if (ref.kind === 'price') return ref.value;
  const suffix = ref.kind === 'indicator' && ref.plot !== undefined ? `.${ref.plot}` : '';
  const v = refCache.get(`${ref.kind}:${ref.id}${suffix}`);
  return v === undefined ? null : v;
}

let exchange: ReturnType<typeof createExchange> | null = null;

function requireExchange(): ReturnType<typeof createExchange> {
  if (IS_MAINNET) throw new Error(MAINNET_REFUSED);
  if (KEY === undefined) throw new Error('no API wallet key in the environment');
  if (exchange === null) {
    exchange = createExchange({ privKey: KEY, isMainnet: IS_MAINNET, baseUrl: BASE_URL });
  }
  return exchange;
}

async function place(a: Armed, symbol: string, action: Action): Promise<void> {
  const b = book.get(symbol);
  if (b === undefined) return;
  const ex = requireExchange();

  // Every entry is an immediate-or-cancel limit at a price already decided acceptable, or a
  // resting limit. There is no market order on a book: the aggressive form is a bound, and a
  // fill worse than the bound simply does not happen.
  if (action.do === 'open' || action.do === 'add') {
    // The borrowed multiple the human approved has to be the one the venue uses. It is an
    // ACCOUNT setting there, not an order field, so an order placed without setting it runs at
    // whatever the account was last left at. The approval screen said 3x; the account could be
    // at 20x, which is a different position with a much closer liquidation and the same words
    // on screen. Set it before the first order and refuse to trade if that fails.
    if (action.do === 'open' && a.venueLeverage !== action.leverage) {
      await ex.updateLeverage(b.assetId, true, action.leverage);
      a.venueLeverage = action.leverage;
    }

    const isBuy = action.do === 'open' ? action.side === 'long' : b.positionSide !== 'short';
    const entry = action.entry;
    const raw =
      entry.type === 'market'
        ? aggressiveLimitPrice(b.markPx, isBuy, entry.maxSlippageBps)
        : (resolveRef(entry.ref) ?? b.markPx);
    // Rounded here, toward the side that cannot breach the bound. formatPrice throws on an
    // invalid price by design, so arriving valid is the caller's job.
    const px = roundToValidPrice(raw, b.szDecimals, true, isBuy);
    const size = action.sizeUsd / px;

    // Counted BEFORE the await, not after.
    //
    // This is the order that matters. Placing an order is a network call taking hundreds of
    // milliseconds, and counting it afterwards leaves a window in which every concurrent check
    // reads a rate of zero and a position of flat. Live, that window let eight orders out
    // against a four-per-minute limit and built a $238 position under a $60 cap. Incrementing
    // first makes the state pessimistic while the order is in doubt, which is the only safe
    // direction for these two numbers to be wrong in.
    const now = Date.now();
    a.ordersInLastMin.push(now);
    if (a.inFlightUsd === 0) a.inFlightSinceMs = now;
    a.inFlightUsd += action.sizeUsd;
    if (a.entryAtMs === null) a.entryAtMs = now;

    try {
      await ex.order([
        {
          assetId: b.assetId,
          isBuy,
          price: px,
          size,
          reduceOnly: false,
          tif: entry.type === 'market' ? 'Ioc' : entry.postOnly === true ? 'Alo' : 'Gtc',
          szDecimals: b.szDecimals,
          cloid: newCloid(),
        },
      ]);
    } catch (err) {
      // A rejected order holds no size, so its reservation is given back. The rate count is
      // NOT given back: the venue was asked, and a rate limit exists to bound how often we ask.
      a.inFlightUsd = Math.max(0, a.inFlightUsd - action.sizeUsd);
      throw err;
    }
    return;
  }

  if (action.do === 'reduce' || action.do === 'close') {
    if (b.positionSide === 'flat') return;
    const isBuy = b.positionSide === 'short'; // closing a short is a buy
    const fraction = action.do === 'close' ? 1 : action.fraction;
    const exit = action.do === 'close' ? action.exit : action.exit;
    const raw =
      exit.type === 'market'
        ? aggressiveLimitPrice(b.markPx, isBuy, exit.maxSlippageBps)
        : (resolveRef(exit.ref) ?? b.markPx);
    const px = roundToValidPrice(raw, b.szDecimals, true, isBuy);

    await ex.order([
      {
        assetId: b.assetId,
        isBuy,
        price: px,
        size: (b.positionUsd * fraction) / px,
        reduceOnly: true,
        tif: 'Ioc',
        szDecimals: b.szDecimals,
        cloid: newCloid(),
      },
    ]);
    a.ordersInLastMin.push(Date.now());
    if (action.do === 'close') a.entryAtMs = null;
    return;
  }

  if (action.do === 'set_stop' || action.do === 'set_target') {
    const ref = resolveRef(action.ref);
    if (ref === null || b.positionSide === 'flat') return;
    // Counted like any other order, and counted before the await for the same reason. A trigger
    // is an order on the venue's book: it spends the account's rate budget and its open-order
    // allowance. Ten identical stops went out in ten seconds while the rate counter read zero.
    a.ordersInLastMin.push(Date.now());
    // A stop for a long triggers below and sells, so it rounds as a sell would.
    const px = roundToValidPrice(ref, b.szDecimals, true, b.positionSide === 'short');
    await ex.trigger([
      {
        assetId: b.assetId,
        isBuy: b.positionSide === 'short',
        size: b.positionUsd / b.markPx,
        triggerPx: px,
        isMarket: true,
        tpsl: action.do === 'set_stop' ? 'sl' : 'tp',
        szDecimals: b.szDecimals,
        cloid: newCloid(),
      },
    ]);
    return;
  }
}

// ---------- the human's own controls ----------
//
// Cancel, close and flatten are the buttons on the trading window. They run HERE, in the child,
// rather than in the app, and that is a key-handling decision rather than a convenience.
//
// This process is the only one in the tree that holds the API wallet. Signing a human's close
// in the app would mean a second process holding a key that can place orders, which doubles the
// surface for no gain. The app already talks to this one over IPC, so the button borrows the
// signer that is already here.
//
// None of these consult an envelope, and that is correct rather than an oversight. Every verb
// below only ever REDUCES: it cancels resting orders or closes into flat. The envelope exists
// to bound what a program may do on its own; a human reducing their own exposure is the thing
// the envelope is protecting, not a thing it needs to rule on. Same reasoning as the envelope
// already letting a close through after a breach.
//
// The order lists arrive from the app rather than being read here. The app owns the feed, so
// asking the venue a second time from this process would be a second answer to a question that
// already has one, and the two could disagree about what is resting.
type ManualMsg = {
  verb: 'cancel' | 'cancel_all' | 'close' | 'flatten';
  requestId: string;
  cancels?: { assetId: number; oid: number }[];
  coin?: string;
};

async function closeCoin(coin: string): Promise<string> {
  const b = book.get(coin);
  if (b === undefined) return `${coin}: no market data, nothing sent`;
  if (b.positionSide === 'flat') return `${coin}: already flat`;
  const ex = requireExchange();
  const isBuy = b.positionSide === 'short';
  // A wide bound on purpose. This is a human pressing close, so the intent is out, not out at a
  // good price, and a fill that does not happen because the bound was tight is the worse
  // outcome. It is still a bound: there is no unbounded order anywhere in this file.
  const px = roundToValidPrice(aggressiveLimitPrice(b.markPx, isBuy, 100), b.szDecimals, true, isBuy);
  await ex.order([
    {
      assetId: b.assetId,
      isBuy,
      price: px,
      size: b.positionUsd / px,
      reduceOnly: true,
      tif: 'Ioc',
      szDecimals: b.szDecimals,
      cloid: newCloid(),
    },
  ]);
  return `${coin}: close sent at ${px}`;
}

async function manual(msg: ManualMsg): Promise<void> {
  const done = (ok: boolean, detail: string) =>
    send({ type: 'manual_result', requestId: msg.requestId, ok, detail });
  try {
    if (msg.verb === 'cancel' || msg.verb === 'cancel_all') {
      const cancels = msg.cancels ?? [];
      if (cancels.length === 0) return done(true, 'nothing working to cancel');
      await requireExchange().cancel(cancels);
      return done(true, `cancelled ${cancels.length} order(s)`);
    }

    if (msg.verb === 'close') {
      if (msg.coin === undefined) return done(false, 'close needs a coin');
      return done(true, await closeCoin(msg.coin));
    }

    // Flatten is the big red one: stop every bot AND close every position. Bots are stopped
    // FIRST, because closing while a program is still armed invites it to open the position
    // straight back on its next tick.
    for (const [id] of [...armed]) {
      armed.delete(id);
      send({ type: 'disarmed', id, reason: 'flatten' });
    }
    const results: string[] = [];
    for (const [coin, b] of book) {
      if (b.positionSide === 'flat') continue;
      try {
        results.push(await closeCoin(coin));
      } catch (err) {
        results.push(`${coin}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done(true, results.length === 0 ? 'nothing open, every bot stopped' : results.join('; '));
  } catch (err) {
    done(false, err instanceof Error ? err.message : String(err));
  }
}

async function flatten(id: string, reason: string): Promise<void> {
  const a = armed.get(id);
  if (a === undefined) return;
  const b = book.get(a.mandate.symbol);
  if (b !== undefined && b.positionSide !== 'flat') {
    try {
      await place(a, a.mandate.symbol, { do: 'close', exit: { type: 'market', maxSlippageBps: 100 } });
    } catch (err) {
      send({ type: 'error', id, message: `flatten failed: ${err instanceof Error ? err.message : err}` });
    }
  }
  armed.delete(id);
  send({ type: 'halted', id, reason });
}

// The supervisor. Runs every tick regardless of what the program is doing, and never consults
// it: a program that has gone quiet or wrong is precisely when this has to work.
async function supervise(id: string, a: Armed): Promise<boolean> {
  const s = runState(a, a.mandate.symbol);
  const b = book.get(a.mandate.symbol);

  // The kill switch is checked HERE, every tick, not only when something arms. It used to be
  // consulted once at arm time, which meant flipping it in the window stopped nothing that was
  // already running: the one moment a kill switch exists for. The app pushes its state over
  // IPC and the host also kills this process outright, so the switch works whether or not this
  // loop is healthy.
  if (killed) {
    await flatten(id, 'kill switch');
    return true;
  }

  const loss = -(s.realisedUsd + s.unrealisedUsd);
  if (loss >= a.mandate.maxLossUsd) {
    await flatten(id, `loss ${loss.toFixed(2)} reached the ${a.mandate.maxLossUsd} limit`);
    return true;
  }

  if (Date.now() >= Date.parse(a.mandate.expiresAt)) {
    await flatten(id, 'mandate expired');
    return true;
  }

  if (b !== undefined && b.positionSide !== 'flat' && b.positionUsd > 0) {
    const liq = liquidationPrice({
      entryPx: b.entryPx,
      side: b.positionSide,
      positionSize: b.positionUsd / b.entryPx,
      marginAvailable: b.marginAvailable,
      maintenanceLeverage: b.maintenanceLeverage,
    });
    const distance = distanceToLiquidationPct(b.markPx, liq, b.positionSide);
    // Well before the liquidator vault would take the maintenance margin as well as the
    // position. Leaving on our own terms costs a fee; being taken costs the margin.
    if (distance <= 1) {
      await flatten(id, `mark is ${distance.toFixed(2)}% from liquidation`);
      return true;
    }
  }

  return false;
}

async function tick(): Promise<void> {
  if (stopping) return;

  for (const [id, a] of [...armed]) {
    const symbol = a.mandate.symbol;
    const b = book.get(symbol);
    if (b === undefined) continue;

    try {
      if (await supervise(id, a)) continue;

      const market: MarketState = {
        nowMs: Date.now(),
        markPx: b.markPx,
        prevMarkPx: a.prevMarkPx,
        resolveRef,
        lastClose: () => null, // bar closes arrive from the app, absent here means the condition is false
      };

      const out = evaluate(a.program, market, runState(a, symbol), a.memory);
      // Which rule fired, reported so the window can say WHY something happened rather than
      // only that it did. The evaluator stamps every rule it fires with this tick's clock, so
      // the ones matching nowMs are exactly the ones that just fired.
      for (const [ruleId, firedAt] of Object.entries(out.memory.firedAtMs)) {
        if (firedAt === market.nowMs) {
          send({ type: 'rule', id, ruleId, at: new Date(firedAt).toISOString() });
        }
      }
      a.memory = out.memory;
      a.prevMarkPx = b.markPx;

      for (const action of out.actions) {
        if (action.do === 'notify') {
          send({ type: 'error', id, message: action.text });
          continue;
        }
        if (action.do === 'stand_down') {
          await flatten(id, action.reason);
          break;
        }

        const ruling = checkEnvelope(action, a.mandate, runState(a, symbol));
        if (!ruling.allow) {
          send({ type: 'error', id, message: `refused ${action.do}: ${ruling.reason}` });
          if (ruling.halt) {
            await flatten(id, ruling.reason);
            break;
          }
          continue;
        }

        await place(a, symbol, action);
      }
    } catch (err) {
      send({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

process.on('message', async (msg: Record<string, unknown>) => {
  const cmd = msg.cmd;

  if (cmd === 'arm') {
    const mandate = msg.mandate as Mandate;
    armed.set(mandate.id, {
      mandate,
      program: msg.program as Program,
      memory: emptyMemory(),
      armedAtMs: Date.now(),
      entryAtMs: null,
      prevMarkPx: 0,
      ordersInLastMin: [],
      realisedUsd: 0,
      inFlightUsd: 0,
      inFlightSinceMs: 0,
      lastPositionUsd: 0,
      venueLeverage: null,
    });
    return;
  }

  if (cmd === 'kill') {
    killed = msg.on === true;
    return;
  }

  if (cmd === 'manual') {
    await manual(msg.action as ManualMsg);
    return;
  }

  if (cmd === 'disarm') {
    armed.delete(String(msg.id));
    return;
  }

  if (cmd === 'book') {
    // In-flight size is RETIRED by how much the position actually grew, never discarded.
    //
    // This used to set inFlightUsd to zero on every book, on the reasoning that a confirmed
    // position supersedes what we thought was in flight. That reasoning has a hole: the book
    // arrives every couple of seconds and the venue takes time to reflect a fill, so a book
    // showing a position that has not caught up yet would zero the reservation while the orders
    // behind it were still live. The next tick then saw a flat account and full headroom and
    // opened again. Live, that is how a $60 cap ended up holding $238.
    //
    // Subtracting the observed growth keeps the sum honest whether the book is current or
    // stale: what the venue has confirmed stops being in flight, and what it has not stays
    // reserved. The TTL is the backstop for an order that is never confirmed at all, which
    // would otherwise hold its size forever and wedge the mandate.
    const nextBook = msg.book as Book;
    for (const a of armed.values()) {
      if (a.mandate.symbol !== String(msg.symbol)) continue;
      const grew = Math.max(0, nextBook.positionUsd - a.lastPositionUsd);
      a.inFlightUsd = Math.max(0, a.inFlightUsd - grew);
      a.lastPositionUsd = nextBook.positionUsd;
      if (a.inFlightUsd > 0 && Date.now() - a.inFlightSinceMs > IN_FLIGHT_TTL_MS) {
        send({
          type: 'error',
          id: a.mandate.id,
          message: `releasing ${a.inFlightUsd.toFixed(2)} of unconfirmed size after ${IN_FLIGHT_TTL_MS / 1000}s`,
        });
        a.inFlightUsd = 0;
      }
    }

    // The app owns the market feed and forwards it, so there is one websocket for the whole
    // process tree rather than two views of the same market that can disagree.
    book.set(String(msg.symbol), msg.book as Book);
    return;
  }

  if (cmd === 'refs') {
    for (const [k, v] of Object.entries(msg.values as Record<string, number>)) refCache.set(k, v);
    return;
  }

  if (cmd === 'flatten_and_exit') {
    stopping = true;
    for (const [id] of [...armed]) await flatten(id, String(msg.reason ?? 'kill switch'));
    process.exit(0);
  }

  if (cmd === 'shutdown') process.exit(0);
});

// One tick at a time, always.
//
// setInterval does not wait for an async callback, and a tick that places an order spends
// hundreds of milliseconds inside a network call. At 250ms that meant up to eight ticks running
// at once, every one of them having read the order rate and the position before any of the
// others had changed either. The envelope was not bypassed by a bad rule; it was asked eight
// questions about the same instant and truthfully answered yes to all of them.
//
// This is the classic shape of the bug and it is worth naming: a guard on shared state is only
// a guard if the state cannot be read concurrently with its own update. Serialising the loop is
// what makes every check in it mean what it says.
let ticking = false;

const timer = setInterval(() => {
  if (ticking) return;
  ticking = true;
  void tick().finally(() => {
    ticking = false;
  });
}, 250);
timer.unref?.();

send({ type: 'error', id: null, message: `runner up, ${IS_MAINNET ? 'MAINNET REFUSED' : 'testnet'}` });
