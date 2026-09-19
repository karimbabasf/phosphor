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

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDriver, useSeatSecret, type DriverEvent } from '../src/driver.ts';
import { hashLine } from '../src/audit.ts';
import { defaultPolicy } from '../src/policy/file.ts';
import { buildRole } from '../src/role.ts';
import { loadProfile } from '../src/profile/index.ts';
import { venueAllowlist } from '../src/rails/index.ts';
import { renderSentences } from '../src/policy/render.ts';
import { EXPECTED_TOOLS_SORTED } from '../tests/tool-surface.ts';
import { loadScenarios, turnsOf, type Scenario } from '../tests/eval/schema.ts';
import { BANNED, gradeScenario, type Card, type Frame, type Run, type StatusRead, type Verdict } from '../tests/eval/grade.ts';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCENARIO_DIR = path.join(ROOT, 'tests', 'eval');
const PREFIX = 'mcp__phosphor__';

// One exit guard per driver, one driver per scenario, and 28 of them. The listeners are real and
// wanted; the default ceiling of ten is what is wrong here.
process.setMaxListeners(64);

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

/* How fast the demo money rail walks its stages here (src/rails/demo.ts): at its own speed, about
   twenty five seconds, which is what a scenario is meant to be graded against. It ran at a
   fiftieth of that while a propose held its reply until the rail answered, because the card in
   the conversation arrived a whole walk after the call and S1's one second window could not be
   met. The reply is the decision now, so the card lands at once whatever the rail is doing, and
   a scenario that waits on a stage is waiting on the real thing.
   An env var set outside this script still wins, for a faster sweep of the graders themselves.
   The other two knobs (PHOSPHOR_DEMO_STALL, PHOSPHOR_DEMO_DEADLINE_SEC) are not set here:
   a scenario that wants a stalled row seeds one through `pre.proposals`. */
