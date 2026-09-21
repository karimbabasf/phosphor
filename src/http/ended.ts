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

// `seat` is the session the row names, so a notice queued for one agent is never handed to
// the next one seated in the same conversation after a restart.
type Notice = { id: string; stage: string; seat: string; text: string; at: number };

// The longest any one interpolated field may be. Venue error bodies run to paragraphs.
const FIELD_MAX = 200;

// How many endings this process remembers having told, as row and stage. Beyond it the oldest
// are forgotten, which risks a repeat about a row a thousand endings old and nothing worse.
const TOLD_MAX = 1000;

const KIND_WORDS: Record<string, string> = {
  swap: 'swap',
  hl_deposit: 'deposit to Hyperliquid',
  hl_withdraw: 'withdrawal from Hyperliquid',
  intents_send: 'send',
  intents_pay: 'payout',
  trade: 'trade',
  policy_change: 'rule change',
};

/* ONE LINE, NO BRACKETS, BOUNDED. Everything interpolated into the notice is remote text at one
   remove or another: a venue's error body, a token list's symbol, the venue's settled figure.
   Inside a tool result the agent reads such text as data. Inside a user turn it does not, and
   a newline plus a "]" would close the app's fence and let the rest read as a fresh line from
   somebody else. So every field is flattened, stripped of both brackets and cut. */
function plain(value: unknown, max: number = FIELD_MAX): string {
  const text = String(value ?? '').replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)} (cut)` : text;
}

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

  // What the move was, in the fewest words that still name it. A rule change is its sentence,
  // a trade change is its operation, everything else is what it spent.
  function legs(p: Proposal, v: ProposalView): string {
    const draft = p.draft;
    if (draft.kind === 'policy_change') return plain(draft.sentence, 80);
    if (draft.kind === 'trade' && draft.op !== 'open') return plain(`${draft.op} on ${v.money.symbol}`);
    const spent = v.money.amountIn === null ? plain(v.money.symbol) : plain(`${v.money.amountIn} ${v.money.symbol}`);
    if (spent === '') return '';
    return draft.kind === 'swap' ? `${spent} to ${plain(v.money.toSymbol)}` : spent;
  }

  function words(p: Proposal, v: ProposalView): string {
    const kind = p.draft.kind === 'trade' && p.draft.op !== 'open' ? 'change to a trade' : (KIND_WORDS[p.kind] ?? plain(p.kind));
    const what = legs(p, v);
    const named = what === '' ? `proposal ${plain(p.id)}` : `${what}, proposal ${plain(p.id)}`;
    let ending = `has ended: ${plain(v.stageLabel)}.`;
    if (v.stage === 'confirmed' && v.money.amountOut !== null) ending += ` ${plain(v.money.amountOut)} ${plain(v.money.toSymbol)} arrived.`;
    if (v.error !== null) ending += ` ${plain(v.error.message)}`;
    return (
      `[phosphor: the ${kind} you proposed (${named}) ${ending} ` +
      'Tell the person in one plain sentence: what ended and what it means for their money, with the figure that changed. ' +
      'If they already know, say nothing.]'
    );
  }

  /* Whether a tool's answer carried this row AT this ending. The stage is the whole test: a
     read that returned the row still crediting, a moment before the venue credited it, is a
     read of the row and not of its ending, and dropping the notice on it is exactly the
     transcript bug this file exists to close. The shapes are the two the driver hands the
     window (src/driver.ts, TOOL_DATA_TOOLS): proposal_status answers with the view, and a
     propose answers with the id on top and the view beside it. A read through `proposals` or
     `diagnose` reaches the window as nothing, so it cannot count here; the agent is told to say
     nothing when the person already knows, which covers a repeat. */
  function carries(data: unknown, notice: Notice): boolean {
    if (data === null || typeof data !== 'object') return false;
    const row = data as { id?: unknown; stage?: unknown; view?: { id?: unknown; stage?: unknown } | null };
    if (row.id === notice.id && row.stage === notice.stage) return true;
    const view = row.view;
    return view !== null && typeof view === 'object' && view?.id === notice.id && view?.stage === notice.stage;
  }

  function seen(chat: Chat, notice: Notice): boolean {
    return chat.transcript.some((event) => event.kind === 'tool_data' && carries(event.data, notice));
  }

  // One turn, however many endings it carries: the driver flips to thinking on the first
  // write, and a second write would land inside that turn.
  function send(chat: Chat, notices: Notice[]): void {
    if (notices.length === 0) return;
    const text = notices.map((n) => n.text).join('\n\n');
    try {
      chat.driver.send(`${text}\n\n${deps.tag()}`);
    } catch {
      // No agent on this seat any more. The card in the window still says what happened.
      return;
    }
    deps.audit.append('driver_prompt', `app to ${chat.label}: ${text}`, { chat: chat.id, ids: notices.map((n) => n.id) });
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
    const notice: Notice = { id: p.id, stage: v.stage, seat: p.by, text: words(p, v), at: now() };
    const state = chat.driver.status().state;
    if (state === 'ready') {
      send(chat, [notice]);
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
    send(
      chat,
      waiting.filter((notice) => notice.seat === chat.session && !seen(chat, notice)),
    );
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
