// A page is a stranger's text, and it can talk an agent into a money move. Under the auto-approve
// limit nothing else would stop that move running, so once the chat's agent has read the web, what
// it proposes waits for the person's click until the person's next message (src/web-read.ts).
// Driven end to end: the real driver over the Claude stand-in marks the chat's seat, and the real
// proposal service decides a small swap that seat proposes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver } from '../../src/driver.ts';
import type { DriverEvent } from '../../src/driver.ts';
import { WEB_READ_REASON } from '../../src/web-read.ts';
import { lockdownCopy } from '../fixtures/lockdown-copy.ts';
import { landed, makeCtx, railThat } from './helpers/proposals.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SETTINGS = lockdownCopy();

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

// A chat on the Claude stand-in, seated as `seat`, and a proposal service whose swap rail only
// counts what it was handed.
function world(seat: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-web-read-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    home: path.join(dir, 'agents', 'claude'),
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-stream.sh'),
    settingsPath: SETTINGS,
    session: seat,
    onEvent: (event) => events.push(event),
  });
  const executed: string[] = [];
  const h = makeCtx({ rails: [railThat('swap', async (draft) => (executed.push(draft.kind), { ok: true, detail: 'scripted swap', txids: ['0xswap'] }))], intentsUsdc: 1000 });
  const ends = () => events.filter((e) => e.kind === 'turn_end').length;
  // A $20 swap, well under the click threshold, as this chat's agent would propose it.
  const swap = () => landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 20, minAmountOut: 19.8, by: seat }));
  return {
    driver,
    events,
    executed,
    ends,
    swap,
    async turn(text: string): Promise<void> {
      const before = ends();
      driver.send(text);
      await until(() => ends() > before && driver.status().state === 'ready');
    },
    done(): void {
      driver.stop();
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a turn with no web read still runs a small swap on the policy alone', async () => {
  const w = world('seat-no-web');
  try {
    w.driver.start();
    await until(() => w.driver.status().state === 'ready');
    await w.turn('swap 20 dollars of usdc into usdt');
    const p = await w.swap();
    assert.equal(p.verdict.outcome, 'allow', JSON.stringify(p.verdict));
    assert.equal(p.status, 'executed');
    assert.equal(p.decidedBy, 'policy');
    assert.deepEqual(w.executed, ['swap']);
  } finally {
    w.done();
  }
});

test('after the agent reads a page, a small swap waits for the click, and says why', async () => {
  const w = world('seat-web');
  try {
    w.driver.start();
    await until(() => w.driver.status().state === 'ready');
    await w.turn('what is near ai WEB-FETCH');
    assert.ok(w.events.some((e) => e.kind === 'tool' && e.name === 'web_fetch'));
    const p = await w.swap();
    assert.equal(p.verdict.outcome, 'needs_approval', JSON.stringify(p.verdict));
    assert.equal(p.status, 'pending');
    assert.equal(p.verdict.reasons.at(-1), WEB_READ_REASON);
    assert.equal(WEB_READ_REASON, 'It read a web page this turn, so this one waits for your OK.');
    assert.deepEqual(w.executed, [], 'nothing ran on the policy alone');
  } finally {
    w.done();
  }
});

test('the person\'s next message clears the mark, and the same small swap runs on its own again', async () => {
  const w = world('seat-web-then-talk');
  try {
    w.driver.start();
    await until(() => w.driver.status().state === 'ready');
    await w.turn('what is near ai WEB-FETCH');
    assert.equal((await w.swap()).status, 'pending');
    await w.turn('ok, swap 20 dollars of usdc into usdt');
    const p = await w.swap();
    assert.equal(p.verdict.outcome, 'allow', JSON.stringify(p.verdict));
    assert.equal(p.status, 'executed');
    assert.deepEqual(w.executed, ['swap']);
  } finally {
    w.done();
  }
});

test('a web-reading turn the person stopped keeps the mark through the next message, whose swap still waits', async () => {
  const w = world('seat-web-stopped');
  try {
    w.driver.start();
    await until(() => w.driver.status().state === 'ready');
    w.driver.send('what is near ai WEB-FETCH SLOW-ANSWER');
    await until(() => w.events.some((e) => e.kind === 'delta'));
    assert.equal(w.driver.interrupt(), true);
    await until(() => w.ends() === 1 && w.driver.status().state === 'ready');
    // A proposal the stopped turn had started may still be landing, so this turn is not clean yet.
    await w.turn('never mind that');
    assert.equal((await w.swap()).status, 'pending');
    await w.turn('swap 20 dollars of usdc into usdt');
    assert.equal((await w.swap()).status, 'executed');
  } finally {
    w.done();
  }
});
