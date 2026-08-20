// Where the seconds go. A measuring instrument for the in-app driver, not a fix for it.
//
// The complaint this exists to answer is "chart analysis and changing charts take too long for a
// live demo". That is a claim about wall time, and wall time in this design is spent in four
// separate places that look identical from the window: process boot and MCP attach, the model's
// own thinking, the number of model round trips a prompt costs, and the bytes each tool result
// puts back into the context for the next round trip. A stopwatch on the whole turn cannot tell
// those apart, so this script instruments the raw stream-json events and reports each one.
//
// SAFETY, and this is the whole reason the script is longer than a stopwatch. Karim's real app
// runs on the default port against mainnet with real funds. Every measurement here stands up its
// OWN app instance: a scratch PHOSPHOR_CONFIG_DIR, its own data directory, its own keys path, a
// free high port, and testnet. Nothing in this file may address port 4177, and nothing here calls
// a propose tool. Chart tools move no money but they DO mutate window state, which is exactly why
// the throwaway instance is not optional.
//
// It spawns the claude child itself rather than driving createDriver, because DriverEvent
// deliberately throws away everything being measured here: it drops thinking blocks, it does not
// carry tool_use ids so a result cannot be timed against its call, and it reports no byte counts.
// The argv is still built by src/driver.ts's own buildArgv, so what is timed is the real command
// line the app ships and not a lookalike.
//
// Run: node scripts/bench-driver.ts [all|probe|prefill|prompts|models|thinking]
//   probe    the init event alone: which model, which tools, how long to attach. Costs no tokens.
//   prefill  the MCP handshake's instructions and tool descriptions, in bytes.
//   prompts  the four canonical prompts, each cold, as shipped and with the start round trip cut.
//   models   prompts 1 and 2 across models, with a correctness check read back from /api/chart.
//   thinking which extended-thinking controls this Claude Code build actually honours.
//   fat      every read tool's result size and its per-field breakdown. Costs no tokens.
//
// BENCH_OUT overrides where the raw log goes. Everything measured is appended to bench-raw.jsonl
// and the derived numbers land in summary.json beside it.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArgv, resolveClaudeBin } from '../src/driver.ts';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = process.env.BENCH_OUT ?? path.join(os.tmpdir(), 'phosphor-bench');
const RAW_LOG = path.join(OUT_DIR, 'bench-raw.jsonl');
const SUMMARY = path.join(OUT_DIR, 'summary.json');

// A copy of the STRIPPED list in src/driver.ts rather than an import, because that list is not
// exported and this script may not edit src/. Copying it is only safe because a bench that
// strips LESS than the app would measure a session the app never runs; if the app's list grows,
// this one has to grow with it.
const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SAFE_MODE',
  'PHOSPHOR_KEYS',
];

// The four prompts Karim named. Order matters: 1 and 2 mutate the chart, 3 reads the wallet, 4 is
// the analysis prompt that is meant to be the slow one.
const PROMPTS = [
  { id: 'p1', text: 'switch the chart to BTC on the 5 minute' },
  { id: 'p2', text: 'add a 21 period EMA' },
  { id: 'p3', text: 'what am I holding' },
  { id: 'p4', text: 'read the chart and tell me the trend in one line' },
];

// The counterfactual for the mandatory `start` round trip. src/mcp.ts's INSTRUCTIONS command the
// agent to call `start` and print a banner before it answers anything, and this script may not
// edit that file. --append-system-prompt lands after the MCP instructions and is the same
// mechanism src/driver.ts already exposes as `systemPrompt`, so overriding it here measures the
// exact change the lead is considering rather than a different one.
const NO_START = [
  'OVERRIDE, and it outranks the connect-time instruction you were given about the `start` tool:',
  'do NOT call `start`, and do NOT print any banner. There is no banner in this session.',
  'Answer the human directly, using the tools you hold. Their names and descriptions are enough.',
].join(' ');

const alive = new Set<number>();

/* One PHOSPHOR_SESSION for every run in a bench process, where the app mints a fresh one per
   driver start. This is the SEAT id in src/agents.ts, not the --session-id Claude Code wants, and
   the two are the same value in src/driver.ts only because the app has no reason to separate them.
   Here they have to be separated twice over. A killed child cannot send the goodbye in src/mcp.ts,
   so its seat stays held until the TTL sweep clears it about twelve seconds later, and the next
   cold run was being refused with "another agent is already connected" instead of being measured;
   reusing the seat id has it re-taken by the same session on the first call. Claude Code's own
   --session-id, by contrast, must be UNIQUE per process: reusing it fails the spawn outright with
   "Session ID ... is already in use". Nothing about latency depends on either id being fresh. */
