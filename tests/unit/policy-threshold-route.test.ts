// The onboarding threshold lands in policy.json, and a bad value is refused with the file untouched.
//
// Known failure 6 of the ready-for-people prompt: ui/screens/firstrun.js wrote draft.threshold
// and sent it nowhere, so a new person's chosen threshold was dropped and the default stood.
// The route the step posts to now carries the window token like every human write and goes
// through the policy file's own loader, schema and checked writer, the engine's ceiling and its
// never-asks rule: never a second writer, never a value the schema has not seen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { handleMutation, thresholdRefusal } from '../../src/http/mutation.ts';
import type { Ctx } from '../../src/http/context.ts';
import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';

const TOKEN = 'b'.repeat(64);

type Line = { type: string; msg: string; data?: Record<string, unknown> };
type App = { url: string; dataDir: string; lines: Line[]; close: () => Promise<void> };

async function boot(): Promise<App> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-threshold-'));
  savePolicy(dataDir, defaultPolicy());
  const lines: Line[] = [];
  const ctx = {
    token: TOKEN,
    cfg: { port: 4203, dataDir },
    audit: { append: (type: string, msg: string, data?: Record<string, unknown>) => lines.push({ type, msg, data }) },
    getPolicy: () => loadPolicy(dataDir),
    sse: { broadcastState: () => {} },
  } as unknown as Ctx;
  const server = http.createServer((req, res) => {
    void handleMutation(ctx, '/api/policy/threshold', req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, dataDir, lines, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function post(app: App, body: Record<string, unknown>, token: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api/policy/threshold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.url, host: '127.0.0.1' },
    body: JSON.stringify(token === null ? body : { ...body, token }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('the value lands in policy.json, the sentences follow it, and the audit says a human did it', async () => {
  const app = await boot();
  try {
    const { status, json } = await post(app, { usd: 25 });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, threshold: 25, from: 100 });
    const policy = loadPolicy(app.dataDir);
    assert.ok(policy !== null, 'the file no longer loads');
    assert.equal(policy.outbound.humanClickAboveUsd, 25);
    assert.ok(policy.sentences.some((s) => s.includes('$25')), `the sentences did not follow: ${policy.sentences.join(' | ')}`);
    // Only the one axis moved.
    assert.equal(policy.outbound.maxPerTransactionUsd, 10000);
    assert.equal(policy.outbound.maxPerSessionUsd, 25000);
    assert.equal(policy.outbound.autoApproveDailyUsd, 500);
    const line = app.lines.find((l) => l.type === 'policy_changed');
    assert.ok(line, 'no policy_changed audit line');
    assert.deepEqual(line.data, { axis: 'humanClickAboveUsd', from: 100, to: 25, by: 'human', where: 'onboarding' });

    // A typed figure arrives as a string from the input and lands the same way.
    const typed = await post(app, { usd: '500' });
    assert.equal(typed.json.threshold, 500);
    assert.equal(loadPolicy(app.dataDir)?.outbound.humanClickAboveUsd, 500);
  } finally {
    await app.close();
  }
});

test('a bad value is refused with one sentence naming the figures, and the file is left as it was', async () => {
  const app = await boot();
  try {
    const cases: Array<[unknown, RegExp]> = [
      ['abc', /has to be a number/],
      [undefined, /has to be a number/],
      [0, /above \$0/],
      [-5, /above \$0/],
      [10000, /nothing ever asks you.*under \$10,000/],
      [12000, /nothing ever asks you/],
      [2_000_000, /cannot go past \$1,000,000/],
      [Number.NaN, /has to be a number/],
    ];
    for (const [usd, expected] of cases) {
      const { status, json } = await post(app, usd === undefined ? {} : { usd });
      assert.equal(status, 400, String(usd));
      assert.match(String(json.error), expected, String(usd));
      assert.equal(loadPolicy(app.dataDir)?.outbound.humanClickAboveUsd, 100, `the file moved on ${String(usd)}`);
    }
    assert.ok(!app.lines.some((l) => l.type === 'policy_changed'), 'a refusal wrote an audit line');
  } finally {
    await app.close();
  }
});

test('an unreadable policy file refuses the write rather than seeding a fresh one, and the route needs the window token', async () => {
  const app = await boot();
  try {
    assert.equal((await post(app, { usd: 25 }, null)).status, 403);
    fs.writeFileSync(path.join(app.dataDir, 'policy.json'), '{ not json');
    const { status, json } = await post(app, { usd: 25 });
    assert.equal(status, 409);
    assert.match(String(json.error), /cannot be read/);
    assert.equal(fs.readFileSync(path.join(app.dataDir, 'policy.json'), 'utf8'), '{ not json');
  } finally {
    await app.close();
  }
});

test('the refusal table is the one the route uses', () => {
  assert.equal(thresholdRefusal(25, 10000), null);
  assert.equal(thresholdRefusal(9999.99, 10000), null);
  assert.match(String(thresholdRefusal(10000, 10000)), /\$10,000/);
  assert.match(String(thresholdRefusal('25', 10000)), /number/);
  assert.match(String(thresholdRefusal(Infinity, 10000)), /number/);
});
