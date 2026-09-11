// What the host and the child say to each other, as JSON over IPC.
//
// The child holds armed plans by id and refuses any command for a plan it does not hold. That
// is the envelope: the host cannot ask for more than the human approved because the child only
// knows how to place the plan it was given, and every command names a plan rather than an
// order. Every command carries a `seq` the reply echoes, so the host can await the venue's
// answer to a human's button rather than reporting "sent".

import type { Plan } from '../trade/plan.ts';
import type { PlanRow } from '../trade/plans.ts';

export type AssetMeta = { assetId: number; szDecimals: number; maxLeverage: number };

export type Cloids = PlanRow['cloids'];

export type ToChild =
  | { cmd: 'arm'; seq: number; plan: Plan; cloids: Cloids; gen: number; meta: AssetMeta }
  | { cmd: 'fire'; seq: number; id: string; mark: number }
  | { cmd: 'protect'; seq: number; id: string }
  | { cmd: 'modify'; seq: number; id: string; stop?: number; target?: number; cloids: Cloids; gen: number; mark: number }
  | { cmd: 'cancel'; seq: number; id: string }
  | { cmd: 'close'; seq: number; id: string; maxSlippageBps: number; mark: number }
  // Every coin the host names is closed at the human's own bound, and every cloid it names is
  // cancelled. The child holds books for armed coins only, so the host names the rest.
  | { cmd: 'flatten'; seq: number; coins: { coin: string; meta: AssetMeta; mark: number }[]; cancels: { assetId: number; cloid: string }[] }
  // Cancel whatever exits are still resting for a plan that is finished, and forget it.
  | { cmd: 'release'; seq: number; id: string }
  | { cmd: 'disarm'; seq: number; id: string }
  | { cmd: 'kill'; seq: number };

export type FromChild =
  | { ev: 'ready'; seq: 0 }
  | { ev: 'armed'; seq: number; id: string }
  // The child mints every cloid from the plan id, the leg and its generation, so the host gets
  // them back on every event that placed something and persists them beside the plan.
  | { ev: 'placed'; seq: number; id: string; oids: { entry?: number; stop?: number; target?: number }; filledSz: number; avgPx: number | null; cloids: Cloids; gen: number }
  | { ev: 'protected'; seq: number; id: string; oids: { stop?: number; target?: number }; sz: number; cloids: Cloids; gen: number }
  | { ev: 'modified'; seq: number; id: string; stop: number; target: number | null; cloids: Cloids; gen: number }
  | { ev: 'cancelled'; seq: number; id: string; filledSz: number }
  | { ev: 'closed'; seq: number; id: string; stillOpenSz: number }
  | { ev: 'flat'; seq: number; stillOpen: string[]; detail: string }
  | { ev: 'released'; seq: number; id: string }
  | { ev: 'refused'; seq: number; id: string | null; reason: string }
  | { ev: 'error'; seq: number; id: string | null; message: string };

export function isFromChild(m: unknown): m is FromChild {
  return m !== null && typeof m === 'object' && typeof (m as { ev?: unknown }).ev === 'string';
}
