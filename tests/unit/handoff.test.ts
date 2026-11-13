// The vendor switch inside an open chat (src/handoff.ts, src/http/chats.ts handoff): the new
// agent is told the conversation so far, in a small capsule with nothing secret in it, and the
// switch loosens nothing the old session had earned (its web-read mark).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCapsule, CAPSULE_MAX, redact } from '../../src/handoff.ts';
import type { DriverEvent } from '../../src/driver.ts';
import { createChatRegistry } from '../../src/http/chats.ts';
import { writePick, readPick } from '../../src/agents-catalog.ts';
import { vendorFor } from '../../src/providers/index.ts';
import { markWebRead, webReadBy, clearWebRead } from '../../src/web-read.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const NAMES = { from: 'Claude Code', to: 'Grok' };

type Entry = DriverEvent & { at: number };
const at = (e: DriverEvent): Entry => ({ ...e, at: 0 });

function conversation(): Entry[] {
  return [
    at({ kind: 'status', state: 'ready' }),
    at({ kind: 'said', text: 'Find me a long on SOL near 140, the codeword is PELICAN.' }),
    at({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} }),
    at({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true }),
    at({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: { total: 412.5 } }),
    at({ kind: 'text', text: 'You hold $412.50. SOL at 140 is a clean retest of the range low.' }),
    at({ kind: 'said', text: 'Plan it with a stop at 132.' }),
    at({ kind: 'tool', name: 'mcp__phosphor__propose_trade', input: { coin: 'SOL', side: 'long', stop: 132 } }),
    at({ kind: 'tool_result', name: 'mcp__phosphor__propose_trade', ok: true }),
    at({ kind: 'text', text: 'The plan is on the card: long SOL at 140, stop 132.' }),
    at({ kind: 'turn_end', error: false, turns: 3 }),
  ];
}

test('an empty chat carries nothing', () => {
  assert.equal(buildCapsule([], NAMES), null);
  assert.equal(buildCapsule([at({ kind: 'status', state: 'ready' })], NAMES), null);
});

test('the capsule names the switch, sums the task up, keeps the last turns word for word and says what is open', () => {
  const capsule = buildCapsule(conversation(), NAMES) ?? '';
  assert.ok(capsule.startsWith('[phosphor: handoff.'), 'an app note, in the shape the persona already reads as the app');
  assert.ok(capsule.endsWith(']'));
  assert.match(capsule, /from Claude Code to Grok/);
  assert.match(capsule, /The person opened with: "Find me a long on SOL near 140, the codeword is PELICAN\."/);
  assert.match(capsule, /Tools used: wallet, propose_trade\./);
  assert.match(capsule, /Person: Plan it with a stop at 132\./);
  assert.match(capsule, /Assistant: The plan is on the card: long SOL at 140, stop 132\./);
  assert.match(capsule, /Tool: wallet \{\} \(ok\) -> \{"total":412\.5\}/);
  assert.match(capsule, /A move was proposed: propose_trade \{"coin":"SOL","side":"long","stop":132\}/);
  assert.match(capsule, /approves nothing/);
});

test('a message with no answer yet is named as open', () => {
  const capsule = buildCapsule([...conversation(), at({ kind: 'said', text: 'And add 20 USDC first.' })], NAMES) ?? '';
  assert.match(capsule, /last message has no answer yet: "And add 20 USDC first\."/);
});

test('an earlier switch shows where the other vendor took over', () => {
  const events = [...conversation().slice(0, 6), at({ kind: 'handoff', from: 'Claude Code', to: 'Grok' }), ...conversation().slice(6)];
  const capsule = buildCapsule(events, { from: 'Grok', to: 'Claude Code' }) ?? '';
  assert.match(capsule, /\(Grok took over the chat here\.\)\nPerson: Plan it with a stop at 132\./);
});

