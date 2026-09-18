// Phosphor agent evals. The scenarios in EVAL_SPEC Part B, run against a real app.
//
// This is scripts/e2e.ts's harness with a scenario loop on top: a real app on a throwaway data
// dir, a real MCP server, the window token minted here and held here, and the finger that clicks
// approve. What e2e proves once, this proves 28 times against a named expectation.
//
// Two modes, one grader.
//   scripted (default, `npm run eval`): tests/eval/agent.ts stands in for the `claude` binary.
//     The turn's text and tool calls come from the scenario file; the calls themselves go to the
//     real server through the real driver. No model tokens, so it runs in CI.
//   live (`npm run eval:live`): src/driver.ts spawns the real agent under
//     operator/driver.settings.json, each scenario's userSays is fed as a turn, and the harness
//     plays the human at the window. Costs tokens. Never in CI.
//
// The app under test is staged: the repo is copied to a temp directory so each scenario can write
// its own data/demo-state.json (the demo ledger reads that path relative to its own file, so a
// scenario's balances cannot be set any other way). Nothing here touches ~/.phosphor, the real
// keystore, or the installed app's ports.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDriver, type DriverEvent } from '../src/driver.ts';
import { hashLine } from '../src/audit.ts';
import { EXPECTED_TOOLS_SORTED } from '../tests/tool-surface.ts';
import { loadScenarios, type Scenario } from '../tests/eval/schema.ts';
import { gradeScenario, type Card, type Frame, type Run, type StatusRead, type Verdict } from '../tests/eval/grade.ts';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCENARIO_DIR = path.join(ROOT, 'tests', 'eval');
const PREFIX = 'mcp__phosphor__';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const VERBOSE = args.includes('--verbose');
const ONLY = (() => {
  const at = args.indexOf('--only');
  return at === -1 ? [] : (args[at + 1] ?? '').split(',').filter(Boolean);
})();

// ---------- small helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') out[key] = value;
  return out;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A port nobody else is on. Every worktree of this repo can be running its own app, and the
// installed app is on one of these too, so a fixed number is a collision waiting to happen.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ---------- the staged repo ----------

// Everything the app reads at run time, minus node_modules (symlinked) and config.local.json
// (a developer's own machine, and none of its business here).
const STAGE_COPY = ['src', 'tests', 'scripts', 'operator', 'data', 'skills', 'ui', 'package.json', 'tsconfig.json', 'config.json'];

function stageRepo(): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-eval-stage-'));
  for (const entry of STAGE_COPY) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(stage, entry), { recursive: true, dereference: false });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'));
  fs.chmodSync(path.join(stage, 'tests', 'eval', 'agent.ts'), 0o755);
  return stage;
}

// ---------- the preconditions ----------

const DEFAULT_DEMO = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo-state.json'), 'utf8')) as Json;

function writeDemoState(stage: string, scenario: Scenario): void {
  const demo = { ...DEFAULT_DEMO, ...(scenario.pre.demo ?? {}) };
  fs.writeFileSync(path.join(stage, 'data', 'demo-state.json'), `${JSON.stringify(demo, null, 2)}\n`);
}

// `agoSec` anywhere in a seeded row becomes a real stamp, so "40 seconds elapsed" is true at the
// second the scenario runs rather than at the second somebody wrote the fixture.
function resolveStamps(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveStamps(item, now));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (typeof inner === 'object' && inner !== null && typeof (inner as Json).agoSec === 'number') {
      out[key] = new Date(now - (inner as Json).agoSec * 1000).toISOString();
      continue;
    }
    out[key] = resolveStamps(inner, now);
  }
  return out;
}

