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

const server = new McpServer({ name: 'phosphor', version: '0.1.0' });

function registerRead(name: string, description: string, shape: Record<string, z.ZodTypeAny>): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'read', tool: name, args }),
  );
}

function registerPropose(
  name: string,
  kind: 'consolidate' | 'policy_change',
  description: string,
  shape: Record<string, z.ZodTypeAny>,
): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'propose', kind, params: args }),
  );
}

const CANNOT_APPROVE =
  'Returns a proposal id and simulation result. Execution only ever happens after a human approves in the app window; this tool cannot approve.';

registerRead(
  'balances',
  'Returns current holdings across every configured chain, with per-chain staleness. Read-only, changes nothing.',
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
    toChain: z.enum(['eth', 'base', 'arb', 'sol', 'near']),
    symbol: z.string(),
    fromChains: z.array(z.enum(['eth', 'base', 'arb', 'sol', 'near'])).optional(),
    maxTotalUsd: z.number().optional(),
  },
);
registerPropose('propose_policy_change', 'policy_change', `Proposes a change to the app's policy rules. ${CANNOT_APPROVE}`, {
  patch: z.object({}).passthrough(),
  sentence: z.string(),
});

const transport = new StdioServerTransport();
await server.connect(transport);
void sendHello();
setInterval(sendHello, 15000);
