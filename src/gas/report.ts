// What this app has spent on gas, added up. A pure fold over the transaction history.
//
// It takes TxEntry[] and returns numbers. No RPC, no store, no config read, no clock of its
// own: the clock arrives as nowMs. That is deliberate twice over. A report that did its own
// reads would be a second source of truth for money that already has one in
// src/transactions.ts, and it would sit on the request path carrying an error budget it
// cannot pay. Grouping is the whole job here.
//
// Two properties this file exists to hold.
//
// Gas units never become floats. A busy chain burns past 2^53 units when a history is summed
// over months, and a float sum past that point rounds without telling anyone: 9007199254740993
// plus 1 gives back 9007199254740994. BigInt inside, decimal string at the edge, which is the
// same rule the rails keep at 18 decimals and for the same reason.
//
// Nothing that cannot be counted is quietly counted as zero. The four remainders (pending,
// unknown, intent-settled, unpriced) leave here as their own numbers. An aggregate that drops
// what it cannot see reports a smaller total than the truth and then calls it the truth, and
// "$1.42 spent on gas" while three receipts are still being read is a wrong number said
// confidently, which is worse for the person reading it than a right number with a line
// underneath saying what is missing.

import type { TxEntry, TxGas } from '../transactions.ts';

export type GasWindow = '24h' | '7d' | '30d' | 'all';

export type GasSlice = {
  key: string;          // stable grouping key: 'swap', 'arb', 'intents_deposit', 'oneclick'
  label: string;        // what the legend prints
  feeUsd: number;       // summed, priced receipts only
  feeNative: number;    // summed; meaningful only when `symbol` is non-null
  symbol: string | null;// the native symbol, null when the slice spans chains with different ones
  gasUsed: string;      // summed gas units, decimal string: base units never become floats
  txCount: number;      // receipts that burned gas
  moveCount: number;    // distinct TxEntry rows contributing
  share: number;        // 0..1 of totalUsd; 0 when totalUsd is 0
};

export type GasReport = {
  window: GasWindow;
  fromTs: string | null;      // null for 'all'
  toTs: string;
  totalUsd: number;
  totalGasUsed: string;
  txCount: number;            // receipts that burned gas
  moveCount: number;          // movements that burned gas
  byAction: GasSlice[];       // TxEntry.action: swap, deposit, withdraw, transfer, ...
  byChain: GasSlice[];        // TxGas.place: eth, base, arb
  /* WriteDraft kind: intents_deposit vs hl_deposit vs swap. Retired kinds still appear here
     (lp_add, yield_deposit and the rest), because this groups the history and that history
     really happened. Nothing keys a decision off these values, so no branch needs updating
     when a kind stops being proposable. */
  byKind: GasSlice[];
  byVenue: GasSlice[];        // TxEntry.venue, with 'none' for a move that named no venue
  reverted: { feeUsd: number; txCount: number };
  unpriced: { txCount: number; gasUsed: string };
  pending: { moveCount: number };
  unknown: { moveCount: number };
  intentOnly: { moveCount: number };   // moves whose every hash was an intent
  movedUsd: number;           // summed TxEntry.valueUsd over executed moves in the window
  gasBps: number | null;      // totalUsd / movedUsd * 10000, null when movedUsd is 0
  venueFeeUsd: number;        // summed TxEntry.venueFeeUsd: NOT gas, shown beside it
};

const WINDOW_MS: Record<Exclude<GasWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Dollars are summed as integer nano-dollars, never as running floats.
//
// The report has to hold sum(byChain.feeUsd) === totalUsd, and the four slice maps fold the
// same receipts in four different orders. Float addition is not associative, so the grouping
// order alone can move the last bit and turn that invariant into a tolerance. Integers make
// it a fact. The floor this costs is 1e-9 USD, four orders of magnitude below the cheapest
// receipt this app has ever recorded.
const NANO = 1_000_000_000;
const WEI = 1e18;

function nanoUsd(usd: number): bigint {
  if (!Number.isFinite(usd)) return 0n;
  return BigInt(Math.round(usd * NANO));
}

function usd(nano: bigint): number {
  return Number(nano) / NANO;
}

// A receipt figure is always a decimal string written by receipt.gasUsed.toString(), so the
// only way here is a hand-edited or truncated tx-gas.json. That counts as a receipt with no
// units rather than throwing, because one damaged cache line must not take the whole report
// down: the row is still visible in txCount, which is where a reader would notice it.
function units(value: string): bigint {
  return /^[0-9]+$/.test(value) ? BigInt(value) : 0n;
}

