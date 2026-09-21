// Criterion 2's check, printed as one table: how long the agent waits on the app, measured from
// where the agent sits (docs/superpowers/specs/2026-09-20-quality-definitions.md, term 2).
//
// Boots a demo backend on a free port with a scratch data dir, connects to it through the MCP
// door over stdio (src/mcp.ts, the same process an agent's client spawns, the way scripts/e2e.ts
// does), and times what comes back:
//
//   READS         20 calls each of wallet, proposals, policy_show and show, warm: one call per
//                 route runs first and is not counted (2.1: p95 under 300 ms). A read with a
//                 venue inside is allowed 2 s, and no demo read has one, so that budget is
//                 `npm run venue-latency`'s line to show, not this table's.
//   PROPOSES      5 propose_swap under the click threshold and 5 over it, dry because demo mode
//                 signs nothing and moves nothing (2.2: p95 under 3 s at the decision, under
//                 1.5 s when the row waits for a click). The TOOL ANSWER is what is timed, never
//                 the row: an answer that arrived after the row settled fails on its own line,
//                 because that is the 20 s hold the vault Gotchas record coming back.
//   STAGE CHANGE  from the row's lastChangeAt to the /api/events frame that carries its id, for
//                 every stage every row of this run entered (2.3: under 500 ms).
//   RESOURCES     `ps -o rss=,%cpu=` on the backend pid after the run, and the audit lines one
//                 proposal wrote over its whole life (2.5: RSS under 250 MB, at most 12 lines).
//
// Run: node scripts/latency-proof.ts. Exit 0 when every row passes, 1 otherwise.
// PHOSPHOR_DEMO_STAGE_SCALE scales the demo walk (default 0.2: a lifecycle takes about five
// seconds instead of twenty five). The scale changes how long a stage lasts, not how fast a
// change reaches the screen, which is the number measured.

import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The budgets, in ms, as term 2 fixes them.
export const READ_BUDGET_MS = 300;
export const PROPOSE_BUDGET_MS = 3000;
export const PROPOSE_CLICK_BUDGET_MS = 1500;
export const STAGE_BUDGET_MS = 500;
export const RSS_BUDGET_MB = 250;
export const AUDIT_LINES_BUDGET = 12;

const READS = 20;
const READ_TOOLS = ['wallet', 'proposals', 'policy_show', 'show'] as const;
// Distinct amounts, because the duplicate guard (src/http/propose.ts) refuses a repeat of a
// swap still in flight from the same session, and every one of these is in flight at once.
// Under the 100 USD default threshold: ten to fourteen dollars. Over it: 150 to 190.
const UNDER_USD = [10, 11, 12, 13, 14];
const OVER_USD = [150, 160, 170, 180, 190];
// The floor asked for, as a share of what the wallet read prices the swap at. Frozen rule 2:
// the floor comes off a read, never off a guess, and is truncated toward zero, never rounded.
const FLOOR_SHARE = 0.98;
const FLOOR_SIG = 6;

// ---------- the numbers, exported for tests/unit/latency-proof.test.ts ----------

// Nearest rank: the p-th percentile is the smallest sample at or above p percent of the set.
// The same rule tests/unit/runner-latency.test.ts and scripts/venue-latency.ts use, so the three
// tables read against each other.
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export type ProofRow = {
  route: string;
  samples: number[];
  budgetMs: number;
  // Anything that fails the row on its own, whatever the percentiles say: a call that errored,
  // a frame that never came, an answer that arrived after settlement.
  problems: string[];
};

export type RowStats = { route: string; n: number; p50: number; p95: number; max: number; budgetMs: number; pass: boolean };

export function rowStats(row: ProofRow): RowStats {
  const n = row.samples.length;
  const p95 = percentile(row.samples, 95);
  return {
    route: row.route,
    n,
    p50: percentile(row.samples, 50),
    p95,
    max: n === 0 ? Number.NaN : Math.max(...row.samples),
    budgetMs: row.budgetMs,
    pass: n > 0 && row.problems.length === 0 && p95 <= row.budgetMs,
  };
}

function ms(value: number): string {
  return Number.isNaN(value) ? '-' : value.toFixed(1);
}

