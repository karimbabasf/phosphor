// The invite file: the treasury's key and every live code, encrypted under a passphrase typed at
// a no-echo prompt on each run. Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md,
// "The invite file".
//
// ~/.phosphor-invites/invites.enc.json by default, mode 0600 in a 0700 directory, never inside the
// working copy (the repo is public). AES-256-GCM under a key from scrypt (N = 2^17, r = 8, p = 1,
// a 32-byte salt) of a passphrase of at least 20 characters. It is the only copy of T's key: lose
// it and the reclaim and whatever sits in T are gone, while holders can still claim their codes.
//
// FAILS CLOSED. A wrong passphrase, a changed byte anywhere, a truncated file, a header asking
// for other scrypt costs: each is a refusal before anything is signed, and the file is never
// rewritten by a run that could not read it. The header is bound into the GCM tag as associated
// data, and its scrypt costs are checked against the one setting this file is ever written with
// BEFORE the KDF runs, so an edited N is a refusal rather than an out-of-memory crash.
//
// NEVER PLAINTEXT ON DISK. The book is sealed in memory and only the sealed envelope is written,
// through src/fsatomic.ts: a 0600 temp file beside the target, fsync, rename, fsync the directory.
// A crash leaves the old file or the new one, never half of one and never the book in the clear.
//
// THE LOCK. One invite command at a time on one file: a lock file beside it, created exclusively,
// holding the pid. It is never broken automatically; a run that finds one says whose it is.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveReal } from '../../src/config.ts';
import { atomicWrite } from '../../src/fsatomic.ts';
import { readBook } from './book.ts';
import type { InviteBook } from './book.ts';

export const INVITE_FILE_ENV = 'PHOSPHOR_INVITES_FILE';
export const MIN_PASSPHRASE_CHARS = 20;

const FORMAT = 'phosphor-invites';
const FILE_VERSION = 1;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// scrypt takes 128 * N * r bytes (128 MiB here); node:crypto refuses past 32 MiB unless told.
const SCRYPT_MAXMEM = 2 * 128 * SCRYPT_N * SCRYPT_R;

export function defaultInviteFile(home: string = os.homedir()): string {
  return path.join(home, '.phosphor-invites', 'invites.enc.json');
}

/* Where the file is: the --file flag, else PHOSPHOR_INVITES_FILE, else the default. Refused inside
   the working copy, compared the way the filesystem sees both paths (src/config.ts resolveReal),
   because the repo is public and a file in it is one `git add -f` from being published. */
export function inviteFilePath(flag: string | undefined, env: NodeJS.ProcessEnv, repoRoot: string, home?: string): string {
  const chosen = flag ?? env[INVITE_FILE_ENV];
  const file = path.resolve(chosen !== undefined && chosen.trim() !== '' ? chosen : defaultInviteFile(home));
  const rel = path.relative(resolveReal(repoRoot), resolveReal(file));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`The invite file must sit outside the repo working copy (got ${file}). The repo is public; keep the file in your home directory.`);
  }
  return file;
}

// Characters, not bytes: a passphrase in another script is not shorter for being multi-byte.
export function passphraseChars(passphrase: Uint8Array): number {
  let count = 0;
  for (const byte of passphrase) if ((byte & 0xc0) !== 0x80) count += 1;
  return count;
}

type Header = { format: typeof FORMAT; version: typeof FILE_VERSION; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string } };
type Envelope = Header & { cipher: { name: 'aes-256-gcm'; iv: string; tag: string }; data: string };

// The header as associated data, in a fixed order, so an edit to any of it fails the tag.
function aadOf(header: Header): Buffer {
  const k = header.kdf;
  return Buffer.from(JSON.stringify([header.format, header.version, k.name, k.N, k.r, k.p, k.salt, 'aes-256-gcm']), 'utf8');
}

function deriveKey(passphrase: Uint8Array, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

function seal(key: Buffer, header: Header, book: InviteBook): Envelope {
  const iv = crypto.randomBytes(IV_BYTES);
  const plain = Buffer.from(JSON.stringify(book), 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadOf(header));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { ...header, cipher: { name: 'aes-256-gcm', iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }, data: data.toString('base64') };
  } finally {
    plain.fill(0);
  }
}

const DAMAGED = 'The invite file is damaged or was changed: it does not read as an invite file. Nothing was changed.';
const WRONG = 'The passphrase is wrong, or the invite file was changed. Nothing was changed.';

/* The envelope off disk with every field the shape this module writes, or a refusal. The scrypt
   costs must be exactly the ones above: this module is the file's only writer. */
