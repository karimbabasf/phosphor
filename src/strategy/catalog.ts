// How to write a mandate, answered in one read.
//
// This exists because of one asymmetry. Every other thing an agent does here is a single call
// with named arguments: chart_set_view takes a product, propose_swap takes two symbols and an
// amount. Opening a position takes a PROGRAM, written in the closed grammar in ./grammar.ts,
// and there is no discretionary order anywhere in this app: nothing opens except when an armed
// mandate's rule fires. So the one action a trader most wants is the one an agent cannot reach
// by reading a tool signature, and the failure mode is the agent asking its human how, or
// worse, guessing and getting a refusal it cannot interpret.
//
// Everything below is data. The examples are real programs, and tests/unit/mandate-catalog
// runs each one through validateProgram, so an example that stops parsing fails the build
// rather than reaching an agent as confident nonsense.

import type { Program } from './grammar.ts';
import type { Network } from '../types.ts';

export type Example = {
  intent: string;
  note: string;
  program: Program;
  envelope: Record<string, unknown>;
};

// The one trap that costs a position rather than a refusal. actionVerbs() derives
// allowedActions from the program itself, and checkEnvelope tests allowedActions before it
// lets any verb through, including the safety ones. A program whose rules only open therefore
// arms a bot that CANNOT CLOSE.
const EXIT_RULE =
  'Every program must contain an exit. allowedActions is derived from the verbs your rules actually use, and the envelope refuses any verb not in that list, including close and cancel. A program that only opens arms a bot that cannot get flat. Always include a close or reduce rule, and normally a set_stop.';

const REFS = [
  { form: '{ "kind": "price", "value": 152.4 }', means: 'a literal price.' },
  {
    form: '{ "kind": "drawing", "id": "tl_1" }',
    means:
      'something you drew on the chart. This is what turns a trend line into a trigger: draw it with chart_trendline or chart_batch op:draw, take the id it returns, and reference it here. The line keeps its slope, so the trigger price moves with time.',
  },
  {
    form: '{ "kind": "indicator", "id": "ema_50", "plot": "value" }',
    means: 'an indicator already on the chart. Add it with chart_add_indicator first and use the id it returns.',
  },
];

const CONDITIONS = [
  { op: 'price_above', fields: '{ ref }', means: 'mark price is above the reference right now.' },
  { op: 'price_below', fields: '{ ref }', means: 'mark price is below the reference right now.' },
  { op: 'price_cross_up', fields: '{ ref }', means: 'price crossed the reference upward since the last check. An edge, not a state.' },
  { op: 'price_cross_down', fields: '{ ref }', means: 'price crossed the reference downward. An edge, not a state.' },
  {
    op: 'bar_close',
    fields: '{ timeframeSec, side: "above" | "below", ref }',
    means: 'a bar of that timeframe CLOSED beyond the reference. Slower and far less noisy than a cross, which is why breakouts use it.',
  },
  { op: 'position', fields: '{ state: "flat" | "long" | "short" }', means: 'what you are holding. `flat` is the usual guard on an entry rule.' },
  { op: 'pnl_pct', fields: '{ cmp: "gt" | "lt", value }', means: 'open PnL as a percent. Negative values are losses.' },
  { op: 'elapsed', fields: '{ since: "arm" | "entry", cmp: "gt" | "lt", seconds }', means: 'time since the mandate armed, or since the position opened. A time stop.' },
  { op: 'and', fields: '{ of: [condition, ...] }', means: 'all of them.' },
  { op: 'or', fields: '{ of: [condition, ...] }', means: 'any of them.' },
  { op: 'not', fields: '{ of: condition }', means: 'the opposite.' },
];

export const ACTIONS = [
  { do: 'open', fields: '{ side: "long" | "short", sizeUsd, leverage, entry }', means: 'open a position. Refused unless flat allows it and the envelope covers the size and the multiple.' },
  { do: 'add', fields: '{ sizeUsd, entry }', means: 'add to what is already open.' },
  { do: 'reduce', fields: '{ fraction, exit }', means: 'take part of it off. fraction is 0 to 1.' },
  { do: 'close', fields: '{ exit }', means: 'get flat.' },
  { do: 'set_stop', fields: '{ ref, trailPct? }', means: 'a stop at a reference. With trailPct it follows the position.' },
  { do: 'set_target', fields: '{ ref, fraction }', means: 'take a fraction off at a reference.' },
  { do: 'cancel', fields: '{ which: "all" | "entries" | "exits" }', means: 'pull resting orders.' },
  { do: 'stand_down', fields: '{ reason }', means: 'stop acting and say why. The thesis is dead but the position is handled elsewhere.' },
  { do: 'notify', fields: '{ text }', means: 'tell the human something. Moves nothing.' },
];

