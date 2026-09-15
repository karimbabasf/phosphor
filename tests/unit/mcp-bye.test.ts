// The proxy's goodbye reaches the app, whatever order the shutdown signals arrive in.
//
// Closing an MCP client ends the proxy's stdin, and that fires stdin 'end', stdin 'close' and
// later SIGTERM within a few milliseconds of each other. Each one asks for the bye and exits
// when the bye is done. Found 2026-09-15 under a loaded test run: the first trigger started the
// bye, the second saw the bye already started, took that for done, and exited the process
// before the request had left the socket. The seat stayed held for a TTL, and the next
// unrecognised session was refused with a full roster. It only showed under load because an
// idle hello leaves a pooled socket the bye can write to at once; a hello still in flight
// makes the bye open a new connection, which is the tick the exit won.
//
// Driven against a stub app that holds the hello open, so the bye needs its own connection
// and the race is the one the test is about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Seen = { op: string; session: string };

function stubApp(holdHelloMs: number): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Seen;
      seen.push({ op: body.op, session: body.session });
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, seat: 'held' }));
      };
      if (body.op === 'hello') setTimeout(answer, holdHelloMs);
      else answer();
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

test('closing the client sends the bye after the hello, even while the hello is still in flight', async () => {
  const app = await stubApp(300);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env.ACC_PORT = String(app.port);
  env.PHOSPHOR_SESSION = 'bye-under-test';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    cwd: ROOT,
    env,
  });
  const client = new Client({ name: 'phosphor-bye-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    assert.ok(await until(() => app.seen.some((s) => s.op === 'hello'), 3000), 'the proxy never said hello');
    await client.close();
    const said = await until(() => app.seen.some((s) => s.op === 'bye'), 3000);
    assert.ok(said, `the proxy exited without saying bye; the app saw ${JSON.stringify(app.seen)}`);
    const ops = app.seen.filter((s) => s.session === 'bye-under-test').map((s) => s.op);
    assert.equal(ops.indexOf('hello') < ops.indexOf('bye'), true, `the bye overtook the hello: ${ops.join(', ')}`);
  } finally {
    await client.close().catch(() => {});
    app.close();
  }
});
