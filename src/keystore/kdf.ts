// Turning a password into a key, and nothing else.
//
// scrypt, N = 2^18, r = 8, p = 1, 32-byte salt, 32-byte output. That is about 256 MiB and
// roughly half a second on Apple silicon, which is the tier geth and Rabby use for a real
// wallet and the reason a stolen file is not a stolen wallet: an attacker who copies
// keys.enc.json pays that cost per guess.
//
// Why scrypt and not Argon2id. Argon2id is the better function on paper. It is not in Node,
// so it would be the first native dependency in a three-dependency repo that holds keys, and
// the supply-chain risk of that dependency is a worse trade than the difference between two
// memory-hard KDFs at these parameters. node:crypto ships scrypt, and this file uses nothing
// else.
//
// The KEK derived here never encrypts the keys. It wraps a random 32-byte data key
// (src/keystore/envelope.ts), so changing the password rewraps 32 bytes rather than
// re-encrypting the file, and a Keychain copy for Touch ID later holds a wrapped data key
// rather than anything derived from the password.

import crypto from 'node:crypto';

export type KdfParams = {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // hex
};

export const SCRYPT_N = 2 ** 18;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const KEY_BYTES = 32;
export const SALT_BYTES = 32;

/* scrypt needs 128 * N * r bytes, which at these parameters is 256 MiB, and node:crypto's
   default ceiling is 32 MiB. Doubling the requirement leaves room for the implementation's own
   working buffers without letting a hand-edited header ask for an unbounded allocation: see
   the bounds check below, which is what stops a tampered N from being a memory bomb. */
function maxmemFor(N: number, r: number): number {
  return 2 * 128 * N * r;
}

export function newSalt(): string {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

export function defaultParams(): KdfParams {
  return { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: newSalt() };
}

/* The header is plaintext and an attacker can edit it. The GCM tag catches that after the
   fact, but the KDF runs BEFORE the tag is checked, so an N of 2^30 in a tampered header would
   be an out-of-memory crash rather than a failed unlock. These bounds are what make the
   failure a refusal. The ceiling is one step above the parameters this app writes, so a file
   written by a future version with a stronger setting still opens. */
export function checkParams(params: KdfParams): void {
  if (params.name !== 'scrypt') throw new Error(`unsupported key derivation ${String(params.name)}`);
  if (!Number.isInteger(params.N) || params.N < 2 ** 14 || params.N > 2 ** 20) {
    throw new Error(`key derivation cost N is out of range: ${String(params.N)}`);
  }
  if ((params.N & (params.N - 1)) !== 0) throw new Error('key derivation cost N must be a power of two');
  if (!Number.isInteger(params.r) || params.r < 1 || params.r > 32) throw new Error(`key derivation r is out of range: ${String(params.r)}`);
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 16) throw new Error(`key derivation p is out of range: ${String(params.p)}`);
  if (!/^[0-9a-f]{32,128}$/.test(params.salt)) throw new Error('key derivation salt is not hex, or is too short');
}

// The key-encryption key. Async because it holds a core for about half a second and this
// process also answers HTTP: a synchronous derivation would stall every open SSE stream.
export function deriveKek(password: string, params: KdfParams): Promise<Buffer> {
  checkParams(params);
  const salt = Buffer.from(params.salt, 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(password.normalize('NFKD'), 'utf8'),
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params.N, params.r) },
      (err, key) => (err !== null ? reject(err) : resolve(key)),
    );
  });
}
