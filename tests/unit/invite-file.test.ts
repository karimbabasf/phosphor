// The invite file: AES-256-GCM under scrypt (N = 2^17, r = 8, p = 1) of a passphrase of at least 20
// characters, 0600, written atomically, never in the clear, and failing closed on a wrong
// passphrase or any changed byte. Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md,
// "The invite file". Throwaway keys and codes only, made at run time from a counter.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeAddress, formatCode, generateSecret } from '../../src/invite/code.ts';
import { newBook, readBook } from '../../scripts/invite/book.ts';
import type { InviteBook } from '../../scripts/invite/book.ts';
import { INVITE_FILE_ENV, MIN_PASSPHRASE_CHARS, createInviteFile, defaultInviteFile, inviteFilePath, openInviteFile, passphraseChars, takeLock } from '../../scripts/invite/file.ts';
import { newTreasury } from '../../scripts/invite/money.ts';
import { START, countingRandom } from './helpers/invite-chain.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PASS = Buffer.from('correct horse battery staple, twice over', 'utf8');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-file-'));
}

// A book with one batch of `count` codes, every key and code made at run time.
function sampleBook(count = 3): InviteBook {
  const random = countingRandom(7);
  const book = newBook(newTreasury({ random, now: () => START }));
  const batch = 'b1';
  const legs = [];
  for (let i = 0; i < count; i += 1) {
    const secret = generateSecret(random);
    const address = codeAddress(secret)!;
    book.codes.push({ code: formatCode(secret), address, label: 'SF builders', amountBase: '5000000', batch, state: 'open', createdAt: new Date(START).toISOString() });
    legs.push({ receiverId: address, amountBase: '5000000' });
  }
  book.moves.push({ id: batch, kind: 'batch', signer: book.treasury.address, legs, state: 'done', createdAt: new Date(START).toISOString(), label: 'SF builders', printedAt: new Date(START).toISOString() });
  return book;
}

// Every string a reader of the disk must never find.
function secretsOf(book: InviteBook): string[] {
  const out = [book.treasury.key, book.treasury.key.slice(2), 'SF builders', '"treasury"'];
  for (const c of book.codes) out.push(c.code, c.code.toLowerCase(), c.code.slice(5).replace(/-/g, ''));
  return out;
}

test('a new file opens with the same passphrase and holds the same book, 0600 in a 0700 folder', () => {
  const dir = path.join(tmpDir(), 'invites');
  const file = path.join(dir, 'invites.enc.json');
  const book = sampleBook();
  createInviteFile(file, PASS, book).close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as { kdf: Record<string, unknown>; cipher: Record<string, unknown> };
  assert.deepEqual({ name: envelope.kdf['name'], N: envelope.kdf['N'], r: envelope.kdf['r'], p: envelope.kdf['p'] }, { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
  assert.equal(envelope.cipher['name'], 'aes-256-gcm');
  const opened = openInviteFile(file, PASS);
  assert.deepEqual(opened.book, book);
  opened.close();
  const raw = fs.readFileSync(file, 'utf8');
  for (const s of secretsOf(book)) assert.ok(!raw.includes(s), `the file shows ${s.slice(0, 12)} in the clear`);
});

test('a wrong passphrase fails closed: a refusal, and the file is not touched', () => {
  const file = path.join(tmpDir(), 'invites.enc.json');
  createInviteFile(file, PASS, sampleBook()).close();
  const before = fs.readFileSync(file);
  assert.throws(() => openInviteFile(file, Buffer.from('correct horse battery staple, once over', 'utf8')), /passphrase is wrong, or the invite file was changed/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['invites.enc.json']);
});

test('a truncated file fails closed, and so does a changed byte anywhere: data, tag, iv, salt, format', () => {
  const file = path.join(tmpDir(), 'invites.enc.json');
  createInviteFile(file, PASS, sampleBook()).close();
  const good = fs.readFileSync(file, 'utf8');

  fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
  assert.throws(() => openInviteFile(file, PASS), /damaged or was changed/);
  fs.writeFileSync(file, '');
  assert.throws(() => openInviteFile(file, PASS), /damaged or was changed/);

  const env = JSON.parse(good) as { format: string; version: number; kdf: { salt: string }; cipher: { iv: string; tag: string }; data: string };
  const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  const data = Buffer.from(env.data, 'base64');
  data[data.length >> 1]! ^= 0x01;
  const edits: Array<[string, unknown, RegExp]> = [
    ['data', { ...env, data: data.toString('base64') }, /passphrase is wrong, or the invite file was changed/],
    ['data cut short', { ...env, data: env.data.slice(0, 8) }, /passphrase is wrong, or the invite file was changed/],
    ['tag', { ...env, cipher: { ...env.cipher, tag: flip(env.cipher.tag) } }, /passphrase is wrong, or the invite file was changed/],
    ['iv', { ...env, cipher: { ...env.cipher, iv: flip(env.cipher.iv) } }, /passphrase is wrong, or the invite file was changed/],
    ['salt', { ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt) } }, /passphrase is wrong, or the invite file was changed/],
    ['format', { ...env, format: 'phosphor-invites-2' }, /damaged or was changed/],
    ['version', { ...env, version: 2 }, /damaged or was changed/],
  ];
  for (const [what, edited, said] of edits) {
    fs.writeFileSync(file, JSON.stringify(edited));
    assert.throws(() => openInviteFile(file, PASS), said, `a changed ${what} was read`);
  }
  fs.writeFileSync(file, good);
  openInviteFile(file, PASS).close();
});