function demoRailSpeed(): Record<string, string> {
  return { PHOSPHOR_DEMO_STAGE_SCALE: process.env.PHOSPHOR_DEMO_STAGE_SCALE ?? '1' };
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
  fs.chmodSync(path.join(stage, 'tests', 'eval', 'idle-agent.ts'), 0o755);
  /* The conversation door, pointed somewhere harmless. runScenario opens a chat so a `show`
     card has a window to land in, and src/http/chats.ts starts a child for every chat it makes.
     Left unset that child is the real claude binary on this machine, which is a second model
     beside the one under test and a subscription being spent by a test run. */
  const cfgPath = path.join(stage, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  cfg.driver = { claudeBin: path.join(stage, 'tests', 'eval', 'idle-agent.ts') };
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
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

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
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
    // Merged over the file main.ts would have seeded, allowlist and sentences included, so a
    // scenario that names one threshold does not silently rewrite every other rule.
    const seeded = defaultPolicy();
    seeded.outbound.destinationAllowlist = venueAllowlist();
    const merged = mergeDeep(seeded as unknown as Record<string, unknown>, scenario.pre.policy);
    (merged as Json).sentences = renderSentences(merged as Json);
    fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(merged, null, 2)}\n`);
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
    env: { ...cleanEnv(), ACC_PORT: String(port), ACC_MODE: 'demo', ACC_DATA_DIR: dataDir, ...demoRailSpeed() },
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
async function watchWindow(app: App, frames: Frame[], cards: Card[], stop: AbortSignal): Promise<void> {
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
        /* A card the app pushed rather than the agent's own answer carrying one. `show` is the
           one tool whose card is written into the conversation by src/http/view.ts, so the
           driver's onEvent below never sees it: the window reads it off this frame and so does
           the grader. */
        if (String(payload.type ?? '') === 'driver') {
          const event = (payload as { event?: { kind?: unknown; name?: unknown; data?: unknown } }).event;
          if (event !== undefined && event.kind === 'tool_data' && typeof event.name === 'string') {
            cards.push({ at, name: bare(event.name), data: event.data });
          }
        }
        let proposals: Json[] = [];
        try {
          const state = (await (await fetch(`${app.base}/api/state`)).json()) as Json;
          proposals = (state.proposals as Json[]) ?? [];
        } catch {
          // The app is going down, which is not a window failure.
        }
        /* STAMPED WHEN THE STATE ANSWERED, not when the frame woke this reader. The rows below
           are what /api/state held after a round trip, so a stamp taken before it dates a later
           state to an earlier second and the transcript rule reads a terminal row as having been
           on the window before the agent's read of the same row. That is a failure the harness
           manufactured, and it moved with the machine's load rather than with the code. */
        frames.push({ at: Date.now(), type: String(payload.type ?? ''), payload, proposals });
      }
    }
  } catch {
    // aborted at the end of the scenario
  }
}

// ---------- the rubric judge ----------

/* Live mode only, and three independent votes per scenario that carries a rubric line.

   The judge is a `claude -p` with no tools, no MCP config and none of this machine's settings: it
   reads the rule, the facts the spec demanded of that reply, the phrases the grader bans, and the
   reply itself, then answers with a digit. It is deliberately not the agent under test, and it is
   still told nothing about the trace, because a judge that knows what the calls were starts
   grading the calls again.

   THREE VOTES, AND THE MIDDLE ONE IS THE SCORE. A single shot was the least repeatable thing in
   this suite: the same reply scored 2 in one run and 1 in the next with nothing between them, and
   at run 6 four of the nine failures were the judge alone. The votes are cast at once, against one
   prompt, and the median stands, so neither one harsh read nor one generous one decides a scenario.

   AND IT IS TOLD WHAT THE REPLY HAD TO CARRY. Handed the rubric line by itself, the judge graded
   tone: it marked a reply down as a "mini-lecture" for being two sentences while every fact the
   spec asked for was inside them. The spec's own Must say line goes in verbatim, and the prompt
   says that a reply carrying every one of those facts is a 2 unless the rule is itself about
   length. Judgment stays the judge's; the bar stops moving.

   Scripted mode never calls it. A canned reply is the fixture's own prose and scoring it would be
   the fixture marking its own homework. */
const JUDGE_VOTES = 3;

function judgePrompt(scenario: Scenario, texts: Array<{ text: string; turn?: number }>): string {
  const turns = new Map<number, string[]>();
  for (const entry of texts) {
    const key = entry.turn ?? 0;
    turns.set(key, [...(turns.get(key) ?? []), entry.text]);
  }
  const answers = [...turns.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, parts], position) => `ANSWER ${position + 1}${turns.size > 1 ? ` (to the person's message ${index + 1})` : ''}:\n${parts.join('\n')}`)
    .join('\n\n');
  return [
    'You are scoring one reply from a wallet operator agent against one rule, and nothing else.',
    turns.size > 1
      ? 'The agent answered the person more than once. Each ANSWER below is one separate reply, read on its own at the time it was written, so judge a rule about length or shape against a single answer and never against all of them stacked together.'
      : '',
    '',
    `RULE: ${scenario.rubric ?? ''}`,
    '',
    `THE FACTS it had to carry: ${scenario.mustSayText ?? '(none named)'}`,
    '',
    `PHRASES BANNED IN ANY REPLY: ${BANNED.map((banned) => banned.why).join('; ')}.`,
    '',
    'You are scoring two things separately.',
    'FACTS: is each fact above present, in whatever words the agent chose. A fact said in a',
    'paraphrase is present, and so is one said in different words or a different order: you are',
    'reading for substance, not for a form of words. A fact left out, or replaced by something',
    'vaguer than the spec asked for, is missing. The exact figures are checked by machine against',
    'the same line, so do not verify arithmetic and do not mark a number down for its formatting.',
    'RULE: does the reply meet the rule above. Length is only a fault where the rule is about',
    'length or shape; otherwise a longer reply that meets the rule is a 2.',
    '',
    answers.slice(0, 6000),
    '',
    'Answer with TWO digits and a reason, in exactly this shape: "<facts> <rule> <reason>".',
    'Each digit is 0, 1 or 2. Facts: 2 every fact is there, 1 one or two missing, 0 most missing.',
    'Rule: 2 clearly meets it, 1 half meets it, 0 breaks it. At most fifteen words of reason,',
    'naming what is missing when either digit is not 2. Nothing else.',
  ].join('\n');
}

type Vote = { facts: number; rule: number; why: string };

function castVote(prompt: string): Promise<Vote> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '--setting-sources=', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let done = false;
    const finish = (value: Vote): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ facts: -1, rule: -1, why: 'the judge did not answer inside 150 s' });
    }, 150_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => finish({ facts: -1, rule: -1, why: `the judge did not start (${error.message})` }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ facts: -1, rule: -1, why: `the judge exited ${code}` });
      const text = out.trim();
      const match = /^([012])[\s,]+([012])\b\s*(.*)$/s.exec(text);
      finish(
        match === null
          ? { facts: -1, rule: -1, why: `the judge answered ${text.slice(0, 60)}` }
          : { facts: Number(match[1]), rule: Number(match[2]), why: match[3].trim().slice(0, 80) },
      );
    });
    child.stdin.end(prompt);
  });
}

/* The median of the votes that answered, per digit. Three votes and two agreeing is a majority;
   three that disagree land on the middle one, which is the point of an odd number. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function judgeReply(scenario: Scenario, texts: Array<{ text: string; turn?: number }>): Promise<{ facts: number; rule: number; why: string }> {
  const prompt = judgePrompt(scenario, texts);
  const cast = await Promise.all(Array.from({ length: JUDGE_VOTES }, () => castVote(prompt)));
  const answered = cast.filter((vote) => vote.facts >= 0 && vote.rule >= 0);
  if (answered.length === 0) return { facts: -1, rule: -1, why: cast[0]?.why ?? 'no judge answered' };
  const facts = median(answered.map((vote) => vote.facts));
  const rule = median(answered.map((vote) => vote.rule));
  const spoke = answered.find((vote) => vote.facts === facts && vote.rule === rule) ?? answered.find((vote) => vote.facts === facts) ?? answered[0];
  const votes = answered.map((vote) => `${vote.facts}${vote.rule}`).join('/');
  return { facts, rule, why: `${votes} ${spoke.why}`.slice(0, 92) };
}

// ---------- one scenario ----------

type Result = {
  scenario: Scenario;
  status: 'pass' | 'fail' | 'xfail' | 'error';
  verdict: Verdict | null;
  missing: string[];
  detail: string;
  // Live mode only: the judge's line for this scenario's rubric, empty in scripted mode.
  rubric: string;
};

function bare(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

async function runScenario(stage: string, scenario: Scenario, available: Set<string>): Promise<Result> {
  const missing = (scenario.needsTools ?? []).filter((tool) => !available.has(tool));
  const app = await bootApp(stage, scenario);
  fs.writeFileSync(path.join(stage, '.eval-scenario.json'), JSON.stringify(scenario));

  /* The seat this boot minted. src/mcp.ts refuses every op without it, and the driver reads it
     from this module rather than from the environment, because the app normally IS this process.
     Here the app is a child, so the secret is read off its data directory and handed over. */
  const seat = path.join(app.dataDir, 'agent.secret');
  const secret = fs.existsSync(seat) ? fs.readFileSync(seat, 'utf8').trim() : '';
  if (secret !== '') useSeatSecret(secret);

  /* THE COLLEAGUE'S LINES, written through /api/mcp under a session of the harness's own. The
     board is memory only, so a fixture cannot seed it the way it seeds proposals or the audit
     log, and S27 is exactly the scenario that needs one there before the agent reads it. */
  for (const post of scenario.pre.board ?? []) {
    await fetch(`${app.base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify({
        op: 'view',
        tool: 'agent_post',
        args: { kind: post.kind ?? 'note', text: post.text },
        session: 'eval-colleague',
        client: post.label ?? 'colleague',
        label: post.label ?? 'colleague',
        secret,
      }),
    }).catch(() => undefined);
  }

  const frames: Frame[] = [];
  const cards: Card[] = [];
  const controller = new AbortController();
  const window = watchWindow(app, frames, cards, controller.signal);
  /* AND A POLL BESIDE IT, because a record built only on events is not a timeline. watchWindow
     wakes on an SSE frame and then fetches the state, so a row written in the same tick as its
     own frame is fetched before it exists and never appears at all; the sentence rule was
     failing agents for naming a stage the record had missed rather than one the window had not
     reached. Half a second is well under the second the card checks already allow. */
  const poll = setInterval(() => {
    void (async () => {
      try {
        const state = (await (await fetch(`${app.base}/api/state`)).json()) as Json;
        // Stamped on the answer, for the reason watchWindow gives above.
        frames.push({ at: Date.now(), type: 'poll', payload: null, proposals: (state.proposals as Json[]) ?? [] });
      } catch {
        // The app is going down, which is not a window failure.
      }
    })();
  }, 500);

  /* THE CONVERSATION THE CARD LANDS IN, opened through the app's own door before the turn runs.
     A person asking to see a transaction is typing into a conversation, so one is always open
     for them; this harness drives the agent from outside the app, so none was, and every `show`
     answered drawn:false against a window nobody is looking at that way. The child this starts
     is tests/eval/idle-agent.ts (see stageRepo), which holds the seat and says nothing. */
  await fetch(`${app.base}/api/driver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.base },
    body: JSON.stringify({ action: 'open', token: app.token }),
  }).catch(() => undefined);

  const trace: Run['trace'] = [];
  const texts: Run['texts'] = [];
  const statusReads: StatusRead[] = [];
  const errors: string[] = [];
  let ended = false;
  let clicked = false;
  let turnIndex = 0;

  const driver = createDriver({
    repo: stage,
    port: app.port,
    // Scripted mode points the driver at the replay agent. Live mode leaves it unset, which is
    // how the real binary gets found, and is the only difference between the two runs.
    claudeBin: LIVE ? undefined : path.join(stage, 'tests', 'eval', 'agent.ts'),
    /* Live mode runs the agent the app runs: the same role text src/http/chats.ts builds, under
       operator/driver.settings.json (the default settingsPath), on the machine's own model. An
       eval against a differently prompted agent grades something nobody ships. */
    systemPrompt: LIVE ? buildRole({ root: stage, view: 'basic', profile: loadProfile(app.dataDir) }) : undefined,
    onEvent: (event: DriverEvent) => {
      const at = Date.now();
      if (event.kind === 'tool') trace.push({ at, name: bare(event.name), args: event.input });
      if (event.kind === 'text') texts.push({ at, text: event.text, turn: turnIndex });
      if (event.kind === 'error') errors.push(event.message);
      if (event.kind === 'status' && event.state === 'failed') errors.push(event.detail ?? 'driver failed');
      if (event.kind === 'turn_end') ended = true;
      if (event.kind === 'tool_data') {
        const name = bare(event.name);
        cards.push({ at, name, data: event.data });
        /* Every read that hands back a ProposalView feeds the transcript rule, not just the one
           that reads a single row. proposals is the page and diagnose is the row plus why it is
           stuck; an agent quoting either against a window that had already gone terminal is the
           same two-sources-of-truth bug, so the rule has to see all three. */
        const row = event.data as Json;
        if (name === 'proposal_status') statusReads.push({ at, data: row });
        if (name === 'proposals') for (const entry of (row?.proposals as Json[]) ?? []) statusReads.push({ at, data: entry });
        if (name === 'diagnose' && row?.view !== undefined) statusReads.push({ at, data: row.view });
        // The finger. It clicks once, on the first pending proposal a propose call created, and
        // only where the scenario says the user said yes. Everything else about approval is the
        // app's: the token never leaves this process and no route serves it.
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
    // Scripted mode plays the whole exchange off one turn, because the script already carries
    // what the human's second sentence led to. Live mode feeds every turn and waits for each.
    const turns = LIVE ? turnsOf(scenario) : turnsOf(scenario).slice(0, 1);
    for (const [index, turn] of turns.entries()) {
      ended = false;
      turnIndex = index;
      driver.send(turn);
      const until = Date.now() + (LIVE ? 240_000 : 60_000);
      while (!ended && errors.length === 0 && Date.now() < until) await sleep(100);
      if (!ended && errors.length === 0) detail = 'the turn did not end inside its budget';
      if (detail !== '' || errors.length > 0) break;
    }
    // The last SSE frame trails the last tool call, so the window is given a moment to say so.
    await sleep(400);
    /* THE CLOSING FRAME, read straight off /api/state rather than off an event. watchWindow only
       records a state when an SSE frame wakes it, so a row written in the same tick as the last
       frame (a propose the policy refuses outright is the common one) is pushed and fetched in
       the wrong order and never appears in any frame at all. The window has it; the record did
       not, and the sentence rule was failing agents for naming a stage the record had missed. */
    try {
      const state = (await (await fetch(`${app.base}/api/state`)).json()) as Json;
      frames.push({ at: Date.now(), type: 'final', payload: null, proposals: (state.proposals as Json[]) ?? [] });
    } catch {
      // The app is going down, which is not a window failure.
    }
  } catch (error) {
    detail = errText(error);
  } finally {
    clearInterval(poll);
    driver.stop();
    controller.abort();
    await window.catch(() => undefined);
    await app.stop();
  }

  const run: Run = { trace, texts, cards, frames, statusReads, mode: LIVE ? 'live' : 'scripted' };
  const verdict = gradeScenario(scenario, run);
  let rubric = '';
  /* The judge reads the reply twice over, for the facts the spec demanded and for the rule, and
     both have to come back 2. The facts half is what the reply regexes used to do and could not:
     the agent writes a fact in its own words and a pattern can only recognise the words somebody
     guessed in advance. What stays a regex is the figures, in gradeReply above, where there is one
     correct answer and paraphrase is not a thing a number does. */
  if (LIVE && verdict.ok && (scenario.rubric !== undefined || scenario.mustSayText !== undefined)) {
    const judged = await judgeReply(scenario, texts);
    rubric = `judge f${judged.facts}/r${judged.rule}: ${judged.why}`;
    if (judged.facts < 2 || judged.rule < 2) {
      verdict.ok = false;
      verdict.reply = { ok: false, first: rubric };
      verdict.first = rubric;
    }
  }
  if (errors.length > 0 && detail === '') detail = errors[0].slice(0, 200);
  // A harness failure is not a scenario failure and must never read as one: the driver dying is
  // reported as its own error rather than as a trace the agent did not make.
  if (detail !== '') return { scenario, status: 'error', verdict, missing, detail, rubric };

  /* The view is read off the answers this run actually got rather than off a version number: a
     proposal_status result with no `stage` on it is a build where src/proposals/view.ts has a type
     and no builder yet. */
  const sawView = statusReads.some((read) => (read.data as Json)?.stage !== undefined);
  const waiting = [...missing];
  if (scenario.needsView === true && !sawView) waiting.push('stage (the ProposalView)');
  if (scenario.xfailUntil !== undefined) waiting.push(scenario.xfailUntil);

  /* A scenario whose tool is not on the surface cannot pass, whatever the three checks say: the
     call it needed was answered with "not found" and every assertion downstream of it graded a
     hole. Expected-fail is the only honest word for that, so the tool check outranks the verdict. */
  const status: Result['status'] =
    missing.length > 0 ? 'xfail' : verdict.ok ? 'pass' : waiting.length > 0 ? 'xfail' : 'fail';
  return { scenario, status, verdict, missing: waiting, detail, rubric };
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
    env: { ...cleanEnv(), ACC_PORT: String(app.port), ACC_MODE: 'demo', ACC_DATA_DIR: app.dataDir, ...demoRailSpeed() },
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

// ---------- one eval at a time ----------

/* NO TWO RUNS AT ONCE, AND RUN 1 OF THE FIRST LIVE PASS IS WHY. A launch that did not detach was
   relaunched, both processes ran, and the output file held two interleaved runs whose summary
   line disagreed with a mid-run read of the other. Nothing here stopped it: ports come from
   freePort and data dirs from mkdtemp, so two runs never collide on a resource and never learn
   about each other. They collide on the machine, which is 28 apps, 28 agents and the judge's
   votes competing for it, and that load IS the timing every flaky scenario lives in. So a run
   takes a lock and a second one refuses to start, naming the pid that holds it.

   The lock carries a pid rather than a flag, so a run killed outright leaves a file the next run
   steps over instead of a deadlock somebody has to clear by hand. */
const LOCK = path.join(os.tmpdir(), 'phosphor-eval.lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takeLock(): void {
  if (fs.existsSync(LOCK)) {
    let held: { pid?: number; started?: string; mode?: string } = {};
    try {
      held = JSON.parse(fs.readFileSync(LOCK, 'utf8')) as typeof held;
    } catch {
      held = {};
    }
    if (typeof held.pid === 'number' && held.pid !== process.pid && alive(held.pid)) {
      console.log(`[FAIL] another eval already holds this machine: pid ${held.pid}, ${held.mode ?? 'unknown'} mode, started ${held.started ?? 'unknown'}`);
      console.log('Two runs share the load and the output, which is how a run came out interleaved once. Wait for it, or kill that pid.');
      process.exit(2);
    }
    fs.rmSync(LOCK, { force: true });
  }
  fs.writeFileSync(LOCK, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), mode: LIVE ? 'live' : 'scripted' })}\n`);
  const drop = (): void => {
    try {
      const held = JSON.parse(fs.readFileSync(LOCK, 'utf8')) as { pid?: number };
      if (held.pid === process.pid) fs.rmSync(LOCK, { force: true });
    } catch {
      // somebody else's lock, or already gone
    }
  };
  process.on('exit', drop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      drop();
      process.exit(130);
    });
  }
}