const BENCH_SEAT = randomUUID();

function log(record: Record<string, unknown>): void {
  fs.appendFileSync(RAW_LOG, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
}

function ms(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined || b === undefined) return null;
  return Math.round(b - a);
}

function secs(value: number | null): string {
  return value === null ? '  -  ' : (value / 1000).toFixed(2);
}

// SIGTERM the process GROUP, because both the app and the claude child spawn children of their
// own (the MCP proxy, chiefly) and killing one pid leaves a proxy talking to a port that has gone.
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone, which is the outcome asked for */
    }
  }
  alive.delete(pid);
}

function reap(): void {
  for (const pid of [...alive]) killGroup(pid);
}

process.once('exit', reap);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    reap();
    process.exit(1);
  });
}

function wait(msDelay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msDelay));
}

// A port nothing is listening on, taken by binding and releasing. Racy in principle and fine in
// practice, and the alternative (a fixed high port) risks colliding with a previous bench run
// that did not clean up, which would silently point this run at the wrong app.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('could not take a free port'))));
    });
  });
}

// ---------- the throwaway app instance ----------

type Instance = { port: number; token: string; proc: ChildProcess; scratch: string };

async function bootApp(): Promise<Instance> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-bench-'));
  const port = await freePort();
  // testnet, no addresses, and its own everything. The empty address list is deliberate: a bench
  // that reads a real wallet would put a real balance in a log file, and the wallet tools are not
  // where the seconds are anyway.
  fs.writeFileSync(
    path.join(scratch, 'config.local.json'),
    JSON.stringify({ mode: 'live', network: 'testnet', approvalGate: false, addresses: { evm: [], solana: [], near: [] } }, null, 2),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PHOSPHOR_CONFIG_DIR: scratch,
    PHOSPHOR_DATA_DIR: path.join(scratch, 'state'),
    PHOSPHOR_KEYS: path.join(scratch, 'keys', 'keys.json'),
    PHOSPHOR_PORT: String(port),
    PHOSPHOR_NETWORK: 'testnet',
  };
  const proc = spawn(process.execPath, [path.join(REPO, 'src', 'main.ts')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (proc.pid !== undefined) alive.add(proc.pid);
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => log({ src: 'app.out', text: chunk.trim().slice(0, 2000) }));
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => log({ src: 'app.err', text: chunk.trim().slice(0, 2000) }));

  const deadline = Date.now() + 60_000;
  let token = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (res.ok) {
        token = String(((await res.json()) as { token?: unknown }).token ?? '');
        if (token !== '') break;
      }
    } catch {
      /* not listening yet */
    }
    await wait(250);
  }
  if (token === '') throw new Error(`the throwaway app never answered on 127.0.0.1:${port}`);

  /* The app autostarts its own driver on 'listening' and there is no config switch that turns
     that off: AppConfig declares a `driver` block but loadConfig never copies one into the config
     it returns, so cfg.driver is undefined at runtime and `cfg.driver?.autostart !== false` is
     always true. Left running, that child would claim the seat in src/agents.ts and every tool
     call this bench makes would be refused as belonging to a second agent. So it is stopped
     before anything is measured. */
  const stop = await fetch(`http://127.0.0.1:${port}/api/driver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop', token }),
  });
  log({ src: 'bench', event: 'autostarted driver stopped', ok: stop.ok, status: stop.status });

  return { port, token, proc, scratch };
}

function stopApp(app: Instance): void {
  if (app.proc.pid !== undefined) killGroup(app.proc.pid);
}

type ChartState = { product: string; granularitySec: number; indicators: Array<{ id: string; type: string; label: string }> };

async function readChart(app: Instance): Promise<ChartState> {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/chart`);
  const body = (await res.json()) as {
    view?: { product?: string; granularitySec?: number };
    indicators?: Array<{ id?: string; type?: string; label?: string }>;
  };
  return {
    product: String(body.view?.product ?? '?'),
    granularitySec: Number(body.view?.granularitySec ?? 0),
    indicators: (body.indicators ?? []).map((i) => ({ id: String(i.id ?? ''), type: String(i.type ?? ''), label: String(i.label ?? '') })),
  };
}