type Acc = {
  key: string;
  label: string;
  nanoUsd: bigint;
  wei: bigint;
  gasUsed: bigint;
  txCount: number;
  moveCount: number;
  lastMove: number;
  symbol: string | null;
  mixed: boolean;
};

// One receipt's contribution, built once and pushed into all four groupings, so the four can
// never disagree about what a single receipt cost.
type Charge = {
  move: number; // index of the TxEntry this receipt hangs off, for the distinct move count
  nanoUsd: bigint;
  gasUsed: bigint;
  wei: bigint;
  symbol: string;
};

function bump(into: Map<string, Acc>, key: string, label: string, charge: Charge): void {
  let acc = into.get(key);
  if (acc === undefined) {
    acc = {
      key, label,
      nanoUsd: 0n, wei: 0n, gasUsed: 0n,
      txCount: 0, moveCount: 0, lastMove: -1,
      symbol: null, mixed: false,
    };
    into.set(key, acc);
  }
  acc.nanoUsd += charge.nanoUsd;
  acc.wei += charge.wei;
  acc.gasUsed += charge.gasUsed;
  acc.txCount += 1;
  // Entries arrive in order and a move's receipts arrive together, so the last id seen is
  // enough to count distinct rows without holding a Set per slice.
  if (acc.lastMove !== charge.move) {
    acc.moveCount += 1;
    acc.lastMove = charge.move;
  }
  if (acc.symbol === null) acc.symbol = charge.symbol;
  else if (acc.symbol !== charge.symbol) acc.mixed = true;
}

