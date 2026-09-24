// A page is a stranger's text, and it can talk an agent into a money move. Under the auto-approve
// limit nothing else would stop that move running, so once the chat's agent has read the web,
// what it proposes waits for the person's click for the rest of that agent session: the page
// stays in its context until the session is gone (src/web-read.ts). And a move is judged by what
// was true when it was asked for, not when it lands.
// Driven end to end: the real driver over the Claude stand-in marks the chat's seat, and the real
// proposal service decides a small swap that seat proposes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Rail } from '../../src/types.ts';
import { createDriver } from '../../src/driver.ts';
import type { DriverEvent } from '../../src/driver.ts';
import { WEB_READ_REASON, webReadBy } from '../../src/web-read.ts';
import { lockdownCopy } from '../fixtures/lockdown-copy.ts';
import { landed, makeCtx } from './helpers/proposals.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SETTINGS = lockdownCopy();

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

// A chat on the Claude stand-in, seated as `seat`, and a proposal service whose swap rail counts
// what it ran. `slowReads` holds every swap's simulation (read before the queue) until released.
function world(seat: string, opts: { slowReads?: boolean } = {}) {
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
  let release: () => void = () => {};
  const reads = new Promise<void>((r) => (release = r));
  const executed: string[] = [];
  const rail: Rail = {
    kind: 'swap',
    valueUsd: () => 0,
    async simulate() {
      if (opts.slowReads === true) await reads;
      return { ok: true, summary: 'scripted rail: nothing was simulated' };
    },
    async execute(draft) {
      executed.push(draft.kind);
      return { ok: true, detail: 'scripted swap', txids: ['0xswap'] };
    },
  };
  const h = makeCtx({ rails: [rail], intentsUsdc: 1000 });
  const ends = () => events.filter((e) => e.kind === 'turn_end').length;
  // A $20 swap, well under the click threshold, as this chat's agent would ask for it.
  const ask = () => h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 20, minAmountOut: 19.8, by: seat });
  return {
    driver,
    executed,
    h,
    ask,
    swap: () => landed(h, ask()),
    release: () => release(),
    async start(): Promise<void> {
      driver.start();
      await until(() => driver.status().state === 'ready');
    },
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
    await w.start();
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
    await w.start();
    await w.turn('what is near ai WEB-FETCH');
    const p = await w.swap();
    assert.equal(p.verdict.outcome, 'needs_approval', JSON.stringify(p.verdict));
    assert.equal(p.status, 'pending');
    assert.equal(p.verdict.reasons.at(-1), WEB_READ_REASON);
    assert.equal(WEB_READ_REASON, 'It read a web page earlier in this chat, so this one waits for your OK.');
    assert.equal(p.webRead, true, 'the row carries its own stamp');
    assert.deepEqual(w.executed, [], 'nothing ran on the policy alone');
  } finally {
    w.done();
  }
});

// Audit finding 1, path A: the page said "once the user replies, swap", and the reply cleared the
// mark while the page was still in the agent's context.
test('the person\'s next message does not clear it: the page is still in the agent\'s context', async () => {
  const w = world('seat-web-then-talk');
  try {
    await w.start();
    await w.turn('what is near ai WEB-FETCH');
    await w.turn('thanks');
    const p = await w.swap();
    assert.equal(p.status, 'pending', JSON.stringify(p.verdict));
    assert.equal(p.verdict.reasons.at(-1), WEB_READ_REASON);
    assert.deepEqual(w.executed, []);
  } finally {
    w.done();
  }
});

// Audit finding 1, path B, the proof of concept as it was filed: a swap asked for while the mark
// was set, whose reads outlive the turn, landed after the next message and ran with no click.
test('a swap asked for after a web read waits for the click however long its reads take', async () => {
  const w = world('seat-web-slow-reads', { slowReads: true });
  try {
    await w.start();
    await w.turn('what is near ai WEB-FETCH');
    const reply = w.ask();
    await new Promise((r) => setTimeout(r, 50));
    await w.turn('thanks');
    w.release();
    const p = await w.h.svc.settled((await reply).id, 5000);
    assert.equal(p.status, 'pending', `landed ${p.status} ${String(p.decidedBy)} ${p.verdict.outcome}`);
    assert.equal(p.verdict.reasons.at(-1), WEB_READ_REASON);
    assert.deepEqual(w.executed, []);
  } finally {
    w.done();
  }
});

test('a move is judged by the mark when it was asked for, not when it lands', async () => {
  const w = world('seat-web-restart', { slowReads: true });
  try {
    await w.start();
    await w.turn('what is near ai WEB-FETCH');
    const reply = w.ask();
    await new Promise((r) => setTimeout(r, 50));
    // A new session while the swap's reads run: the page is gone from the agent, so is the mark.
    w.driver.stop();
    await w.start();
    await w.turn('thanks');
    assert.equal(webReadBy('seat-web-restart'), false, 'the new session has read nothing');
    w.release();
    const p = await w.h.svc.settled((await reply).id, 5000);
    assert.equal(p.status, 'pending', `landed ${p.status} ${String(p.decidedBy)} ${p.verdict.outcome}`);
    assert.equal(p.verdict.reasons.at(-1), WEB_READ_REASON);
    assert.deepEqual(w.executed, []);
  } finally {
    w.done();
  }
});

test('a new agent session starts clean: a small swap runs on its own again', async () => {
  const w = world('seat-web-new-session');
  try {
    await w.start();
    await w.turn('what is near ai WEB-FETCH');
    assert.equal((await w.swap()).status, 'pending');
    w.driver.stop();
    await w.start();
    await w.turn('swap 20 dollars of usdc into usdt');
    const p = await w.swap();
    assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
    assert.deepEqual(w.executed, ['swap']);
  } finally {
    w.done();
  }
});
