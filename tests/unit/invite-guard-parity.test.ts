// The chat's invite code guard has two copies: the backend's looksLikeInviteCode (src/invite/code.ts,
// which also turns away a chat prompt carrying a code) and the window's codeIn (ui/core/invite.js).
// CONTRACTS.md says the window mirrors the backend, nothing looser or tighter. Both copies run here
// over one corpus (tests/fixtures/invite-code-texts.ts), over codes the generator really makes,
// and over generated text built to sit on the shape's edges, and they must agree on every one.
// The log tail's cut reads the same matches, so a code behind prose that fills the shape is cut too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { formatCode, generateSecret, inviteLink, looksLikeInviteCode, redactInviteCodes } from '../../src/invite/code.ts';
import { REDACTED, redactEvent } from '../../src/http/log-tail.ts';
import type { LogEvent } from '../../src/types.ts';
import { CODE, GUARD_TEXTS } from '../fixtures/invite-code-texts.ts';

const ADAPTER = readFileSync(new URL('../../ui/core/invite.js', import.meta.url), 'utf8');

function windowGuard(): (text: unknown) => string | null {
  const win: Record<string, any> = {};
  const context = createContext({ window: win });
  runInContext(ADAPTER, context, { filename: 'ui/core/invite.js' });
  return win.PhosphorInviteApi.codeIn;
}

const codeIn = windowGuard();

function bothSay(text: string): boolean {
  const backend = looksLikeInviteCode(text);
  const window = codeIn(text) !== null;
  assert.equal(window, backend, `the two copies disagree on ${JSON.stringify(text)}: backend ${backend}, window ${window}`);
  return backend;
}

// The data groups of a code, as a person would read them back out of a log.
function groupsOf(code: string): string[] {
  return code.toUpperCase().replace(/^PH[O0]S/, '').split(/[\s-]+/).filter(Boolean);
}

function leftIn(text: string, code: string): string[] {
  const flat = text.toUpperCase().replace(/[\s-]/g, '');
  return groupsOf(code).filter((group) => flat.includes(group));
}

test('both copies give the corpus verdict on every text', () => {
  for (const { name, text, code } of GUARD_TEXTS) {
    assert.equal(bothSay(text), code, `${name}: expected ${code ? 'a code' : 'no code'} in ${JSON.stringify(text)}`);
  }
  assert.equal(codeIn(null), null);
  assert.equal(codeIn(undefined), null);
});

test('both copies find every code the generator makes, in every form and behind prose with the shape', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = formatCode(generateSecret());
    const forms = [
      code,
      code.toLowerCase(),
      code.replace(/-/g, ''),
      code.replace(/-/g, ' '),
      code.replace('PHOS', 'PH0S'),
      inviteLink(code),
      `my code is ${code.toLowerCase()}, thanks`,
      `phosphorus is used in my codes ok ${code}`,
      `phosphorus is in my code ok ${code}`,
    ];
    for (const form of forms) assert.equal(bothSay(form), true, `missed ${form}`);
  }
});

test('the two copies agree on text built around the shape\'s edges', () => {
  // A seeded generator, so a failure names a text that can be run again.
  let seed = 0x2545f491;
  const next = (n: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const PIECES = ['phos', 'PH0S', 'phorus ', 'phates ', 'ok ', 'in ', '2', '7', '0', 'A', 'x', 'Q', 'O', 'l', '-', ' ', '\n', '2X9QK', 'M7RTB', 'KMNPQ', 'a8gn4cj'];
  let codes = 0;
  for (let i = 0; i < 4000; i += 1) {
    let text = '';
    const length = 4 + next(28);
    for (let j = 0; j < length; j += 1) text += PIECES[next(PIECES.length)];
    if (bothSay(text)) codes += 1;
  }
  assert.ok(codes > 50 && codes < 3950, `the generated texts do not reach both verdicts (${codes} of 4000 held a code)`);
});

test('the log tail cuts a code behind prose that fills the shape, wherever that prose ends', () => {
  const texts = GUARD_TEXTS.filter(({ text, code }) => code && leftIn(text, CODE).length === groupsOf(CODE).length);
  assert.ok(texts.length >= 10, 'the corpus lost its code forms');
  for (const { name, text } of texts) {
    const cut = redactInviteCodes(text, REDACTED);
    assert.deepEqual(leftIn(cut, CODE), [], `${name}: left in ${cut}`);
    const event = { ts: '2026-10-01T00:00:00.000Z', type: 'driver_prompt', detail: `typed: ${text}`, data: { prompt: text } } as unknown as LogEvent;
    const line = JSON.stringify(redactEvent(event, () => false));
    assert.deepEqual(leftIn(line, CODE), [], `${name}: the log tail left ${line}`);
  }
  // Prose stays as it is when there is no shape in it, and the line around a code survives.
  assert.equal(redactInviteCodes('how does phosphor handle swaps', REDACTED), 'how does phosphor handle swaps');
  assert.equal(redactInviteCodes(`before ${CODE} after`, '[x]'), 'before [x] after');
});
