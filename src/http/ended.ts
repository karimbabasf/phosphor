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
// this process has not told yet, becomes one note to that conversation: an app-authored line,
// fenced and named like the screen tag, saying which move ended, how, and why.
//
// A NOTE, NEVER A TURN (2026-09-23). It used to go down as a turn of its own, and the agent
// answered every one: five in eight minutes, each a paragraph repeating a card the person could
// already see (R3). The driver now holds it (src/driver.ts note) and it rides in front of the
// person's next message, so the agent knows how its move ended without being woken to say so.
//
// UNLESS THE MOVE DID NOT GO THROUGH (2026-09-25). The agent filed VVV to USDC as step one of a
// plan to DAI and told the person "Once the USDC shows up, I'll get you a price for DAI". The
// swap failed, the note sat waiting for a message, and the person's words were "the agent
// noticed it failed only after I asked it". A plan that broke needs the person, so an ending
// that did not go through (failed, refunded, nothing moved: see wakes) is noted as above and
// then wakes the agent for one line. Every other ending stays a silent note: R3 stands. The wake
// keeps what R3 taught: failures that land within GATHER_MS of each other are one turn, a chat is
// woken at most once per WAKE_GAP_MS and a failure inside that stays a note, and a person who
// speaks first carries the note in front of their own words, which calls the wake off.
//
// WHAT IT IS NOT. Not an approval path and not a retry: it carries no id the agent could act on
// beyond reading, and the turn a failure wakes says it approves nothing and asks for no move
// until the person answers. That sentence is not the wall: the seat is marked for exactly that
// turn, and any move filed inside it waits for the person's click whatever its size
// (src/app-turn.ts). Not a message the window draws: the card already shows the ending,
// and only the agent's line is drawn. Not an interruption: a turn in progress is left alone, the
// notice waits on the chat and is noted when the driver reports ready, unless the transcript
// shows the agent read that row's ending itself in the meantime, in which case it is dropped.

import type { Proposal } from '../types.ts';
import type { ProposalView } from '../proposals/view.ts';
import type { Audit } from '../audit.ts';
import type { DriverEvent } from '../driver.ts';
import { clearAppTurn, markAppTurn } from '../app-turn.ts';
import type { Chat } from './context.ts';

// A wake waiting on its window, and the only thing needed to call it off.
export type WakeTimer = { cancel(): void };

export type EndedNoticeDeps = {
  store: { subscribe(fn: (p: Proposal) => void): () => void };
  chats: () => Chat[];
  view: (p: Proposal) => ProposalView;
  // The screen tag, the line the person's own messages carry (src/http/mutation.ts, screenTag).
  // A note rides one of those; the turn a failure wakes is the app's, so it carries its own.
  tag?: () => string;
  audit: Pick<Audit, 'append'>;
  now?: () => number;
  // Test seam, as in src/market/push.ts: the gathering window is the one part that happens later.
  schedule?: (fn: () => void, ms: number) => WakeTimer;
};

export type EndedNotices = {
  // Sends what waits on this chat, if anything does. The chat registry calls it when the
  // driver reports ready.
  flush(chat: Chat): void;
  // Every event the chat's driver reports; the chat registry calls it. The turn a failure woke
  // ends on its turn_end (see wake).
  event(chat: Chat, event: DriverEvent): void;
  pending(): number;
  stop(): void;
};

// `seat` is the session the row names, so a notice queued for one agent is never handed to
// the next one seated in the same conversation after a restart. `wakes`: see wakes below.
type Notice = { id: string; stage: string; seat: string; text: string; wakes: boolean; at: number };

// The longest any one interpolated field may be. Venue error bodies run to paragraphs.
const FIELD_MAX = 200;

// How many endings this process remembers having told, as row and stage. Beyond it the oldest
// are forgotten, which risks a repeat about a row a thousand endings old and nothing worse.
const TOLD_MAX = 1000;

// How long the first failure waits for the ones behind it: two legs of one plan failing a few
// seconds apart are one thing to say, not two.
const GATHER_MS = 5_000;

// The least time between two turns the app starts in one chat. R3 was five in eight minutes. A
// failure inside it stays a note, and the person's next message carries it.
const WAKE_GAP_MS = 120_000;

