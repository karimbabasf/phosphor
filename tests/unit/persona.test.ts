import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALWAYS_CLICK_TOOLS, CHAT_WITHHELD, CHECK, IDENTITY, MONEY, OPERATING_RULES, TRADING, VOICE, WORDS, handshakeInstructions } from '../../src/persona.ts';
import { buildRole } from '../../src/role.ts';
import { buildGreeting } from '../../src/greeting.ts';

// One identity, two surfaces. The MCP handshake is what an agent in a terminal reads at connect
// time; the persona is the system prompt of the agent the window runs. They drifted for a month
// and said different things about the same money, so both compose from one file and these tests
// hold them to it.

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/* Statements the app no longer makes true, and rules that lost. The last five are the voice of
   2026-09-22: figures outranking brevity, a read after every propose, the stage text quoted word
   for word, and the move template that taught "floor" and "click line" (R3). */
const STALE = [
  'withdraw3',
  'liquidity pool',
  'different page',
  'holds no Solana key',
  'the car and you are the person with the key',
  'EVERY SENTENCE ABOUT MONEY CARRIES ITS FIGURES',
  'After EVERY propose',
  'read the row and THEN wallet',
  'quote its words',
  'Shorten the words, never the numbers',
];

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function surfaces(): Array<[string, string]> {
  return [
    ['handshake', handshakeInstructions(ROOT)],
    ['persona', buildRole({ root: ROOT, network: 'mainnet', view: 'basic', agent: 'Grok' })],
  ];
}

test('both surfaces open with the same identity', () => {
  for (const [name, text] of surfaces()) {
    assert.ok(text.startsWith("You are Phosphor's assistant"), name);
    assert.ok(text.includes(IDENTITY[0]), `${name} lost the identity sentence`);
  }
});

test('both surfaces carry the voice, the words, the money, the checks and the rules, whole', () => {
  for (const [name, text] of surfaces()) {
    for (const line of [...VOICE, ...WORDS, ...MONEY, ...TRADING, ...CHECK]) {
      assert.ok(text.includes(line), `${name} is missing: ${line.slice(0, 60)}`);
    }
    for (const rule of OPERATING_RULES) assert.ok(text.includes(rule), `${name} is missing the rule: ${rule.slice(0, 60)}`);
  }
});

/* A close condition is not a touch, and both surfaces have to say so. The failure this pins:
   the agent writes a plan that fires on a 15m close, tells the person "when it hits 108", and
   the person watches 108 print, comes back, and finds nothing fired. */
test('both surfaces say how a trade fills and never call a close condition a touch', () => {
  for (const [, text] of surfaces()) {
    assert.ok(/rests at Hyperliquid and fills the instant price touches it/.test(text));
    assert.ok(/closes past the level, up to a whole bar later/.test(text));
    assert.ok(/a wick that closes back does not count/.test(text));
  }
});

test('neither surface carries a statement the app no longer makes true', () => {
  for (const [name, text] of surfaces()) {
    for (const stale of STALE) assert.ok(!text.includes(stale), `${name} still says: ${stale}`);
  }
});

test('the always-click tools are named once and the rule names them', () => {
  assert.deepEqual([...ALWAYS_CLICK_TOOLS].sort(), ['propose_hl_withdraw', 'propose_policy_change', 'propose_send']);
  const rule = OPERATING_RULES.find((r) => r.includes('always wait for a click'));
  assert.ok(rule !== undefined);
  for (const tool of ALWAYS_CLICK_TOOLS) assert.ok(rule.includes(tool), `${tool} is missing from the rule`);
});

test('both surfaces speak in the house style: no dashes, no assistant tics', () => {
  for (const [name, text] of surfaces()) {
    assert.ok(!text.includes(EM_DASH), `${name}: em dash`);
    assert.ok(!text.includes(EN_DASH), `${name}: en dash`);
    assert.ok(!/as an AI/i.test(text));
  }
});

/* The phrases that stand in for a fact about a moving move. The rules never use them in their
   own voice: a prompt that says "should land" teaches the habit it exists to break. */
const BANNED: readonly RegExp[] = [/should land/i, /any minute/i, /probably (fine|worked)/i, /still settling/i];

test('neither surface uses the wording a move\'s answer must not use', () => {
  for (const [name, text] of surfaces()) {
    for (const banned of BANNED) assert.equal(banned.test(text), false, `${name} uses ${String(banned)}`);
  }
});

test('both surfaces state the two policy numbers as two different jobs', () => {
  for (const [, text] of surfaces()) {
    assert.match(text, /above the limit they click, above the cap nothing runs at all/);
    assert.match(text, /the limit has to sit strictly under the cap/);
    assert.match(text, /policy_show/);
  }
});

test('a move is checked when it goes wrong, and not re-read after every propose', () => {
  for (const [, text] of surfaces()) {
    assert.match(text, /swap_check reads a swap's truth now/);
    assert.match(text, /Do not read after every move/);
    assert.ok(!/proposal_status after every/i.test(text));
  }
});

test('the window\'s agent is pointed at its system prompt, not handed the rules twice', () => {
  const chat = handshakeInstructions(ROOT, 'chat');
  assert.ok(chat.length < 120, `the chat's server instructions are ${chat.length} characters`);
  assert.ok(chat.includes('system prompt'));
  assert.ok(handshakeInstructions(ROOT).includes('Call `start` first'), 'a terminal agent has no persona and still orients on start');
});

test('the chat leaves out the tools a money chat does not need, and keeps every move', () => {
  assert.deepEqual([...CHAT_WITHHELD].sort(), [
    'agent_board',
    'agent_jobs',
    'agent_post',
    'agent_roster',
    'agent_spawn',
    'composition',
    'log_tail',
    'profile_learned',
    'set_theme',
    'start',
  ]);
  assert.equal(CHAT_WITHHELD.some((t) => t.startsWith('propose_')), false);
});

test('the start answer no longer repeats the rules the handshake carries', () => {
  const greeting = buildGreeting(
    { view: 'basic', totalUsd: 8.66, pocketCount: 1, pendingCount: 0, inFlightCount: 0, clickThresholdUsd: 10, killSwitch: false, tradingAllowed: true, holder: null, emptyCount: 0 },
    '0.0.0',
  ) as unknown as Record<string, unknown>;
  assert.equal('rules' in greeting, false);
  assert.ok(!String(greeting.banner).includes('the person with the key'));
});
