// A one-time deposit address from 1Click, for money coming in from outside the app.
//
// WHY THIS REPLACED THE BRIDGE. NEAR Intents is closing the POA bridge JSON-RPC that handed this
// app one standing address per network (its mail of 2026-11-12, "The POA Bridge API is closing":
// quotes, token lists and status move to the 1Click Swap API). The public replacement is a quote:
// one 1Click quote mints one deposit address, for one deposit, until the quote's deadline. A
// standing address (`chainDepositAddresses` on an ANY_INPUT quote) needs a partner API key and the
// user's session, which this app does not have yet, so every address here is a one-time address
// and the window says so.
//
// THE QUOTE. FLEX_INPUT, the coin in and the same coin out, sent on its own chain (depositType
// ORIGIN_CHAIN) and credited to this wallet's intents account (recipientType INTENTS). FLEX_INPUT is
// the shape that takes a deposit of any size at or above the quote's amount. A refund (a deposit
// under the minimum, or one 1Click could not process) goes to the same intents account (refundType
// INTENTS): the sender may be an exchange whose address nobody here knows, and money refunded to a
// chain address is money that left. Live 2026-11-13, dry: Base USDC, NEAR, XRP, TON, Solana, ETH
// and BNB USDT quote 1:1 with no fee; BTC keeps 22 sats of 100,000. Stellar answers "Incorrect
// depositMode" without MEMO and "Quoting for this pair is not available" with it, so Stellar is
// asked in memo mode and offers nothing until 1Click quotes it; XRP and TON refuse MEMO.
//
// WHAT IS CHECKED before an address may be shown, every one a refusal: the echo names our account
// as recipient and refund, with the routing fields, the coin and the amount that were sent;
// 1Click's signature covers the address, the memo and the deadline; the address has the shape of an
// address on that chain; a memo is there exactly when the quote was asked in memo mode; and the
// deadline is far enough ahead to be worth sending to.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../fsatomic.ts';
import { QuoteRefusal, oneLine, quoteEchoProblems } from '../intents.ts';
import type { OneClickClient, OneClickQuoteResponse, OneClickStatus, OneClickToken } from '../intents.ts';
import { quoteSignatureProblems } from '../quote-signature.ts';
import { scanNetworkOf, validateAddress } from '../chainscan/index.ts';
import type { ChainNetwork } from '../chainscan/index.ts';
import { humanAmount, receiveNetworkByBridge, receiveNetworkOf, spendNetworkOf } from './intents-address.ts';
import type { ReceiveNetwork } from './intents-address.ts';
import type { OwnDeposit } from './pay-rules.ts';

/* How long a one-time address takes deposits. Long enough for an exchange withdrawal that waits
   in review for hours, short enough that "use it once, today" is the honest sentence. 1Click
   accepted a 30 day deadline on a dry quote (2026-11-13); its docs call the deadline "the time
   when the deposit address becomes inactive and funds may be lost", which is why this is not
   longer. */
export const ONE_TIME_DEADLINE_MS = 24 * 60 * 60 * 1000;
// An address with less than this left is not handed out again: a new one is minted instead.
export const REUSE_MIN_LEFT_MS = 2 * 60 * 60 * 1000;
// A quote whose own deadline is closer than this is refused rather than shown.
const MIN_LIFE_MS = 30 * 60 * 1000;
// FLEX_INPUT reads slippage as the band either side of the quoted amount, the way every rail here does.
const SLIPPAGE_BPS = 100;
/* The most a same-coin deposit may lose between the address and the balance, in basis points, the
   same-asset send's floor (src/rails/intents-send.ts). A fee line (appFees) sits outside 1Click's
   signature, so a position between this app and 1Click can add one to the request and take it off
   the echo, and 1Click's own fee account may carry any size of one; neither can hide from the
   signed amounts, and FLEX_INPUT converts every deposit at the quoted rate. Live 2026-11-13: Base
   USDC, NEAR and XRP quote in = out, BTC kept 2.2 bp. */
export const DEPOSIT_MAX_LOSS_BPS = 100;
// The chains 1Click asks for a memo on (live 2026-11-13: Stellar). Asked the other way once if it says so.
const MEMO_FIRST: ReadonlySet<string> = new Set(['stellar']);

export type DepositMode = 'SIMPLE' | 'MEMO';

