// Phosphor end to end proof. Boots a real app on a throwaway data dir, drives it through a
// real MCP client over stdio, and plays the human at the browser for every approval. Nothing
// here is mocked: the only thing this script fakes is the finger that clicks approve, and it
// can only do that because it holds the per-boot token that GET /api/session hands out.
//
// The claim under test is the product's whole pitch: the agent authors and proposes, the app
// enforces and executes, and no write happens without either a human click or a policy that
// explicitly said this size is fine. Run: node scripts/e2e.ts (exit 0 all green, 1 otherwise).

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

// The exact tool surface, sorted. An extra tool here is a new way for an agent to reach the
// money, so the set is part of the contract and this check is a set comparison, not a count.
const EXPECTED_TOOLS = [
  'balances',
  'candles',
  'composition',
  'log_tail',
  'policy_show',
  'proposal_status',
  'propose_consolidate',
  'propose_hl_deposit',
  'propose_lp_add',
  'propose_lp_remove',
  'propose_policy_change',
  'propose_swap',
  'wallet',
];

const DEMO_TOTAL_STABLE_USD = 49878.15;
const DEMO_ETH_USDT = 9200;
const NEW_CLICK_SENTENCE = 'Ask me before anything above $500.';

// ---------- checklist ----------

type Check = { label: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `   ${detail}` : ''}`);
  return ok;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// StdioClientTransport wants a Record<string,string>; process.env is not one.
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

// ---------- HTTP helpers (the browser half of the app) ----------

async function getJson(route: string): Promise<Json> {
  const res = await fetch(`${BASE}${route}`);
  return await res.json();
}

async function postJson(route: string, body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ---------- MCP helpers (the agent half of the app) ----------

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = (res.content ?? []).map(c => c.text ?? '').join('');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function holdingAmount(ledger: Json, chain: string, symbol: string): number {
  const found = (ledger.holdings as Json[]).find(h => h.chain === chain && h.symbol === symbol && !h.native);
  return found ? Number(found.amount) : 0;
}

// ---------- children ----------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-e2e-'));
const childEnv = { ...cleanEnv(), ACC_PORT: String(PORT), ACC_MODE: 'demo', ACC_DATA_DIR: dataDir, PHOSPHOR_APPROVAL_GATE: 'true' };

type AppProcess = ChildProcessByStdio<null, Readable, Readable>;

let app: AppProcess | null = null;
let client: Client | null = null;
let mcpPid: number | null = null;
const appOutput: string[] = [];

// Belt and braces: the finally block is the real cleanup, these handlers only cover a kill
// signal or an exit path that skips it. Both are safe to run twice. The MCP child needs
// killing by pid rather than by closing the transport, because a signal handler cannot await
// and because src/mcp.ts holds its own heartbeat interval open once its stdin is gone.
function hardKillChildren(): void {
  if (app !== null && app.exitCode === null) {
    try {
      app.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  if (mcpPid !== null) {
    try {
      process.kill(mcpPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
process.on('exit', hardKillChildren);
process.on('SIGINT', () => {
  hardKillChildren();
  process.exit(1);
});
process.on('SIGTERM', () => {
  hardKillChildren();
  process.exit(1);
});

function startApp(): void {
  const child: AppProcess = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => appOutput.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => appOutput.push(d.toString()));
  app = child;
}

async function waitForApp(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (app !== null && app.exitCode !== null) return false; // died on boot, stop waiting
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) {
        await res.json();
        return true;
      }
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  return false;
}

async function cleanup(): Promise<void> {
  if (client !== null) {
    try {
      await client.close(); // closes the stdio transport, which kills the src/mcp.ts child
    } catch {
      // transport already down
    }
    client = null;
  }
  if (mcpPid !== null) {
    try {
      process.kill(mcpPid, 'SIGKILL'); // no-op once close() got there first
    } catch {
      // already gone, which is the expected case
    }
    mcpPid = null;
  }
  if (app !== null && app.exitCode === null) {
    const exited = new Promise<void>(resolve => app?.once('exit', () => resolve()));
    app.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    if (app.exitCode === null) {
      app.kill('SIGKILL');
      await Promise.race([exited, sleep(1000)]);
    }
  }
}

// ---------- the run ----------

async function run(): Promise<void> {
  startApp();
  if (!check('app boots and serves GET /api/state', await waitForApp(20_000), `port ${PORT}, dataDir ${dataDir}`)) {
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    cwd: ROOT,
    env: childEnv,
  });
  client = new Client({ name: 'phosphor-e2e', version: '0.1.0' });
  await client.connect(transport);
  mcpPid = transport.pid;

  const names = (await client.listTools()).tools.map(t => t.name).sort();
  check(
    `MCP surface is exactly the ${EXPECTED_TOOLS.length} expected tools`,
    names.length === EXPECTED_TOOLS.length && names.join(',') === EXPECTED_TOOLS.join(','),
    names.join(', '),
  );

  // ---- reads ----

  const balances = await callTool(client, 'balances');
  check(
    `balances totals ${DEMO_TOTAL_STABLE_USD} (+- 1)`,
    Math.abs(Number(balances.totalStableUsd) - DEMO_TOTAL_STABLE_USD) <= 1,
    `totalStableUsd=${balances.totalStableUsd} holdings=${(balances.holdings as Json[]).length}`,
  );

  const composition = await callTool(client, 'composition');
  const top = (composition.rows as Json[])[0];
  check(
    'composition top row is Circle',
    top !== undefined && top.issuer === 'Circle',
    `${top?.issuer}/${top?.symbol}/${top?.chain} share=${(Number(top?.share) * 100).toFixed(2)}%`,
  );

  // ---- the stranded chain refusal is a feature, not a bug ----
  // Default fromChains sweeps every chain, which includes NEAR, and NEAR deliberately holds
  // 0.001 NEAR of gas in the demo fixture. The engine refuses the whole proposal rather than
  // quietly dropping the leg it cannot fund: a partial sweep the human did not ask for is a
  // worse answer than no sweep at all.
  const stranded = await callTool(client, 'propose_consolidate', { toChain: 'eth', symbol: 'USDT' });
  check(
    'default fromChains refuses the whole sweep on the stranded NEAR leg',
    stranded.status === 'policy_refused' && stranded.verdict?.rule === 'min_native_gas',
    `status=${stranded.status} rule=${stranded.verdict?.rule}`,
  );

  // ---- propose, approve, execute ----

  const proposal = await callTool(client, 'propose_consolidate', {
    toChain: 'eth',
    symbol: 'USDT',
    fromChains: ['arb', 'sol'],
  });
  const proposalId: string = proposal.id;
  check(
    'propose_consolidate arb+sol to eth lands pending with a simulation',
    proposal.status === 'pending' && proposal.verdict?.outcome === 'needs_approval' && proposal.simulation?.ok === true,
    `id=${proposalId} status=${proposal.status} verdict=${proposal.verdict?.outcome}`,
  );

  const before = await getJson('/api/state');
  const ethUsdtBefore = holdingAmount(before.ledger, 'eth', 'USDT');
  const pending = (before.proposals as Json[]).find(p => p.id === proposalId);
  check(
    'app state shows it pending and nothing has moved',
    pending?.status === 'pending' && Math.abs(ethUsdtBefore - DEMO_ETH_USDT) < 1e-9,
    `status=${pending?.status} eth USDT=${ethUsdtBefore}`,
  );

  const session = await getJson('/api/session');
  const token: string = session.token;
  check('GET /api/session mints a per-boot approval token', typeof token === 'string' && token.length >= 32, `${token.length} chars`);

  const approved = await postJson('/api/approve', { id: proposalId, token });
  check(
    'the human click executes the consolidation',
    approved.status === 200 && approved.json?.status === 'executed',
    `http ${approved.status} status=${approved.json?.status}`,
  );

  const after = await getJson('/api/state');
  const ethUsdtAfter = holdingAmount(after.ledger, 'eth', 'USDT');
  check(
    'eth USDT increased after execution',
    ethUsdtAfter > ethUsdtBefore,
    `${ethUsdtBefore} to ${ethUsdtAfter.toFixed(2)}`,
  );

  // The audit log is the product's memory. Order matters as much as content: an executed event
  // that does not sit downstream of a tool call, a proposal and an approval is an execution
  // nobody asked for.
  const log = (await callTool(client, 'log_tail', { limit: 500 })) as Json[];
  const oldestFirst = [...log].reverse();
  const at = (pred: (e: Json) => boolean): number => oldestFirst.findIndex(pred);
  const iTool = at(
    e =>
      e.type === 'tool_call' &&
      e.data?.op === 'propose' &&
      e.data?.kind === 'consolidate' &&
      Array.isArray(e.data?.params?.fromChains),
  );
  const iCreated = at(e => e.type === 'proposal_created' && e.data?.id === proposalId);
  const iApproved = at(e => e.type === 'approved' && e.data?.id === proposalId);
  const iExecuted = at(e => e.type === 'executed' && e.data?.id === proposalId);
  check(
    'audit reads tool_call -> proposal_created -> approved -> executed, in that order',
    iTool >= 0 && iTool < iCreated && iCreated < iApproved && iApproved < iExecuted,
    `indices ${iTool} < ${iCreated} < ${iApproved} < ${iExecuted}`,
  );

  // ---- the policy the agent writes, the human still signs ----

  const policyProposal = await callTool(client, 'propose_policy_change', {
    patch: { outbound: { humanClickAboveUsd: 500 } },
    sentence: NEW_CLICK_SENTENCE,
  });
  check(
    'propose_policy_change lands pending, never auto-applied',
    policyProposal.status === 'pending' && policyProposal.verdict?.outcome === 'needs_approval',
    `id=${policyProposal.id} status=${policyProposal.status}`,
  );

  const policyApproved = await postJson('/api/approve', { id: policyProposal.id, token });
  check(
    'the approved policy change is applied',
    policyApproved.status === 200 && policyApproved.json?.status === 'executed',
    `http ${policyApproved.status} status=${policyApproved.json?.status}`,
  );

  const shown = await callTool(client, 'policy_show');
  check(
    'policy_show carries the new sentence',
    Array.isArray(shown.sentences) && (shown.sentences as string[]).includes(NEW_CLICK_SENTENCE),
    `"${NEW_CLICK_SENTENCE}"`,
  );

  // ---- kill switch ----

  const killOn = await postJson('/api/kill', { on: true, token });
  check('kill switch on', killOn.status === 200 && killOn.json?.killSwitch === true, `http ${killOn.status}`);

  const whileKilled = await callTool(client, 'propose_consolidate', {
    toChain: 'eth',
    symbol: 'USDT',
    fromChains: ['arb', 'sol'],
  });
  check(
    'kill switch refuses every write',
    whileKilled.status === 'policy_refused' && whileKilled.verdict?.rule === 'kill_switch',
    `status=${whileKilled.status} rule=${whileKilled.verdict?.rule}`,
  );

  const killOff = await postJson('/api/kill', { on: false, token });
  check('kill switch off', killOff.status === 200 && killOff.json?.killSwitch === false, `http ${killOff.status}`);

  // ---- the approval surface refuses anything but the real token ----

  const forged = await postJson('/api/approve', { id: proposalId, token: 'not-the-approval-token' });
  check('POST /api/approve with a wrong token is 403', forged.status === 403, `http ${forged.status}`);

  const recent = (await callTool(client, 'log_tail', { limit: 50 })) as Json[];
  const rejection = recent.find(e => e.type === 'approve_attempt_rejected' && e.data?.reason === 'wrong approval token');
  check(
    'the forged approval is audited as approve_attempt_rejected',
    rejection !== undefined,
    rejection?.msg ?? 'no such event',
  );
}

// ---------- main ----------

try {
  await run();
} catch (err) {
  check('e2e ran without throwing', false, errText(err));
} finally {
  await cleanup();
}

const passed = checks.filter(c => c.ok).length;
const failed = checks.length - passed;

console.log('');
console.log('='.repeat(72));
console.log(`PHOSPHOR E2E: ${checks.length} checks, ${passed} passed, ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) {
  console.log('');
  console.log(`data dir kept for inspection: ${dataDir}`);
  if (appOutput.length > 0) {
    console.log('--- app output ---');
    console.log(appOutput.join('').trimEnd());
  }
} else {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
