// PHOSPHOR MCP stdio server: a thin proxy. Every tool call becomes one POST to
// the control app's /api/mcp route on localhost. No state, no keys, no file
// writes, and no path that can approve, refuse, dismiss, or execute a proposal;
// that decision is a physical click a human makes in the app window.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePort(): number {
  if (process.env.ACC_PORT) return Number(process.env.ACC_PORT);
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw) as { port?: number };
    if (typeof cfg.port === 'number') return cfg.port;
  } catch {
    // no config.json at the repo root, or it does not parse: fall through to the hard default
  }
  return 4177;
}

const BASE_URL = `http://127.0.0.1:${resolvePort()}`;
const NOT_RUNNING = 'The control app is not running. Start it with: npm run app';

// One id per MCP process, which is one id per agent session. It is what makes the app able
// to tell two agents apart, and therefore able to let only one of them in. It is an
// identifier and never an authorisation: see the KNOWN HOLE note at the top of
// src/server.ts. A restart mints a new one, which is correct: it is a new session.
const SESSION = randomUUID();

// The app derives its expiry window from this number, so the two cannot drift apart. Five
// seconds costs nothing on loopback and takes the worst-case "still shows connected" from
// about a minute down to about twelve seconds when an agent is killed outright.
const HELLO_MS = 5_000;
const CLIENT = 'phosphor-mcp';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function proxy(body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, session: SESSION, client: CLIENT }),
    });
  } catch {
    return textResult(NOT_RUNNING);
  }
  try {
    const json: unknown = await res.json();
    // A refused seat is the one error worth surfacing as a sentence rather than as a JSON
    // blob: the agent reading it has to understand that it is not connected and why, or it
    // will read the refusal as the tool being broken and try something else. Keyed on the
    // marker rather than on the status, because other 409s (a view change refused while a
    // human is deciding) are answers whose shape their callers depend on.
    const payload = json as { error?: unknown; seat?: unknown };
    if (res.status === 409 && payload.seat === 'busy' && typeof payload.error === 'string') {
      return textResult(payload.error);
    }
    return textResult(JSON.stringify(json));
  } catch {
    return textResult(NOT_RUNNING);
  }
}

async function sendHello(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'hello', client: CLIENT, session: SESSION, intervalMs: HELLO_MS }),
    });
  } catch {
    // app not reachable yet; the next heartbeat tries again
  }
}

// The goodbye. A killed process cannot send one and the app's TTL covers that case, but
// every ordinary exit CAN, and this is what makes the seat free itself and the light go out
// the instant an agent is closed instead of one TTL later.
let leaving = false;

async function sendBye(): Promise<void> {
  if (leaving) return;
  leaving = true;
  try {
    // Bounded: a shutdown must not hang on an app that is already gone.
    await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'bye', session: SESSION }),
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // nothing to say goodbye to; the app's TTL sweeps the seat
  }
}

// Both halves of how an MCP server dies: the harness closes stdin, or it signals. Adding a
// signal listener overrides node's default exit, so each one exits explicitly.
function wireShutdown(): void {
  const leave = (code: number) => {
    void sendBye().finally(() => process.exit(code));
  };
  process.stdin.on('end', () => leave(0));
  process.stdin.on('close', () => leave(0));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => leave(0));
  }
}

const server = new McpServer({ name: 'phosphor', version: '0.3.0' });

function registerRead(name: string, description: string, shape: Record<string, z.ZodTypeAny>): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'read', tool: name, args }),
  );
}

type ProposeKind =
  | 'consolidate'
  | 'policy_change'
  | 'swap'
  | 'hl_deposit'
  | 'intents_deposit'
  | 'intents_withdraw'
  | 'lp_add'
  | 'lp_remove'
  | 'mandate_arm';

function registerPropose(
  name: string,
  kind: ProposeKind,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'propose', kind, params: args }),
  );
}

const CHAIN = z.enum(['eth', 'base', 'arb', 'sol', 'near']);

