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
import type { Mandate, RunState } from '../strategy/envelope.ts';
import { emptyMemory, evaluate } from '../strategy/evaluate.ts';
import type { MarketState, RuleMemory } from '../strategy/evaluate.ts';
import type { Action, Program, Ref } from '../strategy/grammar.ts';
import { createExchange, aggressiveLimitPrice, newCloid } from '../hl/exchange.ts';
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
};

const armed = new Map<string, Armed>();
let stopping = false;

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
    positionUsd: b?.positionUsd ?? 0,
    positionSide: b?.positionSide ?? 'flat',
    entryAtMs: a.entryAtMs,
    realisedUsd: a.realisedUsd,
    unrealisedUsd: b?.unrealisedUsd ?? 0,
    ordersInLastMin: a.ordersInLastMin.length,
    programHash: a.mandate.programHash,
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
    const isBuy = action.do === 'open' ? action.side === 'long' : b.positionSide !== 'short';
    const entry = action.entry;
    const px =
      entry.type === 'market'
        ? aggressiveLimitPrice(b.markPx, isBuy, entry.maxSlippageBps)
        : (resolveRef(entry.ref) ?? b.markPx);
    const size = action.sizeUsd / px;

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
    a.ordersInLastMin.push(Date.now());
    if (a.entryAtMs === null) a.entryAtMs = Date.now();
    return;
  }

  if (action.do === 'reduce' || action.do === 'close') {
    if (b.positionSide === 'flat') return;
    const isBuy = b.positionSide === 'short'; // closing a short is a buy
    const fraction = action.do === 'close' ? 1 : action.fraction;
    const exit = action.do === 'close' ? action.exit : action.exit;
    const px =
      exit.type === 'market'
        ? aggressiveLimitPrice(b.markPx, isBuy, exit.maxSlippageBps)
        : (resolveRef(exit.ref) ?? b.markPx);

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
    const px = resolveRef(action.ref);
    if (px === null || b.positionSide === 'flat') return;
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
    });
    return;
  }

  if (cmd === 'disarm') {
    armed.delete(String(msg.id));
    return;
  }

  if (cmd === 'book') {
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

const timer = setInterval(() => void tick(), 250);
timer.unref?.();

send({ type: 'error', id: null, message: `runner up, ${IS_MAINNET ? 'MAINNET REFUSED' : 'testnet'}` });