const ENTRIES = [
  { form: '{ "type": "market", "maxSlippageBps": 50 }', means: 'cross the spread, refusing worse than 50 bps of slippage.' },
  { form: '{ "type": "limit", "ref": {...}, "postOnly": true }', means: 'rest at a reference. postOnly refuses to take.' },
];

// The envelope is what the human actually approves. The program says what the bot tries; these
// say what it can never exceed however the program is written.
const ENVELOPE = [
  { field: 'symbol', means: 'the market, for example "SOL". One mandate, one market.' },
  { field: 'maxNotionalUsd', means: 'the largest position it may hold, in dollars. This is the number the policy engine prices the whole mandate at.' },
  { field: 'maxLeverage', means: 'the largest multiple. Set at the venue as an ACCOUNT setting, not per order, so this is enforced rather than requested.' },
  { field: 'maxOrdersPerMin', means: 'a rate limit. Several rules can fire in one tick, so this is what stops a loop.' },
  { field: 'maxLossUsd', means: 'the stop-out wall for the whole mandate. It disarms itself here.' },
  { field: 'expiresAt', means: 'an ISO timestamp. Standing authority with no end is not something to hand out; keep it hours, not weeks.' },
  { field: 'allowedActions', means: 'the verbs it may use. Derive it from the program (every verb the rules use) and read EXIT_RULE before you do.' },
];

// The one line in this file that must never be stale. An agent that believes it is on testnet
// writes bolder programs than an agent that knows the money is real, so a hardcoded "testnet
// only" is not a harmless leftover once mainnet is switched on: it is the app telling the
// agent the opposite of the truth at exactly the moment the truth matters.
function networkTrap(network: Network): string {
  return network === 'mainnet'
    ? 'Trading is on Hyperliquid MAINNET. Every mandate you propose is armed against real money, and a rule that fires spends it. Size the envelope like it is the human real balance, because it is.'
    : 'Trading is on Hyperliquid testnet, so a mandate is armed against play money. Write the program as if it were real anyway: the same program is what runs when the app is pointed at mainnet.';
}

const TRAPS = [
  EXIT_RULE,
  'propose_mandate ALWAYS waits for a human click, on every network, even where the approval gate is off. It grants standing authority rather than spending once, so there is no threshold that skips it. Expect to wait, and tell the human what you asked for in plain words.',
  'The approval screen renders your program as English. Write rules a person can check against what you told them, because what they read is what they are agreeing to.',
  'Prices in a program are literal numbers. Read the live price first (trade_read, or chart_read) and compute stops and targets from it, or you will arm a stop that is already crossed.',
  'A cross condition is an EDGE and fires once as it happens. A price_above is a STATE and is true for as long as it is true. Guard state conditions with `once: true` or a position check, or they fire on every tick.',
];

