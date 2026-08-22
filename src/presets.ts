// Study packages: a whole chart setup in one call, and a tidy that runs first.
//
// TWO PROBLEMS, ONE ANSWER.
//
// The first is round trips. Setting up a wave read is five calls (clear, two panes, two
// overlays), each one an LLM turn, each one a visible pause in front of a person watching a
// window. The agent knows the package it wants before the first call; there is no reason for
// it to be spelled out one indicator at a time.
//
// The second is the mess. Three sub-panes is the cap, and it is there so the price stays
// readable. An agent that adds a wave to a chart already carrying RSI, MACD and volume gets
// refused, and the refusal is correct: the honest fix is to clear what is no longer being
// looked at. Before this, clearing was a separate call an agent had to think of, and it
// usually did not. Applying a package CLEARS THE AGENT'S OWN STUDIES FIRST, always, so a
// package cannot fail on a cap and the chart cannot silently accumulate.
//
// WHAT IT NEVER TOUCHES. A human's own indicators are not cleared by a package, on the same
// rule everything else in this app holds: the agent's tidy reaches the agent's work. If a
// human's overlays leave no room, the package says so and applies what fits rather than
// deleting something a person put there on purpose.
//
// The names describe what is being READ, never a strategy. `wave` is the wave family on
// screen; it is not a system, and applying it is not a view about the market.

export type Preset = {
  name: string;
  summary: string;
  // Added in order. Overlays first, so that if a human's overlays leave only some room, what
  // survives is the price context rather than a lone oscillator.
  indicators: { type: string; params?: Record<string, number> }[];
};

export const PRESETS: readonly Preset[] = [
  {
    name: 'wave',
    summary:
      'The wave family: the WaveTrend oscillator with its signal, the candle-body money flow under it, and session VWAP on the price. What the "market cipher" style dashboards put on a screen, drawn from the published formulas.',
    indicators: [
      { type: 'vwapbands', params: { multiplier: 1 } },
      { type: 'ema', params: { period: 21 } },
      { type: 'wave' },
      { type: 'moneyflow' },
    ],
  },
  {
    name: 'trend',
    summary:
      'Trend context: a fast and a slow EMA, the SuperTrend stop, and directional movement underneath so the strength of it is a number rather than an impression.',
    indicators: [
      { type: 'ema', params: { period: 21 } },
      { type: 'ema', params: { period: 55 } },
      { type: 'supertrend' },
      { type: 'adx' },
    ],
  },
  {
    name: 'momentum',
    summary: 'Three momentum panes that disagree usefully: RSI, MACD and the stochastic RSI.',
    indicators: [{ type: 'rsi' }, { type: 'macd' }, { type: 'stochrsi' }],
  },
  {
    name: 'volatility',
    summary:
      'Compression and expansion: Bollinger inside Keltner on the price, and the squeeze pane that reports how long they have been that way.',
    indicators: [{ type: 'bbands' }, { type: 'keltner' }, { type: 'squeeze' }],
  },
  {
    name: 'ichimoku',
    summary: 'The Ichimoku cloud with directional movement under it.',
    indicators: [{ type: 'ichimoku' }, { type: 'adx' }],
  },
  {
    name: 'volume',
    summary:
      'Where the volume actually was: VWAP with its deviation bands, the volume pane, and the volume-weighted money flow index.',
    indicators: [{ type: 'vwapbands' }, { type: 'volume' }, { type: 'mfi' }],
  },
  {
    name: 'scalp',
    summary:
      'A short timeframe setup: a fast EMA and VWAP bands on the price, the wave for turns, and relative volume so a push on nothing is visible as one.',
    indicators: [
      { type: 'ema', params: { period: 9 } },
      { type: 'vwapbands' },
      { type: 'wave', params: { channel: 6, average: 8 } },
      { type: 'relvolume' },
    ],
  },
  {
    name: 'clean',
    summary:
      'Nothing. Clears every study this agent added and leaves the price bare. The one to reach for before starting a different piece of work.',
    indicators: [],
  },
];

export function findPreset(name: unknown): Preset | undefined {
  const key = String(name ?? '').toLowerCase().trim();
  return PRESETS.find((p) => p.name === key);
}

export function presetCatalog(): unknown[] {
  return PRESETS.map((p) => ({
    name: p.name,
    summary: p.summary,
    draws: p.indicators.map((i) => i.type),
  }));
}
