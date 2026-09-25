// A turn the app starts is nobody's click.
//
// Since 2026-09-25 a move that did not go through wakes its agent for one line (src/http/ended.ts),
// and that turn goes down the same driver.send a person's message does. Under the auto-approve
// limit a move the agent filed inside it ran on the policy alone with nobody at the window: a
// retry, the plan's next leg (security review F1). The wake's words ask for no move; words are not
// a wall. So the seat is marked for exactly that turn (src/app-turn.ts), every row it files
// carries the mark, and land() makes each one wait for the person's click. A position closed
// inside that turn is tests/unit/trade-door.test.ts's.
//
// Driven through the real ending notice and the real proposal service: a swap fails, the app wakes
// the chat, and the woken turn proposes. The chat registry's own part, handing the notice every
// driver event, is the last test.
//
// Run: node --test tests/unit/app-turn-gate.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Chat } from '../../src/http/context.ts';
import type { DriverEvent, DriverState } from '../../src/driver.ts';
import type { Proposal, Rail } from '../../src/types.ts';
import { createEndedNotices } from '../../src/http/ended.ts';
import { createChatRegistry } from '../../src/http/chats.ts';
import { createAgents } from '../../src/agents.ts';
import { landed, makeCtx } from './helpers/proposals.ts';

const SEAT = 'seat-woken';
const OTHER = 'seat-other-chat';
const REASON = 'Your agent asked for this on its own after a move did not go through, so it waits for your OK.';

// A chat as the registry holds it, on a stand-in driver with the real one's rules for a turn.
function chatOn(id: string, session: string) {
  let state: DriverState = 'ready';
  const turns: string[] = [];
  let refuse = false;
  const chat = {
    id,
    session,
    label: `AGENT ${id}`,
    transcript: [] as Array<DriverEvent & { at: number }>,
    driver: {
      status: () => ({ state }),
      send: (text: string) => {
        if (refuse) throw new Error('driver: the agent is still answering');
        turns.push(text);
        state = 'thinking';
      },
      note: () => {},
    },
  } as unknown as Chat;
  return {
    chat,
    turns,
    refuse: () => {
      refuse = true;
    },
    setState: (next: DriverState) => {
      state = next;
    },
  };
}

// The incident's first leg, VVV to USDC, filed by this chat's agent and ended with nothing moved.
function failedSwap(by: string): Proposal {
  const at = new Date().toISOString();
  return {
    id: 'failed-1',
    kind: 'swap',
    createdAt: at,
    status: 'failed',
    decidedBy: 'policy',
    decidedAt: at,
    settledAt: at,
    draft: { kind: 'swap', venue: 'intents-native', chain: 'near', toChain: 'near', fromSymbol: 'VVV', toSymbol: 'USDC', amountIn: 12.5, amountUsd: 40, minAmountOut: 39.2, from: '0x1', to: '0x1', counterparty: 'intents-native', quote: null },
    simulation: { ok: true, summary: 'ok' },
    verdict: { outcome: 'allow', reasons: [] },
    by,
    result: { ok: false, detail: 'the relay did not take it', reason: 'venue_failed_nothing_moved' },
  };
}

function world(opts: { slowReads?: boolean } = {}) {
  const executed: string[] = [];
  let release: () => void = () => {};
  const reads = new Promise<void>((resolve) => (release = resolve));
  const rail: Rail = {
    kind: 'swap',
    valueUsd: () => 0,
    async simulate() {
      if (opts.slowReads === true) await reads;
      return { ok: true, summary: 'scripted rail: nothing was simulated' };
    },
    async execute(draft) {
      executed.push(draft.kind);
      return { ok: true, detail: 'scripted swap', txids: ['0xswap'] };
    },
  };
  const h = makeCtx({ rails: [rail], intentsUsdc: 1000 });
  const woken = chatOn('c1', SEAT);
  const other = chatOn('c2', OTHER);
  // The gathering window is the one part that happens later; the test fires it.
  let owed: (() => void) | null = null;
  const notices = createEndedNotices({
    store: h.store,
    chats: () => [woken.chat, other.chat],
    view: (p) => h.svc.view(p),
    tag: () => '[phosphor: the window is on the pro screen]',
    audit: h.audit,
    schedule: (fn) => {
      owed = fn;
      return {
        cancel: () => {
          owed = null;
        },
      };
    },
  });

  // A $20 swap under the click threshold, as a chat's agent would ask for it.
  const swap = (by?: string) => h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 20, minAmountOut: 19.8, by });
  return {
    h,
    executed,
    woken,
    other,
    notices,
    swap,
    release: () => release(),
    // A swap this chat's agent filed did not go through, and five seconds on the app wakes it.
    wake(): void {
      h.store.put(failedSwap(SEAT));
      assert.ok(owed !== null, 'the failure owed no wake');
      const fire = owed as () => void;
      owed = null;
      fire();
      assert.equal(woken.turns.length, 1, 'the app did not start a turn');
      assert.match(woken.turns[0], /the app wrote this turn, not the person/);
    },
    // The woken turn's result line and the ready after it, as the chat registry hands them on.
    turnEnds(): void {
      notices.event(woken.chat, { kind: 'turn_end', error: false, turns: 1 });
      woken.setState('ready');
      notices.event(woken.chat, { kind: 'status', state: 'ready' });
    },
  };
}