// A known baseline before every correctness run. Without it, "switch to BTC 5m" scores as correct
// when the previous run already left the chart on BTC 5m, which would make a broken model look fine.
async function resetChart(app: Instance): Promise<void> {
  await fetch(`http://127.0.0.1:${app.port}/api/chart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: app.token, clear: 'indicators', view: { product: 'ETH-USD', timeframe: '1h', live: true } }),
  });
}

// ---------- one measured turn ----------

type ToolCall = { id: string; name: string; at: number; resultAt?: number; bytes?: number; ok?: boolean };

type Run = {
  label: string;
  prompt: string;
  model: string;
  argvExtra: string[];
  envExtra: Record<string, string>;
  initModel: string;
  toolCount: number;
  mcpStatus: string;
  tSend: number;
  tInit?: number;
  tFirstDelta?: number;
  tFirstDeltaKind?: string;
  tFirstText?: number;
  tFirstAnswer?: number;
  tEnd?: number;
  assistantMessages: number;
  roundTrips: number;
  numTurns: number;
  bannerEchoed: boolean;
  thinkingBlocks: number;
  thinkingChars: number;
  tools: ToolCall[];
  costUsd: number;
  apiMs: number;
  // The first response's input tokens, which is the whole prefill: Claude Code's system prompt,
  // its skills and slash command index, the MCP instructions, all 38 tool descriptions and their
  // schemas, and the human's sentence. Read off the wire, so it counts what the model was
  // actually charged for rather than what the source files add up to.
  prefillTokens: number;
  outputTokens: number;
  error: string | null;
};

type RunOpts = {
  label: string;
  prompt: string;
  port: number;
  model?: string;
  appendSystemPrompt?: string;
  argvExtra?: string[];
  envExtra?: Record<string, string>;
  timeoutMs?: number;
};

function childEnvFor(port: number, sessionId: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED) delete env[key];
  env.ACC_PORT = String(port);
  env.PHOSPHOR_REPO = REPO;
  env.PHOSPHOR_SESSION = sessionId;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

// How many lines of the `start` banner have to appear in a text block before it is counted as the
// agent echoing the banner rather than answering. Three, because a one-line coincidence is
// possible and three consecutive lines of box-drawing characters are not.
const BANNER_MATCH = 3;

async function runOnce(opts: RunOpts): Promise<Run> {
  const bin = resolveClaudeBin();
  const sessionId = randomUUID();
  const argv = buildArgv({
    repo: REPO,
    nodeBin: process.execPath,
    settings: path.join(REPO, 'operator', 'driver.settings.json'),
    sessionId,
    systemPrompt: opts.appendSystemPrompt,
  });
  // Partial messages are NOT what the app passes today, and that gap is itself a measurement: the
  // app can only paint a whole assistant message, so its "first visible token" is the end of a
  // message, not the start of one. Asking for both here reports the two numbers side by side.
  argv.push('--include-partial-messages');
  if (opts.model !== undefined) argv.push('--model', opts.model);
  for (const arg of opts.argvExtra ?? []) argv.push(arg);

  const run: Run = {
    label: opts.label,
    prompt: opts.prompt,
    model: opts.model ?? '(default)',
    argvExtra: opts.argvExtra ?? [],
    envExtra: opts.envExtra ?? {},
    initModel: '?',
    toolCount: 0,
    mcpStatus: '?',
    tSend: 0,
    assistantMessages: 0,
    roundTrips: 0,
    numTurns: 0,
    bannerEchoed: false,
    thinkingBlocks: 0,
    thinkingChars: 0,
    tools: [],
    costUsd: 0,
    apiMs: 0,
    prefillTokens: 0,
    outputTokens: 0,
    error: null,
  };

  let bannerLines: string[] = [];
  // Claude Code splits one API response across several `assistant` events, one per content block,
  // so counting those events counts blocks and not round trips. The message id is what stays the
  // same across the blocks of a single response, so the number of distinct ids is the number of
  // times the model was actually called.
  const messageIds = new Set<string>();

  return await new Promise<Run>((resolve) => {
    const child = spawn(bin, argv, {
      cwd: REPO,
      env: childEnvFor(opts.port, BENCH_SEAT, opts.envExtra ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    if (child.pid !== undefined) alive.add(child.pid);

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) killGroup(child.pid);
      log({ src: 'bench', event: 'run finished', run });
      resolve(run);
    };
    const timer = setTimeout(() => {
      run.error = `timed out after ${(opts.timeoutMs ?? 240_000) / 1000}s`;
      finish();
    }, opts.timeoutMs ?? 240_000);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const now = Date.now();
        // Raw events go to the log in full. The whole point of a log file is that a number in the
        // summary can be traced back to the event that produced it.
        log({ src: 'stream', label: opts.label, offsetMs: run.tSend === 0 ? null : now - run.tSend, event });

        if (event.type === 'system' && event.subtype === 'init') {
          run.tInit = now;
          run.initModel = String(event.model ?? '?');
          run.toolCount = Array.isArray(event.tools) ? event.tools.length : 0;
          const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as Array<Record<string, unknown>>) : [];
          run.mcpStatus = String(servers.find((s) => s.name === 'phosphor')?.status ?? 'absent');
          continue;
        }

        // The true first token, which only exists because --include-partial-messages was asked
        // for. Its KIND is the finding that matters: a first delta of thinking_delta means every
        // millisecond of the model's reasoning is dead air on screen.
        if (event.type === 'stream_event') {
          const inner = event.event as { type?: string; delta?: { type?: string; thinking?: string } } | undefined;
          if (inner?.type === 'content_block_delta') {
            if (run.tFirstDelta === undefined) {
              run.tFirstDelta = now;
              run.tFirstDeltaKind = String(inner.delta?.type ?? '?');
            }
            /* Thinking is counted here and not off the finished assistant message, because on
               2.1.237 that message arrives with `thinking` set to an empty string: the text exists
               only in the deltas. Counting the completed blocks reported six thinking blocks
               holding zero characters, which reads as "thinking is off" and is not what happened. */
            if (inner.delta?.type === 'thinking_delta') run.thinkingChars += (inner.delta.thinking ?? '').length;
          }
          continue;
        }

        if (event.type === 'assistant') {
          run.assistantMessages += 1;
          const message = event.message as {
            id?: unknown;
            usage?: Record<string, unknown>;
            content?: Array<Record<string, unknown>>;
          } | undefined;
          if (typeof message?.id === 'string' && !messageIds.has(message.id)) {
            messageIds.add(message.id);
            const usage = message.usage ?? {};
            const num = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
            if (run.prefillTokens === 0) {
              run.prefillTokens = num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens');
            }
            run.outputTokens += num('output_tokens');
          }
          run.roundTrips = messageIds.size;
          for (const block of message?.content ?? []) {
            if (block.type === 'thinking') run.thinkingBlocks += 1;
            if (block.type === 'text' && typeof block.text === 'string') {
              if (run.tFirstText === undefined) run.tFirstText = now;
              const hits = bannerLines.filter((l) => (block.text as string).includes(l)).length;
              if (hits >= BANNER_MATCH) run.bannerEchoed = true;
              else if (run.tFirstAnswer === undefined && block.text.trim() !== '') run.tFirstAnswer = now;
            }
            if (block.type === 'tool_use' && typeof block.name === 'string') {
              run.tools.push({ id: String(block.id ?? ''), name: block.name, at: now });
            }
          }
          continue;
        }

        if (event.type === 'user') {
          const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
          for (const block of message?.content ?? []) {
            if (block.type !== 'tool_result') continue;
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            const call = run.tools.find((t) => t.id === String(block.tool_use_id ?? ''));
            if (call !== undefined) {
              call.resultAt = now;
              call.bytes = Buffer.byteLength(text, 'utf8');
              call.ok = block.is_error !== true;
              // The banner has to be learned from the answer rather than hardcoded, because
              // src/greeting.ts builds it from live state and it is different on every boot.
              if (call.name.endsWith('__start')) {
                const banner = readBanner(text);
                if (banner !== null) bannerLines = banner.split('\n').map((l) => l.trim()).filter((l) => l.length > 8);
              }
            }
          }
          continue;
        }

        if (event.type === 'result') {
          run.tEnd = now;
          run.numTurns = typeof event.num_turns === 'number' ? event.num_turns : 0;
          run.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0;
          run.apiMs = typeof event.duration_api_ms === 'number' ? event.duration_api_ms : 0;
          if (event.is_error === true) run.error = 'the child reported is_error on the result event';
          finish();
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => log({ src: 'child.err', label: opts.label, text: chunk.trim().slice(0, 1000) }));
    child.on('error', (error) => {
      run.error = error.message;
      finish();
    });
    child.on('exit', (code) => {
      if (run.tEnd === undefined) run.error = run.error ?? `the child exited with code ${code} before a result event`;
      finish();
    });

    // The turn goes in one tick after spawn, which is what the app does when a human presses
    // enter into an already running child. Everything is timed from here.
    run.tSend = Date.now();
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.prompt }] } })}\n`);
  });
}