// Every one of these is run through validateProgram by the unit test beside this file. Prices
// are placeholders and say so: an agent must read the market before it arms anything.
export const EXAMPLES: Example[] = [
  {
    intent: 'Short $100 of SOL at 10x, market entry, once, with a stop and a hard loss bail.',
    note:
      'The plainest possible mandate and the shape most requests reduce to. Replace stopPrice with a real level read from the market: this one sits above entry because a short is stopped out upward.',
    program: {
      symbol: 'SOL',
      rules: [
        {
          id: 'enter',
          when: { op: 'position', state: 'flat' },
          once: true,
          then: [
            { do: 'open', side: 'short', sizeUsd: 100, leverage: 10, entry: { type: 'market', maxSlippageBps: 50 } },
            { do: 'set_stop', ref: { kind: 'price', value: 160 } },
          ],
        },
        {
          id: 'bail',
          when: { op: 'pnl_pct', cmp: 'lt', value: -20 },
          then: [{ do: 'close', exit: { type: 'market', maxSlippageBps: 100 } }],
        },
      ],
    },
    envelope: {
      symbol: 'SOL',
      maxNotionalUsd: 100,
      maxLeverage: 10,
      maxOrdersPerMin: 6,
      maxLossUsd: 25,
      expiresAt: '(ISO timestamp, a few hours out)',
      allowedActions: ['open', 'set_stop', 'close'],
    },
  },
  {
    intent: 'Go long when price closes above a trend line I drew, and stop out back under it.',
    note:
      'The reason drawing and trading are one system. Draw the line first with chart_trendline or chart_batch op:draw, take the id it returns (tl_1 here), and the trigger tracks the slope: the level it fires at moves as time passes, which a literal price cannot do. NOT ARMABLE TODAY: the runner is fed the order book and nothing else, so it has no value for a drawing and no bar closes, and arming this is refused rather than left to sit reading false forever. Write the levels as fixed prices until the runner is fed the chart. See unrunnableRefusal in src/runner/host.ts.',
    program: {
      symbol: 'BTC',
      rules: [
        {
          id: 'break-up',
          when: {
            op: 'and',
            of: [
              { op: 'position', state: 'flat' },
              { op: 'bar_close', timeframeSec: 900, side: 'above', ref: { kind: 'drawing', id: 'tl_1' } },
            ],
          },
          once: true,
          then: [
            { do: 'open', side: 'long', sizeUsd: 250, leverage: 3, entry: { type: 'market', maxSlippageBps: 30 } },
            { do: 'set_stop', ref: { kind: 'drawing', id: 'tl_1' } },
          ],
        },
        {
          id: 'thesis-dead',
          when: { op: 'bar_close', timeframeSec: 900, side: 'below', ref: { kind: 'drawing', id: 'tl_1' } },
          then: [
            { do: 'close', exit: { type: 'market', maxSlippageBps: 60 } },
            { do: 'stand_down', reason: 'closed back under the line the trade was based on' },
          ],
        },
      ],
    },
    envelope: {
      symbol: 'BTC',
      maxNotionalUsd: 250,
      maxLeverage: 3,
      maxOrdersPerMin: 4,
      maxLossUsd: 40,
      expiresAt: '(ISO timestamp)',
      allowedActions: ['open', 'set_stop', 'close', 'stand_down'],
    },
  },
  {
    intent: 'Scale out: take half off at a target, trail the rest, and give up after two hours.',
    note: 'Shows set_target with a fraction, a trailing stop, and a time stop measured from entry rather than from arm.',
    program: {
      symbol: 'ETH',
      rules: [
        {
          id: 'enter',
          when: { op: 'position', state: 'flat' },
          once: true,
          then: [{ do: 'open', side: 'long', sizeUsd: 300, leverage: 2, entry: { type: 'limit', ref: { kind: 'price', value: 2400 }, postOnly: true } }],
        },
        {
          id: 'half-off',
          when: { op: 'pnl_pct', cmp: 'gt', value: 4 },
          once: true,
          then: [
            { do: 'set_target', ref: { kind: 'price', value: 2600 }, fraction: 0.5 },
            { do: 'set_stop', ref: { kind: 'price', value: 2450 }, trailPct: 1.5 },
          ],
        },
        {
          id: 'time-stop',
          when: { op: 'elapsed', since: 'entry', cmp: 'gt', seconds: 7200 },
          then: [
            { do: 'close', exit: { type: 'market', maxSlippageBps: 60 } },
            { do: 'cancel', which: 'all' },
          ],
        },
      ],
    },
    envelope: {
      symbol: 'ETH',
      maxNotionalUsd: 300,
      maxLeverage: 2,
      maxOrdersPerMin: 6,
      maxLossUsd: 45,
      expiresAt: '(ISO timestamp)',
      allowedActions: ['open', 'set_target', 'set_stop', 'close', 'cancel'],
    },
  },
  {
    intent: 'Watch only: tell me when a level breaks, and never touch the book.',
    note:
      'A mandate that trades nothing is a legitimate and cheap thing to arm, and it is the right first mandate when a human wants to see the machinery work before it holds risk. allowedActions carries notify alone, so no verb that moves anything is permitted at all.',
    program: {
      symbol: 'SOL',
      rules: [
        {
          id: 'tell-me',
          when: { op: 'price_cross_up', ref: { kind: 'price', value: 200 } },
          once: true,
          then: [{ do: 'notify', text: 'SOL crossed 200' }],
        },
      ],
    },
    envelope: {
      symbol: 'SOL',
      maxNotionalUsd: 0,
      maxLeverage: 1,
      maxOrdersPerMin: 1,
      maxLossUsd: 0,
      expiresAt: '(ISO timestamp)',
      allowedActions: ['notify'],
    },
  },
];

export function buildMandateCatalog(network: Network) {
  return {
    howItWorks:
      'This app has no discretionary order. Nothing opens except when an armed mandate rule fires, so opening a position means writing a program in this grammar and proposing it with propose_mandate. The program says what the bot tries; the envelope says what it can never exceed. A human approves both, always.',
    network,
    refs: REFS,
    conditions: CONDITIONS,
    actions: ACTIONS,
    entries: ENTRIES,
    envelope: ENVELOPE,
    // The network line is first because it changes how every line under it should be read.
    traps: [networkTrap(network), ...TRAPS],
    examples: EXAMPLES,
  };
}
