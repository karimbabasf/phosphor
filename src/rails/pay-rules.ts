// The rules a payout obeys on the chains past EVM, Solana and NEAR, each one a refusal before a
// quote is asked for and again before the key is touched (src/rails/intents-pay.ts runs them).
//
// WHY A PAYOUT CARRIES NO MEMO. 1Click's quote request has no memo, destination tag or comment
// field at all (checked against its OpenAPI on 2026-09-26), so nothing this app signs can put one
// on the far side. On the XRP Ledger, Stellar and TON an exchange tells one customer's deposit
// from another's by that memo, so a payout to an exchange deposit address lands in nobody's
// account. Every rule here that names a memo exists because of that one missing field.
//
// WHAT IS PURE AND WHAT IS READ. The address rules (payAddress) are pure: a form 1Click would not
// echo, or one that carries a memo inside it, is refused by name, and a TON address is respelt as
// the same account non-bounceable. The account rules (payChecks) take what the chains said: the
// chain reader's answer about the receiver, the ledger's own rules for it on XRPL and Stellar
// (src/chainscan/destination.ts), and the bridge's deposit address for our own account. A fact
// the chain would not give, on a path where money could be lost, is a refusal, never a pass.

import { crc16 } from '../chainscan/codec.ts';
import { validateAddressForFamily } from '../chainscan/networks.ts';
import type { AddressActivity } from '../chainscan/common.ts';
import type { PayTarget } from '../chainscan/destination.ts';
import { spendNetworkOf } from './intents-address.ts';

// The chains where a deposit to an exchange is told apart by a memo, tag or comment.
export const MEMO_CHAINS: ReadonlySet<string> = new Set(['xrp', 'stellar', 'ton']);

// The two ledgers whose accounts carry rules the chain reader does not report.
export function needsTarget(network: string): boolean {
  return network === 'xrp' || network === 'stellar';
}

/* The chains where our own bridge deposit address is asked for before a payout: every chain
   this rule set covers. On a memo chain it may be the one address the bridge shares with
   everybody; on the rest it is a round trip, and the card says so. */
export function readsOwnDeposit(network: string): boolean {
  const pay = spendNetworkOf(network)?.pay;
  return pay !== undefined && pay !== null && pay !== 'evm' && pay !== 'sol' && pay !== 'near';
}

function labelOf(network: string): string {
  return spendNetworkOf(network)?.name ?? network;
}

// ---------- the address ----------

export type PayAddress =
  | { ok: true; to: string; checksum: 'valid' | 'lowercase' | null; given: string | null }
  | { ok: false; reason: string };

const TON_RAW = /^(0|-1):([0-9a-f]{64})$/;

type TonAccount = { flag: number | null; workchain: number; hash: Buffer };

function tonAccount(value: string): TonAccount | null {
  const raw = TON_RAW.exec(value.toLowerCase());
  if (raw !== null) return { flag: null, workchain: Number(raw[1]), hash: Buffer.from(raw[2], 'hex') };
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 36) return null;
  return { flag: bytes[0], workchain: bytes[1] === 0xff ? -1 : bytes[1], hash: bytes.subarray(2, 34) };
}

/* The user-friendly form with the non-bounceable flag (0x51), url-safe, which is how a wallet
   writes "UQ...". A bounceable transfer to a wallet that has never been deployed comes back to
   the sender, and the sender here is a bridge that may not take it back. */
function tonNonBounceable(account: TonAccount): string {
  const body = Buffer.concat([Buffer.from([0x51, account.workchain === -1 ? 0xff : account.workchain]), account.hash]);
  const crc = crc16(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff])]).toString('base64url');
}

/* The receiver as the payout will send it, or the reason it will not. Decoded by the family's
   own decoder (src/chainscan/networks.ts validateAddressForFamily), which refuses and never
   repairs; the rules before it refuse a form that decodes but cannot be paid. */
