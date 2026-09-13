// The plan registry on disk.
//
// Every plan that was ever armed leaves a row: the trade page says why a plan stopped by reading
// it, and the boot reconcile decides what to re-arm by reading it against the proposal store.
// Only an idea can be removed, because an idea has never had authority.
//
// Written whole through the app's one durable writer (src/fsatomic.ts), so a crash mid-write
// leaves the last good file rather than half of a new one. Owner-only, like every other file
// under the data dir that says what this app is allowed to do.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../fsatomic.ts';

import type { Plan } from './plan.ts';
import type { PlanRisk } from './risk.ts';

export type PlanStatus = 'idea' | 'waiting' | 'placed' | 'open' | 'done';
export type EndReason = 'stopped' | 'targeted' | 'closed' | 'cancelled' | 'expired' | `failed:${string}`;

export type PlanRow = Plan & {
  status: PlanStatus;
  endReason?: EndReason;
  // The feed behind the watcher is stale, so nothing fires until it is fresh again.
  blind?: boolean;
  // The signing session ended with this plan still waiting. It re-arms on the next unlock.
  locked?: boolean;
  proposalId?: string;
  hash: string;
  risk?: PlanRisk;
  // One client order id per leg and generation, minted by the host and persisted with the plan
  // so cancel and reconcile go by an id this app owns and no oid ever needs re-reading.
  cloids: { entry?: string; stop?: string; target?: string };
  gen: number;
  // The fill the entry actually got, once it has one. Changes on an open plan measure from here.
  fillPx?: number;
  // The position size the exits were last sized to. A fill that grows the position past it
  // means protect has to run again.
  exitSz?: number;
  holds?: { condition: string; holds: boolean }[];
  by?: string | null;
  createdAt: string;
  updatedAt: string;
};

// A row minus the optional plan fields. A row that takes a new plan loses these first: spread
// over the old row, a plan without a target keeps the old target under the new plan's hash, so
// the row and its hash disagree and a target the agent removed, or grew while a card waited,
// rides into the arm.
export function bookkeepingOf(row: PlanRow): Omit<PlanRow, 'target' | 'when' | 'note'> {
  const { target: _target, when: _when, note: _note, ...rest } = row;
  return rest;
}

export type PlanStore = {
  list(): PlanRow[];
  get(id: string): PlanRow | null;
  put(row: PlanRow): void;
  // Ideas only. Anything that was armed keeps its row, so the answer for those is false.
  remove(id: string): boolean;
};

const FILE = 'plans.json';

function looksLikeRow(v: unknown): v is PlanRow {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.symbol === 'string' && typeof r.status === 'string' && typeof r.hash === 'string';
}

export function createPlanStore(dir: string): PlanStore {
  const file = path.join(dir, FILE);
  const rows = new Map<string, PlanRow>();

  function load(): void {
    if (!fs.existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // A file this app cannot read is copied aside rather than lost: the evidence stays, the
      // next write replaces the original, and the app comes up with no plans rather than not
      // at all.
      const aside = `${file}.${Date.now().toString(36)}.unreadable`;
      try {
        fs.copyFileSync(file, aside);
      } catch {
        // Nothing more to do.
      }
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) if (looksLikeRow(row)) rows.set(row.id, row);
  }

  function save(): void {
    atomicWriteJson(file, [...rows.values()]);
  }

  load();

  return {
    list: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    put(row) {
      rows.set(row.id, row);
      save();
    },
    remove(id) {
      const row = rows.get(id);
      if (row === undefined || row.status !== 'idea') return false;
      rows.delete(id);
      save();
      return true;
    },
  };
}
