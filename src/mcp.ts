// PHOSPHOR MCP stdio server: a thin proxy. Every tool call becomes one POST to
// the control app's /api/mcp route on localhost. No state, no keys, no file
// writes, and no path that can approve, refuse, dismiss, or execute a proposal;
// that decision is a physical click a human makes in the app window.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function proxy(body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return textResult(NOT_RUNNING);
  }
  try {
    const json: unknown = await res.json();
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
      body: JSON.stringify({ op: 'hello', client: 'phosphor-mcp' }),
    });
  } catch {
    // app not reachable yet; the next heartbeat tries again in 15s
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
  | 'lp_add'
  | 'lp_remove';

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
  'Finds a market to chart. Takes anything a person would say ("btc", "bitcoin", "wif", "PEPE-USD") and returns the product id chart_set_view wants, plus near matches when the query is ambiguous. Every result can be charted on any timeframe from 1s to 1w. Read-only, changes nothing.',
  { query: z.string(), limit: z.number().int().optional() },
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
registerView('chart_clear', `Clears what is on the chart. ${CHART_ANSWER}`, {
  what: z.enum(['indicators', 'levels', 'marks', 'agent', 'all']).optional().default('agent'),
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
void sendHello();
setInterval(sendHello, 15000);
