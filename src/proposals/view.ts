// The one object every surface reads. proposal_status returns it, /api/state carries it, the
// card draws it, the agent narrates it. Two copies of this truth is the bug this file exists
// to end (the card said "Confirmed at 14:20" while the agent said "still settling").
//
// Names shared by the backend, the window and the evals:
//   SSE frame            { type: 'proposal', id }   (the object rides in GET /api/state.proposals[].view, never in the frame)
//   proposal_status      ({ id })                    returns ProposalView
//   proposals            ({ limit?, kind? })         returns { proposals: ProposalView[] }, newest first, default 10, max 50
//   diagnose             ({ id })                    returns { view, log: string[], provider, venue }
//   show                 ({ kind, id })              returns { drawn: true, kind, id } and emits the card
//   card ids             card-proposal-<proposalId>, card-tx-<hash>, dock-ask, #agent-status

/* The one import that runs rather than being erased, and it points at the module that imports
   this one. Both sides are hoisted function declarations over a plain row and neither is called
   while a module is being evaluated, so the pair resolves. It is here rather than restated
   because a second derivation of OutcomeState beside this one is the exact bug this file
   exists to end. */
import { outcomeOf } from './lifecycle.ts';
import type { OutcomeState, PlanFate } from './lifecycle.ts';
import { px } from '../trade/plan.ts';
import { isReasonCode } from '../rails/reasons.ts';
import type { ReasonCode } from '../rails/reasons.ts';
import type { PolicyAxisChange, Proposal, WriteDraft } from '../types.ts';
import { baseUnitsToDecimal } from '../intents.ts';
import { spendNetworkOf } from '../rails/intents-address.ts';

// The app's own phases are lowercase. The provider's phases are the vendor's words, byte for
// byte: 1Click's seven off GetExecutionStatusResponse, the solver relay's four off get_status,
// because "settling" is a word nobody outside this app can check. INCOMPLETE_DEPOSIT is never
// folded into PROCESSING: partial money arrived. The vendor word is the stage's IDENTITY, never
// its face: STAGE_LABEL is the only text a surface prints, and no label carries a vendor's word.
export type ProposalStage =
  | 'waiting_for_you'
  | 'waiting_for_unlock'
  | 'waiting_for_touch'
  | 'held'
  | 'signing'
  | 'submitting'
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED'
  | 'PENDING'
  | 'TX_BROADCASTED'
  | 'SETTLED'
  | 'NOT_FOUND_OR_NOT_VALID'
  | 'crediting'
  | 'confirmed'
  | 'failed'
  | 'declined'
  | 'refused'
  | 'stalled';

export type TxLeg = {
  leg: 'origin' | 'near' | 'intent' | 'destination';
  hash: string;
  network: string | null;
  explorer: string | null;
  running: boolean; // the leg the operation is inside right now. At most one is true.
};

/* The states a person reads a move in. Twenty-three stage words are the app's to keep; a card
   shows one of these. `stalled` is working and late, never over. `coming_back` is money that left
   and is on its way back: not over, and never "didn't go through", which reads as nothing moved. */
export type MoveState = 'working' | 'needs_you' | 'done' | 'didnt_go_through' | 'coming_back';

/* Why a move is where it is, when that needs saying: the code from src/rails/reasons.ts, the one
   plain sentence for it (what happened, where the money is, what the person can do), and the
   engineer's line behind it with long ids shortened. The card prints the sentence and folds the
   details; the agent quotes the sentence. Chosen by the cause, never by the status. */
export type ProposalReason = {
  code: ReasonCode;
  sentence: string;
  details: string | null;
  /* Whether asking for the same move again can work as it stands: nobody quoted, the price moved,
     a read failed, or it ended with nothing gone. Never for a move that may still be live at the
     venue, nor for one only a different amount, coin or rule would let through. */
  retry: boolean;
};

export type ProposalView = {
  id: string;
  kind: WriteDraft['kind'];
  sentence: string; // what the move IS, in one plain line. The card prints it, the agent quotes it.
  /* A policy change's money axes, before and after, from the verdict the engine wrote. The
     sentence above is the AGENT's words and this is the app's own arithmetic beside them, so a
     card can show what the change actually does rather than what it was called. Empty for every
     other kind, and for a policy change that moves no money limit. */
  changes: PolicyAxisChange[];
  stage: ProposalStage;
  stageLabel: string; // the one plain line both surfaces print. Never built twice.
  /* The sentence under the label, STAGE_COPY verbatim: what is happening and whether the
     person has to do anything. On the view so the card prints it and the agent quotes it off
     the same read, rather than each phrasing the wait in its own words. */
  stageCopy: string;
  providerStage: string | null; // 1Click's raw word, null when no provider owns this phase
  waitingOn: string | null; // 'You', 'Touch ID', '1Click', 'Hyperliquid', null when terminal
  terminal: boolean;
  /* True on `stalled` alone. The row is terminal in the sense that the app has stopped expecting
     the venue, and it is NOT finished: the same balance read that would have settled it still
     settles it forward to confirmed. The two facts sit beside each other because `terminal: true`
     under "Late, nothing has changed" reads as "this is over", and the thing a reader does next
     on that reading is send a second copy of a move that was merely slow. */
  settlesForward: boolean;
  outcome: OutcomeState;
  createdAt: string;
  decidedAt: string | null;
  /* Who decided, and it is the fact the "You clicked at" line turns on. A policy decision (an
     auto-run under the ask line, a refusal by a rule) carries a decidedAt too, and a card that
     read only the clock said the human had clicked on every one of them. */
  decidedBy: 'human' | 'policy' | null;
  settledAt: string | null;
  lastChangeAt: string; // when `stage` last changed, not when the row was last written
  elapsedSec: number; // now - createdAt
  sinceChangeSec: number; // now - lastChangeAt
  /* End to end, once it has ended: from the ask to the moment it settled. Null while it is
     open, and null on `stalled`, which has not ended. `elapsedSec` keeps growing after the
     end (it is a clock, not a duration), and a card that printed it as "took" said a swap
     took sixty hours. */
  tookSec: number | null;
  typicalSec: number | null;
  deadlineAt: string | null; // when this row flips itself to `stalled`; null for kinds with no deadline
  money: {
    symbol: string; // what is spent
    toSymbol: string; // what arrives: the bought coin on a swap, the same coin everywhere else
    amountIn: string | null;
    feeUsd: string | null;
    amountOut: string | null;
    fromPocket: string | null; // 'NEAR Intents', 'Hyperliquid', a chain id
    toPocket: string | null;
    beforeUsd: number | null;
    afterUsd: number | null;
  };
  txs: TxLeg[];
  correlationId: string | null;
  /* The engine's or the rail's own code (kept for readers that switch on it) and, for a move
     that stopped, the plain sentence from `reason`. */
  error: { code: string; message: string } | null;
  state: MoveState;
  // Set once a move that is still working has run past its usual time, counted from the click.
  late: { elapsedSec: number; typicalSec: number } | null;
  reason: ProposalReason | null;
  // A finished move with a catch, in one sentence: less arrived than was approved. Null otherwise.
  note: string | null;
};

