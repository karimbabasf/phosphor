// The last line of defence: the two process events that end a Node process outright.
//
// Node 24 terminates on an unhandled rejection and on an uncaught exception, and nothing in
// src/ listened for either. A backend holding live keys died with a raw stack written to stdio
// the Tauri shell inherits to nowhere, so the window kept its last render and every fetch after
// it failed in silence. There were eight known paths into this, and the kill switch was one of
// them: flipping it onto a dead runner child threw out of a `void` call.
//
// What a handler does here is deliberately small: write one audit line, mirror it to stderr
// because nobody is tailing a JSONL file, then exit nonzero so the supervisor above knows the
// difference between a clean stop and a fall. It does NOT keep the process alive. An uncaught
// exception has already left whatever it escaped from half finished, and a process that signs
// transactions is the last place to guess about that.

import type { Audit } from './audit.ts';

export type CrashDeps = {
  audit: Pick<Audit, 'append'>;
  // Seams, for the test that has to observe a crash without taking the test runner with it.
  exit?: (code: number) => void;
  stderr?: (line: string) => void;
  // Ran after the crash is recorded and before the exit. Best effort by definition: whatever
  // this does, it runs on a process that is already going down.
  onFatal?: () => void;
};

export function describeFault(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type FaultKind = 'uncaughtException' | 'unhandledRejection';

/* The reporting itself, separated from the process wiring so a test can drive it. Emitting a
   real 'uncaughtException' inside node:test is not a usable test: the runner registers its own
   listener and fails the case before ours is reached. */
export function createFaultReporter(deps: CrashDeps): (kind: FaultKind, err: unknown) => void {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const write = deps.stderr ?? ((line: string): void => void process.stderr.write(line + '\n'));
  let crashing = false;

  return function fatal(kind: FaultKind, err: unknown): void {
    // A second fault raised while reporting the first must not recurse. The likeliest cause is
    // the audit file itself (a full disk is the whole reason P0-9 could kill the app from
    // inside a catch block), and recursing there would loop instead of exiting.
    if (crashing) {
      write(`phosphor: a second fault while reporting the first: ${describeFault(err)}`);
      exit(1);
      return;
    }
    crashing = true;

    const detail = describeFault(err);
    const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : null;
    write(`phosphor: ${kind}: ${detail}`);
    if (stack !== null) write(stack);

    try {
      deps.audit.append('error', `${kind}: ${detail}`, stack === null ? undefined : { stack });
    } catch (writeErr) {
      write(`phosphor: the fault could not be written to the audit log: ${describeFault(writeErr)}`);
    }
    try {
      deps.onFatal?.();
    } catch {
      // Nothing left to try. stderr already carries the fault that brought us here.
    }
    exit(1);
  };
}

export function installCrashHandlers(deps: CrashDeps): () => void {
  const fatal = createFaultReporter(deps);
  const onException = (err: unknown): void => fatal('uncaughtException', err);
  const onRejection = (reason: unknown): void => fatal('unhandledRejection', reason);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  return function uninstall(): void {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