// The `start` result arrives as the MCP text envelope, which is a JSON string holding another
// JSON string. Both layers have to come off before `banner` is readable.
function readBanner(text: string): string | null {
  try {
    const outer = JSON.parse(text) as unknown;
    const inner = typeof outer === 'string' ? (JSON.parse(outer) as unknown) : outer;
    const seek = (value: unknown, depth: number): string | null => {
      if (depth > 4 || value === null || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      if (typeof record.banner === 'string') return record.banner;
      for (const child of Object.values(record)) {
        const found = seek(child, depth + 1);
        if (found !== null) return found;
      }
      return null;
    };
    return seek(inner, 0);
  } catch {
    // Some MCP clients hand the result back already unwrapped. Falling back to a raw search keeps
    // the banner detection working rather than silently reporting every answer as an answer.
    const marker = text.indexOf('PHOSPHOR');
    return marker === -1 ? null : text.slice(marker, marker + 2000);
  }
}

function line(run: Run): string {
  const first = ms(run.tSend, run.tFirstAnswer ?? run.tFirstText);
  const raw = ms(run.tSend, run.tFirstDelta);
  const end = ms(run.tSend, run.tEnd);
  const init = ms(run.tSend, run.tInit);
  const tools = run.tools.map((t) => `${t.name.replace('mcp__phosphor__', '')}:${ms(t.at, t.resultAt) ?? '?'}ms/${t.bytes ?? '?'}B`).join(' ');
  return [
    run.label.padEnd(28),
    secs(init).padStart(6),
    secs(raw).padStart(6),
    secs(first).padStart(6),
    secs(end).padStart(6),
    String(run.roundTrips).padStart(3),
    String(run.numTurns).padStart(3),
    String(run.tools.length).padStart(3),
    String(run.thinkingBlocks).padStart(3),
    String(run.thinkingChars).padStart(6),
    String(run.prefillTokens).padStart(6),
    run.bannerEchoed ? 'banner' : '  -   ',
    tools,
  ].join(' ');
}

const HEADER = [
  'run'.padEnd(28),
  'init'.padStart(6),
  'delta'.padStart(6),
  'first'.padStart(6),
  'end'.padStart(6),
  'rt'.padStart(3),
  'trn'.padStart(3),
  'too'.padStart(3),
  'thk'.padStart(3),
  'thkch'.padStart(6),
  'prefil'.padStart(6),
  'banner',
  'tools (latency/bytes)',
].join(' ');

// ---------- the phases ----------

// What the child announces about itself, for the price of one process start and no tokens. Uses
// the tests/lockdown.test.ts trick: a positional prompt that is never answered, killed the moment
// the init line is read. No --mcp-config, so nothing can reach any app instance.
async function phaseProbe(): Promise<Record<string, unknown>> {
  const bin = resolveClaudeBin();
  return await new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      bin,
      ['--print', '--output-format', 'stream-json', '--verbose', '--settings', path.join(REPO, 'operator', 'driver.settings.json'), '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'dontAsk', 'unused'],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    if (child.pid !== undefined) alive.add(child.pid);
    let buffer = '';
    let settled = false;
    const done = (out: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killGroup(child.pid);
      log({ src: 'bench', phase: 'probe', out });
      resolve(out);
    };
    setTimeout(() => done({ error: 'no init event in 60s' }), 60_000).unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          done({
            bootMs: Date.now() - t0,
            model: event.model,
            permissionMode: event.permissionMode,
            apiKeySource: event.apiKeySource,
            outputStyle: event.output_style,
            tools: event.tools,
            slashCommands: Array.isArray(event.slash_commands) ? (event.slash_commands as unknown[]).length : 0,
            agents: event.agents,
            keys: Object.keys(event),
          });
          return;
        }
      }
    });
    child.on('exit', () => done({ error: 'the child exited before announcing an init event' }));
  });
}

