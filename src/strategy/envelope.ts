// The envelope check: the wall around an armed program.
//
// This runs in the same function that signs, on every intended action, with no network hop
// between the check and the key. That placement is the whole security argument. A check
// living in a service, in the UI, or in the agent is a check something can route around.
//
// Two properties are load-bearing and both are tested.
//
//   1. A breach HALTS, it never clamps. An order that would exceed the mandate is refused
//      whole and the mandate stops. Shrinking it to fit would be worse than refusing: the
//      human approved a shape, and quietly executing a different, smaller shape inside it is
//      still executing something nobody agreed to, while looking like it worked.
//
//   2. Getting flat is never blocked. close, reduce, cancel, stand_down and notify are
//      allowed past expiry and past a loss breach, because the rule that noticed the problem
//      must not also be the rule that traps the position. A stop that cannot fire because the
//      account is already down too much is the exact failure this file exists to prevent.
//
// What is NOT here: any notion of a destination. The grammar has no verb that moves value off
// the venue, so there is nothing for this function to allowlist. That absence is structural
// and tests/injection.test.ts holds it.

import type { Action } from './grammar.ts';

export type Mandate = {
  id: string;
  programHash: string;
  symbol: string;
  maxNotionalUsd: number;
  maxLeverage: number;
  maxOrdersPerMin: number;
  maxLossUsd: number;
  expiresAt: string;
  allowedActions: Action['do'][];
};

export type RunState = {
  nowMs: number;
  armedAtMs: number;
  symbol: string;
  positionUsd: number; // absolute notional currently open
  positionSide: 'flat' | 'long' | 'short';
  // When the current position was opened, null while flat. A time stop measures from here
  // rather than from arming, because "out after two hours" means two hours in the trade.
  entryAtMs: number | null;
  realisedUsd: number; // since arming, negative is a loss
  unrealisedUsd: number;
  ordersInLastMin: number;
  programHash: string;
};

export type Ruling = { allow: true } | { allow: false; halt: boolean; reason: string };

// Verbs that reduce or report. None of them can grow a position, so none of them can deepen
// the hole that a breach is complaining about.
const SAFETY: readonly Action['do'][] = ['close', 'reduce', 'cancel', 'stand_down', 'notify'];

function isSafety(a: Action): boolean {
  return SAFETY.includes(a.do);
}

// Notional this action would ADD. A reduce or a close adds nothing, and a stop or target is
// an instruction about an existing position rather than new exposure.
function addedNotionalUsd(a: Action): number {
  if (a.do === 'open') return a.sizeUsd;
  if (a.do === 'add') return a.sizeUsd;
  return 0;
}

function placesOrder(a: Action): boolean {
  return a.do === 'open' || a.do === 'add' || a.do === 'reduce' || a.do === 'close';
}

const refuse = (reason: string, halt: boolean): Ruling => ({ allow: false, halt, reason });

export function checkEnvelope(action: Action, m: Mandate, s: RunState): Ruling {
  // The program identity check comes first. A hash mismatch means the thing about to run is
  // not the thing the human read and clicked, which makes every other check meaningless.
  if (s.programHash !== m.programHash) {
    return refuse(
      `program hash ${s.programHash.slice(0, 12)} does not match the mandate's ${m.programHash.slice(0, 12)}`,
      true,
    );
  }

  if (s.symbol !== m.symbol) {
    return refuse(`mandate covers ${m.symbol}, the runner is on ${s.symbol}`, true);
  }

  if (!m.allowedActions.includes(action.do)) {
    return refuse(`'${action.do}' is not in this mandate's allowed actions`, true);
  }

  const expired = s.nowMs >= Date.parse(m.expiresAt);
  const loss = -(s.realisedUsd + s.unrealisedUsd); // positive when down
  const lossBreached = loss >= m.maxLossUsd;

  // Safety verbs clear the remaining checks deliberately. Everything above still applies to
  // them: a verb the human did not grant stays ungranted, and a hash mismatch still halts.
  if (isSafety(action)) return { allow: true };

  if (expired) {
    return refuse(`mandate expired at ${m.expiresAt}; only closing actions remain`, true);
  }

  if (lossBreached) {
    return refuse(
      `loss ${loss.toFixed(2)} reached the ${m.maxLossUsd.toFixed(2)} limit; only closing actions remain`,
      true,
    );
  }

  // Rate limiting refuses without halting. Being briefly too fast is a pace problem, not a
  // sign the program is wrong, and halting a strategy for it would turn a busy minute into a
  // dead mandate. Every other refusal here means the program asked for something outside what
  // the human granted, which is not a pace problem.
  if (placesOrder(action) && s.ordersInLastMin >= m.maxOrdersPerMin) {
    return refuse(`${s.ordersInLastMin} orders in the last minute is at the ${m.maxOrdersPerMin} limit`, false);
  }

  if (action.do === 'open' || action.do === 'add') {
    if (action.sizeUsd <= 0) return refuse('size must be positive', true);

    const after = s.positionUsd + addedNotionalUsd(action);
    if (after > m.maxNotionalUsd) {
      return refuse(
        `would take notional to ${after.toFixed(2)}, over the ${m.maxNotionalUsd.toFixed(2)} cap`,
        true,
      );
    }
  }

  if (action.do === 'open') {
    if (action.leverage > m.maxLeverage) {
      return refuse(`${action.leverage}x is over the ${m.maxLeverage}x cap`, true);
    }
    if (action.leverage < 1) return refuse('leverage below 1x is not a position', true);
  }

  return { allow: true };
}
