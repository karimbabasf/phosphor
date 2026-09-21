#!/usr/bin/env node
// The anxiety harness's scripted agent: what sits in the window's own conversation while the
// screenshots are taken.
//
// tests/eval/agent.ts plays one canned turn and exits, which is right for an eval that grades one
// exchange. A situation is a MOMENT in a longer conversation: the person asks, the card lands,
// the card moves through its stages, and the app tells the agent when the move ended
// (src/http/ended.ts) so it can say one sentence. That last part needs the child to still be
// there after its turn, so this one stays up and answers every turn the driver writes:
//
//   a human turn    plays the steps in <PHOSPHOR_REPO>/.anxiety-turn.json, which the harness
//                   writes before it posts the prompt: text to say, tools to call, waits.
//   an app notice   (the "[phosphor: the swap you proposed ... has ended: ...]" line) is answered
//                   with one sentence built from the stage words the notice carries, the same
//                   words src/proposals/view.ts prints on the card. Synthesized, not a model's.
//
// Everything else is real: the calls go through the real MCP server the driver configured, the
// arguments meet the real schemas, the answers are the app's own, and the window draws the card
// from the tool_data event exactly as it does for a live agent.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STAGE_LABEL } from '../../src/proposals/view.ts';
import type { ProposalStage } from '../../src/proposals/view.ts';

const PREFIX = 'mcp__phosphor__';
export const TURN_FILE = '.anxiety-turn.json';

export type TurnStep = {
  say?: string;
  tool?: string;
  args?: Record<string, unknown>;
  waitMs?: number;
};

export type Turn = { steps: TurnStep[] };

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

function mcpServer(): { command: string; args: string[] } {
  const raw = argValue('--mcp-config');
  if (raw === undefined) die('anxiety agent: no --mcp-config in argv');
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const phosphor = parsed.mcpServers?.phosphor;
  if (phosphor?.command === undefined) die('anxiety agent: --mcp-config names no phosphor server');
  return { command: phosphor.command, args: phosphor.args ?? [] };
}

/* `{{2.money.amountIn}}` in a say or an argument is step 2's real answer at that path, so a
   scripted sentence carries the app's own figures and a proposal id the app minted a moment ago.
   `{{0.view.sentence|the move}}` falls back to the words after the bar when the path resolves to
   nothing (a refusal the app answered without a row), and `{{0}}` is the whole answer when it
   was plain text. A path with no fallback that resolves to nothing becomes `?`, which is visible
   rather than hidden. */
export function fill(text: string, results: unknown[]): string {
  return text.replace(/\{\{(\d+)(?:\.([\w.[\]]+))?(?:\|([^}]*))?\}\}/g, (_whole, index: string, dotted: string | undefined, fallback: string | undefined) => {
    let cursor: unknown = results[Number(index)];
    for (const key of dotted === undefined ? [] : dotted.split('.')) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor === null || cursor === undefined) return fallback ?? '?';
    return typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
  });
}

/* The app's notice, recognised by the fence src/http/ended.ts writes. The role text rides in on
   the first turn of a child, so a notice can arrive with the role text in front of it; the test
   is on the fence, never on the start of the turn. */
const NOTICE = /\[phosphor: the (.+?) you proposed \((.+?), proposal [^)]+\) has ended: ([^.]+)\.(.*?)\]/s;

// One sentence per ending, in the card's own words (STAGE_LABEL) so the reply and the card
// cannot disagree. What ended, how, what it means for the money.
const ENDED: Partial<Record<ProposalStage, (kind: string, legs: string, rest: string) => string>> = {
  confirmed: (kind, legs, rest) => {
    const arrived = /(\S+ \S+) arrived\./.exec(rest);
    return arrived === null
      ? `Done: the ${kind} of ${legs} went through and your balance shows it.`
      : `Done: the ${kind} of ${legs} went through, and ${arrived[1]} arrived in your balance.`;
  },
  declined: (kind, legs) => `You said no to the ${kind} of ${legs}, so nothing moved.`,
  refused: (kind, legs) => `A rule you set stopped the ${kind} of ${legs}, so nothing moved. You can change that rule in the window.`,
  failed: (kind, legs) => `The ${kind} of ${legs} did not go through and nothing more will be signed. Check your balance before doing anything else.`,
  FAILED: (kind, legs) => `The ${kind} of ${legs} could not finish and nothing more will be signed. Check your balance before doing anything else.`,
  NOT_FOUND_OR_NOT_VALID: (kind, legs) => `The ${kind} of ${legs} did not settle before its price expired, so nothing moved. Ask me for a fresh price to try again.`,
  REFUNDED: (kind, legs) => `The ${kind} of ${legs} could not finish and the money came back to you. Check your balance before doing anything else.`,
  stalled: (kind, legs) => `The ${kind} of ${legs} is running late and nothing has changed since its last update. The app keeps checking and will settle it when the venue credits it.`,
};