/* THE TURN A FAILURE WAKES, sent under the notes that name the endings: the driver puts what it
   holds in front of any turn (src/driver.ts send). Fenced like every app line, one line, no id,
   and it says what it is not: the person did not write it and it approves nothing, so what comes
   back is a line of words and never a move made while nobody is asking. */
const WAKE =
  '[phosphor: the app wrote this turn, not the person, and it approves nothing. A move you proposed did not go through, ' +
  'and the card already shows how it ended. Reply in ONE line: what that means for what they asked, and the next step ' +
  'you can offer, such as a retry or another route. Never repeat the card or its numbers, and propose nothing until they answer.]';

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

/* THE ENDINGS THAT NEED THE PERSON, read off the view's plain state, which already puts the cause
   over the stage (src/proposals/view.ts, plainStateOf): a FAILED the app is still checking is
   `working`, money on its way back is `coming_back`, a short fill is `done`. A refusal the agent
   met inside its own propose wakes nothing: it lands mid-turn, and the answer that carried it
   drops it (see seen). `declined` is the person's own no, and telling them what they just did is
   R3 again. */
function wakes(v: ProposalView): boolean {
  if (v.stage === 'declined') return false;
  return v.state === 'didnt_go_through' || v.state === 'coming_back';
}

// The real timer, unref'd so a wake still owed never holds the process open.
function realTimer(fn: () => void, ms: number): WakeTimer {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export function createEndedNotices(deps: EndedNoticeDeps): EndedNotices {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? realTimer;
  const told = new Set<string>();
  const toldOrder: string[] = [];
  const queued = new Map<string, Notice[]>();
  // By chat: the wake owed (the rows its notes carry, and its timer), and when the app last woke it.
  const owed = new Map<string, { ids: string[]; timer: WakeTimer }>();
  const woke = new Map<string, number>();
  // By chat: the seat a turn the app started is running on, marked until that turn ends.
  const running = new Map<string, string>();

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

  function words(p: Proposal, v: ProposalView, failure: boolean): string {
    const kind = p.draft.kind === 'trade' && p.draft.op !== 'open' ? 'change to a trade' : (KIND_WORDS[p.kind] ?? plain(p.kind));
    const what = legs(p, v);
    const named = what === '' ? `proposal ${plain(p.id)}` : `${what}, proposal ${plain(p.id)}`;
    let ending = `has ended: ${plain(v.stageLabel)}.`;
    if (v.stage === 'confirmed' && v.money.amountOut !== null) ending += ` ${plain(v.money.amountOut)} ${plain(v.money.toSymbol)} arrived.`;
    if (v.error !== null) ending += ` ${plain(v.error.message)}`;
    return (
      `[phosphor: since your last answer, the ${kind} you proposed (${named}) ${ending} ` +
      // A failure is to be told, not held back: the wake, or the persona under their message, says how.
      (failure ? 'The card already shows this; never repeat it.]' : 'The card already shows this; mention it only if it bears on what they ask next.]')
    );
  }

  /* Whether a tool's answer carried this row AT this ending. The stage is the whole test: a
     read that returned the row still crediting, a moment before the venue credited it, is a
     read of the row and not of its ending, and dropping the notice on it is exactly the
     transcript bug this file exists to close. The shapes are the two the driver hands the
     window (src/driver.ts, TOOL_DATA_TOOLS): proposal_status answers with the view, and a
     propose answers with the id on top and the view beside it. A read through `proposals` or
     `diagnose` reaches the window as nothing, so it cannot count here: a note says to mention it
     only if it bears on what they ask next, and a failure wakes one line at most per WAKE_GAP_MS. */
  function carries(data: unknown, notice: Notice): boolean {
    if (data === null || typeof data !== 'object') return false;
    const row = data as { id?: unknown; stage?: unknown; view?: { id?: unknown; stage?: unknown } | null };
    if (row.id === notice.id && row.stage === notice.stage) return true;
    const view = row.view;
    return view !== null && typeof view === 'object' && view?.id === notice.id && view?.stage === notice.stage;
  }

  /* A swap_check answer names the row and not its stage: it is the swap's truth read at that
     moment (src/proposals/swap-reads.ts), so one that came back after the ending landed was a read
     of the ending. The persona sends the agent there on every failed swap (src/persona.ts CHECK),
     and a failure it had just explained must not wake it to explain it again. */
  function checked(event: Chat['transcript'][number], notice: Notice): boolean {
    if (event.kind !== 'tool_data' || !event.name.endsWith('swap_check') || event.at < notice.at) return false;
    const data = event.data as { id?: unknown } | null;
    return data !== null && typeof data === 'object' && data.id === notice.id;
  }

  function seen(chat: Chat, notice: Notice): boolean {
    return chat.transcript.some((event) => event.kind === 'tool_data' && (carries(event.data, notice) || checked(event, notice)));
  }

  // One note, however many endings it carries. A failure among them is owed a wake besides.
  function send(chat: Chat, notices: Notice[]): void {
    if (notices.length === 0) return;
    // No agent on this seat any more. The card in the window still says what happened.
    const state = chat.driver.status().state;
    if (state === 'stopped' || state === 'failed' || state === 'off') return;
    const text = notices.map((n) => n.text).join('\n\n');
    chat.driver.note(text);
    deps.audit.append('driver_prompt', `app note for ${chat.label}: ${text}`, { chat: chat.id, ids: notices.map((n) => n.id) });
    const failures = notices.filter((n) => n.wakes);
    if (failures.length > 0) owe(chat, failures);
  }

  /* GATHER_MS after the first failure it carries, counted from when that ending landed and not
     from when it was noted: a failure that waited out a long turn goes the moment the turn ends,
     and one that landed while the agent was idle waits for the ones behind it. A failure noted
     while a wake is owed joins it. */
  function owe(chat: Chat, failures: Notice[]): void {
    const ids = failures.map((n) => n.id);
    const waiting = owed.get(chat.id);
    if (waiting !== undefined) {
      waiting.ids.push(...ids);
      return;
    }
    const first = Math.min(...failures.map((n) => n.at));
    owed.set(chat.id, { ids, timer: schedule(() => wake(chat), Math.max(0, first + GATHER_MS - now())) });
  }

  /* The notes are already with the driver, which sends them in front of this turn. A driver that
     is not ready has a turn under way, and that turn carried them: the person spoke first. */
  function wake(chat: Chat): void {
    const waiting = owed.get(chat.id);
    if (waiting === undefined) return;
    owed.delete(chat.id);
    if (chat.driver.status().state !== 'ready') return;
    const last = woke.get(chat.id);
    if (last !== undefined && now() - last < WAKE_GAP_MS) return;
    const tag = deps.tag?.();
    /* THE TURN IS THE APP'S, and so is anything proposed inside it. The seat is marked before the
       turn goes down, so a move filed in it waits for the person's click whatever its size
       (src/app-turn.ts), and the mark goes when that turn ends (event below). */
    markAppTurn(chat.session);
    running.set(chat.id, chat.session);
    try {
      chat.driver.send(tag === undefined ? WAKE : `${WAKE}\n\n${tag}`);
    } catch {
      // The driver would not take a turn. The notes stay for the person's next message.
      over(chat);
      return;
    }
    woke.set(chat.id, now());
    deps.audit.append('driver_prompt', `app to ${chat.label}: ${WAKE}`, { chat: chat.id, ids: waiting.ids });
  }

  // The app's turn in this chat is over, and its seat is the person's again.
  function over(chat: Chat): void {
    const seat = running.get(chat.id);
    if (seat === undefined) return;
    running.delete(chat.id);
    clearAppTurn(seat);
  }

  /* The woken turn ends on its own turn_end. A driver in any state but answering has no turn
     under way either (ready, stopped, failed, a restart starting), so the mark goes then too. */
  function event(chat: Chat, e: DriverEvent): void {
    if (e.kind === 'turn_end' || (e.kind === 'status' && e.state !== 'thinking')) over(chat);
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
    const failure = wakes(v);
    const notice: Notice = { id: p.id, stage: v.stage, seat: p.by, text: words(p, v, failure), wakes: failure, at: now() };
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
    /* Ready comes after a turn or a start, and either took the driver's notes with it: into the
       turn (the person spoke inside the window) or away (a restart). A wake owed from before this
       moment has nothing left to wake for. */
    const stale = owed.get(chat.id);
    if (stale !== undefined) {
      stale.timer.cancel();
      owed.delete(chat.id);
    }
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
    event,
    pending: () => [...queued.values()].reduce((n, list) => n + list.length, 0),
    stop: () => {
      off();
      queued.clear();
      for (const waiting of owed.values()) waiting.timer.cancel();
      owed.clear();
      for (const seat of running.values()) clearAppTurn(seat);
      running.clear();
    },
  };
}
