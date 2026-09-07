// Realised profit and loss for a mandate, from the venue's own fills.
//
// WHY THIS IS A MODULE AND NOT A LINE IN TWO PLACES. A mandate's maxLossUsd is the ceiling on
// the one proposal type that grants standing, unattended authority, and the child enforces it
// as `-(realisedUsd + unrealisedUsd) >= maxLossUsd`. The child initialised realisedUsd to 0 and
// never assigned it again, so only OPEN losses counted. A program with a stop and a re-entry
// rule, which is the shape src/strategy/catalog.ts teaches, therefore had no cap at all: the
// stop fills at minus $50, the position is flat, unrealised is 0, the supervisor computes a loss
// of 0, and the entry rule fires again on the next cross. Roughly the whole allowance per cycle,
// for as long as the signing session lives.
//
// Meanwhile the app was already computing the real figure for the trading screen, from the
// venue's own closed-PnL on the fills for the window since the mandate armed. So the gauge on
// screen could read "at the limit" while the child kept trading, because the number displayed
// and the number enforced came from different places. This is that one number, computed once
// and used by both.
//
// Fees are subtracted, because a fee is money that left the account and a loss ceiling that
// ignores them is a ceiling the account can be walked past one commission at a time.

export type FillRow = {
  coin: string;
  atMs: number;
  // What the venue booked as closed profit on this fill. Absent on a fill that opened a
  // position rather than closing one.
  closedPnlUsd?: number | null;
  feeUsd: number;
};

export function realisedSince(fills: readonly FillRow[], symbol: string, sinceMs: number): number {
  const coin = symbol.toUpperCase();
  return fills
    .filter((f) => f.coin.toUpperCase() === coin && f.atMs >= sinceMs)
    .reduce((sum, f) => sum + (f.closedPnlUsd ?? 0) - f.feeUsd, 0);
}

// What the app pushes to the child on every book: mandate id to realised USD. Keyed by mandate
// rather than by symbol because the window each figure covers starts when that mandate armed,
// so two mandates on one coin have two different answers.
export type RealisedByMandate = Record<string, number>;

/* Applied to one armed record on the way in. Kept here rather than inline in the child's book
   handler so the assignment the whole finding is about is a function a test can call: the child
   is a forked process whose module has top-level side effects, and a test cannot import it. */
export function applyRealised(armed: { mandate: { id: string }; realisedUsd: number }, realised: RealisedByMandate | undefined): void {
  if (realised === undefined) return;
  const next = realised[armed.mandate.id];
  // Silence leaves the last known figure in place rather than resetting it to zero. A feed that
  // stops answering must not read as a wallet that stopped losing money.
  if (typeof next === 'number' && Number.isFinite(next)) armed.realisedUsd = next;
}