/* THE ONLY WORDS A STAGE IS EVER PRINTED AS. The card, the agent's sentence, proposal_status and
   the ending notice all read this table and none of them keeps a copy. The rule for a label: the
   app's own words, never a vendor's ("The router is working" was 1Click's phase wearing a
   sentence, and a person who has never heard of a router read it as a fault). Every wait names
   what is being waited on, every ending names what happened, and no label is a code. */
export const STAGE_LABEL: Record<ProposalStage, string> = {
  waiting_for_you: 'Waiting for you',
  waiting_for_unlock: 'Needs the unlock',
  waiting_for_touch: 'Touch ID',
  held: 'Holding',
  signing: 'Signing',
  submitting: 'Sending it',
  KNOWN_DEPOSIT_TX: 'Deposit seen',
  PENDING_DEPOSIT: 'Waiting for the deposit',
  INCOMPLETE_DEPOSIT: 'Part of it arrived',
  PROCESSING: 'On its way',
  SUCCESS: 'Waiting for the venue to credit it',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
  PENDING: 'Finding a match',
  TX_BROADCASTED: 'Settling on NEAR',
  SETTLED: 'Settled, checking your balance',
  NOT_FOUND_OR_NOT_VALID: 'Not accepted, checking nothing moved',
  crediting: 'Waiting for the venue to credit it',
  confirmed: 'Confirmed',
  failed: 'Failed',
  declined: 'Declined',
  refused: 'Refused',
  stalled: 'Late, nothing has changed',
};

/* ONE LINE OF USER COPY PER STAGE: what is happening, and whether the person has to do anything.
   The label is the headline; this is the sentence under it. A surface prints it verbatim or not
   at all, never a paraphrase, so the card and the agent cannot describe one moment two ways. */
export const STAGE_COPY: Record<ProposalStage, string> = {
  waiting_for_you: 'Nothing moves until you answer.',
  waiting_for_unlock: 'The wallet is locked. Unlock it and the move continues.',
  waiting_for_touch: 'Touch ID is asking for your fingerprint. Nothing moves until you answer it.',
  held: 'The checks before signing have not cleared. Nothing is signed until they do; the app tries again.',
  signing: 'The wallet is signing it. Nothing for you to do.',
  submitting: 'It is signed and being sent. Nothing for you to do.',
  KNOWN_DEPOSIT_TX: 'Your money has been seen on its way. Nothing for you to do.',
  PENDING_DEPOSIT: 'Waiting for your money to arrive at the transfer. Nothing for you to do.',
  INCOMPLETE_DEPOSIT: 'Part of the money arrived and the rest is still on its way. Nothing for you to do yet.',
  PROCESSING: 'The transfer is moving your money across. Nothing for you to do.',
  SUCCESS: 'The transfer is done and the venue has not shown the money yet. Nothing for you to do.',
  REFUNDED: 'The transfer could not finish and sent the money back. Check your balance before doing anything else.',
  FAILED: 'The transfer could not finish and nothing more is signed. Check your balance before doing anything else.',
  PENDING: 'Your swap is sent and being matched at the price you approved. Nothing for you to do.',
  TX_BROADCASTED: 'Your swap is settling on NEAR. Nothing for you to do.',
  SETTLED: 'Your swap settled. The balance is being read to confirm it. Nothing for you to do.',
  NOT_FOUND_OR_NOT_VALID: 'The network did not accept the swap. Nothing should have moved. The app checks your balance until the price window closes, then marks it.',
  crediting: 'The money is on its way to the venue and not in the balance yet. Nothing for you to do.',
  confirmed: 'Done. The balance shows it.',
  failed: 'It did not go through. The reason is on the card. Nothing more will be signed.',
  declined: 'You said no. Nothing moved.',
  refused: 'A rule you set stopped it. Nothing moved. Change it in Vault, under Policies, if you want it to go.',
  stalled: 'Late: nothing has changed since the last update. The app keeps checking; nothing more is signed.',
};

/* NOT_FOUND_OR_NOT_VALID is not here on purpose. When the relay answers it for a published
   intent the signed bytes stay valid until the deadline, so the rail leaves the row open with
   that word and the sweep writes `failed` after the deadline plus grace; until then the row is
   still being checked, and a card that said Failed over it was ahead of the app. */
export const TERMINAL: ReadonlySet<ProposalStage> = new Set<ProposalStage>([
  'confirmed',
  'failed',
  'declined',
  'refused',
  'stalled',
  'REFUNDED',
  'FAILED',
]);