// This sentence used to read "Execution only ever happens after a human approves in the
// app window". That is false below the click threshold, where the policy engine decides
// and the proposal executes immediately with decidedBy 'policy' (verified 2026-08-12: a
// $60.64 lp_add). One shared constant put the same false claim on all six propose tools.
//
// A tool description is the whole interface an agent reasons from before it acts, so a
// description that overstates the safety net is a defect in the safety net.
const CANNOT_APPROVE =
  'Returns a proposal id and simulation result. This tool cannot approve, refuse or execute anything. Whether a human is asked depends on the policy: proposals above the click threshold wait for a human click in the app window, and proposals below it are decided by the policy engine and may execute immediately.';

registerRead(
  'balances',
  'Returns current holdings across every configured chain, with per-chain staleness. Read-only, changes nothing.',
  {},
);
registerRead(
  'wallet',
  'Returns everything held the way a wallet shows it: one row per token and per liquidity pool position, with chain, quantity, unit price, USD value and share of the total. Read-only, changes nothing.',
  {},
);
registerRead(
  'composition',
  'Returns stablecoin composition by issuer and chain: shares, freezable share, and any unclassified holdings. Read-only, changes nothing.',
  {},
);
registerRead(
  'policy_show',
  'Returns the current policy as plain-English sentences, or reports that the policy file is unreadable and every write is refused. Read-only, changes nothing.',
  {},
);
registerRead('log_tail', 'Returns the most recent audit log lines, newest first. Read-only, changes nothing.', {
  limit: z.number().int().optional().default(50),
});
registerRead(
  'candles',
  'Returns recent OHLC candles for a product, with a staleness marker. Read-only, changes nothing.',
  { product: z.string(), granularity: z.number().int().optional().default(60) },
);
registerRead(
  'proposal_status',
  'Returns the status, verdict, and simulation result for a proposal id. Read-only, changes nothing.',
  { id: z.string() },
);

// ---------- the chart ----------
//
// Reading and driving the chart moves no money, so none of this goes near the approval gate.
// It is still audited like every other call, and everything written here is labelled [agent]
// on the surface a human uses to decide whether to approve a transfer.

