// One Phosphor per data directory.
//
// The damage two backends do to one directory is silent and total: store.put reads the whole
// proposal list, edits it and writes it back, so the second writer rewrites the file without the
// first writer's proposals. A proposal a human approved stops existing and nothing says so.
//
// The last test here is the one that matters most in practice: a lock left behind by a killed
// process must not make the app permanently unstartable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { acquireInstanceLock, InstanceLockedError } from '../../src/instancelock.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-lock-'));
}

/* The lock file holds `<pid> <start time>`. The start time is what tells a recycled pid from the
   original holder: a SIGKILL leaves the file behind, the operating system hands the number to
   something unrelated an hour later, and a pid check alone would make the app permanently
   unstartable in the name of a process that has nothing to do with it. */
function heldPid(dir: string): number {
  return Number.parseInt(fs.readFileSync(path.join(dir, '.lock'), 'utf8').trim(), 10);
}

test('the lock holds this process id', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  assert.equal(heldPid(dir), process.pid);
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});

test('a second lock on the same directory is refused by name', () => {
  const dir = tmpDir();
  const first = acquireInstanceLock(dir);
  assert.throws(() => acquireInstanceLock(dir), (err: unknown) => {
    assert.ok(err instanceof InstanceLockedError);
    assert.equal(err.heldBy, process.pid);
    assert.match(err.message, /already using this data directory/);
    assert.match(err.message, /silently lose proposals/);
    return true;
  });
  first.release();
});

test('two different directories do not contend', () => {
  const one = tmpDir();
  const two = tmpDir();
  const a = acquireInstanceLock(one);
  const b = acquireInstanceLock(two);
  assert.equal(heldPid(one), process.pid);
  assert.equal(heldPid(two), process.pid, 'the second directory has a lock of its own');
  a.release();
  b.release();
  assert.equal(fs.existsSync(path.join(one, '.lock')), false);
  assert.equal(fs.existsSync(path.join(two, '.lock')), false);
});

test('a lock left by a dead process is cleared rather than honoured', () => {
  const dir = tmpDir();
  // A pid that has certainly exited: spawn a process, wait for it, then claim its number.
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = gone.pid;
  assert.ok(typeof deadPid === 'number' && deadPid > 0);
  fs.writeFileSync(path.join(dir, '.lock'), String(deadPid));

  const lock = acquireInstanceLock(dir);
  assert.equal(heldPid(dir), process.pid);
  lock.release();
});

test('a lock file with garbage in it is treated as stale, not as a permanent block', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.lock'), 'not a pid');
  const lock = acquireInstanceLock(dir);
  assert.equal(heldPid(dir), process.pid);
  lock.release();
});

/* THE RECYCLED PID, which is the case a pid alone cannot answer. The lock names a process that
   is alive and is not the one that wrote it, which is what a pid number reused after a SIGKILL
   looks like. Honouring it makes the app permanently unstartable with a message about an
   unrelated process. */
test('a lock naming a live process that started at a different time is stale, not a block', () => {
  const dir = tmpDir();
  // This process is certainly alive, and it certainly did not start in 1999.
  fs.writeFileSync(path.join(dir, '.lock'), `${process.pid} Fri Jan  1 00:00:00 1999`);

  const lock = acquireInstanceLock(dir);
  assert.equal(heldPid(dir), process.pid);
  lock.release();
});

test('a lock file written by an older version, with a pid and nothing else, is still honoured', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.lock'), String(process.pid));
  assert.throws(() => acquireInstanceLock(dir), InstanceLockedError);
  fs.unlinkSync(path.join(dir, '.lock'));
});

test('release never removes a lock another process has taken over', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  fs.writeFileSync(path.join(dir, '.lock'), '999999');
  lock.release();
  assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), '999999');
});

test('release is idempotent, and the second one does not remove somebody else\'s lock', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);

  // Somebody else takes the directory between the two releases, which is the case that makes a
  // second release dangerous rather than merely redundant.
  const next = acquireInstanceLock(dir);
  lock.release();
  assert.equal(heldPid(dir), process.pid, 'the newer lock is still there');
  next.release();
});

// The whole point, end to end: a real second process against one data dir exits with the named
// error rather than quietly running beside the first.
test('a second backend process on one data directory exits with the named error', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  try {
    const second = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { acquireInstanceLock } from ${JSON.stringify(path.join(ROOT, 'src/instancelock.ts'))};
        try {
          acquireInstanceLock(${JSON.stringify(dir)});
          process.exit(0);
        } catch (err) {
          process.stderr.write(err.message + '\\n');
          process.exit(4);
        }
      `,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(second.status, 4, 'the second process refuses rather than running beside the first');
    assert.match(second.stderr, new RegExp(`process ${process.pid}\\) is already using this data directory`));
  } finally {
    lock.release();
  }
});

// ---------- the two races, each closed at the moment it used to open ----------
//
// Neither of these can be written as two calls in one test, because acquireInstanceLock is
// synchronous and a synchronous function cannot interleave with itself. Both use the seams the
// module exposes for exactly this: each one acts at the instant the other process used to.

test('the lock is never observable with nothing in it, so a live holder cannot be read as stale', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.lock');

  /* THE WINDOW. `ps` is a process spawn and it used to run between creating the lock file and
     writing the pid into it, so for those milliseconds the lock existed at zero bytes. A second
     process arriving then read an empty file, parsed no pid, called the lock unreadable and
     therefore stale, and deleted a live holder's claim. This callback runs at that instant and
     asks the one question the second process would have asked. */
  let sawEmptyLock: boolean | null = null;
  const lock = acquireInstanceLock(dir, {
    startedAt: () => {
      sawEmptyLock = fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8').trim() === '';
      return 'Mon Sep  7 10:00:00 2026';
    },
  });

  assert.equal(sawEmptyLock, false, 'no lock file exists yet at the moment the start time is read');
  assert.equal(heldPid(dir), process.pid, 'and when one does exist it already names its holder');
  lock.release();
});

test('a caller that decided a lock was stale will not delete the lock that replaced it', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.lock');
  // A lock left behind by a process that is long gone. Both callers read this one.
  fs.writeFileSync(lockPath, '999999 Mon Sep  7 09:00:00 2026');

  /* The second caller's view of the world. It has just judged the stale lock removable; between
     that judgement and the removal, the first caller cleared the same file and took the
     directory. The old code's unlink named a path and asked no questions, so it deleted a live
     holder's lock and then took the directory for itself: two processes, one data directory,
     and store.put quietly dropping one of them's proposals. */
  let winner: { path: string; release(): void } | null = null;
  assert.throws(
    () =>
      acquireInstanceLock(dir, {
        beforeUnlink: () => {
          if (winner === null) winner = acquireInstanceLock(dir);
        },
      }),
    InstanceLockedError,
    'the second caller refuses rather than removing a lock that is no longer the one it judged',
  );

  assert.equal(heldPid(dir), process.pid, 'the winner still holds the directory');
  winner!.release();
});