/* THE PATH EACH MONEY KIND WALKS, in order, and the words it can end on. A card draws its
   progress from `path`, a harness enumerates its situations from both, and a rail that stamps a
   word outside its kind's path is wrong, not novel. The steps a person owns (waiting_for_you,
   waiting_for_unlock, waiting_for_touch) come first and are skipped when nothing asks for them:
   under the threshold there is no click, on a software wallet there is no Touch ID. A swap's
   path is the relay's; the 1Click swap that stays behind `swap.rail` for a month walks
   LEGACY_SWAP_PATH, and a history row keeps whichever it walked.

   `held` sits between the person's steps and the signature on every kind that runs a
   preflight (src/preflight/, the 1Click rails): the checks said wait, nothing was signed, and
   the executor tries again. It is skipped when the checks clear first time, which is most
   rows. It read "Signing" before this word existed, over a row that was signing nothing. */
export type KindStages = { path: readonly ProposalStage[]; terminal: readonly ProposalStage[] };
const PERSON_STEPS: readonly ProposalStage[] = ['waiting_for_you', 'waiting_for_unlock', 'waiting_for_touch'];
const ENDINGS_OF_A_CLICK: readonly ProposalStage[] = ['declined', 'refused'];
export const KIND_STAGES: Record<WriteDraft['kind'], KindStages> = {
  swap: {
    path: [...PERSON_STEPS, 'signing', 'submitting', 'PENDING', 'TX_BROADCASTED', 'SETTLED', 'confirmed'],
    terminal: ['confirmed', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  hl_deposit: {
    path: [...PERSON_STEPS, 'held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'crediting', 'confirmed'],
    terminal: ['confirmed', 'REFUNDED', 'FAILED', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  hl_withdraw: {
    path: [...PERSON_STEPS, 'held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'crediting', 'confirmed'],
    terminal: ['confirmed', 'REFUNDED', 'FAILED', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  intents_send: {
    path: [...PERSON_STEPS, 'held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'confirmed'],
    terminal: ['confirmed', 'REFUNDED', 'FAILED', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  intents_pay: {
    path: [...PERSON_STEPS, 'held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'confirmed'],
    terminal: ['confirmed', 'REFUNDED', 'FAILED', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  trade: {
    path: [...PERSON_STEPS, 'signing', 'submitting', 'confirmed'],
    terminal: ['confirmed', 'failed', 'stalled', ...ENDINGS_OF_A_CLICK],
  },
  policy_change: {
    path: ['waiting_for_you', 'confirmed'],
    terminal: ['confirmed', 'failed', ...ENDINGS_OF_A_CLICK],
  },
};
export const LEGACY_SWAP_PATH: readonly ProposalStage[] = [...PERSON_STEPS, 'held', 'signing', 'submitting', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'crediting', 'confirmed'];

export const TYPICAL_SEC: Record<WriteDraft['kind'], number> = {
  hl_deposit: 180,
  hl_withdraw: 180,
  swap: 45,
  intents_send: 60,
  intents_pay: 60,
  trade: 10,
  policy_change: 0,
};

// Eight typical durations, floor ten minutes, for every kind that moves money. A policy change
// is a click on a sentence and never waits on anyone, so it has no deadline.
export const DEADLINE_SEC: Record<WriteDraft['kind'], number | null> = Object.fromEntries(
  (Object.keys(TYPICAL_SEC) as WriteDraft['kind'][]).map((kind) => [
    kind,
    kind === 'policy_change' ? null : Math.max(TYPICAL_SEC[kind] * 8, 600),
  ]),
) as Record<WriteDraft['kind'], number | null>;

// The vendors' words, as each vendor spells them: 1Click's seven, then the solver relay's four.
// A word this app does not recognise is not printed as a stage: the row falls back to its own
// phase rather than showing a string the stage table has no label for.
export const ONECLICK_STAGES: ReadonlySet<string> = new Set([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);
export const RELAY_STAGES: ReadonlySet<string> = new Set(['PENDING', 'TX_BROADCASTED', 'SETTLED', 'NOT_FOUND_OR_NOT_VALID']);
const PROVIDER_STAGES: ReadonlySet<string> = new Set([...ONECLICK_STAGES, ...RELAY_STAGES]);
// The two vendor words that mean "my part is done": the money is with the venue and not yet in
// the balance, which is `crediting` once the executor has handed the row to the settle watch.
const PROVIDER_DONE: ReadonlySet<string> = new Set(['SUCCESS', 'SETTLED']);

/* THE ONE MAP FROM A ROW TO A STAGE WORD. Every surface reads this and none of them keeps a
   second one: the card had its own `STAGES` table and the agent had `outcomeOf`, and the two
   disagreeing is the bug. Pure: it reads the row and nothing else, so persist() can call it on
   the row it is about to write and on the row it is replacing. */
export function stageOf(p: Proposal): ProposalStage {
  const provider = p.result?.evidence?.providerStage;
  switch (p.status) {
    case 'pending':
      return 'waiting_for_you';
    case 'pending_unlock':
      return 'waiting_for_unlock';
    case 'awaiting_touch':
      return 'waiting_for_touch';
    // Approved and stamped heldSince is the preflight holding the row (execute.ts): nothing
    // is being signed, and "Signing" over it was the wrong wait with the wrong owner.
    case 'approved':
      return p.heldSince !== undefined ? 'held' : 'signing';
    case 'executing':
      return provider !== undefined && PROVIDER_STAGES.has(provider) ? (provider as ProposalStage) : 'submitting';
    /* The router being done is not the venue having credited the money, and the gap between
       those two facts is the transcript this file exists to close. So SUCCESS on an open row
       reads `crediting`, which names what is actually being waited on; every other 1Click word
       still describes the router's own work and is passed through as the vendor spells it. */
    case 'needs_reconciliation':
      if (p.stalledAt !== undefined) return 'stalled';
      if (provider !== undefined && !PROVIDER_DONE.has(provider) && PROVIDER_STAGES.has(provider)) return provider as ProposalStage;
      return 'crediting';
    case 'executed':
      return 'confirmed';
    case 'failed':
      return 'failed';
    // A person clicked no, which is a decision rather than a fault: "Declined". The policy
    // refusing is the app's own wall and reads "Refused". Two words for two different actors.
    case 'refused':
      return 'declined';
    case 'policy_refused':
      return 'refused';
  }
}

/* WHO HAS NOT ANSWERED YET, in the words a person would use. Null once the row is terminal,
   because "waiting on nobody" is not a fact worth printing and a card that kept a name there
   would read as though something were still owed. */
function waitingOn(p: Proposal, stage: ProposalStage): string | null {
  if (TERMINAL.has(stage)) return null;
  switch (stage) {
    case 'waiting_for_you':
    case 'waiting_for_unlock':
      return 'You';
    case 'waiting_for_touch':
      return 'Touch ID';
    case 'held':
      return 'The checks';
    case 'signing':
      return 'the wallet';
    case 'crediting':
      return p.kind === 'hl_deposit' ? 'Hyperliquid' : 'NEAR Intents';
    case 'PENDING':
    case 'TX_BROADCASTED':
    case 'SETTLED':
    case 'NOT_FOUND_OR_NOT_VALID':
      // The relay's words: the swap is inside NEAR Intents the whole way.
      return 'NEAR Intents';
    default:
      /* submitting and every 1Click word: the transfer between pockets is the thing that has
         not answered. It is named as what it is to the person, never by its vendor: "1Click"
         told nobody what they were waiting for. */
      if (p.kind === 'trade') return 'Hyperliquid';
      if (p.kind === 'swap' && p.draft.kind === 'swap' && p.draft.venue === 'intents-relay') return 'NEAR Intents';
      return 'the transfer';
  }
}

/* Where the money starts and where it lands, named as the two pockets a person holds plus the
   chain a payout leaves for. A policy change moves nothing, so both are null.

   RETIRED KINDS STILL HAVE TO RENDER. state/proposals.json holds executed rows naming rails
   this app no longer has (intents_deposit, lp_add, the two yield moves), every surface reads
   them, and a lookup that came back undefined for one of those used to throw inside the state
   build, which is the whole payload gone over a row from a year ago. So every table here is
   read with a fallback rather than indexed blind. */
function pocketsOf(draft: WriteDraft): { from: string | null; to: string | null } {
  switch (draft.kind) {
    case 'hl_deposit':
      return { from: 'NEAR Intents', to: 'Hyperliquid' };
    case 'hl_withdraw':
      return { from: 'Hyperliquid', to: 'NEAR Intents' };
    case 'swap':
    case 'intents_send':
      return { from: 'NEAR Intents', to: 'NEAR Intents' };
    case 'intents_pay':
      return { from: 'NEAR Intents', to: draft.network };
    case 'trade':
      return { from: 'Hyperliquid', to: 'Hyperliquid' };
    case 'policy_change':
      return { from: null, to: null };
    default:
      return { from: null, to: null };
  }
}

function symbolOf(draft: WriteDraft): string {
  if (draft.kind === 'policy_change') return '';
  if (draft.kind === 'swap') return draft.fromSymbol;
  if (draft.kind === 'trade') return draft.op === 'open' ? draft.plan.symbol : 'USDC';
  const symbol = (draft as { symbol?: unknown }).symbol;
  return typeof symbol === 'string' ? symbol : '';
}

// The coin the move lands as. Only a swap changes coins; the card drew its out leg with the
// spent symbol and printed "2.0097 USDC" over two wNEAR (Karim, 2026-09-20).
function toSymbolOf(draft: WriteDraft): string {
  return draft.kind === 'swap' ? draft.toSymbol : symbolOf(draft);
}

function amountInOf(draft: WriteDraft): string | null {
  if (draft.kind === 'policy_change' || draft.kind === 'trade') return null;
  // The exact decimal a swap was approved with, never the double beside it for display.
  if (draft.kind === 'swap' && draft.amountInExact !== undefined) return draft.amountInExact;
  const amount = draft.kind === 'swap' ? draft.amountIn : (draft as { amount?: unknown }).amount;
  return typeof amount === 'number' ? String(amount) : null;
}

/* One bounded line, for the one string on a draft an agent wrote: a policy change's own
   sentence. It is already what the card and the approval show, and it is DATA here as it is
   there, so it arrives flattened and capped rather than able to add lines to a card or a
   reply. Nothing else in this file needs it: every other sentence is built from numbers and
   enum values the app minted. */
const MAX_SENTENCE = 200;

function oneLine(raw: string): string {
  let flat = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 32;
    flat += code < 32 || code === 127 ? ' ' : ch;
  }
  const tidy = flat.replace(/\s+/g, ' ').trim();
  return tidy.length > MAX_SENTENCE ? tidy.slice(0, MAX_SENTENCE) + '...' : tidy;
}

// The amount and the token as the draft holds them, never rounded: "7.54" under a draft that
// says 7.5425 is a figure nobody agreed to. Null amount (a retired kind, a row written without
// one) says the token alone rather than the word undefined.
function moved(draft: WriteDraft): string {
  const amount = amountInOf(draft);
  const symbol = symbolOf(draft);
  return amount === null ? symbol : `${amount} ${symbol}`;
}

/* THE MOVE IN ONE PLAIN LINE. The card prints it, the agent quotes it when it names a pending
   move, and neither of them phrases it again: "what is this?" answered twice is the same bug as
   "what stage is it at?" answered twice.

   Every money line reads the same way, amount then token then the two pockets, so a person who
   has read one has read them all. A send names its receiver in full: the whole address and
   whether it lands on a chain or inside NEAR Intents are the two facts a wrong send turns on,
   and a shortened address is exactly what a substituted one hides behind. */
export function sentenceOf(draft: WriteDraft): string {
  switch (draft.kind) {
    case 'policy_change':
      return oneLine(draft.sentence);
    case 'hl_deposit':
      return `${moved(draft)} from NEAR Intents to Hyperliquid`;
    case 'hl_withdraw':
      return `${moved(draft)} from Hyperliquid to NEAR Intents`;
    // Both legs sit inside the verifier, so the sentence names the two assets rather than two
    // pockets: a swap changes what the balance holds and moves nothing anywhere.
    // The bought coin's network is named: one ticker is several coins, one per network.
    case 'swap': {
      const network = spendNetworkOf(draft.toChain)?.name;
      return `${moved(draft)} to ${draft.toSymbol}${network === undefined ? '' : ` on ${network}`}, inside NEAR Intents`;
    }
    case 'intents_send':
      return `${moved(draft)} from NEAR Intents to ${draft.to}, inside NEAR Intents`;
    case 'intents_pay':
      return `${moved(draft)} from NEAR Intents to ${draft.to}, on ${spendNetworkOf(draft.network)?.name ?? draft.network}`;
    case 'trade': {
      if (draft.op === 'open') {
        const plan = draft.plan;
        return `${plan.side === 'long' ? 'Long' : 'Short'} ${plan.symbol}, $${plan.sizeUsd} notional, stop ${px(plan.stop)}`;
      }
      if (draft.cancel === true) return `Cancel trade ${draft.id}`;
      if (draft.close === true) return `Close trade ${draft.id}`;
      const parts: string[] = [];
      if (draft.stop !== undefined) parts.push(`stop ${px(draft.stop)}`);
      if (draft.target !== undefined) parts.push(`target ${px(draft.target)}`);
      return parts.length === 0 ? `No change to trade ${draft.id}` : `Trade ${draft.id}: ${parts.join(', ')}`;
    }
    // A rail this app no longer has still has to read; see pocketsOf.
    default:
      return moved(draft);
  }
}

/* WHAT ARRIVED, and never a figure this app made up. The venue's settled amount first, because
   that is the only number anybody observed; then the quote the simulation was priced on, which
   is the solver's promise and is what the card drew before the click. Null when neither exists,
   which is a different fact from zero. */
function amountOutOf(p: Proposal): string | null {
  const settled = p.result?.evidence?.settledAmountOut;
  if (settled !== undefined) return settled;
  const sim = p.simulation;
  return sim?.send?.arrives ?? sim?.swap?.receives ?? null;
}

// The fee the simulation priced, in USD. Absent where no simulation carried one: a fee derived
// by subtracting two numbers of different ages is a guess with a decimal point on it.
function feeUsdOf(p: Proposal): string | null {
  const fee = p.simulation?.send?.feeUsd ?? p.simulation?.swap?.feeUsd ?? null;
  return fee === null ? null : fee.toFixed(2);
}

/* THE HASHES, IN THE ORDER THEY WERE LEARNED. The first is the one this app produced: the
   intent it signed, or on a Hyperliquid exit the venue action it sent. The rest are what 1Click
   reported around it, already merged and deduped from its four hash sets by uniqueTxids, so
   nothing here can honestly say which set a later hash came out of and none of them claims to.
   `running` marks the leg the operation is inside: the newest one, and only while the row is
   still open. */
function txsOf(p: Proposal, stage: ProposalStage): TxLeg[] {
  const hashes = p.result?.txids ?? [];
  const explorer = p.result?.evidence?.explorerUrl ?? null;
  const network = p.draft.kind === 'intents_pay' ? p.draft.network : null;
  const open = !TERMINAL.has(stage);
  return hashes.map((hash, i) => ({
    leg: i === 0 ? (p.kind === 'hl_withdraw' ? 'origin' : 'intent') : 'destination',
    hash,
    network: i === 0 ? null : network,
    explorer: i === hashes.length - 1 ? explorer : null,
    running: open && i === hashes.length - 1,
  }));
}

/* WHAT WENT WRONG, as a code the grader and the agent read and a sentence a person reads. A
   human declining is not an error and gets none: they decided, and the row says so. The
   sentence is the reason's own, so the error line and the copy line cannot disagree about why
   (the card said "a rule you set" over a swap nobody had quoted, 2026-09-23); the engineer's line
   is in reason.details. */
function errorOf(p: Proposal, stage: ProposalStage, sinceChangeSec: number, reason: ProposalReason | null): { code: string; message: string } | null {
  // The plain sentence first, then the specific line behind it (a limit's figure, the venue's
  // own words): a card's reason line reads the first sentence, its fold and an agent the rest.
  const said = (fallback: string): string => (reason === null ? fallback : reason.details === null ? reason.sentence : `${reason.sentence} ${reason.details}`);
  /* In a person's units: "22 minutes", never an ISO stamp and never 1325 seconds. The agent
     quotes this line and the card prints it, so it is written for the reader, not the log. */
  if (stage === 'stalled') {
    return {
      code: 'deadline_passed',
      message: `Nothing has changed for ${durationWords(sinceChangeSec)}. ${waitingOn(p, 'crediting') ?? 'The venue'} has not answered.`,
    };
  }
  if (stage === 'refused') return { code: p.verdict.outcome === 'refuse' ? p.verdict.rule : 'policy_refused', message: said(p.verdict.reasons.at(-1) ?? 'The policy refused it.') };
  if (stage === 'failed') return { code: 'rail_failed', message: said(p.result?.detail ?? '') };
  if (stage === 'FAILED') return { code: 'provider_failed', message: said(p.result?.detail ?? '') };
  if (stage === 'REFUNDED') return { code: 'refunded', message: said(p.result?.detail ?? '') };
  return null;
}

// ---------- the plain states and the reasons ----------

const NEEDS_YOU: ReadonlySet<ProposalStage> = new Set<ProposalStage>(['waiting_for_you', 'waiting_for_unlock', 'waiting_for_touch']);
const DIDNT_GO_THROUGH: ReadonlySet<ProposalStage> = new Set<ProposalStage>(['failed', 'declined', 'refused', 'REFUNDED', 'FAILED']);

export function moveStateOf(stage: ProposalStage): MoveState {
  if (NEEDS_YOU.has(stage)) return 'needs_you';
  if (stage === 'confirmed') return 'done';
  if (DIDNT_GO_THROUGH.has(stage)) return 'didnt_go_through';
  return 'working';
}

/* THE STATE A CAUSE SAYS, where it says more than the stage. A FAILED or REFUNDED stage read
   "Didn't go through" over "Still checking whether this went through" and over a refund still on
   its way, so a person read the state, tried again, and could pay twice (hunt A, 2026-09-23). */
const STATE_OF_REASON: Partial<Record<ReasonCode, MoveState>> = {
  stuck_unknown: 'working',
  // A FAILED swap whose signed transfer can still run is still being checked (audit, finding 9).
  venue_failed_watching: 'working',
  venue_failed_refund_pending: 'coming_back',
  short_fill: 'done',
};

export function plainStateOf(stage: ProposalStage, reason: ProposalReason | null): MoveState {
  return (reason === null ? undefined : STATE_OF_REASON[reason.code]) ?? moveStateOf(stage);
}

/* The engine's rules, as the cause a person reads. The last six are the app's own walls; any
   other rule on a money move is one of the person's, and on a policy change it is the app
   refusing the change as written. */
const RULE_REASON: Record<string, ReasonCode> = {
  max_per_transaction: 'over_trade_cap',
  max_per_session: 'over_daily_cap',
  kill_switch: 'kill_switch',
  policy_unreadable: 'rules_unreadable',
  invalid_amount: 'unpriced',
  invalid_draft: 'invalid_request',
  simulation_required: 'simulation_failed',
  no_rail: 'not_available',
  unknown_kind: 'invalid_request',
};

/* THE CAUSE, read off what decided the row: the verdict's code or rule for a refusal, the rail's
   code for an ending, and only then the status. A code the rail named wins; a row written before
   codes existed falls back to what its own fields can still prove. */
export function reasonCodeOf(p: Proposal, stage: ProposalStage): ReasonCode | null {
  switch (p.status) {
    case 'pending':
      return 'needs_approval';
    case 'refused':
      return 'declined';
    case 'policy_refused': {
      const named = (p.verdict.reasonCodes ?? []).find((c) => isReasonCode(c));
      if (named !== undefined && isReasonCode(named)) return named;
      const rule = p.verdict.outcome === 'refuse' ? p.verdict.rule : '';
      return RULE_REASON[rule] ?? (p.kind === 'policy_change' ? 'invalid_request' : 'policy_rule');
    }
    case 'failed': {
      if (isReasonCode(p.result?.reason)) return p.result.reason;
      if (p.result?.evidence?.providerStage === 'REFUNDED') return 'refunded';
      // No hash, handle or nonce is the executor's own proof nothing was sent (src/proposals/execute.ts).
      const evidence = p.result?.evidence;
      const sent = (p.result?.txids?.length ?? 0) > 0 || evidence?.handle !== undefined || evidence?.nonce !== undefined;
      return sent ? 'stuck_unknown' : 'not_sent';
    }
    case 'needs_reconciliation':
      if (isReasonCode(p.result?.reason)) return p.result.reason;
      // The venue's refund, reported and not yet shown in the balance.
      if (stage === 'REFUNDED') return 'venue_failed_refund_pending';
      // A FAILED with no balance read behind it proves nothing either way, and neither does a
      // row with no read at all; a row with the rail's read is settling and on its way.
      return stage === 'FAILED' || stage === 'stalled' || p.pocket === undefined ? 'stuck_unknown' : null;
    default:
      return null;
  }
}

// What a person calls a coin: NEAR, not wNEAR; a raw venue id is "that coin".
function plainSymbol(symbol: string): string {
  if (symbol.toUpperCase() === 'WNEAR') return 'NEAR';
  return symbol.includes(':') ? 'that coin' : symbol;
}

const NOUN: Record<string, string> = {
  swap: 'swap',
  hl_deposit: 'deposit',
  hl_withdraw: 'withdrawal',
  intents_send: 'send',
  intents_pay: 'payment',
  trade: 'trade',
  policy_change: 'change',
};

// Native bitcoin as the thing bought. Inside NEAR Intents nobody sells it today (R1, 2026-09-23).
function buysNativeBtc(draft: WriteDraft): boolean {
  return draft.kind === 'swap' && (draft.toChain.toLowerCase() === 'btc' || /btc\.omft\.near/i.test(draft.toSymbol));
}

/* How long a row waits on a signed transfer that can still run, in a person's words. A few minutes
   for the three this app signs now; a transfer 1Click signed for 72 hours says how long, never "a
   few minutes" over days. Unknown says until when rather than inventing a figure. */
export function watchWords(deadline: string | undefined, now: number): string {
  const left = Date.parse(deadline ?? '') - now;
  if (!Number.isFinite(left)) return 'until it can no longer run';
  if (left <= 15 * 60_000) return 'for a few minutes';
  const minutes = Math.round(left / 60_000);
  if (minutes < 90) return `until it can no longer run, in about ${minutes} minutes`;
  const hours = Math.round(left / 3_600_000);
  if (hours < 48) return `until it can no longer run, in about ${hours} hours`;
  return `until it can no longer run, in about ${Math.round(hours / 24)} days`;
}

/* ONE PLAIN SENTENCE PER CAUSE, and this is the only place any of them is written. Each says
   what happened, where the money is, and what the person can do, in words a person uses. What the
   row itself knows rides in `seen`: how long it still watches its signed transfer (watchWords) and
   what arrived against the floor on a short fill (arrivedOf). */
export type Seen = { watch?: string; arrived?: { amount: string; floor: string } | null };

export function reasonSentence(code: ReasonCode, draft: WriteDraft, seen: Seen = {}): string {
  const watch = seen.watch ?? 'for a few minutes';
  const sym = plainSymbol(symbolOf(draft)) || 'it';
  const to = plainSymbol(toSymbolOf(draft));
  const noun = NOUN[draft.kind] ?? 'move';
  const The = `The ${noun}`;
  switch (code) {
    case 'needs_approval':
      return 'This one waits for your OK. Nothing moves until you say yes.';
    case 'over_trade_cap':
      return "That's over your limit for one move, so nothing moved. Ask for less, or ask me to raise the limit; your limits are in Vault, under Policies.";
    case 'over_daily_cap':
      return 'That would go past your daily limit, so nothing moved. Try a smaller amount, or wait for the limit to free up.';
    case 'kill_switch':
      return "Everything is frozen, so nothing moved. Unfreeze it from the top bar when you're ready.";
    case 'policy_rule':
      return 'One of your rules stopped this, so nothing moved. Change it in Vault, under Policies, if you want it to go.';
    case 'rules_unreadable':
      return "Your rules couldn't be read, so nothing can move right now.";
    case 'unpriced':
      return `The app has no dollar price for ${sym} right now, so it can't check this against your limits. Nothing moved. Try again in a minute.`;
    case 'no_price':
      // No retry can ever price it, so the sentence names the coin that works (retry is false, below).
      if (buysNativeBtc(draft)) return "Bitcoin itself can't be held here, so nothing moved. Wrapped bitcoin (WBTC) tracks it one to one: ask for WBTC instead.";
      return `Nobody is offering a price for ${sym}${to !== '' && to !== sym ? ` to ${to}` : ''} right now, so nothing moved. Try again in a minute.`;
    case 'price_moved':
      return 'The price moved while we checked, so nothing happened and nothing moved. Ask again for a fresh price.';
    case 'insufficient_balance':
      return `You don't have that much ${sym}, so nothing moved. Check your balance, or ask to swap all of it.`;
    case 'balance_unread':
      return "Your balance couldn't be read just now, so nothing moved. Try again in a moment.";
    case 'below_minimum':
      return "That's under the smallest amount the swap service takes, so nothing moved. Try a bigger amount.";
    case 'unsupported_asset':
      return "The swap service doesn't offer that coin there, so nothing moved. Ask what can be swapped and pick from that.";
    case 'ambiguous_asset':
      return 'Two different coins go by that name, so nothing moved. Say which one you mean.';
    case 'simulation_failed':
      return "The last check before signing didn't pass, so nothing was signed and nothing moved. Try again in a minute.";
    case 'invalid_request':
      return "That couldn't be set up as asked, so nothing moved. The details say why.";
    case 'not_available':
      return "That kind of move isn't available here, so nothing moved.";
    case 'plan_exists':
      return `${sym} already has a live plan, so nothing new was placed. Change or cancel that plan first.`;
    case 'declined':
      return 'You said no. Nothing moved.';
    case 'not_sent':
      return `${The} didn't go through. Nothing left your balance.`;
    case 'venue_failed_nothing_moved':
      return `${The} didn't go through. Nothing left your balance.`;
    case 'venue_failed_watching':
      return `Still checking this ${noun}. Your ${sym} hasn't moved so far; I'm keeping an eye on it ${watch}.`;
    case 'venue_failed_refund_pending':
      return `${The} didn't go through. Your ${sym} is with the swap service until it comes back to your balance; the app keeps checking.`;
    case 'refunded':
      return `${The} didn't go through. The swap service sent your ${sym} back to your balance.`;
    case 'short_fill':
      return seen.arrived === undefined || seen.arrived === null
        ? `${The} went through, but less arrived than the minimum you approved. The details show how much.`
        : `${The} went through, but only ${seen.arrived.amount} ${to || 'of it'} arrived, less than the ${seen.arrived.floor} you approved.`;
    case 'stuck_unknown':
      return "Still checking whether this went through. I'll update it here.";
  }
}

/* Long ids, cut to their two ends the way the card cuts them (ui/screens/cards.js shortenIds):
   a 64-hex hash or handle, with or without 0x, and a base58 signature of 64 or more. An address
   is not a hash and stays whole (frozen rule 3): a 40-hex address, a Solana key, a NEAR name. */
export function shortIds(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{64}\b|\b[1-9A-HJ-NP-Za-km-z]{64,}\b/g, (id) => `${id.slice(0, 8)}...${id.slice(-8)}`);
}

const MAX_DETAILS = 600;

function detailsOf(p: Proposal): string | null {
  const raw = p.status === 'policy_refused' || p.status === 'pending' ? p.verdict.reasons.at(-1) : p.result?.detail;
  if (raw === undefined || raw.trim() === '') return null;
  const flat = shortIds(raw.replace(/\s+/g, ' ').trim());
  return flat.length > MAX_DETAILS ? `${flat.slice(0, MAX_DETAILS)}...` : flat;
}

const RETRYABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'no_price',
  'price_moved',
  'simulation_failed',
  'balance_unread',
  'unpriced',
  'not_sent',
  'venue_failed_nothing_moved',
  'refunded',
]);

function reasonOfRow(p: Proposal, stage: ProposalStage, now: number): ProposalReason | null {
  const code = reasonCodeOf(p, stage);
  if (code === null) return null;
  const sentence = reasonSentence(code, p.draft, { watch: watchWords(p.result?.evidence?.deadline, now), arrived: arrivedOf(p) });
  // Native bitcoin has no seller however often it is asked, so its no_price offers no Try again.
  const retry = RETRYABLE.has(code) && !(code === 'no_price' && buysNativeBtc(p.draft));
  return { code, sentence, details: code === 'declined' ? null : detailsOf(p), retry };
}

// What the rail's own reads say arrived, against the floor it was approved with, in the coin's units.
function arrivedOf(p: Proposal): { amount: string; floor: string } | null {
  const pocket = p.pocket;
  if (pocket === undefined || pocket.after === null || !/^\d+$/.test(pocket.before) || !/^\d+$/.test(pocket.after) || !/^\d+$/.test(pocket.floor)) return null;
  const delta = BigInt(pocket.after) - BigInt(pocket.before);
  if (delta <= 0n) return null;
  return { amount: baseUnitsToDecimal(delta, pocket.decimals), floor: baseUnitsToDecimal(BigInt(pocket.floor), pocket.decimals) };
}

// Late once a move still working has run past its usual time, counted from the click.
// A move the app is still checking is late by definition: the rail already gave up on its answer.
function lateOf(p: Proposal, state: MoveState, now: number, checking = false): { elapsedSec: number; typicalSec: number } | null {
  const typical = TYPICAL_SEC[p.kind] ?? 0;
  if (state !== 'working' || typical <= 0) return null;
  const elapsed = secondsBetween(p.decidedAt ?? p.createdAt, now);
  return elapsed > typical || checking ? { elapsedSec: elapsed, typicalSec: typical } : null;
}

// A duration in words: seconds under a minute and a half, minutes to the hour, then hours.
function durationWords(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  if (n < 90) return `${n} seconds`;
  const minutes = Math.round(n / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${hours} ${hours === 1 ? 'hour' : 'hours'} ${rest} minutes`;
}

function secondsBetween(from: string | undefined, now: number): number {
  const at = Date.parse(from ?? '');
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/* WHEN THIS ROW FLIPS ITSELF TO `stalled`, counted from the decision rather than from the ask.
   A proposal waiting for a person is not late however long it waits, so the clock starts when
   somebody decided and the app took the work on. Null for a policy change, which waits on
   nobody once it is clicked. */
export function deadlineAtOf(p: Proposal): string | null {
  const seconds = DEADLINE_SEC[p.kind] ?? null;
  if (seconds === null) return null;
  const from = Date.parse(p.decidedAt ?? p.createdAt);
  if (!Number.isFinite(from)) return null;
  return new Date(from + seconds * 1000).toISOString();
}

/* The two seams the builder reaches through, wired by createProposalService. They are
   injected rather than imported so this file stays the leaf every surface reads from: the
   card, the state payload, the agent's read and the evals all end here, and a module that
   pulled in the executor and the trade runner would not be that.

   `settle` is the whole of "the view self-settles". A row whose stage says the venue has not
   credited the money, read against a balance that says it has, is the two-sources-of-truth bug
   in one object, so the read drives the row forward instead of printing beside it. It signs
   nothing and sends nothing; the most it does is write a row the ledger already proved. */
export type ViewCtx = {
  settle: (p: Proposal) => Proposal;
  // A trade proposal's fate is its plan's, and the plan lives in the runner. Absent where no
  // runner is wired, which is demo mode and most tests.
  plan?: (p: Proposal) => PlanFate | null;
};

/* THE ONE OBJECT. proposal_status returns it, /api/state carries it, the card draws it, the
   agent narrates it. Everything on it is read off the row or off the tables above; nothing here
   phrases a second opinion about what the row means. */
export function proposalView(ctx: ViewCtx, row: Proposal, now: number = Date.now()): ProposalView {
  const p = ctx.settle(row);
  const stage = stageOf(p);
  const lastChangeAt = p.lastChangeAt ?? p.createdAt;
  const sinceChangeSec = secondsBetween(lastChangeAt, now);
  const pockets = pocketsOf(p.draft);
  const typical = TYPICAL_SEC[p.kind] ?? null;
  const reason = reasonOfRow(p, stage, now);
  const state = plainStateOf(stage, reason);
  // Where the cause chose the state, the cause's sentence is the copy, so the two cannot disagree.
  const byCause = reason !== null && (state === 'didnt_go_through' || STATE_OF_REASON[reason.code] !== undefined);
  /* AND WHEN IT ENDED, which a move still being checked or on its way back has not, whatever the
     venue's word: "Ended at" under "Still checking whether this went through" was two truths on one
     card (hunt B, #7). `terminal` keeps the stage's meaning: the app has stopped expecting the venue. */
  const ended = reason !== null && STATE_OF_REASON[reason.code] !== undefined ? state === 'done' || state === 'didnt_go_through' : TERMINAL.has(stage);
  return {
    id: p.id,
    kind: p.kind,
    sentence: sentenceOf(p.draft),
    changes: p.verdict.outcome === 'needs_approval' ? (p.verdict.changes ?? []) : [],
    stage,
    stageLabel: STAGE_LABEL[stage],
    // A move that did not go through says why in its own words, never the stage's stock line:
    // "A rule you set stopped it" was printed over every refusal, the app's own included.
    stageCopy: byCause && reason !== null ? reason.sentence : STAGE_COPY[stage],
    providerStage: p.result?.evidence?.providerStage ?? null,
    waitingOn: waitingOn(p, stage),
    terminal: TERMINAL.has(stage),
    settlesForward: stage === 'stalled',
    outcome: outcomeOf(p, ctx.plan?.(p) ?? null).state,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt ?? null,
    decidedBy: p.decidedBy === 'human' || p.decidedBy === 'policy' ? p.decidedBy : null,
    /* WHEN IT ENDED, and null while it has not. The row is stamped the moment the rail stops
       answering, which is BEFORE the venue has shown the money: a row in `crediting` carries a
       stamp and is not settled. The card prints this as "Confirmed at", so it read "Confirmed
       at 14:20" over a move the agent was still calling unfinished, which is the pair of clocks
       out of order from Karim's transcript. `stalled` carries none for the same reason: it
       settles forward, so it has not ended either. */
    settledAt: ended && stage !== 'stalled' ? (p.settledAt ?? null) : null,
    lastChangeAt,
    elapsedSec: secondsBetween(p.createdAt, now),
    sinceChangeSec,
    tookSec: ended && stage !== 'stalled' && p.settledAt !== undefined ? secondsBetween(p.createdAt, Date.parse(p.settledAt)) : null,
    typicalSec: typical === 0 ? null : typical,
    deadlineAt: deadlineAtOf(p),
    money: {
      symbol: symbolOf(p.draft),
      toSymbol: toSymbolOf(p.draft),
      amountIn: amountInOf(p.draft),
      feeUsd: feeUsdOf(p),
      amountOut: amountOutOf(p),
      fromPocket: pockets.from,
      toPocket: pockets.to,
      beforeUsd: p.balances?.beforeUsd ?? null,
      afterUsd: p.balances?.afterUsd ?? null,
    },
    txs: txsOf(p, stage),
    correlationId: p.result?.evidence?.quote?.correlationId ?? null,
    error: errorOf(p, stage, sinceChangeSec, reason),
    state,
    late: lateOf(p, state, now, reason?.code === 'stuck_unknown' || reason?.code === 'venue_failed_watching'),
    reason,
    note: state === 'done' && reason !== null ? reason.sentence : null,
  };
}
