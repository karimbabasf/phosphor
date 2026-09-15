// The sentence in the Touch ID dialog, composed from a proposal's structured fields and
// nothing else.
//
// The dialog is the last thing the person reads before the enclave releases the key, and it
// is drawn by the operating system where no page can cover it. That makes it the one honest
// description of what the click does, and it stays honest only if no agent-authored string can
// reach it: a draft's `summary` is rendered in the window, a policy change carries a
// `sentence`, and a plan has a name, and none of those appear here. Amounts, symbols, chains
// and venues are numbers and enum values the app set when it built the draft.

import type { Proposal, WriteDraft } from '../types.ts';

const MAX_REASON = 120;

function amount(n: number, symbol: string): string {
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 6;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ${clean(symbol)}`;
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

/* Symbols and chain ids are app-set enum values, but they are still strings, so they are
   reduced to the characters a ticker can carry before they reach a system dialog. */
function clean(s: string): string {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12) || '?';
}

function describe(draft: WriteDraft): string {
  switch (draft.kind) {
    case 'swap':
      return `Swap ${amount(draft.amountIn, draft.fromSymbol)} to ${clean(draft.toSymbol)} (${usd(draft.amountUsd)})`;
    case 'intents_deposit':
      return `Deposit ${amount(draft.amount, draft.symbol)} from ${clean(draft.chain)} into NEAR Intents (${usd(draft.amountUsd)})`;
    case 'intents_withdraw':
      return `Withdraw ${amount(draft.amount, draft.symbol)} from NEAR Intents to ${clean(draft.chain)} (${usd(draft.amountUsd)})`;
    case 'hl_deposit':
      return `Move ${amount(draft.amount, draft.symbol)} into Hyperliquid (${usd(draft.amountUsd)})`;
    case 'hl_withdraw':
      return `Withdraw ${amount(draft.amount, draft.symbol)} out of Hyperliquid (${usd(draft.amountUsd)})`;
    case 'consolidate':
      return `Consolidate ${clean(draft.symbol)} onto ${clean(draft.toChain)} (${usd(draft.totalUsd)})`;
    case 'transfer':
      return `Transfer ${amount(draft.leg.amount, draft.leg.symbol)} (${usd(draft.leg.amountUsd)})`;
    case 'policy_change':
      return 'Change the policy that limits what the agent may do';
    case 'trade':
      return draft.op === 'open'
        ? `Arm a trade on Hyperliquid risking ${usd(draft.amountUsd)}`
        : draft.cancel === true
          ? 'Cancel an armed trade on Hyperliquid'
          : draft.close === true
            ? 'Close a position on Hyperliquid'
            : 'Change an armed trade on Hyperliquid';
  }
}

export function reasonFor(proposal: Pick<Proposal, 'draft'>): string {
  return `Approve: ${describe(proposal.draft)}`.slice(0, MAX_REASON);
}

export const UNLOCK_REASON = 'Open your Phosphor vault';
export const REVEAL_REASON = 'Reveal your recovery phrase';
export const CREATE_REASON = 'Confirm your new Phosphor wallet';
export const MIGRATE_REASON = 'Move your wallet behind the Secure Enclave';
export const RESTORE_REASON = 'Restore a wallet from its recovery phrase';
export const FORGET_REASON = 'Forget this wallet on this Mac';
export const ADDRESS_REASON = 'Show your deposit address';
