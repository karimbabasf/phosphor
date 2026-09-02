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

type Health = {
  ok: true;
  version: string;
  killSwitch: boolean;
  pending: number;
  locked: boolean;
  /* The audit chain, checked rather than assumed. verify() had no caller outside the tests:
     nothing on boot, no route, not health, so the record's integrity was never actually read in
     production. It is a whole-file walk, so it runs once at boot and this reports what it found;
     a poll that re-walked a 10 MB history would be its own denial of service. */
  auditChain: string;
  lastError: string | null;
  uptimeSec: number;
};

/* What the boot check found, held for the life of the process. Set by src/main.ts before the port
   opens; a server built without one (every test in this repo) reports that it was not run rather
   than claiming a chain it never looked at. */
let chainAtBoot = 'not checked';

export function recordAuditChain(state: string): void {
  chainAtBoot = state;
}

function buildHealth(ctx: Ctx): Health {
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
  // A broken chain outranks a stale error line: it is a claim about the record itself, and the
  // record is what every other answer here is drawn from.
  const chainError = chainAtBoot.startsWith('broken') ? `the audit log is damaged: ${chainAtBoot.slice('broken: '.length)}` : null;
  const lastError = chainError ?? storeError ?? policyError ?? (recorded === null ? null : `${recorded.at}: ${recorded.msg}`);

  return {
    ok: true,
    version: VERSION,
    killSwitch,
    pending,
    /* Read from the keystore rather than hardcoded. This was `false` with a comment saying the
       custody track had not landed, and it had: health reported an unlocked wallet on every
       install, including one that was shut. `locked` is the narrow question the field asks, so
       needs_migration and no_wallet are both false here and lock.state on /api/state is the
       four-way answer. */
    locked: ctx.keystore.state() === 'locked',
    auditChain: chainAtBoot,
    lastError,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
  };
}

export function sendHealth(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, buildHealth(ctx));
}
