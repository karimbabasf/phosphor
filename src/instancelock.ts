// One Phosphor per data directory, enforced by the filesystem.
//
// Nothing did this before. Two backends on one data dir were prevented only by the Tauri shell
// probing the port before it spawned, which is check-then-act and covers nothing at all under
// `npm run app` twice with a different port and the same PHOSPHOR_DATA_DIR. The damage is
// silent: store.put is read-modify-write over the whole proposal list, so the second writer
// reads a list without the first writer's proposal and rewrites the file without it. A
// proposal a human approved simply stops existing, and nothing reports it.
//
// An atomic create is the whole mechanism. The lock file is built complete under a temporary
// name and then link()ed into place: link fails when the target exists, so two processes racing
// at boot cannot both win, and unlike the plain `wx` open this replaced there is no instant at
// which the lock exists with nothing in it. The pid inside is what makes a lock left by a killed
// process recoverable rather than permanent, and the START TIME beside it is what stops a
// recycled pid making the app permanently unstartable in the name of an unrelated process.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type InstanceLock = {
  path: string;
  release(): void;
};

export class InstanceLockedError extends Error {
  readonly heldBy: number;
  constructor(heldBy: number, lockPath: string) {
    super(
      `another Phosphor (process ${heldBy}) is already using this data directory. ` +
        `Two of them on one directory silently lose proposals, so this one will not start. ` +
        `Quit the other window, or if process ${heldBy} is gone, delete ${lockPath}.`,
    );
    this.name = 'InstanceLockedError';
    this.heldBy = heldBy;
  }
}

// Is that pid a process that still exists? Signal 0 performs the permission and existence
// checks and delivers nothing. EPERM means the process exists and belongs to someone else,
// which still counts as alive: it is a running process, not a stale file.
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* WHEN that pid started, which is what tells a recycled pid from the original holder.
   A pid alone cannot: a SIGKILL leaves the lock file behind, the operating system hands the
   number to something unrelated an hour later, and the app is then permanently unstartable with
   a message naming a process that has nothing to do with it. A start time is the cheapest thing
   that distinguishes them and it needs no dependency: ps reports it on macOS and on Linux.
   Null when ps is unavailable or says nothing, and a null on either side means the comparison is
   skipped and the pid alone decides, which is exactly the old behaviour. */
function pidStartedAt(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

type Holder = { pid: number; startedAt: string | null };

/* The lock file holds `<pid> <start time>` now, and used to hold the pid alone. An old file is
   read as a pid with an unknown start time, which is the same answer this returns when ps cannot
   help, so an app upgraded while holding a lock still reads its own file. */
function readHolder(lockPath: string): Holder | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const space = raw.indexOf(' ');
    return { pid, startedAt: space === -1 ? null : raw.slice(space + 1).trim() || null };
  } catch {
    return null;
  }
}

// Held means the pid is alive AND, when both sides know it, started when the lock says it did.
function stillHeld(holder: Holder): boolean {
  if (!pidIsAlive(holder.pid)) return false;
  if (holder.startedAt === null) return true; // an older lock file, or a machine with no ps
  const now = pidStartedAt(holder.pid);
  return now === null || now === holder.startedAt;
}

/* Test seams. Both name a moment the two old races lived in, and neither exists to make the
   code easier to read: the races are between two PROCESSES, and a synchronous function cannot
   interleave with itself, so without a way to act at those two instants the only test possible
   would be spawning children and hoping the timing lands. */
export type LockSeams = {
  // What computes this process's start time. Called BEFORE the lock file is created now; the
  // old order called it in between creating the file and writing to it.
  startedAt?: (pid: number) => string | null;
  // Called after this caller decides an existing lock is stale and before it removes it. The
  // window another process used to be able to take the lock in.
  beforeUnlink?: () => void;
};

/* Take the lock, or throw InstanceLockedError naming the process that holds it.
   A lock file whose pid is dead, or whose contents are unreadable, is stale: a SIGKILL leaves
   one behind and it must not make the app permanently unstartable. It is removed and the open
   is retried exactly once, so two processes both finding the same stale lock still end with one
   winner rather than two.

   TWO RACES CLOSED HERE, both found by reading and both a few milliseconds wide, which is
   exactly the width of a shell relaunching after a crash.

   1. THE EMPTY FILE. `wx` created the lock and the pid was written to it afterwards, with a call
      out to `ps` in between, so for the length of a process spawn the lock existed at zero
      bytes. A second process arriving in that window got EEXIST, read an empty file, parsed no
      pid, concluded the lock was unreadable and therefore stale, and deleted a LIVE holder's
      lock. The file is now built complete under a temporary name and put in place with link(),
      which fails when the target exists and is atomic. A lock file at this path is therefore
      never observable in a state that has no pid in it.

      link() rather than rename(): rename REPLACES whatever is at the target, so two processes
      renaming into place would both succeed and both believe they held the directory, which is
      the failure this whole module exists to prevent. link() is the primitive that means "create
      this name, only if it does not exist", with the content already in it.

   2. THE UNCONDITIONAL UNLINK. Both processes reading the same stale lock is not a race at all
      under the old code: the first removes it and takes the lock, and the second then removes
      the FIRST's fresh lock, because the unlink named a path and asked no questions. The removal
      is now a compare-and-delete: the file is read again immediately before it goes, and
      anything other than the exact bytes this caller judged stale is left alone. */
export function acquireInstanceLock(dataDir: string, seams: LockSeams = {}): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.lock');

  // Everything slow happens before the lock exists, which is half of race 1: `ps` is a process
  // spawn, and it used to run with the lock already created and still empty.
  const startedAt = (seams.startedAt ?? pidStartedAt)(process.pid);
  const body = startedAt === null ? String(process.pid) : `${process.pid} ${startedAt}`;

  /* Create the file under a name nobody looks at, fill it, then claim the real name in one
     atomic step. The temp name carries the pid and eight random characters so two attempts
     cannot collide on it, and it is removed whichever way this goes. */
  function claim(): boolean {
    const tmpPath = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    /* No fsync, deliberately, and src/fsatomic.ts stays the app's only durable writer. What this
       file needs is atomicity against another PROCESS, which link() gives whether or not the
       bytes have reached the platter. Durability across a power cut is worth nothing here: the
       holder is dead on the other side of one, and its lock is stale by definition. */
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      fs.writeFileSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmpPath, lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Nothing to clean up, which is the state we wanted.
      }
    }
  }

  // The exact bytes, not the parsed holder: two different holders can parse to the same pid
  // when neither start time is readable, and the point of this read is to prove the file has
  // not been replaced since the decision to remove it was made.
  function rawLock(): string | null {
    try {
      return fs.readFileSync(lockPath, 'utf8');
    } catch {
      return null;
    }
  }

  if (!claim()) {
    const raw = rawLock();
    const holder = raw === null ? null : readHolder(lockPath);
    if (holder !== null && stillHeld(holder)) throw new InstanceLockedError(holder.pid, lockPath);

    // Stale, or unreadable and therefore useless as a claim. Clear it and try once more.
    seams.beforeUnlink?.();
    if (raw !== null && rawLock() === raw) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else got there first; the retry below will find their lock and refuse.
      }
    }
    if (!claim()) {
      const now = readHolder(lockPath);
      throw new InstanceLockedError(now?.pid ?? 0, lockPath);
    }
  }

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      // Only ever remove a lock this process actually holds. A release that ran after another
      // process had taken over a stale lock would hand the directory to a third.
      if (readHolder(lockPath)?.pid !== process.pid) return;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone, which is the state we wanted.
      }
    },
  };
}
