// Grok in the window's chat, over a stand-in that plays grok 1.0.40's measured stream
// (tests/fixtures/fake-grok-turn.sh): one process per turn, Phosphor's tools reached through
// use_tool, and the session refused on the first name that is not Phosphor's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver } from '../../src/driver.ts';
import type { Driver, DriverEvent } from '../../src/driver.ts';
import { grok, sessionDir } from '../../src/providers/grok.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type World = { dir: string; home: string; events: DriverEvent[]; driver: Driver; argv: () => string[]; done: () => void };

// A PATH with the stand-in called grok on it, a GROK_HOME with a login in it and the Phosphor
// server registered the way the Vault's `grok mcp add` does, and a TMPDIR the stand-in records its
// argv under. All three are restored by done().
function world(opts: { login?: boolean; registered?: boolean } = {}): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-grok-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, 'tests', 'fixtures', 'fake-grok-turn.sh'), path.join(bin, 'grok'));
  const grokHome = path.join(dir, 'user-grok');
  fs.mkdirSync(grokHome);
  if (opts.login !== false) fs.writeFileSync(path.join(grokHome, 'auth.json'), '{"login":"fake"}', { mode: 0o600 });
  if (opts.registered !== false) fs.writeFileSync(path.join(grokHome, 'config.toml'), '[mcp_servers.phosphor]\ncommand = "node"\n');
  const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME, TMPDIR: process.env.TMPDIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.GROK_HOME = grokHome;
  process.env.TMPDIR = dir;
  const home = path.join(dir, 'agents', 'grok');
  const events: DriverEvent[] = [];
  const driver = createDriver({ repo: ROOT, port: 4177, provider: grok, home, systemPrompt: 'You are Phosphor.', onEvent: (e) => events.push(e) });
  return {
    dir,
    home,
    events,
    driver,
    argv: () => {
      const file = path.join(dir, 'grok-argv.txt');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    },
    done: () => {
      driver.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

const turnEnds = (w: World) => w.events.filter((e) => e.kind === 'turn_end').length;

test('grok is ready without a process, and each message is one turn that ends ready again', async () => {
  const w = world();
  try {
    w.driver.start();
    assert.equal(w.driver.status().state, 'ready');
    assert.equal(w.driver.status().running, true, 'ready to answer is running, though no process exists');
    w.driver.send('what do I hold');
    await until(() => turnEnds(w) === 1 && w.driver.status().state === 'ready');
    assert.equal(w.driver.status().state, 'ready');

    const tools = w.events.filter((e) => e.kind === 'tool');
    assert.deepEqual(tools.map((e) => (e as { name: string }).name), ['mcp__phosphor__wallet']);
    const data = w.events.find((e) => e.kind === 'tool_data') as { data: { totalUsd: number } } | undefined;
    assert.equal(data?.data.totalUsd, 8.66, 'the card is drawn from the tool\'s own answer, wrapper off');

    const deltas = w.events.filter((e) => e.kind === 'delta') as Array<{ block: number; text: string }>;
    const texts = w.events.filter((e) => e.kind === 'text') as Array<{ block: number; text: string }>;
    assert.deepEqual(deltas.map((d) => d.text), ['Checking ', 'your balance.']);
    assert.equal(texts[0].text, 'Checking your balance.');
    assert.equal(texts[0].block, deltas[0].block);
    assert.equal(texts[1].text, 'About **$8.66**, almost all USDC.');
    assert.notEqual(texts[1].block, texts[0].block, 'an unstreamed block still gets a number of its own');

    const [line] = w.argv();
    assert.ok(line.includes(` grok_home=${path.join(w.dir, 'user-grok')} `), `the child runs on the person's own grok home: ${line}`);
    assert.ok(line.includes(` home=${w.home} `), `under a HOME the app owns: ${line}`);
    assert.equal(fs.existsSync(path.join(w.home, '.grok')), false, 'the app keeps no copy of the login or the config');
  } finally {
    w.done();
  }
});

test('the second turn resumes the session the first one created', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('first');
    await until(() => turnEnds(w) === 1 && w.driver.status().state === 'ready');
    w.driver.send('second');
    await until(() => turnEnds(w) === 2 && w.driver.status().state === 'ready');
    const [first, second] = w.argv();
    const id = /--session-id (\S+)/.exec(first)?.[1];
    assert.ok(id, first);
    assert.ok(second.includes(`--resume ${id}`), second);
    assert.ok(first.includes('--system-prompt-override You are Phosphor.'), 'grok takes the persona as its whole system prompt');
  } finally {
    w.done();
  }
});

