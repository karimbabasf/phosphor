// The sentence in the Touch ID dialog, composed from a proposal's structured fields and
// nothing else.
//
// The dialog is the last thing the person reads before the enclave releases the key, and it
// is drawn by the operating system where no page can cover it. That makes it the one honest
// description of what the click does, and it stays honest only if no agent-authored sentence
// can reach it: a draft's `summary` is rendered in the window, a policy change carries a
// `sentence`, and a plan has a name, and none of those appear here. Amounts are numbers the
// app priced; chains are enum values; a symbol is one of two agent-chosen strings that survive,
// and it survives only when it is shaped like a ticker (see clean). The other is the receiver
// of a send (see shortAddress), because a dialog that approves a payment and hides who is paid
// is the dialog Karim asked never to see: it is shown shortened, and only when it is shaped
// like an address.

import type { Proposal, WriteDraft } from '../types.ts';
import { spendNetworkOf } from '../rails/intents-address.ts';

const MAX_REASON = 120;

function amount(n: unknown, symbol: string): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return `some ${clean(symbol)}`;
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 6;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ${clean(symbol)}`;
}

function usd(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'an unpriced amount';
  return `$${n.toLocaleString('en-US', n >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/* The receiver of a send, shortened to its two ends. The address is the one field on a send
   the agent chose, and it reaches the dialog because the dialog is the last place a person can
   see where the money goes; it reaches it only when it is shaped like an address (hex, base58
   or a NEAR id), so an agent-authored sentence in that field is said as "an address".
   Eight characters each end: six and four was forty bits of hex, which a vanity generator
   matches in minutes, so a substituted address could read the same in the dialog as the one on
   the card. Sixteen is beyond that reach, and the card still shows the whole address. */
const ADDRESS_SHAPE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/;
const END_CHARS = 8;

function shortAddress(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!ADDRESS_SHAPE.test(s)) return 'an address';
  return s.length <= 2 * END_CHARS + 4 ? s : `${s.slice(0, END_CHARS)}...${s.slice(-END_CHARS)}`;
}

/* The chain a payout lands on, by name and only from the chain registry: a network id the
   registry does not know is said as "a chain", never echoed. The registry is a table in this
   repo, which is the property that matters here: nothing an agent typed reaches this dialog as
   a chain name. */
function networkName(raw: unknown): string {
  return spendNetworkOf(String(raw))?.name ?? 'a chain';
}

function describe(draft: WriteDraft): string {
  switch (draft.kind) {
    case 'swap':
      return `Swap ${amount(draft.amountIn, draft.fromSymbol)} to ${clean(draft.toSymbol)} (${usd(draft.amountUsd)})`;
    case 'intents_send':
      return `Send ${amount(draft.amount, draft.symbol)} inside NEAR Intents to ${shortAddress(draft.to)} (${usd(draft.amountUsd)})`;
    case 'intents_pay':
      return `Pay ${amount(draft.amount, draft.symbol)} to ${shortAddress(draft.to)} on ${networkName(draft.network)} (${usd(draft.amountUsd)})`;
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
