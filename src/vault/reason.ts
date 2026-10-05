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
// is the dialog Karim asked never to see: it is shown shortened (a NEAR name whole), and only
// when it is shaped like an address (a payout's, when it decodes as an address on the chain it
// lands on).

import type { Proposal, WriteDraft } from '../types.ts';
import { spendNetworkOf } from '../rails/intents-address.ts';
import { payAddress } from '../rails/pay-rules.ts';
import { APPROVE_AGENT_TYPES, HL_DOMAIN, HL_USDC_TOKEN, SEND_ASSET_TYPES, USD_CLASS_TRANSFER_TYPES } from '../rails/hl-user-signed.ts';

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
   Eight characters each end, after the prefix every address of its kind shares: six and four
   was forty bits of hex, which a vanity generator matches in minutes, so a substituted address
   could read the same in the dialog as the one on the card. Sixteen is beyond that reach, and
   the card still shows the whole address. */
const ADDRESS_SHAPE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/;
const END_CHARS = 8;

/* The characters every address of its kind starts with, by payout family: they say whose chain
   it is, never whose account, so the ends are counted after them and a vanity generator gets no
   free characters. Each is only characters made wholly of fixed bits: the version byte of a
   base58 address makes its first character (T, r, D, X, 1, 3), a Stellar key's makes its G, a
   TON address's flag and workchain make UQ, a segwit address carries its witness version in the
   character after bc1, and a CashAddr or Cardano header's top five bits are the character after
   bitcoincash: or addr1. ui/screens/cards.js keeps the same table for the card's groups. */
const FIXED_PREFIX: Readonly<Record<string, RegExp>> = {
  evm: /^0x/,
  move: /^0x/,
  starknet: /^0x/,
  near: /^0x(?=[0-9a-f]{40}$)/, // an eth-implicit id; a name is said whole (nearName)
  tron: /^T/,
  xrp: /^r/,
  stellar: /^G/,
  ton: /^[UE]Q/,
  btc: /^(bc1[a-z0-9]|[13])/,
  ltc: /^(ltc1[a-z0-9]|[LM3])/,
  doge: /^[DA]/,
  dash: /^[X7]/,
  bch: /^bitcoincash:[a-z0-9]/,
  cardano: /^addr1[a-z0-9]/,
};

// With no chain to go by (a send inside NEAR Intents): a 0x, or a prefix that names the chain.
const ANY_PREFIX = /^0x(?=[0-9a-fA-F]{40,}$)|^[a-z]+:(?=[a-z0-9]{20,}$)/;

/* A Cardano base address is addr1, a header, the 28-byte payment key hash, a 28-byte stake key
   hash and a checksum. The money answers to the payment key alone, and the stake half can be any
   28 bytes, so its last characters and the checksum after them are ground to order in minutes
   (review H1, 2026-09-27). Sixteen characters from the payment half are 77 bits that are not. */
const CARDANO_HEAD = 16;

/* A NEAR name is said whole, however long: anyone can register one for a fraction of a NEAR and
   choose both of its ends, so alice-bu...unt.near named a registered imitation as well as the real
   account (review V1, 2026-09-27). Only an id that is a key's hash, implicit (64 hex) or
   eth-implicit (0x and 40 hex), is shortened like every other hash. NEAR caps an id at 64
   characters, and reasonFor never cuts inside the receiver. */
const NEAR_NAME = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

function nearName(s: string): boolean {
  return NEAR_NAME.test(s) && !/^[0-9a-f]{64}$/.test(s) && !/^0x[0-9a-f]{40}$/.test(s);
}

function ends(s: string, family?: string): string {
  // With no chain to go by, the receiver is an intents account: an EVM address or a NEAR id.
  if ((family === undefined || family === 'near') && nearName(s)) return s;
  const rule = family === undefined ? ANY_PREFIX : FIXED_PREFIX[family];
  const prefix = rule?.exec(s)?.[0] ?? '';
  const head = family === 'cardano' ? CARDANO_HEAD : END_CHARS;
  const body = s.slice(prefix.length);
  return body.length <= head + END_CHARS + 4 ? s : `${prefix}${body.slice(0, head)}...${body.slice(-END_CHARS)}`;
}