test('an edited scrypt cost is refused before the KDF runs, so it cannot be a memory bomb', () => {
  const file = path.join(tmpDir(), 'invites.enc.json');
  createInviteFile(file, PASS, sampleBook()).close();
  const env = JSON.parse(fs.readFileSync(file, 'utf8')) as { kdf: Record<string, unknown> };
  const scrypt = mock.method(crypto, 'scryptSync');
  try {
    for (const kdf of [{ N: 2 ** 30 }, { N: 2 ** 14 }, { r: 1 }, { p: 4 }, { name: 'pbkdf2' }, { salt: 'ab' }]) {
      fs.writeFileSync(file, JSON.stringify({ ...env, kdf: { ...env.kdf, ...kdf } }));
      assert.throws(() => openInviteFile(file, PASS), /damaged or was changed/);
    }
    assert.equal(scrypt.mock.callCount(), 0, 'no KDF ran on an edited header');
  } finally {
    scrypt.mock.restore();
  }
});

test('the book is never on disk in the clear, not even in the temp file of an atomic write', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'invites.enc.json');
  const book = sampleBook(4);
  const secrets = secretsOf(book);
  const written: string[] = [];
  const capture = (data: unknown): void => {
    written.push(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'));
  };
  const realWriteFile = fs.writeFileSync;
  const realWrite = fs.writeSync;
  const realAppend = fs.appendFileSync;
  const wf = mock.method(fs, 'writeFileSync', (...args: unknown[]) => {
    capture(args[1]);
    return (realWriteFile as (...a: unknown[]) => unknown).apply(fs, args);
  });
  const ws = mock.method(fs, 'writeSync', (...args: unknown[]) => {
    capture(args[1]);
    return (realWrite as (...a: unknown[]) => unknown).apply(fs, args);
  });
  const af = mock.method(fs, 'appendFileSync', (...args: unknown[]) => {
    capture(args[1]);
    return (realAppend as (...a: unknown[]) => unknown).apply(fs, args);
  });
  try {
    const opened = createInviteFile(file, PASS, book);
    opened.book.codes[0]!.state = 'reclaimed';
    opened.save();
    opened.save();
    opened.close();
  } finally {
    wf.mock.restore();
    ws.mock.restore();
    af.mock.restore();
  }
  assert.ok(written.length >= 3, 'every save went through a captured write');
  for (const text of written) {
    assert.ok(text.includes('"aes-256-gcm"'), 'every write is an envelope');
    for (const s of secrets) assert.ok(!text.includes(s), `a write carried ${s.slice(0, 12)} in the clear`);
  }
  assert.deepEqual(fs.readdirSync(dir), ['invites.enc.json'], 'no temp file is left behind');
  assert.equal(openInviteFile(file, PASS).book.codes[0]!.state, 'reclaimed');
});

