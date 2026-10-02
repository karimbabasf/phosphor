// Every read under /api/ needs the window token or the read key (src/http/read-gate.ts). The
// audit found the GET table open to any process that could reach 127.0.0.1, under any macOS
// account: GET /api/state handed out the ledger, the policy with the size of a move that needs no
// click, the pending moves and the wallet's address, with no credential at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { readKeyFor } from '../../src/http/auth.ts';
import { readKeyPath } from '../../src/http/read-gate.ts';
import { READ_ROUTES } from '../../src/http/router.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Every route in the GET table, the reveal fetch and a path no route answers: a gate that only
// covered the routes somebody listed would leave the next one open.
function everyRead(): string[] {
  return [...READ_ROUTES.filter((r) => r !== '/api/health'), '/api/wallet/reveal/0123456789abcdef', '/api/not-a-route'];
}

async function read(url: string, route: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; text: string; type: string }> {
  const abort = new AbortController();
  const res = await fetch(`${url}${route}`, { method, headers, signal: abort.signal });
  const type = res.headers.get('content-type') ?? '';
  // The event stream never ends on its own; its status and type are the answer.
  if (type.startsWith('text/event-stream')) {
    abort.abort();
    return { status: res.status, text: '', type };
  }
  return { status: res.status, text: await res.text(), type };
}

test('every read refuses a caller that carries nothing, and says nothing about the wallet', async () => {
  const h = await bootChartServer();
  try {
    assert.ok(READ_ROUTES.includes('/api/state') && READ_ROUTES.length > 15, `the GET table was not found: ${READ_ROUTES.join(',')}`);
    for (const route of everyRead()) {
      for (const method of ['GET', 'HEAD']) {
        const answer = await read(h.url, route, {}, method);
        assert.equal(answer.status, 401, `${method} ${route} answered ${answer.status} with no credential`);
        assert.ok(!answer.text.includes('0xself'), `${route} named the wallet's address`);
        assert.ok(!answer.text.includes('humanClickAboveUsd'), `${route} handed out the policy`);
      }
    }
    // The same with a matching Origin: the window's origin is not a credential.
    const withOrigin = await read(h.url, '/api/state', { origin: h.url });
    assert.equal(withOrigin.status, 401);
  } finally {
    await h.close();
  }
});

test('a wrong token, a wrong key, the token in a URL and the seat secret are all refused', async () => {
  const h = await bootChartServer();
  try {
    const key = readKeyFor(h.token);
    const refused: [string, Record<string, string>][] = [
      ['/api/state', { 'x-phosphor-token': 'f'.repeat(48) }],
      ['/api/state', { 'x-phosphor-read': 'f'.repeat(64) }],
      // The read key is not the token: it opens reads, so it must not stand in for the token...
      ['/api/state', { 'x-phosphor-token': key }],
      // ...and the token never travels in a URL, where a log or a history could keep it.
      [`/api/state?token=${h.token}`, {}],
      [`/api/state?read=${h.token}`, {}],
      [`/api/events?token=${h.token}`, {}],
      // The agents' secret opens /api/mcp, where its reads are seated and audited. Not these.
      ['/api/state', { 'x-phosphor-read': h.seat }],
      [`/api/state?secret=${h.seat}`, {}],
    ];
    for (const [route, headers] of refused) {
      const answer = await read(h.url, route, headers);
      assert.equal(answer.status, 401, `${route} ${JSON.stringify(headers)} answered ${answer.status}`);
    }
  } finally {
    await h.close();
  }
});

test('the window token in its header, or the read key in its header or in ?read=, opens every read', async () => {
  const h = await bootChartServer();
  try {
    const key = readKeyFor(h.token);
    for (const route of everyRead()) {
      const sep = route.includes('?') ? '&' : '?';
      for (const [how, path, headers] of [
        ['token header', route, { 'x-phosphor-token': h.token }],
        ['read header', route, { 'x-phosphor-read': key }],
        ['read param', `${route}${sep}read=${key}`, {}],
      ] as [string, string, Record<string, string>][]) {
        const answer = await read(h.url, path, headers);
        assert.notEqual(answer.status, 401, `${route} by ${how} was refused`);
      }
    }
    const state = await read(h.url, '/api/state', { 'x-phosphor-read': key });
    assert.equal(state.status, 200);
    assert.ok(state.text.includes('humanClickAboveUsd'), 'the window still reads its policy');
    const stream = await read(h.url, `/api/events?read=${key}`);
    assert.equal(stream.status, 200);
    assert.ok(stream.type.startsWith('text/event-stream'), stream.type);
  } finally {
    await h.close();
  }
});