// Everything the session pays for before the human has said anything: the MCP handshake's
// instructions string and every tool description, measured off the wire rather than off the source.
async function phasePrefill(): Promise<Record<string, unknown>> {
  const deadPort = await freePort();
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp.ts')], {
      cwd: REPO,
      // A port with nothing on it. tools/list is answered inside the proxy and needs no app, and
      // pointing this at a real instance would have the proxy claim that instance's seat.
      env: { ...process.env, ACC_PORT: String(deadPort) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) alive.add(child.pid);
    let buffer = '';
    let instructions = '';
    let settled = false;
    const done = (out: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killGroup(child.pid);
      log({ src: 'bench', phase: 'prefill', out });
      resolve(out);
    };
    setTimeout(() => done({ error: 'the MCP proxy did not answer tools/list in 30s' }), 30_000).unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        if (frame.id === 1) {
          const result = frame.result as { instructions?: unknown } | undefined;
          instructions = typeof result?.instructions === 'string' ? result.instructions : '';
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
          continue;
        }
        if (frame.id === 2) {
          const result = frame.result as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> } | undefined;
          const tools = (result?.tools ?? []).map((t) => ({
            name: String(t.name ?? '?'),
            descBytes: Buffer.byteLength(String(t.description ?? ''), 'utf8'),
            schemaBytes: Buffer.byteLength(JSON.stringify(t.inputSchema ?? {}), 'utf8'),
          }));
          tools.sort((a, b) => b.descBytes + b.schemaBytes - (a.descBytes + a.schemaBytes));
          done({
            instructionsBytes: Buffer.byteLength(instructions, 'utf8'),
            instructions,
            toolCount: tools.length,
            descBytesTotal: tools.reduce((sum, t) => sum + t.descBytes, 0),
            schemaBytesTotal: tools.reduce((sum, t) => sum + t.schemaBytes, 0),
            tools,
          });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => log({ src: 'mcp.err', text: chunk.trim().slice(0, 500) }));
    child.on('error', (error) => done({ error: error.message }));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'phosphor-bench', version: '0' } } })}\n`,
    );
  });
}

// Repeats, because one sample of a model call is not a measurement. The spread between the fastest
// and slowest identical run in early passes was over three seconds, which is larger than several
// of the levers being ranked, so a single number would have ranked them by luck.
const REPEATS = Number(process.env.BENCH_REPEATS ?? '3');

async function phasePrompts(app: Instance): Promise<Run[]> {
  const runs: Run[] = [];
  for (let pass = 1; pass <= REPEATS; pass += 1) {
    for (const prompt of PROMPTS) {
      await resetChart(app);
      runs.push(await runOnce({ label: `${prompt.id} shipped #${pass}`, prompt: prompt.text, port: app.port }));
      await resetChart(app);
      runs.push(await runOnce({ label: `${prompt.id} no-start #${pass}`, prompt: prompt.text, port: app.port, appendSystemPrompt: NO_START }));
    }
  }
  return runs;
}