export type OneTimeDeposit = {
  // The intents account it credits, lowercased.
  account: string;
  // The registry id ('base') and its bridge key ('eth:8453'), which Activity names a network by.
  chain: string;
  network: string;
  symbol: string;
  // 1Click's id for the coin, which is also the verifier's.
  assetId: string;
  decimals: number;
  address: string;
  // Present only on a memo chain, and then half of where the money goes.
  memo: string | null;
  // The least to send, in base units and in the coin's unit: the quoted amount, which sits at or
  // above 1Click's own floor and above minAmountIn.
  minimumBase: string;
  minimum: string;
  // ISO. After `deadline` the address takes nothing and money sent to it may be lost.
  deadline: string;
  // ISO, when 1Click says the address goes cold (slower), or null.
  coldAt: string | null;
  mintedAt: string;
  // 1Click's own: what a dispute is filed under.
  correlationId: string | null;
  signature: string | null;
  timestamp: string | null;
};

export type DepositAsk = {
  account: string;
  net: ReceiveNetwork;
  token: { symbol: string; assetId: string; decimals: number };
};

export type MintDeps = {
  quote: OneClickClient['quote'];
  now?: () => number;
  // The 1Click quote key, for a test that signs with its own.
  quoteKey?: string;
};

/* The chain whose address rules a deposit address on this network has to pass. The EVM chains
   share one shape, so any of them stands for all; every other network is ruled below by its own
   decoder in src/chainscan, after the plain rule. */
function shapeChainOf(net: ReceiveNetwork): ChainNetwork | null {
  switch (net.kind) {
    case 'evm':
      return 'ethereum';
    case 'sol':
      return 'solana';
    case 'near':
      return 'near';
    case 'other':
      return net.id === 'btc' ? 'bitcoin' : null;
  }
}

/* Why a string 1Click answered with is not an address on this network, or null. The deposit
   address is the one string on the money-in screen this app cannot check against anything it
   holds: the decoders in src/chainscan rule where they know the chain, and elsewhere an address is
   at least printable, unbroken and of a plausible length. */
export function depositAddressProblem(net: ReceiveNetwork, address: string): string | null {
  const chain = shapeChainOf(net);
  if (chain !== null) {
    const check = validateAddress(chain, address);
    return check.ok ? null : check.reason;
  }
  if (!/^[!-~]{10,128}$/.test(address)) return 'expected 10 to 128 printable characters with no spaces';
  const decoded = scanNetworkOf(net.id);
  if (decoded !== null) {
    const check = validateAddress(decoded, address);
    return check.ok ? null : check.reason;
  }
  return null;
}

// "Amount is too low for bridge, try at least 150000": 1Click's floor for the coin, in base units.
export function floorFrom(err: unknown): string | null {
  if (!(err instanceof QuoteRefusal) || err.status !== 400) return null;
  const m = /too low[^0-9]*try at least\s+(\d{1,40})\b/i.exec(err.message);
  return m === null ? null : m[1]!;
}

/* The amount to quote at, from 1Click's floor. Not the floor itself: 1Click holds the low edge of
   the slippage band (minAmountIn) to its floor, so a quote AT the floor is refused with the same
   floor (live, 2026-11-13: Base USDC at 150000 and XRP at 2000000 both answered "try at least" the
   same number). So the floor is lifted by the band, then rounded up to two significant figures,
   which is a minimum a person can read and type (0.16 USDC, 2.1 XRP). A floor under a millionth of
   the coin (NEAR answers "try at least 0" for one yoctoNEAR, ARB and SUI a unit or two) is no
   floor a card can print, so it becomes a millionth of the coin, which 1Click accepted for wNEAR.
   And never under MIN_QUOTE_UNITS, so the value check below has a unit of rounding to spare. */
export function amountAboveFloor(floor: string, decimals: number): bigint {
  const dust = probeAmount(decimals);
  const asked = BigInt(floor);
  const base = asked > dust ? asked : dust;
  const keep = BigInt(10_000 - SLIPPAGE_BPS);
  const lifted = (base * 10_000n + keep - 1n) / keep;
  const digits = lifted.toString().length;
  if (digits <= 2) return lifted;
  const scale = 10n ** BigInt(digits - 2);
  return ((lifted + scale - 1n) / scale) * scale;
}