function readEnvelope(text: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(DAMAGED);
  }
  const e = raw as Record<string, unknown> | null;
  const kdf = e?.['kdf'] as Record<string, unknown> | undefined;
  const cipher = e?.['cipher'] as Record<string, unknown> | undefined;
  const ok =
    e !== null &&
    typeof e === 'object' &&
    e['format'] === FORMAT &&
    e['version'] === FILE_VERSION &&
    kdf !== undefined &&
    kdf !== null &&
    kdf['name'] === 'scrypt' &&
    kdf['N'] === SCRYPT_N &&
    kdf['r'] === SCRYPT_R &&
    kdf['p'] === SCRYPT_P &&
    typeof kdf['salt'] === 'string' &&
    /^[0-9a-f]{64}$/.test(kdf['salt']) &&
    cipher !== undefined &&
    cipher !== null &&
    cipher['name'] === 'aes-256-gcm' &&
    typeof cipher['iv'] === 'string' &&
    /^[0-9a-f]{24}$/.test(cipher['iv']) &&
    typeof cipher['tag'] === 'string' &&
    /^[0-9a-f]{32}$/.test(cipher['tag']) &&
    typeof e['data'] === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(e['data']);
  if (!ok) throw new Error(DAMAGED);
  return raw as Envelope;
}

export type InviteFile = {
  path: string;
  book: InviteBook;
  // Seal the book as it stands now and replace the file atomically. Throws when the write fails,
  // so a caller that must have something on disk before it signs or sends can stop.
  save(): void;
  // Forget the key. The book stays readable in memory; nothing more can be written.
  close(): void;
};

function handle(file: string, key: Buffer, header: Header, book: InviteBook): InviteFile {
  let open = true;
  const out: InviteFile = {
    path: file,
    book,
    save() {
      if (!open) throw new Error('the invite file was closed');
      writeEnvelope(file, seal(key, header, out.book));
    },
    close() {
      open = false;
      key.fill(0);
    },
  };
  return out;
}

/* The directory is made 0700 only when this module makes it: chmod on a directory that already
   exists would change a folder someone chose, /tmp included. The file is 0600 from the moment its
   temp file exists (src/fsatomic.ts opens it with that mode). */
function writeEnvelope(file: string, envelope: Envelope): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(file, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

/* A new file holding `book`, sealed under `passphrase`. Refuses when a file is already there:
   the one at that path may be the only copy of a funded treasury's key. */
export function createInviteFile(file: string, passphrase: Uint8Array, book: InviteBook): InviteFile {
  if (passphraseChars(passphrase) < MIN_PASSPHRASE_CHARS) throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`);
  if (fs.existsSync(file)) throw new Error(`There is already an invite file at ${file}. It may hold the only copy of a treasury key, so it is never replaced.`);
  const header: Header = { format: FORMAT, version: FILE_VERSION, kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: crypto.randomBytes(SALT_BYTES).toString('hex') } };
  const key = deriveKey(passphrase, Buffer.from(header.kdf.salt, 'hex'));
  const opened = handle(file, key, header, book);
  try {
    opened.save();
  } catch (err) {
    opened.close();
    throw err;
  }
  return opened;
}

/* The file, decrypted and checked whole, or a refusal that changes nothing. */
export function openInviteFile(file: string, passphrase: Uint8Array): InviteFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`There is no invite file at ${file}. Run \`npm run invite -- treasury\` to make one.`);
    throw err;
  }
  const envelope = readEnvelope(text);
  const header: Header = { format: envelope.format, version: envelope.version, kdf: envelope.kdf };
  const key = deriveKey(passphrase, Buffer.from(envelope.kdf.salt, 'hex'));
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'hex'), { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(header));
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'hex'));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  } catch {
    key.fill(0);
    throw new Error(WRONG);
  }
  try {
    return handle(file, key, header, readBook(JSON.parse(plain.toString('utf8'))));
  } catch (err) {
    key.fill(0);
    throw err instanceof SyntaxError ? new Error(DAMAGED) : err;
  } finally {
    plain.fill(0);
  }
}

export type FileLock = { path: string; release(): void };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* The lock beside the file, taken before the file is read by any command that writes it, released
   when that command ends. O_EXCL makes two takers impossible; a lock left by a run that died is
   named, never broken, because breaking a live one is how two runs sign out of one book. */
export function takeLock(file: string): FileLock {
  const lockPath = `${file}.lock`;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${new Date().toISOString()} ${crypto.randomBytes(8).toString('hex')}\n`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let holder = '';
    try {
      holder = fs.readFileSync(lockPath, 'utf8').trim();
    } catch {
      // gone between the two calls, or unreadable: the sentence below still holds
    }
    const pid = Number(holder.split(' ')[0]);
    const who = Number.isInteger(pid) && pid > 0 ? `pid ${pid}, ${alive(pid) ? 'still running' : 'no longer running'}` : 'a run this one cannot name';
    throw new Error(
      `Another invite command holds the lock (${who}). Let it finish. If no invite command is running, it stopped without cleaning up: delete ${lockPath} and run this again.`,
    );
  }
  try {
    fs.writeSync(fd, token);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: lockPath,
    release() {
      try {
        if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
      } catch {
        // already gone
      }
    },
  };
}
