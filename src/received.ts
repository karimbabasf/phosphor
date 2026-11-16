// Money that came in from outside the app, for Activity.
//
// The app's own moves are the proposal store and an invite claim is its own record. Money a person
// sends in from an exchange or another wallet has neither, so Activity showed only what left
// (Karim, 2026-10-05: "our activity doesnt show any received transactions"). Until 0.11.5 the POA
// bridge was asked for the account's deposits. NEAR Intents is closing it (its mail of 2026-11-12),
// and every address this app hands out now is a one-time 1Click quote kept in the book
// (src/rails/deposit-quote.ts), so 1Click is asked about each of those (GET /v0/status) and what
// it said is kept in <dataDir>/received.json, beside the rows the bridge reported before.
//
// WHAT IS ASKED. The book's addresses for this account that are not settled yet and were minted in
// the last seven days, the newest twenty per read. A terminal answer (SUCCESS, REFUNDED, FAILED)
// settles the address in the book, so it is never asked again. A refund lands in the same balance
// (the quote's refundType is INTENTS), so a refunded deposit reads as received.
//
// WHAT IS KEPT. Each deposit as 1Click last described it, timed by the first read that saw it,
// keyed by its origin-chain hash: an answer that names no hash is not a row yet. Rows stay, so a
// deposit seen once stays in Activity, and the bridge's old rows are never dropped.
//
// WHEN IT IS READ. When the window reads its activity (src/http/receipts.ts), at most once a
// minute, and never in demo mode. The read runs behind the answer: the list served is the one
// already held, and what the read finds shows at the window's next read (Pro reads every 30 s
// while it is up). A failed read changes nothing.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './fsatomic.ts';
import { decimalToBaseUnits } from './intents.ts';
import type { OneClickStatus } from './intents.ts';
import type { BookEntry, DepositBook } from './rails/deposit-quote.ts';

export const RECEIVED_FILE = 'received.json';
export const RECEIVED_READ_MS = 60_000;
// Which of the book's addresses are asked about: minted in the last week, the newest twenty a read.
export const RECEIVED_ASK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIVED_ASK_MAX = 20;
// The words after which an address is never asked about again.
const SETTLED: ReadonlySet<string> = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
// The file's ceiling, newest kept. A wallet that has taken more deposits than this shows the newest.
export const RECEIVED_KEPT = 500;

export type ReceivedDeposit = {
  // The intents account it was credited to, lowercased: rows of another wallet never show.
  account: string;
  txHash: string;
  // NEAR Intents' key for the network it came from ('eth:8453') and its id for the coin.
  network: string;
  asset: string;
  // In base units: what reached the balance once settled, what arrived at the address before.
  amountBase: string;
  // Off the book's entry (or the bridge's row, on an old one); null while neither has said.
  decimals: number | null;
  symbol: string | null;
  // COMPLETED is in the balance (credited, or refunded into it), FAILED did not arrive, anything
  // else is on its way.
  status: string;
  // ISO: the first read that saw it (on an old bridge row, the bridge's created_at). null for an
  // old row the account's first bridge read found with no time: nobody knows when it came.
  at: string | null;
};

export type Received = {
  // This wallet's deposits, newest first, the ones with no time last.
  list(): ReceivedDeposit[];
  // Ask 1Click again when the last ask is a minute old. Never waits and never throws.
  refresh(): void;
  // One read now, for a test or a caller that has to wait. Rejects when the read failed.
  read(): Promise<void>;
};

export type ReceivedDeps = {
  dataDir: string;
  // The wallet's intents account, lowercased, or null with no wallet.
  account: () => string | null;
  // False in demo mode: a demo wallet's account has nothing at 1Click.
  enabled: boolean;
  // The one-time addresses this app handed out, and 1Click's word on one. Absent, nothing is asked.
  book?: DepositBook;
  status?: (address: string, memo?: string) => Promise<OneClickStatus>;
  now?: () => number;
};

function isDeposit(value: unknown): value is ReceivedDeposit {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.account === 'string' &&
    typeof r.txHash === 'string' &&
    typeof r.network === 'string' &&
    typeof r.asset === 'string' &&
    typeof r.amountBase === 'string' &&
    (r.decimals === null || typeof r.decimals === 'number') &&
    (r.symbol === null || typeof r.symbol === 'string') &&
    typeof r.status === 'string' &&
    (r.at === null || typeof r.at === 'string')
  );
}

// Newest first, and a row with no time below every row with one.
function byTime(a: ReceivedDeposit, b: ReceivedDeposit): number {
  if (a.at === b.at) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at < b.at ? 1 : -1;
}

/* What reached the balance, in base units: the delivered amount on SUCCESS, the refund on REFUNDED,
   what arrived at the address before either. Null when 1Click named none that reads. */