/* The least a quote is asked at, in base units. The value check compares the signed amounts in
   whole units, and at 2 units the 1% slippage band alone rounds minAmountOut to half (live,
   2026-11-13: ARB, SUI, MOVE, GNO and Robinhood USDG answered floors of a unit or two, and every
   one of them was refused by the check). At 1,000 one unit is a tenth of a percent. */
export const MIN_QUOTE_UNITS = 1_000n;

// A millionth of the coin, and never under MIN_QUOTE_UNITS.
function probeAmount(decimals: number): bigint {
  const millionth = 10n ** BigInt(Math.max(0, decimals - 6));
  return millionth > MIN_QUOTE_UNITS ? millionth : MIN_QUOTE_UNITS;
}

// How many dry asks the floor may take: one at a base unit, one more at a millionth of the coin
// when the base unit is refused without a floor, a mode switch, and two at a floor.
const FLOOR_TRIES = 5;

// "Failed to get quote": what 1Click says for an amount too small to price on a chain that names no
// floor for it. Nothing else is asked again: a mode refusal, a closed pair and every other refusal stand.
function unpriced(err: unknown): boolean {
  return err instanceof QuoteRefusal && /failed to get quote/i.test(err.message);
}

function modeRefused(err: unknown): boolean {
  return err instanceof QuoteRefusal && err.status === 400 && /incorrect depositmode/i.test(err.message);
}

function isoOf(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/* Every reason the live quote cannot be shown, empty when it can. Exported for the tests. */
export function depositQuoteProblems(response: OneClickQuoteResponse, ask: DepositAsk, sent: { amount: string; mode: DepositMode }, now: number, quoteKey?: string): string[] {
  const q = response.quote;
  const problems = [
    ...quoteEchoProblems(response.raw, {
      recipient: ask.account,
      recipientVerb: 'credit',
      recipientNoun: 'intents account',
      recipientType: 'INTENTS',
      recipientTypeWhy: 'a deposit is credited inside NEAR Intents',
      depositType: 'ORIGIN_CHAIN',
      refundType: 'INTENTS',
      refundTypeWhy: 'this wallet\'s own intents balance',
      refundTo: ask.account,
      originAsset: ask.token.assetId,
      destinationAsset: ask.token.assetId,
      amount: sent.amount,
      noEcho: 'nothing ties its address to this wallet',
    }),
    ...quoteSignatureProblems(response, quoteKey),
  ];
  const echo = (response.raw as { quoteRequest?: { swapType?: unknown; dry?: unknown } } | null)?.quoteRequest;
  if (echo?.swapType !== 'FLEX_INPUT') problems.push(`the quote was priced as ${oneLine(String(echo?.swapType), 20)}, not FLEX_INPUT`);
  if (echo?.dry !== false) problems.push('the quote is a dry run, which carries no address');
  /* The value check (DEPOSIT_MAX_LOSS_BPS): the coin is the same in and out, so the signed amounts
     compare as they are. The input is the quoted amountIn, or the amount sent where 1Click's is not
     a whole number, the same fallback the minimum takes (mintOneTimeDeposit). */
  const units = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,40}$/.test(v) ? BigInt(v) : null);
  const amountIn = units(q.amountIn) ?? units(sent.amount);
  const amountOut = units(q.amountOut);
  const minOut = units(q.minAmountOut);
  if (amountIn === null || amountOut === null || minOut === null || amountIn === 0n) {
    problems.push('the quote carries no amounts this app can read, so what a deposit keeps cannot be checked');
  } else {
    if (amountOut * 10_000n < amountIn * BigInt(10_000 - DEPOSIT_MAX_LOSS_BPS)) {
      const keptBp = ((amountIn - amountOut) * 10_000n + amountIn - 1n) / amountIn;
      problems.push(
        `the quote keeps ${Number(keptBp) / 100}% of a deposit (${amountIn} base units in, ${amountOut} out), more than the ` +
          `${DEPOSIT_MAX_LOSS_BPS / 100}% a deposit of the same coin may lose, so a fee this app never asked for may be in it`,
      );
    }
    if (minOut * 10_000n < amountIn * BigInt(10_000 - DEPOSIT_MAX_LOSS_BPS - SLIPPAGE_BPS)) {
      problems.push(`the quote guarantees only ${minOut} of ${amountIn} base units arriving, under the ${(DEPOSIT_MAX_LOSS_BPS + SLIPPAGE_BPS) / 100}% band this app allows`);
    }
  }
  const address = typeof q.depositAddress === 'string' ? q.depositAddress.trim() : '';
  if (address === '') problems.push('the quote carries no deposit address');
  else {
    const shape = depositAddressProblem(ask.net, address);
    if (shape !== null) problems.push(`the deposit address is not an address on ${ask.net.name} (${shape})`);
  }
  const memo = typeof q.depositMemo === 'string' ? q.depositMemo.trim() : '';
  if (sent.mode === 'MEMO' && memo === '') problems.push('the quote was asked in memo mode and carries no memo, so a deposit to it could reach nobody');
  if (sent.mode === 'SIMPLE' && memo !== '') problems.push('the quote carries a memo it was not asked for, so its address may be shared with other people');
  const deadline = isoOf(q.deadline);
  if (deadline === null) problems.push('the quote carries no deadline, so nobody can say until when its address takes money');
  else if (deadline - now < MIN_LIFE_MS) problems.push('the quote\'s address stops taking money in under half an hour');
  return problems;
}

