// The lock's clock, and the one exception to it.
//
// AUTO-LOCK IS FED BY HUMAN ACTIVITY ONLY. The window posts /api/activity on pointer and key
// events, at most once every thirty seconds, and that beacon is the only thing that moves the
// timer. An agent reading balances every two seconds does not, and that is the whole design:
// if agent traffic refreshed the timer, a chatty assistant would hold a funded wallet open
// indefinitely, which is exactly the failure the lock exists for. The other direction matters
// too: a lock that a person had to fight would be a lock they turned off.
//
// SLEEP IS A CLOCK JUMP. There is no portable "the machine slept" signal to a Node process, and
// a lid closed for four hours must not come back to an open wallet. The tick runs every fifteen
// seconds, so a gap of more than sixty seconds between ticks means this process was not
// running: suspended, throttled, or stopped in a debugger. All three are reasons to lock.
//
// THE SIGNING SESSION is the exception, and it is deliberately narrow. An armed rule holds one
// key, the Hyperliquid API wallet, which by the venue's own signing split can place orders and
// cannot withdraw, transfer or approve another agent. So a bot that outlives a lock holds
// trading authority and not custody. It carries an expiry a human set when they armed it, and
// when that expires the session goes and the child holding the key is killed.

export const IDLE_LOCK_MS = 15 * 60 * 1000;
export const TICK_MS = 15_000;
// More than four ticks. A missed tick or two is a busy event loop; a minute is a machine that
// was not running.
export const SLEEP_GAP_MS = 60_000;

export const SIGNING_SESSION_DEFAULT_MS = 8 * 60 * 60 * 1000;
export const SIGNING_SESSION_MAX_MS = 24 * 60 * 60 * 1000;

export type LockReason = 'idle' | 'sleep';

export type SigningSession = {
  id: string;
  armedAt: number;
  expiresAt: number;
};

export type Session = {
  // The human moved. Called by /api/activity and by every custody route, because typing a
  // password is a person being present.
  touch(): void;
  // Seconds until the idle lock fires, or null when there is nothing to lock.
  idleLocksInSec(): number | null;
  // One pass of the clock. The interval calls it; a test calls it directly.
  tick(): LockReason | null;
  start(): void;
  stop(): void;

  // ---- the signing session ----
  arm(id: string, requestedMs?: number): SigningSession;
  disarm(id: string): boolean;
  sessionFor(id: string): SigningSession | null;
  armed(): SigningSession[];
  // Sessions whose expiry has passed, removed and returned so the caller can kill what holds
  // their key. Called on every tick.
  expired(): SigningSession[];
};

export type SessionDeps = {
  // What locking actually does. Kept as a callback rather than a keystore handle so this
  // module has no opinion about what a lock is beyond when it happens.
  lock: (reason: LockReason) => void;
  isUnlocked: () => boolean;
  idleMs?: number;
  now?: () => number;
};

export function createSession(deps: SessionDeps): Session {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_LOCK_MS;
  let lastHuman = now();
  let lastTick = now();
  let timer: NodeJS.Timeout | null = null;
  const sessions = new Map<string, SigningSession>();

  function touch(): void {
    lastHuman = now();
  }

  function idleLocksInSec(): number | null {
    if (!deps.isUnlocked()) return null;
    return Math.max(0, Math.ceil((lastHuman + idleMs - now()) / 1000));
  }

  function tick(): LockReason | null {
    const at = now();
    const gap = at - lastTick;
    lastTick = at;

    /* Order matters. The sleep check runs first and does NOT consult the idle timer, because a
       machine that slept for four hours also has a stale lastHuman: reporting that as an idle
       lock would be true and useless. A person wants to read "it locked because the lid was
       closed". */
    if (gap > SLEEP_GAP_MS) {
      // The human clock restarts from here whatever happens, or the next tick would lock again
      // for a gap that has already been answered.
      lastHuman = at;
      if (deps.isUnlocked()) {
        deps.lock('sleep');
        return 'sleep';
      }
      return null;
    }
    if (deps.isUnlocked() && at - lastHuman >= idleMs) {
      deps.lock('idle');
      return 'idle';
    }
    return null;
  }

  function start(): void {
    if (timer !== null) return;
    lastTick = now();
    timer = setInterval(() => void tick(), TICK_MS);
    // The lock's clock must never be the reason the process stays alive.
    timer.unref?.();
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  return {
    touch,
    idleLocksInSec,
    tick,
    start,
    stop,

    arm(id, requestedMs) {
      /* Clamped rather than refused. A human asking for a week gets a day and is told so on the
         armed row, which is a better answer than a form error: the number they wanted was a
         statement about how long they expect to be away, and the ceiling is the app's own
         statement about how long an unattended trading key may live. */
      const asked = typeof requestedMs === 'number' && Number.isFinite(requestedMs) && requestedMs > 0
        ? requestedMs
        : SIGNING_SESSION_DEFAULT_MS;
      const at = now();
      const session: SigningSession = { id, armedAt: at, expiresAt: at + Math.min(asked, SIGNING_SESSION_MAX_MS) };
      sessions.set(id, session);
      return session;
    },

    disarm(id) {
      return sessions.delete(id);
    },

    sessionFor(id) {
      const held = sessions.get(id);
      if (held === undefined) return null;
      if (now() >= held.expiresAt) {
        sessions.delete(id);
        return null;
      }
      return held;
    },

    armed() {
      return [...sessions.values()].filter((s) => now() < s.expiresAt);
    },

    expired() {
      const at = now();
      const done: SigningSession[] = [];
      for (const [id, session] of [...sessions]) {
        if (at < session.expiresAt) continue;
        sessions.delete(id);
        done.push(session);
      }
      return done;
    },
  };
}
