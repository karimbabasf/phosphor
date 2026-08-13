// The set of draft kinds a rail owns, and nothing else.
//
// This is a separate module from the registry on purpose, and the reason is a bug that has
// now been paid for twice from opposite directions.
//
// The registry (./index.ts) constructs rails, so it imports uniswap, oneclick, the intents
// rails, the mandate rail and the deployment tables, and through them config, RPC hosts and
// ABIs. The policy engine must not pull any of that in: it is the part that decides whether
// money is allowed to move, and it stays loadable and testable on its own.
//
// So the list lived in both places. Adding a rail then meant editing two lists, and the day
// someone edited one the type still accepted the draft (it matches structurally) while the
// guard rejected it. The draft fell past the rail branch, found no legs, and was refused as
// 'nothing_to_move': a refusal whose stated reason had nothing to do with the real cause.
// The value checked was not the value used, which is the shape of every real bug in this
// build.
//
// One list, in a file that imports no runtime code, so both sides can have it.
import type {
  HlDepositDraft,
  IntentsDepositDraft,
  IntentsWithdrawDraft,
  LpAddDraft,
  LpRemoveDraft,
  MandateDraft,
  SwapDraft,
  WriteDraft,
} from '../types.ts';

export type RailKind =
  | 'swap'
  | 'hl_deposit'
  | 'intents_deposit'
  | 'intents_withdraw'
  | 'lp_add'
  | 'lp_remove'
  | 'mandate_arm';

export type RailDraft =
  | SwapDraft
  | HlDepositDraft
  | IntentsDepositDraft
  | IntentsWithdrawDraft
  | LpAddDraft
  | LpRemoveDraft
  | MandateDraft;

export const RAIL_KINDS: readonly RailKind[] = [
  'swap',
  'hl_deposit',
  'intents_deposit',
  'intents_withdraw',
  'lp_add',
  'lp_remove',
  'mandate_arm',
];

export function isRailKind(kind: WriteDraft['kind']): kind is RailKind {
  return (RAIL_KINDS as readonly string[]).includes(kind);
}

export function isRailDraft(draft: WriteDraft): draft is RailDraft {
  return isRailKind(draft.kind);
}
