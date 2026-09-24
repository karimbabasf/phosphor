// The web-read mark: once a chat's agent has searched the web or read a page, every money move it
// proposes waits for the person's click, whatever its size, until the person's next message
// (the lead's call, 2026-09-23). A page is a stranger's text and can talk an agent into a move;
// under the auto-approve limit nothing else would stop that move running.
//
// Keyed by the seat a proposal records as `by`. src/driver.ts marks the seat on the agent's web
// call and clears it when a message of the person's starts its turn; land() in
// src/proposals/execute.ts reads it. One exception to the clearing: a turn the person stopped may
// still have a proposal of its own being priced, so the turn after a stopped one keeps the mark,
// and the message after that clears it.

const marked = new Set<string>();

export const WEB_READ_REASON = 'It read a web page this turn, so this one waits for your OK.';

export function markWebRead(seat: string): void {
  if (seat !== '') marked.add(seat);
}

export function clearWebRead(seat: string): void {
  marked.delete(seat);
}

export function webReadBy(seat: string | undefined): boolean {
  return seat !== undefined && marked.has(seat);
}
