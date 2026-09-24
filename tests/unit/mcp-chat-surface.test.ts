// What the window's own agent is handed by the MCP server: the tools a money chat uses, told in
// plain words, and the three swap reads that let it check before it proposes. The server runs
// here for real over stdio, with no app behind it (nothing is called, only listed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { EXPECTED_CHAT_TOOLS_SORTED, EXPECTED_TOOLS_SORTED } from '../tool-surface.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };

async function listed(surface: 'chat' | 'terminal'): Promise<{ tools: Listed[]; instructions: string }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-mcp-surface-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PHOSPHOR_DATA_DIR: data,
      // Port 9 answers nothing: listing needs no app, and no call is made.
      PHOSPHOR_PORT: '9',
      PHOSPHOR_SEAT: 'surface-test',
      PHOSPHOR_SESSION: 'surface-test',
      ...(surface === 'chat' ? { PHOSPHOR_SURFACE: 'chat' } : {}),
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'surface-test', version: '0' });
  await client.connect(transport);
  const instructions = client.getInstructions() ?? '';
  const { tools } = await client.listTools();
  await client.close();
  fs.rmSync(data, { recursive: true, force: true });
  return { tools: tools as Listed[], instructions };
}

// Every description the model reads: the tool's own and each argument's.
function said(tool: Listed): string {
  const out: string[] = [tool.description ?? ''];
  (function walk(node: unknown): void {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'description' && typeof v === 'string') out.push(v);
        else walk(v);
      }
    }
  })(tool.inputSchema);
  return out.join(' ');
}

test('the window\'s agent holds the chat surface, and an agent in a terminal holds every tool', async () => {
  const chat = await listed('chat');
  assert.deepEqual(chat.tools.map((t) => t.name).sort(), [...EXPECTED_CHAT_TOOLS_SORTED]);
  assert.ok(chat.instructions.length < 120, 'the chat is handed the rules its system prompt already carries');
  const terminal = await listed('terminal');
  assert.deepEqual(terminal.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS_SORTED]);
  assert.ok(terminal.instructions.includes('Call `start` first'));
});

/* The words the agent parroted on 2026-09-23 came from somewhere, and the tool descriptions were
   one of the places (R3: "minAmountOut is the floor", "quote its words", "solver"). diagnose keeps
   one sentence naming what it never returns (a handle, a quote signature, a key), because
   tests/injection.test.ts holds that promise. */
test('no chat tool tells the agent in words it must not use', async () => {
  const { tools } = await listed('chat');
  const words = ['floor', 'solver', 'click line', 'click threshold', 'intents balance', 'simulation', '1Click', 'base units', 'quote its words', 'pocket', 'verdict', 'nonce'];
  for (const tool of tools) {
    const text = said(tool);
    for (const word of words) assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text), `${tool.name} says ${word}`);
    if (tool.name !== 'diagnose') assert.ok(!/\bhandle\b/i.test(text), `${tool.name} says handle`);
  }
});

test('no chat tool sends the agent to re-read a move it just proposed', async () => {
  const { tools } = await listed('chat');
  for (const tool of tools) {
    const text = said(tool);
    assert.ok(!/read proposal_status for/i.test(text), `${tool.name} still orders a read after the move`);
    assert.ok(!/before saying anything is done/i.test(text), `${tool.name} still orders a read before every answer`);
  }
});

test('propose_swap and swap_quote take "all" or an exact amount as text', async () => {
  const { tools } = await listed('chat');
  for (const name of ['propose_swap', 'swap_quote']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    const amountIn = (tool.inputSchema.properties as Record<string, { anyOf?: Array<{ type?: string }>; description?: string }>).amountIn;
    assert.deepEqual(amountIn.anyOf?.map((a) => a.type).sort(), ['number', 'string'], `${name} amountIn is not text or a number`);
    assert.ok(amountIn.description?.includes('"all"'));
  }
});

test('the swap reads take exactly propose_swap\'s own names, and swap_check one id', async () => {
  const { tools } = await listed('chat');
  const args = (name: string) => Object.keys((tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as object).sort();
  assert.deepEqual(args('swap_quote'), ['amountIn', 'chain', 'fromSymbol', 'toChain', 'toSymbol']);
  assert.deepEqual(args('swap_assets'), ['limit', 'query']);
  assert.deepEqual(args('swap_check'), ['id']);
  const swap = args('propose_swap');
  for (const name of ['amountIn', 'chain', 'fromSymbol', 'toChain', 'toSymbol']) assert.ok(swap.includes(name), name);
});

// The app finds each coin itself (src/proposals/swap-reads.ts, resolveSwapSides), so a network the
// agent guessed could only pick a coin the person did not mean.
test('a swap names a network only when the person did: neither is required, and the text says so', async () => {
  const { tools } = await listed('chat');
  for (const name of ['propose_swap', 'swap_quote']) {
    const tool = tools.find((t) => t.name === name);
    const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    assert.ok(!required.includes('chain') && !required.includes('toChain'), `${name} still requires a network: ${required.join(', ')}`);
    assert.match(tool?.description ?? '', /only when they named that network/, name);
  }
});

test('what the chat is handed stays well under half of what it was', async () => {
  /* 62,641 characters of tool JSON on 2026-09-22 (46 tools, measured over stdio like this). The
     chat surface drops ten tools and every description says what the tool does and its limits,
     without the history of why. Measured 43,541. */
  const { tools } = await listed('chat');
  const size = JSON.stringify(tools).length;
  assert.ok(size < 46_000, `the chat's tools are ${size} characters of JSON`);
});
