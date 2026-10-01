// Where the web gate's provenance comes from, driven end to end: the real driver over the Claude
// stand-in records each web search result for the chat's seat (and for no other), closes page
// reading when a search carried the wallet's own data, and forgets both with the session; the
// window's prompt route records the person's own words and nothing the app adds to them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver } from '../../src/driver.ts';
import type { DriverEvent } from '../../src/driver.ts';
import { checkPage, walletPrints } from '../../src/web-gate.ts';
import type { WalletPrints } from '../../src/web-gate.ts';
import { lockdownCopy } from '../fixtures/lockdown-copy.ts';
import { bootDriverServer } from '../fixtures/driver-server.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SETTINGS = lockdownCopy();
// The figure and address LEAKY-SEARCH puts in its query (tests/fixtures/fake-claude-stream.sh).
const PRINTS = walletPrints({ addresses: ['0x1111111111111111111111111111111111111111'], amounts: [1234.56] });

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

function world(seat: string, prints?: () => WalletPrints) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-web-gate-'));
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
    prints,
    onEvent: (event) => events.push(event),
  });
  const ends = () => events.filter((e) => e.kind === 'turn_end').length;
  return {
    driver,
    events,
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

test('a web search\'s links become readable for the chat that searched, and for no other', async () => {
  const w = world('seat-gate-search');
  try {
    await w.start();
    assert.equal((checkPage('seat-gate-search', 'https://near.ai/', PRINTS) as { code?: string }).code, 'provenance');
    await w.turn('what is near ai WEB-SEARCH');
    assert.ok(checkPage('seat-gate-search', 'https://near.ai/', PRINTS).ok);
    assert.ok(checkPage('seat-gate-search', 'https://docs.near.ai/agents/quickstart', PRINTS).ok);
    assert.equal((checkPage('seat-gate-other', 'https://near.ai/', PRINTS) as { code?: string }).code, 'provenance');
  } finally {
    w.done();
  }
});

test('a search that carried the wallet\'s figure and address closes page reading for the session', async () => {
  const w = world('seat-gate-leak', () => PRINTS);
  try {
    await w.start();
    await w.turn('LEAKY-SEARCH');
    const v = checkPage('seat-gate-leak', 'https://verify.example.org/a', PRINTS);
    assert.equal(v.ok ? '' : v.code, 'sealed');
    assert.ok(w.events.some((e) => e.kind === 'debug' && e.message.includes('page reading is closed')), 'the developer\'s log says why');
    assert.notEqual(w.driver.status().state, 'failed', 'the chat goes on: only page reading is closed');
  } finally {
    w.done();
  }
});

test('the same search with no prints to check against records its links and closes nothing', async () => {
  const w = world('seat-gate-noprints');
  try {
    await w.start();
    await w.turn('LEAKY-SEARCH');
    assert.ok(checkPage('seat-gate-noprints', 'https://verify.example.org/a', walletPrints({ addresses: [], amounts: [] })).ok);
  } finally {
    w.done();
  }
});

test('a new agent session forgets every search result and lifts the seal', async () => {
  const w = world('seat-gate-restart', () => PRINTS);
  try {
    await w.start();
    await w.turn('what is near ai WEB-SEARCH');
    await w.turn('LEAKY-SEARCH');
    assert.equal((checkPage('seat-gate-restart', 'https://near.ai/', PRINTS) as { code?: string }).code, 'sealed');
    w.driver.stop();
    await w.start();
    assert.equal((checkPage('seat-gate-restart', 'https://near.ai/', PRINTS) as { code?: string }).code, 'provenance');
  } finally {
    w.done();
  }
});

test('the prompt route records the person\'s words as provenance, and not the screen line it adds', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const [chat] = await b.chats();
    assert.ok(chat !== undefined);
    const sent = await b.driver({ action: 'prompt', chat: chat.id, text: 'summarise https://docs.near.org/concepts/basics for me' });
    assert.equal(sent.status, 200);
    assert.ok(checkPage(chat.session, 'https://docs.near.org/concepts/basics', PRINTS).ok);
    assert.equal(b.calls.sends.length, 1);
    assert.match(b.calls.sends[0], /\[phosphor: the window is on/);
    // The screen line is the app's: nothing in it is an address anyone gave.
    assert.equal((checkPage(chat.session, 'https://phosphor.money/', PRINTS) as { code?: string }).code, 'provenance');
  } finally {
    await b.close();
  }
});
