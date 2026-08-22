// Several conversations at once, and the two ways that goes wrong.
//
// The window held one agent until 2026-08-21. Making it hold four is mostly bookkeeping, except
// for two places where a mistake is not cosmetic:
//
//   - OPENING MUST NOT EVICT. `startDriver` clears the whole roster on purpose, because the
//     globe means "start over with your own agent". The plus means "and also this one", and
//     running the evicting path for it would kill the conversation the human is standing in
//     along with every worker it had spawned. The two are separate functions for that reason
//     and this file is what keeps them separate.
//   - A REQUEST MUST REACH THE AGENT IT NAMES. A sentence typed into one conversation arriving
//     at a different one is the failure that is only noticed after the wrong agent acted on it,
//     so an unknown name is refused rather than quietly sent to the first chat.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootDriverServer } from '../fixtures/driver-server.ts';

async function chats(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/driver`);
  return (await res.json()) as Record<string, unknown>;
}

test('with nothing running the window is told about one chat, and no agent was spawned', async () => {
  const b = await bootDriverServer();
  try {
    const body = await chats(b.url);
    const list = body.chats as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, '', 'a chat that exists yet has an id, and this one must not exist');
    assert.equal(list[0].state, 'off');
    assert.equal(b.calls.starts, 0, 'serving the window spawned an agent nobody asked for');
  } finally {
    await b.close();
  }
});

test('the plus opens a second chat and leaves the roster alone', async () => {
  const b = await bootDriverServer();
  try {
    // The globe first: this is the one press that is allowed to clear the roster.
    b.agents.claim({ session: 'terminal-1', client: 'a terminal' });
    await b.driver({ action: 'start' });
    assert.equal(b.agents.roster().length, 0, 'the globe is still the control that starts over');

    // Something joins beside the window's own agent: a second terminal, or a worker one of
    // these chats spawned. Either way it is on the roster when the plus is pressed.
    b.agents.claim({ session: 'worker-1', client: 'an analyst', role: 'analyst' });
    const opened = await b.driver({ action: 'open' });

    assert.equal(opened.status, 200);
    assert.notEqual(opened.body.id, '', 'an opened chat has an id to address it by');
    assert.equal(b.calls.starts, 2, 'the second chat was created but never started');
    assert.equal(
      b.agents.roster().length,
      1,
      'opening a chat evicted the roster, which kills the conversation the human is standing in',
    );

    const list = (await chats(b.url)).chats as Array<Record<string, unknown>>;
    assert.equal(list.length, 2);
    assert.notEqual(list[0].id, list[1].id);
  } finally {
    await b.close();
  }
});

test('a fifth chat is refused with a reason, and nothing is started', async () => {
  const b = await bootDriverServer();
  try {
    await b.driver({ action: 'start' });
    for (let i = 0; i < 3; i += 1) assert.equal((await b.driver({ action: 'open' })).status, 200);

    const startsBefore = b.calls.starts;
    const refused = await b.driver({ action: 'open' });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /maximum/);
    assert.equal(b.calls.starts, startsBefore, 'a refused open still spawned a process');
  } finally {
    await b.close();
  }
});

test('a request for a chat that is not open is refused, never redirected', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const sent = await b.driver({ action: 'prompt', chat: 'c99', text: 'sell everything' });

    assert.equal(sent.status, 404);
    assert.equal(b.calls.sends.length, 0, 'a sentence for a chat that does not exist reached an agent that does');
  } finally {
    await b.close();
  }
});

test('a prompt reaches the chat it names and is written into that chat alone', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const second = await b.driver({ action: 'open' });
    const id = String(second.body.id);

    await b.driver({ action: 'prompt', chat: id, text: 'read the four hour' });
    assert.deepEqual(b.calls.sends, ['read the four hour']);

    const list = (await chats(b.url)).chats as Array<Record<string, unknown>>;
    const target = list.find((c) => c.id === id);
    const other = list.find((c) => c.id !== id);
    const said = (t: unknown) => (t as Array<Record<string, unknown>>).filter((e) => e.kind === 'said');
    assert.equal(said(target?.transcript).length, 1);
    assert.equal(said(other?.transcript).length, 0, 'the sentence was written into a conversation it was not for');
  } finally {
    await b.close();
  }
});

test('closing a chat stops its agent and takes it off the list', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'start' });
    const second = await b.driver({ action: 'open' });
    const id = String(second.body.id);

    const closed = await b.driver({ action: 'close', chat: id });
    assert.equal(closed.status, 200);
    assert.equal(b.calls.stops, 1);

    const list = (await chats(b.url)).chats as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list.some((c) => c.id === id), false);
  } finally {
    await b.close();
  }
});
