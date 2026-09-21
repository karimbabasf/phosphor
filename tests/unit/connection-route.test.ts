// The connection route: one builder, per agent, read by the window through the driver door and by
// the shell's menu item through GET /api/connection, both answering the same bytes.
//
// It used to be `claude mcp add phosphor -- node .../src/mcp.ts` for everyone, with no port and
// no data directory, while the Rust menu item built a different line that had them. The line
// now comes from src/agents-catalog.ts for the agent named, the agent picked, or Claude Code,
// and carries the environment the proxy needs in every mode. The picker's own three actions
// (scan, check, pick) sit on the same door and are driven here over a real HTTP server, so the
// token and origin gates are the real ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { handleConnectionRead, handleMutation, scopeSentence } from '../../src/http/mutation.ts';
import { agentById } from '../../src/agents-catalog.ts';
import type { Ctx } from '../../src/http/context.ts';
import { readPick, writePick } from '../../src/agents-catalog.ts';
import { createAgents } from '../../src/agents.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TOKEN = 'a'.repeat(64);
const STATES = new Set(['installed_and_logged_in', 'installed_not_logged_in', 'not_installed', 'unknown_client']);

type Line = { type: string; msg: string; data?: Record<string, unknown> };
type App = { url: string; dataDir: string; lines: Line[]; running: { value: boolean }; close: () => Promise<void> };

