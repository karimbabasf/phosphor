// What a refused write is allowed to write down about the token it was refused for.
//
// THE LEAK. Every rejected mutation appended `expectedFp: tokenFingerprint(ctx.token)` beside the
// fingerprint of whatever the caller sent, and GET /api/log has no credential and no Origin check.
// So one unauthenticated POST /api/approve and one unauthenticated GET /api/log handed any local
// process a stable 12-hex-character fingerprint of the one secret in this system.
//
// It is a SHA-256 prefix and it is not invertible, and it was still worth deleting. It is an
// offline oracle: a candidate token obtained anywhere else, a crash dump, a stale window, a
// partially disclosed value, could be confirmed against it without contacting this app at all and
// without leaving the audit line a real attempt leaves. The fingerprint that stays is the one for
// the token the CALLER sent, which is the caller's own value and tells one stale page retrying
// apart from a client that never had a token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { tokenFingerprint } from '../../src/http/auth.ts';
import { handleMutation } from '../../src/http/mutation.ts';
import type { Ctx } from '../../src/http/context.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TOKEN = 'f'.repeat(64);

type Line = { type: string; data: Record<string, unknown> };

async function boot(): Promise<{ url: string; close: () => Promise<void>; lines: Line[] }> {
  const lines: Line[] = [];
  const ctx = {
    token: TOKEN,
    audit: { append: (type: string, _msg: string, data: Record<string, unknown>) => lines.push({ type, data }) },
  } as unknown as Ctx;

  const server = http.createServer((req, res) => {
    void handleMutation(ctx, '/api/approve', req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    lines,
  };
}

test('a refused write records nothing derived from the token it was checked against', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.url}/api/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app.url },
      body: JSON.stringify({ id: 'nope' }),
    });
    assert.equal(res.status, 403);
    await res.text();

    const rejected = app.lines.find((line) => line.type === 'approve_attempt_rejected');
    assert.ok(rejected !== undefined, 'the rejection is still recorded');

    const forbidden = tokenFingerprint(TOKEN);
    const serialised = JSON.stringify(rejected.data);
    assert.ok(
      !serialised.includes(forbidden),
      `the record leaks ${forbidden}, which is a fingerprint of this boot own approval token: ${serialised}`,
    );
    assert.ok(!Object.keys(rejected.data).includes('expectedFp'), 'and it leaks it under no name either');

    // What the line is for still works: it says a token was missing and who asked.
    assert.equal(rejected.data.reason, 'approval token missing');
    assert.equal(rejected.data.tokenPresent, false);
    assert.equal(rejected.data.tokenFp, null);
  } finally {
    await app.close();
  }
});

test('the fingerprint of what the CALLER sent is still recorded, because it is theirs', async () => {
  const app = await boot();
  try {
    const wrong = 'a'.repeat(64);
    const res = await fetch(`${app.url}/api/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app.url },
      body: JSON.stringify({ id: 'nope', token: wrong }),
    });
    assert.equal(res.status, 403);
    await res.text();

    const rejected = app.lines.find((line) => line.type === 'approve_attempt_rejected');
    assert.ok(rejected !== undefined);
    assert.equal(rejected.data.tokenFp, tokenFingerprint(wrong), 'two rejections sharing this are one stale page');
    assert.ok(!JSON.stringify(rejected.data).includes(tokenFingerprint(TOKEN)));
  } finally {
    await app.close();
  }
});

test('no route builds a fingerprint of the token this app holds', () => {
  // The source-level half, so a second site cannot reintroduce the oracle somewhere the test above
  // does not reach. tokenFingerprint is for values that arrived from outside.
  const dir = path.join(ROOT, 'src', 'http');
  const offenders: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const line of source.split('\n')) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/tokenFingerprint\(\s*ctx\.token\s*\)/.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], 'a value derived from the window token must not reach an unauthenticated route');
});