/* One one-time address for one coin on one network. Throws on every failure, a QuoteRefusal where
   1Click itself refused (a closed pair reads as a pause upstream), an Error naming the check that
   failed otherwise. Mints at most one address: the floor is asked for with a dry quote first. */
export async function mintOneTimeDeposit(deps: MintDeps, ask: DepositAsk): Promise<OneTimeDeposit> {
  const now = deps.now ?? Date.now;
  const account = ask.account.toLowerCase();
  const full: DepositAsk = { ...ask, account };
  let mode: DepositMode = MEMO_FIRST.has(ask.net.id) ? 'MEMO' : 'SIMPLE';
  const params = (dry: boolean, amount: string) => ({
    dry,
    swapType: 'FLEX_INPUT' as const,
    depositMode: mode,
    originAsset: ask.token.assetId,
    destinationAsset: ask.token.assetId,
    amount,
    refundTo: account,
    refundType: 'INTENTS' as const,
    recipient: account,
    recipientType: 'INTENTS' as const,
    depositType: 'ORIGIN_CHAIN' as const,
    slippageToleranceBps: SLIPPAGE_BPS,
    deadlineMs: ONE_TIME_DEADLINE_MS,
  });

  /* The floor, dry: one base unit first, and 1Click answers the least it takes. The amount the live
     quote is asked at is one a dry quote has already taken, so the live ask is never the one that
     learns the floor. The mode is switched at most once, and a floor must rise or it is a loop. */
  let amount = '1';
  let switched = false;
  let escalated = false;
  let taken = false;
  let last: unknown = null;
  for (let attempt = 0; attempt < FLOOR_TRIES && !taken; attempt += 1) {
    try {
      await deps.quote(params(true, amount));
      taken = true;
    } catch (err) {
      last = err;
      if (modeRefused(err) && !switched) {
        switched = true;
        mode = mode === 'MEMO' ? 'SIMPLE' : 'MEMO';
        continue;
      }
      const floor = floorFrom(err);
      if (floor === null) {
        /* Some chains refuse one base unit without naming a floor (live, 2026-11-13: Bitcoin answers
           "Failed to get quote" for 1 sat and "try at least 6400" for 1,000): 1Click is asked once
           more, at a millionth of the coin, before its refusal stands. */
        if (escalated || amount !== '1' || !unpriced(err)) throw err;
        escalated = true;
        amount = probeAmount(ask.token.decimals).toString();
        continue;
      }
      const next = amountAboveFloor(floor, ask.token.decimals);
      if (next <= BigInt(amount)) throw err;
      amount = next.toString();
    }
  }
  if (!taken) throw last ?? new Error('1Click named no amount it would quote');

  const response = await deps.quote(params(false, amount));
  const at = now();
  const problems = depositQuoteProblems(response, full, { amount, mode }, at, deps.quoteKey);
  if (problems.length > 0) throw new Error(`the deposit address was not shown: ${problems.join('; ')}`);

  const q = response.quote;
  const asked = at + ONE_TIME_DEADLINE_MS;
  const deadline = Math.min(isoOf(q.deadline) ?? asked, asked);
  const cold = isoOf(q.timeWhenInactive);
  const memo = typeof q.depositMemo === 'string' && q.depositMemo.trim() !== '' ? q.depositMemo.trim() : null;
  const minimumBase = /^\d+$/.test(q.amountIn) ? q.amountIn : amount;
  return {
    account,
    chain: ask.net.id,
    network: ask.net.bridge,
    symbol: ask.token.symbol,
    assetId: ask.token.assetId,
    decimals: ask.token.decimals,
    address: (q.depositAddress as string).trim(),
    memo,
    minimumBase,
    minimum: humanAmount(minimumBase, ask.token.decimals),
    deadline: new Date(deadline).toISOString(),
    coldAt: cold === null ? null : new Date(Math.min(cold, deadline)).toISOString(),
    mintedAt: new Date(at).toISOString(),
    correlationId: response.correlationId ?? null,
    signature: response.signature ?? null,
    timestamp: response.timestamp ?? null,
  };
}

