// Every invite claim this app has signed, on disk: state/invites.json, mode 0600.
//
// A record is written BEFORE the signed claim is published (spec, "The claim", step 7), so a
// quit at any moment after the signature leaves enough behind to finish the story at the next
// boot: the code's account, the nonce the verifier is asked by, the deadline it dies at, the
// intent hash and the amount. Never the code and never its key: a record is a set of public facts
// about an account anyone can look up, and the code is the one thing that spends it.
//
// A finished claim stays, marked done or failed. The done ones are the Activity rows
// (src/transactions.ts): the audit log is compactable and this file is not.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../fsatomic.ts';

export type ClaimRoute = 'relay' | 'oneclick';

export type ClaimAttempt = {
  route: ClaimRoute;
  nonce: string; // base64 V1, as signed
  deadline: string; // ISO, the signed intent's own deadline
  intentHash: string; // base58 of the payload's EIP-191 hash, known before publish
  depositAddress?: string; // the 1Click handle, Plan B only: what its status is asked by
};

export type ClaimRecord = {
  claim: string; // opaque, random, never derived from the code
  status: 'pending' | 'done' | 'failed';
  codeAddress: string;
  receiver: string; // the wallet's decrypted EVM address, lowercased
  assetId: string;
  amountBase: string; // what the code held and what was signed
  attempts: ClaimAttempt[];
  startedAt: string;
  settledAt?: string;
  // Once done: the route that paid, what landed in the wallet, the hashes to look it up by.
  route?: ClaimRoute;
  creditedBase?: string;
  intentHash?: string;
  nearTx?: string;
  // Once failed: why, in one word (src/invite/claim.ts FailReason).
  reason?: string;
};

export type ClaimStore = {
  all(): ClaimRecord[];
  get(claim: string): ClaimRecord | undefined;
  // Insert or replace by claim id, then write the file. Throws when the write fails, so a caller
  // that has to have the record on disk before it publishes can stop.
  put(record: ClaimRecord): void;
};

export const CLAIMS_FILE = 'invites.json';

function isRecord(value: unknown): value is ClaimRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.claim === 'string' &&
    (r.status === 'pending' || r.status === 'done' || r.status === 'failed') &&
    typeof r.codeAddress === 'string' &&
    typeof r.receiver === 'string' &&
    typeof r.assetId === 'string' &&
    typeof r.amountBase === 'string' &&
    /^\d+$/.test(r.amountBase) &&
    Array.isArray(r.attempts) &&
    typeof r.startedAt === 'string'
  );
}

export function createClaimStore(dataDir: string): ClaimStore {
  const file = path.join(dataDir, CLAIMS_FILE);
  let records: ClaimRecord[] | null = null;

  function load(): ClaimRecord[] {
    if (records !== null) return records;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { claims?: unknown };
      records = Array.isArray(raw.claims) ? raw.claims.filter(isRecord) : [];
    } catch {
      // No file yet, or one this app cannot read: no claims. The next write replaces it.
      records = [];
    }
    return records;
  }

  return {
    all: () => [...load()],
    get: (claim) => load().find((r) => r.claim === claim),
    put(record) {
      const next = load().filter((r) => r.claim !== record.claim);
      next.push(record);
      atomicWriteJson(file, { version: 1, claims: next });
      records = next;
    },
  };
}