export function payAddress(network: string, raw: string): PayAddress {
  const net = spendNetworkOf(network);
  const label = labelOf(network);
  if (net === undefined || net.pay === null) return { ok: false, reason: `this app does not pay out on ${label}` };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (network === 'xrp' && /^[XT][1-9A-HJ-NP-Za-km-z]{46}$/.test(value)) {
    return { ok: false, reason: 'this is an X-address, which carries a destination tag inside it, and Phosphor cannot send a tag, so it would be dropped; ask for the classic r... address, and only one that needs no tag' };
  }
  if (network === 'stellar' && /^M[A-Z2-7]{68}$/.test(value)) {
    return { ok: false, reason: 'this is a muxed M... address, which carries a memo id inside it, and Phosphor cannot send a memo, so it would be dropped; ask for the plain G... address, and only one that needs no memo' };
  }
  if (network === 'doge' && /^9/.test(value)) {
    return { ok: false, reason: 'the payout service refuses Dogecoin addresses that start with 9 (it refused one on 2026-09-26), so this one cannot be paid; ask for a D... or A... address' };
  }
  if (network === 'bch' && /^[13]/.test(value)) {
    return {
      ok: false,
      reason:
        'a legacy 1... or 3... address is also a Bitcoin address, and Bitcoin Cash sent to a Bitcoin wrapped segwit address can be taken by anyone; ask for the bitcoincash:q... form of the address',
    };
  }
  if (network === 'starknet' && !/^0x[0-9a-fA-F]{64}$/.test(value) && /^0x[0-9a-fA-F]{1,63}$/.test(value)) {
    return { ok: false, reason: 'a Starknet payout needs the address written out in full, 64 hex characters after 0x with its leading zeros; a shorter one is not padded here, because a dropped digit and a missing zero look the same' };
  }
  if (network === 'ton') {
    const account = tonAccount(value);
    if (account !== null && account.flag !== null && (account.flag & 0x80) !== 0) {
      return { ok: false, reason: 'this is a testnet TON address (its testnet flag is set), and a mainnet payout to it would not reach the wallet meant' };
    }
    if (account !== null && account.workchain === -1) {
      return { ok: false, reason: 'this TON address is on the masterchain (workchain -1), where wallets do not live; ask for the UQ... address' };
    }
  }
  const checked = validateAddressForFamily(net.pay, value, label);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  if (network !== 'ton') return { ok: true, to: checked.normalized, checksum: checked.checksum ?? null, given: null };
  const account = tonAccount(checked.normalized);
  if (account === null) return { ok: false, reason: 'not a TON address: it does not decode to an account' };
  const to = tonNonBounceable(account);
  // A bounceable or raw spelling is respelt, and the card names both; a non-bounceable one sent
  // in standard base64 is only re-encoded, the same flag and the same bytes.
  const respelt = account.flag === null || account.flag !== 0x51;
  return { ok: true, to, checksum: checked.checksum ?? null, given: respelt ? value : null };
}

// Whether two spellings on one chain name one account: a TON account by its bytes, hex by value.
export function sameAccount(network: string, a: string, b: string): boolean {
  if (network === 'ton') {
    const x = tonAccount(a);
    const y = tonAccount(b);
    return x !== null && y !== null && x.workchain === y.workchain && x.hash.equals(y.hash);
  }
  if (/^0x[0-9a-f]+$/i.test(a) && /^0x[0-9a-f]+$/i.test(b)) return BigInt(a) === BigInt(b);
  if (network === 'bch' || network === 'cardano' || /^(bc1|ltc1)/i.test(a)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// ---------- what the card and the agent are told ----------

export type PayNote = { text: string; tone: 'warn' | 'info' };

export function memoCaution(network: string): PayNote | null {
  if (!MEMO_CHAINS.has(network)) return null;
  return { tone: 'warn', text: `${labelOf(network)}: exchanges often need a memo or tag here; Phosphor cannot attach one, so do not send to an exchange deposit address.` };
}

// ---------- the account ----------

export type OwnDeposit = { address: string; memo: string | null };

export type PayFacts = {
  network: string;
  symbol: string;
  native: boolean; // the chain's own coin
  issuer: string | null; // the token's contract or issuer on the chain, null for the coin
  amount: number; // what leaves the balance
  minReceived: number; // the least that arrives, the floor the rail holds the quote to
  to: string;
  given: string | null; // the spelling the caller gave, when the payout sends another of the same account
  activity: AddressActivity | null; // the chain reader's answer about the receiver
  target: PayTarget | null | undefined; // the ledger's rules; null unanswered, undefined not asked
  own: OwnDeposit | null | undefined; // our own bridge deposit address; null unanswered, undefined not asked
};

function amountText(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 7 });
}