test('two chats on Grok keep their own turn files, and each is gone once its turn ends', async () => {
  const w = world();
  const other: DriverEvent[] = [];
  const second = createDriver({ repo: ROOT, port: 4177, provider: grok, home: w.home, onEvent: (e) => other.push(e) });
  try {
    w.driver.start();
    second.start();
    w.driver.send('first');
    second.send('second');
    await until(() => turnEnds(w) === 1 && other.some((e) => e.kind === 'turn_end'));
    const files = w.argv().map((line) => /--prompt-file (\S+)/.exec(line)?.[1]);
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1], 'one file for two chats hands one chat\'s words to the other');
    for (const file of files) assert.equal(fs.existsSync(String(file)), false, `${file} outlived its turn`);
  } finally {
    second.stop();
    w.done();
  }
});

test('a chat stopped and started again asks grok for a new session, and keeps its own seat', async () => {
  const w = world();
  // The chat registry hands every driver its chat's seat, fixed for the life of the chat.
  const chat = createDriver({ repo: ROOT, port: 4177, provider: grok, home: w.home, session: 'chat-seat-1', onEvent: (e) => w.events.push(e) });
  try {
    chat.start();
    chat.send('first');
    await until(() => turnEnds(w) === 1 && chat.status().state === 'ready');
    chat.stop();
    chat.start();
    chat.send('second');
    await until(() => turnEnds(w) === 2 && chat.status().state === 'ready');
    const [first, second] = w.argv();
    const a = /--session-id (\S+)/.exec(first)?.[1];
    const b = /--session-id (\S+)/.exec(second)?.[1];
    assert.ok(a && b, `${first}\n${second}`);
    assert.notEqual(a, b, 'grok refuses --session-id for a session it already holds');
    assert.ok(!second.includes('--resume'));
    for (const line of [first, second]) assert.ok(line.endsWith('seat=chat-seat-1'), `the chat's cards lose their chat: ${line}`);
  } finally {
    chat.stop();
    w.done();
  }
});

test('a turn is ready only once its process has gone, and ends once', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('LINGER');
    await until(() => turnEnds(w) === 1);
    assert.equal(w.driver.status().state, 'thinking', 'ready while the process still holds the session invites a refused send');
    await until(() => w.driver.status().state === 'ready');
    assert.equal(w.driver.status().state, 'ready');
    assert.equal(turnEnds(w), 1, 'the exit after a result line is not a second turn');
  } finally {
    w.done();
  }
});

test('a stopped turn says nothing more into the chat', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('NOISY');
    await until(() => w.argv().length === 1);
    await new Promise((r) => setTimeout(r, 200));
    w.driver.stop();
    const after = w.events.length;
    await new Promise((r) => setTimeout(r, 700));
    const late = w.events.slice(after).filter((e) => e.kind === 'error');
    assert.deepEqual(late, [], 'a dying process still wrote into the chat');
  } finally {
    w.done();
  }
});

test('a refused turn leaves no turn file behind', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('BUILTIN');
    await until(() => w.driver.status().state === 'failed');
    const left = fs.readdirSync(w.home).filter((f) => f.startsWith('turn-'));
    assert.deepEqual(left, []);
  } finally {
    w.done();
  }
});

const failedStatus = (w: World) =>
  w.events.find((e) => e.kind === 'status' && (e as { state: string }).state === 'failed') as { reason?: string; detail?: string };