test('a small swap filed inside a turn the app started waits for the person\'s click, and says why', async () => {
  const w = world();
  w.wake();
  const p = await landed(w.h, w.swap(SEAT));
  assert.equal(p.status, 'pending', `the swap landed ${p.status}, decided by ${String(p.decidedBy)}`);
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.equal(p.verdict.reasons.at(-1), REASON);
  assert.equal(p.appTurn, true, 'the row carries its own stamp');
  assert.deepEqual(w.executed, [], 'a swap ran with nobody at the window');
});

test('the turn the person starts after it gets the policy as it always was', async () => {
  const w = world();
  w.wake();
  assert.equal((await landed(w.h, w.swap(SEAT))).status, 'pending');
  w.turnEnds();
  // The person's own message: the swap runs on the policy alone again.
  w.woken.chat.driver.send('swap 20 usdc to usdt');
  const p = await landed(w.h, w.swap(SEAT));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  assert.equal(p.decidedBy, 'policy');
  assert.equal(p.appTurn, undefined);
  assert.deepEqual(w.executed, ['swap']);
});

test('the mark is that chat\'s alone: another chat\'s agent, and a row no seat filed, run as before', async () => {
  const w = world();
  w.wake();
  const theirs = await landed(w.h, w.swap(OTHER));
  assert.equal(theirs.status, 'executed', `another chat's swap landed ${theirs.status}`);
  assert.equal(theirs.appTurn, undefined);
  assert.equal((await landed(w.h, w.swap())).status, 'executed', 'a row with no seat was held');
  // An event from the other chat ends nothing in this one.
  w.notices.event(w.other.chat, { kind: 'turn_end', error: false, turns: 1 });
  w.notices.event(w.other.chat, { kind: 'status', state: 'ready' });
  assert.equal((await landed(w.h, w.swap(SEAT))).status, 'pending', 'another chat\'s turn end cleared this chat\'s mark');
  assert.deepEqual(w.executed, ['swap', 'swap']);
});

test('a move asked for inside the app\'s turn waits for the click however long its reads outlive the turn', async () => {
  const w = world({ slowReads: true });
  w.wake();
  const reply = w.swap(SEAT);
  await new Promise((resolve) => setTimeout(resolve, 20));
  w.turnEnds();
  w.release();
  const p = await w.h.svc.settled((await reply).id, 5000);
  assert.equal(p.status, 'pending', `landed ${p.status} ${String(p.decidedBy)} ${p.verdict.outcome}`);
  assert.equal(p.verdict.reasons.at(-1), REASON);
  assert.deepEqual(w.executed, []);
});

test('a turn that never ends cleanly still takes the mark with it: a stop, a failure, a restart', async () => {
  for (const state of ['stopped', 'failed', 'starting', 'off'] as const) {
    const w = world();
    w.wake();
    w.woken.setState(state);
    w.notices.event(w.woken.chat, { kind: 'status', state });
    assert.equal((await landed(w.h, w.swap(SEAT))).status, 'executed', `still marked after ${state}`);
  }
  // A driver that would not take the turn leaves no mark behind it.
  const refused = world();
  refused.woken.refuse();
  assert.throws(() => refused.wake(), /the app did not start a turn/);
  assert.equal((await landed(refused.h, refused.swap(SEAT))).status, 'executed', 'a wake that was refused left the seat marked');
  // And stopping the notices clears whatever turn was still running.
  const stopped = world();
  stopped.wake();
  stopped.notices.stop();
  assert.equal((await landed(stopped.h, stopped.swap(SEAT))).status, 'executed');
});

test('the chat registry hands the ending notice every driver event, turn ends and states included', () => {
  const seen: string[] = [];
  const registry = createChatRegistry({
    cfg: { mode: 'demo', port: 0, addresses: {}, candleProducts: [], dataDir: '/nonexistent', keysPath: '/nonexistent/keys.json' },
    audit: { append: () => {} } as never,
    agents: createAgents(),
    getView: () => 'pro',
    sse: { broadcast: () => {} } as never,
    makeDriver: () => ({
      start: () => {},
      send: () => {},
      note: () => {},
      interrupt: () => false,
      stop: () => {},
      status: () => ({ state: 'ready' as const, sessionId: 'fake', running: true }),
    }),
    onEvent: (chat, event) => seen.push(`${chat.id} ${event.kind === 'status' ? `status:${event.state}` : event.kind}`),
  });
  const chat = registry.primary();
  registry.event(chat, { kind: 'status', state: 'thinking' });
  registry.event(chat, { kind: 'turn_end', error: false, turns: 1 });
  registry.event(chat, { kind: 'status', state: 'ready' });
  assert.deepEqual(seen, [`${chat.id} status:thinking`, `${chat.id} turn_end`, `${chat.id} status:ready`]);
});
