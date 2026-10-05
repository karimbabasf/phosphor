import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALWAYS_CLICK_TOOLS, CHAT_WITHHELD, CHECK, IDENTITY, MONEY, OPERATING_RULES, SCREENS, TRADING, VAULT, VAULT_RULES, VOICE, WINDOW, WORDS, handshakeInstructions } from '../../src/persona.ts';
import { buildRole } from '../../src/role.ts';
import { CAPABILITIES, buildGreeting } from '../../src/greeting.ts';

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
    for (const line of [...WINDOW, ...VOICE, ...WORDS, ...MONEY, ...TRADING, ...VAULT, ...VAULT_RULES, ...CHECK]) {
      assert.ok(text.includes(line), `${name} is missing: ${line.slice(0, 60)}`);
    }
    for (const rule of OPERATING_RULES) assert.ok(text.includes(rule), `${name} is missing the rule: ${rule.slice(0, 60)}`);
  }
});

/* The four screens as they are since the 2026-09-23 layout. Karim, live: asked to show BTC, the
   agent said it would open it "on the basic screen", which has had no chart since that layout. */
test('the screen map is the one the window draws: four screens, and a chart only on Trade', () => {
  assert.deepEqual(SCREENS.map((s) => s.key), ['basic', 'pro', 'trade', 'vault']);
  const map = WINDOW.join(' ');
  assert.ok(map.includes('Basic: the chat and their balances (a ring with the total, a tile per coin, Add money). No charts.'));
  assert.ok(map.includes('Pro: balances, the trading account, positions, orders, the last 24 hours.'));
  assert.ok(map.includes('Trade: one market: its chart, with positions and orders.'));
  assert.ok(map.includes('Vault: agents and safety: freeze, lock, backup, limits.'));
  assert.ok(map.includes('Charts are on Trade only. Asked to see a coin, a chart or a market: switch to trade, trade_focus the coin'));
  assert.ok(map.includes('"Opened BTC on Trade."'));
  assert.ok(map.includes('Never bring up their screen unless they ask: small talk gets small talk.'));
  for (const stale of ['basic is chat and balances; pro adds charts', 'operator deck', 'open BTC on the basic']) {
    for (const [name, text] of surfaces()) assert.ok(!text.includes(stale), `${name} still says ${stale}`);
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

/* What is new in 0.10.15 and 0.10.16, Karim's ask of 2026-10-05: the agent explains the wallet and
   the vault if asked. Pinned by meaning, one fact a person asks about per line. */
test('both surfaces explain the wallet and the vault as 0.10.15 and 0.10.16 left them', () => {
  for (const [name, text] of surfaces()) {
    const at = text.indexOf('HOW THEIR WALLET AND VAULT WORK.');
    assert.ok(at > text.indexOf('THE MONEY.') && at < text.indexOf('RESEARCH.'), `${name}: the section sits with the money`);
    for (const fact of [
      /Phosphor-only: their Touch ID wallet opens for Phosphor alone/,
      /write a 24-word paper key by hand/,
      /The paper key is the only key that opens the vault away from this Mac[^.]*: keep it like cash/,
      /still controls the allowance, the gas account and Hyperliquid/,
      /\$100 unless they pick another size or turn it off/,
      /over its size plus 10 percent goes back to the vault on its own/,
      /you spend only from the allowance/,
      /a top-up from the vault is theirs to ask for in the Vault tab, with one Touch ID/,
      /Approve then asks two Touch IDs: the move's own first, then one that moves exactly the difference/,
      /The gas account[^.]*about 0\.5 NEAR/,
      /Allow trading on Hyperliquid[^.]*for 90 days with one Touch ID/,
      /The move shuts the NEAR door/,
      /Restore your vault in the Vault tab: write a new paper key, type the old paper's 24 words/,
      /While the vault moves or is restored, your moves wait/,
      /docs\/verify\.md/,
      /node scripts\/vault-check\.ts/,
    ]) {
      assert.match(text, fact, name);
    }
  }
});

test('both surfaces keep the agent away from the paper key, the vault and the person\'s own steps', () => {
  for (const [name, text] of surfaces()) {
    assert.match(text, /Never ask for, accept or repeat their paper key, recovery phrase or private key/, name);
    assert.match(text, /If they type one here anyway, do not repeat or use it/, name);
    assert.match(text, /You cannot move vault money: no tool you hold reaches it, and every move out of the vault needs their Touch ID/, name);
    assert.match(text, /theirs to do in the Vault tab: say so plainly, name the row, and never say you did it or will/, name);
  }
});

/* The paper key check goes from all 24 words to a few, and the private key backup from typing it
   back to Copy and "I saved it" (fix2e). The section says what the person does, so it stays true
   either way; a restore still types the old paper whole. Every session pays for it, so it has a
   ceiling: 4,154 characters as written. */
test('the vault section stays true while the backup checks change, and stays short', () => {
  const section = [...VAULT, ...VAULT_RULES].join('\n');
  for (const stale of [/type (all|the) 24 words back/i, /typed back whole/i, /\bprint(ed)? sheet\b/i, /type the whole key back/i, /prove the copy/i]) {
    assert.doesNotMatch(section, stale);
  }
  assert.match(section, /Phosphor checks what they wrote/);
  assert.ok(section.length < 4_300, `the vault section is ${section.length} characters`);
});

/* A payout carries no memo (src/rails/pay-rules.ts, 2026-09-26): both surfaces and the tool index
   say so and tell the agent never to ask the person for one, so it does not promise an exchange
   deposit it cannot make; the index names the chains a payout lands on. */
test('both surfaces and the tool index say a payout carries no memo, and never to ask for one', () => {
  for (const [name, text] of surfaces()) {
    assert.match(text, /no memo, tag or comment/i, name);
    assert.match(text, /never ask (the person |them )?for one/i, name);
  }
  const send = CAPABILITIES.flatMap((g) => g.items).find((i) => i.tool === 'propose_send');
  assert.ok(send !== undefined);
  assert.match(send.does, /no memo/i);
  assert.match(send.does, /but Zcash and Aleo/);
});
