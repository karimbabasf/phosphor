// The Node half of the Secure Enclave wrap. The Swift half is src-tauri/se-helper/main.swift,
// and the two must agree on every byte: a change to a constant here is a change there.
//
// WHAT THIS DOES. The data key that encrypts the wallet payload is wrapped to the public key of
// a P-256 key that lives in the Secure Enclave. Wrapping needs only that public key, so it
// happens here, in the process that made the data key, and the plaintext key never has to be
// handed to another process at creation. Unwrapping needs the enclave's private half and the
// owner's Touch ID, so it happens in the sidecar and nowhere else.
//
// THE SCHEME, written out because "ECIES" names a family and not a byte layout: an ephemeral
// P-256 key is made per wrap; the shared secret is the x-coordinate of ECDH(ephemeral,
// enclave); the wrap key is HKDF-SHA256(secret, salt "phosphor-vault", info
// "phosphor-vault-dek-wrap-v1" || ephemeralPub || enclavePub, 32 bytes); the box is AES-256-GCM
// over the data key with a 12-byte random nonce and the caller's AAD, laid out as
// nonce || ciphertext || tag so CryptoKit's SealedBox(combined:) reads it directly. Public keys
// travel as X9.63 (0x04 || x || y, 65 bytes). The AAD is the canonical wallet header, which
// ties a wrapped key to the addresses beside it: a wrapped key moved to another file fails to
// open rather than opening the wrong wallet.

import crypto from 'node:crypto';

export const SE_WRAP_INFO = 'phosphor-vault-dek-wrap-v1';
export const SE_WRAP_SALT = 'phosphor-vault';

export interface SeWrapped {
  /** X9.63 ephemeral public key, base64. */
  ephemeralPublicKey: string;
  /** nonce || ciphertext || tag, base64. */
  ciphertext: string;
}

function x963ToKeyObject(x963: Buffer): crypto.KeyObject {
  if (x963.length !== 65 || x963[0] !== 0x04) throw new Error('enclave public key must be X9.63 (65 bytes)');
  const b64u = (b: Buffer) => b.toString('base64url');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(x963.subarray(1, 33)), y: b64u(x963.subarray(33, 65)) },
    format: 'jwk',
  });
}

function keyObjectToX963(pub: crypto.KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

function wrapKeyFor(secret: Buffer, ephemeralPub: Buffer, enclavePub: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from(SE_WRAP_INFO, 'utf8'), ephemeralPub, enclavePub]);
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(SE_WRAP_SALT, 'utf8'), info, 32));
}

export function seWrap(dek: Buffer, enclavePublicKeyB64: string, aad: Buffer): SeWrapped {
  if (dek.length !== 32) throw new Error('data key must be 32 bytes');
  const enclavePub = Buffer.from(enclavePublicKeyB64, 'base64');
  const enclaveKey = x963ToKeyObject(enclavePub);
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ephPub = keyObjectToX963(eph.publicKey);
  const secret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: enclaveKey });
  const key = wrapKeyFor(secret, ephPub, enclavePub);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  secret.fill(0);
  return {
    ephemeralPublicKey: ephPub.toString('base64'),
    ciphertext: Buffer.concat([nonce, ct, tag]).toString('base64'),
  };
}

/* Software unwrap, for tests only: it needs the enclave's PRIVATE key, which the enclave never
   gives out. It exists so the derivation can be checked against a plain P-256 key in a unit
   test without a Touch ID, and so a wrong constant on either side shows up as a failing test
   rather than as a wallet that will not open. */
export function seUnwrapWithSoftwareKey(wrapped: SeWrapped, enclavePrivate: crypto.KeyObject, aad: Buffer): Buffer {
  const enclavePub = keyObjectToX963(crypto.createPublicKey(enclavePrivate));
  const ephPub = Buffer.from(wrapped.ephemeralPublicKey, 'base64');
  const secret = crypto.diffieHellman({ privateKey: enclavePrivate, publicKey: x963ToKeyObject(ephPub) });
  const key = wrapKeyFor(secret, ephPub, enclavePub);
  const combined = Buffer.from(wrapped.ciphertext, 'base64');
  if (combined.length !== 12 + 32 + 16) throw new Error('a wrapped data key is nonce, 32 bytes and a 16-byte tag');
  const nonce = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(12, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  key.fill(0);
  secret.fill(0);
  return out;
}
