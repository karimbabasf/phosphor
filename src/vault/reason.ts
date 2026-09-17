// The sentence in the Touch ID dialog, composed from a proposal's structured fields and
// nothing else.
//
// The dialog is the last thing the person reads before the enclave releases the key, and it
// is drawn by the operating system where no page can cover it. That makes it the one honest
// description of what the click does, and it stays honest only if no agent-authored sentence
// can reach it: a draft's `summary` is rendered in the window, a policy change carries a
// `sentence`, and a plan has a name, and none of those appear here. Amounts are numbers the
// app priced; chains are enum values; a symbol is the one agent-chosen word that survives,
// and it survives only when it is shaped like a ticker (see clean).

import type { Proposal, WriteDraft } from '../types.ts';

const MAX_REASON = 120;

function amount(n: unknown, symbol: string): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return `some ${clean(symbol)}`;
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 6;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ${clean(symbol)}`;
}

function usd(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'an unpriced amount';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

/* A symbol or chain id is an agent-chosen string until the rail refuses it, and the pen test
   put ATTACKER-CON through the swap grammar. So only a ticker-shaped word reaches the dialog:
   two to eight capitals or digits, which is what every asset this app knows looks like, and
   anything else is said as "a token". A dialog that names the wrong token is still a dialog
   that names an amount, a venue and a direction the agent cannot alter. */
function clean(s: string): string {
  const upper = String(s).toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(upper) ? upper : 'a token';
}

function describe(draft: WriteDraft): string {
  switch (draft.kind) {
    case 'swap':
      return `Swap ${amount(draft.amountIn, draft.fromSymbol)} to ${clean(draft.toSymbol)} (${usd(draft.amountUsd)})`;
    case 'intents_deposit':
      return `Deposit ${amount(draft.amount, draft.symbol)} from ${clean(draft.chain)} into NEAR Intents (${usd(draft.amountUsd)})`;
    case 'intents_withdraw':
      return `Withdraw ${amount(draft.amount, draft.symbol)} from NEAR Intents to ${clean(draft.chain)} (${usd(draft.amountUsd)})`;
    case 'intents_send':
      return `Send ${amount(draft.amount, draft.symbol)} inside NEAR Intents to another account (${usd(draft.amountUsd)})`;
    case 'hl_deposit':
      return `Move ${amount(draft.amount, draft.symbol)} into Hyperliquid (${usd(draft.amountUsd)})`;
    case 'hl_withdraw':
      return `Withdraw ${amount(draft.amount, draft.symbol)} out of Hyperliquid (${usd(draft.amountUsd)})`;
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
