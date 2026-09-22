// The recipients book: every receiver a human has approved a send to, with how many times and
// when. `<dataDir>/recipients.json`, one row per (where, address).
//
// It exists so the send card can say "First send to this address" in amber or "Sent here 3
// times, last 12 Sep" in grey, which is the one fact that separates a friend's wallet from an
// address that arrived in a tool result five minutes ago. It is NOT an allowlist and it gates
// nothing: a first send is a warning on the card, never a refusal, and an address in the book
// still needs the click and the Touch ID every time. The book is written on approval only
// (src/proposals/lifecycle.ts), so a proposal the agent filed and nobody clicked leaves no row.
//
// `label` is the agent's own note about the receiver, kept as data for the audit trail and never
// drawn on the card: the agent does not get to name the address it is paying.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './fsatomic.ts';

export type RecipientRow = {
  key: string; // `${where}:${address as compared}`
  where: string; // 'intents' or a chain network id
  address: string; // as the chain spells it
  label?: string;
  firstAt: string;
  lastAt: string;
  count: number;
};

const FILE = 'recipients.json';
const MAX_LABEL = 64;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function recipientsPath(dataDir: string): string {
  return path.join(dataDir, FILE);
}

// EVM addresses and NEAR ids compare lowercased (two spellings of one account); a base58
// address compares exactly, because its case carries key material.
export function recipientKey(where: string, address: string): string {
  const trimmed = address.trim();
  const compared = EVM_ADDRESS.test(trimmed) || where === 'intents' || where === 'near' ? trimmed.toLowerCase() : trimmed;
  return `${where}:${compared}`;
}

export function readRecipients(dataDir: string): RecipientRow[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recipientsPath(dataDir), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRow);
  } catch {
    return [];
  }
}

function isRow(value: unknown): value is RecipientRow {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r['key'] === 'string' && typeof r['where'] === 'string' && typeof r['address'] === 'string' &&
    typeof r['firstAt'] === 'string' && typeof r['lastAt'] === 'string' && typeof r['count'] === 'number';
}

/* What a payout network was called in this book before the chains became one registry, for the
   five it could pay out on. base and near are absent because their name did not change, and
   bitcoin is absent because no payout on it was ever possible, so no row can exist. A table in
   this repo, never a name from a caller: a where that could alias itself would be a way to read
   somebody else's row.

   READ ONLY. Nothing is written under these names and nothing on disk is rewritten, so the book
   stays exactly what the app wrote and simply stays readable. */
const LEGACY_WHERE: Record<string, string> = {
  eth: 'ethereum',
  arb: 'arbitrum',
  sol: 'solana',
};

export function recipientFor(dataDir: string, where: string, address: string): RecipientRow | null {
  const rows = readRecipients(dataDir);
  const key = recipientKey(where, address);
  const found = rows.find((r) => r.key === key);
  if (found !== undefined) return found;
  /* A receiver approved before the rename is the same receiver, and the card's "first send"
     warning is only worth anything while it means what it says. */
  const legacy = LEGACY_WHERE[where];
  if (legacy === undefined) return null;
  const was = recipientKey(legacy, address);
  return rows.find((r) => r.key === was) ?? null;
}

function cleanLabel(label: string | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const flat = label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > MAX_LABEL ? flat.slice(0, MAX_LABEL) : flat;
}

// One approved send to this receiver, recorded. A new row starts at count 1; an existing one
// gains a count and a fresh lastAt, and keeps its first label unless it never had one.
export function recordRecipient(dataDir: string, where: string, address: string, at: string, label?: string): RecipientRow {
  const key = recipientKey(where, address);
  const rows = readRecipients(dataDir);
  const clean = cleanLabel(label);
  const existing = rows.find((r) => r.key === key);
  let row: RecipientRow;
  if (existing === undefined) {
    row = { key, where, address: address.trim(), ...(clean === undefined ? {} : { label: clean }), firstAt: at, lastAt: at, count: 1 };
    rows.push(row);
  } else {
    existing.count += 1;
    existing.lastAt = at;
    if (existing.label === undefined && clean !== undefined) existing.label = clean;
    row = existing;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(recipientsPath(dataDir), rows);
  return row;
}
