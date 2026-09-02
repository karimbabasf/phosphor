// One Phosphor per data directory, enforced by the filesystem.
//
// Nothing did this before. Two backends on one data dir were prevented only by the Tauri shell
// probing the port before it spawned, which is check-then-act and covers nothing at all under
// `npm run app` twice with a different port and the same PHOSPHOR_DATA_DIR. The damage is
// silent: store.put is read-modify-write over the whole proposal list, so the second writer
// reads a list without the first writer's proposal and rewrites the file without it. A
// proposal a human approved simply stops existing, and nothing reports it.
//
// `wx` is the whole mechanism: open-for-write-and-fail-if-it-exists is one atomic syscall, so
// two processes racing at boot cannot both win. The pid inside is what makes a lock left by a
// killed process recoverable rather than permanent, and the START TIME beside it is what stops a
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

/* Take the lock, or throw InstanceLockedError naming the process that holds it.
   A lock file whose pid is dead, or whose contents are unreadable, is stale: a SIGKILL leaves
   one behind and it must not make the app permanently unstartable. It is removed and the open
   is retried exactly once, so two processes both finding the same stale lock still end with one
   winner rather than two. */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.lock');

  function open(): number | null {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  }

  let fd = open();
  if (fd === null) {
    const holder = readHolder(lockPath);
    if (holder !== null && stillHeld(holder)) throw new InstanceLockedError(holder.pid, lockPath);
    // Stale, or unreadable and therefore useless as a claim. Clear it and try once more.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Someone else got there first; the retry below will find their lock and refuse.
    }
    fd = open();
    if (fd === null) {
      const now = readHolder(lockPath);
      throw new InstanceLockedError(now?.pid ?? 0, lockPath);
    }
  }

  const startedAt = pidStartedAt(process.pid);
  try {
    fs.writeFileSync(fd, startedAt === null ? String(process.pid) : `${process.pid} ${startedAt}`);
  } finally {
    fs.closeSync(fd);
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
