import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALWAYS_CLICK_TOOLS, IDENTITY, MONEY, OPERATING_RULES, VERIFY, handshakeInstructions } from '../../src/persona.ts';
import { buildRole } from '../../src/role.ts';
import { greetingRules } from '../../src/greeting.ts';

// One identity, two surfaces. The MCP handshake is what an outside agent reads at connect time;
// the role is what the in-app agent reads before the human's first word. They drifted for a
// month and said different things about the same money, so both now compose from one file and
// these tests hold them to it.

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const STALE = ['withdraw3', 'liquidity pool', 'different page', 'one way in', 'One way in', 'holds no Solana key', 'any chain this app signs for'];

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
  assert.deepEqual([...ALWAYS_CLICK_TOOLS].sort(), ['propose_hl_withdraw', 'propose_intents_send', 'propose_policy_change']);
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
