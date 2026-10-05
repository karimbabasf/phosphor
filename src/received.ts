// Money that came in through the bridge, for Activity.
//
// The app's own moves are the proposal store and an invite claim is its own record. Money a person
// sends in from an exchange or another wallet has neither: the POA bridge credits it to this
// account and nothing in the app wrote it down, so Activity showed only what left (Karim,
// 2026-10-05: "our activity doesnt show any received transactions"). So the bridge is asked
// (recent_deposits, every network in one call) and what it said is kept in <dataDir>/received.json.
//
// WHAT IS KEPT. Each deposit as the bridge last described it, plus the one fact its rows do not
// carry: a time. A row's time is the first time this app saw it, written down so that it does not
// move at the next boot. Rows stay after the bridge's page has moved past them (it answers the
// newest 100), so a deposit seen once stays in Activity.
//
// WHEN IT IS READ. When the window reads its activity (src/http/receipts.ts), at most once a
// minute, and never in demo mode. The read runs behind the answer: the list served is the one
// already held, and what the read finds shows at the window's next read (Pro reads every 30 s
// while it is up). A failed read changes nothing.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './fsatomic.ts';
import { poaAccountDepositsOrThrow, poaSupportedTokens } from './rails/intents-address.ts';
import type { PoaToken } from './rails/intents-address.ts';

export const RECEIVED_FILE = 'received.json';
export const RECEIVED_READ_MS = 60_000;
// The bridge's token list names the coins, and changes far less often than once a minute.
const TOKENS_MS = 60 * 60_000;
// The file's ceiling, newest kept. A wallet that has taken more deposits than this shows the newest.
export const RECEIVED_KEPT = 500;

export type ReceivedDeposit = {
  // The intents account it was credited to, lowercased: rows of another wallet never show.
  account: string;
  txHash: string;
  // The bridge's key for the network it came from ('eth:8453') and its id for the coin.
  network: string;
  asset: string;
  // In base units, as the bridge sent it.
  amountBase: string;
  // Off the row or the bridge's token list; null while neither has said.
  decimals: number | null;
  symbol: string | null;
  // The bridge's word: COMPLETED is credited, FAILED did not arrive, anything else is on its way.
  status: string;
  // ISO, the first time this app saw it.
  seenAt: string;
};

export type Received = {
  // This wallet's deposits, newest first.
  list(): ReceivedDeposit[];
  // Ask the bridge again when the last ask is a minute old. Never waits and never throws.
  refresh(): void;
  // One read now, for a test or a caller that has to wait. Rejects when the read failed.
  read(): Promise<void>;
};

export type ReceivedDeps = {
  dataDir: string;
  // The wallet's intents account, lowercased, or null with no wallet.
  account: () => string | null;
  // False in demo mode: a demo wallet's account has nothing at the bridge.
  enabled: boolean;
  fetchImpl?: typeof fetch;
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
    typeof r.seenAt === 'string'
  );
}

// The token a deposit row names: same network, and the same contract, or none for the chain's own coin.
function tokenOf(asset: string, tokens: PoaToken[]): PoaToken | undefined {
  const parts = asset.split(':');
  const network = parts.slice(0, 2).join(':');
  const rest = parts.slice(2).join(':').toLowerCase();
  const contract = rest === '' || rest === 'native' ? null : rest;
  return tokens.find((t) => t.network === network && (t.contract === null ? null : t.contract.toLowerCase()) === contract);
}

const keyOf = (d: { account: string; txHash: string; asset: string }): string => `${d.account}|${d.asset}|${d.txHash}`;

export function createReceived(deps: ReceivedDeps): Received {
  const file = path.join(deps.dataDir, RECEIVED_FILE);
  const now = deps.now ?? Date.now;
  let rows: ReceivedDeposit[] | null = null;
  let tokens: PoaToken[] = [];
  let tokensAt = -Infinity;
  let askedAt = -Infinity;
  let reading = false;

  function load(): ReceivedDeposit[] {
    if (rows !== null) return rows;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { deposits?: unknown };
      rows = Array.isArray(raw.deposits) ? raw.deposits.filter(isDeposit) : [];
    } catch {
      // No file yet, or one this app cannot read: nothing seen. The next write replaces it.
      rows = [];
    }
    return rows;
  }

  async function read(): Promise<void> {
    const account = deps.account();
    if (account === null) return;
    const fresh = await poaAccountDepositsOrThrow(account, deps.fetchImpl);
    const at = now();
    // A coin the held list cannot name sends for the bridge's list, at most once an hour after one
    // that answered; an empty answer keeps the old list and is asked again at the next read.
    if (fresh.some((d) => tokenOf(d.asset, tokens) === undefined) && at - tokensAt >= TOKENS_MS) {
      const listed = await poaSupportedTokens(deps.fetchImpl);
      if (listed.length > 0) {
        tokens = listed;
        tokensAt = at;
      }
    }
    const held = new Map(load().map((r) => [keyOf(r), r]));
    let changed = false;
    fresh.forEach((d, i) => {
      if (d.txHash === '' || d.asset === '') return;
      const token = tokenOf(d.asset, tokens);
      const prior = held.get(keyOf({ account, txHash: d.txHash, asset: d.asset }));
      const next: ReceivedDeposit = {
        account,
        txHash: d.txHash,
        network: d.network,
        asset: d.asset,
        amountBase: d.amount,
        decimals: d.decimals ?? token?.decimals ?? prior?.decimals ?? null,
        symbol: token?.symbol ?? prior?.symbol ?? null,
        status: d.status,
        // The bridge's page is newest first, so rows first seen together keep its order a millisecond apart.
        seenAt: prior?.seenAt ?? new Date(at - i).toISOString(),
      };
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(next)) return;
      held.set(keyOf(next), next);
      changed = true;
    });
    if (!changed) return;
    const next = [...held.values()].sort((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0)).slice(0, RECEIVED_KEPT);
    atomicWriteJson(file, { version: 1, deposits: next });
    rows = next;
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
