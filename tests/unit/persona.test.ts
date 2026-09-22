import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALWAYS_CLICK_TOOLS, FIGURES, IDENTITY, MONEY, OPERATING_RULES, TRADING, VERIFY, handshakeInstructions } from '../../src/persona.ts';
import { buildRole } from '../../src/role.ts';
import { greetingRules } from '../../src/greeting.ts';

// One identity, two surfaces. The MCP handshake is what an outside agent reads at connect time;
// the role is what the in-app agent reads before the human's first word. They drifted for a
// month and said different things about the same money, so both now compose from one file and
// these tests hold them to it.

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/* The last entry is not a stale fact but a rule that lost: it told the agent that the card beside
   its answer already carried the amounts, the quote, the floor, the fee and the venue, and the
   agent duly answered a refused 500 USDC swap without the 500 in it. FIGURES replaced it, and it
   is listed here so it cannot quietly come back. */
const STALE = [
  'withdraw3',
  'liquidity pool',
  'different page',
  'one way in',
  'One way in',
  'holds no Solana key',
  'any chain this app signs for',
  'the quote, the floor, the fee or the venue',
];

const EM_DASH = '—';
const EN_DASH = '–';

function role(): string {
  return buildRole({ root: ROOT, network: 'mainnet', view: 'basic' });
}

test('both surfaces open with the same identity', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    assert.ok(text.includes(IDENTITY[0]), 'the identity sentence is missing');
    assert.ok(/car and you are the person with the key/.test(text));
  }
});

test('both surfaces state the money graph, the withdraw rule and the verification habit', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    for (const line of [...MONEY, ...VERIFY]) assert.ok(text.includes(line), `missing: ${line.slice(0, 60)}`);
    assert.ok(/always by a human click/.test(text));
    assert.ok(/proposal_status/.test(text));
  }
});

/* A close condition is not a touch, and both surfaces have to say so. The failure this pins:
   the agent writes a plan that fires on a 15m close, tells the person "when it hits 108", and
   the person watches 108 print, comes back, and finds nothing fired. Nothing is broken and the
   answer was still wrong. */
test('both surfaces say how a trade fills and never call a close condition a touch', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    for (const line of TRADING) assert.ok(text.includes(line), `missing: ${line.slice(0, 60)}`);
    assert.ok(/rest AT Hyperliquid/.test(text), 'the venue-held entries are not named as such');
    assert.ok(/CLOSES on the right side/.test(text), 'the close condition is not spelled out');
    assert.ok(/does not fire at all/.test(text), 'the wick that closes back is not named');
  }
});

test('neither surface carries a statement the app no longer makes true', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    for (const stale of STALE) assert.ok(!text.includes(stale), `stale statement reached the agent: ${stale}`);
  }
});

test('the greeting rules are the persona rules, not a second copy', () => {
  assert.deepEqual(greetingRules(), OPERATING_RULES);
  assert.ok(OPERATING_RULES.some((r) => r.includes('proposal_status')), 'the verification habit is a rule');
});

test('the always-click tools are named once and the rule names them', () => {
  assert.deepEqual([...ALWAYS_CLICK_TOOLS].sort(), ['propose_hl_withdraw', 'propose_policy_change', 'propose_send']);
  const rule = OPERATING_RULES.find((r) => r.includes('may execute immediately'));
  assert.ok(rule !== undefined);
  for (const tool of ALWAYS_CLICK_TOOLS) assert.ok(rule.includes(tool), `${tool} is missing from the threshold rule`);
});

test('the persona speaks in the house style: no dashes, no assistant tics', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    assert.ok(!text.includes(EM_DASH), 'em dash');
    assert.ok(!text.includes(EN_DASH), 'en dash');
    assert.ok(!/as an AI/i.test(text));
  }
  assert.ok(/Never print a banner/.test(role()));
});

/* ---------- what an answer about a pending move has to carry ----------

   The transcript that started this build: the human asked "all good?" and got "still settling,
   waiting". Both words were true and neither was a fact. So the prompt names the four things an
   answer carries and names the phrases that stand in for them, and both surfaces are held to it
   here, because a rule that only reaches one of the two is a rule the other agent has never
   read. */

// The phrases the eval grader bans in a reply, applied to the prompt itself: a prompt that uses
// the wording it forbids is a prompt teaching the habit it exists to break.
const BANNED: readonly RegExp[] = [
  /\bwaiting\b(?!\s+(on|for)\b)/i,
  /should land/i,
  /any minute/i,
  /probably (fine|worked)/i,
];

test('neither surface uses the wording it tells the agent not to use', () => {
  for (const [name, text] of [['handshake', handshakeInstructions(ROOT)], ['role', role()]] as const) {
    for (const banned of BANNED) {
      // The rules name each phrase once, in quotes, to forbid it. Everything outside the quotes
      // is the prompt speaking in its own voice, and that is what is checked.
      const spoken = text.replace(/"[^"]*"/g, '""');
      assert.equal(banned.test(spoken), false, `${name} uses ${String(banned)} in its own voice`);
    }
  }
});

test('both surfaces name the four facts a pending answer carries, and ban the phrases that replace them', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    for (const token of ['the stage in its own words', 'what it is waiting on', 'the seconds so far', 'the typical figure']) {
      assert.ok(text.includes(token), `missing from the answering rules: ${token}`);
    }
    for (const phrase of ['still settling', 'should land', 'any minute', 'probably fine']) {
      assert.ok(text.includes(`"${phrase}"`), `${phrase} is not named as a phrase to avoid`);
    }
    assert.ok(/proposals\b/.test(text) && /diagnose\b/.test(text), 'the two free debugging reads are named');
  }
});

test('both surfaces state the two policy numbers as two different jobs, in one line', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    assert.match(text, /above the ask threshold a human clicks/i);
    assert.match(text, /above the hard cap nothing runs at all/i);
    /* Was "setting the two equal means nothing ever asks", which described a trap the human had to
       spot. The engine refuses that patch by name now (never_asks, feat/live-truth-a), so the rule
       states the constraint rather than the consequence: the ask sits STRICTLY under the cap. */
    assert.match(text, /the ask has to sit strictly under the cap/i);
    assert.match(text, /nothing would ever ask you/i);
    assert.match(text, /policy_show/);
  }
});

/* ---------- the figures outrank every rule about length ----------

   Both surfaces told the agent to say the figures and, further down the same text, that the card
   beside its answer already carried them. Brevity won every time it was measured. FIGURES is the
   one block that settles it, so both surfaces carry it whole, it sits above the rules it outranks,
   and the clause it replaced is in STALE above. */
test('both surfaces carry the figure rules, and say the figures outrank the rules about length', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    for (const line of FIGURES) assert.ok(text.includes(line), `missing from the figure rules: ${line.slice(0, 60)}`);
    assert.match(text, /7\.5425 USDC is not 7\.54/);
    assert.match(text, /A REFUSAL CARRIES THE SAME FIGURES/);
    assert.match(text, /read the row and THEN wallet/);
    assert.match(text, /Shorten the words, never the numbers/);
  }
  // Moved into FIGURES on 2026-09-19, from the bottom of the role, because down there the agent
  // read past it and answered "you hold $1,900 across two pockets" with neither pocket's figure.
  for (const text of [handshakeInstructions(ROOT), role()]) {
    assert.match(text, /both figures AND the total/);
    assert.match(text, /never the total alone and never the two without it/);
  }
});

test('a claim that a move is done is tied to a proposal_status read', () => {
  for (const text of [handshakeInstructions(ROOT), role()]) {
    assert.match(text, /Say a move is done only with a proposal_status read behind you/);
  }
});