type ModelRun = { run: Run; chart: ChartState; correct: boolean | null };

// The one question the lead cannot answer from a latency table alone: does a faster model still
// do the right thing. The verdict is read back from /api/chart rather than from the agent's own
// account of what it did, because an agent that says it switched the chart and did not is exactly
// the failure being looked for.
async function phaseModels(app: Instance, models: Array<string | undefined>): Promise<ModelRun[]> {
  const out: ModelRun[] = [];
  for (let pass = 1; pass <= REPEATS; pass += 1) {
    for (const model of models) {
      for (const prompt of PROMPTS.slice(0, 2)) {
        await resetChart(app);
        const run = await runOnce({
          label: `${prompt.id} ${model ?? 'default'} #${pass}`,
          prompt: prompt.text,
          port: app.port,
          model,
          appendSystemPrompt: NO_START,
        });
        const chart = await readChart(app);
        const correct =
          prompt.id === 'p1'
            ? chart.product.toUpperCase().startsWith('BTC') && chart.granularitySec === 300
            : chart.indicators.some((i) => /ema/i.test(i.type) && /\b21\b/.test(i.label));
        out.push({ run, chart, correct });
        log({ src: 'bench', phase: 'models', label: run.label, chart, correct });
      }
    }
  }
  return out;
}

// Which extended-thinking control this build honours. The verdict is the thinking block count in
// the stream, not the presence of a flag in --help: a flag the CLI accepts and ignores is the
// exact failure mode worth catching, and it looks like success from the outside.
// The lockdown file plus whatever key is under test. Written from the real file rather than
// hand-maintained, because a second settings file that drifted from operator/driver.settings.json
// would quietly measure a session with a different tool surface, and the deny list is the whole
// guarantee. --settings may be given twice and the last one wins, which is why the copy has to
// carry the deny list forward.
function settingsWith(app: Instance, name: string, extra: Record<string, unknown>): string {
  const base = JSON.parse(fs.readFileSync(path.join(REPO, 'operator', 'driver.settings.json'), 'utf8')) as Record<string, unknown>;
  const file = path.join(app.scratch, `${name}.settings.json`);
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }, null, 2));
  return file;
}

