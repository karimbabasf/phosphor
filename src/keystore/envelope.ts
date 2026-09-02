// The envelope: AES-256-GCM twice, over one file.
//
//   the data key      32 random bytes, made once when the wallet is made
//   the payload       the whole keys JSON, encrypted under the data key
//   the wrap          the data key, encrypted under the password-derived KEK
//   the header        plaintext, and the additional authenticated data for BOTH
//
// Two layers rather than one because a password change or a Touch ID copy then rewraps 32
// bytes instead of re-encrypting the file, and because what a Keychain item would hold is a
// wrapped data key rather than anything derived from the password.
//
// The header is the AAD, which is what stops it being editable. It carries the KDF parameters
// and, more to the point, the public addresses every read path uses while the wallet is
// locked. Without the AAD an attacker could swap the EVM address in the header for their own,
// leave the ciphertext untouched, and the app would show a locked wallet whose receive screen
// pointed at somebody else's address. With it, that edit fails the tag on the next unlock.
//
// The AAD is the CANONICAL form of the header (keys sorted, recursively), not the bytes as
// they happen to sit in the file. Serialising an object twice has to produce the same bytes
// twice or the tag is a coin toss, and JSON.parse preserving key order is a V8 behaviour
// rather than a guarantee.

import crypto from 'node:crypto';

export const IV_BYTES = 12; // 96 bits, the size GCM is defined for
export const TAG_BYTES = 16;

export type Sealed = {
  iv: string; // hex
  tag: string; // hex
  data: string; // base64
};

// Sorted keys, recursively, so two serialisations of the same header agree byte for byte.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}

export function aadFor(header: unknown): Buffer {
  return Buffer.from(canonical(header), 'utf8');
}

export function newDataKey(): Buffer {
  return crypto.randomBytes(32);
}

export function seal(plaintext: Buffer, key: Buffer, aad: Buffer): Sealed {
  if (key.length !== 32) throw new Error(`the encryption key must be 32 bytes, got ${key.length}`);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}

/* Throws on a wrong key, a tampered ciphertext, a tampered header and a truncated file alike:
   GCM does not distinguish them and neither does the caller, because "this did not open" is
   the only honest answer. The one distinction the caller draws is between a wrong PASSWORD
   and a damaged FILE, and it draws it from which layer failed: the wrap is opened first, so a
   wrap that fails is a password and a payload that fails after a good wrap is damage. */
export function open(sealed: Sealed, key: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32) throw new Error(`the encryption key must be 32 bytes, got ${key.length}`);
  const iv = Buffer.from(sealed.iv, 'hex');
  if (iv.length !== IV_BYTES) throw new Error(`the nonce must be ${IV_BYTES} bytes, got ${iv.length}`);
  const tag = Buffer.from(sealed.tag, 'hex');
  if (tag.length !== TAG_BYTES) throw new Error(`the authentication tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

// Overwrite a buffer that held key material. Best effort and stated as such: it cannot reach a
// copy the allocator already moved, and on an unsigned binary any same-user process can read
// the heap anyway (see decision 10 in the spec). What it does buy is that a long-running
// process does not keep the key readable for the hours between a lock and the next unlock.
export function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const b of buffers) if (b !== null && b !== undefined) b.fill(0);
}
