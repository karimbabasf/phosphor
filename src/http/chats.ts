// The window's own agents: one Claude Code child per open conversation, their transcripts, and
// the two doors that start one (the globe, which replaces the roster, and the plus, which does
// not). Everything here used to be a `chats` Map and six functions inside the createServer
// closure; the registry is the same code with the closure's reads named as arguments.

import type { AppConfig } from '../types.ts';
import type { Audit } from '../audit.ts';
import type { AgentPresence } from '../agents.ts';
import type { Driver, DriverEvent } from '../driver.ts';
import { createDriver } from '../driver.ts';
import { buildRole } from '../role.ts';
import type { ViewMode } from '../types.ts';
import { PROJECT_DIR } from './context.ts';
import type { Chat, ChatRegistry, SseHub } from './context.ts';

export function createChatRegistry(deps: {
  cfg: AppConfig;
  audit: Audit;
  agents: AgentPresence;
  getView: () => ViewMode;
  sse: SseHub;
  /* Injected only so a test can drive the start paths without a real Claude Code process
     appearing on the machine. See the note on ServerDeps.makeDriver. */
  makeDriver?: () => Driver;
}): ChatRegistry {
  const { cfg, audit, agents, getView, sse, makeDriver } = deps;

  // THE DRIVER'S SEATS, PLURAL SINCE 2026-08-21.
  //
  // This used to be one `driver` and one `transcript`. It is now a map of CHATS, each holding
  // its own child process and its own conversation, because one seat made the window the only
  // part of Phosphor that could not do two things at once: src/agents.ts has seated a roster of
  // six since this morning and src/crew.ts spawns workers into it, and the human's own surface
  // was still a single thread they had to finish before starting the next one.
  //
  // WHAT A SECOND CHAT IS AND IS NOT. It is a second Claude Code process under the same
  // lockdown file, the same assertSurface check, and the same MCP server, joining the roster as
  // its own named member. It is NOT a second view of one conversation: the three windows (pro,
  // trade, basic) still all show whichever chat is in front, which is what they always did.
  //
  // THE ONE ORDERING RULE. Opening a chat must never evict the roster. startDriver() below
  // clears the whole roster on purpose, because the globe means "start over with your own
  // agent". The plus means "and also this one", and running the evicting path for it would kill
  // the conversation the human is standing in. They are separate functions for that reason and
  // openChat() is deliberately the one with no evict in it.
  //
  // The transcript is kept here rather than in the browser because a window that reloads
  // mid-conversation should come back to the conversation, and because the SSE stream is a
  // change notification, not a delivery guarantee. TRANSCRIPT_MAX is a memory bound, not an
  // editorial one: the full record of what an agent did lives in the audit log, which is
  // append-only and is what anyone should read when the question is what happened.
  const TRANSCRIPT_MAX = 400;

  /* How many conversations a human may have open at once.
     The real ceiling is elsewhere and it is MAX_AGENTS in src/agents.ts, which seats six and
     refuses a seventh with a sentence saying so. This number is smaller than six for two
     reasons that have nothing to do with arithmetic: every chat is a model on the other end of
     a subscription and costs whether or not it is the tab in front, and every chat can spawn up
     to three workers of its own, which come out of the same six seats. Four windows and the
     workers they put to use is the roster full. */
  const MAX_CHATS = 4;

  const chats = new Map<string, Chat>();
  let chatSeq = 0;

  function driverEvent(chat: Chat, event: DriverEvent): void {
    chat.transcript.push({ ...event, at: Date.now() });
    if (chat.transcript.length > TRANSCRIPT_MAX) {
      chat.transcript.splice(0, chat.transcript.length - TRANSCRIPT_MAX);
    }
    // A refused lockdown is not a chat message. It is the one driver event that belongs in the
    // permanent record, because it means a Claude Code upgrade changed the tool surface under an
    // app that signs transactions.
    if (event.kind === 'error' && event.message.startsWith('refusing to drive')) {
      audit.append('error', event.message, { source: 'driver', chat: chat.id });
    }
    // Tagged with the chat, always. An untagged event was fine when there was one conversation
    // and would print into whichever one the human happened to be looking at now.
    sse.broadcast({ type: 'driver', chat: chat.id, event });
  }

  function makeChat(): Chat {
    chatSeq += 1;
    const id = `c${chatSeq}`;
    const chat = { id, label: `AGENT ${chatSeq}`, transcript: [] } as Partial<Chat> as Chat;
    chat.driver = makeDriver
      ? makeDriver()
      : createDriver({
            repo: PROJECT_DIR,
            port: cfg.port,
            claudeBin: cfg.driver?.claudeBin,
            /* The name this child answers to on the roster, so a human reading src/agents.ts
               through the window can tell four attached agents apart. Without it every one of
               them is called after the client that started it and they are all the same client. */
            label: chat.label,
            /* Unset by default, and that is a measured decision rather than an omission. Pinning
               a faster model looked like the obvious speed win and it is not one: over six runs
               of two canonical chart prompts, all three models were correct every time, and the
               medians came out 5.0s on sonnet, 6.2s on the machine default (opus), 8.0s on haiku,
               which is inside the run-to-run spread on the first two. Haiku was slower, not
               faster: it spent thinking tokens the others did not and took an extra round trip
               more often. The time is in the round trips, not the model, so the app takes the
               user's own default and `driver.model` in config.json is there for anyone who
               disagrees. See scripts/bench-driver.ts to re-run the comparison. */
            model: cfg.driver?.model,
            /* The role, and the reason it is a default rather than a config field with no value.
               An agent given no role is a general assistant holding a wallet's tools: it offers
               to write code it cannot write, it asks which screen you meant, and it treats a
               token name as something that can tell it what to do. src/role.ts is the answer to
               all three. A `driver.systemPrompt` in config still wins outright, because somebody
               running their own Phosphor should be able to change how their own agent talks. */
            systemPrompt:
              cfg.driver?.systemPrompt ?? buildRole({ root: PROJECT_DIR, view: getView() }),
            onEvent: (event) => driverEvent(chat, event),
          });
    chats.set(id, chat);
    return chat;
  }

  /* The chat every door falls back to: the oldest one open, or a fresh one when nothing is.
     Lazy for the same reason it always was, which is that the app must be able to boot, serve
     the window and answer /api/state without ever spawning an agent. */
  function primaryChat(): Chat {
    for (const chat of chats.values()) return chat;
    return makeChat();
  }

  function chatById(id: unknown): Chat | null {
    if (typeof id !== 'string' || id === '') return null;
    return chats.get(id) ?? null;
  }

  /* Starting the window's own agent, from either door: a human pressing the globe, or the app
     opening.

     THE ROSTER IS CLEARED FIRST, and that order is not cosmetic: an agent this is replacing
     heartbeats every few seconds and a process takes longer than that to start, so opening
     first would let an outgoing agent rejoin ahead of its replacement.

     It clears the WHOLE roster rather than one member, and that is the deliberate reading of
     the control. Phosphor seats a team now, but this button means "start over with your own
     agent": a human who presses it while three sessions are attached is asking for one agent,
     not for a fourth. An agent that wants colleagues spawns them (src/crew.ts) and they join
     after this point. */
  function startDriver(how: 'human' | 'app'): string | null {
    const dropped = agents.evict();
    for (const member of dropped) {
      audit.append('agent_disconnected', `${how === 'human' ? 'the human' : 'the app'} replaced ${member.label} with the in-app driver`, {
        client: member.client,
        role: member.role,
      });
    }
    audit.append(
      'app_start',
      how === 'human'
        ? 'in-app driver starting: the app is spawning its own agent'
        : 'in-app driver starting at boot: the window opens with an agent attached',
    );
    primaryChat().driver.start();
    sse.broadcastState();
    return dropped[0]?.client ?? null;
  }

  /* The plus. A second conversation beside the one already running, and the whole difference
     from startDriver above is the line that is missing: no evict. A human pressing plus is
     asking for another agent, not for a replacement, and dropping the roster here would take
     down the chat they are standing in along with every worker it had spawned. */
  function openChat(): { ok: true; chat: Chat } | { ok: false; error: string } {
    if (chats.size >= MAX_CHATS) {
      return {
        ok: false,
        error:
          `${chats.size} agents are already open and ${MAX_CHATS} is the maximum. Close one first. ` +
          'Each one is a model running whether or not its tab is in front, and each can put three ' +
          'workers of its own on the roster.',
      };
    }
    const chat = makeChat();
    audit.append('app_start', `a second in-app agent is starting: ${chat.label}`, { chat: chat.id });
    chat.driver.start();
    sse.broadcastState();
    return { ok: true, chat };
  }

  function closeChat(chat: Chat): void {
    chat.driver.stop();
    chats.delete(chat.id);
    audit.append('app_start', `in-app driver closed by the human (${chat.label})`, { chat: chat.id });
    sse.broadcastState();
  }

  /* Every open conversation, with its transcript, so a window that reloaded comes back to all
     of them rather than to the one that happened to be in front.

     WITH NOTHING OPEN THE ANSWER IS A CHAT THAT DOES NOT EXIST YET, and that is deliberate
     rather than a placeholder. The app has to be able to serve this window without spawning an
     agent, so answering here must not create one. The empty id is what the window posts back
     when the human presses the globe, and the POST is where the process is made. */
  function driverPayload(): Record<string, unknown> {
    const open = [...chats.values()].map((chat) => ({
      id: chat.id,
      label: chat.label,
      ...chat.driver.status(),
      transcript: chat.transcript,
    }));
    if (open.length === 0) {
      open.push({ id: '', label: 'AGENT 1', state: 'off' as const, sessionId: '', running: false, transcript: [] });
    }
    // The flat fields are the first chat's, kept beside the list so anything reading the older
    // single-seat shape still reads something true rather than undefined.
    const { id: _id, label: _label, transcript: _t, ...flat } = open[0];
    return { ...flat, chats: open, max: MAX_CHATS };
  }

  return {
    size: () => chats.size,
    all: () => [...chats.values()],
    byId: chatById,
    primary: primaryChat,
    event: driverEvent,
    start: startDriver,
    open: openChat,
    close: closeChat,
    payload: driverPayload,
    /* The children die with the server that started them. An orphaned driver would keep the
       seat, keep spending the user's subscription, and keep proposing into a state directory
       whose window is gone, and it is the app's job to clean up a process the app created. */
    stopAll: () => {
      for (const chat of chats.values()) chat.driver.stop();
    },
  };
}
