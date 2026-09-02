// GET /api/health: is this app alive, and is anything wrong with it.
//
// The only unauthenticated GET that proved the app was up used to be `/api/session`, which
// answered by handing out the approval token. So "check whether Phosphor is running" and "take
// control of Phosphor" were the same request, and every supervisor, probe and shell script that
// wanted the first was reaching for the second.
//
// This carries no token and no secret. Everything in it is either a fact the window already
// shows a person (the kill switch, how many decisions are waiting) or a fact about the process
// (version, uptime, the last error). Nothing here names a balance, an address, a proposal or a
// key, so it is safe for anything on this machine to read, which is the point: a health check
// that needs a credential is a health check nobody runs.

import type http from 'node:http';

import { VERSION } from '../version.ts';
import { sendJson } from './respond.ts';
import type { Ctx } from './context.ts';

const startedAtMs = Date.now();

export type Health = {
  ok: true;
  version: string;
  killSwitch: boolean;
  pending: number;
  locked: boolean;
  lastError: string | null;
  uptimeSec: number;
};

export function buildHealth(ctx: Ctx): Health {
  // The store can throw: a proposal file that will not read is quarantined and named. Health is
  // the one route that must answer anyway, because a person reaching for it is already asking
  // what is wrong. The failure becomes the answer rather than a 500.
  let pending = 0;
  let storeError: string | null = null;
  try {
    pending = ctx.proposals.list().filter((p) => p.status === 'pending').length;
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
  }

  let killSwitch = true; // fail closed: an unreadable policy reads as the switch being ON
  let policyError: string | null = null;
  try {
    const policy = ctx.getPolicy();
    if (policy === null) policyError = 'the policy file cannot be read, so every write is refused';
    else killSwitch = policy.killSwitch;
  } catch (err) {
    policyError = err instanceof Error ? err.message : String(err);
  }

  const recorded = ctx.audit.lastError();
  const lastError = storeError ?? policyError ?? (recorded === null ? null : `${recorded.at}: ${recorded.msg}`);

  return {
    ok: true,
    version: VERSION,
    killSwitch,
    pending,
    /* Owned by the custody track, which has not landed on this branch. `false` is the honest
       answer for a build with no keystore in it: there is nothing here that can be locked. When
       Track A merges, this reads the keystore. */
    locked: false,
    lastError,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
  };
}

export function sendHealth(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, buildHealth(ctx));
}