function seedDataDir(dataDir: string, scenario: Scenario): void {
  const now = Date.now();
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = (scenario.pre.proposals ?? []).map((row) => resolveStamps(row, now));
  if (rows.length > 0) {
    fs.writeFileSync(path.join(dataDir, 'proposals.json'), `${JSON.stringify(rows, null, 2)}\n`);
  }
  if (scenario.pre.policy !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(scenario.pre.policy, null, 2)}\n`);
  }
  const lines = scenario.pre.audit ?? [];
  if (lines.length > 0) {
    // The chain link is computed here rather than left null: a seeded log the app reports as
    // broken is a fixture bug that reads as a product bug.
    let prev: string | null = null;
    const out: string[] = [];
    for (const line of lines) {
      const event = {
        ts: new Date(now - (line.agoSec ?? 0) * 1000).toISOString(),
        type: line.type,
        msg: line.msg,
        data: line.data ?? null,
        prev,
      };
      const text = JSON.stringify(event);
      out.push(text);
      prev = hashLine(text);
    }
    fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), `${out.join('\n')}\n`);
  }
}

// ---------- one app ----------

type AppProcess = ChildProcessByStdio<Writable, Readable, Readable>;

type App = {
  port: number;
  base: string;
  token: string;
  dataDir: string;
  output: string[];
  stop(): Promise<void>;
};

async function bootApp(stage: string, scenario: Scenario): Promise<App> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-eval-data-'));
  seedDataDir(dataDir, scenario);
  writeDemoState(stage, scenario);

  const token = crypto.randomBytes(32).toString('hex');
  const output: string[] = [];
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: stage,
    env: { ...cleanEnv(), ACC_PORT: String(port), ACC_MODE: 'demo', ACC_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as AppProcess;
  child.stdin.write(`${token}\n`);
  child.stdin.end();
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const until = Date.now() + 20_000;
  let up = false;
  while (Date.now() < until) {
    if (child.exitCode !== null) break;
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

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  if (!up) {
    await stop();
    throw new Error(`the app did not boot on ${base}: ${output.join('').slice(-600)}`);
  }
  return { port, base, token, dataDir, output, stop };
}

// ---------- the window half ----------

// Every SSE frame, and the proposal rows /api/state carried when it arrived. The frame is the
// signal and the state is the truth, which is the shape src/http/sse.ts fixed on purpose, so a
// window check that read only frames would be reading half of it.
async function watchWindow(app: App, frames: Frame[], stop: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${app.base}/api/events`, { signal: stop });
  } catch {
    return;
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let payload: Json;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        const at = Date.now();
        let proposals: Json[] = [];
        try {
          const state = (await (await fetch(`${app.base}/api/state`)).json()) as Json;
          proposals = (state.proposals as Json[]) ?? [];
        } catch {
          // The app is going down, which is not a window failure.
        }
        frames.push({ at, type: String(payload.type ?? ''), payload, proposals });
      }
    }
  } catch {
    // aborted at the end of the scenario
  }
}

// ---------- one scenario ----------

type Result = {
  scenario: Scenario;
  status: 'pass' | 'fail' | 'xfail' | 'error';
  verdict: Verdict | null;
  missing: string[];
  detail: string;
};

