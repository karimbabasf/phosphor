// Freeze over a policy file that will not load: the runner is still told, and the window and the
// log say what the switch did rather than what was asked.
//
// It used to be the other way round. setKill returned before the runner when the policy read
// null, the route answered {"ok":true,"killSwitch":true} and logged KILL SWITCH ON, and an armed
// plan kept firing under a window that said frozen. Here the switch is src/kill.ts with a runner
// that records its calls, and the route is driven through the real router.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createKill, FREEZE_UNREADABLE, LEFT_OPEN_LOCKED, LEFT_OPEN_NO_KEY, UNFREEZE_UNREADABLE } from '../../src/kill.ts';
import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { handle } from '../../src/http/router.ts';
import type { Ctx } from '../../src/http/context.ts';

const TOKEN = 'k'.repeat(64);

type Venue = { open: boolean; child: 'on' | 'off'; key: 'present' | 'absent' | 'locked' };

function world(policy: 'readable' | 'unreadable', venue: Venue = { open: false, child: 'off', key: 'present' }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-kill-'));
  if (policy === 'readable') savePolicy(dataDir, defaultPolicy());
  else fs.writeFileSync(path.join(dataDir, 'policy.json'), '{ not json');
  const calls: string[] = [];
  const lines: Array<{ type: string; msg: string }> = [];
  const runner = {
    setKilled: (on: boolean) => {
      calls.push(`setKilled:${on}`);
    },
    // Reads the switch from the file the way the real stopAll's last step does.
    stopAll: async (reason: string) => {
      calls.push(`stopAll:${reason}:${String(loadPolicy(dataDir)?.killSwitch ?? 'unreadable')}`);
    },
    openOnVenue: () => venue.open,
    status: () => ({ plans: [], child: venue.child, watching: [] }),
  };
  const audit = {
    append: (type: string, msg: string) => {
      lines.push({ type, msg });
      return undefined as never;
    },
    flushTip: () => {},
  };
  const setKill = createKill({ dataDir, audit: audit as never, runner, tradingKey: () => venue.key });
  return { dataDir, calls, lines, setKill };
}

test('Freeze over an unreadable policy stops the runner and says the switch was not saved', () => {
  const w = world('unreadable');
  const answer = w.setKill(true);
  assert.deepEqual(answer, { ok: false, killSwitch: true, code: 'policy_unreadable', error: FREEZE_UNREADABLE });
  assert.deepEqual(w.calls, ['setKilled:true', 'stopAll:kill switch:unreadable'], 'the runner is told, and its last read of the switch fails closed');
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'policy.json'), 'utf8'), '{ not json', 'nothing was written over the file');
  assert.equal(w.lines.some((l) => l.type === 'kill_switch'), false, 'no line claims the switch was saved');
  assert.ok(w.lines.some((l) => l.type === 'error' && l.msg.includes('policy file is unreadable')));
});

test('Unfreeze over an unreadable policy is refused, and the runner keeps its brake', () => {
  const w = world('unreadable');
  const answer = w.setKill(false);
  assert.deepEqual(answer, { ok: false, killSwitch: true, code: 'policy_unreadable', error: UNFREEZE_UNREADABLE });
  assert.deepEqual(w.calls, [], 'nothing told the runner it may fire again');
});

test('Freeze over a readable policy saves the switch before the runner reads it back', () => {
  const w = world('readable');
  assert.deepEqual(w.setKill(true), { ok: true, killSwitch: true });
  assert.equal(loadPolicy(w.dataDir)?.killSwitch, true);
  assert.deepEqual(w.calls, ['setKilled:true', 'stopAll:kill switch:true']);

  assert.deepEqual(w.setKill(false), { ok: true, killSwitch: false });
  assert.equal(loadPolicy(w.dataDir)?.killSwitch, false);
  assert.deepEqual(w.calls.slice(2), ['setKilled:false']);
});

async function press(w: ReturnType<typeof world>, on: boolean): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctx = {
    token: TOKEN,
    audit: { append: (type: string, msg: string) => void w.lines.push({ type, msg }) },
    setKill: w.setKill,
    sse: { broadcastState: () => {}, broadcastLock: () => {} },
  } as unknown as Ctx;
  const server = http.createServer((req, res) => void handle(ctx, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ token: TOKEN, on }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the route answers and logs what the switch did, not what was asked', async () => {
  const w = world('unreadable');
  const frozen = await press(w, true);
  assert.equal(frozen.status, 409, 'the window shows the sentence as a refusal');
  assert.equal(frozen.json.ok, false);
  assert.equal(frozen.json.code, 'policy_unreadable');
  assert.equal(frozen.json.error, FREEZE_UNREADABLE);
  assert.equal(w.lines.some((l) => l.msg.startsWith('KILL SWITCH ON')), false, 'the log never claims a switch that was not saved');
  assert.ok(w.lines.some((l) => l.type === 'kill_switch' && l.msg.startsWith('Freeze pressed (human), and the switch was not saved')));
  assert.deepEqual(w.calls, ['setKilled:true', 'stopAll:kill switch:unreadable']);

  const good = world('readable');
  const on = await press(good, true);
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { ok: true, killSwitch: true });
  assert.ok(good.lines.some((l) => l.msg === 'KILL SWITCH ON: all writes refused (human)'));
});

/* Freeze closes positions only with the trading key in reach: a running plan's child holds it, or
   an open wallet hands it over. Locked with no plan running, stopAll closes nothing and logs why,
   and docs/trading.md said every position closes. The press now says what stayed open. */
test('Freeze with positions open and no trading key in reach says they are still open, and why', async () => {
  const locked = world('readable', { open: true, child: 'off', key: 'locked' });
  assert.deepEqual(locked.setKill(true), { ok: true, killSwitch: true, note: LEFT_OPEN_LOCKED });
  assert.deepEqual(locked.calls, ['setKilled:true', 'stopAll:kill switch:true'], 'the freeze itself still happens');

  const noKey = world('readable', { open: true, child: 'off', key: 'absent' });
  assert.deepEqual(noKey.setKill(true), { ok: true, killSwitch: true, note: LEFT_OPEN_NO_KEY });

  const viaRoute = world('readable', { open: true, child: 'off', key: 'locked' });
  const answer = await press(viaRoute, true);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { ok: true, killSwitch: true, note: LEFT_OPEN_LOCKED });
  assert.ok(viaRoute.lines.some((l) => l.msg === 'KILL SWITCH ON: all writes refused (human); trading positions left open, no trading key in reach'));
});

test('Freeze that can reach the venue, or has nothing there, says nothing more', () => {
  for (const venue of [
    { open: true, child: 'on', key: 'locked' },
    { open: true, child: 'off', key: 'present' },
    { open: false, child: 'off', key: 'locked' },
  ] as Venue[]) {
    assert.deepEqual(world('readable', venue).setKill(true), { ok: true, killSwitch: true }, JSON.stringify(venue));
  }
});
