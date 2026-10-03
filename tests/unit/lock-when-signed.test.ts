// A screen lock locks the wallet as soon as the signature in flight is made, not after the
// delivery watch, and nothing new starts while it closes.
//
// The when-idle lock used to be refused while any move was `executing`, and a move stays
// executing through minutes of delivery polling that need no key. The shell asked for forty
// seconds and gave up, so a screen locked under a slow payout left the wallet open until the idle
// timer, and an agent could keep one move after another executing. Here a real keystore sits
// behind the real route, and a proposal service with a rail the test releases by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { CLOSE_GRACE_MS, createKeystore } from '../../src/keystore/store.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { evmPrivateKey, isLocked, keyHeld, useKeystore } from '../../src/keystore/index.ts';
import { handle } from '../../src/http/router.ts';
import type { Ctx } from '../../src/http/context.ts';
import { mayStillSign } from '../../src/proposals.ts';
import type { Proposal } from '../../src/types.ts';
import { makeCtx, slowRail } from './helpers/proposals.ts';
import { tempDir } from './helpers/tmp.ts';

const TOKEN = 'w'.repeat(64);
const PASSWORD = 'a long enough password';

async function openWallet() {
  const dir = tempDir('phosphor-signed-');
  const keysPath = path.join(dir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  await keystore.create(PASSWORD);
  return { keystore, keysPath };
}

async function until(what: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (what()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return what();
}

async function askToLock(rows: () => Proposal[], keystore: Awaited<ReturnType<typeof openWallet>>['keystore']) {
  const lines: string[] = [];
  const ctx = {
    token: TOKEN,
    audit: { append: (_type: string, line: string) => void lines.push(line) },
    proposals: { list: rows },
    keystore,
    sse: { broadcastLock: () => {}, broadcastState: () => {} },
  } as unknown as Ctx;
  const server = http.createServer((req, res) => void handle(ctx, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ token: TOKEN, whenIdle: true, reason: 'the screen locked' }),
    });
    return { json: (await res.json()) as Record<string, unknown>, lines };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const row = (status: Proposal['status'], result?: Proposal['result']): Proposal =>
  ({ id: crypto.randomUUID(), kind: 'swap', status, createdAt: new Date().toISOString(), ...(result === undefined ? {} : { result }) }) as Proposal;

test('a move in its delivery watch does not hold the lock: the screen lock wipes the key at once', async () => {
  const { keystore } = await openWallet();
  const watching = row('executing', { ok: false, detail: 'submitted, waiting for the venue', txids: ['0x' + 'ab'.repeat(32)] });
  const answer = await askToLock(() => [watching], keystore);
  assert.equal(answer.json.ok, true, JSON.stringify(answer.json));
  assert.equal(keystore.state(), 'locked');
  assert.equal(keystore.keyHeld(), false, 'the key is gone while the venue is still delivering');
});

test('a move that has not signed yet keeps its key, the wallet is shut to everything else, and the key goes with its signature', async () => {
  const { keystore } = await openWallet();
  useKeystore(keystore);
  try {
    let signing = row('executing');
    const answer = await askToLock(() => [signing], keystore);
    assert.equal(answer.json.ok, false);
    assert.equal(answer.json.code, 'busy');
    assert.match(String(answer.lines[0]), /^the wallet was shut \(the screen locked\)/);
    assert.equal(keystore.state(), 'locked', 'the window draws locked from the first ask');
    assert.equal(isLocked(), true, 'nothing new may start');
    assert.equal(keystore.isUnlocked(), false);
    assert.equal(keyHeld(), true, 'the move already under way can still sign');
    assert.match(evmPrivateKey('unused'), /^0x[0-9a-f]{64}$/);

    // Asked again, as the shell does once a second: one closer, the same answer.
    assert.equal((await askToLock(() => [signing], keystore)).json.code, 'busy');

    // The rail signs and hands its hash to the row: the key goes on the next sweep.
    signing = { ...signing, result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0x01'] } };
    assert.ok(await until(() => !keystore.keyHeld()), 'the key went once the signature was made');
    assert.throws(() => evmPrivateKey('unused'), /locked/);
    assert.equal((await askToLock(() => [signing], keystore)).json.ok, true, 'and the next ask is answered locked');
  } finally {
    useKeystore(null);
  }
});

test('a move asked for while the wallet closes waits for an unlock instead of running', async () => {
  const { keystore } = await openWallet();
  useKeystore(keystore);
  const first = slowRail('swap');
  const h = makeCtx({ rails: [first.rail], intentsUsdc: 1000 });
  try {
    const running = await h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 10, minAmountOut: 9.9, by: 'seat' });
    assert.equal(running.status, 'executing', 'a small move runs on its own while the wallet is open');
    await first.started();

    assert.equal(keystore.lockWhen('when-idle', () => !h.svc.list().some(mayStillSign), CLOSE_GRACE_MS), true);
    const next = await h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 11, minAmountOut: 10.9, by: 'seat' });
    assert.equal(next.status, 'pending_unlock', 'the agent cannot keep the wallet open by asking for one move after another');

    first.hooks()?.onEvidence?.({ txids: ['0x' + 'cd'.repeat(32)] });
    assert.ok(await until(() => !keystore.keyHeld()), 'the key went with the first move signature, during its watch');
    assert.equal(h.store.get(running.id)?.status, 'executing', 'the first move is still being delivered');
    first.release({ ok: true, detail: 'delivered', txids: ['0x' + 'cd'.repeat(32)] });
    await h.svc.settle(5000);
    assert.equal(h.store.get(running.id)?.status, 'executed');
  } finally {
    useKeystore(null);
  }
});

test('a close that waits on a signature that never comes ends at its cap, and an unlock calls it off', async () => {
  const { keystore } = await openWallet();
  assert.equal(keystore.lockWhen('stuck', () => false, 200), true);
  assert.equal(keystore.state(), 'locked');
  assert.ok(await until(() => !keystore.keyHeld()), 'the cap wiped the key');

  assert.equal((await keystore.unlock(PASSWORD)).ok, true);
  assert.equal(keystore.lockWhen('stuck', () => false, 200), true);
  assert.equal((await keystore.unlock(PASSWORD)).ok, true, 'the person opened the wallet on purpose');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(keystore.state(), 'unlocked', 'and the close waiting behind it is called off');

  assert.equal(keystore.lockWhen('stuck', () => false, 60_000), true);
  assert.equal(keystore.lock(), true, 'the person\'s own Lock does not wait');
  assert.equal(keystore.keyHeld(), false);
});
