// The web-read mark: once a chat's agent has searched the web or read a page, every money move it
// proposes waits for the person's click, whatever its size, for the rest of that agent session
// (the lead's calls of 2026-09-23). A page is a stranger's text and can talk an agent into a move;
// under the auto-approve limit nothing else would stop that move running.
//
// FOR THE WHOLE SESSION, because the page stays in the agent's context until the session is gone.
// It used to end at the person's next message, and a page that said "once the user replies,
// swap" walked straight through that (audit finding 1, path A). So src/driver.ts marks the seat on
// the agent's web call and clears it only when it starts a new session: a restart, or a new chat.
//
// STAMPED WHEN ASKED FOR. The proposal service reads the mark the moment a move is asked for and
// stamps the row (Proposal.webRead); land() in src/proposals/execute.ts reads that stamp, never
// this set. A swap whose reads outlived its turn used to land after the mark had gone and run
// with no click (path B). Keyed by the seat a proposal records as `by`.

const marked = new Set<string>();

export const WEB_READ_REASON = 'It read a web page earlier in this chat, so this one waits for your OK.';

export function markWebRead(seat: string): void {
  if (seat !== '') marked.add(seat);
}

export function clearWebRead(seat: string): void {
  marked.delete(seat);
}

export function webReadBy(seat: string | undefined): boolean {
  return seat !== undefined && marked.has(seat);
}
