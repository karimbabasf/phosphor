// Why the wallet locked, as one of a few fixed codes, for the lock screen's line under its title.
//
// The shell posts its reason as a sentence (src-tauri/src/session_watch.rs) and the idle clock
// names its own (src/keystore/session.ts). Only the codes below ever leave this module: the
// request's own text is never kept, so nothing a caller writes reaches /api/state. A reason this
// table does not know gives no code, and the screen then says nothing rather than guess.
//
// A lock the person asked for (Lock now, quitting, the window closing) has no code either: they
// know why. The code lives only while the wallet stays locked and goes at the next unlock.

import type { LockState } from './store.ts';

export type LockCode = 'screen' | 'switch' | 'idle' | 'sleep';

const FROM_SHELL: ReadonlyMap<string, LockCode> = new Map([
  ['the screen locked', 'screen'],
  ['this Mac switched to another user', 'switch'],
]);

export function lockCodeOf(reason: unknown): LockCode | null {
  return typeof reason === 'string' ? (FROM_SHELL.get(reason) ?? null) : null;
}

export type LockReason = {
  // Called right after a lock that really happened, with its code or null.
  note: (code: LockCode | null) => void;
  // The code, while the wallet is locked; null otherwise.
  code: () => LockCode | null;
};

type Lockable = { state: () => LockState; onChange?: (fn: (state: LockState) => void) => () => void };

// One per keystore, so the server's routes and the idle clock built in main.ts share it.
const held = new WeakMap<object, LockReason>();

export function lockReasonFor(keystore: Lockable): LockReason {
  const known = held.get(keystore);
  if (known !== undefined) return known;
  let code: LockCode | null = null;
  if (typeof keystore.onChange === 'function') {
    keystore.onChange((state) => {
      if (state !== 'locked') code = null;
    });
  }
  const reason: LockReason = {
    note: (next) => {
      code = next;
    },
    code: () => (keystore.state() === 'locked' ? code : null),
  };
  held.set(keystore, reason);
  return reason;
}
