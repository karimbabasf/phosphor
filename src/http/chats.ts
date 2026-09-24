// The window's own agents: one child per open conversation, running the agent CLI the person
// picked, their transcripts, and the two doors that start one (the globe, which replaces the
// roster, and the plus, which does not). Everything here used to be a `chats` Map and six
// functions inside the createServer closure; the registry is the same code with the closure's
// reads named as arguments.

import crypto from 'node:crypto';
import path from 'node:path';

import type { AppConfig } from '../types.ts';
import type { Audit } from '../audit.ts';
import type { AgentPresence } from '../agents.ts';
import { readPick } from '../agents-catalog.ts';
import type { Driver, DriverEvent } from '../driver.ts';
import { createDriver } from '../driver.ts';
import { providerById, unavailable, vendorFor } from '../providers/index.ts';
import type { ChatVendor } from '../providers/index.ts';
import { buildRole, customPersona } from '../role.ts';
import { loadProfile } from '../profile/index.ts';
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
  /* Told every time a chat's driver reports ready, which is the one moment an app-authored
     turn may go down without cutting into an answer. The ending notice (ended.ts) waits on it. */
  onIdle?: (chat: Chat) => void;
}): ChatRegistry {
  const { cfg, audit, agents, getView, sse, makeDriver, onIdle } = deps;

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
  // Which vendor each chat's driver runs, kept beside the chat because a driver is built for one.
  const vendors = new Map<string, ChatVendor>();
  let chatSeq = 0;

  // The vendor the person picked, read at the moment a chat is built or started.
  function picked(): ChatVendor {
    return vendorFor(readPick(cfg.dataDir)?.agent ?? null);
  }

  function driverEvent(chat: Chat, event: DriverEvent): void {
    /* A delta is the answer being written. It reaches the window and nothing else: the `text`
       event that closes the same block is what the transcript keeps, so a window that reloads
       gets each block once, whole. */
    if (event.kind === 'delta') {
      sse.broadcast({ type: 'driver', chat: chat.id, event });
      return;
    }
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
    if (event.kind === 'status' && event.state === 'ready') onIdle?.(chat);
  }

  /* THE DRIVER FOR ONE CHAT, running the vendor the person picked. The pick used to be read by
     the picker and nobody else, so every chat ran Claude Code whatever the Vault said (R3,
     2026-09-23: Grok picked, eleven Claude sessions started). A pick the chat cannot run gets a
     driver whose every start fails with that pick's own sentence, never Claude in its place. */
  function buildDriver(chat: Chat, vendor: ChatVendor): Driver {
    if (makeDriver) return makeDriver();
    const provider = providerById(vendor.id);
    return createDriver({
      repo: PROJECT_DIR,
      port: cfg.port,
      provider: provider ?? unavailable(vendor),
      // The directory the vendor's child gets as its own: its persona file, and for Grok its
      // HOME, its config and its copy of the login. Inside the data directory, never the person's.
      home: path.join(cfg.dataDir, 'agents', vendor.id),
      surface: 'chat',
      claudeBin: cfg.driver?.claudeBin,
      /* The name this child answers to on the roster, so a human reading src/agents.ts through
         the window can tell four attached agents apart. */
      label: chat.label,
      session: chat.session,
      /* Unset by default, and that is a measured decision rather than an omission. Pinning a
         faster model looked like the obvious speed win and it is not one: over six runs of two
         canonical chart prompts, all three models were correct every time, and the medians came
         out 5.0s on sonnet, 6.2s on the machine default (opus), 8.0s on haiku, which is inside the
         run-to-run spread on the first two. The time is in the round trips, not the model, so the
         app takes the vendor's own default. `driver.model` in config.json names a Claude model,
         so it is passed to Claude Code alone. See scripts/bench-driver.ts. */
      model: vendor.id === 'claude' ? cfg.driver?.model : undefined,
      /* The persona, as the child's system prompt. An agent given no role is a general assistant
         holding a wallet's tools: it offers to write code it cannot write, it asks which screen
         you meant, and it treats a token name as something that can tell it what to do.
         src/role.ts is the answer to all three. A `driver.systemPrompt` in config still sets how
         the agent talks, because somebody running their own Phosphor should be able to change
         that, and the rules that are facts about the code ride along with it. */
      systemPrompt:
        cfg.driver?.systemPrompt === undefined
          ? buildRole({ root: PROJECT_DIR, view: getView(), profile: loadProfile(cfg.dataDir), agent: vendor.name })
          : customPersona(cfg.driver.systemPrompt),
      onEvent: (event) => driverEvent(chat, event),
    });
  }

  function makeChat(): Chat {
    chatSeq += 1;
    const id = `c${chatSeq}`;
    /* THE SEAT THIS CONVERSATION OWNS, minted here and handed to the child, because a card has
       to be addressable to the conversation that asked for it. It cannot be read back off the
       driver afterwards: `status().sessionId` is the vendor's own id once the init event lands.
       Every call this child makes carries it as `session` on /api/mcp. */
    const session = crypto.randomUUID();
    const chat = { id, session, label: `AGENT ${chatSeq}`, transcript: [] } as Partial<Chat> as Chat;
    const vendor = picked();
    chat.driver = buildDriver(chat, vendor);
    vendors.set(id, vendor);
    chats.set(id, chat);
    return chat;
  }

  /* A chat whose agent is not running is rebuilt when the pick has changed since it was made, so
     "Start" after picking Grok starts Grok. A running one is left alone: the Vault refuses a new
     pick while an agent is running (src/http/mutation.ts, agent-pick). */
  function current(chat: Chat): Chat {
    const vendor = picked();
    if (vendors.get(chat.id)?.id === vendor.id || chat.driver.status().running) return chat;
    chat.driver = buildDriver(chat, vendor);
    vendors.set(chat.id, vendor);
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
    const chat = current(primaryChat());
    const vendor = vendors.get(chat.id)?.name ?? 'the agent';
    audit.append(
      'app_start',
      how === 'human'
        ? `in-app driver starting: the app is spawning its own agent (${vendor})`
        : `in-app driver starting at boot: the window opens with an agent attached (${vendor})`,
    );
    chat.driver.start();
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
    vendors.delete(chat.id);
    audit.append('app_start', `in-app driver closed by the human (${chat.label})`, { chat: chat.id });
    sse.broadcastState();
  }

  /* Every open conversation, with its transcript, so a window that reloaded comes back to all
     of them rather than to the one that happened to be in front.

     WITH NOTHING OPEN THE ANSWER IS A CHAT THAT DOES NOT EXIST YET, and that is deliberate
     rather than a placeholder. The app has to be able to serve this window without spawning an
     agent, so answering here must not create one. The empty id is what the window posts back
     when the human presses the globe, and the POST is where the process is made. */
  /* `agent` is the vendor, so the window can say "Start Grok", or say where a pick it cannot run
     here runs instead. At the top it is the pick now, which is what a new chat will run; on each
     chat it is what that chat's driver runs. */
  function driverPayload(): Record<string, unknown> {
    const now = picked();
    const open = [...chats.values()].map((chat) => ({
      id: chat.id,
      label: chat.label,
      // The seat the child in this conversation carries. The window reads it to tell which
      // conversation a card was addressed to; the roster on /api/state already names the same
      // ids, and a session id is not a credential (the seat secret is).
      session: chat.session,
      agent: vendors.get(chat.id) ?? now,
      ...chat.driver.status(),
      transcript: chat.transcript,
    }));
    if (open.length === 0) {
      open.push({ id: '', label: 'AGENT 1', session: '', agent: now, state: 'off' as const, sessionId: '', running: false, transcript: [] });
    }
    // The flat fields are the first chat's, kept beside the list so anything reading the older
    // single-seat shape still reads something true rather than undefined.
    const { id: _id, label: _label, transcript: _t, agent: _a, ...flat } = open[0];
    return { ...flat, agent: now, chats: open, max: MAX_CHATS };
  }

  return {
    size: () => chats.size,
    all: () => [...chats.values()],
    // Every door that hands a chat out hands it on the vendor picked now (see current).
    byId: (id) => {
      const chat = chatById(id);
      return chat === null ? null : current(chat);
    },
    primary: () => current(primaryChat()),
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