const AGAIN = 'nothing is sent. Try again in a minute';

function xrpRules(f: PayFacts, problems: string[], notes: PayNote[]): void {
  if (!f.native) {
    problems.push(`only XRP itself can be paid out on the XRP Ledger, and ${f.symbol} is not XRP`);
    return;
  }
  const t = f.target;
  if (t === undefined || t === null || t.network !== 'xrp') {
    problems.push(`the XRP Ledger did not answer about ${f.to}, so whether it needs a destination tag cannot be checked; ${AGAIN}`);
    return;
  }
  if (t.exists && t.requireDestTag) {
    problems.push(
      `${f.to} requires a destination tag on the XRP Ledger (exchanges set this to tell deposits apart), and Phosphor cannot send one, ` +
        'so the ledger would refuse the payment; use a personal wallet address that needs no tag',
    );
    return;
  }
  if (t.exists) return;
  if (t.reserveXrp === null) {
    if (f.minReceived < 1) {
      problems.push(
        `${f.to} does not exist on the XRP Ledger yet and the ledger's reserve could not be read, so the app holds to 1 XRP: ` +
          `a payment that creates an account must bring at least that, and this one delivers as little as ${amountText(f.minReceived)} XRP`,
      );
      return;
    }
  } else if (f.minReceived < t.reserveXrp) {
    problems.push(
      `${f.to} does not exist on the XRP Ledger yet, and a payment that creates an account must bring at least the ledger's ` +
        `${amountText(t.reserveXrp)} XRP reserve; this one delivers as little as ${amountText(f.minReceived)} XRP, so the ledger would refuse it`,
    );
    return;
  }
  notes.push({ tone: 'warn', text: `${f.to} does not exist on the XRP Ledger yet; this payment creates it, and ${amountText(t.reserveXrp ?? 1)} XRP of it stays locked as the ledger's reserve.` });
}

function stellarRules(f: PayFacts, problems: string[], notes: PayNote[]): void {
  const t = f.target;
  if (t === undefined || t === null || t.network !== 'stellar') {
    problems.push(`Stellar did not answer about ${f.to}, so whether it needs a memo cannot be checked; ${AGAIN}`);
    return;
  }
  if (t.memoRequired) {
    problems.push(`${f.to} says every payment to it needs a memo (it sets config.memo_required, as exchanges do), and Phosphor cannot send one`);
    return;
  }
  if (!t.exists) {
    if (!f.native) {
      problems.push(`${f.to} does not exist on Stellar yet, and only XLM can create an account: ${f.symbol} cannot be paid to it until it exists and trusts ${f.symbol}`);
    } else if (f.minReceived < 1) {
      problems.push(`${f.to} does not exist on Stellar yet, and creating an account takes at least 1 XLM; this payment delivers as little as ${amountText(f.minReceived)} XLM`);
    } else {
      notes.push({ tone: 'warn', text: `${f.to} does not exist on Stellar yet; this payment creates it, and 1 XLM of it stays locked as the account's reserve.` });
    }
    return;
  }
  if (f.native) return;
  // The issuer is 1Click's word for the token, so it is used, and printed, only when it is shaped
  // like the Stellar account an issuer is.
  const issuer = f.issuer !== null && /^G[A-Z2-7]{55}$/.test(f.issuer) ? f.issuer : null;
  if (issuer === null) {
    problems.push(`the issuer of ${f.symbol} on Stellar is not known to the app, so the receiver's trustline for it cannot be checked`);
    return;
  }
  const line = t.trustlines.find((l) => l.code.toUpperCase() === f.symbol.toUpperCase() && l.issuer === issuer);
  if (line === undefined) {
    problems.push(`${f.to} has no trustline for ${f.symbol} from its issuer ${issuer}, so it cannot hold ${f.symbol} and the payment would fail; the receiver adds ${f.symbol} in their wallet first`);
    return;
  }
  if (!line.authorized) {
    problems.push(`the issuer of ${f.symbol} has not authorized ${f.to} to hold it, so the payment would fail`);
    return;
  }
  const room = Number(line.limit) - Number(line.balance);
  if (Number.isFinite(room) && room < f.amount) {
    problems.push(`${f.to} has room for only ${amountText(Math.max(0, room))} more ${f.symbol} under the limit it set on its trustline, less than this payment`);
  }
}

