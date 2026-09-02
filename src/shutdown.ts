// Stopping on purpose, as opposed to falling over.
//
// The backend usually had no signal handler at all. `armExitGuard` in driver.ts registered the
// only ones, and it was called from `start()`, which only runs when somebody opens a chat, and
// `driver.autostart` defaults false. So on an ordinary install the Tauri shell's SIGTERM hit
// node's default action: the process died wherever it happened to be, mid rail, mid write. Even
// when the guard was armed it was `killSync(); process.exit(0)`, which awaits nothing.
//
// Three steps, in this order, and the order is the whole design:
//   1. DRAIN. New writes get 503 immediately. Whatever is in flight keeps its turn; what has not
//      started never will, which is better than starting it two hundred milliseconds before the
//      process ends.
//   2. SETTLE, with a hard cap. The proposal chain is awaited so a broadcast in progress gets to
//      finish writing its row. The cap is what stops a hung rail turning "quit" into "hang":
//      past it we stop waiting and say we stopped waiting.
//   3. CLOSE. Sockets, the runner child, the agent processes.
//
// Signals are registered UNCONDITIONALLY at boot, not from whichever subsystem happened to start.
//
// A fourth reason to run all three arrives without a signal: the window going away. See
// watchParent below.

import type { Audit } from './audit.ts';
import { VENUE_WRITE_TIMEOUT_MS } from './net.ts';

export type ShutdownDeps = {
  audit: Pick<Audit, 'append'>;
  // Stop accepting new writes. Runs first and must not be async: everything after it is allowed
  // to take time, and this is the step that must not.
  drain: () => void;
  // Wait for work already in flight. Resolves true if it finished inside the cap.
  settle: (capMs: number) => Promise<boolean>;
  // Sockets, children, timers. Best effort; a throw here does not stop the exit.
  close: () => Promise<void>;
  capMs?: number;
  exit?: (code: number) => void;
  stderr?: (line: string) => void;
  // Test seam for the parent watch below. Absent means the real thing: process.ppid, a five
  // second tick, and process.kill(pid, 0).
  parentWatch?: ParentWatch;
};

/* Long enough to cover ONE venue write, which is what the drain exists for.
   It was two seconds while a venue write gets thirty (src/net.ts), so a quit during a real send
   always timed the drain out and stranded the row with an unknown outcome: the drain was
   decorative for exactly the case it was written for. The cost of the longer cap is paid only
   when something is actually in flight, because serialise.idle() resolves at once when nothing
   is, and a second signal (a person pressing ctrl-C again) still stops the wait immediately. */
export const SETTLE_CAP_MS = VENUE_WRITE_TIMEOUT_MS + 2_000;
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export const PARENT_POLL_MS = 5_000;

export type ParentWatch = {
  enabled?: boolean;
  intervalMs?: number;
  // Reads the CURRENT parent. Defaults to process.ppid, which changes the moment this process
  // is reparented, which is the moment the process that started it went away.
  ppid?: () => number;
  alive?: (pid: number) => boolean;
};

function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which is still alive. Only ESRCH is
    // the answer this is looking for.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* THE SHELL DIES AND NODE DOES NOT, which is the orphan this closes.
   src-tauri/src/main.rs registers no signal handler, so on SIGTERM the shell takes the default
   action: neither `impl Drop for Backend` nor RunEvent::Exit runs, and this process is left
   holding the port with the wallet loaded. Seen twice on 2026-09-01.
   Fixed on the node side and not the Rust side, because it costs no new crate and because a
   backend outliving its window is wrong however the window went. A crash, a Force Quit and a
   SIGKILL leave the same orphan and none of them can run Rust either.

   The signal is the parent pid. When the process that started this one goes, this one is
   reparented (to launchd on macOS, to init or a subreaper on Linux), so process.ppid stops
   matching what it was at boot. Both halves are checked: the reparent is the thing that always
   happens, and a pid that no longer answers is the thing that is unambiguous.

   PHOSPHOR_NO_PARENT_WATCH=1 turns it off, for anything that starts a backend from a parent
   meant to exit first. */
export function watchParent(deps: ParentWatch & { onGone: (why: string) => void }): () => void {
  const enabled = deps.enabled ?? process.env.PHOSPHOR_NO_PARENT_WATCH !== '1';
  if (!enabled) return () => {};

  const read = deps.ppid ?? ((): number => process.ppid);
  const alive = deps.alive ?? pidIsAlive;
  const started = read();
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;
    const now = read();
    const why =
      now !== started
        ? `the process that started phosphor (pid ${started}) is gone and this one was reparented to ${now}`
        : !alive(started)
          ? `the process that started phosphor (pid ${started}) is gone`
          : null;
    if (why === null) return;
    fired = true;
    deps.onGone(why);
  }, deps.intervalMs ?? PARENT_POLL_MS);
  // Never a reason on its own for this process to stay up. The HTTP server is what holds it.
  timer.unref?.();
  return () => clearInterval(timer);
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const write = deps.stderr ?? ((line: string): void => void process.stderr.write(line + '\n'));
  const capMs = deps.capMs ?? SETTLE_CAP_MS;
  let running = false;

  return async function shutdown(signal: string): Promise<void> {
    // A second signal while the first is being handled is somebody pressing ctrl-C again
    // because it is taking too long. Honour that: stop waiting and go now.
    if (running) {
      write(`phosphor: ${signal} again, stopping without waiting for work in flight`);
      exit(1);
      return;
    }
    running = true;
    write(`phosphor: ${signal}, shutting down`);

    deps.drain();

    let settled = false;
    try {
      settled = await deps.settle(capMs);
    } catch (err) {
      write(`phosphor: waiting for work in flight failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      deps.audit.append(
        'app_start',
        settled
          ? `phosphor stopped on ${signal} with nothing left in flight`
          : `phosphor stopped on ${signal} while work was still in flight after ${capMs}ms; check the transaction history`,
        { signal, settled },
      );
    } catch {
      // stderr already carries the sentence.
    }
    if (!settled) {
      write(`phosphor: something was still running after ${capMs}ms. Check the transaction history for an unknown outcome.`);
    }

    try {
      await deps.close();
    } catch (err) {
      write(`phosphor: closing down failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    exit(0);
  };
}

export function installShutdownHandlers(deps: ShutdownDeps): () => void {
  const shutdown = createShutdown(deps);
  const handlers = SIGNALS.map((signal) => {
    // Registering a listener replaces node's default action for that signal, so the handler has
    // to exit explicitly or the app stops responding to the signal meant to end it.
    const fn = (): void => void shutdown(signal);
    process.on(signal, fn);
    return { signal, fn };
  });
  /* The same three steps, reached without a signal. The window going away is a reason to stop
     that no signal ever arrives for, so it goes through the one shutdown closure rather than a
     second copy: a SIGTERM racing a dead parent must not run the drain twice. */
  const stopWatch = watchParent({
    ...deps.parentWatch,
    onGone: (why) => void shutdown(why),
  });
  return function uninstall(): void {
    for (const { signal, fn } of handlers) process.off(signal, fn);
    stopWatch();
  };
}

// Race a promise against a deadline. Returns true if it won.
export function within(capMs: number, work: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), capMs);
    timer.unref?.();
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true); // it finished; that it finished badly is the caller's business
      },
    );
  });
}