/* One table: route, n, p50, p95, max, budget, PASS or FAIL. Fixed columns so three runs pasted
   under each other line up, and a problem printed under its row in the row's own words. */
export function renderTable(rows: ProofRow[]): string {
  const width = Math.max(30, ...rows.map((r) => r.route.length));
  const head = `${'route'.padEnd(width)}  ${'n'.padStart(3)}  ${'p50'.padStart(8)}  ${'p95'.padStart(8)}  ${'max'.padStart(8)}  ${'budget'.padStart(8)}  result`;
  const lines = [head, '-'.repeat(head.length)];
  for (const row of rows) {
    const s = rowStats(row);
    lines.push(
      `${s.route.padEnd(width)}  ${String(s.n).padStart(3)}  ${ms(s.p50).padStart(8)}  ${ms(s.p95).padStart(8)}  ${ms(s.max).padStart(8)}  ${`${s.budgetMs} ms`.padStart(8)}  ${s.pass ? 'PASS' : 'FAIL'}`,
    );
    for (const problem of row.problems) lines.push(`${''.padEnd(width)}  ${problem}`);
  }
  return lines.join('\n');
}

// The last line. Names every failing row so the reader never has to scan the table for it.
export function verdictLine(rows: ProofRow[], extra: { label: string; pass: boolean }[] = []): string {
  const failing = [...rows.filter((r) => !rowStats(r).pass).map((r) => r.route), ...extra.filter((e) => !e.pass).map((e) => e.label)];
  return failing.length === 0 ? 'LATENCY PROOF: PASS' : `LATENCY PROOF: FAIL: ${failing.join(', ')}`;
}

// Truncated toward zero to `sig` significant figures. Never rounded: a floor printed above the
// quote it came from is the bug commit 42f5809 fixed on the card, and this is the same rule
// applied before the number leaves the caller.
export function truncatedFloor(amount: number, sig = FLOOR_SIG): number {
  if (!(amount > 0)) return 0;
  const scale = 10 ** (sig - 1 - Math.floor(Math.log10(amount)));
  return Math.floor(amount * scale) / scale;
}

// ---------- helpers ----------

function sleep(msToWait: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msToWait));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/* The backend's environment. The shell's own PHOSPHOR_* and ACC_* settings are dropped first,
   because src/config.ts reads PHOSPHOR_PORT before ACC_PORT: a PHOSPHOR_PORT left over from
   another worktree would win over the port chosen here and this run would talk to somebody
   else's app. Only the PHOSPHOR_* names go back in, the ones config.ts and src/mcp.ts read first. */
function childEnv(port: number, dataDir: string, stageScale: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('PHOSPHOR_') || key.startsWith('ACC_')) continue;
    out[key] = value;
  }
  out.PHOSPHOR_PORT = String(port);
  out.PHOSPHOR_MODE = 'demo';
  out.PHOSPHOR_DATA_DIR = dataDir;
  out.PHOSPHOR_DEMO_STAGE_SCALE = stageScale;
  return out;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

// Every call made, counted so the audit log can be read back against it at the end: a proxy
// that answered from anywhere but the app would make every number above meaningless, and the
// app writes one tool_call line per op it dispatched (src/http/mcp.ts).
let callsMade = 0;

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  callsMade += 1;
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = (res.content ?? []).map((c) => c.text ?? '').join('');
  let parsed: Json = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // a sentence, not an object: kept as is so a problem line can quote it
  }
  if (res.isError === true) throw new Error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 200));
  return parsed;
}

// ---------- the SSE watcher ----------

type Frame = { id: string; at: number };

/* Reads /api/events for the life of the run and keeps the arrival time of every frame that
   names a proposal. The frame carries the id and nothing else (src/http/sse.ts, broadcastProposal),
   so what is measured is exactly what a window gets: the signal to refetch that row. */