registerRead(
  'chart_read',
  'Returns everything about the chart as it currently stands: product, timeframe, the visible time range in epoch seconds and ISO, seconds until the current bar closes, the current bar OHLCV, the change and range across the window, the price scale and the decimal precision in use, every indicator with its last values and a one-line state, the price levels and marks, and the on-screen geometry so you can tell whether what you asked for is readable. Read-only, changes nothing.',
  {},
);
registerRead(
  'chart_measure',
  'Measures between two points on the chart: absolute and percent change, bars and elapsed time between them, the high and low the path actually took, and the worst drawdown along the way. Give two times, two prices, or one of each; anything left out defaults to the oldest loaded bar and the newest. Read-only, changes nothing.',
  {
    fromTime: z.number().optional(),
    toTime: z.number().optional(),
    fromPrice: z.number().optional(),
    toPrice: z.number().optional(),
  },
);
registerRead(
  'chart_scan',
  'Reads several timeframes at once without moving the chart: last price, change, high and low, range, ATR in price and percent, trend, and seconds until each bar closes. Use this to hold a multi-timeframe picture instead of switching the view back and forth. Read-only, changes nothing.',
  {
    product: z.string().optional(),
    timeframes: z.array(z.string()).optional(),
    bars: z.number().int().optional(),
  },
);
registerRead(
  'indicator_catalog',
  'Lists every indicator this chart can draw, with its parameters, defaults, allowed ranges, and whether it overlays the price or takes its own pane. Call this before chart_add_indicator. Read-only, changes nothing.',
  {},
);
registerRead(
  'market_search',
  'Finds a market to chart. Takes anything a person would say ("btc", "bitcoin", "wif", "PEPE-USD") and returns the product id chart_set_view wants, plus near matches when the query is ambiguous. Every result can be charted on any timeframe from 1m to 1w. Read-only, changes nothing.',
  { query: z.string(), limit: z.number().int().optional() },
);
registerRead(
  'chart_batch',
  [
    'The measurement instrument: many chart questions and drawings in ONE call.',
    'Each entry is { op, args, as }. A later entry can use an earlier one with "$ref:<as>.<field>",',
    'so drawing a line and measuring against it is a single call. One failing entry does not stop the rest.',
    '',
    'Seeing: candles, history_page (walks back through history on a cursor, no limit on how far).',
    'Measuring: pivots (swing points by prominence), levels (where price reacted before),',
    'regime (volatility percentile), atr, volume_profile (point of control and value area),',
    'vwap (anchored to a bar you choose), range (Kaufman efficiency), divergence, indicator_series.',
    'Geometry: trendline_fit, trendline_at (what a drawn line is worth at any time),',
    'trendline_touches (every bar that came within a tolerance of it).',
    'Drawing: draw (trendline or zone), drawings_list, drawings_remove, drawings_clear.',
    '',
    'Anything drawn appears on the human chart tagged [agent] and keeps a stable id.',
    'Every result is a MEASUREMENT with the parameters that produced it. This tool returns no',
    'signals, scores or trade suggestions: you do the reading, it does the measuring.',
    'Omit product or granularitySec to measure whatever the chart is currently showing.',
  ].join(' '),
  {
    ops: z.array(
      z.object({
        op: z.string(),
        // Every argument this surface accepts, named. An open record would have been
        // shorter and would have put a hole in the guarantee tests/injection.test.ts
        // exists to hold: that scan walks schema property names looking for an
        // exfiltration target, and it cannot see inside a free-form bag. Enumerating the
        // keys keeps the absence of an address provable rather than merely true, and it
        // has the second benefit of telling the agent which arguments exist.
        args: z
          .object({
            product: z.string().optional(),
            granularitySec: z.number().optional(),
            bars: z.number().int().optional(),
            // pivots, levels, trend line fitting
            window: z.number().optional(),
            minProminence: z.number().optional(),
            tolerance: z.number().optional(),
            kind: z.enum(['high', 'low', 'trendline', 'zone']).optional(),
            // regime, atr
            period: z.number().optional(),
            lookback: z.number().optional(),
            // volume profile
            bins: z.number().int().optional(),
            valueAreaPct: z.number().optional(),
            // vwap
            anchorIndex: z.number().int().optional(),
            // range
            maxEfficiency: z.number().optional(),
            // indicator series and divergence
            indicator: z.string().optional(),
            plot: z.string().optional(),
            params: z.record(z.number()).optional(),
            // drawing. Anchors are time and price, never pixels and never an address.
            label: z.string().optional(),
            a: z.object({ t: z.number(), price: z.number() }).optional(),
            b: z.object({ t: z.number(), price: z.number() }).optional(),
            low: z.number().optional(),
            high: z.number().optional(),
            // referring to something already drawn
            id: z.string().optional(),
            t: z.number().optional(),
            // history paging
            cursor: z.number().optional(),
            limit: z.number().int().optional(),
            source: z.enum(['agent', 'all']).optional(),
          })
          .optional(),
        as: z.string().optional(),
      }),
    ),
  },
);

function registerView(name: string, description: string, shape: Record<string, z.ZodTypeAny>): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => proxy({ op: 'view', tool: name, args }));
}

const CHART_ANSWER = 'Returns the full chart read after the change, so no follow-up call is needed.';

