// The chat runs the agent the person picked. Until 2026-09-23 the pick was read by the picker and
// nobody else, so Grok picked in the Vault still started Claude Code, eleven times in one
// afternoon (R3). And a registration written from a translocated copy of the app named a node that
// was gone the next day. Both are held here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChatRegistry } from '../../src/http/chats.ts';
import { writePick, readPick } from '../../src/agents-catalog.ts';
import type { Run } from '../../src/agents-catalog.ts';
import { connectionSpecFor, refreshRegistration, translocated } from '../../src/http/mutation.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type Frame = { type: string; chat?: string; event?: { kind: string } };

function registry(dataDir: string) {
  const frames: Frame[] = [];
  const lines: string[] = [];
  const chats = createChatRegistry({
    cfg: { port: 4177, dataDir } as never,
    audit: { append: (_kind: string, line: string) => lines.push(line) } as never,
    agents: { evict: () => [] } as never,
    getView: () => 'basic',
    sse: { broadcast: (f: Frame) => frames.push(f), broadcastState: () => {} } as never,
  });
  return { chats, frames, lines };
}

// A PATH with a stand-in grok, and a GROK_HOME holding a login, for as long as `body` runs.
async function withGrok(dir: string, body: () => Promise<void> | void): Promise<void> {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'tests', 'fixtures', 'fake-grok-turn.sh'), path.join(bin, 'grok'));
  fs.mkdirSync(path.join(dir, 'user-grok'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'user-grok', 'auth.json'), '{}');
  const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME };
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.GROK_HOME = path.join(dir, 'user-grok');
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a pick the chat cannot run fails its start with where it runs instead, and starts nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  try {
    writePick(dir, 'codex');
    const { chats } = registry(dir);
    chats.start('human');
    const chat = chats.primary();
    assert.equal(chat.driver.status().state, 'failed');
    const failed = chat.transcript.find((e) => e.kind === 'status' && (e as { state?: string }).state === 'failed') as { reason?: string };
    assert.equal(failed.reason, 'Codex runs in your terminal, not in this chat. Start it there and it joins this window.');
    const payload = chats.payload() as { agent: { id: string; inApp: boolean; reason: string }; chats: Array<{ agent: { id: string } }> };
    assert.equal(payload.agent.id, 'codex');
    assert.equal(payload.agent.inApp, false);
    assert.equal(payload.chats[0].agent.id, 'codex');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok picked is Grok started, and the window is told which vendor it is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  try {
    await withGrok(dir, () => {
      writePick(dir, 'grok');
      const { chats, lines } = registry(dir);
      const before = chats.payload() as { agent: { id: string; name: string } };
      assert.deepEqual(before.agent, { id: 'grok', name: 'Grok', inApp: true, reason: null }, 'the start control can say "Start Grok" before anything runs');
      chats.start('human');
      const chat = chats.primary();
      assert.equal(chat.driver.status().state, 'ready');
      assert.ok(lines.some((l) => l.includes('(Grok)')), 'the audit line names the vendor');
      chat.driver.stop();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat that is not running follows a new pick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  try {
    await withGrok(dir, () => {
      writePick(dir, 'codex');
      const { chats } = registry(dir);
      chats.start('human');
      assert.equal(chats.primary().driver.status().state, 'failed');
      writePick(dir, 'grok');
      chats.start('human');
      const chat = chats.primary();
      assert.equal(chat.driver.status().state, 'ready');
      assert.equal((chats.payload() as { chats: Array<{ agent: { id: string } }> }).chats[0].agent.id, 'grok');
      chat.driver.stop();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a delta reaches the window and never the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  try {
    const { chats, frames } = registry(dir);
    const chat = chats.primary();
    chats.event(chat, { kind: 'delta', block: 1, text: 'Swapping' });
    chats.event(chat, { kind: 'text', block: 1, text: 'Swapping $4 now.' });
    assert.deepEqual(frames.map((f) => f.event?.kind), ['delta', 'text']);
    assert.deepEqual(frames[0], { type: 'driver', chat: chat.id, event: { kind: 'delta', block: 1, text: 'Swapping' } });
    assert.deepEqual(chat.transcript.map((e) => e.kind), ['text']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a developer line goes to the audit log and never to the window or the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  try {
    const { chats, frames, lines } = registry(dir);
    const chat = chats.primary();
    chats.event(chat, { kind: 'debug', message: 'the agent called switch, which no tool in this session has; Claude Code turned it away' });
    assert.deepEqual(frames, []);
    assert.deepEqual(chat.transcript, []);
    assert.ok(lines.some((l) => l.includes('called switch')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const TRANSLOCATED_NODE = '/private/var/folders/vx/x/T/AppTranslocation/0DC04684/d/Phosphor.app/Contents/MacOS/node';

test('a copy of the app running from a translocation path is recognised as one', () => {
  const saved = process.env.PHOSPHOR_APP_DATA;
  process.env.PHOSPHOR_APP_DATA = '1';
  try {
    assert.equal(translocated(connectionSpecFor({ port: 4177, dataDir: '/d' }, TRANSLOCATED_NODE)), true);
    assert.equal(translocated(connectionSpecFor({ port: 4177, dataDir: '/d' }, '/Applications/Phosphor.app/Contents/MacOS/node')), false);
  } finally {
    if (saved === undefined) delete process.env.PHOSPHOR_APP_DATA;
    else process.env.PHOSPHOR_APP_DATA = saved;
  }
});

test('at boot the pick is registered again when it names another connection, once, and never from a translocated copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-vendor-'));
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, PHOSPHOR_APP_DATA: process.env.PHOSPHOR_APP_DATA };
  try {
    // A grok this test owns, found on PATH, and a run that records instead of running.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = bin;
    process.env.HOME = dir;
    process.env.PHOSPHOR_APP_DATA = '1';
    const calls: string[][] = [];
    const run: Run = async (_bin, args) => {
      calls.push(args);
      return { code: 0, stdout: 'Added phosphor', stderr: '', timedOut: false };
    };
    const lines: string[] = [];
    const audit = { append: (_kind: string, line: string) => lines.push(line) } as never;
    const cfg = { port: 4177, dataDir: dir };

    assert.equal(await refreshRegistration(cfg, audit, { run, execPath: process.execPath }), null, 'no pick, nothing to register');
    assert.equal(calls.length, 0);

    writePick(dir, 'grok');
    const first = await refreshRegistration(cfg, audit, { run, execPath: process.execPath });
    assert.equal(first?.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 4), ['mcp', 'add', 'phosphor', process.execPath]);
    assert.deepEqual(readPick(dir)?.registered, connectionSpecFor(cfg, process.execPath), 'the connection written is remembered');

    assert.equal(await refreshRegistration(cfg, audit, { run, execPath: process.execPath }), null, 'an ordinary boot writes nothing');
    assert.equal(calls.length, 1);

    assert.equal(await refreshRegistration(cfg, audit, { run, execPath: TRANSLOCATED_NODE }), null);
    assert.equal(calls.length, 1, 'a translocated copy writes nothing');
    assert.ok(lines.some((l) => l.includes('App Translocation')));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