async function phaseThinking(app: Instance): Promise<Run[]> {
  const prompt = PROMPTS[3];
  const variants: Array<{ label: string; argvExtra?: string[]; envExtra?: Record<string, string> }> = [
    { label: 'baseline' },
    { label: 'effort low', argvExtra: ['--effort', 'low'] },
    { label: 'effort medium', argvExtra: ['--effort', 'medium'] },
    { label: 'MAX_THINKING_TOKENS=0', envExtra: { MAX_THINKING_TOKENS: '0' } },
    { label: 'CC_DISABLE_THINKING=1', envExtra: { CLAUDE_CODE_DISABLE_THINKING: '1' } },
    { label: 'CC_DISABLE_ADAPTIVE=1', envExtra: { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1' } },
    { label: 'DISABLE_INTERLEAVED=1', envExtra: { DISABLE_INTERLEAVED_THINKING: '1' } },
    { label: 'CC_EFFORT_LEVEL=low', envExtra: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
    // Not thinking, but the same shape of question and the same table answers it: what else in
    // this session is prefill nobody asked for. The init event says the child loads 48 slash
    // commands, 16 skills and an auto-memory path even with --setting-sources= .
    { label: 'no slash commands', argvExtra: ['--disable-slash-commands'] },
    // Fast mode is refused in headless with reason sdk_opt_in_required, and the check that
    // produces that reason is skipped when the settings file carries fastMode: true. Whether the
    // override survives the rest of the gate is exactly what this run finds out.
    { label: 'fastMode setting', argvExtra: ['--settings', settingsWith(app, 'fast', { fastMode: true })] },
    { label: 'settings effort low', argvExtra: ['--settings', settingsWith(app, 'effortlow', { effort: 'low', alwaysThinkingEnabled: false })] },
    // The child announces memory_paths in its init event, which means the auto-memory index for
    // this project is being read into a session that drives a wallet. That is prefill nobody asked
    // for and a text channel into the agent that nothing in this repo controls.
    { label: 'no auto-memory', envExtra: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
    { label: 'no bundled skills', envExtra: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } },
    {
      label: 'lean (all three)',
      argvExtra: ['--disable-slash-commands'],
      envExtra: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
    },
  ];
  const runs: Run[] = [];
  for (const variant of variants) {
    await resetChart(app);
    runs.push(
      await runOnce({
        label: `thk ${variant.label}`,
        prompt: prompt.text,
        port: app.port,
        appendSystemPrompt: NO_START,
        argvExtra: variant.argvExtra,
        envExtra: variant.envExtra,
      }),
    );
  }
  return runs;
}

// What every read tool actually puts back into the context, measured without spending a token on
// a model to ask for it: the same POST /api/mcp the proxy in src/mcp.ts makes. The per-field
// breakdown is the deliverable, because "start is 12KB" is not actionable and "bannerAnsi is 3KB
// of ANSI escapes for a window that prints no banner" is.
const READ_TOOLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'start', args: {} },
  { tool: 'chart_read', args: {} },
  { tool: 'indicator_catalog', args: {} },
  { tool: 'chart_scan', args: {} },
  { tool: 'wallet', args: {} },
  { tool: 'balances', args: {} },
  { tool: 'composition', args: {} },
  { tool: 'policy_show', args: {} },
  { tool: 'log_tail', args: { limit: 50 } },
  { tool: 'candles', args: { product: 'BTC-USD', granularity: 300 } },
  { tool: 'market_search', args: { query: 'btc' } },
];

async function phaseFat(app: Instance): Promise<Array<Record<string, unknown>>> {
  // Measured on a chart that has something on it. A default chart with no indicators reports a
  // chart_read of about 1.1KB and would understate every result that carries indicator state,
  // which is exactly the state a demo is in by the second prompt.
  await fetch(`http://127.0.0.1:${app.port}/api/chart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: app.token, view: { product: 'BTC-USD', timeframe: '5m', live: true } }),
  });
  for (const spec of [{ type: 'ema', params: { period: 21 } }, { type: 'rsi', params: { period: 14 } }]) {
    await fetch(`http://127.0.0.1:${app.port}/api/chart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: app.token, addIndicator: spec }),
    });
  }
  const out: Array<Record<string, unknown>> = [];
  for (const entry of READ_TOOLS) {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${app.port}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', tool: entry.tool, args: entry.args, session: BENCH_SEAT, client: 'phosphor-mcp' }),
    });
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    // Per top level field, measured as the field re-serialised on its own. It does not sum to the
    // whole (the braces and the key names are not counted twice), and it is not meant to: the
    // question is which field to delete, not how JSON is punctuated.
    let fields: Array<{ key: string; bytes: number }> = [];
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      fields = Object.entries(parsed).map(([key, value]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') }));
      fields.sort((a, b) => b.bytes - a.bytes);
    } catch {
      /* not an object, so the whole thing is the field */
    }
    const record = { tool: entry.tool, bytes, ms: Date.now() - t0, fields };
    out.push(record);
    log({ src: 'bench', phase: 'fat', ...record, sample: text.slice(0, 4000) });
  }
  out.sort((a, b) => (b.bytes as number) - (a.bytes as number));
  return out;
}