const LABEL_TO_STAGE = new Map<string, ProposalStage>(
  (Object.entries(STAGE_LABEL) as Array<[ProposalStage, string]>).map(([stage, label]) => [label, stage]),
);

export function endingReply(notice: string): string | null {
  const m = NOTICE.exec(notice);
  if (m === null) return null;
  const [, kind, legs, label, rest] = m;
  const stage = LABEL_TO_STAGE.get(label.trim());
  const say = stage === undefined ? undefined : ENDED[stage];
  return say === undefined ? `The ${kind} of ${legs} has ended: ${label.trim()}.` : say(kind, legs, rest);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(event: { message?: { content?: Array<{ type?: string; text?: string }> } }): string {
  return (event.message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).map((block) => block.text ?? '').join('');
    return { text, ok: res.isError !== true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), ok: false };
  }
}

function readTurn(repo: string): Turn {
  const file = path.join(repo, TURN_FILE);
  if (!fs.existsSync(file)) return { steps: [{ say: 'Nothing to do.' }] };
  const turn = JSON.parse(fs.readFileSync(file, 'utf8')) as Turn;
  // Consumed: the next human turn plays the next file the harness writes, never this one again.
  fs.rmSync(file, { force: true });
  return turn;
}

async function playTurn(client: Client, turn: Turn, counter: { n: number }): Promise<number> {
  let calls = 0;
  const results: unknown[] = [];
  for (const step of turn.steps) {
    if (step.waitMs !== undefined && step.waitMs > 0) await sleep(step.waitMs);
    const content: Array<Record<string, unknown>> = [];
    if (step.say !== undefined) content.push({ type: 'text', text: fill(step.say, results) });
    counter.n += 1;
    const id = `toolu_anx_${counter.n}`;
    const args = JSON.parse(fill(JSON.stringify(step.args ?? {}), results)) as Record<string, unknown>;
    if (step.tool !== undefined) content.push({ type: 'tool_use', id, name: `${PREFIX}${step.tool}`, input: args });
    if (content.length > 0) emit({ type: 'assistant', message: { role: 'assistant', content } });
    if (step.tool === undefined) {
      results.push(null);
      continue;
    }
    calls += 1;
    const result = await callTool(client, step.tool, args);
    try {
      results.push(JSON.parse(result.text));
    } catch {
      results.push(result.text);
    }
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result.text }], is_error: !result.ok }],
      },
    });
  }
  return calls;
}

async function main(): Promise<void> {
  const repo = process.env.PHOSPHOR_REPO;
  if (repo === undefined) die('anxiety agent: PHOSPHOR_REPO is unset');
  const server = mcpServer();
  const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: repo, env: cleanEnv() });
  const client = new Client({ name: 'phosphor-anxiety-agent', version: '0.1.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => `${PREFIX}${tool.name}`);
  emit({
    type: 'system',
    subtype: 'init',
    session_id: argValue('--session-id') ?? 'anxiety',
    tools,
    mcp_servers: [{ name: 'phosphor', status: 'connected' }],
    memory_paths: {},
  });

  const counter = { n: 0 };
  const rl = readline.createInterface({ input: process.stdin });
  // Turns are played one after another, in the order they arrived, never interleaved.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type !== 'user') return;
    const text = textOf(event);
    chain = chain.then(async () => {
      const ending = endingReply(text);
      if (ending !== null) {
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ending }] } });
        emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 0 });
        return;
      }
      const calls = await playTurn(client, readTurn(repo), counter);
      emit({ type: 'result', subtype: 'success', is_error: false, num_turns: calls });
    });
  });
  rl.on('close', async () => {
    await chain.catch(() => undefined);
    await client.close().catch(() => undefined);
    try {
      if (transport.pid !== null && transport.pid !== undefined) process.kill(transport.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    process.exit(0);
  });
}

// Importable for its pure parts (fill, endingReply); the child runs only when spawned as one.
// Real paths on both sides: the loader names a module by its real path, and a stage under
// /var/folders is really under /private/var/folders.
function isEntry(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) void main();