test('a long chat stays under the cap, keeps the newest turns and says how many it left out', () => {
  const events: Entry[] = [];
  for (let i = 0; i < 40; i += 1) {
    events.push(at({ kind: 'said', text: `question ${i} ${'x'.repeat(1500)}` }));
    events.push(at({ kind: 'text', text: `answer ${i} ${'y'.repeat(3000)}` }));
  }
  const capsule = buildCapsule(events, NAMES) ?? '';
  assert.ok(capsule.length <= CAPSULE_MAX, `${capsule.length} characters`);
  assert.ok(capsule.endsWith(']'), 'the note is closed, not cut');
  assert.match(capsule, /question 39/);
  assert.doesNotMatch(capsule, /question 20 /);
  assert.match(capsule, /earlier turns left out/);
  assert.match(capsule, /The person opened with: "question 0/, 'the summary still has the start of the task');
});

test('nothing secret reaches the capsule: keys, recovery phrases, tokens, key-shaped fields', () => {
  const key = `0x${'4f'.repeat(32)}`;
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const events = [
    at({ kind: 'said', text: `my key is ${key} and my words are ${phrase} ok` }),
    at({ kind: 'tool', name: 'mcp__phosphor__wallet', input: { privateKey: 'hunter2', mnemonic: 'x', coin: 'ETH' } }),
    at({ kind: 'text', text: 'Never paste sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA or xai-BBBBBBBBBBBBBBBBBBBBBBBB here.' }),
  ];
  const capsule = buildCapsule(events, NAMES) ?? '';
  assert.ok(!capsule.includes('4f4f4f4f'), 'the hex key');
  assert.ok(!capsule.includes('abandon ability'), 'the phrase');
  assert.ok(!capsule.includes('hunter2') && !capsule.includes('privateKey') && !capsule.includes('mnemonic'), 'key-shaped fields');
  assert.ok(!capsule.includes('AAAAAAAAAAAA') && !capsule.includes('BBBBBBBBBBBB'), 'tokens');
  assert.match(capsule, /\[a key, removed\]/);
  assert.match(capsule, /\[a recovery phrase, removed\] ok/);
  assert.match(capsule, /"coin":"ETH"/, 'the rest of the call stays');
});

test('ordinary trading talk passes redaction untouched', () => {
  const line = 'Swap 20 USDC into WETH, then short SOL at 10x if it loses 132, and cap me at $200.';
  assert.equal(redact(line), line);
});

// ---------- the switch, through the registry and two real drivers ----------

async function until(check: () => boolean, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a switch from Grok to Claude Code hands the new session the conversation, keeps the web-read mark, and draws one quiet line', async () => {
  const dir = tempDir('phosphor-handoff-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'tests', 'fixtures', 'fake-grok-turn.sh'), path.join(bin, 'grok'));
  fs.mkdirSync(path.join(dir, 'user-grok'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'user-grok', 'auth.json'), '{}');
  const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME, TMPDIR: process.env.TMPDIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.GROK_HOME = path.join(dir, 'user-grok');
  process.env.TMPDIR = dir;
  const lines: string[] = [];
  const chats = createChatRegistry({
    cfg: { port: 4177, dataDir: dir, driver: { claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-turns.sh') } } as never,
    audit: { append: (_kind: string, line: string) => lines.push(line) } as never,
    agents: { evict: () => [], markOwn: () => {} } as never,
    getView: () => 'basic',
    sse: { broadcast: () => {}, broadcastState: () => {} } as never,
  });
  try {
    writePick(dir, 'grok');
    chats.start('human');
    const chat = chats.primary();
    assert.equal(chat.driver.status().state, 'ready');
    for (const event of conversation()) chats.event(chat, event);
    markWebRead(chat.session);

    const handed = chats.handoff(chat, vendorFor('claude'));
    assert.deepEqual(handed, { ok: true });
    const after = chat.transcript.slice(chat.transcript.findIndex((e) => e.kind === 'handoff'));
    assert.deepEqual(after[0], { kind: 'handoff', from: 'Grok', to: 'Claude Code', at: after[0].at });
    assert.ok(!after.some((e) => e.kind === 'status' && e.state === 'stopped'), 'the old driver going says nothing in the chat');
    assert.ok(chat.transcript.some((e) => e.kind === 'said'), 'the window keeps the conversation');
    assert.ok(lines.some((l) => l.includes('handed AGENT 1 from Grok to Claude Code')));
    assert.equal((chats.payload() as { chats: Array<{ agent: { id: string } }> }).chats[0].agent.id, 'claude');

    await until(() => chat.driver.status().state === 'ready');
    assert.equal(webReadBy(chat.session), true, 'the new session carries the old one\'s words, so it carries its mark');
    chat.driver.send('carry on');
    const turns = path.join(dir, 'turns.jsonl');
    // The fake appends the turn as one long line, and under load that write can land in pieces: a
    // read is taken only once the line is whole, which its newline says.
    await until(() => fs.existsSync(turns) && fs.readFileSync(turns, 'utf8').endsWith('\n'));
    const first = fs.readFileSync(turns, 'utf8');
    assert.match(first, /\[phosphor: handoff\./);
    assert.match(first, /PELICAN/, 'the new vendor is told what was said to the old one');
    assert.match(first, /carry on/);

    // The same vendor again is refused, and so is a switch while an answer is being written.
    assert.equal(chats.handoff(chat, vendorFor('claude')).ok, false);
    assert.equal(chat.driver.status().state, 'thinking');
    const busy = chats.handoff(chat, vendorFor('grok'));
    assert.equal(busy.ok, false);
    chat.driver.stop();
  } finally {
    chats.stopAll();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain start still clears the web-read mark: only a handoff keeps it', async () => {
  const dir = tempDir('phosphor-handoff-');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const chats = createChatRegistry({
    cfg: { port: 4177, dataDir: dir, driver: { claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-turns.sh') } } as never,
    audit: { append: () => {} } as never,
    agents: { evict: () => [], markOwn: () => {} } as never,
    getView: () => 'basic',
    sse: { broadcast: () => {}, broadcastState: () => {} } as never,
  });
  try {
    assert.equal(readPick(dir), null);
    const chat = chats.primary();
    markWebRead(chat.session);
    chats.start('human');
    assert.equal(webReadBy(chat.session), false);
    clearWebRead(chat.session);
  } finally {
    chats.stopAll();
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
