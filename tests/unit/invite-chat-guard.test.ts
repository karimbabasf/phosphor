// The backend's wall behind the window's chat guard: POST /api/driver { action: 'prompt' } turns
// away a message that carries an invite code, with the composer's own sentence, and sends,
// transcribes and logs nothing of it. The window keeps a code out of the box first
// (ui/core/invite.js); this holds for a window whose guard did not load and for any other caller.
// The verdicts are the shared corpus's (tests/fixtures/invite-code-texts.ts), so the wall and both
// guards answer the same.

import test from 'node:test';
import assert from 'node:assert/strict';

import { INVITE_KEPT_OUT } from '../../src/http/mutation.ts';
import { foldText } from '../../src/invite/code.ts';
import { bootDriverServer } from '../fixtures/driver-server.ts';
import { CODE_GROUPS, GUARD_TEXTS } from '../fixtures/invite-code-texts.ts';

// The data groups of the corpus codes, as a person would read them back out of a log or a
// transcript: through the fold, every separator dropped.
function holdsPartOfTheCode(text: string): string[] {
  const flat = foldText(text).text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return CODE_GROUPS.filter((group) => flat.includes(group));
}

test('a chat message that carries an invite code is turned away calmly, and nothing of it goes anywhere', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const codes = GUARD_TEXTS.filter((entry) => entry.code);
    for (const { name, text } of codes) {
      const answer = await b.driver({ action: 'prompt', text });
      assert.equal(answer.status, 400, `${name}: answered ${answer.status}`);
      assert.deepEqual(answer.body, { error: INVITE_KEPT_OUT, reason: 'invite-code' }, `${name}: the answer quoted something`);
    }
    assert.deepEqual(b.calls.sends, [], 'a code reached the agent');

    const lines = b.auditLines();
    const kept = lines.filter((line) => line.includes('kept from the agent'));
    assert.equal(kept.length, codes.length, 'each refusal is one audit line');
    for (const line of lines) assert.deepEqual(holdsPartOfTheCode(line), [], `the audit log holds part of the code: ${line}`);

    const list = (await (await fetch(`${b.url}/api/driver`, { headers: { 'x-phosphor-token': await b.token() } })).json()) as { chats: Array<{ transcript: Array<{ kind: string }> }> };
    const said = list.chats.flatMap((chat) => chat.transcript).filter((event) => event.kind === 'said');
    assert.deepEqual(said, [], 'a refused message was written into the transcript');
  } finally {
    await b.close();
  }
});

test('a message with no code in it, prose with the shape included, still goes', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const plain = GUARD_TEXTS.filter((entry) => !entry.code && entry.text !== '');
    for (const { name, text } of plain) {
      const answer = await b.driver({ action: 'prompt', text });
      assert.equal(answer.status, 200, `${name}: refused with ${JSON.stringify(answer.body)}`);
    }
    assert.equal(b.calls.sends.length, plain.length);
    assert.ok(b.calls.sends[0]!.startsWith(plain[0]!.text));
  } finally {
    await b.close();
  }
});