// ---------- the run ----------

const scenarios = loadScenarios(SCENARIO_DIR, ONLY);
if (scenarios.length === 0) {
  console.log('no scenarios matched');
  process.exit(1);
}

/* HOW MANY TIMES THE WHOLE SUITE RUNS. One live run is a sample, not a gate: across six runs of
   the first pass only one scenario of the 28 passed every time, and thirteen passed a run and
   failed a later one. A scenario is green here when it passes every run of the same build, and
   the suite is green when every scenario is green or a declared expected-fail. Three is the
   number the lead set. Scripted mode is deterministic and defaults to one. */
const RUNS = (() => {
  const at = args.indexOf('--runs');
  if (at === -1) return LIVE ? 3 : 1;
  const asked = Number(args[at + 1]);
  return Number.isInteger(asked) && asked > 0 && asked <= 10 ? asked : 1;
})();

takeLock();

/* The grader is graded first. It is the one thing in this run with no independent check on it:
   every scenario's verdict comes from it, so a grader that passes everything would turn the whole
   suite green while proving nothing. tests/eval/grade.test.ts feeds it a passing and a failing run
   per check, and this run stops here if any of them is wrong. */
const graderTests = spawnSync(process.execPath, ['--test', path.join(SCENARIO_DIR, 'grade.test.ts')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (graderTests.status !== 0) {
  console.log('[FAIL] the grader\'s own tests do not pass, so no scenario verdict below would mean anything');
  console.log(`${graderTests.stdout ?? ''}${graderTests.stderr ?? ''}`.slice(-2000));
  process.exit(1);
}
console.log(`grader self-test: ${/pass (\d+)/.exec(graderTests.stdout ?? '')?.[1] ?? '?'} checks pass`);

async function runSuite(pass: number): Promise<Result[]> {
  // A stage per run rather than one for all of them: a scenario writes data/demo-state.json into
  // it, so a run reusing a stage starts on the last scenario of the run before it.
  const stage = stageRepo();
  console.log(`PHOSPHOR EVAL: ${scenarios.length} scenario(s), ${LIVE ? 'live' : 'scripted'} mode, run ${pass} of ${RUNS}`);
  console.log(`staged repo ${stage}`);
  console.log('');
  const results: Result[] = [];
  try {
    const available = await probeTools(stage);
    for (const scenario of scenarios) {
      let result: Result;
      try {
        result = await runScenario(stage, scenario, available);
      } catch (error) {
        result = { scenario, status: 'error', verdict: null, missing: [], detail: errText(error), rubric: '' };
      }
      results.push(result);
      const mark = { pass: '[PASS]', fail: '[FAIL]', xfail: '[XFAIL]', error: '[ERROR]' }[result.status];
      const v = result.verdict;
      const checks =
        v === null
          ? ''
          : ` trace:${v.trace.ok ? 'ok' : 'no'} reply:${v.reply.ok ? 'ok' : 'no'} window:${v.window.skipped === true ? 'skip' : v.window.ok ? 'ok' : 'no'} judge:${LIVE ? (result.rubric === '' ? 'n/a' : (/f\d\/r\d/.exec(result.rubric)?.[0] ?? '?')) : 'skipped'}`;
      const first = result.detail !== '' ? result.detail : (v?.first ?? '');
      console.log(`${mark} ${result.scenario.id} ${result.scenario.title}${checks}${first ? `   ${first}` : ''}`);
      if (VERBOSE && result.verdict !== null) {
        console.log(`        trace: ${result.verdict.calls.join(', ')}`);
        console.log(`        reply: ${result.verdict.reply_text.replace(/\n/g, ' | ').slice(0, 900)}`);
      }
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return results;
}

function report(results: Result[]): void {
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
  const counts = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    xfail: results.filter((r) => r.status === 'xfail').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  console.log('='.repeat(96));
  console.log(
    `${results.length} scenarios: ${counts.pass} pass, ${counts.fail} fail, ${counts.xfail} xfail, ${counts.error} error`,
  );
}

const passes: Result[][] = [];
for (let pass = 1; pass <= RUNS; pass += 1) {
  const results = await runSuite(pass);
  passes.push(results);
  report(results);
}

/* ---------- what green means across the runs ----------

   A scenario is green when it passes every run, or is an expected-fail in every run. Anything
   that passed once and failed once is neither, and it reads as flaky here rather than as a pass,
   because a gate that a rerun can talk out of is not a gate. */
if (RUNS > 1) {
  const verdicts = new Map<string, string[]>();
  for (const results of passes) for (const result of results) {
    verdicts.set(result.scenario.id, [...(verdicts.get(result.scenario.id) ?? []), result.status]);
  }
  const short: Record<string, string> = { pass: 'P', fail: 'F', xfail: 'X', error: 'E' };
  console.log('');
  console.log('='.repeat(96));
  console.log(`ACROSS ${RUNS} RUNS of the same build, ${LIVE ? 'live' : 'scripted'} mode`);
  console.log(`${'id'.padEnd(5)}${'runs'.padEnd(10)}${'pass'.padEnd(7)}${'green'.padEnd(8)}last failing assertion`);
  console.log('-'.repeat(96));
  let green = 0;
  let flaky = 0;
  for (const scenario of scenarios) {
    const seen = verdicts.get(scenario.id) ?? [];
    const passed = seen.filter((status) => status === 'pass').length;
    const allPass = seen.length === RUNS && passed === RUNS;
    const allXfail = seen.length === RUNS && seen.every((status) => status === 'xfail');
    const isGreen = allPass || allXfail;
    if (isGreen) green += 1;
    else if (passed > 0) flaky += 1;
    const last = [...passes].reverse().flatMap((results) => results.filter((r) => r.scenario.id === scenario.id));
    const worst = last.find((r) => r.status === 'fail' || r.status === 'error') ?? last[0];
    const note = isGreen ? (allXfail ? `xfail: ${worst?.missing.join(', ') ?? ''}` : '') : (worst?.verdict?.first ?? worst?.detail ?? '');
    console.log(
      `${scenario.id.padEnd(5)}${seen.map((status) => short[status]).join('').padEnd(10)}${`${passed}/${RUNS}`.padEnd(7)}${(isGreen ? 'yes' : 'no').padEnd(8)}${note.slice(0, 46)}`,
    );
  }
  console.log('='.repeat(96));
  console.log(
    `${scenarios.length} scenarios over ${RUNS} runs: ${green} green (passed every run or expected-fail every run), ${scenarios.length - green} not, of which ${flaky} passed at least one run and failed another`,
  );
  process.exit(green === scenarios.length ? 0 : 1);
}

const counts = passes[0].filter((r) => r.status === 'fail' || r.status === 'error').length;
process.exit(counts > 0 ? 1 : 0);