function tronRules(f: PayFacts, problems: string[]): void {
  if (!f.native) return;
  const a = f.activity;
  if (a === null || a.network !== 'tron' || !a.ok || a.isContract === null) {
    problems.push(`Tron did not say whether ${f.to} is a contract, and Tron refuses TRX sent to a contract; ${AGAIN}`);
    return;
  }
  if (a.isContract) problems.push(`${f.to} is a contract on Tron, and Tron refuses TRX sent to a contract, so the payout could not land; pay a wallet, or a token the contract can hold`);
}

function ownDepositRules(f: PayFacts, problems: string[], notes: PayNote[]): void {
  const label = labelOf(f.network);
  if (f.own === undefined) return;
  if (f.own === null) {
    if (MEMO_CHAINS.has(f.network)) {
      problems.push(
        `the bridge did not say what your own NEAR Intents deposit address on ${label} is, so the app cannot rule out that this is it, ` +
          `and a payout to it would arrive with no memo; ${AGAIN}`,
      );
    }
    return;
  }
  if (!sameAccount(f.network, f.own.address, f.to)) return;
  if (f.own.memo !== null) {
    problems.push(
      `${f.to} is your own NEAR Intents deposit address on ${label}, which the bridge shares and tells apart by a memo; ` +
        'a payout carries no memo, so the money would not reach your balance',
    );
    return;
  }
  notes.push({ tone: 'info', text: `This is your own NEAR Intents deposit address on ${label}: the money comes back into your balance, less the fees both ways.` });
}

/* Every rule for the payout's chain, over what the chains said. The problems are refusals, each a
   whole sentence; the notes are what the card and the agent say beside a payout that goes ahead. */
export function payChecks(f: PayFacts): { problems: string[]; notes: PayNote[] } {
  const problems: string[] = [];
  const notes: PayNote[] = [];
  if (f.network === 'xrp') xrpRules(f, problems, notes);
  if (f.network === 'stellar') stellarRules(f, problems, notes);
  if (f.network === 'tron') tronRules(f, problems);
  ownDepositRules(f, problems, notes);
  if (f.given !== null && f.network === 'ton') {
    notes.push({ tone: 'info', text: `This is the same account, sent as non-bounceable (${f.to} rather than ${f.given}), so a wallet that is new cannot bounce the money back.` });
  }
  const caution = memoCaution(f.network);
  if (caution !== null) notes.push(caution);
  return { problems, notes };
}

// ---------- the propose surface ----------

/* What an agent is told when it tries to attach a memo anyway: by the MCP schema (src/mcp.ts),
   which is strict for propose_send, and by the door (src/http/propose.ts) for a raw post. Said as
   a refusal, never dropped: a memo dropped in silence is an agent that believes it sent one. */
export const NO_MEMO =
  'propose_send takes no memo, tag or comment: a payout cannot carry one, so an exchange deposit address that needs one cannot be paid; never ask the person for one, ask for a personal wallet address instead';

// The arguments propose_send takes, and the shape of a key that is a memo by another name.
export const SEND_FIELDS: readonly string[] = ['amount', 'confirmed', 'note', 'symbol', 'to', 'where'];
const MEMO_KEY = /memo|tag|comment|message|narration|payment_?id|reference/i;

export function memoKeys(params: Record<string, unknown>): string[] {
  return Object.keys(params).filter((key) => !SEND_FIELDS.includes(key) && MEMO_KEY.test(key));
}

// The sentence for keys the schema does not take: the memo one when any of them is a memo.
export function extraKeysSentence(keys: readonly string[]): string {
  if (keys.some((key) => MEMO_KEY.test(key))) return NO_MEMO;
  return `propose_send takes only ${SEND_FIELDS.join(', ')}; ${keys.map((k) => JSON.stringify(k.slice(0, 32))).join(', ')} is not one of them`;
}