function amountBaseOf(said: OneClickStatus, entry: BookEntry): string | null {
  // parseStatus says "0" for a refund field a terminal answer left out, which is not the refund.
  const refunded = said.refundedAmount !== undefined && said.refundedAmount !== '0' ? said.refundedAmount : undefined;
  const text =
    said.status === 'SUCCESS' ? (said.settledAmountOut ?? said.depositedAmount) : said.status === 'REFUNDED' ? (refunded ?? said.depositedAmount) : said.depositedAmount;
  if (text === undefined || text === '0') return null;
  try {
    const base = decimalToBaseUnits(text, entry.decimals);
    return base > 0n ? base.toString() : null;
  } catch {
    return null;
  }
}

function statusWord(said: OneClickStatus): string {
  if (said.status === 'SUCCESS' || said.status === 'REFUNDED') return 'COMPLETED';
  return said.status === 'FAILED' ? 'FAILED' : 'PENDING';
}

const keyOf = (d: { account: string; txHash: string; asset: string }): string => `${d.account}|${d.asset}|${d.txHash}`;

export function createReceived(deps: ReceivedDeps): Received {
  const file = path.join(deps.dataDir, RECEIVED_FILE);
  const now = deps.now ?? Date.now;
  let rows: ReceivedDeposit[] | null = null;
  // The accounts whose first bridge read was behind them, kept in the file beside the rows so a
  // write here carries the old field on unchanged.
  let readFor = new Set<string>();
  let askedAt = -Infinity;
  let reading = false;

  function load(): ReceivedDeposit[] {
    if (rows !== null) return rows;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { read?: unknown; deposits?: unknown };
      rows = Array.isArray(raw.deposits) ? raw.deposits.filter(isDeposit) : [];
      readFor = new Set(Array.isArray(raw.read) ? raw.read.filter((a): a is string => typeof a === 'string') : []);
    } catch {
      // No file yet, or one this app cannot read: nothing seen. The next write replaces it.
      rows = [];
    }
    return rows;
  }

  async function read(): Promise<void> {
    const account = deps.account();
    const book = deps.book;
    const status = deps.status;
    if (account === null || book === undefined || status === undefined) return;
    const at = now();
    const open = book
      .all()
      .filter((e) => e.account === account && e.settled === null && at - Date.parse(e.mintedAt) <= RECEIVED_ASK_WINDOW_MS)
      .slice(0, RECEIVED_ASK_MAX);
    if (open.length === 0) return;
    const answers = await Promise.all(open.map((entry) => status(entry.address, entry.memo ?? undefined).then((said) => ({ entry, said }), () => null)));
    const held = new Map(load().map((r) => [keyOf(r), r]));
    let changed = false;
    const settled: Array<{ entry: BookEntry; word: string }> = [];
    for (const got of answers) {
      if (got === null) continue;
      const { entry, said } = got;
      const first = said.found ? said.originTxHashes[0] : undefined;
      // Printed and linked in Activity, so held to the letters and digits a chain hash is made of.
      const txHash = first !== undefined && /^(0x)?[0-9A-Za-z]{16,128}$/.test(first) ? first : undefined;
      const amountBase = amountBaseOf(said, entry);
      let kept = false;
      if (txHash !== undefined && amountBase !== null) {
        kept = true;
        const prior = held.get(keyOf({ account, txHash, asset: entry.assetId }));
        const next: ReceivedDeposit = {
          account,
          txHash,
          network: entry.network,
          asset: entry.assetId,
          amountBase,
          decimals: entry.decimals,
          symbol: entry.symbol,
          status: statusWord(said),
          at: prior?.at ?? new Date(at).toISOString(),
        };
        if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(next)) {
          held.set(keyOf(next), next);
          changed = true;
        }
      }
      /* Settled only once its row is kept, or on FAILED, where nothing may have arrived: a SUCCESS or
         REFUNDED that names no hash or amount yet is asked again, so the deposit still reaches
         Activity when 1Click fills them in (inside the seven days). */
      if (SETTLED.has(said.status) && (kept || said.status === 'FAILED')) settled.push({ entry, word: said.status });
    }
    if (changed) {
      const next = [...held.values()].sort(byTime).slice(0, RECEIVED_KEPT);
      atomicWriteJson(file, { version: 1, read: [...readFor], deposits: next });
      rows = next;
    }
    // Only once its row is on disk: a settled address is never asked about again.
    for (const { entry, word } of settled) book.settle(entry.address, entry.memo, word);
  }

  return {
    list() {
      const account = deps.account();
      return account === null ? [] : load().filter((r) => r.account === account);
    },
    refresh() {
      if (!deps.enabled || reading || now() - askedAt < RECEIVED_READ_MS) return;
      askedAt = now();
      reading = true;
      read()
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    },
    read,
  };
}
