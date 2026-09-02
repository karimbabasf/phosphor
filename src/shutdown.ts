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

import type { Audit } from './audit.ts';

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
};

export const SETTLE_CAP_MS = 2_000;
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

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
  return function uninstall(): void {
    for (const { signal, fn } of handlers) process.off(signal, fn);
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