test('a grok home that would load hooks refuses the turn with a sentence, and starts nothing', async () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.dir, 'user-grok', 'hooks'));
    w.driver.start();
    w.driver.send('what do I hold');
    assert.equal(w.driver.status().state, 'failed');
    assert.equal(failedStatus(w).reason, 'Your Grok setup loads hooks, rules, plugins or other tool servers Phosphor did not put there, so Grok will not start here.');
    assert.ok(failedStatus(w).detail?.includes('1 hooks'), String(failedStatus(w).detail));
    assert.deepEqual(w.argv(), [], 'a turn ran');
  } finally {
    w.done();
  }
});

test('a tool server of the person\'s own in their grok config refuses the turn, since it would join a money chat', async () => {
  const w = world();
  try {
    fs.appendFileSync(path.join(w.dir, 'user-grok', 'config.toml'), '\n[mcp_servers.other]\ncommand = "other"\n');
    w.driver.start();
    w.driver.send('what do I hold');
    assert.equal(w.driver.status().state, 'failed');
    assert.ok(failedStatus(w).detail?.includes('server other'), String(failedStatus(w).detail));
    assert.deepEqual(w.argv(), [], 'a turn ran');
  } finally {
    w.done();
  }
});

test('with Phosphor not registered in grok, the turn says to pick Grok again, and starts nothing', async () => {
  const w = world({ registered: false });
  try {
    w.driver.start();
    w.driver.send('what do I hold');
    assert.equal(w.driver.status().state, 'failed');
    assert.equal(failedStatus(w).reason, "Grok isn't connected to this copy of Phosphor yet. Pick Grok again in the Vault, then start it.");
    assert.deepEqual(w.argv(), [], 'a turn ran');
  } finally {
    w.done();
  }
});

test('a page read with grok\'s web_fetch is shown as a web read, never drawn as a card, and the turn goes on', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('WEB then read');
    await until(() => turnEnds(w) === 1 && w.driver.status().state === 'ready');
    assert.equal(w.driver.status().state, 'ready');
    const calls = w.events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result') as Array<{ kind: string; name: string; input?: unknown; ok?: boolean }>;
    assert.deepEqual(calls.map((e) => `${e.kind} ${e.name}`), ['tool web_fetch', 'tool_result web_fetch', 'tool mcp__phosphor__wallet', 'tool_result mcp__phosphor__wallet']);
    assert.deepEqual(calls[0].input, { url: 'https://near.ai' });
    assert.equal(calls[1].ok, true);
    const cards = w.events.filter((e) => e.kind === 'tool_data').map((e) => (e as { name: string }).name);
    assert.deepEqual(cards, ['mcp__phosphor__wallet']);
  } finally {
    w.done();
  }
});

test('a web search the API ran inside the reply is allowed, and shown as one', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('SERVERWEB then read');
    await until(() => turnEnds(w) === 1 && w.driver.status().state === 'ready');
    assert.notEqual(w.driver.status().state, 'failed');
    const calls = w.events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result').map((e) => `${e.kind} ${(e as { name: string }).name}`);
    assert.deepEqual(calls.slice(0, 2), ['tool web_search', 'tool_result web_search']);
  } finally {
    w.done();
  }
});

test('a stopped chat\'s session leaves the person\'s grok history, and nobody else\'s does', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('first');
    await until(() => turnEnds(w) === 1 && w.driver.status().state === 'ready');
    const id = /--session-id (\S+)/.exec(w.argv()[0])?.[1] ?? '';
    const grokHome = path.join(w.dir, 'user-grok');
    // Where grok 1.0.40 kept the session (measured): sessions/<the cwd, URL-encoded>/<id>.
    const ours = sessionDir(grokHome, w.home, id);
    const theirs = sessionDir(grokHome, '/Users/someone/project', id);
    for (const dir of [ours, theirs]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'messages.json'), '[]');
    }
    // What grok keeps beside the sessions of one cwd: every prompt typed there, in plain text.
    fs.writeFileSync(path.join(path.dirname(ours), 'prompt_history.jsonl'), `{"session_id":"${id}","prompt":"send 5 USDC"}\n`);
    w.driver.stop();
    assert.equal(fs.existsSync(ours), false, 'a money chat stayed in the person\'s grok history');
    assert.equal(fs.existsSync(path.dirname(ours)), false, 'the chat\'s prompts, or the app\'s emptied folder, stayed behind');
    assert.equal(fs.existsSync(theirs), true, 'a session of the person\'s own was removed');
  } finally {
    w.done();
  }
});