async function watchEvents(base: string, frames: Frame[], control: AbortController): Promise<void> {
  const res = await fetch(`${base}/api/events`, { signal: control.signal });
  if (!res.ok || res.body === null) throw new Error(`/api/events answered ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const at = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(line.slice(6)) as { type?: unknown; id?: unknown };
              if (payload.type === 'proposal' && typeof payload.id === 'string') frames.push({ id: payload.id, at });
            } catch {
              // not JSON: not one of ours
            }
          }
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // the stream closes with the run, and that is the one way out of this loop
    }
  })();
}

// ---------- the run ----------

type Row = { id: string; status: string; settledAt?: string; stageAt?: Record<string, string>; lastChangeAt?: string; result?: { detail?: string } };

async function proposalRows(base: string): Promise<Row[]> {
  const res = await fetch(`${base}/api/proposals?limit=50`);
  const body = (await res.json()) as { proposals?: Row[] };
  return body.proposals ?? [];
}

// The endings a walk can reach. needs_reconciliation is not one: a demo row wears it while it
// is settling (the credit read that closes it comes a beat later), so a wait that stopped on it
// would read every row as stuck one second before it confirmed.
const DONE = new Set(['executed', 'failed', 'refused']);

async function main(): Promise<number> {
  const stageScale = process.env.PHOSPHOR_DEMO_STAGE_SCALE ?? '0.2';
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-latency-'));
  const env = childEnv(port, dataDir, stageScale);
  const appOutput: string[] = [];

  // Standing in for the Tauri shell: the window token goes down stdin as the first line and is
  // held nowhere else. No route here needs it; it exists so the backend boots the way it ships.
  const app: ChildProcessByStdio<Writable, Readable, Readable> = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  app.stdin.write(`${crypto.randomBytes(32).toString('hex')}\n`);
  app.stdin.end();
  app.stdout.on('data', (chunk: Buffer) => appOutput.push(chunk.toString()));
  app.stderr.on('data', (chunk: Buffer) => appOutput.push(chunk.toString()));

  let client: Client | null = null;
  let mcpPid: number | null = null;
  const events = new AbortController();

  const cleanup = async (): Promise<void> => {
    events.abort();
    if (client !== null) {
      try {
        await client.close();
      } catch {
        // transport already down
      }
      client = null;
    }
    if (mcpPid !== null) {
      try {
        process.kill(mcpPid, 'SIGKILL');
      } catch {
        // already gone, the expected case
      }
      mcpPid = null;
    }
    if (app.exitCode === null) {
      const exited = new Promise<void>((resolve) => app.once('exit', () => resolve()));
      app.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (app.exitCode === null) app.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  const hardKill = (): void => {
    if (mcpPid !== null) {
      try {
        process.kill(mcpPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    if (app.exitCode === null) app.kill('SIGKILL');
  };
  process.on('SIGINT', () => {
    hardKill();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    hardKill();
    process.exit(1);
  });

  try {
    const until = Date.now() + 20_000;
    let up = false;
    while (Date.now() < until && app.exitCode === null) {
      try {
        const res = await fetch(`${base}/api/state`);
        if (res.ok) {
          await res.json();
          up = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    if (!up) {
      console.log(`the demo backend did not boot on ${base}:\n${appOutput.join('').slice(-800)}`);
      return 1;
    }
    console.log(`demo backend pid ${app.pid} on ${base}, data dir ${dataDir}, stage scale ${stageScale}`);

    // The watcher opens before the first proposal exists, so a row's very first frame is caught.
    const frames: Frame[] = [];
    await watchEvents(base, frames, events);

    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp.ts')], cwd: ROOT, env });
    client = new Client({ name: 'phosphor-latency-proof', version: '0.1.0' });
    await client.connect(transport);
    mcpPid = transport.pid;

    // The wallet read that prices the floors. It is also the warm-up for the proxy's first hop.
    const wallet = await callTool(client, 'wallet');
    const priceOf = (symbol: string): number => {
      const row = ((wallet.rows ?? []) as Json[]).find((r) => r.symbol === symbol && r.kind === 'intents');
      if (row === undefined || !(Number(row.priceUsd) > 0)) throw new Error(`the wallet read carries no price for ${symbol}`);
      return Number(row.priceUsd);
    };
    const floorFor = (amountIn: number): number => truncatedFloor((amountIn * priceOf('USDC')) / priceOf('ETH') * FLOOR_SHARE);

    // ---- proposes over the threshold: the row waits for a click, and the answer says so ----
    const over: ProofRow = { route: 'propose_swap over threshold (click)', samples: [], budgetMs: PROPOSE_CLICK_BUDGET_MS, problems: [] };
    const overIds: string[] = [];
    for (const usd of OVER_USD) {
      try {
        const { ms: took, value } = await timed(() =>
          callTool(client as Client, 'propose_swap', { chain: 'eth', toChain: 'eth', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: usd, minAmountOut: floorFor(usd) }),
        );
        over.samples.push(took);
        if (typeof value?.id !== 'string') over.problems.push(`${usd} USDC: no proposal id in the answer: ${JSON.stringify(value).slice(0, 160)}`);
        else {
          overIds.push(value.id);
          if (value.status !== 'pending') over.problems.push(`${usd} USDC: answered ${value.status}, expected pending (a click)`);
        }
      } catch (err) {
        over.problems.push(`${usd} USDC: ${errText(err)}`);
      }
    }

    // ---- the reads, warm: one uncounted call, then twenty ----
    const reads: ProofRow[] = [];
    for (const tool of READ_TOOLS) {
      const args: Record<string, unknown> = tool === 'show' ? { kind: 'proposal', id: overIds[0] ?? 'none' } : {};
      const row: ProofRow = { route: tool === 'show' ? 'show (proposal)' : tool, samples: [], budgetMs: READ_BUDGET_MS, problems: [] };
      try {
        await callTool(client, tool, args);
        for (let i = 0; i < READS; i += 1) row.samples.push((await timed(() => callTool(client as Client, tool, args))).ms);
      } catch (err) {
        row.problems.push(`after ${row.samples.length} of ${READS}: ${errText(err)}`);
      }
      reads.push(row);
    }

    // ---- proposes under the threshold: the policy decides, the rail walks, the answer is timed ----
    const under: ProofRow = { route: 'propose_swap under threshold', samples: [], budgetMs: PROPOSE_BUDGET_MS, problems: [] };
    const underIds: string[] = [];
    const answeredAt = new Map<string, number>();
    for (const usd of UNDER_USD) {
      try {
        const { ms: took, value } = await timed(() =>
          callTool(client as Client, 'propose_swap', { chain: 'eth', toChain: 'eth', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: usd, minAmountOut: floorFor(usd) }),
        );
        under.samples.push(took);
        if (typeof value?.id !== 'string') under.problems.push(`${usd} USDC: no proposal id in the answer: ${JSON.stringify(value).slice(0, 160)}`);
        else {
          underIds.push(value.id);
          answeredAt.set(value.id, Date.now());
          if (value.status === 'executed') under.problems.push(`${usd} USDC: answered executed, after settlement`);
          else if (value.status !== 'executing' && value.status !== 'approved') under.problems.push(`${usd} USDC: answered ${value.status}, expected executing`);
        }
      } catch (err) {
        under.problems.push(`${usd} USDC: ${errText(err)}`);
      }
    }

    // ---- wait for every walk to end ----
    const walkUntil = Date.now() + 30_000 + 30_000 * Number(stageScale);
    let done: Row[] = [];
    while (Date.now() < walkUntil) {
      const all = await proposalRows(base);
      done = all.filter((r) => underIds.includes(r.id) && DONE.has(r.status));
      if (done.length === underIds.length) break;
      await sleep(250);
    }
    const all = await proposalRows(base);
    const mine = all.filter((r) => underIds.includes(r.id) || overIds.includes(r.id));
    for (const id of underIds) {
      const row = mine.find((r) => r.id === id);
      if (row === undefined) under.problems.push(`${id}: not in /api/proposals after the walk`);
      else if (!DONE.has(row.status)) under.problems.push(`${id}: still ${row.status} after the wait: ${row.result?.detail ?? 'no detail on the row'}`);
      else if (row.status !== 'executed') under.problems.push(`${id}: ended ${row.status}, not executed: ${row.result?.detail ?? 'no detail on the row'}`);
    }

    // The answer came before settlement, or the hold is back. settledAt is the rail's return;
    // the confirmed stamp is the balance read that closed it. Either one after the answer is fine.
    let leads: number[] = [];
    for (const id of underIds) {
      const row = mine.find((r) => r.id === id);
      const settled = row?.settledAt ?? row?.stageAt?.confirmed;
      const answered = answeredAt.get(id);
      if (row === undefined || answered === undefined) continue;
      if (settled === undefined) {
        under.problems.push(`${id}: never settled, so the answer cannot be placed against settlement`);
        continue;
      }
      const lead = Date.parse(settled) - answered;
      leads.push(lead);
      if (lead <= 0) under.problems.push(`${id}: answered ${(-lead / 1000).toFixed(1)} s after settlement`);
    }
    leads = leads.sort((a, b) => a - b);

    // ---- stage change to screen: every stage every row entered, against the frames ----
    const stage: ProofRow = { route: 'stage change to SSE frame', samples: [], budgetMs: STAGE_BUDGET_MS, problems: [] };
    for (const row of mine) {
      const entries = Object.entries(row.stageAt ?? {});
      if (entries.length === 0) {
        stage.problems.push(`${row.id}: no stageAt on the row`);
        continue;
      }
      for (const [word, iso] of entries) {
        const at = Date.parse(iso);
        const frame = frames.filter((f) => f.id === row.id && f.at >= at).sort((a, b) => a.at - b.at)[0];
        if (frame === undefined) stage.problems.push(`${row.id}: no frame after ${word} at ${iso}`);
        else stage.samples.push(frame.at - at);
      }
    }
    const rows: ProofRow[] = [...reads, over, under, stage];

    // ---- resources: the backend a few seconds after the last write, and one lifecycle's log ----
    await sleep(3000);
    let rssMb = Number.NaN;
    let cpu = '-';
    try {
      const out = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(app.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      rssMb = Number(out[0]) / 1024;
      cpu = out[1] ?? '-';
    } catch (err) {
      cpu = `ps failed: ${errText(err)}`;
    }
    const auditLines = fs.existsSync(path.join(dataDir, 'audit.jsonl')) ? fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n') : [];
    const callsAudited = auditLines.filter((line) => line.includes('"type":"tool_call"')).length;
    const perLifecycle = underIds.map((id) => ({ id, lines: auditLines.filter((line) => line.includes(id)).length }));
    const worst = Math.max(0, ...perLifecycle.map((p) => p.lines));
    const rssPass = rssMb <= RSS_BUDGET_MB;
    const auditPass = perLifecycle.length > 0 && worst <= AUDIT_LINES_BUDGET;

    console.log('');
    console.log(renderTable(rows));
    console.log('');
    if (leads.length > 0) {
      console.log(`propose_swap under threshold: ${leads.filter((l) => l > 0).length} of ${leads.length} answered before settlement, the closest by ${((leads[0] as number) / 1000).toFixed(1)} s`);
    }
    console.log(`reads: demo backend, no venue inside any read; the 2 s venue budget (2.1) is npm run venue-latency's line`);
    console.log(`tool calls audited by the app: ${callsAudited} of ${callsMade} made ${callsAudited === callsMade ? 'PASS' : 'FAIL'}`);
    console.log(
      `resources: pid ${app.pid}, rss ${rssMb.toFixed(1)} MB (budget ${RSS_BUDGET_MB}) ${rssPass ? 'PASS' : 'FAIL'}, ` +
        `cpu ${cpu}% (ps, a decaying minute average taken 3 s after the run, not the hour-long idle read)`,
    );
    console.log(
      `audit lines per proposal lifecycle: max ${worst} (budget ${AUDIT_LINES_BUDGET}) ${auditPass ? 'PASS' : 'FAIL'}   ` +
        perLifecycle.map((p) => `${p.id}: ${p.lines}`).join(', '),
    );
    const verdict = verdictLine(rows, [
      { label: 'tool calls audited', pass: callsAudited === callsMade },
      { label: 'rss', pass: rssPass },
      { label: 'audit lines per lifecycle', pass: auditPass },
    ]);
    console.log(verdict);
    return verdict.endsWith('PASS') ? 0 : 1;
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(errText(err));
      process.exit(1);
    },
  );
}