// Dollars first, descending. A slice with no price still burned gas, so units break the tie
// and it lands last rather than nowhere; the key breaks what is left, so two runs over the
// same history print the same order and a screenshot of one can be compared with the other.
function bySpend(a: Acc, b: Acc): number {
  if (a.nanoUsd !== b.nanoUsd) return a.nanoUsd > b.nanoUsd ? -1 : 1;
  if (a.gasUsed !== b.gasUsed) return a.gasUsed > b.gasUsed ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function slices(accs: Map<string, Acc>, totalNano: bigint): GasSlice[] {
  return [...accs.values()].sort(bySpend).map(a => ({
    key: a.key,
    label: a.label,
    feeUsd: usd(a.nanoUsd),
    // Summed in wei and divided once. gasUsed * gasPriceWei is exactly what the receipt
    // reader multiplied to get feeNative in the first place, so this is the same quantity
    // with the eighteen decimals kept until the last step instead of one rounding per row.
    feeNative: Number(a.wei) / WEI,
    symbol: a.mixed ? null : a.symbol,
    gasUsed: a.gasUsed.toString(),
    txCount: a.txCount,
    moveCount: a.moveCount,
    share: totalNano === 0n ? 0 : Number(a.nanoUsd) / Number(totalNano),
  }));
}

// A kind is a machine token ('intents_deposit'); a legend is read by a person. The key stays
// the token so the UI and the MCP tool can key off it. Works on a retired kind unchanged: it
// only reshapes the string.
function kindLabel(kind: TxEntry['kind']): string {
  return kind.replace(/_/g, ' ');
}

export function buildGasReport(args: { entries: TxEntry[]; window: GasWindow; nowMs: number }): GasReport {
  const { entries, window, nowMs } = args;
  const fromMs = window === 'all' ? null : nowMs - WINDOW_MS[window];

  const byAction = new Map<string, Acc>();
  const byChain = new Map<string, Acc>();
  const byKind = new Map<string, Acc>();
  const byVenue = new Map<string, Acc>();

  let totalNano = 0n;
  let totalGas = 0n;
  let txCount = 0;
  let moveCount = 0;
  let movedNano = 0n;
  let venueFeeNano = 0n;
  let revertedNano = 0n;
  let revertedTx = 0;
  let unpricedTx = 0;
  let unpricedGas = 0n;
  let pendingMoves = 0;
  let unknownMoves = 0;
  let intentOnlyMoves = 0;

  let move = -1;
  for (const entry of entries) {
    // The window filters on TxEntry.ts, the settle time, which is the timestamp every other
    // surface in this app orders by. A ts that will not parse cannot be proved to be outside
    // the window, so it stays in: dropping it would be the silent loss this file is against.
    if (fromMs !== null) {
      const ms = Date.parse(entry.ts);
      if (Number.isFinite(ms) && ms < fromMs) continue;
    }
    move += 1;

    let burned = false;
    let pending = false;
    let unknown = false;
    let intents = 0;

    for (const hash of entry.hashes) {
      // An intent is signed by us and settled by a solver. It burned no gas of ours, which
      // is a fact about the rail rather than a hole in the data, so it is never a remainder
      // to chase and never a zero to average into anything.
      if (hash.kind === 'intent') {
        intents += 1;
        continue;
      }
      const receipt: TxGas | null = hash.gas;
      if (receipt === null) {
        // Both of these are "we do not know what this cost", and they are different
        // sentences: one is still being read, the other was looked for on every chain this
        // app can reach and found on none.
        if (hash.gasPending) pending = true;
        else unknown = true;
        continue;
      }

      const gasUsed = units(receipt.gasUsed);
      const nano = receipt.feeUsd === null ? 0n : nanoUsd(receipt.feeUsd);
      burned = true;
      txCount += 1;
      totalGas += gasUsed;
      totalNano += nano;
      if (receipt.feeUsd === null) {
        // The units are known and no price was available. Its gas counts everywhere; its
        // dollars are absent rather than zero, and the count says how much is absent.
        unpricedTx += 1;
        unpricedGas += gasUsed;
      }
      if (receipt.status === 'reverted') {
        // Not a remainder: this is counted in the total like any other receipt. It gets its
        // own line because it is the only figure in the report that is pure loss, gas paid
        // for a movement that did not happen.
        revertedTx += 1;
        revertedNano += nano;
      }

      const charge: Charge = { move, nanoUsd: nano, gasUsed, wei: gasUsed * units(receipt.gasPriceWei), symbol: receipt.feeSymbol };
      // The receipt's own place, never the draft's guess. TxGas.place is the chain whose RPC
      // actually answered with this hash, and a cross-chain move records an origin hash and a
      // destination hash, so this is the only grouping that splits one movement across two
      // chains. byAction, byKind and byVenue group the movement, so each of them sees every
      // receipt of that movement in one slice. The legend prints the place token itself,
      // which is what the HISTORY rows already print, rather than a second prettier table
      // for the same three chains that would drift from the first one it gained a chain.
      bump(byChain, receipt.place, receipt.place, charge);
      bump(byAction, entry.action, entry.action, charge);
      bump(byKind, entry.kind, kindLabel(entry.kind), charge);
      bump(byVenue, entry.venue ?? 'none', entry.venue ?? 'no venue', charge);
    }

    if (burned) moveCount += 1;
    if (pending) pendingMoves += 1;
    if (unknown) unknownMoves += 1;
    if (entry.hashes.length > 0 && intents === entry.hashes.length) intentOnlyMoves += 1;
    // A movement that recorded no hash at all. It is not intent-settled, and saying so would
    // be a claim about a solver nobody has evidence for, so it goes to the one bucket that
    // states only what is true here: this app cannot account for what this move cost. The
    // alternative, counting it nowhere, is the silent drop.
    if (entry.hashes.length === 0) unknownMoves += 1;

    // A failed move burned gas (counted above) and moved nothing (not counted here). That
    // asymmetry is the whole point of gasBps. Note this keys off the move's own status, not
    // off a reverted receipt: a cross-chain move whose destination leg reverted still moved
    // the value its origin leg sent, and erasing all of it would understate movedUsd and
    // then overstate the ratio built on it.
    if (entry.status === 'executed' || entry.status === 'executing') {
      movedNano += nanoUsd(entry.valueUsd);
      // The venue's own fee, off the quote the human approved. Same subset as movedUsd: a
      // quote for a move that never executed named a fee nobody paid.
      if (entry.venueFeeUsd !== null) venueFeeNano += nanoUsd(entry.venueFeeUsd);
    }
  }

  const totalUsd = usd(totalNano);
  const movedUsd = usd(movedNano);

  return {
    window,
    fromTs: fromMs === null ? null : new Date(fromMs).toISOString(),
    toTs: new Date(nowMs).toISOString(),
    totalUsd,
    totalGasUsed: totalGas.toString(),
    txCount,
    moveCount,
    byAction: slices(byAction, totalNano),
    byChain: slices(byChain, totalNano),
    byKind: slices(byKind, totalNano),
    byVenue: slices(byVenue, totalNano),
    reverted: { feeUsd: usd(revertedNano), txCount: revertedTx },
    unpriced: { txCount: unpricedTx, gasUsed: unpricedGas.toString() },
    pending: { moveCount: pendingMoves },
    unknown: { moveCount: unknownMoves },
    intentOnly: { moveCount: intentOnlyMoves },
    movedUsd,
    gasBps: movedNano === 0n ? null : (totalUsd / movedUsd) * 10000,
    venueFeeUsd: usd(venueFeeNano),
  };
}
