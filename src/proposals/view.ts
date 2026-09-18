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
import type { Proposal, WriteDraft } from '../types.ts';

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
  stage: ProposalStage;
  stageLabel: string; // the one plain line both surfaces print. Never built twice.
  providerStage: string | null; // 1Click's raw word, null when no provider owns this phase
  waitingOn: string | null; // 'You', 'Touch ID', '1Click', 'Hyperliquid', null when terminal
  terminal: boolean;
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

// Where the money starts and where it lands, named as the two pockets a person holds plus the
// chain a payout leaves for. A policy change moves nothing, so both are null.
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
  }
}

function symbolOf(draft: WriteDraft): string {
  if (draft.kind === 'policy_change') return '';
  if (draft.kind === 'swap') return draft.fromSymbol;
  if (draft.kind === 'trade') return draft.op === 'open' ? draft.plan.symbol : 'USDC';
  return draft.symbol;
}

function amountInOf(draft: WriteDraft): string | null {
  if (draft.kind === 'policy_change' || draft.kind === 'trade') return null;
  return String(draft.kind === 'swap' ? draft.amountIn : draft.amount);
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
  const seconds = DEADLINE_SEC[p.kind];
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
  const typical = TYPICAL_SEC[p.kind];
  return {
    id: p.id,
    kind: p.kind,
    stage,
    stageLabel: STAGE_LABEL[stage],
    providerStage: p.result?.evidence?.providerStage ?? null,
    waitingOn: waitingOn(p, stage),
    terminal: TERMINAL.has(stage),
    outcome: outcomeOf(p, ctx.plan?.(p) ?? null).state,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt ?? null,
    settledAt: p.settledAt ?? null,
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
