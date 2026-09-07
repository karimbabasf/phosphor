// The one durable write in the app. Every file that holds state goes through it.
//
// tmp-file-then-rename was already the shape in five of the seven writers, and it is only half
// of what durability needs. rename() is atomic in the directory entry, so a reader never sees a
// half-written file, but neither the new file's BYTES nor the directory entry naming them are
// guaranteed to be on the disk when the call returns. A power loss between the write and the
// flush can land the rename and lose the body, and the file that comes back is zero bytes.
//
// That is not theory here. It is the mechanism behind the worst finding in the backend audit:
// proposals.json read as empty, store.readAll's `if (raw.trim().length === 0) return []` treated
// empty as "no proposals", and every proposal, pending and executed alike, vanished with no
// error and nothing to distinguish it from a fresh install. Both halves are closed now. This is
// the half that stops the empty file existing; store.ts refuses to read one.
//
// So: write, fsync the FILE so the bytes are down, close, rename, then fsync the DIRECTORY so
// the entry pointing at them is down too. The directory flush is the step people leave out, and
// without it the rename itself can be lost.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A tmp name in the same directory, because rename is only atomic within one filesystem. The
// leading dot keeps it out of a listing, and the pid plus random suffix keeps two writers (or
// two processes on one data dir) from colliding on the same tmp file.
function tmpNameFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

// Not every filesystem lets you open a directory for fsync (Windows does not), and a failure
// here means the write is atomic but not durable, which is exactly where the code stood before.
// Losing durability is worth reporting, never worth throwing away a successful write for.
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Best effort, as above.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/* Write `contents` to `filePath` so that a reader afterwards sees either the whole of the old
   file or the whole of the new one, and so that a machine losing power sees the same.

   `mode` and `dirMode` exist for one caller: the keystore, whose file has to be 0600 in a 0700
   directory. It wrote its own copy of this function while the two tracks were in flight, for the
   stated reason that a key file could not wait on another branch to be written safely. Folding
   it back in is worth doing rather than leaving two: its copy did not fsync the DIRECTORY after
   the rename, so the rename naming the new key file could itself be lost in a power cut, which
   is the failure this module exists to close. Omit both and the caller gets the process umask,
   which is what every other state file wants. */
export function atomicWrite(
  filePath: string,
  contents: string,
  opts: { mode?: number; dirMode?: number } = {},
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, ...(opts.dirMode === undefined ? {} : { mode: opts.dirMode }) });
  // mkdir's mode is masked by the umask and does nothing at all when the directory already
  // exists, so a caller that asked for a mode gets it stated rather than hoped for.
  if (opts.dirMode !== undefined) fs.chmodSync(dir, opts.dirMode);
  const tmpPath = tmpNameFor(filePath);

  const fd = opts.mode === undefined ? fs.openSync(tmpPath, 'w') : fs.openSync(tmpPath, 'w', opts.mode);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd); // the bytes, before the name that will point at them
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // A rename that fails leaves the tmp file behind, and a data dir slowly filling with
    // .proposals.json.*.tmp is its own problem. The original error is what the caller needs.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // nothing to do
    }
    throw err;
  }

  // Same argument as the directory above: open's mode is umask-masked, so the file's mode is
  // set rather than assumed. It matters here in a way it does not elsewhere: 0644 on a key file
  // is world-readable.
  if (opts.mode !== undefined) fs.chmodSync(filePath, opts.mode);

  syncDir(dir); // the entry, so the rename itself survives a power loss
}

/* The shape every caller in this app actually wants: pretty-printed JSON, durably, and readable
   by its owner alone.

   0600 rather than the process umask, which on a default install is 0644. Every file that goes
   through here is the app's own state in the app's own data directory: the proposal list, the
   audit anchor, the policy, the view and theme, the transaction cache. Between them they carry
   holdings, addresses, amounts and the whole decision history, and world-readable is the wrong
   default for any of it on a machine with a second account on it. The keystore has always passed
   0600 explicitly; there was no reason the rest of the state was different, other than that
   nobody had said so. A caller that genuinely wants a shareable file calls atomicWrite and says
   which mode it wants. */
export function atomicWriteJson(filePath: string, value: unknown, space: number | undefined = 2): void {
  atomicWrite(filePath, JSON.stringify(value, null, space), { mode: 0o600 });
}

/* Push a file this app appended to onto the disk. appendFileSync writes into the page cache and
   returns; the audit log's anchor is written durably a moment later and names those lines, so
   the lines have to be on disk first or a power cut leaves an anchor ahead of its log. Lives here
   so src/ keeps one place that calls fsync for a write. */
export function syncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
