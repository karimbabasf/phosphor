// The app tells the agent when a move it proposed has ended after its turn was over.
//
// Until 2026-09-20 the only thing that ever prompted the in-app driver was a human typing. So
// an agent that proposed a withdrawal, said "waiting for your click" and ended its turn never
// heard what happened next: the click, the venue refusing the send, the card flipping to
// Failed. Its last words stayed "Waiting for you" over a card that said the opposite, and the
// person found out by reading the card (Karim's transcript, 2026-09-20).
//
// WHAT THIS IS. One subscriber on the proposal store. A row that reaches a terminal stage, that
// an agent in one of the window's conversations proposed (Proposal.by is that seat), and that
// this process has not told yet, becomes one turn to that conversation: an app-authored line,
// fenced and named like the screen tag, saying which move ended, how, and why. The agent turns
// that into a sentence for the person, or into nothing if the person already knows.
//
// WHAT IT IS NOT. Not an approval path and not a retry: it carries no id the agent could act on
// beyond reading, and it says so. Not a message the window draws: the agent's own reply is what
// the person sees. Not an interruption: a turn in progress is left alone, the notice waits on
// the chat and goes down when the driver reports ready, unless the transcript shows the agent
// read that row's ending itself in the meantime, in which case it is dropped.

import type { Proposal } from '../types.ts';
import type { ProposalView } from '../proposals/view.ts';
import type { Audit } from '../audit.ts';
import type { Chat } from './context.ts';

export type EndedNoticeDeps = {
  store: { subscribe(fn: (p: Proposal) => void): () => void };
  chats: () => Chat[];
  view: (p: Proposal) => ProposalView;
  // The screen tag, the same line the human's prompts carry (src/http/mutation.ts, screenTag).
  tag: () => string;
  audit: Pick<Audit, 'append'>;
  now?: () => number;
};

export type EndedNotices = {
  // Sends what waits on this chat, if anything does. The chat registry calls it when the
  // driver reports ready.
  flush(chat: Chat): void;
  pending(): number;
  stop(): void;
};

type Notice = { id: string; text: string; at: number };

// How many endings this process remembers having told, as row and stage. Beyond it the oldest
// are forgotten, which risks a repeat about a row a thousand endings old and nothing worse.
const TOLD_MAX = 1000;

// A read that landed this close to the row's ending still counts as having seen it: the
// store write and the tool's answer are the same moment from two clocks.
const SEEN_SLACK_MS = 1_000;

const KIND_WORDS: Record<string, string> = {
  swap: 'swap',
  hl_deposit: 'deposit to Hyperliquid',
  hl_withdraw: 'withdrawal from Hyperliquid',
  intents_send: 'send',
  intents_pay: 'payout',
  trade: 'trade',
  trade_change: 'change to a trade',
  policy_change: 'rule change',
};

export function createEndedNotices(deps: EndedNoticeDeps): EndedNotices {
  const now = deps.now ?? Date.now;
  const told = new Set<string>();
  const toldOrder: string[] = [];
  const queued = new Map<string, Notice[]>();

  function remember(id: string): void {
    told.add(id);
    toldOrder.push(id);
    while (toldOrder.length > TOLD_MAX) told.delete(toldOrder.shift() as string);
  }

  function words(p: Proposal, v: ProposalView): string {
    const kind = KIND_WORDS[p.kind] ?? p.kind;
    const spent = v.money.amountIn === null ? v.money.symbol : `${v.money.amountIn} ${v.money.symbol}`;
    const legs = p.kind === 'swap' ? `${spent} to ${v.money.toSymbol}` : spent;
    let ending = `has ended: ${v.stageLabel}.`;
    if (v.stage === 'confirmed' && v.money.amountOut !== null) ending += ` ${v.money.amountOut} ${v.money.toSymbol} arrived.`;
    if (v.error !== null) ending += ` ${v.error.message}`;
    return (
      `[phosphor: the ${kind} you proposed (${legs}, proposal ${p.id}) ${ending} ` +
      'Tell the person in one or two plain sentences: what ended, how, and what it means for their money. ' +
      'If they already know, say nothing.]'
    );
  }

  /* Whether a tool's answer carried this row after it ended: proposal_status and a propose answer
     with the id at the top, diagnose with it under `view`, the proposals page with it in the
     list. The same three shapes the eval harness reads a status off (scripts/eval.ts). */
  function carries(data: unknown, id: string): boolean {
    if (data === null || typeof data !== 'object') return false;
    const row = data as { id?: unknown; view?: { id?: unknown } | null; proposals?: unknown };
    if (row.id === id) return true;
    if (row.view !== null && typeof row.view === 'object' && row.view?.id === id) return true;
    if (Array.isArray(row.proposals)) return row.proposals.some((entry) => carries(entry, id));
    return Array.isArray(data) && data.some((entry) => carries(entry, id));
  }

  function seen(chat: Chat, notice: Notice): boolean {
    for (const event of chat.transcript) {
      if (event.kind !== 'tool_data' || event.at < notice.at - SEEN_SLACK_MS) continue;
      if (carries(event.data, notice.id)) return true;
    }
    return false;
  }

  function send(chat: Chat, notice: Notice): void {
    try {
      chat.driver.send(`${notice.text}\n\n${deps.tag()}`);
    } catch {
      // No agent on this seat any more. The card in the window still says what happened.
      return;
    }
    deps.audit.append('driver_prompt', `app to ${chat.label}: ${notice.text}`, { chat: chat.id, id: notice.id });
  }

  function onWrite(p: Proposal): void {
    if (typeof p.by !== 'string') return;
    const v = deps.view(p);
    if (!v.terminal) return;
    /* Keyed by the ending, not the row: `stalled` is terminal and settles forward, so a row told
       as late is told again when the credit lands, and never twice for the same lateness. */
    const key = `${p.id}:${v.stage}`;
    if (told.has(key)) return;
    const chat = deps.chats().find((c) => c.session === p.by);
    if (chat === undefined) return;
    remember(key);
    const notice: Notice = { id: p.id, text: words(p, v), at: now() };
    const state = chat.driver.status().state;
    if (state === 'ready') {
      send(chat, notice);
      return;
    }
    if (state === 'thinking' || state === 'starting') {
      queued.set(chat.id, [...(queued.get(chat.id) ?? []), notice]);
    }
    // stopped, failed, off: nobody to tell, and the row keeps its card.
  }

  function flush(chat: Chat): void {
    const waiting = queued.get(chat.id);
    if (waiting === undefined) return;
    queued.delete(chat.id);
    for (const notice of waiting) {
      if (!seen(chat, notice)) send(chat, notice);
    }
  }

  const off = deps.store.subscribe(onWrite);

  return {
    flush,
    pending: () => [...queued.values()].reduce((n, list) => n + list.length, 0),
    stop: () => {
      off();
      queued.clear();
    },
  };
}
