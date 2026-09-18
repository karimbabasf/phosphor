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

import type { WriteDraft } from '../types.js';
import type { OutcomeState } from './lifecycle.js';

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
