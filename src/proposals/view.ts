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
import type { PolicyAxisChange, Proposal, WriteDraft } from '../types.ts';

// The app's own phases are lowercase. The provider's phases are 1Click's seven words, byte for
// byte off GetExecutionStatusResponse, because "settling" is a word nobody outside this app can
// check. INCOMPLETE_DEPOSIT is never folded into PROCESSING: partial money arrived.
export type ProposalStage =
  | 'waiting_for_you'
  | 'waiting_for_unlock'
  | 'waiting_for_touch'
  | 'signing'
  | 'submitting'
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED'
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
  settledAt: string | null;
  lastChangeAt: string; // when `stage` last changed, not when the row was last written
  elapsedSec: number; // now - createdAt
  sinceChangeSec: number; // now - lastChangeAt
  typicalSec: number | null;
  deadlineAt: string | null; // when this row flips itself to `stalled`; null for kinds with no deadline
  money: {
    symbol: string;
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
  error: { code: string; message: string } | null;
};

export const STAGE_LABEL: Record<ProposalStage, string> = {
  waiting_for_you: 'Waiting for you',
  waiting_for_unlock: 'Needs the unlock',
  waiting_for_touch: 'Touch ID',
  signing: 'Signing',
  submitting: 'Sending it',
  KNOWN_DEPOSIT_TX: 'Deposit seen',
  PENDING_DEPOSIT: 'Waiting for the deposit',
  INCOMPLETE_DEPOSIT: 'Part of it arrived',
  PROCESSING: 'The router is working',
  SUCCESS: 'The router is done',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
  crediting: 'Waiting for the venue to credit it',
  confirmed: 'Confirmed',
  failed: 'Failed',
  declined: 'Declined',
  refused: 'Refused',
  stalled: 'Late, nothing has changed',
};

export const TERMINAL: ReadonlySet<ProposalStage> = new Set<ProposalStage>([
  'confirmed',
  'failed',
  'declined',
  'refused',
  'stalled',
  'REFUNDED',
  'FAILED',
]);

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

// 1Click's seven words, as the vendor spells them. A word this app does not recognise is not
// printed as a stage: the row falls back to its own phase rather than showing a string the
// stage table has no label for.
const PROVIDER_STAGES: ReadonlySet<string> = new Set([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);

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
    case 'approved':
      return 'signing';
    case 'executing':
      return provider !== undefined && PROVIDER_STAGES.has(provider) ? (provider as ProposalStage) : 'submitting';
    /* The router being done is not the venue having credited the money, and the gap between
       those two facts is the transcript this file exists to close. So SUCCESS on an open row
       reads `crediting`, which names what is actually being waited on; every other 1Click word
       still describes the router's own work and is passed through as the vendor spells it. */
    case 'needs_reconciliation':
      if (p.stalledAt !== undefined) return 'stalled';
      if (provider !== undefined && provider !== 'SUCCESS' && PROVIDER_STAGES.has(provider)) return provider as ProposalStage;
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
    case 'signing':
      return 'The wallet';
    case 'crediting':
      return p.kind === 'hl_deposit' ? 'Hyperliquid' : 'NEAR Intents';
    default:
      // submitting and every 1Click word: the router is the thing that has not answered.
      return p.kind === 'trade' ? 'Hyperliquid' : '1Click';
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

function amountInOf(draft: WriteDraft): string | null {
  if (draft.kind === 'policy_change' || draft.kind === 'trade') return null;
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
    case 'swap':
      return `${moved(draft)} to ${draft.toSymbol} inside NEAR Intents`;
    case 'intents_send':
      return `${moved(draft)} from NEAR Intents to ${draft.to}, inside NEAR Intents`;
    case 'intents_pay':
      return `${moved(draft)} from NEAR Intents to ${draft.to}, on ${draft.network}`;
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
   human declining is not an error and gets none: they decided, and the row says so. */
function errorOf(p: Proposal, stage: ProposalStage, sinceChangeSec: number): { code: string; message: string } | null {
  const detail = p.result?.detail ?? '';
  if (stage === 'stalled') {
    return {
      code: 'deadline_passed',
      message:
        `Nothing has changed since ${p.lastChangeAt ?? p.createdAt}, which is ${sinceChangeSec} seconds. ` +
        `${waitingOn(p, 'crediting') ?? 'The venue'} has not answered.`,
    };
  }
  if (stage === 'refused') return { code: p.verdict.outcome === 'refuse' ? p.verdict.rule : 'policy_refused', message: p.verdict.reasons.at(-1) ?? 'The policy refused it.' };
  if (stage === 'failed') return { code: 'rail_failed', message: detail };
  if (stage === 'FAILED') return { code: 'provider_failed', message: detail };
  if (stage === 'REFUNDED') return { code: 'refunded', message: detail };
  return null;
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
  return {
    id: p.id,
    kind: p.kind,
    sentence: sentenceOf(p.draft),
    changes: p.verdict.outcome === 'needs_approval' ? (p.verdict.changes ?? []) : [],
    stage,
    stageLabel: STAGE_LABEL[stage],
    providerStage: p.result?.evidence?.providerStage ?? null,
    waitingOn: waitingOn(p, stage),
    terminal: TERMINAL.has(stage),
    settlesForward: stage === 'stalled',
    outcome: outcomeOf(p, ctx.plan?.(p) ?? null).state,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt ?? null,
    /* WHEN IT ENDED, and null while it has not. The row is stamped the moment the rail stops
       answering, which is BEFORE the venue has shown the money: a row in `crediting` carries a
       stamp and is not settled. The card prints this as "Confirmed at", so it read "Confirmed
       at 14:20" over a move the agent was still calling unfinished, which is the pair of clocks
       out of order from Karim's transcript. `stalled` carries none for the same reason: it
       settles forward, so it has not ended either. */
    settledAt: TERMINAL.has(stage) && stage !== 'stalled' ? (p.settledAt ?? null) : null,
    lastChangeAt,
    elapsedSec: secondsBetween(p.createdAt, now),
    sinceChangeSec,
    typicalSec: typical === 0 ? null : typical,
    deadlineAt: deadlineAtOf(p),
    money: {
      symbol: symbolOf(p.draft),
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
    error: errorOf(p, stage, sinceChangeSec),
  };
}
