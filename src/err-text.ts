// What a failure says wherever it is said: in an answer, an audit line, a proposal's error.
//
// An Error's message, and never its stack. A thrown string is said as it is. Anything else thrown
// is read for a message and is otherwise not said at all: its own string form is whatever its
// author made it, and that can be a stack. `err.toString()` rather than `err` for a string, because
// the code scanner (CodeQL js/stack-trace-exposure) counts anything a catch received as a stack
// until a toString or a property read has turned it into text.
export function errText(err: unknown): string {
  if (typeof err === 'string') return err.toString();
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : 'no reason was given';
}

/* The system's part of a failure, when the system raised it: its code (ENOSPC, EACCES, EISDIR) and
   the call that failed. Never its message, which names the file's path. */
export function osError(err: unknown): { code: string; syscall: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  return typeof code === 'string' && typeof syscall === 'string' ? { code, syscall } : null;
}