test('health tells anyone the app is alive and its version, and the wallet facts only to a credential', async () => {
  const h = await bootChartServer();
  try {
    const open = await read(h.url, '/api/health');
    assert.equal(open.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(open.text)).sort(), ['ok', 'uptimeSec', 'version']);
    for (const headers of [{ 'x-phosphor-token': h.token }, { 'x-phosphor-read': readKeyFor(h.token) }] as Record<string, string>[]) {
      const full = JSON.parse((await read(h.url, '/api/health', headers)).text);
      for (const field of ['locked', 'pending', 'executing', 'killSwitch', 'lastError', 'auditChain']) {
        assert.ok(field in full, `health with a credential has no ${field}`);
      }
    }
  } finally {
    await h.close();
  }
});

test('the window trades its token for the read key, and the key cannot decide anything', async () => {
  const h = await bootChartServer();
  try {
    const traded = await h.post('/api/read-key', { token: h.token });
    assert.equal(traded.status, 200);
    assert.equal(traded.json.read, readKeyFor(h.token));
    assert.match(traded.json.read, /^[0-9a-f]{64}$/);
    assert.notEqual(traded.json.read, h.token);

    assert.equal((await h.post('/api/read-key', { token: 'f'.repeat(48) })).status, 403, 'a wrong token got a key');
    assert.equal((await h.post('/api/read-key', {})).status, 403, 'no token got a key');
    const noOrigin = await fetch(`${h.url}/api/read-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.token }) });
    assert.equal(noOrigin.status, 403, 'a post with no Origin got a key');

    // The key opens reads only: as the token on a decision route it is a wrong token.
    for (const route of ['/api/approve', '/api/kill', '/api/unlock', '/api/read-key']) {
      const answer = await h.post(route, { token: traded.json.read, id: 'x', on: true, password: 'p'.repeat(12) });
      assert.equal(answer.status, 403, `${route} took the read key as the token`);
    }
  } finally {
    await h.close();
  }
});

test('refused reads are one audit line, not one per knock', async () => {
  const h = await bootChartServer();
  try {
    await read(h.url, '/api/wallet/reveal/0123456789abcdef');
    for (let i = 0; i < 25; i += 1) await read(h.url, '/api/state');
    const lines = h.audit.tail(200).filter((e) => e.type === 'read_refused');
    assert.equal(lines.length, 1, `${lines.length} read_refused lines for 26 refusals`);
    assert.match(lines[0].msg, /GET \/api\/wallet\/reveal\/ refused/);
    assert.ok(!JSON.stringify(h.audit.tail(200)).includes('0123456789abcdef'), 'a reveal nonce reached the audit log');
  } finally {
    await h.close();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

// A real boot on a throwaway folder, the token piped the way the shell pipes it.
async function bootReal(dataDir: string, token: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.ts')], {
    env: { ...process.env, PHOSPHOR_MODE: 'demo', PHOSPHOR_PORT: String(port), PHOSPHOR_DATA_DIR: dataDir, PHOSPHOR_KEYS: path.join(dataDir, 'keys.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(`${token}\n`);
  const up = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 25_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', () => resolve());
      child.kill('SIGTERM');
    });
  if (!up) {
    await stop();
    assert.fail('the backend did not come up');
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

test('a boot writes the read key for programs the person runs: owner-only, this boot only', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-read-key-'));
  try {
    const first = 'e'.repeat(64);
    const app = await bootReal(dataDir, first);
    try {
      const file = readKeyPath(dataDir);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'another account on this Mac could read the key');
      const key = fs.readFileSync(file, 'utf8').trim();
      assert.equal(key, readKeyFor(first));
      assert.equal((await fetch(`${app.base}/api/state`)).status, 401);
      assert.equal((await fetch(`${app.base}/api/state`, { headers: { 'x-phosphor-read': key } })).status, 200);
    } finally {
      await app.stop();
    }
    // The next boot has another token, and a key copied from this one opens nothing there.
    const old = fs.readFileSync(readKeyPath(dataDir), 'utf8').trim();
    const second = await bootReal(dataDir, 'f'.repeat(64));
    try {
      assert.notEqual(fs.readFileSync(readKeyPath(dataDir), 'utf8').trim(), old, 'the key was not rewritten');
      assert.equal((await fetch(`${second.base}/api/state`, { headers: { 'x-phosphor-read': old } })).status, 401);
    } finally {
      await second.stop();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the read key is an HMAC of the token: stable for one token, different for another, never the token', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.equal(readKeyFor(a), readKeyFor(a));
  assert.notEqual(readKeyFor(a), readKeyFor(b));
  assert.match(readKeyFor(a), /^[0-9a-f]{64}$/);
  assert.ok(!readKeyFor(a).includes(a.slice(0, 16)));
});