async function boot(): Promise<App> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-connection-'));
  const lines: Line[] = [];
  const running = { value: false };
  const ctx = {
    token: TOKEN,
    cfg: { port: 4203, dataDir },
    audit: { append: (type: string, msg: string, data?: Record<string, unknown>) => lines.push({ type, msg, data }) },
    agents: createAgents(),
    sse: { broadcastState: () => {} },
    chats: { all: () => [{ driver: { status: () => ({ state: running.value ? 'ready' : 'off', sessionId: '', running: running.value }) } }] },
    getPolicy: () => ({ outbound: { humanClickAboveUsd: 100, autoApproveDailyUsd: 500, maxPerTransactionUsd: 10000 } }),
  } as unknown as Ctx;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/connection') return handleConnectionRead(ctx, req, res, url);
    void handleMutation(ctx, url.pathname, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    dataDir,
    lines,
    running,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(app: App, route: string, body: Record<string, unknown>, token: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.url, host: '127.0.0.1' },
    body: JSON.stringify(token === null ? body : { ...body, token }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(app: App, route: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}${route}`, { headers: { host: '127.0.0.1' } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const SERVER = path.join(ROOT, 'src', 'mcp.ts');

test('with nothing picked the line is Claude Code\'s, with this boot\'s port and data directory and node on PATH', async () => {
  const app = await boot();
  try {
    const { status, json } = await post(app, '/api/driver', { action: 'connection' });
    assert.equal(status, 200);
    assert.equal(json.agent, 'claude');
    assert.equal(json.command, `claude mcp add phosphor --scope user --env PHOSPHOR_PORT=4203 --env PHOSPHOR_DATA_DIR=${app.dataDir} -- node ${SERVER}`);
    assert.equal(json.inApp, true);
    assert.equal(json.registers, true);
    assert.equal(json.picked, null);
    assert.deepEqual(json.connected, []);
  } finally {
    await app.close();
  }
});

test('the line is built per agent, never the Claude line for someone else, and an unknown name is refused', async () => {
  const app = await boot();
  try {
    const lines: Record<string, unknown> = {};
    for (const agent of ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop']) {
      const { status, json } = await post(app, '/api/driver', { action: 'connection', agent });
      assert.equal(status, 200, agent);
      assert.equal(json.agent, agent);
      lines[agent] = json.command;
    }
    assert.match(String(lines.codex), /^codex mcp add phosphor --env PHOSPHOR_PORT=4203 /);
    assert.match(String(lines.hermes), /^hermes mcp add phosphor --command node --env PHOSPHOR_PORT=4203 PHOSPHOR_DATA_DIR=.* --args .*src\/mcp\.ts$/);
    assert.match(String(lines.grok), /^grok mcp add phosphor node --scope user --env PHOSPHOR_PORT=4203 /);
    assert.match(String(lines.mcp), /^PHOSPHOR_PORT=4203 PHOSPHOR_DATA_DIR=.* node .*src\/mcp\.ts$/);
    assert.equal(lines.desktop, null);
    assert.equal(new Set(Object.values(lines).filter((l) => l !== null)).size, 5);

    const bad = await post(app, '/api/driver', { action: 'connection', agent: 'clippy' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test('the picked agent is the default, and the shell\'s GET answers the same bytes as the window\'s POST', async () => {
  const app = await boot();
  try {
    writePick(app.dataDir, 'codex');
    const viaPost = await post(app, '/api/driver', { action: 'connection' });
    assert.equal(viaPost.json.agent, 'codex');
    assert.equal(viaPost.json.picked, 'codex');
    const viaGet = await get(app, '/api/connection');
    assert.equal(viaGet.status, 200);
    assert.equal(viaGet.json.command, viaPost.json.command);
    assert.match(String(viaGet.json.command), /^codex mcp add phosphor /);
    // The menu item can ask for another agent by name, and is refused an unknown one.
    const named = await get(app, '/api/connection?agent=grok');
    assert.match(String(named.json.command), /^grok mcp add phosphor /);
    assert.equal((await get(app, '/api/connection?agent=clippy')).status, 400);
  } finally {
    await app.close();
  }
});

test('packaged, the line names the bundled runtime this process runs on, in every agent\'s line', async () => {
  const app = await boot();
  const before = process.env.PHOSPHOR_APP_DATA;
  process.env.PHOSPHOR_APP_DATA = '1';
  try {
    for (const agent of ['claude', 'codex', 'hermes', 'grok', 'mcp']) {
      const { json } = await post(app, '/api/driver', { action: 'connection', agent });
      assert.ok(String(json.command).includes(process.execPath), `${agent}: ${String(json.command)}`);
      assert.ok(!/ node /.test(String(json.command)), `${agent} still says node on PATH`);
    }
  } finally {
    if (before === undefined) delete process.env.PHOSPHOR_APP_DATA;
    else process.env.PHOSPHOR_APP_DATA = before;
    await app.close();
  }
});

test('a pick is written to agent.json with an audit line, and its check answers one of the four states inside three seconds', async () => {
  const app = await boot();
  try {
    const started = Date.now();
    const { status, json } = await post(app, '/api/driver', { action: 'agent-pick', agent: 'desktop' });
    assert.ok(Date.now() - started < 3_000);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const check = json.check as Record<string, unknown>;
    assert.ok(STATES.has(String(check.state)));
    assert.equal(check.state, 'unknown_client');
    assert.equal(check.probed, false);
    assert.equal(json.registered, false);
    assert.equal(json.registrationFailed, false);
    assert.equal(json.command, null);
    assert.equal(readPick(app.dataDir)?.agent, 'desktop');
    assert.ok(app.lines.some((l) => l.type === 'app_start' && /picked Claude Desktop or a chat app/.test(l.msg)), 'no audit line for the pick');

    // The same door names the picked agent afterwards, and the scan covers the four the app can probe.
    const check2 = await post(app, '/api/driver', { action: 'agent-check' });
    assert.equal((check2.json.check as Record<string, unknown>).agent, 'desktop');
    const scan = await post(app, '/api/driver', { action: 'agent-scan' });
    assert.deepEqual((scan.json.agents as Array<{ agent: string }>).map((a) => a.agent), ['claude', 'codex', 'hermes', 'grok']);
    assert.ok((scan.json.agents as Array<{ state: string }>).every((a) => STATES.has(a.state)));
    assert.equal(scan.json.picked, 'desktop');
  } finally {
    await app.close();
  }
});

/* The routes check with the process's own PATH and HOME (src/http/mutation.ts checkFor), so a Mac
   with no agent on it is played by pointing both at nothing for the length of one test. */
async function withNoAgents<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = '/nonexistent';
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-no-agents-'));
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
}

test('a pick of an agent that is not on this Mac says it is not here yet, and stores nothing', async () => {
  const app = await boot();
  try {
    await withNoAgents(async () => {
      // Nothing picked before: the fresh pick of a missing agent is "not yet", never "no longer".
      const fresh = await post(app, '/api/driver', { action: 'agent-pick', agent: 'codex' });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.json.ok, true);
      const check = fresh.json.check as Record<string, unknown>;
      assert.equal(check.state, 'not_installed');
      assert.equal(check.sentence, 'Codex is not on this Mac yet. Install it, then come back to this screen.');
      assert.equal(fresh.json.registered, false);
      assert.equal(fresh.json.picked, null);
      assert.equal(readPick(app.dataDir), null, 'a missing agent was stored as the pick');
      assert.ok(app.lines.some((l) => l.type === 'app_start' && /picked Codex, which is not on this Mac: nothing stored/.test(l.msg)), 'no audit line for the attempt');

      // An earlier pick stays where it was: the sentence is still "not yet", and the pick is untouched.
      writePick(app.dataDir, 'mcp');
      const again = await post(app, '/api/driver', { action: 'agent-pick', agent: 'codex' });
      assert.equal((again.json.check as Record<string, unknown>).sentence, 'Codex is not on this Mac yet. Install it, then come back to this screen.');
      assert.equal(again.json.picked, 'mcp');
      assert.equal(readPick(app.dataDir)?.agent, 'mcp');
    });
  } finally {
    await app.close();
  }
});

test('the agent picked earlier that has since gone says it is no longer on this Mac, on a check and on a re-pick', async () => {
  const app = await boot();
  try {
    // Picked while it was on this Mac (the file the route writes), then removed.
    writePick(app.dataDir, 'codex');
    await withNoAgents(async () => {
      const check = await post(app, '/api/driver', { action: 'agent-check' });
      assert.equal((check.json.check as Record<string, unknown>).state, 'not_installed');
      assert.equal((check.json.check as Record<string, unknown>).sentence, 'Codex is no longer on this Mac.');
      const repick = await post(app, '/api/driver', { action: 'agent-pick', agent: 'codex' });
      assert.equal((repick.json.check as Record<string, unknown>).sentence, 'Codex is no longer on this Mac.');
      assert.equal(repick.json.picked, 'codex');
      assert.equal(readPick(app.dataDir)?.agent, 'codex');
    });
  } finally {
    await app.close();
  }
});

test('a pick is refused with one sentence while an agent this app started is running, and nothing is written', async () => {
  const app = await boot();
  try {
    app.running.value = true;
    const { status, json } = await post(app, '/api/driver', { action: 'agent-pick', agent: 'codex' });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.refused, 'running');
    assert.equal(json.sentence, 'Your assistant is running. Turn it off in the chat, then change it here.');
    assert.equal(readPick(app.dataDir), null);
    // Picking the agent that is already picked is not a switch, so it is not refused.
    app.running.value = false;
    await post(app, '/api/driver', { action: 'agent-pick', agent: 'mcp' });
    app.running.value = true;
    const same = await post(app, '/api/driver', { action: 'agent-pick', agent: 'mcp' });
    assert.equal(same.json.ok, true);
  } finally {
    await app.close();
  }
});

test('the picker\'s actions carry the window token like every other write; the shell\'s read does not need one', async () => {
  const app = await boot();
  try {
    for (const action of ['connection', 'agent-scan', 'agent-check', 'agent-pick']) {
      const { status } = await post(app, '/api/driver', { action, agent: 'mcp' }, null);
      assert.equal(status, 403, action);
    }
    assert.equal(readPick(app.dataDir), null);
    assert.equal((await get(app, '/api/connection')).status, 200);
  } finally {
    await app.close();
  }
});

test('an agent the app registers is told, behind Details, that the registration reaches every session on this Mac, with the daily auto ceiling as the cap', async () => {
  const app = await boot();
  try {
    for (const agent of ['claude', 'codex', 'hermes', 'grok']) {
      const { json } = await post(app, '/api/driver', { action: 'agent-check', agent });
      const details = (json.check as { details: string[] }).details;
      const name = agentById(agent)!.name;
      assert.ok(details.includes(`Phosphor will be available in every ${name} session on this Mac, not just one folder, and moves under your threshold run on their own up to $500.00 a day.`), `${agent}: ${details.join(' | ')}`);
      assert.ok(!String((json.check as { sentence: string }).sentence).includes('every'), 'the scope sentence reached the visible sentence');
    }
    for (const agent of ['mcp', 'desktop']) {
      const { json } = await post(app, '/api/driver', { action: 'agent-check', agent });
      assert.ok(!(json.check as { details: string[] }).details.some((d) => d.includes('every')), agent);
    }
    assert.equal(scopeSentence(agentById('codex')!, null), 'Phosphor will be available in every Codex session on this Mac, not just one folder, and moves under your threshold run on their own up to your daily auto ceiling.');
  } finally {
    await app.close();
  }
});