function shortAddress(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!ADDRESS_SHAPE.test(s)) return 'an address';
  return ends(s);
}

/* A payout's receiver, shaped by the chain it lands on rather than by one pattern for all: an
   XRP, Stellar, TON, Cardano or Bitcoin Cash address is none of hex, base58 of 32 to 44 or a NEAR
   id, and a dialog that said "an address" for every one of them hid who is paid. It reaches the
   dialog only when it decodes as that chain's payout address and is the spelling the draft
   carries, so a sentence in the field is still said as "an address". */
function payee(network: unknown, raw: unknown): string {
  const s = String(raw ?? '').trim();
  const checked = payAddress(String(network), s);
  return checked.ok && checked.to === s ? ends(s, spendNetworkOf(String(network))?.pay ?? '') : shortAddress(s);
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
      return `Pay ${amount(draft.amount, draft.symbol)} to ${payee(draft.network, draft.to)} on ${networkName(draft.network)} (${usd(draft.amountUsd)})`;
    case 'hl_deposit':
      return `Move ${amount(draft.amount, draft.symbol)} into Hyperliquid (${usd(draft.amountUsd)})`;
    case 'hl_withdraw':
      return `Withdraw ${amount(draft.amount, draft.symbol)} out of Hyperliquid (${usd(draft.amountUsd)})`;
    case 'policy_change':
      return 'Change the policy that limits what the agent may do';
    // Never asked as an approval: the vault service writes a top-up's sentence (src/vault/chip.ts).
    case 'vault_top_up':
      return `Move ${clean(draft.amount)} ${clean(draft.symbol)} from your vault to your allowance (${usd(draft.amountUsd)})`;
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

// The receiver as describe names it, on the two drafts that name one.
function receiver(draft: WriteDraft): string | null {
  if (draft.kind === 'intents_pay') return payee(draft.network, draft.to);
  if (draft.kind === 'intents_send') return shortAddress(draft.to);
  return null;
}

/* The cap is this app's own: the enclave helper hands the sentence to LocalAuthentication as it
   is (src-tauri/se-helper/main.swift), which sets no length. It never cuts inside the receiver:
   a name cut short is a name an attacker can finish, and a large amount of a cheap token with a
   long symbol would push a 64-character name past it. Nothing before the receiver holds " to ". */
export function reasonFor(proposal: Pick<Proposal, 'draft'>): string {
  const said = `Approve: ${describe(proposal.draft)}`;
  const to = receiver(proposal.draft);
  const at = to === null ? -1 : said.indexOf(` to ${to}`);
  return said.slice(0, Math.max(MAX_REASON, at === -1 || to === null ? 0 : at + 4 + to.length));
}

/* ONE TOUCH, ONE HYPERLIQUID OWNER ACTION, AND THE DIALOG SAYS WHICH. Once a vault has moved to the
   chip, the owner key opens for a single Hyperliquid signature behind a Touch ID of its own
   (src/rails/hl-user-signed.ts, OwnerTouch). Its sentence is read off the typed data that very
   signature covers, never off a draft or anybody's words, the way the vault service writes the
   chip's sentence from the payload it signs. Only the three shapes this app builds are read, field
   for field, on mainnet, in USDC; anything else, or a sentence over the cap, is null, and then
   nothing is asked and nothing is signed. */
export function ownerReason(typed: unknown): string | null {
  if (!exactly(typed, ['domain', 'types', 'primaryType', 'message'])) return null;
  const { domain, types, primaryType, message } = typed;
  if (!exactly(domain, ['name', 'version', 'chainId', 'verifyingContract'])) return null;
  for (const key of ['name', 'version', 'chainId', 'verifyingContract'] as const) {
    if (domain[key] !== HL_DOMAIN[key]) return null;
  }
  const fields = typeof primaryType === 'string' ? ownerFields(primaryType) : null;
  if (fields === null || !exactly(types, [primaryType as string]) || !sameFields(types[primaryType as string], fields)) return null;
  if (!exactly(message, fields.map((f) => f.name)) || message.hyperliquidChain !== 'Mainnet' || !isNonce(message.nonce)) return null;

  let said: string;
  switch (primaryType) {
    case 'HyperliquidTransaction:SendAsset': {
      const { destination, sourceDex, destinationDex, token, amount, fromSubAccount } = message;
      if (typeof destination !== 'string' || !/^0x[0-9a-f]{40}$/.test(destination)) return null;
      if (!isDex(sourceDex) || !isDex(destinationDex) || token !== HL_USDC_TOKEN || fromSubAccount !== '' || !isAmount(amount)) return null;
      said = `Send ${usdcExact(amount)} USDC from your Hyperliquid account to ${ends(destination, 'evm')}`;
      break;
    }
    case 'HyperliquidTransaction:UsdClassTransfer': {
      const { amount, toPerp } = message;
      if (!isAmount(amount) || typeof toPerp !== 'boolean') return null;
      said = `Move ${usdcExact(amount)} USDC from ${toPerp ? 'spot to perp' : 'perp to spot'} in your Hyperliquid account`;
      break;
    }
    default: {
      const { agentAddress, agentName } = message;
      if (typeof agentAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) return null;
      // Signed and never shown: a label on the venue's list of agents, so it is held to a label's shape.
      if (typeof agentName !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(agentName)) return null;
      said = `Let ${ends(agentAddress.toLowerCase(), 'evm')} trade on your Hyperliquid account`;
    }
  }
  return said.length <= MAX_REASON ? said : null;
}

// The field table for each owner action, from the module that signs it. Read when asked, never at load.
function ownerFields(primaryType: string): ReadonlyArray<{ name: string; type: string }> | null {
  switch (primaryType) {
    case 'HyperliquidTransaction:SendAsset':
      return SEND_ASSET_TYPES[primaryType];
    case 'HyperliquidTransaction:UsdClassTransfer':
      return USD_CLASS_TRANSFER_TYPES[primaryType];
    case 'HyperliquidTransaction:ApproveAgent':
      return APPROVE_AGENT_TYPES[primaryType];
    default:
      return null;
  }
}

function exactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function sameFields(given: unknown, want: ReadonlyArray<{ name: string; type: string }>): boolean {
  return Array.isArray(given) && given.length === want.length && given.every((f, i) => exactly(f, ['name', 'type']) && f.name === want[i].name && f.type === want[i].type);
}

// A uint64, as the builders write it: a bigint.
function isNonce(value: unknown): boolean {
  return typeof value === 'bigint' && value > 0n && value < 2n ** 64n;
}

function isDex(value: unknown): boolean {
  return value === '' || value === 'spot';
}

// The decimal string toAmountString writes: no sign, no exponent, at most six places, no zero at
// either end that changes nothing, and never zero itself.
function isAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,20})(\.\d{0,5}[1-9])?$/.test(value) && value !== '0';
}

// Exact, grouped, and never fewer than two places, as the chip's own sentences write money:
// "8" is 8.00, "1234.5" is 1,234.50, "8.209399" stays 8.209399.
function usdcExact(amount: string): string {
  const [whole, frac = ''] = amount.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0')}`;
}

export const UNLOCK_REASON = 'Open your Phosphor vault';
export const REVEAL_REASON = 'Reveal your recovery phrase';
export const KEY_REASON = 'Reveal your private key';
export const CREATE_REASON = 'Confirm your new Phosphor wallet';
export const MIGRATE_REASON = 'Move your wallet behind the Secure Enclave';
export const RESTORE_REASON = 'Restore a wallet from its recovery phrase';
export const RESTORE_KEY_REASON = 'Restore a wallet from its private key';
export const FORGET_REASON = 'Forget this wallet on this Mac';
export const BIND_REASON = 'Make your wallet Phosphor-only on this Mac';
export const ADDRESS_REASON = 'Show your deposit address';
