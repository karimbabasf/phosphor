// Where the agent's persona travels, and what the person sees while an answer is written.
//
// The persona used to ride in front of the person's first message, so the model read the app's
// rules as something the person had typed, under Claude Code's own coding-agent prompt (R3,
// 2026-09-23: 34K tokens on the first call, "YOU ARE PHOSPHOR" in the first human turn). It is
// the real system prompt now, through a 0600 file named on argv: `ps -axo args=` prints the argv
// of any process this user owns, and a worker's persona is built around a brief another agent
// wrote, so the text itself never goes there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArgv, createDriver } from '../../src/driver.ts';
import type { DriverEvent } from '../../src/driver.ts';
import { lockdownCopy } from '../fixtures/lockdown-copy.ts';

// A copy outside this checkout: see tests/fixtures/lockdown-copy.ts.
const SETTINGS = lockdownCopy();

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ROLE = 'You drive Phosphor. Report in one line.';
const ASK = 'swap 4 dollars into eth';

test('no prose reaches the command line: the persona is a file path, never its text', () => {
  const argv = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x', systemPromptFile: '/data/agents/claude/persona-x.txt' });
  const joined = argv.join(' ');
  assert.ok(!joined.includes('--append-system-prompt'), 'an appended prompt keeps the coding-agent prompt in front of it');
  assert.equal(argv[argv.indexOf('--system-prompt-file') + 1], '/data/agents/claude/persona-x.txt');
  assert.ok(!argv.includes('--system-prompt'), 'the text form of the flag puts the persona on argv');
  assert.ok(argv.includes('--no-session-persistence'), 'money chats stay out of ~/.claude/projects');
  assert.ok(argv.includes('--include-partial-messages'), 'the window prints an answer as it is written');
});

type Run = { events: DriverEvent[]; turns: string[]; argv: string; home: string; left: string[] };

// The real spawn, the real stdin write and the real parser, over a stand-in binary.
async function drive(opts: { systemPrompt?: string; sends: string[]; notes?: string[] }): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-prompt-'));
  const home = path.join(dir, 'agents', 'claude');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const events: DriverEvent[] = [];
  try {
    const driver = createDriver({
      repo: ROOT,
      port: 4177,
      home,
      claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-stream.sh'),
      settingsPath: SETTINGS,
      systemPrompt: opts.systemPrompt,
      onEvent: (event) => events.push(event),
    });
    driver.start();
    const deadline = Date.now() + 20_000;
    while (driver.status().state !== 'ready' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const note of opts.notes ?? []) driver.note(note);
    for (const [i, text] of opts.sends.entries()) {
      driver.send(text);
      while (Date.now() < deadline && driver.status().state !== 'failed' && events.filter((e) => e.kind === 'turn_end').length <= i) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    // What the child read at startup (the stand-in keeps a copy: the driver removes the file once
    // the init line is out). Read after the turns, by which time the stand-in has long made it.
    const seen = path.join(dir, 'persona-seen.txt');
    const personaText = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '';
    const personaMode = fs.existsSync(seen) ? Number.parseInt(fs.readFileSync(path.join(dir, 'persona-mode.txt'), 'utf8').trim(), 8) : 0;
    const turnFile = path.join(dir, 'turns.jsonl');
    const turns = fs.existsSync(turnFile) ? fs.readFileSync(turnFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).message.content[0].text as string) : [];
    const argv = fs.readFileSync(path.join(dir, 'claude-argv.txt'), 'utf8');
    // Looked at before stop(), which would remove it too: the init line is what must have.
    const left = fs.existsSync(home) ? fs.readdirSync(home).filter((f) => f.startsWith('persona-')) : [];
    driver.stop();
    if (opts.systemPrompt !== undefined) {
      assert.equal(personaText, opts.systemPrompt, 'the file holds the persona, whole');
      assert.equal(personaMode, 0o600, 'readable by this user alone');
    }
    return { events, turns, argv, home, left };
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the persona is the system prompt: named on argv as a file, and absent from every turn', async () => {
  const run = await drive({ systemPrompt: ROLE, sends: [ASK] });
  assert.ok(run.argv.includes('--system-prompt-file'), run.argv);
  assert.ok(!run.argv.includes(ROLE), 'ps would print it');
  assert.deepEqual(run.turns, [ASK], 'the person\'s words go down the pipe as they typed them');
});

test('a driver with no persona names no file', async () => {
  const run = await drive({ sends: [ASK] });
  assert.ok(!run.argv.includes('--system-prompt-file'));
  assert.deepEqual(run.turns, [ASK]);
});

test('the persona file is gone once the agent has read it', async () => {
  const run = await drive({ systemPrompt: ROLE, sends: [ASK] });
  assert.deepEqual(run.left, [], 'the persona outlived the init line');
});

test('an answer streams: deltas carry a block number, and the whole block closes it', async () => {
  const run = await drive({ systemPrompt: ROLE, sends: [ASK] });
  const deltas = run.events.filter((e): e is Extract<DriverEvent, { kind: 'delta' }> => e.kind === 'delta');
  const texts = run.events.filter((e): e is Extract<DriverEvent, { kind: 'text' }> => e.kind === 'text');
  assert.deepEqual(deltas.map((d) => d.text), ['Swapping $4 ', 'now.']);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'Swapping $4 now.');
  assert.ok(deltas.every((d) => d.block === texts[0].block), 'the text closes the stream its deltas opened');
  assert.ok(run.events.findIndex((e) => e.kind === 'delta') < run.events.findIndex((e) => e.kind === 'text'));
});

