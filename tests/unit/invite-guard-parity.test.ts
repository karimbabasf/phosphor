// The chat's invite code guard has two copies: the backend's findInviteCode and looksLikeInviteCode
// (src/invite/code.ts, which also turns away a chat prompt carrying a code) and the window's codeIn
// (ui/core/invite.js). CONTRACTS.md says the window mirrors the backend, nothing looser or tighter.
// Both copies run here over one corpus (tests/fixtures/invite-code-texts.ts), over codes the
// generator really makes, and over generated text built to sit on the shape's edges, and they must
// give the same answer on every one: the same verdict and the same stretch of text. The log tail's
// cut reads the same matches, so a code behind prose that fills the shape is cut too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { findInviteCode, foldText, formatCode, generateSecret, inviteLink, looksLikeInviteCode, redactInviteCodes } from '../../src/invite/code.ts';
import { REDACTED, redactEvent } from '../../src/http/log-tail.ts';
import type { LogEvent } from '../../src/types.ts';
import { CODE_GROUPS, GUARD_TEXTS } from '../fixtures/invite-code-texts.ts';

const ADAPTER = readFileSync(new URL('../../ui/core/invite.js', import.meta.url), 'utf8');

function windowGuard(): (text: unknown) => string | null {
  const win: Record<string, any> = {};
  const context = createContext({ window: win });
  runInContext(ADAPTER, context, { filename: 'ui/core/invite.js' });
  return win.PhosphorInviteApi.codeIn;
}

const codeIn = windowGuard();

function bothSay(text: string): boolean {
  const backend = findInviteCode(text);
  const window = codeIn(text);
  assert.equal(window, backend, `the two copies disagree on ${JSON.stringify(text)}: backend ${JSON.stringify(backend)}, window ${JSON.stringify(window)}`);
  assert.equal(looksLikeInviteCode(text), backend !== null);
  return backend !== null;
}

// The data groups of the corpus codes a reader could take back out of a text: read through the
// fold, every separator dropped, the way the audit repaired one (aud-invite, L4).
function leftIn(text: string): string[] {
  const flat = foldText(text).text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return CODE_GROUPS.filter((group) => flat.includes(group));
}

test('both copies give the corpus verdict on every text', () => {
  for (const { name, text, code } of GUARD_TEXTS) {
    assert.equal(bothSay(text), code, `${name}: expected ${code ? 'a code' : 'no code'} in ${JSON.stringify(text)}`);
  }
  assert.equal(codeIn(null), null);
  assert.equal(codeIn(undefined), null);
});

test('both copies find every code the generator makes, in every form and behind prose with the shape', () => {
  const dash = String.fromCodePoint(0x2013);
  for (let i = 0; i < 200; i += 1) {
    const code = formatCode(generateSecret());
    const data = code.slice(5);
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
      // Audit L4: rewritten hyphens, other separators, full-width letters, no prefix, a first group
      // cut short.
      code.replace(/-/g, '‑'),
      code.replace(/-/g, dash),
      code.replace(/-/g, '​'),
      code.replace(/-/g, '_'),
      code.replace(/[0-9A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
      data,
      data.replace(/-/g, ''),
      `here: ${data.replace(/-/g, ' ').toLowerCase()}.`,
      `PHOS${data.replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1-')}`,
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
  // The second line of pieces is what the fold reads: Unicode dashes and spaces, invisible
  // characters, accents, full-width and bold letters, a ligature, and the data of a real code.
  const valid = formatCode(new Uint8Array(16).fill(0x42)).slice(5);
  const PIECES = [
    'phos', 'PH0S', 'phorus ', 'phates ', 'ok ', 'in ', '2', '7', '0', 'A', 'x', 'Q', 'O', 'l', '-', ' ', '\n', '2X9QK', 'M7RTB', 'KMNPQ', 'a8gn4cj',
    '‑', String.fromCodePoint(0x2014), ' ', '​', '­', '́', '２', 'Ａ', String.fromCodePoint(0x1d7d0), 'ﬁ', 'ı', '_', '.', valid, valid.slice(0, 11),
  ];
  let codes = 0;
  for (let i = 0; i < 6000; i += 1) {
    let text = '';
    const length = 4 + next(28);
    for (let j = 0; j < length; j += 1) text += PIECES[next(PIECES.length)];
    if (bothSay(text)) codes += 1;
  }
  assert.ok(codes > 50 && codes < 5950, `the generated texts do not reach both verdicts (${codes} of 6000 held a code)`);
});

test('the log tail cuts every code in the corpus, behind prose or alone, in every spelling', () => {
  const texts = GUARD_TEXTS.filter(({ text, code }) => code && leftIn(text).length >= 5);
  assert.ok(texts.length >= 35, `the corpus lost its code forms (${texts.length} left)`);
  for (const { name, text } of texts) {
    const cut = redactInviteCodes(text, REDACTED);
    assert.deepEqual(leftIn(cut), [], `${name}: left in ${cut}`);
    const event = { ts: '2026-10-01T00:00:00.000Z', type: 'driver_prompt', detail: `typed: ${text}`, data: { prompt: text } } as unknown as LogEvent;
    const line = JSON.stringify(redactEvent(event, () => false));
    assert.deepEqual(leftIn(line), [], `${name}: the log tail left ${line}`);
  }
  // Prose stays as it is when there is no shape in it, and the line around a code survives.
  assert.equal(redactInviteCodes('how does phosphor handle swaps', REDACTED), 'how does phosphor handle swaps');
  assert.equal(redactInviteCodes(`before ${GUARD_TEXTS[0]!.text} after`, '[x]'), 'before [x] after');
});
