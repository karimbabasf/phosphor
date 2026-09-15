// The trade feed asks the venue about the wallet that exists now, and about nobody when there
// is none.
//
// On a fresh install the account was `cfg.addresses.evm[0] ?? ''`, read once at boot, and the
// feed posted `{type:'spotClearinghouseState', user:''}` every thirty seconds. Hyperliquid
// answers that with 422 "Failed to deserialize the JSON body", the feed kept the complaint in
// its one error slot, and the Trade tab said "No route to the venue" until a restart, wallet or
// no wallet. Three properties close it: no wallet means no account read and no error; a read
// that works retires the error the last one left; and a wallet made after boot is the account
// from the next poll on. The runner child gets the same account, read when it is forked.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { createTradeFeed } from '../../src/trade/feed-ws.ts';
import type { FeedSocket } from '../../src/trade/feed-ws.ts';
import type { InfoClient } from '../../src/hl/info.ts';
import { createRunnerHost } from '../../src/runner/host.ts';
import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';

const WS = 'wss://test.invalid/ws';
const USER = '0x1111111111111111111111111111111111111111';
const SPOT_REFRESH_MS = 30_000;

type FakeSocket = FeedSocket & { sent: string[]; open(): void };

function fakeSockets(): { make: (url: string) => FeedSocket; last: () => FakeSocket } {
  const all: FakeSocket[] = [];
  function make(): FeedSocket {
    const sock: FakeSocket = {
      sent: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string): void {
        sock.sent.push(data);
      },
      close(): void {
        sock.readyState = 3;
      },
      open(): void {
        sock.readyState = 1;
        sock.onopen?.();
      },
    };
    all.push(sock);
    return sock;
  }
  return { make, last: () => all[all.length - 1] };
}

/* The /info door, recording every body. `spotAnswers` is consumed one per spot read; the
   string 'reject' in place of an answer is a 422, so a test can script one between two good
   reads. */
function fakeInfo(spotAnswers: Array<unknown | 'reject'> = []): { info: InfoClient; posts: Array<Record<string, unknown>> } {
  const posts: Array<Record<string, unknown>> = [];
  let spotReads = 0;
  const info: InfoClient = {
    post<T>(body: unknown): Promise<T> {
      const b = body as Record<string, unknown>;
      posts.push(b);
      if (b.type === 'meta') return Promise.resolve({ universe: [] } as T);
      if (b.type === 'spotClearinghouseState') {
        const scripted = spotAnswers[Math.min(spotReads, spotAnswers.length - 1)];
        spotReads += 1;
        if (scripted === 'reject') return Promise.reject(new Error('hyperliquid /info 422: Failed to deserialize the JSON body into the target type'));
        return Promise.resolve((scripted ?? { balances: [] }) as T);
      }
      return Promise.resolve({} as T);
    },
    health: () => ({ ok: true, consecutiveFailures: 0, lastError: null, lastLatencyMs: null, backoffUntilMs: null }),
  };
  return { info, posts };
}

function subscriptions(sock: FakeSocket): Array<Record<string, unknown>> {
  return sock.sent
    .map((raw) => JSON.parse(raw) as { method?: string; subscription?: Record<string, unknown> })
    .filter((m) => m.method === 'subscribe')
    .map((m) => m.subscription ?? {});
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('with no wallet the feed asks the venue nothing account-shaped and reports no error', async () => {
  const socks = fakeSockets();
  const { info, posts } = fakeInfo();
  const feed = createTradeFeed({ wsUrl: WS, user: '', info, wsImpl: socks.make });
  socks.last().open();
  await settle();

  assert.equal(posts.filter((p) => p.type === 'spotClearinghouseState').length, 0, 'no spot read for user ""');
  assert.deepEqual(
    subscriptions(socks.last()).map((s) => s.type),
    [],
    'no account channel is subscribed for nobody',
  );
  assert.equal(feed.status().lastError, null, 'a wallet that does not exist yet is not a fault');
  assert.equal(feed.status().account, null);
  feed.stop();
});

test('a spot read that works retires the error the last one left', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const socks = fakeSockets();
    // Boot read fine, the read after the socket opens is a 422, the poll after that is fine.
    const { info } = fakeInfo([{ balances: [] }, 'reject', { balances: [] }]);
    const feed = createTradeFeed({ wsUrl: WS, user: USER, info, wsImpl: socks.make });
    await settle();
    socks.last().open();
    await settle();
    assert.match(String(feed.status().lastError), /spot read failed: .*422/, 'the bad answer is reported');

    mock.timers.tick(SPOT_REFRESH_MS);
    await settle();
    assert.equal(feed.status().lastError, null, 'and the next good read clears it');
    feed.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a wallet created after boot is the account from the next poll on', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const socks = fakeSockets();
    const { info, posts } = fakeInfo();
    let current = '';
    const feed = createTradeFeed({ wsUrl: WS, user: () => current, info, wsImpl: socks.make });
    socks.last().open();
    await settle();
    assert.equal(subscriptions(socks.last()).length, 0);
    assert.equal(feed.status().account, null);

    // The person creates the wallet in the window.
    current = USER;
    mock.timers.tick(SPOT_REFRESH_MS);
    await settle();

    const subs = subscriptions(socks.last());
    assert.ok(
      subs.some((s) => s.type === 'clearinghouseState' && s.user === USER),
      `the account channels follow the wallet: ${JSON.stringify(subs)}`,
    );
    assert.ok(subs.some((s) => s.type === 'userFills' && s.user === USER));
    const spot = posts.filter((p) => p.type === 'spotClearinghouseState');
    assert.deepEqual(
      spot.map((p) => p.user),
      [USER],
      'the balance is read for the new wallet and was never read for nobody',
    );
    assert.equal(feed.status().account, USER);
    assert.equal(feed.status().lastError, null);
    feed.stop();
  } finally {
    mock.timers.reset();
  }
});

// ---------- the runner child ----------

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  readonly stdin = new (class extends EventEmitter {
    write(): boolean {
      return true;
    }
    end(): void {}
  })();
  stderr = null;
  send(msg: unknown): boolean {
    const m = msg as ToChild;
    let reply: FromChild | null = null;
    if (m.cmd === 'arm') reply = { ev: 'armed', seq: m.seq, id: m.plan.id };
    if (m.cmd === 'release') reply = { ev: 'released', seq: m.seq, id: m.id };
    if (reply !== null) setImmediate(() => this.emit('message', reply));
    return true;
  }
  kill(): boolean {
    return true;
  }
}

function plan(): PlanRow {
  return {
    id: 'm1',
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 100,
    leverage: 2,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'waiting',
    hash: 'unused-in-this-test',
    cloids: {},
    gen: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('the runner child is forked with the wallet as it is at arm time, not at boot', async () => {
  let current = '';
  const envs: string[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: () => current,
    killSwitch: () => false,
    onEvent: () => {},
    store: createPlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-feed-identity-'))),
    meta: () => ({ assetId: 1, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    replyMs: 200,
    forkImpl: ((_entry: string, _args: string[], opts: { env: Record<string, string> }) => {
      envs.push(opts.env.PHOSPHOR_HL_USER);
      return new FakeChild() as unknown as ChildProcess;
    }) as never,
  });

  // The wallet appears after the host was built and before the first arm.
  current = USER;
  const armed = await runner.arm(plan());
  assert.equal(armed.ok, true, armed.ok ? '' : armed.reason);
  assert.deepEqual(envs, [USER]);
  await runner.stopAll('test over');
});