registerView(
  'chart_set_view',
  `Changes what the chart shows: product, timeframe, how many bars are on screen, how far back the window sits, and the price scale. Pass live:true to jump back to the newest bar. Omit a field to leave it alone. ${CHART_ANSWER}`,
  {
    product: z.string().optional(),
    timeframe: z.string().optional().describe('one of 1s 5s 15s 30s 1m 5m 15m 30m 1h 4h 8h 1d'),
    barCount: z.number().optional().describe('bars across the plot, 20 to 500'),
    panOffset: z.number().optional().describe('bars back from the newest; 0 is live'),
    live: z.boolean().optional(),
    priceScale: z.enum(['auto']).optional(),
    priceLow: z.number().optional(),
    priceHigh: z.number().optional(),
  },
);
registerView(
  'chart_add_indicator',
  `Adds an indicator. Overlays draw on the price pane; RSI, MACD, ATR, Stochastic, OBV and volume take their own pane under it. Three sub-panes and eight overlays are the maximum, and a request past that is refused with the reason rather than squeezed in. ${CHART_ANSWER}`,
  {
    type: z.string().describe('sma, ema, wma, vwap, bbands, donchian, volume, rsi, macd, atr, stoch, obv'),
    params: z.object({}).passthrough().optional().describe('for example {"period": 50}; defaults apply when omitted'),
  },
);
registerView('chart_remove_indicator', `Removes an indicator by its id or its type. ${CHART_ANSWER}`, {
  id: z.string().optional(),
  type: z.string().optional(),
});
registerView(
  'chart_level',
  `Draws a horizontal price line with a label, for a level worth watching. The label is shown to the human tagged [agent]. ${CHART_ANSWER}`,
  { price: z.number(), label: z.string().optional() },
);
registerView(
  'chart_mark',
  `Marks a moment in time on the chart with a label, for example when something was executed. The label is shown to the human tagged [agent]. ${CHART_ANSWER}`,
  { t: z.number().describe('unix timestamp in seconds'), label: z.string().optional() },
);
registerView(
  'chart_trendline',
  `Draws a sloped line through two points in time, for a trend, a channel edge or any support that is not flat. Each endpoint is a time and a price, so anchor them to the swing highs or lows the line is meant to touch; the line is drawn between them and extended onwards. Use chart_level instead when the line is horizontal. The label is shown to the human tagged [agent]. ${CHART_ANSWER}`,
  {
    t1: z.number().describe('unix timestamp in seconds of the first anchor'),
    p1: z.number().describe('price of the first anchor'),
    t2: z.number().describe('unix timestamp in seconds of the second anchor'),
    p2: z.number().describe('price of the second anchor'),
    label: z.string().optional(),
  },
);
registerView('chart_clear', `Clears what is on the chart. ${CHART_ANSWER}`, {
  what: z.enum(['indicators', 'levels', 'marks', 'trendlines', 'agent', 'all']).optional().default('agent'),
});

// ---------- the trading surface ----------
//
// Reads answer "what is my situation". Writes change what is drawn and what is pointed at,
// and nothing else. There is deliberately no tool here that closes a position, cancels an
// order, flattens or disarms: those are the human's controls on the window, reachable only
// from a route this door does not open onto. The capability is ABSENT rather than guarded,
// which is a stronger property than a check, because a check can be wrong.

const TRADE_ANSWER = 'Returns the trading surface as it now stands, so no follow-up read is needed.';

registerRead(
  'trade_read',
  [
    'The whole trading situation in one call: account health, every open position with how far it',
    'sits from liquidation, working orders including stops and targets, recent fills, and every armed',
    'mandate with how much of its approved bounds it has already spent.',
    '',
    'Liquidation distance comes in three units because only the third one answers the question.',
    'Twelve percent sounds far and is not, on something that moves eight percent a day. The ATR',
    'multiple is the number that means something.',
    '',
    'Unknown is reported as null and never as zero. On a unified account the venue reports an',
    'account value that is not the account\'s money, so the health figures derived from it come back',
    'null on purpose: a wrong risk number is worse than a missing one.',
    'Read-only, changes nothing.',
  ].join(' '),
  { symbol: z.string().optional().describe('limit to one market; omit for everything') },
);

registerRead(
  'trade_batch',
  [
    'Several trading reads in one round trip, the same shape as chart_batch.',
    'Each entry is { op, args, as }, and a later entry can use an earlier one with "$ref:<as>.<field>".',
    'One failing entry does not stop the rest.',
    '',
    'Ops: account, positions, orders, fills, mandates, market, venue_health.',
    'Read-only, changes nothing.',
  ].join(' '),
  {
    ops: z.array(
      z.object({
        op: z.string(),
        // Enumerated for the same reason chart_batch enumerates: tests/injection.test.ts walks
        // schema property names looking for somewhere an address could be smuggled, and it
        // cannot see inside a free-form record. Naming every key keeps the absence of an
        // address structural rather than merely true.
        args: z
          .object({
            symbol: z.string().optional(),
            coin: z.string().optional(),
            id: z.string().optional(),
            limit: z.number().int().optional(),
            sinceMs: z.number().optional(),
          })
          .optional(),
        as: z.string().optional(),
      }),
    ),
  },
);

