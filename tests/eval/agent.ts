#!/usr/bin/env node
// The scripted agent: a stand-in for the `claude` binary that costs no model tokens.
//
// src/driver.ts spawns this exactly as it spawns the real one, with the same argv and the same
// lockdown file, and reads the same stream-json back. What is canned is the judgment: the turn's
// text and its tool calls come from the scenario file. What is real is everything else, and that
// is the point of the mode: the calls go to the real MCP server over the transport the driver
// configured, the arguments are accepted or refused by the real schemas, the results are the
// app's own, and the driver's parser is the one that turns them into a trace.
//
// It is not a mock of the agent. It is a recording of one, played back through the real pipes.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Scenario, Step } from './schema.ts';

const PREFIX = 'mcp__phosphor__';

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') out[key] = value;
  return out;
}

// The MCP server this agent was pointed at, read off the argv the driver built. Reading it here
// rather than guessing is what keeps the mode honest: the scripted agent reaches exactly the
// server the real one would have.
function mcpServer(): { command: string; args: string[] } {
  const raw = argValue('--mcp-config');
  if (raw === undefined) die('eval agent: no --mcp-config in argv');
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const phosphor = parsed.mcpServers?.phosphor;
  if (phosphor?.command === undefined) die('eval agent: --mcp-config names no phosphor server');
  return { command: phosphor.command, args: phosphor.args ?? [] };
}

function scenarioFile(): Scenario {
  const repo = process.env.PHOSPHOR_REPO;
  if (repo === undefined) die('eval agent: PHOSPHOR_REPO is unset, so there is no scenario to play');
  // The harness writes this beside the staged repo before it starts the driver. Not argv and not
  // the environment: src/driver.ts controls both, and neither carries anything the caller wrote.
  const file = path.join(repo, '.eval-scenario.json');
  if (!fs.existsSync(file)) die(`eval agent: ${file} is missing`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
}

/* WHAT MAKES A CANNED REPLY WORTH GRADING.

   A `say` line written out by hand would pass its own regex forever, which grades the fixture
   and nothing else. So a `say` may carry `{{2.money.amountIn}}`: step 2's real answer, at that
   path, as the app returned it a moment ago. The figures in a scripted reply are therefore the
   app's own, and a scenario asserting /7\.5425 USDC/ fails the day the app stops saying 7.5425.
   A path that resolves to nothing becomes `?`, which fails the assertion rather than hiding. */
function fill(text: string, results: unknown[]): string {
  return text.replace(/\{\{(\d+)\.([\w.[\]]+)\}\}/g, (_whole, index: string, dotted: string) => {
    let cursor: unknown = results[Number(index)];
    for (const key of dotted.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return '?';
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor === null || cursor === undefined) return '?';
    return typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The first user turn. The driver does not write one until the window (here, the harness) sends
// it, and the real binary waits the same way.
function firstTurn(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== 'user') return;
      const text = (event.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      rl.close();
      resolve(text);
    });
  });
}

async function callTool(client: Client, step: Step, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  if (step.inject?.error !== undefined) return { text: step.inject.error, ok: false };
  if (step.inject?.result !== undefined) return { text: JSON.stringify(step.inject.result), ok: true };
  try {
    // The server registers bare names. The prefix is what Claude Code puts in front of them
    // before it announces them to the model, which is why the init event above carries it and
    // this call does not.
    const res = (await client.callTool({
      name: step.tool ?? '',
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).map((block) => block.text ?? '').join('');
    return { text, ok: res.isError !== true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), ok: false };
  }
}

const scenario = scenarioFile();
const server = mcpServer();
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  cwd: process.env.PHOSPHOR_REPO,
  env: cleanEnv(),
});
const client = new Client({ name: 'phosphor-eval-agent', version: '0.1.0' });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((tool) => `${PREFIX}${tool.name}`);

// The init event the driver checks before it lets anything run: the announced surface, the MCP
// server's status, and no memory file. Every name here came off the live server a line ago, so a
// surface the driver would refuse is one the app really announced.
emit({
  type: 'system',
  subtype: 'init',
  session_id: argValue('--session-id') ?? 'eval',
  tools,
  mcp_servers: [{ name: 'phosphor', status: 'connected' }],
  memory_paths: {},
});

await firstTurn();

let calls = 0;
const results: unknown[] = [];
for (const [index, step] of scenario.script.entries()) {
  if (step.waitMs !== undefined && step.waitMs > 0) await sleep(step.waitMs);
  const content: Array<Record<string, unknown>> = [];
  if (step.say !== undefined) content.push({ type: 'text', text: fill(step.say, results) });
  const id = `toolu_eval_${index}`;
  // An argument can name an earlier answer the same way a `say` can, which is the only way a
  // fixture reaches a proposal id: the app mints it at run time and no file can hold it.
  const args = JSON.parse(fill(JSON.stringify(step.args ?? {}), results)) as Record<string, unknown>;
  if (step.tool !== undefined) {
    content.push({ type: 'tool_use', id, name: `${PREFIX}${step.tool}`, input: args });
  }
  if (content.length > 0) emit({ type: 'assistant', message: { role: 'assistant', content } });
  if (step.tool === undefined) {
    results.push(null);
    continue;
  }
  calls += 1;
  const result = await callTool(client, step, args);
  try {
    results.push(JSON.parse(result.text));
  } catch {
    results.push(result.text);
  }
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result.text }], is_error: !result.ok },
      ],
    },
  });
}

emit({ type: 'result', subtype: 'success', is_error: false, num_turns: calls });

await client.close();
try {
  if (transport.pid !== null && transport.pid !== undefined) process.kill(transport.pid, 'SIGKILL');
} catch {
  // already gone
}
process.exit(0);
