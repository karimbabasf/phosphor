// "Show me the transaction" draws a card, not a paragraph with a hash in the middle of it.
//
// The card goes through the same pipe a tool answer already takes, the driver's tool_data event,
// so the window draws it with the code it has and there is no second path to keep in step. That
// is what this asserts: one call, one card event, with the right kind on it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootDriverServer } from '../fixtures/driver-server.ts';
import type { Booted } from '../fixtures/driver-server.ts';
import type { Proposal } from '../../src/types.ts';

const SEAT = 's'.repeat(64);
const PENDING: Proposal = {
  id: 'p-show',
  kind: 'hl_deposit',
  createdAt: '2026-09-18T10:00:00.000Z',
  status: 'pending',
  draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'a', amount: 7.5425, amountUsd: 7.5425, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
  simulation: null,
  verdict: { outcome: 'needs_approval', reasons: [] },
};

function boot(opts: { autostart: boolean; seat: string }): Promise<Booted> {
  return bootDriverServer({ ...opts, proposals: [PENDING] });
}

type Frame = { type?: string; chat?: string; event?: { kind?: string; name?: string; data?: { card?: string; id?: string } } };

// One SSE stream, collecting frames until the test stops caring. The window's own EventSource
// reads exactly this.
function listen(url: string): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const controller = new AbortController();
  void fetch(`${url}/api/events`, { signal: controller.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line === undefined) continue;
          try {
            frames.push(JSON.parse(line.slice(6)) as Frame);
          } catch {
            // a heartbeat or a retry line, not a frame
          }
        }
      }
    })
    .catch(() => {
      // the abort below
    });
  return { frames, stop: () => controller.abort() };
}

async function view(app: Booted, args: Record<string, unknown>, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${app.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.url },
    body: JSON.stringify({ secret: SEAT, op: 'view', tool: 'show', args, ...(session === undefined ? {} : { session }) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function cardWithin(frames: Frame[], ms: number): Promise<Frame | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = frames.find((f) => f.type === 'driver' && f.event?.kind === 'tool_data' && f.event.name === 'show');
    if (hit !== undefined || Date.now() > deadline) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('show draws one card event for a proposal within a second', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  const stream = listen(app.url);
  try {
    // The pending proposal the fixture seeded, and the conversation the autostart opened.
    const id = PENDING.id;
    const out = await view(app, { kind: 'proposal', id });
    assert.equal(out.status, 200);
    assert.equal(out.body.drawn, true);
    assert.equal(out.body.kind, 'proposal');
    assert.equal(out.body.id, id);

    const frame = await cardWithin(stream.frames, 1000);
    assert.ok(frame !== undefined, 'no card event reached the window inside a second');
    assert.equal(frame.event?.data?.card, 'proposal');
    assert.equal(frame.event?.data?.id, id);
  } finally {
    stream.stop();
    await app.close();
  }
});

test('an unknown proposal is a 404 that names it, and draws nothing', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  const stream = listen(app.url);
  try {
    const out = await view(app, { kind: 'proposal', id: 'nope' });
    assert.equal(out.status, 404);
    assert.match(JSON.stringify(out.body), /nope/);
    assert.equal(await cardWithin(stream.frames, 200), undefined);
  } finally {
    stream.stop();
    await app.close();
  }
});

test('a transaction without its network is refused rather than drawn against a guess', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  try {
    const out = await view(app, { kind: 'transaction', id: `0x${'a'.repeat(64)}` });
    assert.equal(out.status, 404);
    assert.match(String(out.body.error ?? JSON.stringify(out.body)), /needs the network/);
  } finally {
    await app.close();
  }
});

test('an unknown kind and an empty id are both 400s that say what is wanted', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  try {
    const kind = await view(app, { kind: 'receipt', id: 'x' });
    assert.equal(kind.status, 400);
    const id = await view(app, { kind: 'proposal', id: '   ' });
    assert.equal(id.status, 400);
  } finally {
    await app.close();
  }
});

/* ---------- one conversation, the caller's ----------

   This drew into every open conversation for a day. Two agents in two chats means one agent's
   card appearing in front of a person reading the other's, and the card is what an approval
   rests on. A chat carries the seat id of the child inside it and every call that child makes
   carries the same id, so the two match exactly. */

test('the card lands in the calling seat’s own conversation and nowhere else', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  const stream = listen(app.url);
  try {
    // A second conversation beside the one autostart opened.
    const opened = await app.driver({ action: 'open' });
    assert.equal(opened.status, 200);
    const chats = await app.chats();
    assert.equal(chats.length, 2, 'two conversations are open');

    const out = await view(app, { kind: 'proposal', id: PENDING.id }, chats[1].session);
    assert.equal(out.body.drawn, true);
    assert.equal(out.body.reason, undefined, 'a seat with its own conversation is not told about somebody else’s');

    const frame = await cardWithin(stream.frames, 1000);
    assert.ok(frame !== undefined);
    assert.equal(frame.chat, chats[1].id, 'the card went to the caller’s chat');
    const drawn = stream.frames.filter((f) => f.event?.kind === 'tool_data' && f.event.name === 'show');
    assert.equal(drawn.length, 1, 'exactly one conversation was drawn into');
  } finally {
    stream.stop();
    await app.close();
  }
});

test('an outside client with no conversation draws into the window’s own, and is told so', async () => {
  const app = await boot({ autostart: true, seat: SEAT });
  const stream = listen(app.url);
  try {
    const out = await view(app, { kind: 'proposal', id: PENDING.id }, 'a-terminal-agent-with-no-chat');
    assert.equal(out.body.drawn, true);
    assert.match(String(out.body.reason ?? ''), /conversation the window is showing/);
    const frame = await cardWithin(stream.frames, 1000);
    assert.equal(frame?.chat, (await app.chats())[0].id);
  } finally {
    stream.stop();
    await app.close();
  }
});
