// The proxy dials the port the registration names.
//
// Every registration the app writes and every line it hands out carries PHOSPHOR_PORT (the name
// src/config.ts reads first, ACC_PORT second). The proxy read ACC_PORT alone, so an agent
// registered by the app dialled config.json's 4177 whatever port the app was running on, and
// answered "The control app is not running" against an app that was. Found by the C review on
// 2026-09-20. Driven the way the app's registration drives it: src/mcp.ts spawned as a stdio
// server with only PHOSPHOR_PORT in its environment, against a stub app that records who said
// hello. The data directory is resolved through the same two names, so its PHOSPHOR name is
// proven on the same spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Seen = { op: string; session: string; secret: string };

function stubApp(): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Partial<Seen>;
      seen.push({ op: String(body.op), session: String(body.session), secret: String(body.secret ?? '') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, seat: 'held' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

function until(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

/* The environment a registration gives the proxy: this process's, with every port and data
   directory name taken out first, then only what the test sets. */
function registrationEnv(set: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  for (const name of ['PHOSPHOR_PORT', 'ACC_PORT', 'PHOSPHOR_DATA_DIR', 'ACC_DATA_DIR', 'PHOSPHOR_SEAT', 'PHOSPHOR_CONFIG_DIR']) delete env[name];
  return { ...env, ...set };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    cwd: ROOT,
    env,
  });
  const client = new Client({ name: 'phosphor-port-test', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

test('with only PHOSPHOR_PORT set, the proxy dials that port and reads its seat from PHOSPHOR_DATA_DIR', async () => {
  const app = await stubApp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-proxy-port-'));
  fs.writeFileSync(path.join(dataDir, 'agent.secret'), 'seat-from-the-phosphor-name\n', { mode: 0o600 });
  const client = await connect(registrationEnv({
    PHOSPHOR_PORT: String(app.port),
    PHOSPHOR_DATA_DIR: dataDir,
    PHOSPHOR_SESSION: 'port-under-test',
  }));
  try {
    const said = await until(() => app.seen.some((s) => s.op === 'hello' && s.session === 'port-under-test'), 3000);
    assert.ok(said, `the proxy never reached the app on PHOSPHOR_PORT=${app.port}; it saw ${JSON.stringify(app.seen)}`);
    const hello = app.seen.find((s) => s.op === 'hello' && s.session === 'port-under-test');
    assert.equal(hello?.secret, 'seat-from-the-phosphor-name', 'the seat did not come from PHOSPHOR_DATA_DIR');
  } finally {
    await client.close().catch(() => {});
    app.close();
  }
});

test('PHOSPHOR_PORT wins over ACC_PORT, the order src/config.ts reads them in', async () => {
  const named = await stubApp();
  const other = await stubApp();
  const client = await connect(registrationEnv({
    PHOSPHOR_PORT: String(named.port),
    ACC_PORT: String(other.port),
    PHOSPHOR_SESSION: 'precedence-under-test',
  }));
  try {
    const said = await until(() => named.seen.some((s) => s.op === 'hello'), 3000);
    assert.ok(said, 'the proxy never reached the app PHOSPHOR_PORT names');
    assert.equal(other.seen.length, 0, `ACC_PORT's app heard ${JSON.stringify(other.seen)}`);
  } finally {
    await client.close().catch(() => {});
    named.close();
    other.close();
  }
});
