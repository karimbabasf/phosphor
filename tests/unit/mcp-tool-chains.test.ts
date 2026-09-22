// Which chains the propose tools will accept, read off the tool schemas the agent actually sees.
//
// The schemas are zod inside src/mcp.ts and JSON Schema by the time a model reads them, and the
// second one is the interface: a chain missing there cannot be named however well the rails cope.
// So this test starts the MCP process the way a client does and asks it for its tool list. No app
// is running, which the process tolerates: its hello fails and its tools register regardless.
//
// Run: node --test tests/unit/mcp-tool-chains.test.ts

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.join(import.meta.dirname, '..', '..');

type Field = { enum?: string[]; anyOf?: Field[]; $ref?: string };
type JsonSchema = { properties?: Record<string, Field> };
type ToolRow = { name: string; inputSchema: JsonSchema };

let client: Client | null = null;
let pid: number | null = null;
let tools: ToolRow[] = [];

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    cwd: ROOT,
    // A port nothing listens on, so the process never reaches a live app and never takes a seat.
    env: { ...process.env, ACC_PORT: '1', PHOSPHOR_ROLE: '' } as Record<string, string>,
  });
  client = new Client({ name: 'phosphor-tool-chains', version: '0.1.0' });
  await client.connect(transport);
  pid = transport.pid;
  tools = (await client.listTools()).tools as unknown as ToolRow[];
});

after(async () => {
  if (client !== null) {
    try {
      await client.close();
    } catch {
      // already down
    }
    client = null;
  }
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, which is the expected case
    }
    pid = null;
  }
});

function enumOf(tool: string, field: string): string[] {
  const row = tools.find((t) => t.name === tool);
  assert.ok(row !== undefined, `no tool called ${tool}`);
  /* Two fields of one enum are drawn once and pointed at: toChain is a $ref back to chain, and
     an optional field can come wrapped in an anyOf. Both lead to the same list of values. */
  let spec = row.inputSchema.properties?.[field];
  const ref = spec?.$ref;
  if (typeof ref === 'string') {
    const to = ref.split('/').pop() ?? '';
    spec = row.inputSchema.properties?.[to];
  }
  const values = spec?.enum ?? spec?.anyOf?.flatMap((a) => a.enum ?? []);
  assert.ok(Array.isArray(values) && values.length > 0, `${tool}.${field} is not an enum`);
  return values;
}

test('a swap may name any chain the venue lists a token on', () => {
  for (const field of ['chain', 'toChain']) {
    const chains = enumOf('propose_swap', field);
    assert.ok(chains.includes('ton'), `${field} does not take ton`);
    assert.ok(chains.includes('polygon'), `${field} does not take polygon`);
    assert.ok(chains.includes('base'), `${field} does not take base`);
    assert.ok(!chains.includes('madeupchain'));
  }
});

/* A send may name a chain the app cannot decode an address for; the refusal for that is the pay
   rail's and it names the decoder, because "not in the enum" would read as "no such chain". */
test('a send may name any chain, and the unpayable ones are refused later by name', () => {
  const where = enumOf('propose_send', 'where');
  assert.ok(where.includes('ton'));
  assert.ok(where.includes('intents'));
  assert.ok(where.includes('eth'));
  assert.ok(!where.includes('madeupchain'));
});