function bare(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

async function runScenario(stage: string, scenario: Scenario, available: Set<string>): Promise<Result> {
  const missing = (scenario.needsTools ?? []).filter((tool) => !available.has(tool));
  const app = await bootApp(stage, scenario);
  fs.writeFileSync(path.join(stage, '.eval-scenario.json'), JSON.stringify(scenario));

  const frames: Frame[] = [];
  const controller = new AbortController();
  const window = watchWindow(app, frames, controller.signal);

  const trace: Run['trace'] = [];
  const cards: Card[] = [];
  const texts: Run['texts'] = [];
  const statusReads: StatusRead[] = [];
  const errors: string[] = [];
  let ended = false;
  let clicked = false;

  const driver = createDriver({
    repo: stage,
    port: app.port,
    // Scripted mode points the driver at the replay agent. Live mode leaves it unset, which is
    // how the real binary gets found, and is the only difference between the two runs.
    claudeBin: LIVE ? undefined : path.join(stage, 'tests', 'eval', 'agent.ts'),
    onEvent: (event: DriverEvent) => {
      const at = Date.now();
      if (event.kind === 'tool') trace.push({ at, name: bare(event.name), args: event.input });
      if (event.kind === 'text') texts.push({ at, text: event.text });
      if (event.kind === 'error') errors.push(event.message);
      if (event.kind === 'status' && event.state === 'failed') errors.push(event.detail ?? 'driver failed');
      if (event.kind === 'turn_end') ended = true;
      if (event.kind === 'tool_data') {
        const name = bare(event.name);
        cards.push({ at, name, data: event.data });
        if (name === 'proposal_status') statusReads.push({ at, data: event.data });
        // The finger. It clicks once, on the first pending proposal a propose call created, and
        // only where the scenario says the user said yes. Everything else about approval is the
        // app's: the token never leaves this process and no route serves it.
        const row = event.data as Json;
        if (
          scenario.pre.humanClicks === true &&
          !clicked &&
          name.startsWith('propose_') &&
          typeof row?.id === 'string' &&
          row?.status === 'pending'
        ) {
          clicked = true;
          void fetch(`${app.base}/api/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: app.base },
            body: JSON.stringify({ id: row.id, token: app.token }),
          }).catch(() => undefined);
        }
      }
    },
  });

  let detail = '';
  try {
    driver.start();
    await sleep(250);
    driver.send(scenario.userSays);
    const until = Date.now() + (LIVE ? 240_000 : 60_000);
    while (!ended && errors.length === 0 && Date.now() < until) await sleep(100);
    if (!ended && errors.length === 0) detail = 'the turn did not end inside its budget';
    // The last SSE frame trails the last tool call, so the window is given a moment to say so.
    await sleep(400);
  } catch (error) {
    detail = errText(error);
  } finally {
    driver.stop();
    controller.abort();
    await window.catch(() => undefined);
    await app.stop();
  }

  const run: Run = { trace, texts, cards, frames, statusReads, mode: LIVE ? 'live' : 'scripted' };
  const verdict = gradeScenario(scenario, run);
  if (errors.length > 0 && detail === '') detail = errors[0].slice(0, 200);
  // A harness failure is not a scenario failure and must never read as one: the driver dying is
  // reported as its own error rather than as a trace the agent did not make.
  if (detail !== '') return { scenario, status: 'error', verdict, missing, detail };

  const status: Result['status'] = verdict.ok ? 'pass' : missing.length > 0 ? 'xfail' : 'fail';
  return { scenario, status, verdict, missing, detail };
}

// ---------- the surface probe ----------

// One boot before the loop, to read the live tool list. Two things come out of it: the surface
// check e2e and tests/injection.test.ts already make, from the same list in tests/tool-surface.ts,
// and the set every scenario's `needsTools` is answered against.
async function probeTools(stage: string): Promise<Set<string>> {
  const scenario = { id: 'probe', pre: {} } as unknown as Scenario;
  const app = await bootApp(stage, scenario);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(stage, 'src', 'mcp.ts')],
    cwd: stage,
    env: { ...cleanEnv(), ACC_PORT: String(app.port), ACC_MODE: 'demo', ACC_DATA_DIR: app.dataDir },
  });
  const client = new Client({ name: 'phosphor-eval-probe', version: '0.1.0' });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.close();
  try {
    if (transport.pid !== null && transport.pid !== undefined) process.kill(transport.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await app.stop();

  const expected = [...EXPECTED_TOOLS_SORTED];
  const extra = names.filter((name) => !expected.includes(name));
  if (extra.length > 0) {
    console.log(`[FAIL] the MCP surface carries ${extra.length} tool(s) tests/tool-surface.ts does not: ${extra.join(', ')}`);
    process.exit(1);
  }
  const absent = expected.filter((name) => !names.includes(name));
  if (absent.length > 0) console.log(`note: tests/tool-surface.ts names ${absent.length} tool(s) the server does not serve yet: ${absent.join(', ')}`);
  return new Set(names);
}

// ---------- the run ----------

const scenarios = loadScenarios(SCENARIO_DIR, ONLY);
if (scenarios.length === 0) {
  console.log('no scenarios matched');
  process.exit(1);
}

const stage = stageRepo();
console.log(`PHOSPHOR EVAL: ${scenarios.length} scenario(s), ${LIVE ? 'live' : 'scripted'} mode`);
console.log(`staged repo ${stage}`);
console.log('');

const results: Result[] = [];
let available = new Set<string>();
try {
  available = await probeTools(stage);
  for (const scenario of scenarios) {
    let result: Result;
    try {
      result = await runScenario(stage, scenario, available);
    } catch (error) {
      result = { scenario, status: 'error', verdict: null, missing: [], detail: errText(error) };
    }
    results.push(result);
    const mark = { pass: '[PASS]', fail: '[FAIL]', xfail: '[XFAIL]', error: '[ERROR]' }[result.status];
    const v = result.verdict;
    const checks = v === null ? '' : ` trace:${v.trace.ok ? 'ok' : 'no'} reply:${v.reply.ok ? 'ok' : 'no'} window:${v.window.skipped ? 'skip' : v.window.ok ? 'ok' : 'no'}`;
    const first = result.detail !== '' ? result.detail : (v?.first ?? '');
    console.log(`${mark} ${result.scenario.id} ${result.scenario.title}${checks}${first ? `   ${first}` : ''}`);
    if (VERBOSE && result.verdict !== null) console.log(`        trace: ${result.verdict.calls.join(', ')}`);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

// ---------- the table ----------

const counts = {
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  xfail: results.filter((r) => r.status === 'xfail').length,
  error: results.filter((r) => r.status === 'error').length,
};

console.log('');
console.log('='.repeat(96));
console.log(`${'id'.padEnd(5)}${'mode'.padEnd(10)}${'result'.padEnd(8)}${'failing check'.padEnd(16)}first failing assertion`);
console.log('-'.repeat(96));
for (const result of results) {
  const v = result.verdict;
  const failing =
    result.status === 'error' || v === null
      ? 'harness'
      : !v.trace.ok
        ? 'trace'
        : !v.reply.ok
          ? 'reply'
          : !v.window.ok && v.window.skipped !== true
            ? 'window'
            : '';
  const note = result.status === 'xfail' ? `waiting on ${result.missing.join(', ')}` : (v?.first ?? result.detail);
  console.log(
    `${result.scenario.id.padEnd(5)}${(LIVE ? 'live' : 'scripted').padEnd(10)}${result.status.padEnd(8)}${failing.padEnd(16)}${note.slice(0, 44)}`,
  );
}
console.log('='.repeat(96));
console.log(
  `${results.length} scenarios: ${counts.pass} pass, ${counts.fail} fail, ${counts.xfail} xfail, ${counts.error} error`,
);

process.exit(counts.fail + counts.error > 0 ? 1 : 0);