test('a note waits for the next message and rides in front of it, once, never as a turn of its own', async () => {
  const run = await drive({ sends: ['first', 'second'], notes: ['[phosphor: the swap ended: Confirmed.]'] });
  assert.equal(run.turns.length, 2, 'a note starts no turn');
  assert.ok(run.turns[0].startsWith('[phosphor: the swap ended: Confirmed.]'), run.turns[0]);
  assert.ok(run.turns[0].endsWith('first'));
  assert.equal(run.turns[1], 'second', 'a note rides one turn');
});

test('a page read with WebFetch is shown as a web read, and never drawn as a card', async () => {
  const run = await drive({ sends: ['what is near ai WEB-FETCH'] });
  const calls = run.events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result') as Array<{ kind: string; name: string; input?: unknown }>;
  assert.deepEqual(calls.map((e) => `${e.kind} ${e.name}`), ['tool web_fetch', 'tool_result web_fetch']);
  assert.deepEqual(calls[0].input, { url: 'https://near.ai', prompt: 'What is NEAR AI, in one line?' });
  assert.equal(run.events.some((e) => e.kind === 'tool_data' || e.kind === 'error'), false);
});

test('a tool the API ran inside Claude\'s reply ends the session', async () => {
  const run = await drive({ sends: ['SERVER-TOOL'] });
  const error = run.events.find((e) => e.kind === 'error') as { message: string } | undefined;
  assert.ok(error?.message.includes('server web_search'), String(error?.message));
});

test('a message sent right after a stop is its own turn: the stopped answer\'s late result never ends it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-prompt-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    home: path.join(dir, 'agents', 'claude'),
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-stream.sh'),
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };
  try {
    driver.start();
    await until(() => driver.status().state === 'ready');
    driver.send('SLOW-ANSWER count to a hundred');
    await until(() => events.some((e) => e.kind === 'delta'));
    assert.equal(driver.interrupt(), true);
    await new Promise((r) => setTimeout(r, 50));
    // 50 ms after the stop, 250 ms before the stopped answer's result comes out.
    const sent = events.length;
    driver.send('second');
    await until(() => events.filter((e) => e.kind === 'turn_end').length === 2 && driver.status().state === 'ready');
    const after = events.slice(sent);
    const early = after.slice(0, after.findLastIndex((e) => e.kind === 'turn_end')).filter((e) => e.kind === 'status' && e.state === 'ready');
    assert.deepEqual(early, [], 'the window read ready while the message sent after the stop was still being answered');
    const ends = events.filter((e): e is Extract<DriverEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    assert.deepEqual(ends.map((e) => e.error), [false, false], 'a stop the person asked for is not an error');
    const texts = events.filter((e): e is Extract<DriverEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text);
    assert.deepEqual(texts, ['Counting: 1, 2, ', 'Swapping $4 now.']);
    assert.equal(driver.status().state, 'ready');
    const turns = fs.readFileSync(path.join(dir, 'turns.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(turns.length, 2);
    assert.ok(turns[1].includes('second'), turns[1]);
    assert.equal(fs.readFileSync(path.join(dir, 'controls.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1, 'one interrupt');
  } finally {
    driver.stop();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool name no tool has keeps the chat: the CLI turns it away, and only the developer\'s log hears of it', async () => {
  const run = await drive({ sends: ['show me BTC UNKNOWN-TOOL'] });
  assert.equal(run.events.some((e) => e.kind === 'error' || (e.kind === 'status' && e.state === 'failed')), false, 'the chat ended');
  assert.equal(run.events.some((e) => (e.kind === 'tool' || e.kind === 'tool_result') && e.name === 'switch'), false, 'the window was told');
  const debug = run.events.filter((e): e is Extract<DriverEvent, { kind: 'debug' }> => e.kind === 'debug');
  assert.equal(debug.length, 1);
  assert.match(debug[0].message, /called switch, which no tool in this session has/);
  assert.ok(run.events.some((e) => e.kind === 'text' && e.text === 'Swapping $4 now.'), 'the answer came after the refusal');
  assert.ok(run.events.some((e) => e.kind === 'turn_end' && !e.error));
});

test('Bash, Write and another server\'s tool still end the session', async () => {
  for (const [mode, name] of [['BASH-TOOL', 'Bash'], ['WRITE-TOOL', 'Write'], ['OTHER-SERVER-TOOL', 'mcp__other__peek']]) {
    const run = await drive({ sends: [mode] });
    const error = run.events.find((e): e is Extract<DriverEvent, { kind: 'error' }> => e.kind === 'error');
    assert.ok(error?.message.startsWith(`refusing to drive: the agent called ${name},`), `${mode}: ${String(error?.message)}`);
  }
});

test('a persona file is gone when the agent cannot even start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-prompt-'));
  const home = path.join(dir, 'agents', 'claude');
  // A file that exists and cannot be run: the spawn fails with EACCES and never exits.
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o600 });
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    home,
    claudeBin: bin,
    settingsPath: SETTINGS,
    systemPrompt: ROLE,
    onEvent: (event) => events.push(event),
  });
  try {
    driver.start();
    const deadline = Date.now() + 20_000;
    while (driver.status().state !== 'failed' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(driver.status().state, 'failed');
    const left = fs.existsSync(home) ? fs.readdirSync(home).filter((f) => f.startsWith('persona-')) : [];
    assert.deepEqual(left, []);
  } finally {
    driver.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
