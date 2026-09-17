// An hour of gas readings, one per minute, in memory. What the receipt's sparkline draws and
// what "3x the hourly average" is measured against. Nothing is written to disk: a restart
// starts the hour again, and the first preflight after it simply has no average to quote.

export const GAS_HISTORY_SAMPLES = 60;
const SLOT_MS = 60_000;
const SPAN_MS = GAS_HISTORY_SAMPLES * SLOT_MS;

export type GasHistory = {
  // Records a reading. Two readings inside the same minute are one sample, the newer one.
  push(at: number, value: number): void;
  // The samples of the last hour, oldest first.
  series(now: number): number[];
  // Their mean, or null when there are none.
  average(now: number): number | null;
};

export function createGasHistory(): GasHistory {
  const samples: Array<{ slot: number; value: number }> = [];

  function prune(now: number): void {
    const oldest = Math.floor((now - SPAN_MS) / SLOT_MS) + 1;
    while (samples.length > 0 && samples[0].slot < oldest) samples.shift();
    while (samples.length > GAS_HISTORY_SAMPLES) samples.shift();
  }

  return {
    push(at, value) {
      if (!Number.isFinite(value)) return;
      const slot = Math.floor(at / SLOT_MS);
      const last = samples[samples.length - 1];
      if (last !== undefined && last.slot === slot) last.value = value;
      else if (last === undefined || last.slot < slot) samples.push({ slot, value });
      prune(at);
    },
    series(now) {
      prune(now);
      return samples.map((s) => s.value);
    },
    average(now) {
      prune(now);
      if (samples.length === 0) return null;
      return samples.reduce((sum, s) => sum + s.value, 0) / samples.length;
    },
  };
}