test('the passphrase is at least 20 characters, counted as characters, not bytes', () => {
  const dir = tmpDir();
  assert.equal(MIN_PASSPHRASE_CHARS, 20);
  assert.equal(passphraseChars(Buffer.from('ééééé', 'utf8')), 5);
  assert.throws(() => createInviteFile(path.join(dir, 'a.json'), Buffer.from('nineteen characters', 'utf8'), sampleBook()), /at least 20 characters/);
  assert.equal(fs.existsSync(path.join(dir, 'a.json')), false);
  // Ten two-byte letters are twenty bytes and ten characters: refused.
  assert.throws(() => createInviteFile(path.join(dir, 'b.json'), Buffer.from('é'.repeat(10), 'utf8'), sampleBook()), /at least 20 characters/);
  createInviteFile(path.join(dir, 'c.json'), Buffer.from('é'.repeat(20), 'utf8'), sampleBook()).close();
});

test('an existing invite file is never replaced: it may hold the only copy of a funded treasury key', () => {
  const file = path.join(tmpDir(), 'invites.enc.json');
  createInviteFile(file, PASS, sampleBook()).close();
  const before = fs.readFileSync(file);
  assert.throws(() => createInviteFile(file, PASS, sampleBook()), /never replaced/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('the lock: one taker at a time, 0600, named and never broken when its holder is gone', () => {
  const file = path.join(tmpDir(), 'invites.enc.json');
  const first = takeLock(file);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.throws(() => takeLock(file), /holds the lock \(pid \d+, still running\)/);
  first.release();
  assert.equal(fs.existsSync(first.path), false);
  const again = takeLock(file);
  again.release();

  // A lock left by a run that died: named as such, and left for a person to remove.
  fs.writeFileSync(`${file}.lock`, '999999 2026-10-01T20:00:00.000Z deadbeef\n', { mode: 0o600 });
  assert.throws(() => takeLock(file), /pid 999999, no longer running\).*delete .*\.lock/);
  assert.equal(fs.existsSync(`${file}.lock`), true);
  // release() only ever removes its own lock.
  first.release();
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test('the path: --file, then PHOSPHOR_INVITES_FILE, then ~/.phosphor-invites, and never inside the working copy', () => {
  const home = tmpDir();
  assert.equal(inviteFilePath(undefined, {}, REPO, home), defaultInviteFile(home));
  assert.equal(defaultInviteFile(home), path.join(home, '.phosphor-invites', 'invites.enc.json'));
  assert.equal(inviteFilePath(undefined, { [INVITE_FILE_ENV]: path.join(home, 'a.json') }, REPO, home), path.join(home, 'a.json'));
  assert.equal(inviteFilePath(path.join(home, 'b.json'), { [INVITE_FILE_ENV]: path.join(home, 'a.json') }, REPO, home), path.join(home, 'b.json'));
  assert.throws(() => inviteFilePath(path.join(REPO, 'invites.enc.json'), {}, REPO, home), /outside the repo working copy/);
  assert.throws(() => inviteFilePath(undefined, { [INVITE_FILE_ENV]: path.join(REPO, 'state', 'x.json') }, REPO, home), /outside the repo working copy/);
  // APFS is case-insensitive: another spelling of the repo is still the repo.
  const shouted = path.join(path.dirname(REPO), path.basename(REPO).toUpperCase(), 'x.json');
  if (fs.existsSync(path.dirname(shouted))) assert.throws(() => inviteFilePath(shouted, {}, REPO, home), /outside the repo working copy/);
});

test('a book that does not hold together is refused: a code that is not its address, a key that is not T', () => {
  const book = sampleBook(2);
  assert.deepEqual(readBook(JSON.parse(JSON.stringify(book))), book);
  const swapped = JSON.parse(JSON.stringify(book)) as InviteBook;
  swapped.codes[0]!.address = swapped.codes[1]!.address;
  assert.throws(() => readBook(swapped), /code 1 is not the code for its address/);
  const otherKey = JSON.parse(JSON.stringify(book)) as InviteBook;
  otherKey.treasury.address = book.codes[0]!.address;
  assert.throws(() => readBook(otherKey), /key is not the treasury's address/);
  const orphan = JSON.parse(JSON.stringify(book)) as InviteBook;
  orphan.moves = [];
  assert.throws(() => readBook(orphan), /names a batch the book does not hold/);
  for (const message of [swapped, otherKey].map((b) => {
    try {
      readBook(b);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  })) {
    for (const c of book.codes) assert.ok(!message.includes(c.code), 'an error quoted a code');
  }
});