// Whether a held address may be handed out again: same account, chain and coin, and hours left.
export function stillGood(d: OneTimeDeposit, ask: { account: string; chain: string; assetId: string }, now: number): boolean {
  const left = (isoOf(d.deadline) ?? 0) - now;
  return d.account === ask.account.toLowerCase() && d.chain === ask.chain && d.assetId === ask.assetId && left >= REUSE_MIN_LEFT_MS;
}

// "2026-11-14 18:05 UTC": the deadline as a person reads it when no local clock is at hand.
export function deadlineWords(iso: string): string {
  const ms = isoOf(iso);
  if (ms === null) return 'its deadline';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// The sentence the window and the agent both say about the address, so the two never differ.
export function oneTimeWords(d: Pick<OneTimeDeposit, 'deadline'>): string {
  return `This address is for one deposit and stops taking money at ${deadlineWords(d.deadline)}. Do not save it or send to it again; ask for a new one next time.`;
}

/* ---------- the line to 1Click a card is opened over ----------

   What src/main.ts wires in live mode and nothing builds in demo mode or a test server: the coin
   list the receive report reads, the mint, and the status of a minted address, which the deposit
   watch and Activity ask. One object so a test stands in for 1Click with one fake. */
export type DepositQuotes = {
  tokens(): Promise<OneClickToken[]>;
  mint(ask: DepositAsk): Promise<OneTimeDeposit>;
  status(address: string, memo?: string): Promise<OneClickStatus>;
};

/* ---------- the book: every one-time address this wallet was handed ----------

   <dataDir>/deposit-quotes.json, newest first, the newest 500 kept, and never an address that
   still takes money, whatever its place. Written before an address is shown, so an address on
   screen is always one the app can find again: Activity asks 1Click about each one
   (src/received.ts), and a payout to one is refused (src/rails/pay-rules.ts), because a one-time
   address is not a wallet and money sent to it after its deadline may be lost. Written whole
   through atomicWriteJson (owner-only, never half a file). A file that is there and cannot be read
   is NOT the rule every other file of this app's keeps (no rows, replaced by the next write): it
   may hold addresses that still take money, so it is never written over, a new card is refused,
   and the payout check refuses rather than reading it as empty. A row this build cannot type but
   that names an address is kept on every write and is still ours to the payout check. */
export const DEPOSIT_BOOK_FILE = 'deposit-quotes.json';
export const DEPOSIT_BOOK_KEPT = 500;

/* How many new addresses the book takes in an hour, from both doors together (the window's and
   the agent's deposit tool). Twenty an hour with a 24 hour deadline is at most 480 addresses
   still taking money at once, under the 500 kept, so an agent that keeps asking for new ones is
   refused long before it could crowd a live one out; the book never drops a live one anyway. */
export const MINTS_PER_HOUR = 20;
/* How many of them the agent's door may take. The window keeps the rest, so an agent that keeps
   asking (a loop, or words planted in something it read) can never shut the person out of Add
   money for as long as it runs: the agent is refused, the window is not. */
export const AGENT_MINTS_PER_HOUR = MINTS_PER_HOUR - 5;
export const MINT_WINDOW_MS = 60 * 60 * 1000;

/* Whether one more address may be minted now: the rows minted within the hour around `now`, read
   from the book itself so a restart does not reset the count, plus the mints still waiting on
   1Click. When not, how long until enough of them have left the hour. */
export function mintRoom(rows: readonly BookEntry[], now: number, waiting = 0, limit = MINTS_PER_HOUR): { ok: true } | { ok: false; freesInMs: number } {
  const recent = rows
    .map((r) => isoOf(r.mintedAt))
    .filter((at): at is number => at !== null && Math.abs(now - at) < MINT_WINDOW_MS)
    .sort((a, b) => a - b);
  const over = recent.length + waiting - limit;
  if (over < 0) return { ok: true };
  const leaving = recent[Math.min(over, recent.length - 1)];
  return { ok: false, freesInMs: leaving === undefined ? 0 : Math.max(0, leaving + MINT_WINDOW_MS - now) };
}

/* What the book keeps of `rows` (newest first): all of them up to DEPOSIT_BOOK_KEPT; past it,
   every address whose deadline has not passed, and the newest of the rest in the room left. A
   live address is never dropped: the payout check reads this book, and a live address it had lost
   could be paid. A deadline that cannot be read counts as live. */
export function keptRows(rows: readonly BookEntry[], now: number): BookEntry[] {
  if (rows.length <= DEPOSIT_BOOK_KEPT) return [...rows];
  const live = (r: BookEntry): boolean => (isoOf(r.deadline) ?? Number.POSITIVE_INFINITY) > now;
  let room = DEPOSIT_BOOK_KEPT - rows.filter(live).length;
  return rows.filter((r) => live(r) || room-- > 0);
}

export type BookEntry = OneTimeDeposit & {
  // The terminal word 1Click last said about the address (SUCCESS, REFUNDED, FAILED), or null while open.
  settled: string | null;
};

export type DepositBook = {
  // Throws when the file cannot be written: an address the app cannot find again is never shown.
  add(d: OneTimeDeposit): void;
  all(): BookEntry[];
  settle(address: string, memo: string | null, status: string): void;
};

const ENTRY_STRINGS = ['account', 'chain', 'network', 'symbol', 'assetId', 'address', 'minimumBase', 'minimum', 'deadline', 'mintedAt'] as const;

function isEntry(value: unknown): value is BookEntry {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (!ENTRY_STRINGS.every((k) => typeof r[k] === 'string' && r[k] !== '')) return false;
  const orNull = (k: string): boolean => r[k] === null || typeof r[k] === 'string';
  return Number.isInteger(r.decimals) && orNull('memo') && orNull('coldAt') && orNull('correlationId') && orNull('signature') && orNull('timestamp') && orNull('settled');
}

export function depositBookPath(dataDir: string): string {
  return path.join(dataDir, DEPOSIT_BOOK_FILE);
}

function sameSpot(a: { address: string; memo: string | null }, b: { address: string; memo: string | null }): boolean {
  return a.address === b.address && (a.memo ?? null) === (b.memo ?? null);
}

// A row that names an address, whatever else it carries.
function namesAddress(value: unknown): value is Record<string, unknown> & { address: string } {
  if (value === null || typeof value !== 'object') return false;
  const address = (value as { address?: unknown }).address;
  return typeof address === 'string' && address.trim() !== '';
}

/* The book's file as it is on disk, read one way for the card and the payout check: no file is no
   rows; a file that is there and does not open, parse, or hold a list is unreadable; otherwise the
   rows this build can type, and beside them the rows it cannot type that still name an address. */
type BookFile = { unreadable: boolean; rows: BookEntry[]; other: Array<Record<string, unknown>> };

function absentOrUnreadable(err: unknown): BookFile {
  return { unreadable: (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT', rows: [], other: [] };
}

function readBookFile(file: string): BookFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return absentOrUnreadable(err);
  }
  try {
    const raw = JSON.parse(text) as { deposits?: unknown } | null;
    const list = raw !== null && typeof raw === 'object' ? raw.deposits : undefined;
    if (!Array.isArray(list)) return { unreadable: true, rows: [], other: [] };
    return { unreadable: false, rows: list.filter(isEntry), other: list.filter((r) => !isEntry(r) && namesAddress(r)) };
  } catch {
    return { unreadable: true, rows: [], other: [] };
  }
}

export function createDepositBook(dataDir: string, now: () => number = Date.now): DepositBook {
  const file = depositBookPath(dataDir);
  // Read again whenever the file changed, so the payout check and the card never see two books.
  let held: { stamp: string; read: BookFile } | null = null;

  function read(): BookFile {
    let stamp: string;
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}|${st.size}`;
    } catch (err) {
      return absentOrUnreadable(err);
    }
    if (held !== null && held.stamp === stamp) return held.read;
    const got = readBookFile(file);
    held = { stamp, read: got };
    return got;
  }

  function write(rows: BookEntry[], other: ReadonlyArray<Record<string, unknown>>): void {
    atomicWriteJson(file, { version: 1, deposits: [...keptRows(rows, now()), ...other] });
    held = null;
  }

  return {
    add(d) {
      const book = read();
      if (book.unreadable) throw new Error(`${DEPOSIT_BOOK_FILE} cannot be read, so it is not written over: it may hold addresses that still take money`);
      write([{ ...d, settled: null }, ...book.rows.filter((r) => !sameSpot(r, d))], book.other);
    },
    all: () => [...read().rows],
    settle(address, memo, status) {
      const book = read();
      if (book.unreadable) return;
      const rows = book.rows;
      const at = rows.findIndex((r) => sameSpot(r, { address, memo }));
      if (at < 0 || rows[at]!.settled === status) return;
      const next = [...rows];
      next[at] = { ...rows[at]!, settled: status };
      try {
        write(next, book.other);
      } catch {
        // Asked again at the next read: a settle that did not stick costs one more status call.
      }
    },
  };
}

/* ---------- the standing addresses the bridge handed out before ----------

   <dataDir>/deposit-addresses.json, written by the app up to 0.11.5: the POA bridge's one address
   per (account, network), keyed `${account}|${bridgeKey}`. Read only, never written again, and
   never shown again: NEAR Intents is closing the service that forwards them. Kept so a payout to
   one of them is refused by name, because a person may have saved one on an exchange. */
export const DEPOSIT_PINS_FILE = 'deposit-addresses.json';

export function depositPinsPath(dataDir: string): string {
  return path.join(dataDir, DEPOSIT_PINS_FILE);
}

export type StandingAddress = { account: string; network: string; address: string; memo: string | null };

// The pins, or null when the file is there and is not a pin file this app wrote.
function readPins(dataDir: string): StandingAddress[] | null {
  let text: string;
  try {
    text = fs.readFileSync(depositPinsPath(dataDir), 'utf8');
  } catch (err) {
    return absentOrUnreadable(err).unreadable ? null : [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: StandingAddress[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const row = value as { address?: unknown; memo?: unknown } | null;
    const cut = key.indexOf('|');
    if (cut < 1 || row === null || typeof row !== 'object' || typeof row.address !== 'string' || row.address === '') continue;
    out.push({ account: key.slice(0, cut), network: key.slice(cut + 1), address: row.address, memo: typeof row.memo === 'string' ? row.memo : null });
  }
  return out;
}

export function standingAddresses(dataDir: string): StandingAddress[] {
  return readPins(dataDir) ?? [];
}

/* Every deposit address of this app's on the chains whose addresses a payout to `network` could
   be: the chains of the same address family (every EVM chain is one, so a Base one-time address
   paid on Arbitrum is still caught), from the book and the standing pins, for every account on
   this Mac. Local reads only: a payout never waits on NEAR Intents to learn what is ours. Null
   when either file is there and cannot be read: the payout check refuses on that, because an
   unreadable list is not an empty one. */
export function ownDepositsOn(dataDir: string, network: string): OwnDeposit[] | null {
  const book = readBookFile(depositBookPath(dataDir));
  const standing = readPins(dataDir);
  if (book.unreadable || standing === null) return null;
  const family = spendNetworkOf(network)?.pay ?? null;
  const sameFamily = (net: ReceiveNetwork | undefined): boolean =>
    net !== undefined && (net.id === network || (family !== null && net.pay === family));
  const out: OwnDeposit[] = [];
  for (const d of book.rows) {
    const net = receiveNetworkOf(d.chain);
    if (sameFamily(net)) out.push({ address: d.address, memo: d.memo, kind: 'one_time', network: d.chain, deadline: d.deadline });
  }
  // A row this build cannot type: ours on its chain's family when the registry knows the chain, on every family when not.
  for (const r of book.other) {
    const net = typeof r.chain === 'string' ? receiveNetworkOf(r.chain) : undefined;
    if (net !== undefined && !sameFamily(net)) continue;
    out.push({
      address: r.address as string,
      memo: typeof r.memo === 'string' ? r.memo : null,
      kind: 'one_time',
      network: net?.id ?? network,
      deadline: typeof r.deadline === 'string' ? r.deadline : null,
    });
  }
  for (const s of standing) {
    const net = receiveNetworkByBridge(s.network);
    if (sameFamily(net)) out.push({ address: s.address, memo: s.memo, kind: 'standing', network: net!.id, deadline: null });
  }
  return out;
}