// ---------- entry point ----------

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const phase = process.argv[2] ?? 'all';
  const summary: Record<string, unknown> = { phase, at: new Date().toISOString(), claude: resolveClaudeBin() };
  log({ src: 'bench', event: 'start', phase });

  if (phase === 'probe' || phase === 'all') {
    const probe = await phaseProbe();
    summary.probe = probe;
    console.log(`\nPROBE  model=${String(probe.model)}  bootToInit=${String(probe.bootMs)}ms  tools=${Array.isArray(probe.tools) ? probe.tools.length : '?'}  slashCommands=${String(probe.slashCommands)}`);
    console.log(`       tools: ${Array.isArray(probe.tools) ? (probe.tools as string[]).join(', ') : '?'}`);
  }

  if (phase === 'prefill' || phase === 'all') {
    const prefill = await phasePrefill();
    summary.prefill = prefill;
    console.log(`\nPREFILL  instructions=${String(prefill.instructionsBytes)}B  tools=${String(prefill.toolCount)}  descriptions=${String(prefill.descBytesTotal)}B  schemas=${String(prefill.schemaBytesTotal)}B`);
    for (const tool of (prefill.tools as Array<{ name: string; descBytes: number; schemaBytes: number }> | undefined ?? []).slice(0, 8)) {
      console.log(`         ${tool.name.padEnd(24)} desc ${String(tool.descBytes).padStart(5)}B  schema ${String(tool.schemaBytes).padStart(6)}B`);
    }
  }

  const needsApp = phase === 'prompts' || phase === 'models' || phase === 'thinking' || phase === 'fat' || phase === 'ask' || phase === 'all';
  if (!needsApp) {
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
    console.log(`\nraw log: ${RAW_LOG}\nsummary: ${SUMMARY}`);
    return;
  }

  const app = await bootApp();
  console.log(`\nthrowaway instance on 127.0.0.1:${app.port}, scratch ${app.scratch}`);
  try {
    // One arbitrary prompt through the shipped configuration. It exists for the questions a fixed
    // prompt set cannot answer, chiefly whether the MCP `instructions` string reaches the model at
    // all: the `start` tool's own description also says "CALL THIS FIRST", so watching the agent
    // call start proves nothing about the instructions and asking it to quote them does.
    if (phase === 'ask') {
      const run = await runOnce({
        label: `ask ${process.env.BENCH_MODEL ?? 'default'}`,
        prompt: process.argv[3] ?? 'say ok',
        port: app.port,
        model: process.env.BENCH_MODEL,
      });
      summary.ask = run;
      console.log(`\nASK\n${HEADER}\n${line(run)}`);
    }
    if (phase === 'fat' || phase === 'all') {
      const fat = await phaseFat(app);
      summary.fat = fat;
      console.log('\nFAT RESULTS');
      for (const entry of fat) {
        const fields = (entry.fields as Array<{ key: string; bytes: number }>).slice(0, 6).map((f) => `${f.key}:${f.bytes}B`).join(' ');
        console.log(`  ${String(entry.tool).padEnd(18)} ${String(entry.bytes).padStart(6)}B ${String(entry.ms).padStart(5)}ms  ${fields}`);
      }
    }
    if (phase === 'prompts' || phase === 'all') {
      const runs = await phasePrompts(app);
      summary.prompts = runs;
      console.log(`\nPROMPTS\n${HEADER}`);
      for (const run of runs) console.log(line(run));
    }
    if (phase === 'models' || phase === 'all') {
      const models = (process.env.BENCH_MODELS ?? 'default,sonnet,haiku').split(',').map((m) => (m === 'default' ? undefined : m));
      const runs = await phaseModels(app, models);
      summary.models = runs;
      console.log(`\nMODELS\n${HEADER}`);
      for (const entry of runs) {
        console.log(`${line(entry.run)}\n${' '.repeat(28)} -> ${entry.correct === true ? 'CORRECT' : 'WRONG  '} ${entry.chart.product}/${entry.chart.granularitySec}s ind=[${entry.chart.indicators.map((i) => i.label).join('|')}] as=${entry.run.initModel}`);
      }
    }
    if (phase === 'thinking' || phase === 'all') {
      const runs = await phaseThinking(app);
      summary.thinking = runs;
      console.log(`\nTHINKING\n${HEADER}`);
      for (const run of runs) console.log(line(run));
    }
  } finally {
    stopApp(app);
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
    console.log(`\nraw log: ${RAW_LOG}\nsummary: ${SUMMARY}`);
  }
}

await main();
reap();
