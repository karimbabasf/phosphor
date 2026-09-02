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

test('the lock holds this process id', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), String(process.pid));
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
  const a = acquireInstanceLock(tmpDir());
  const b = acquireInstanceLock(tmpDir());
  a.release();
  b.release();
});

test('a lock left by a dead process is cleared rather than honoured', () => {
  const dir = tmpDir();
  // A pid that has certainly exited: spawn a process, wait for it, then claim its number.
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = gone.pid;
  assert.ok(typeof deadPid === 'number' && deadPid > 0);
  fs.writeFileSync(path.join(dir, '.lock'), String(deadPid));

  const lock = acquireInstanceLock(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), String(process.pid));
  lock.release();
});

test('a lock file with garbage in it is treated as stale, not as a permanent block', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.lock'), 'not a pid');
  const lock = acquireInstanceLock(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), String(process.pid));
  lock.release();
});

test('release never removes a lock another process has taken over', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  fs.writeFileSync(path.join(dir, '.lock'), '999999');
  lock.release();
  assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), '999999');
});

test('release is idempotent', () => {
  const dir = tmpDir();
  const lock = acquireInstanceLock(dir);
  lock.release();
  lock.release();
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
