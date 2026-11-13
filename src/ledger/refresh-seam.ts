// THE refresh seam (src/main.ts builds the one there is): every caller that wants the ledger read
// again comes through here, the poll, an `executed` line, the deposit watch, the unlock.
//
// Two refreshes at once would be two sets of RPC calls racing to write the same snapshot, and the
// loser's answer is the older one. A caller arriving mid-flight joins the read already running
// instead of starting a second, which is how a 3 s watch loop and the 15 s loop used to race each
// other into a flashing warning.

export type RefreshSeam = {
  // The pass in flight, or a new one.
  now(): Promise<void>;
  /* A pass that reads what is true NOW. A pass already in flight may have named its accounts before
     the change that asked for this one (the unlock that names the allowance), so it is waited out
     and the ledger read once more behind it. */
  again(): Promise<void>;
  busy(): boolean;
};

// `landed` runs after every pass that answered (src/main.ts broadcasts the state); a failed pass
// keeps what is on screen and says nothing here.
export function refreshSeam(read: () => Promise<unknown>, landed: () => void): RefreshSeam {
  let refreshing: Promise<void> | null = null;

  /* THE GUARD IS ARMED BEFORE THE READ, not after it. `refreshing = ledger.refresh()...` assigns
     only once refresh() has returned, and a refresh is not always asynchronous: demo mode tells
     its listeners inside the call. One of those listeners settles a proposal, settling writes an
     audit line, and the subscriber in src/main.ts turns an `executed` line back into a refresh,
     which arrived here while `refreshing` was still null and started another pass. 820 settles of
     one deposit in 103 ms, and the app answered nothing for thirteen seconds at the moment the
     money landed. */
  function now(): Promise<void> {
    if (refreshing !== null) return refreshing;
    let finished: () => void = () => {};
    refreshing = new Promise<void>(resolve => {
      finished = resolve;
    });
    // Called now, inside this call, as it always was; a throw becomes a failed pass.
    void (async () => read())()
      .then(landed)
      .catch(() => undefined)
      .finally(() => {
        refreshing = null;
        finished();
      });
    return refreshing;
  }

  return {
    now,
    again: () => (refreshing === null ? now() : refreshing.then(now)),
    busy: () => refreshing !== null,
  };
}
