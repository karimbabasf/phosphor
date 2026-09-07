// Where the agent's role text travels, and why it is not argv any more.
//
// `ps -axo args=` prints the argv of any process this user owns. That is the same fact that moved
// the window token off the environment (src/http/auth.ts) and the Hyperliquid key off it before
// that. The role text used to arrive as `--append-system-prompt`, and for a worker that text is
// built around the BRIEF an operator agent wrote, so every worker published one agent's
// instructions to every process on the machine. Information disclosure only: no money path, no
// privilege gain, and the operator that wrote the brief already holds strictly more capability
// than the analyst reading it. It costs nothing to close, so it is closed.
//
// It now goes down stdin, merged into the first turn. Merged rather than sent alone because Claude
// Code does not emit its init event until a turn arrives, so a role text on its own would start a
// model turn nobody asked for and the human would watch the agent answer it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArgv, createDriver } from '../../src/driver.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ROLE = 'You drive Phosphor. Report in one paragraph.';
const BRIEF = 'Measure the four hour range on SOL and say where it breaks.';

test('no prose reaches the command line, whatever the caller asked for', () => {
  const argv = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x' });
  const joined = argv.join(' ');
  assert.ok(!joined.includes('--append-system-prompt'), 'ps prints this to every process on the machine');
  assert.ok(!joined.includes('--system-prompt'));
});

// Runs the real spawn, the real stdin write and the real parser against a stand-in binary, because
// the whole point is what lands on the pipe rather than what a function returns.
async function driveOnce(opts: { systemPrompt?: string }): Promise<{ turns: string[]; argv: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-prompt-'));
  const turnFile = path.join(dir, 'turns.jsonl');
  const previous = process.env.PHOSPHOR_TEST_TURNS;
  process.env.PHOSPHOR_TEST_TURNS = turnFile;
  try {
    const driver = createDriver({
      repo: ROOT,
      port: 4177,
      claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-turns.sh'),
      settingsPath: path.join(ROOT, 'operator', 'driver.settings.json'),
      systemPrompt: opts.systemPrompt,
      onEvent: () => {},
    });
    driver.start();

    const deadline = Date.now() + 5_000;
    while (driver.status().state !== 'ready' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    driver.send(BRIEF);

    // The fixture appends a line per turn; wait for the first to land rather than for a fixed time.
    while (Date.now() < deadline) {
      if (fs.existsSync(turnFile) && fs.readFileSync(turnFile, 'utf8').includes('\n')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const written = fs.existsSync(turnFile) ? fs.readFileSync(turnFile, 'utf8') : '';
    driver.stop();

    return {
      turns: written.split('\n').filter((line) => line.trim().length > 0),
      argv: buildArgv({ repo: ROOT, nodeBin: '/n', settings: '/s.json', sessionId: 'x' }).join(' '),
    };
  } finally {
    if (previous === undefined) delete process.env.PHOSPHOR_TEST_TURNS;
    else process.env.PHOSPHOR_TEST_TURNS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the role text goes down the pipe with the first turn, and nowhere else', async () => {
  const { turns, argv } = await driveOnce({ systemPrompt: ROLE });
  assert.equal(turns.length, 1, 'one turn, so the round trips are what they always were');

  const first = JSON.parse(turns[0]) as { type: string; message: { content: Array<{ text: string }> } };
  assert.equal(first.type, 'user');
  const text = first.message.content[0].text;
  assert.ok(text.includes(ROLE), 'the agent still learns who it is');
  assert.ok(text.includes(BRIEF), 'and what it was asked');
  assert.ok(text.indexOf(ROLE) < text.indexOf(BRIEF), 'the role comes first, as an appended prompt did');
  assert.ok(!argv.includes(ROLE));
});

test('a driver with no role text sends the turn unchanged', async () => {
  const { turns } = await driveOnce({});
  assert.equal(turns.length, 1);
  const first = JSON.parse(turns[0]) as { message: { content: Array<{ text: string }> } };
  assert.equal(first.message.content[0].text, BRIEF, 'nothing is prepended when there is nothing to prepend');
});

test('the role text rides exactly one turn, not every turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-prompt-'));
  const turnFile = path.join(dir, 'turns.jsonl');
  const previous = process.env.PHOSPHOR_TEST_TURNS;
  process.env.PHOSPHOR_TEST_TURNS = turnFile;
  try {
    const driver = createDriver({
      repo: ROOT,
      port: 4177,
      claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-turns.sh'),
      settingsPath: path.join(ROOT, 'operator', 'driver.settings.json'),
      systemPrompt: ROLE,
      onEvent: () => {},
    });
    driver.start();
    const deadline = Date.now() + 5_000;
    while (driver.status().state !== 'ready' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    driver.send('first');
    driver.send('second');
    while (Date.now() < deadline) {
      const seen = fs.existsSync(turnFile) ? fs.readFileSync(turnFile, 'utf8').split('\n').filter(Boolean) : [];
      if (seen.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const turns = fs.readFileSync(turnFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    driver.stop();

    assert.equal(turns.length, 2);
    assert.ok(turns[0].message.content[0].text.includes(ROLE));
    assert.equal(turns[1].message.content[0].text, 'second', 'a conversation is not the role text over and over');
  } finally {
    if (previous === undefined) delete process.env.PHOSPHOR_TEST_TURNS;
    else process.env.PHOSPHOR_TEST_TURNS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
