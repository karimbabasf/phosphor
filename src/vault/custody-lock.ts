// One custody step at a time, per wallet file.
//
// A bind is several steps across a Touch ID: a key is made, a file is staged, the enclave opens
// it, the marker is written, the file is put in place. An unlock, a reveal or an approval that
// read the live file in the middle of that would ask the enclave about a file that is about to be
// replaced, and then open the new file with the old one's data key. So every step that asks the
// enclave about the live file and opens it, and every step that replaces the file, runs under this
// lock, in the order asked. Nothing here is a control against another process: it orders this
// process's own steps.

export type CustodyLock = {
  run<T>(step: () => Promise<T>): Promise<T>;
  // A step is running or waiting.
  busy(): boolean;
};

const locks = new WeakMap<object, CustodyLock>();

function invoke<T>(step: () => Promise<T>): Promise<T> {
  try {
    return step();
  } catch (err) {
    return Promise.reject(err);
  }
}

// One lock per keystore object, so every route and the approval path share it without a new field
// on the context.
export function custodyLock(keystore: object): CustodyLock {
  const known = locks.get(keystore);
  if (known !== undefined) return known;
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;
  const lock: CustodyLock = {
    run<T>(step: () => Promise<T>): Promise<T> {
      // Free, the step starts now, in this turn: an approval's request reaches the relay before
      // approve() returns, as it always has. Taken, it waits its turn.
      const now = depth === 0;
      depth += 1;
      const turn = now ? invoke(step) : tail.then(step, step);
      tail = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn.finally(() => {
        depth -= 1;
      });
    },
    busy: () => depth > 0,
  };
  locks.set(keystore, lock);
  return lock;
}
