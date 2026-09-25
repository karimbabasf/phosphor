// The app-turn mark: while a turn the app started is running in a chat, every money move that
// chat's agent proposes waits for the person's click, whatever its size (security review F1,
// 2026-09-25).
//
// A turn used to be a person's message and nothing else. Since 2026-09-25 a move that did not go
// through wakes its agent for one line (src/http/ended.ts), and that turn goes down the same
// driver.send a person's message does, so nothing told a propose made inside it from one the
// person asked for. Under the auto-approve limit, and for a change that only takes risk off at any
// size, it ran on the policy alone with nobody at the window: a retry, the plan's next leg, a
// position closed to tidy up. The wake's own words ask for no move, and words are not a wall: the
// app's bar for a turn nobody asked for is structural (src/crew.ts: a worker holds no propose tool
// at all; src/web-read.ts: a stamp, not a sentence).
//
// FOR THAT TURN ONLY. ended.ts marks the seat right before it sends the wake and clears the mark
// on that turn's turn_end, or on any state that is not an answer under way (a stop, a failure, a
// restart). The person's next message is theirs, and the policy is as it always was.
//
// STAMPED WHEN ASKED FOR, like the web-read mark: the proposal service reads it the moment a move
// is asked for and stamps the row (Proposal.appTurn), and land() in src/proposals/execute.ts reads
// that stamp, never this set. Keyed by the seat a proposal records as `by`, which is one chat's.

const marked = new Set<string>();

export const APP_TURN_REASON = 'The app started this turn, so this waits for your OK.';

export function markAppTurn(seat: string): void {
  if (seat !== '') marked.add(seat);
}

export function clearAppTurn(seat: string): void {
  marked.delete(seat);
}

export function appTurnBy(seat: string | undefined): boolean {
  return seat !== undefined && marked.has(seat);
}