registerView(
  'trade_focus',
  `Points the trading surface at one market. The chart follows. ${TRADE_ANSWER}`,
  { symbol: z.string() },
);

registerView(
  'trade_highlight',
  [
    'Points at one row on the human\'s screen and says why, in a note they read.',
    '',
    'This is the trend line generalised. A line you draw makes a PRICE addressable between you, the',
    'human and the bot; a highlight makes a ROW addressable. Saying "the ETH position is the one at',
    'risk" leaves a person hunting; highlighting it puts you both demonstrably on the same object.',
    '',
    'Highlights expire, because a pointer that outlives its reason still looks current.',
    TRADE_ANSWER,
  ].join(' '),
  {
    kind: z.enum(['position', 'order', 'fill', 'mandate', 'rule']),
    id: z.string().describe('the row id: a coin for a position, an oid for an order, a mandate id'),
    note: z.string().optional().describe('why this row, in one line the human reads'),
    ttlSec: z.number().optional().describe('how long it stays, default 300, maximum 3600'),
  },
);

registerView(
  'trade_overlay',
  `Turns one chart overlay on or off: the entry line, the liquidation, the mandate stop-out wall, working stops, targets, resting orders, or your own fills. ${TRADE_ANSWER}`,
  {
    name: z.enum(['position', 'liquidation', 'stops', 'targets', 'orders', 'fills', 'mandateWall']),
    on: z.boolean(),
  },
);

registerView(
  'trade_note',
  `Pins one line of your own reasoning to the trading surface, tagged [agent], where the human sees it beside their position. For the thesis, not for status. ${TRADE_ANSWER}`,
  { text: z.string().describe('one line, 240 characters at most') },
);

registerView('trade_clear', `Removes what you put on the trading surface. ${TRADE_ANSWER}`, {
  what: z.enum(['agent', 'highlights', 'note', 'all']).optional().default('agent'),
});

registerPropose(
  'propose_consolidate',
  'consolidate',
  `Proposes consolidating a stablecoin's scattered balances onto one chain. ${CANNOT_APPROVE}`,
  {
    toChain: CHAIN,
    symbol: z.string(),
    fromChains: z.array(CHAIN).optional(),
    maxTotalUsd: z.number().optional(),
  },
);
registerPropose('propose_policy_change', 'policy_change', `Proposes a change to the app's policy rules. ${CANNOT_APPROVE}`, {
  patch: z.object({}).passthrough(),
  sentence: z.string(),
});

// The four rail tools. Every one of them names chains, symbols and amounts and nothing
// else: the wallet the funds leave, the wallet they come back to, and the contract they
// pass through are all resolved by the app from its own config and its verified
// deployment tables. There is deliberately no argument on this surface that an agent
// could point at an address of its choosing.

registerPropose(
  'propose_swap',
  'swap',
  `Proposes swapping one token for another. venue uniswap-v3 swaps on a single chain through the verified router; venue oneclick swaps wallet funds across chains through NEAR Intents (mainnet only); venue intents-native swaps a balance already deposited inside intents.near, signing an intent instead of moving anything on chain, and needs propose_intents_deposit to have funded it first (mainnet only). Both sides stay in this app's own wallet. ${CANNOT_APPROVE}`,
  {
    venue: z.enum(['uniswap-v3', 'oneclick', 'intents-native']).optional().default('uniswap-v3'),
    chain: CHAIN,
    toChain: CHAIN.optional(),
    fromSymbol: z.string(),
    toSymbol: z.string(),
    amountIn: z.number(),
    minAmountOut: z.number(),
  },
);

registerPropose(
  'propose_hl_deposit',
  'hl_deposit',
  `Proposes depositing USDC into this app's own Hyperliquid account through the Bridge2 contract. The chain, the token and the bridge address come from a per-network table, not from this call. ${CANNOT_APPROVE}`,
  { amount: z.number() },
);

registerPropose(
  'propose_intents_deposit',
  'intents_deposit',
  `Proposes depositing funds from this app's own wallet into NEAR Intents, where they become a balance held by the intents.near verifier under this app's own account. This is the funding step for propose_swap with venue intents-native, which can then swap that balance without moving anything on chain. Leaving symbol out deposits the origin chain's gas asset, so on eth that is native ETH. The asset does not change: this is custody moving, not a swap. Who gets credited is resolved by the app from its own key and cannot be named here. Mainnet only. ${CANNOT_APPROVE}`,
  {
    chain: CHAIN,
    symbol: z.string().optional(),
    amount: z.number(),
  },
);