test('a look-up through search_tool is allowed and never drawn', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('SEARCH then read');
    await until(() => turnEnds(w) === 1);
    const tools = w.events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result').map((e) => (e as { name: string }).name);
    assert.deepEqual(tools, ['mcp__phosphor__wallet', 'mcp__phosphor__wallet']);
  } finally {
    w.done();
  }
});

test('a tool called by its listed name reads as Phosphor\'s own', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('DIRECT then read');
    await until(() => turnEnds(w) === 1);
    const tools = w.events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name);
    assert.deepEqual(tools, ['mcp__phosphor__policy_show', 'mcp__phosphor__wallet']);
    assert.notEqual(w.driver.status().state, 'failed');
  } finally {
    w.done();
  }
});

test('a built-in tool on the stream ends the session', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('BUILTIN');
    await until(() => w.driver.status().state === 'failed');
    assert.equal(w.driver.status().state, 'failed');
    const error = w.events.find((e) => e.kind === 'error') as { message: string } | undefined;
    assert.ok(error?.message.startsWith('refusing to drive'), String(error?.message));
    assert.ok(error?.message.includes('run_terminal_command'));
  } finally {
    w.done();
  }
});

test('a second MCP server on the init line ends the session before the model can use it', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('FOREIGN');
    await until(() => w.driver.status().state === 'failed');
    const error = w.events.find((e) => e.kind === 'error') as { message: string } | undefined;
    assert.ok(error?.message.includes('server other'), String(error?.message));
    assert.equal(w.events.some((e) => e.kind === 'tool'), false);
  } finally {
    w.done();
  }
});

test('stopping an answer ends that turn and keeps the chat', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('SLOW');
    await until(() => w.argv().length === 1);
    assert.equal(w.driver.interrupt(), true);
    await until(() => turnEnds(w) === 1);
    await until(() => w.driver.status().state === 'ready');
    assert.equal(w.driver.status().state, 'ready');
    const end = w.events.find((e) => e.kind === 'turn_end') as { error: boolean };
    assert.equal(end.error, false, 'a stop the person asked for is not an error');
  } finally {
    w.done();
  }
});

test('a message sent right after a stop waits for the stopped turn\'s process to go: one session never has two', async () => {
  const w = world();
  try {
    w.driver.start();
    w.driver.send('STUBBORN');
    await until(() => w.argv().length === 1);
    assert.equal(w.driver.interrupt(), true);
    await new Promise((r) => setTimeout(r, 50));
    // 50 ms after the stop, while the stopped turn still holds the session for another 450.
    w.driver.send('second');
    await until(() => turnEnds(w) === 2 && w.driver.status().state === 'ready');
    const overlap = path.join(w.dir, 'grok-overlap.txt');
    assert.equal(fs.existsSync(overlap), false, fs.existsSync(overlap) ? fs.readFileSync(overlap, 'utf8') : '');
    const [first, second] = w.argv();
    const id = /--session-id (\S+)/.exec(first)?.[1];
    assert.ok(id && second?.includes(`--resume ${id}`), String(second));
    const ends = w.events.filter((e) => e.kind === 'turn_end') as Array<{ error: boolean }>;
    assert.deepEqual(ends.map((e) => e.error), [false, false], 'a stop the person asked for is not an error, and the answer behind it ends on its own');
    const texts = w.events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
    assert.ok(texts.includes('About **$8.66**, almost all USDC.'), 'the message sent behind the stop was answered');
  } finally {
    w.done();
  }
});

test('with no Grok login the start fails with a sentence, and nothing is spawned', () => {
  const w = world({ login: false });
  try {
    w.driver.start();
    assert.equal(w.driver.status().state, 'failed');
    const status = w.events.find((e) => e.kind === 'status' && (e as { state: string }).state === 'failed') as { reason?: string };
    assert.equal(status.reason, 'Grok is not signed in. Run grok login in a terminal, then start it again.');
    assert.equal(fs.existsSync(path.join(w.dir, 'grok-argv.txt')), false);
  } finally {
    w.done();
  }
});
