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

const server = new McpServer({ name: 'phosphor', version: '0.2.0' });

function registerRead(name: string, description: string, shape: Record<string, z.ZodTypeAny>): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'read', tool: name, args }),
  );
}

type ProposeKind = 'consolidate' | 'policy_change' | 'swap' | 'hl_deposit' | 'lp_add' | 'lp_remove';

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

const CANNOT_APPROVE =
  'Returns a proposal id and simulation result. Execution only ever happens after a human approves in the app window; this tool cannot approve.';

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
  `Proposes swapping one token for another. venue uniswap-v3 swaps on a single chain through the verified router; venue oneclick swaps across chains through NEAR Intents (mainnet only). Both sides stay in this app's own wallet. ${CANNOT_APPROVE}`,
  {
    venue: z.enum(['uniswap-v3', 'oneclick']).optional().default('uniswap-v3'),
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

const transport = new StdioServerTransport();
await server.connect(transport);
void sendHello();
setInterval(sendHello, 15000);