registerPropose(
  'propose_intents_withdraw',
  'intents_withdraw',
  `Proposes withdrawing a balance held inside NEAR Intents back out to one of this app's own wallets on a real chain. The reverse of propose_intents_deposit, and the way a balance swapped with venue intents-native gets out of the verifier. chain says where the money lands: eth, base, arb or sol. Leaving symbol out withdraws that chain's gas asset, so on sol that is native SOL. Which wallet on that chain is ours is read from this app's own config and cannot be named here. Mainnet only. ${CANNOT_APPROVE}`,
  {
    chain: CHAIN,
    symbol: z.string().optional(),
    amount: z.number(),
  },
);

registerPropose(
  'propose_mandate',
  'mandate_arm',
  [
    'Proposes ARMING A BOT on Hyperliquid perpetuals: a strategy program plus the envelope it must stay inside.',
    'This is the one proposal that grants standing authority rather than spending once, so it ALWAYS waits for a',
    'human click, on every network, even when the approval gate is disabled.',
    '',
    'The program is a closed grammar, not code. Conditions: price_above, price_below, price_cross_up,',
    'price_cross_down, bar_close, position, pnl_pct, elapsed, and, or, not. Actions: open, add, reduce, close,',
    'set_stop, set_target, cancel, stand_down, notify. A price reference can be a literal, or the id of something',
    'you drew with chart_batch ({kind:"drawing", id:"tl_1"}), which is what lets a trend line become a trigger.',
    '',
    'The approval screen shows the program in plain English and the worst case in dollars, so write rules a person',
    'can check against what you told them. There is no verb here that moves value off the venue.',
    CANNOT_APPROVE,
  ].join(' '),
  {
    symbol: z.string(),
    program: z.unknown(),
    maxNotionalUsd: z.number(),
    maxLeverage: z.number(),
    maxOrdersPerMin: z.number().int(),
    maxLossUsd: z.number(),
    expiresAt: z.string(),
    allowedActions: z.array(z.string()),
  },
);

registerPropose(
  'propose_lp_add',
  'lp_add',
  `Proposes supplying a Uniswap v3 pool with liquidity over a tick range, minting a new position or adding to the matching one this wallet already holds. ${CANNOT_APPROVE}`,
  {
    chain: CHAIN,
    token0Symbol: z.string(),
    token1Symbol: z.string(),
    amount0: z.number(),
    amount1: z.number(),
    feeTier: z.number().int(),
    tickLower: z.number().int(),
    tickUpper: z.number().int(),
  },
);

registerPropose(
  'propose_lp_remove',
  'lp_remove',
  `Proposes pulling a share of a liquidity position this wallet holds, collecting its fees in the same transaction. Call wallet first: only a positionId that already appears there can be pulled. ${CANNOT_APPROVE}`,
  {
    positionId: z.string(),
    liquidityPct: z.number(), // 0..1 of the position
  },
);

// Neither a read nor a propose: it mutates, but it moves no money and gets no policy
// verdict. What it does change is what a HUMAN sees before they decide, which is why
// the description says so plainly rather than calling itself cosmetic.
server.registerTool(
  'set_view_mode',
  {
    description:
      'Switches the app window between the detailed operator view (pro) and a simplified plain-English view written for someone non-technical (basic). This changes what the human sees before they approve anything, so it is refused while any proposal is waiting for a decision, and every switch is written to the audit log. It cannot approve, refuse or execute anything, and it moves no money.',
    inputSchema: { mode: z.enum(['basic', 'pro']) },
  },
  async (args) => proxy({ op: 'set_view_mode', mode: args.mode }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// The transport's own close is the earliest and most reliable of the three shutdown
// signals: it fires when the harness lets go of stdio, before any SIGTERM.
transport.onclose = () => {
  void sendBye().finally(() => process.exit(0));
};
wireShutdown();
void sendHello();
setInterval(sendHello, HELLO_MS);
